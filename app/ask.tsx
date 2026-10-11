"use client";

/**
 * ask.tsx: the question box, the streamed answer and the passages used.
 *
 * It posts the question to /api/ask and reads the reply line by line. Each
 * line is one JSON event: first the passages, then pieces of answer text.
 */
import { useEffect, useRef, useState } from "react";
import type { RetrievedPassage } from "@/lib/retrieve";

const EXAMPLES = [
  "Is a robot speed reduction near workers a safety-related control?",
  "When should a driver-facing system require confirmation before acting?",
  "What does NIST say about human oversight?",
];

type Status = "idle" | "searching" | "writing" | "done" | "error";

const STATUS_MESSAGE: Record<Status, string> = {
  idle: "",
  searching: "Searching the documents.",
  writing: "Writing the answer.",
  done: "Answer ready.",
  error: "Something went wrong.",
};

export default function Ask() {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [answer, setAnswer] = useState("");
  const [passages, setPassages] = useState<RetrievedPassage[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const currentRequest = useRef<AbortController | null>(null);
  const answerSection = useRef<HTMLElement | null>(null);

  const busy = status === "searching" || status === "writing";

  // When a question is sent, bring the answer into view. Without this the
  // answer can start below the bottom of the screen, especially on a phone.
  // People who ask their system for less motion get a jump, not a glide.
  useEffect(() => {
    if (status !== "searching") return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    answerSection.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }, [status, asked]);

  async function ask(text: string) {
    const trimmed = text.trim();
    if (trimmed === "") return;

    // Asking again cancels an answer that is still streaming.
    currentRequest.current?.abort();
    const controller = new AbortController();
    currentRequest.current = controller;

    setQuestion(trimmed);
    setAsked(trimmed);
    setStatus("searching");
    setAnswer("");
    setPassages([]);
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "The request failed. Please try again.");
      }

      // Read the stream and split it into lines. A network chunk can end in
      // the middle of a line, so the unfinished part waits in `buffer`.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim() === "") continue;
          const event = JSON.parse(line);
          if (event.type === "passages") {
            setPassages(event.passages);
            setStatus("writing");
          } else if (event.type === "text") {
            setAnswer((current) => current + event.text);
          } else if (event.type === "notice") {
            setNotice(event.message);
          } else if (event.type === "done") {
            setStatus("done");
          } else if (event.type === "error") {
            throw new Error(event.message);
          }
        }
      }
    } catch (caught) {
      if (controller.signal.aborted) return; // replaced by a newer question
      setError(caught instanceof Error ? caught.message : "Something went wrong. Please try again.");
      setStatus("error");
    }
  }

  return (
    <>
      <form
        className="ask"
        onSubmit={(event) => {
          event.preventDefault();
          ask(question);
        }}
      >
        <label htmlFor="question" className="label">
          Your question
        </label>
        <textarea
          id="question"
          name="question"
          value={question}
          maxLength={500}
          rows={3}
          required
          aria-describedby="question-hint"
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter makes a new line.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              ask(question);
            }
          }}
        />
        <div className="ask-row">
          <span id="question-hint" className="meta">
            Enter to ask. Shift+Enter for a new line.
          </span>
          <button type="submit" className="button" disabled={busy}>
            {busy ? "Working" : "Ask"}
          </button>
        </div>

        <ul className="examples" aria-label="Example questions">
          {EXAMPLES.map((example, index) => (
            <li key={example}>
              <span className="meta" aria-hidden="true">
                Q{index + 1}
              </span>
              <button type="button" className="link-button" onClick={() => ask(example)}>
                {example}
              </button>
            </li>
          ))}
        </ul>
      </form>

      {/* Screen readers hear these short status changes, not every streamed word. */}
      <p role="status" className="visually-hidden">
        {STATUS_MESSAGE[status]}
      </p>

      {status !== "idle" && (
        <section ref={answerSection} className="answer" aria-labelledby="answer-heading" aria-busy={busy}>
          <h2 id="answer-heading" className="section-heading">
            Answer
          </h2>
          <p className="asked">{asked}</p>

          {status === "searching" && <p className="meta">Searching the documents.</p>}
          {error !== "" && <p className="error">{error}</p>}
          {answer !== "" && (
            <p className="answer-text">
              <AnswerText text={answer} passages={passages} />
            </p>
          )}

          {notice !== "" && <p className="meta">{notice}</p>}

          {passages.length > 0 && (
            <details className="passages">
              <summary className="label">Passages used ({passages.length})</summary>
              <ol className="passage-list">
                {passages.map((passage) => (
                  <li key={passage.id} className="passage">
                    <div className="passage-head">
                      <a href={passage.link} target="_blank" rel="noreferrer">
                        {passage.docShortName}, {passage.locator}
                      </a>
                      <span className="meta">match {passage.similarity.toFixed(2)}</span>
                    </div>
                    {passage.section && <p className="passage-section meta">{passage.section}</p>}
                    <p className="passage-text">{passage.content}</p>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </section>
      )}
    </>
  );
}

/**
 * Turn citation tags in the answer into links.
 *
 * The model was told to copy each passage's tag exactly, for example
 * [NIST AI RMF, p. 12]. A tag that matches a retrieved passage becomes a link
 * to that page of the source, shown on a yellow mark without its brackets.
 * A tag that matches nothing stays plain grey text in brackets, which makes
 * an invented citation easy to spot.
 */
function AnswerText({ text, passages }: { text: string; passages: RetrievedPassage[] }) {
  const byCitation = new Map(passages.map((p) => [p.citation, p]));
  const parts = text.split(/(\[[^\[\]\n]{3,90}\])/);

  return (
    <>
      {parts.map((part, index) => {
        if (!part.startsWith("[")) return part;
        // "[A, p. 1; B, p. 2]" is treated as two tags.
        const tags = part.slice(1, -1).split(";").map((tag) => `[${tag.trim()}]`);
        return (
          <span key={index} className="citation">
            {tags.map((tag, i) => {
              const passage = byCitation.get(tag);
              return (
                <span key={tag + i}>
                  {i > 0 && " "}
                  {passage ? (
                    <a href={passage.link} target="_blank" rel="noreferrer" title={passage.docTitle}>
                      {tag.slice(1, -1)}
                    </a>
                  ) : (
                    <span className="citation-unmatched">{tag}</span>
                  )}
                </span>
              );
            })}
          </span>
        );
      })}
    </>
  );
}
