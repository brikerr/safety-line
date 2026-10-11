/**
 * pdf.ts: turn a PDF into clean lines of text, page by page.
 *
 * A PDF does not store paragraphs. It stores small text fragments, each with
 * an x/y position and a font size. Everything here is about using those
 * positions to throw away what is not body text and to put the rest in
 * reading order.
 *
 * The steps, in order:
 *   1. Read fragments from every page (skip rotated margin text).
 *   2. Drop margin line numbers (FDA draft guidance prints one per line).
 *   3. Drop running headers, footers and page numbers.
 *   4. Drop footnotes and other small print.
 *   5. Put fragments in reading order and join them into lines.
 *   6. Mark which lines are section headings.
 *
 * Coordinates: PDF y grows upward, so the top of a page has the largest y.
 */
import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export type Layout = "stream" | "columns";

export type Line = {
  text: string;
  page: number; // 1-based position in the PDF file
  size: number; // font size
  isHeading: boolean;
};

export type PdfStats = {
  pages: number;
  bodySize: number;
  lineNumbers: number; // margin line numbers removed
  furnitureLines: number; // header, footer and page number lines removed
  footnoteWords: number; // words removed from footnote blocks at the foot of a page
  smallPrintWords: number; // other small-print words removed
  multiColumnPages: number; // pages where column gutters were found
};

type Fragment = {
  text: string;
  x0: number;
  x1: number;
  y: number;
  size: number;
};

type PageFragments = { page: number; width: number; height: number; fragments: Fragment[] };

// Tunable numbers, kept together so they are easy to find and change.
const TOP_BAND = 0.9; // headers live above 90% of the page height
const BOTTOM_BAND = 0.11; // footers live below 11% of the page height
const FURNITURE_MIN_PAGES = 2; // a header must repeat on this many pages
const TINY_RATIO = 0.72; // superscript footnote markers: always removed
const SMALL_PRINT_RATIO = 0.82; // reference lists and fine print: removed by default
const GUTTER_MIN_WIDTH = 7; // points of white space that count as a column gap
const GUTTER_VALLEY = 0.6; // a strip with at most this share of the text on either side is worth testing
const BLOCK_GAP = 2.5; // a vertical gap this many times the font size starts a new block
const GUTTER_MIN_RUN = 4; // rows in a row that must be blank at the gutter
const GUTTER_MIN_SIDE = 2; // of those, rows with text on each side
const GUTTER_REACH = 40; // points: how close left-column lines must come to the gutter
const GUTTER_MIN_LINE = 80; // points: how long such a line must be to count as running text
const GUTTER_REACH_SHARE = 0.25; // share of a band's rows that must have such a line
const HEADING_RATIO = 1.08; // a heading is at least 8% larger than the text around it

export async function extractPdf(
  path: string,
  options: { layout: Layout; unmappedGlyph?: string; keepSmallPrint?: boolean },
): Promise<{ lines: Line[]; stats: PdfStats }> {
  const pages = await readFragments(path, options.unmappedGlyph ?? "");
  const stats: PdfStats = {
    pages: pages.length,
    bodySize: 0,
    lineNumbers: 0,
    furnitureLines: 0,
    footnoteWords: 0,
    smallPrintWords: 0,
    multiColumnPages: 0,
  };

  for (const page of pages) stats.lineNumbers += removeMarginLineNumbers(page);
  stats.furnitureLines = removeFurniture(pages);

  // Body size is measured after the furniture is gone so that a big running
  // header cannot be mistaken for the body font.
  stats.bodySize = findBodySize(pages);
  for (const page of pages) {
    // Footnote blocks are found by position, which only works when the page
    // is one column. Multi-column documents rely on the size rule alone.
    if (options.layout === "stream") stats.footnoteWords += removeFootnoteBlock(page);
    stats.smallPrintWords += removeSmallPrint(page, stats.bodySize, options.keepSmallPrint ?? false);
  }

  const lines: Line[] = [];
  for (const page of pages) {
    let pageLines: Line[];
    if (options.layout === "columns") {
      const ordered = linesInColumnOrder(page);
      if (ordered.hasColumns) stats.multiColumnPages++;
      pageLines = ordered.lines;
    } else {
      pageLines = linesInStreamOrder(page);
    }
    lines.push(...markHeadings(pageLines, stats.bodySize, options.layout));
  }
  return { lines, stats };
}

