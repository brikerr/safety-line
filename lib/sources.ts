/**
 * sources.ts: the list of documents, loaded from data/pdfs/sources.json.
 * That JSON file is the single source of truth for titles, URLs and licenses.
 * The ingestion script, the page footer and the README all read from it.
 */
import data from "../data/pdfs/sources.json";

export type Source = {
  id: string; // short id used in the database and file names
  shortName: string; // the name used inside citations
  title: string;
  publisher: string;
  year: number;
  published: string | null; // ISO date
  url: string; // the document's official page
  fileUrl: string; // direct link to the PDF or HTML file
  file: string; // file name inside data/pdfs/
  format: "pdf" | "html";
  pageCount: number | null;
  license: string;
  licenseShort: string; // one line for the page footer
  licenseNote: string;
  layout: "stream" | "columns" | "html"; // how to read it, see scripts/lib/pdf.ts
  unmappedGlyph?: string; // what a glyph with no Unicode mapping stands for
  keepSmallPrint?: boolean; // keep small text (for documents whose tables are set small)
  skipPages?: { from: number; to: number; reason: string }[];
};

export const sources = data as Source[];
