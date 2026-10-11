/**
 * db.ts: one shared Postgres connection pool.
 *
 * DATABASE_URL is the connection string from Neon (use the "pooled" one).
 * The pool is created once and reused, including across hot reloads in
 * development, so we do not open a new connection for every question.
 */
import { Pool } from "pg";

const globalForDb = globalThis as unknown as { pool?: Pool };

export function getPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
  }
  globalForDb.pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  return globalForDb.pool;
}

/** pgvector accepts a vector written as text: '[0.1,0.2,0.3]'. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