/* ------------------------------------------------------------------ */
/* 1. Read fragments                                                   */
/* ------------------------------------------------------------------ */

async function readFragments(path: string, unmappedGlyph: string): Promise<PageFragments[]> {
  const data = new Uint8Array(await readFile(path));
  const task = getDocument({ data, verbosity: 0 });
  const doc = await task.promise;
  const pages: PageFragments[] = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const fragments: Fragment[] = [];

    for (const item of content.items) {
      if (!("str" in item)) continue; // marked-content markers, not text
      const [a, b, c, , x, y] = item.transform;
      // Rotated text is the sideways print in the margin of Federal Register
      // pages. Body text is never rotated in these documents.
      if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0) continue;
      const text = cleanCharacters(item.str, unmappedGlyph);
      if (text.trim() === "") continue;
      fragments.push({ text, x0: x, x1: x + item.width, y, size: item.height });
    }
    pages.push({ page: pageNumber, width: viewport.width, height: viewport.height, fragments });
  }
  await task.destroy();
  return pages;
}

function cleanCharacters(text: string, unmappedGlyph: string): string {
  return (
    text
      // U+FFFD means "the PDF font had no Unicode mapping for this glyph".
      // What it should have been differs per document, so sources.json says.
      .replace(/�/g, unmappedGlyph)
      // Private-use characters are symbol-font bullets (Wingdings and friends).
      .replace(/[-]/g, "•")
      .replace(/­/g, "") // soft hyphen
      .replace(/[  -​]/g, " ") // odd spaces
  );
}

/* ------------------------------------------------------------------ */
/* 2. Margin line numbers                                              */
/* ------------------------------------------------------------------ */

/**
 * FDA draft guidance prints a line number in the left margin of every line.
 * They are easy to recognise: fragments that are only digits and that sit
 * entirely to the left of all other text on the page.
 */
function removeMarginLineNumbers(page: PageFragments): number {
  const isNumber = (f: Fragment) => /^\d{1,5}$/.test(f.text.trim());
  const others = page.fragments.filter((f) => !isNumber(f));
  if (others.length === 0) return 0;
  const textLeftEdge = Math.min(...others.map((f) => f.x0));
  const inMargin = (f: Fragment) => isNumber(f) && f.x1 < textLeftEdge - 1;
  const count = page.fragments.filter(inMargin).length;
  if (count < 5) return 0; // a stray number is not a line-number column
  page.fragments = page.fragments.filter((f) => !inMargin(f));
  return count;
}

/* ------------------------------------------------------------------ */
/* 3. Headers, footers, page numbers                                   */
/* ------------------------------------------------------------------ */

/**
 * A running header or footer has two properties: it sits in the top or
 * bottom band of the page, and the same text shows up on several pages.
 * Position alone is not enough (body text can start high on the page), and
 * repetition alone is not enough (a phrase can repeat in the body), so we
 * require both. Digits are replaced with "#" before comparing, so that
 * "Page 7" and "Page 8" count as the same line.
 */
