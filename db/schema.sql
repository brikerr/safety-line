-- Safety Line database schema.
-- The ingestion script runs this file every time, inside a transaction, so
-- the table is rebuilt cleanly and a failed run leaves the old data in place.
-- The script replaces the DIMENSIONS placeholder below with EMBEDDING_DIMENSIONS.

create extension if not exists vector;

drop table if exists passages;

create table passages (
  id             bigserial primary key,
  doc_id         text not null,      -- short id, e.g. 'nist-ai-rmf'
  doc_title      text not null,
  doc_short_name text not null,      -- the name used in citations
  locator        text not null,      -- 'p. 12', 'pp. 12-13' or 'sec. VIII'
  page_start     integer,            -- position in the PDF file; null for web pages
  page_end       integer,
  section        text,               -- nearest heading above the passage, if found
  published      date,               -- publication date of the document
  source_url     text not null,      -- the document's official page
  link           text not null,      -- deep link to the page or section
  content        text not null,
  word_count     integer not null,
  embedding      vector({{DIMENSIONS}}) not null
);

create index passages_doc_id on passages (doc_id);

-- No vector index on purpose. With around a thousand rows Postgres compares
-- the question against every passage in a few milliseconds, and an exact scan
-- never misses a match.
-- TODO: when the corpus grows past roughly 50,000 passages, add
--   create index on passages using hnsw (embedding vector_cosine_ops);
-- TODO (hybrid search): add a tsvector column and a GIN index for keyword search.
