/**
 * html.ts: turn the OSHA Technical Manual chapter (a web page) into lines.
 *
 * HTML is far easier than PDF because the structure is already there:
 * headings are heading tags and paragraphs are paragraph tags. A web page
 * has no page numbers, so passages from it are cited by section instead,
 * and each section heading's id gives us a deep link.
 */
import { readFile } from "node:fs/promises";
import * as cheerio from "cheerio";
import type { TextLine } from "./chunk";

// The chapter body on osha.gov. Everything outside it is site navigation.
const BODY_SELECTOR = ".field--name-field-acdoc-body";
// Sections we leave out: the bibliography is a list of titles, not guidance.
const SKIP_SECTIONS = [/^XI\. References/i];

export async function extractHtml(path: string): Promise<{ lines: TextLine[]; sections: number }> {
  const $ = cheerio.load(await readFile(path, "utf8"));
  const body = $(BODY_SELECTOR).first();
  if (body.length === 0) {
    throw new Error(`Could not find the chapter body (${BODY_SELECTOR}). The page layout may have changed.`);
  }
  // Footnote markers are superscript links like <sup><a href="#ftn3">3</a></sup>,
  // and the footnotes themselves sit in <div id="ftn3"> blocks at the end.
  body.find("sup, [id^='ftn']").remove();

  const lines: TextLine[] = [];
  let anchor: string | undefined;
  let started = false; // skip the on-page table of contents before section I
  let skipping = false;
  let sections = 0;

  // Walk headings and text blocks in document order. Table cells are taken
  // one cell per line; list items, paragraphs and figure captions one block per line.
  body.find("h5, p, li, td, th, figcaption").each((_, element) => {
    const el = $(element);
    const text = el.text().replace(/\s+/g, " ").trim();
    if (text === "") return;

    if (element.tagName === "h5") {
      started = true;
      skipping = SKIP_SECTIONS.some((pattern) => pattern.test(text));
      if (skipping) return;
      anchor = el.attr("id");
      sections++;
      lines.push({ text, page: null, isHeading: true, anchor });
      return;
    }
    if (!started || skipping) return;
    // A <p> inside a <li> or table cell would otherwise be counted twice.
    if (el.parents("li, td, th").length > 0) return;
    lines.push({ text, page: null, isHeading: false, anchor });
  });

  return { lines, sections };
}