function removeFurniture(pages: PageFragments[]): number {
  type Row = { key: string; fragments: Fragment[] };
  const bandRows = new Map<PageFragments, Row[]>();
  const pagesSeenOn = new Map<string, number>();

  for (const page of pages) {
    const inBand = page.fragments.filter(
      (f) => f.y > page.height * TOP_BAND || f.y < page.height * BOTTOM_BAND,
    );
    const rows = groupIntoRows(inBand).map((fragments) => ({
      key: joinFragments(fragments).replace(/\d+/g, "#").replace(/\s+/g, " ").trim(),
      fragments,
    }));
    bandRows.set(page, rows);
    for (const key of new Set(rows.map((r) => r.key))) {
      pagesSeenOn.set(key, (pagesSeenOn.get(key) ?? 0) + 1);
    }
  }

  const pageNumberPattern = /^(page )?(#|[ivxlc]+)( of #)?$/i;
  let removed = 0;
  for (const page of pages) {
    const drop = new Set<Fragment>();
    for (const row of bandRows.get(page) ?? []) {
      const repeats = (pagesSeenOn.get(row.key) ?? 0) >= FURNITURE_MIN_PAGES;
      if (repeats || pageNumberPattern.test(row.key)) {
        row.fragments.forEach((f) => drop.add(f));
        removed++;
      }
    }
    page.fragments = page.fragments.filter((f) => !drop.has(f));
  }
  return removed;
}

/* ------------------------------------------------------------------ */
/* 4. Small print                                                      */
/* ------------------------------------------------------------------ */

/** The body size is the font size that most of the characters are set in. */
function findBodySize(pages: PageFragments[]): number {
  const charsBySize = new Map<number, number>();
  for (const page of pages) {
    for (const f of page.fragments) {
      const size = Math.round(f.size * 2) / 2;
      charsBySize.set(size, (charsBySize.get(size) ?? 0) + f.text.length);
    }
  }
  let best = 10;
  let bestChars = 0;
  for (const [size, chars] of charsBySize) {
    if (chars > bestChars) [best, bestChars] = [size, chars];
  }
  return best;
}

/**
 * Footnotes interrupt sentences that continue on the next page, and they are
 * mostly citations, so this version drops them.
 * TODO: keep footnotes as their own passages, linked to the page they sit on.
 *
 * A footnote block is recognised by three things together:
 *   - a row that starts with a tiny raised number (the footnote marker),
 *   - whose text is smaller than the main text of that page,
 *   - with nothing larger anywhere below it (it runs to the foot of the page).
 * Everything from that row down is removed.
 */
function removeFootnoteBlock(page: PageFragments): number {
  const rows = groupIntoRows(page.fragments); // top to bottom
  const pageSize = findBodySize([page]);
  const rowSize = (row: Fragment[]) => Math.max(...row.map((f) => f.size));

  for (let i = 0; i < rows.length; i++) {
    const [marker, ...rest] = rows[i];
    if (rest.length === 0 || !/^\d{1,3}$/.test(marker.text.trim())) continue;
    const textSize = rowSize(rest);
    const markerIsRaised = marker.size <= textSize * 0.8;
    const smallerThanPage = textSize <= pageSize * 0.95;
    const nothingLargerBelow = rows.slice(i + 1).every((row) => rowSize(row) <= textSize + 0.5);
    if (!markerIsRaised || !smallerThanPage || !nothingLargerBelow) continue;

    const block = new Set(rows.slice(i).flat());
    page.fragments = page.fragments.filter((f) => !block.has(f));
    return countWords([...block]);
  }
  return 0;
}

/**
 * Size-based clean-up.
 *   - Tiny text is a superscript footnote marker (or a subscript). It is
 *     always removed, or it would glue a stray number onto a word.
 *   - Clearly small text is a reference list or fine print and is removed,
 *     unless it sits right next to body-size text on the same row. That
 *     exception keeps small capitals inside a sentence (the NIST framework
 *     prints GOVERN, MAP, MEASURE and MANAGE that way).
 * sources.json can set keepSmallPrint for a document whose tables are small.
 */
function removeSmallPrint(page: PageFragments, bodySize: number, keepSmallPrint: boolean): number {
  const isTiny = (f: Fragment) => f.size <= bodySize * TINY_RATIO;
  const isSmall = (f: Fragment) => f.size <= bodySize * SMALL_PRINT_RATIO;
  const drop = new Set<Fragment>();

  for (const row of groupIntoRows(page.fragments)) {
    row.forEach((f, i) => {
      if (isTiny(f)) return drop.add(f);
      if (!isSmall(f) || keepSmallPrint) return;
      const touchesBodyText = [row[i - 1], row[i + 1]].some(
        (neighbour) =>
          neighbour &&
          !isSmall(neighbour) &&
          Math.max(f.x0 - neighbour.x1, neighbour.x0 - f.x1) < 0.6 * f.size, // a word space at most
      );
      if (!touchesBodyText) drop.add(f);
    });
  }
  const words = countWords([...drop].filter((f) => !isTiny(f)));
  page.fragments = page.fragments.filter((f) => !drop.has(f));
  return words;
}

function countWords(fragments: Fragment[]): number {
  return fragments.reduce((n, f) => n + f.text.trim().split(/\s+/).length, 0);
}

/* ------------------------------------------------------------------ */
/* 5. Reading order                                                    */
/* ------------------------------------------------------------------ */

/**
 * "stream" layout: trust the order the PDF stores its text in. Documents
 * exported from Word keep that order sensible, including table cells, so
 * re-sorting by position would only make tables worse. A new line starts
 * whenever the vertical position changes.
 */
function linesInStreamOrder(page: PageFragments): Line[] {
  const lines: Line[] = [];
  let current: Fragment[] = [];
  const flush = () => {
    if (current.length > 0) lines.push(toLine(current, page.page));
    current = [];
  };
  for (const f of page.fragments) {
    const last = current[current.length - 1];
    if (last && !sameRow(last, f)) flush();
    current.push(f);
  }
  flush();
  return lines;
}

/**
 * "columns" layout: for pages printed in two or three columns (the Federal
 * Register, the International AI Safety Report). The stored order in these
 * files is unreliable, so we sort by position instead.
 *
 * A page can mix layouts: a full-width table, then two columns of text. So
 * the page is first cut into blocks at tall vertical gaps, and each block
 * into bands, where a band is a run of rows that share the same column
 * gutters. Inside a band each column is read top to bottom, left column
 * first. Rows with no gutters (headings, tables, boxes) are read straight
 * across.
 */
function linesInColumnOrder(page: PageFragments): { lines: Line[]; hasColumns: boolean } {
  const lines: Line[] = [];
  let hasColumns = false;

  // Blocks first: a tall vertical gap separates a table or figure from the
  // text around it, and each block gets its own column analysis.
  for (const rows of splitIntoBlocks(groupIntoRows(page.fragments))) {
    const guttersByRow = findGuttersByRow(rows, page.width);
    let columns: Line[][] = [];
    let currentBand = "";
    const flushColumns = () => {
      for (const column of columns) lines.push(...column);
      columns = [];
    };

    rows.forEach((row, i) => {
      const gutters = guttersByRow[i];
      const band = gutters.join(",");
      if (band !== currentBand) {
        flushColumns(); // a new band starts: finish the columns above it
        currentBand = band;
        columns = Array.from({ length: gutters.length + 1 }, () => []);
      }
      if (gutters.length === 0) {
        lines.push(toLine(row, page.page));
        return;
      }
      hasColumns = true;
      // Deal each piece of the row into its own column.
      for (let c = 0; c <= gutters.length; c++) {
        const left = gutters[c - 1] ?? -Infinity;
        const right = gutters[c] ?? Infinity;
        const piece = row.filter((f) => f.x0 >= left - 1 && f.x1 <= right + 1);
        if (piece.length > 0) columns[c].push(toLine(piece, page.page));
      }
    });
    flushColumns();
  }
  return { lines, hasColumns };
}

/** Split rows (top to bottom) wherever the vertical gap is much taller than a line. */
function splitIntoBlocks(rows: Fragment[][]): Fragment[][][] {
  const blocks: Fragment[][][] = [];
  let current: Fragment[][] = [];
  const rowSize = (row: Fragment[]) => Math.max(...row.map((f) => f.size));
  for (const row of rows) {
    const previous = current[current.length - 1];
    if (previous) {
      const gap = previous[0].y - row[0].y;
      if (gap > BLOCK_GAP * Math.max(rowSize(previous), rowSize(row))) {
        blocks.push(current);
        current = [];
      }
    }
    current.push(row);
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

/**
 * For every row, the x positions of the column gutters that apply to it.
 *
 * A gutter is a vertical strip of white space with a column of running text
 * on each side. Finding one takes two steps:
 *   1. Candidates: strips at least GUTTER_MIN_WIDTH wide where clearly fewer
 *      rows have text than on either side of the strip.
 *   2. Proof, band by band: an unbroken run of rows that are all blank at
 *      the strip, with text on both sides, where a fair share of rows have a
 *      proper line of text running right up to the strip. Word spaces in a
 *      paragraph never line up like that, and bullets and table cells are
 *      too short or stop well before the next column, so tables stay as rows.
 */
function findGuttersByRow(rows: Fragment[][], pageWidth: number): number[][] {
  const result: number[][] = rows.map(() => []);
  if (rows.length < GUTTER_MIN_RUN) return result;
  const width = Math.ceil(pageWidth);
  const inkRows = new Array<number>(width).fill(0); // rows with text at x
  for (const row of rows) {
    const covered = new Set<number>();
    for (const f of row) {
      for (let x = Math.max(0, Math.floor(f.x0)); x < Math.min(width, Math.ceil(f.x1)); x++) covered.add(x);
    }
    for (const x of covered) inkRows[x]++;
  }

  // Step 1: candidate strips. A "valley": far fewer rows have text here
  // than at some point to the left and at some point to the right.
  const peakToLeft: number[] = [];
  const peakToRight: number[] = new Array<number>(width).fill(0);
  for (let x = 0, peak = 0; x < width; x++) peakToLeft[x] = peak = Math.max(peak, inkRows[x]);
  for (let x = width - 1, peak = 0; x >= 0; x--) peakToRight[x] = peak = Math.max(peak, inkRows[x]);
  const candidates: number[] = [];
  let stripStart = -1;
  for (let x = 0; x <= width; x++) {
    const sides = x < width ? Math.min(peakToLeft[x], peakToRight[x]) : 0;
    const isValley = x < width && sides >= GUTTER_MIN_SIDE && inkRows[x] <= sides * GUTTER_VALLEY;
    if (isValley && stripStart < 0) stripStart = x;
    if (!isValley && stripStart >= 0) {
      if (x - stripStart >= GUTTER_MIN_WIDTH) candidates.push(emptiestPoint(inkRows, stripStart, x));
      stripStart = -1;
    }
  }

  // Step 2: for each candidate, find the runs of rows where it really is a gutter.
  for (const g of candidates) {
    const crosses = (row: Fragment[]) => row.some((f) => f.x0 < g - 1 && f.x1 > g + 1);
    let runStart = 0;
    for (let i = 0; i <= rows.length; i++) {
      if (i < rows.length && !crosses(rows[i])) continue;
      const run = rows.slice(runStart, i);
      // For each row with text on the left of the strip: does a proper line
      // of text (not just a bullet or a short table cell) run up to it?
      const leftRows = run.filter((row) => row.some((f) => f.x1 <= g + 1));
      const rightRows = run.filter((row) => row.some((f) => f.x0 >= g - 1)).length;
      const reachesGutter = leftRows.filter((row) => {
        const left = row.filter((f) => f.x1 <= g + 1); // sorted left to right
        let start = left.length - 1;
        while (start > 0 && left[start].x0 - left[start - 1].x1 < 10) start--; // same line of text
        const end = left[left.length - 1].x1;
        return g - end <= GUTTER_REACH && end - left[start].x0 >= GUTTER_MIN_LINE;
      }).length;
      const isColumnBand =
        run.length >= GUTTER_MIN_RUN &&
        rightRows >= GUTTER_MIN_SIDE &&
        reachesGutter >= GUTTER_MIN_SIDE &&
        reachesGutter >= run.length * GUTTER_REACH_SHARE;
      if (isColumnBand) {
        for (let k = runStart; k < i; k++) result[k].push(g);
      }
      runStart = i + 1;
    }
  }
  return result; // candidates were found left to right, so each list is sorted
}

/**
 * The blank strip can be wider than the real gutter (short last lines of
 * paragraphs leave white space at the edge of a column). The real gutter is
 * where the fewest rows have text, so take the middle of that stretch.
 */
function emptiestPoint(inkRows: number[], from: number, to: number): number {
  const least = Math.min(...inkRows.slice(from, to));
  const xs: number[] = [];
  for (let x = from; x < to; x++) if (inkRows[x] === least) xs.push(x);
  return xs[Math.floor(xs.length / 2)] + 0.5;
}

/* ------------------------------------------------------------------ */
/* 6. Headings                                                         */
/* ------------------------------------------------------------------ */

/**
 * Mark the headings on one page. A heading is one of two things:
 *   - a short run of lines (one to three) set clearly larger than the main
 *     text of that page; the run is merged into a single heading line;
 *   - a short line that starts with an outline number: "IV. Scope",
 *     "A. Background", "2.1 Valid and Reliable", "Appendix B", and in
 *     single-column documents "1. Introduction".
 * "Larger" means larger than both the main text of the page and the main
 * text of the document. The page matters because some documents set whole
 * chapters in a bigger font; the document matters because a page of small
 * quoted material would otherwise make ordinary body lines look large.
 */
function markHeadings(lines: Line[], bodySize: number, layout: Layout): Line[] {
  if (lines.length === 0) return lines;
  const charsBySize = new Map<number, number>();
  for (const line of lines) {
    const size = Math.round(line.size * 2) / 2;
    charsBySize.set(size, (charsBySize.get(size) ?? 0) + line.text.length);
  }
  const pageSize = [...charsBySize.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const reference = Math.max(pageSize, bodySize);
  const isLarge = (line: Line) => line.size >= reference * HEADING_RATIO && /[A-Za-z]{3}/.test(line.text);
  const outline = /^(?:[IVXLC]+\.|[A-Z]\.|\d+(?:\.\d+)+\.?|Appendix [A-Z0-9]+[.:]?|Chapter \d+[.:]?)\s+[A-Z]/;
  const topLevel = /^\d{1,2}\.\s+[A-Z][a-z]/; // "1. Introduction"
  const wordCount = (text: string) => text.split(/\s+/).length;

  const result: Line[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isLarge(lines[i])) {
      let end = i;
      while (end + 1 < lines.length && isLarge(lines[end + 1]) && lines[end + 1].size === lines[i].size) end++;
      const run = lines.slice(i, end + 1);
      const text = run.map((line) => line.text).join(" ");
      if (run.length <= 3 && wordCount(text) <= 24) {
        result.push({ ...lines[i], text, isHeading: true });
      } else {
        result.push(...run); // a long run of large text is body text, not a heading
      }
      i = end;
      continue;
    }
    // A numbered heading is short, has no closing punctuation, and the line
    // after it starts a new sentence. (A list item that wraps continues in
    // lower case on the next line.)
    const line = lines[i];
    const next = lines[i + 1];
    const startsFresh = !next || /^["'(\u201C\u2018]?[A-Z0-9]/.test(next.text);
    const short = wordCount(line.text) <= 12 && !/[.;,:]$/.test(line.text);
    const endsMidPhrase = /\b(of|the|a|an|and|or|to|for|in|on|with|by|as|per|that|is|are)$/i.test(line.text);
    // "1. Introduction" style headings are only trusted in single-column
    // documents. In narrow columns every wrapped list item looks like one.
    const pattern = outline.test(line.text) || (layout === "stream" && topLevel.test(line.text));
    const numbered = pattern && short && startsFresh && !endsMidPhrase;
    result.push(numbered ? { ...line, isHeading: true } : line);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Two fragments are on the same row if their baselines are close. */
function sameRow(a: Fragment, b: Fragment): boolean {
  return Math.abs(a.y - b.y) < 0.45 * Math.max(a.size, b.size, 8);
}

/** Group fragments into rows, top of page first, each row left to right. */
function groupIntoRows(fragments: Fragment[]): Fragment[][] {
  const sorted = [...fragments].sort((a, b) => b.y - a.y);
  const rows: Fragment[][] = [];
  for (const f of sorted) {
    const row = rows[rows.length - 1];
    if (row && sameRow(row[0], f)) row.push(f);
    else rows.push([f]);
  }
  for (const row of rows) row.sort((a, b) => a.x0 - b.x0);
  return rows;
}

/** Join fragments into text, adding a space where there is a visible gap. */
function joinFragments(fragments: Fragment[]): string {
  let text = "";
  let previous: Fragment | undefined;
  for (const f of fragments) {
    if (previous) {
      const gap = f.x0 - previous.x1;
      const needsSpace = gap > 0.12 * f.size && !/\s$/.test(text) && !/^\s/.test(f.text);
      if (needsSpace) text += " ";
    }
    text += f.text;
    previous = f;
  }
  // Dot leaders ("Radio ........ Yes") become a single space. They appear in
  // contents pages, which sources.json skips, and in some real tables.
  return text
    .replace(/(?:\.\s?){5,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toLine(fragments: Fragment[], page: number): Line {
  // Use the size most of the line is set in, so one large initial or one
  // small symbol does not change how the whole line is classified.
  const longest = [...fragments].sort((a, b) => b.text.length - a.text.length)[0];
  return { text: joinFragments(fragments), page, size: longest.size, isHeading: false };
}
