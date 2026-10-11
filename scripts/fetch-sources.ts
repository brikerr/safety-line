/**
 * fetch-sources.ts: download the documents listed in data/pdfs/sources.json.
 *
 *   npm run fetch              download any file that is missing
 *   npm run fetch -- --force   download everything again
 *   npm run fetch -- --check   test every link without saving anything
 *
 * The files themselves are not committed to git (see .gitignore); this
 * script is how a fresh clone gets them. Some government sites refuse
 * requests that do not look like a browser. If a download fails, open the
 * URL in your browser, save the file, and put it in data/pdfs/ under the
 * file name shown in the error.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { sources } from "../lib/sources";

const DATA_DIR = path.join(process.cwd(), "data", "pdfs");
const force = process.argv.includes("--force");
const checkOnly = process.argv.includes("--check");

async function main() {
  let failed = 0;
  for (const source of sources) {
    const target = path.join(DATA_DIR, source.file);
    if (existsSync(target) && !force && !checkOnly) {
      console.log(`have     ${source.file}`);
      continue;
    }
    try {
      const response = await fetch(source.fileUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (safety-line document fetch)", Accept: "application/pdf,text/html,*/*" },
        redirect: "follow",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const looksRight =
        source.format === "pdf" ? bytes.subarray(0, 5).toString() === "%PDF-" : bytes.includes("<html");
      if (!looksRight) throw new Error(`the response is not a ${source.format} file`);
      const size = `(${(bytes.length / 1e6).toFixed(1)} MB)`;
      if (checkOnly) {
        console.log(`link ok  ${source.file}  ${size}`);
        continue;
      }
      await writeFile(target, bytes);
      console.log(`fetched  ${source.file}  ${size}`);
    } catch (error) {
      failed++;
      console.error(
        `FAILED   ${source.file}: ${error instanceof Error ? error.message : error}\n` +
          `         Download it by hand from ${source.fileUrl}\n` +
          `         and save it as data/pdfs/${source.file}`,
      );
    }
  }
  if (failed > 0) process.exit(1);
}

main();
