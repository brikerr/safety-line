/**
 * The single page. Everything static (headline, document list, disclaimer)
 * is rendered on the server. The interactive part lives in <Ask />.
 */
import Ask from "./ask";
import { ABOUT_LINE } from "@/lib/about";
import { sources } from "@/lib/sources";

export default function Home() {
  return (
    <>
      <p className="about">
        <span className="label">About</span> {ABOUT_LINE} <a href="#documents-heading">See the documents.</a>
      </p>

      <h1 className="headline">
        What counts as a safety-related control, and when must a human confirm before a system acts?
      </h1>

      <p className="intro">
        Ask a question like this one. Every claim in the answer links to the page it came from. When the documents
        do not cover something, it says so.
      </p>

      <Ask />

      <section className="documents" aria-labelledby="documents-heading">
        <h2 id="documents-heading" className="section-heading">
          The documents
        </h2>
        <ul className="rows">
          {sources.map((source) => (
            <li key={source.id}>
              <span className="meta">{source.year}</span>
              <span>
                <a href={source.url}>{source.title}</a>
                <span className="meta">
                  {source.publisher}. {source.licenseShort}.
                </span>
              </span>
            </li>
          ))}
        </ul>
        <p className="meta">
          Contains public sector information licensed under the Open Government Licence v3.0. Page numbers in
          citations count pages of the PDF file, which can differ from the number printed on the page.
        </p>
      </section>

      <p className="disclaimer meta">
        Answers come only from the listed public documents. Not legal, medical, or engineering advice.
      </p>
    </>
  );
}
