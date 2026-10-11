/**
 * config.ts: the settings shared by the ingestion script and the web app.
 *
 * Both sides must agree on the embedding model. A question is only
 * comparable to a passage if both were embedded by the same model, so if
 * you change EMBEDDING_MODEL you must run ingestion again.
 */

/** Chat model that writes the answer. Any Anthropic model id works here. */
export const CHAT_MODEL = process.env.CHAT_MODEL ?? "claude-sonnet-5-5";

/** Embedding model that turns text into vectors. Any OpenAI embedding model id. */
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";

/** Vector length the embedding model returns. 1536 for text-embedding-3-small. */
export const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS ?? 1536);

/** How many passages to retrieve for each question. */
export const TOP_K = 6;

/** Longest question we accept, in characters. Keeps a public endpoint cheap. */
export const MAX_QUESTION_LENGTH = 500;

/** Rate limits, see lib/rate-limit.ts. */
export const PER_VISITOR_PER_HOUR = 10; // questions one visitor may ask in an hour
export const GLOBAL_PER_DAY = 200; // questions answered for everyone in a day
