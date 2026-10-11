/**
 * models.ts: the one place that knows which AI providers we use.
 *
 * The Vercel AI SDK gives every provider the same interface, so the rest of
 * the code calls embed() and streamText() without caring who is behind them.
 * To switch provider, change the two functions below and nothing else.
 *
 *   Chat:       Anthropic, reads ANTHROPIC_API_KEY
 *   Embeddings: OpenAI, reads OPENAI_API_KEY
 *               (Anthropic does not offer an embedding model)
 */
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { CHAT_MODEL, EMBEDDING_MODEL } from "./config";

export const chatModel = () => anthropic(CHAT_MODEL);
export const embeddingModel = () => openai.embeddingModel(EMBEDDING_MODEL);
