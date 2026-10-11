/**
 * POST /api/ask
 *
 * Body:     { "question": "..." }
 * Response: a stream of JSON lines (one JSON object per line):
 *   {"type":"passages","passages":[...]}   sent first, as soon as retrieval is done
 *   {"type":"text","text":"..."}           many of these, as the model writes
 *   {"type":"notice","message":"..."}      only if the answer was cut short
 *   {"type":"done"}                        or {"type":"error","message":"..."}
 *
 * Sending the passages first means the page can show its sources while the
 * answer is still being written.
 *
 * Before any of that, two checks: a question about the app itself gets a
 * fixed explanation (lib/about.ts), and a visitor over the rate limit gets a
 * 429 with a friendly message (lib/rate-limit.ts).
 */
import { streamText } from "ai";
import { ABOUT_ANSWER, isAboutQuestion } from "@/lib/about";
import { CHAT_MODEL, MAX_QUESTION_LENGTH } from "@/lib/config";
import { chatModel } from "@/lib/models";
import { buildUserMessage, SYSTEM_PROMPT } from "@/lib/prompt";
import { checkRateLimit } from "@/lib/rate-limit";
import { retrieve } from "@/lib/retrieve";

// Give the model time to finish a long answer (seconds, on Vercel).
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (question === "") {
    return Response.json({ error: "Please enter a question." }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return Response.json(
      { error: `Please keep the question under ${MAX_QUESTION_LENGTH} characters.` },
      { status: 400 },
    );
  }

  // A question about the app itself gets a fixed explanation. It costs
  // nothing, so it comes before the rate limit and does not count against it.
  if (isAboutQuestion(question)) {
    return jsonLines([{ type: "passages", passages: [] }, { type: "text", text: ABOUT_ANSWER }, { type: "done" }]);
  }

  // Rate limit: refuse before anything that costs money has happened.
  try {
    const limit = await checkRateLimit(request);
    if (!limit.allowed) return Response.json({ error: limit.message }, { status: 429 });
  } catch (error) {
    console.error("Rate limit check failed:", error);
    return Response.json(
      { error: "The document search is not available right now. Please try again shortly." },
      { status: 500 },
    );
  }

  // Step 1: retrieval. If this fails (database down, missing key) we can
  // still return a normal error response because nothing has streamed yet.
  let passages;
  try {
    passages = await retrieve(question);
  } catch (error) {
    console.error("Retrieval failed:", error);
    return Response.json(
      { error: "The document search is not available right now. Please try again shortly." },
      { status: 500 },
    );
  }
  if (passages.length === 0) {
    return Response.json(
      { error: "No documents are loaded yet. Run the ingestion script first." },
      { status: 503 },
    );
  }

  // Step 2: generation. Only the retrieved passages go to the model.
  const result = streamText({
    model: chatModel(),
    system: SYSTEM_PROMPT,
    prompt: buildUserMessage(question, passages),
    maxOutputTokens: 1500, // roomy: the prompt asks for about 250 words
    onError: ({ error }) => console.error(`Chat model (${CHAT_MODEL}) failed:`, error),
  });

  // Step 3: stream JSON lines back to the browser.
  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController, event: object) =>
    controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));

  const stream = new ReadableStream({
    async start(controller) {
      send(controller, { type: "passages", passages });
      try {
        let wroteText = false;
        for await (const text of result.textStream) {
          wroteText = true;
          send(controller, { type: "text", text });
        }
        // streamText swallows errors so the server keeps running, which
        // means an empty stream is how a failed model call shows up here.
        if (!wroteText) throw new Error("The model returned no text.");
        // "length" means the model hit maxOutputTokens before it finished.
        // Say so, or a cut-off answer looks like a complete one.
        if ((await result.finishReason) === "length") {
          send(controller, { type: "notice", message: "This answer hit the length limit and was cut short." });
        }
        send(controller, { type: "done" });
      } catch (error) {
        console.error("Answer stream failed:", error);
        send(controller, { type: "error", message: "The answer could not be completed. Please try again." });
      } finally {
        controller.close();
      }
    },
  });

  // TODO (evals): log question, passage ids and answer here to score them later.
  // TODO (chat history): each question stands alone; nothing is remembered.
  return new Response(stream, { headers: JSON_LINES_HEADERS });
}

const JSON_LINES_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-store",
};

/** A complete response made of ready-made events, in the same format as a streamed one. */
function jsonLines(events: object[]): Response {
  return new Response(events.map((event) => JSON.stringify(event) + "\n").join(""), { headers: JSON_LINES_HEADERS });
}
