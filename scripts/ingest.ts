/**
 * ingest.ts: read the documents, cut them into passages, embed the passages
 * and store them in Postgres. Run it on your own machine, not on the server:
 *
 *   npm run ingest             full run (needs DATABASE_URL and OPENAI_API_KEY)
 *   npm run ingest -- --dry-run   parse and chunk only, write data/debug/*.txt
 *
 * The npm script loads .env.local first, so the keys are the same ones the
 * app uses. It is safe to run again at any time. Each run rebuilds the table from
 * scratch inside one transaction, so you never end up with half old and
 * half new passages.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { embedMany } from "ai";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../lib/config";
import { getPool, toVectorLiteral } from "../lib/db";
import { embeddingModel } from "../lib/models";
import { sources, type Source } from "../lib/sources";
import { chunkDocument, type Passage, type TextLine } from "./lib/chunk";
import { extractHtml } from "./lib/html";
import { extractPdf } from "./lib/pdf";

const DATA_DIR = path.join(process.cwd(), "data", "pdfs");
const DEBUG_DIR = path.join(process.cwd(), "data", "debug");
const EMBED_BATCH = 100; // passages per embedding request

type Row = Passage & { source: Source; locator: string; link: string };

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const rows: Row[] = [];
  const problems: string[] = [];
  console.log(`\nReading ${sources.length} documents from data/pdfs/\n`);

  for (const source of sources) {
    const file = path.join(DATA_DIR, source.file);
    if (!existsSync(file)) {
      problems.push(`${source.id}: ${source.file} is missing. Run "npm run fetch" first.`);
      continue;
    }
    const { lines, note } = await readDocument(source, file);
    const passages = chunkDocument(lines);
    for (const passage of passages) {
      rows.push({ ...passage, source, locator: locatorFor(passage), link: linkFor(source, passage) });
    }
    const words = passages.reduce((n, p) => n + p.wordCount, 0);
    console.log(`${source.id.padEnd(18)} ${String(passages.length).padStart(4)} passages  ${String(words).padStart(7)} words  ${note}`);
    if (passages.length === 0) problems.push(`${source.id}: no text came out of ${source.file}.`);
    if (dryRun) await writeDebugFile(source, passages);
  }

  console.log(`\nTotal: ${rows.length} passages from ${new Set(rows.map((r) => r.source.id)).size} documents.`);
  if (problems.length > 0) {
    console.error(`\nProblems:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  if (dryRun) {
    console.log("Dry run: nothing was embedded or written. See data/debug/ for the passages.");
    return;
  }

  const embeddings = await embedAll(rows);
  await writeToDatabase(rows, embeddings);
  console.log(`\nDone. ${rows.length} passages stored, embedded with ${EMBEDDING_MODEL}.`);
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

async function readDocument(source: Source, file: string): Promise<{ lines: TextLine[]; note: string }> {
  if (source.format === "html") {
    const { lines, sections } = await extractHtml(file);
    return { lines, note: `${sections} sections` };
  }

  const layout = source.layout === "columns" ? "columns" : "stream";
  const { lines, stats } = await extractPdf(file, {
    layout,
    unmappedGlyph: source.unmappedGlyph,
    keepSmallPrint: source.keepSmallPrint,
  });
  const skipped = (page: number) => (source.skipPages ?? []).some((r) => page >= r.from && page <= r.to);
  const kept = lines.filter((line) => !skipped(line.page));
  // A passage must not run from the page before a skipped range straight
  // into the page after it, so mark the first line after each gap.
  const textLines = kept.map(({ text, page, isHeading }, i) => ({
    text,
    page,
    isHeading,
    breakBefore: i > 0 && page - kept[i - 1].page > 1 && skipped(page - 1),
  }));

  const skippedPages = (source.skipPages ?? []).reduce((n, r) => n + r.to - r.from + 1, 0);
  const note =
    `${stats.pages} pages` +
    (skippedPages ? ` (${skippedPages} skipped)` : "") +
    `, removed: ${stats.furnitureLines} header/footer lines` +
    (stats.lineNumbers ? `, ${stats.lineNumbers} line numbers` : "") +
    `, ${stats.footnoteWords} footnote words, ${stats.smallPrintWords} small-print words` +
    (layout === "columns" ? `; ${stats.multiColumnPages} multi-column pages` : "");
  return { lines: textLines, note };
}

/* ------------------------------------------------------------------ */
/* Citations and links                                                 */
/* ------------------------------------------------------------------ */

