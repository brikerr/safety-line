/**
 * chunk.ts: split one document's text into passages of roughly 300 to 500 words.
 *
 * Why chunk at all? An embedding squeezes a piece of text into one vector.
 * A whole page mixes several topics and gives a blurry vector; a single
 * sentence loses its context. A few hundred words is the usual middle
 * ground: one idea, with enough around it to be understood on its own.
 *
 * The rules:
 *   - Aim for TARGET words, never more than MAX.
 *   - Prefer to cut at the end of a sentence.
 *   - Cut at a section heading when the passage is already a decent size,
 *     so a passage does not straddle two topics.
 *   - Start each passage with the last sentence or so of the one before it
 *     (the overlap), so an idea that crosses a cut is findable from both sides.
 *   - A passage never crosses a document boundary, because this function
 *     only ever sees one document.
 */

/** One line of cleaned text, from a PDF page or an HTML section. */
export type TextLine = {
  text: string;
  page: number | null; // null for HTML documents, which have no pages
  isHeading: boolean;
  anchor?: string; // HTML only: the id to deep link to
  breakBefore?: boolean; // true when pages were skipped just before this line
};

export type Passage = {
  content: string;
  wordCount: number;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  anchor: string | null;
};

const TARGET = 400;
const MIN = 300;
const MAX = 500;
const OVERLAP = 50;
const MIN_BEFORE_HEADING = 150; // do not cut at a heading if the passage would be tiny
const MIN_TAIL = 120; // a shorter leftover is merged into the passage before it

type Word = {
  text: string;
  page: number | null;
  section: string | null;
  anchor: string | null;
  startsHeading: boolean; // first word of a heading line
  hardBreak: boolean; // a passage must never continue across this word
  endsHeading: boolean; // last word of a heading line
  endsSentence: boolean;
};

export function chunkDocument(lines: TextLine[]): Passage[] {
  const words = toWords(lines);
  const passages: Passage[] = [];
  let start = 0;

  while (start < words.length) {
    let end = chooseCut(words, start);
    // Avoid leaving a scrap at the end of the document.
    const tailHasBreak = words.slice(end).some((w) => w.hardBreak);
    if (words.length - end < MIN_TAIL && !tailHasBreak) end = words.length;
    passages.push(toPassage(words, start, end));
    if (end >= words.length) break;
    start = overlapStart(words, start, end);
  }
  return passages;
}

/** Flatten lines into words, remembering page and section for each word. */
function toWords(lines: TextLine[]): Word[] {
  const words: Word[] = [];
  let section: string | null = null;
  let anchor: string | null = null;

  // Every whole word in the document, used below to undo line-break hyphens.
  const vocabulary = new Set<string>();
  for (const line of lines) {
    for (const word of line.text.toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) ?? []) vocabulary.add(word);
  }

  for (const line of lines) {
    const parts = line.text.split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    if (line.isHeading) section = line.text;
    if (line.anchor) anchor = line.anchor;

    parts.forEach((text, i) => {
      const previous = words[words.length - 1];
      // A word split across a line break ends in a hyphen: "guide-" + "lines",
      // but also "visual-" + "manual". To tell them apart, check which
      // spelling the document itself uses elsewhere. If "guidelines" appears
      // as a whole word, drop the hyphen; otherwise keep it.
      const continuesWord =
        i === 0 && previous && !line.isHeading && !previous.endsHeading && !line.breakBefore && /\w-$/.test(previous.text);
      if (continuesWord) {
        const start = previous.text.slice(0, -1);
        const joined = (start + text).toLowerCase().replace(/[^a-z]/g, "");
        const isOneWord = /^[a-z]/.test(text) && vocabulary.has(joined);
        previous.text = isOneWord ? start + text : previous.text + text;
        return;
      }
      words.push({
        text,
        page: line.page,
        section,
        anchor,
        startsHeading: line.isHeading && i === 0,
        hardBreak: line.breakBefore === true && i === 0,
        endsHeading: line.isHeading && i === parts.length - 1,
        endsSentence: false,
      });
    });
  }

  // A sentence ends at . ! or ? (optionally followed by a closing quote or
  // bracket) when the next word starts with a capital, a digit or an opener.
  // Abbreviations like "e.g." cause a few false endings. That is harmless:
  // sentence ends are only used as preferred places to cut.
  for (let i = 0; i < words.length; i++) {
    const next = words[i + 1];
    const looksFinal = /[.!?]["')\]”’]*$/.test(words[i].text);
    const nextStarts = !next || /^["'(\[“‘]?[A-Z0-9]/.test(next.text);
    words[i].endsSentence = words[i].endsHeading || (looksFinal && nextStarts);
  }
  return words;
}

/** Decide where the passage that begins at `start` should end (exclusive). */
function chooseCut(words: Word[], start: number): number {
  const hardEnd = Math.min(start + MAX, words.length);

  // 0. Skipped pages (a reference list, say) end the passage, whatever its size.
  for (let i = start + 1; i < hardEnd; i++) {
    if (words[i].hardBreak) return i;
  }

  // 1. A heading inside the window ends the passage just before it.
  const heading = firstHeadingBetween(words, start + MIN_BEFORE_HEADING, hardEnd);
  if (heading !== null) return heading;

  // The rest of the document fits in one passage.
  if (hardEnd === words.length) return hardEnd;

  // 2. Otherwise cut at the sentence end closest to the target length.
  let best = -1;
  for (let i = start + MIN; i < hardEnd; i++) {
    if (!words[i].endsSentence) continue;
    const distance = Math.abs(i + 1 - (start + TARGET));
    if (best < 0 || distance < Math.abs(best - (start + TARGET))) best = i + 1;
  }
  // 3. No sentence end in range (a long table, say): cut at the hard limit.
  return best > 0 ? best : hardEnd;
}

function firstHeadingBetween(words: Word[], from: number, to: number): number | null {
  for (let i = from; i < to; i++) {
    if (words[i].startsHeading) return i;
  }
  return null;
}

/** Where the next passage starts: back up about OVERLAP words to a sentence start. */
function overlapStart(words: Word[], start: number, end: number): number {
  // Do not overlap backwards across a heading: the next passage is a new topic.
  if (words[end]?.startsHeading || words[end]?.hardBreak) return end;
  for (let back = OVERLAP; back <= OVERLAP + 30; back++) {
    const i = end - back;
    if (i <= start) break;
    if (words[i - 1].endsSentence) return i;
  }
  return Math.max(end - OVERLAP, start + 1);
}

function toPassage(words: Word[], start: number, end: number): Passage {
  const slice = words.slice(start, end);
  let content = "";
  for (const word of slice) {
    // Put headings on their own line so the passage reads like the source.
    const separator = content === "" ? "" : word.startsHeading ? "\n" : " ";
    content += separator + word.text + (word.endsHeading ? "\n" : "");
  }
  content = content.replace(/\n\s+/g, "\n").trim();

  // Label the passage with the section most of it belongs to: the section of
  // its first word that comes after the overlap.
  const anchorWord = slice[Math.min(OVERLAP + 30, slice.length - 1)];
  const pages = slice.map((w) => w.page).filter((p): p is number => p !== null);
  return {
    content,
    wordCount: slice.length,
    pageStart: pages.length ? Math.min(...pages) : null,
    pageEnd: pages.length ? Math.max(...pages) : null,
    section: anchorWord.section,
    anchor: anchorWord.anchor,
  };
}
