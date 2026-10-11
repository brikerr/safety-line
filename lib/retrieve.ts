/**
 * retrieve.ts: find the passages most similar to a question.
 *
 * This is the "R" in RAG. The question is turned into a vector with the same
 * embedding model used for the passages, and Postgres returns the passages
 * whose vectors point in the most similar direction.
 *
 * `<=>` is pgvector's cosine distance operator: 0 means same direction,
 * 1 means unrelated. Similarity is 1 minus distance.
 */
import { embed } from "ai";
import { TOP_K } from "./config";
import { getPool, toVectorLiteral } from "./db";
import { embeddingModel } from "./models";

export type RetrievedPassage = {
  id: number;
  citation: string; // the exact tag the model must use, e.g. "[NIST AI RMF, p. 12]"
  docTitle: string;
  docShortName: string;
  locator: string;
  section: string | null;
  published: string | null;
  sourceUrl: string;
  link: string;
  content: string;
  similarity: number;
};

export async function retrieve(question: string): Promise<RetrievedPassage[]> {
  const { embedding } = await embed({ model: embeddingModel(), value: question });

  const { rows } = await getPool().query(
    `select id, doc_title, doc_short_name, locator, section,
            to_char(published, 'YYYY-MM-DD') as published,
            source_url, link, content,
            1 - (embedding <=> $1::vector) as similarity
       from passages
      order by embedding <=> $1::vector
      limit $2`,
    [toVectorLiteral(embedding), TOP_K],
  );
  // TODO (hybrid search): also run a keyword query and merge the two lists.
  // TODO (reranking): fetch about 30 here and let a reranker pick the best 6.
  // TODO (filters): accept a domain filter and add "where doc_id = any($3)".

  return rows.map((row) => ({
    id: Number(row.id),
    citation: `[${row.doc_short_name}, ${row.locator}]`,
    docTitle: row.doc_title,
    docShortName: row.doc_short_name,
    locator: row.locator,
    section: row.section,
    published: row.published,
    sourceUrl: row.source_url,
    link: row.link,
    content: row.content,
    similarity: Number(row.similarity),
  }));
}