/** The "where" half of a citation: a page, a page range or a section. */
function locatorFor(passage: Passage): string {
  if (passage.pageStart !== null) {
    return passage.pageStart === passage.pageEnd
      ? `p. ${passage.pageStart}`
      : `pp. ${passage.pageStart}-${passage.pageEnd}`;
  }
  // Web page: use the section number from the heading, e.g. "VIII. Risk ...".
  const roman = passage.section?.match(/^([IVXLC]+)\./);
  if (roman) return `sec. ${roman[1]}`;
  const appendix = passage.section?.match(/^Appendix (\w+)/i);
  if (appendix) return `app. ${appendix[1]}`;
  return "web page";
}

/** Browsers open a PDF at a given page when the URL ends in #page=N. */
function linkFor(source: Source, passage: Passage): string {
  if (passage.pageStart !== null) return `${source.fileUrl}#page=${passage.pageStart}`;
  return passage.anchor ? `${source.url}#${passage.anchor}` : source.url;
}

/* ------------------------------------------------------------------ */
/* Embedding and storing                                               */
/* ------------------------------------------------------------------ */

/**
 * What we embed is the passage with a one-line label in front: the document
 * name and the section. The label gives the vector some context ("this is
 * about NHTSA driver distraction") that the passage text alone may lack.
 * Only the plain passage is stored and shown.
 */
function textToEmbed(row: Row): string {
  const label = [row.source.shortName, row.section].filter(Boolean).join(": ");
  return `${label}\n${row.content}`;
}

async function embedAll(rows: Row[]): Promise<number[][]> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set (needed for embeddings).");
  const embeddings: number[][] = [];
  for (let i = 0; i < rows.length; i += EMBED_BATCH) {
    const batch = rows.slice(i, i + EMBED_BATCH);
    const result = await embedMany({ model: embeddingModel(), values: batch.map(textToEmbed) });
    embeddings.push(...result.embeddings);
    process.stdout.write(`\rEmbedding passages: ${embeddings.length}/${rows.length}`);
  }
  process.stdout.write("\n");
  const length = embeddings[0]?.length;
  if (length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`${EMBEDDING_MODEL} returned ${length} dimensions but EMBEDDING_DIMENSIONS is ${EMBEDDING_DIMENSIONS}.`);
  }
  return embeddings;
}

async function writeToDatabase(rows: Row[], embeddings: number[][]) {
  const schema = (await readFile(path.join(process.cwd(), "db", "schema.sql"), "utf8")).replaceAll(
    "{{DIMENSIONS}}",
    String(EMBEDDING_DIMENSIONS),
  );
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(schema); // drops and recreates the table
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      await client.query(
        `insert into passages
           (doc_id, doc_title, doc_short_name, locator, page_start, page_end, section,
            published, source_url, link, content, word_count, embedding)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::vector)`,
        [
          row.source.id,
          row.source.title,
          row.source.shortName,
          row.locator,
          row.pageStart,
          row.pageEnd,
          row.section,
          row.source.published,
          row.source.url,
          row.link,
          row.content,
          row.wordCount,
          toVectorLiteral(embeddings[i]),
        ],
      );
      if ((i + 1) % 50 === 0 || i === rows.length - 1) {
        process.stdout.write(`\rWriting to database: ${i + 1}/${rows.length}`);
      }
    }
    await client.query("commit");
    process.stdout.write("\n");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/** One text file per document, so you can read exactly what was stored. */
async function writeDebugFile(source: Source, passages: Passage[]) {
  await mkdir(DEBUG_DIR, { recursive: true });
  const body = passages
    .map((p, i) => `===== ${i + 1} | ${source.shortName}, ${locatorFor(p)} | ${p.wordCount} words | ${p.section ?? "(no heading)"}\n${p.content}`)
    .join("\n\n");
  await writeFile(path.join(DEBUG_DIR, `${source.id}.txt`), body + "\n");
}

main().catch((error) => {
  console.error(`\nIngestion failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
