/**
 * rate-limit.ts: a cap on how many questions get answered.
 *
 * Every answered question costs money (one embedding call, one chat call),
 * and the endpoint is public. Two limits protect it:
 *   - per visitor: PER_VISITOR_PER_HOUR questions in any 60 minutes
 *   - everyone together: GLOBAL_PER_DAY questions in any 24 hours, a backstop
 *     in case one person arrives from many addresses
 *
 * How it works: each answered question adds one row to a small table in the
 * same Postgres database that holds the passages. Before answering, we count
 * the recent rows. No extra service or account is needed.
 *
 * A serverless function cannot keep a counter in memory, because each
 * request may land on a different copy of the server. The database is the
 * one place they all share.
 */
import { createHash } from "node:crypto";
import { GLOBAL_PER_DAY, PER_VISITOR_PER_HOUR } from "./config";
import { getPool } from "./db";

export type RateLimitResult = { allowed: true } | { allowed: false; message: string };

const VISITOR_MESSAGE = "You've reached the question limit for now. Please try again in an hour.";
const GLOBAL_MESSAGE = "Safety Line has answered its limit of questions for today. Please try again tomorrow.";

// Created on first use, once per server copy, so there is no setup step.
let tableReady: Promise<unknown> | null = null;
function ensureTable() {
  tableReady ??= getPool().query(`
    create table if not exists question_log (
      id         bigserial primary key,
      visitor    text not null,                      -- a hash of the IP address, not the address itself
      created_at timestamptz not null default now()
    );
    create index if not exists question_log_visitor on question_log (visitor, created_at);
    create index if not exists question_log_created on question_log (created_at);
  `);
  return tableReady;
}

/**
 * Who is asking? On Vercel the visitor's address arrives in the
 * x-forwarded-for header, which Vercel sets itself, so a visitor cannot fake
 * it. We store a hash, so the table never holds a raw IP address.
 */
function visitorId(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0].trim();
  const ip = forwarded || request.headers.get("x-real-ip") || "local";
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

/**
 * Count this question against the limits. Returns allowed: false, with the
 * message to show, when either limit has been reached.
 */
export async function checkRateLimit(request: Request): Promise<RateLimitResult> {
  // Local eval runs: skip the limit, and write nothing to question_log, so
  // they neither wait nor use up the shared daily count.
  if (rateLimitDisabled()) return { allowed: true };

  await ensureTable();
  const pool = getPool();
  const visitor = visitorId(request);

  // One statement does the check and the count together: the row is only
  // inserted if both totals are still under their limits.
  const inserted = await pool.query(
    `insert into question_log (visitor)
     select $1
      where (select count(*) from question_log
              where visitor = $1 and created_at > now() - interval '1 hour') < $2
        and (select count(*) from question_log
              where created_at > now() - interval '1 day') < $3
     returning id`,
    [visitor, PER_VISITOR_PER_HOUR, GLOBAL_PER_DAY],
  );

  // Housekeeping, roughly once every 50 questions: forget rows older than two days.
  if (Math.random() < 0.02) {
    pool.query("delete from question_log where created_at < now() - interval '2 days'").catch(() => {});
  }

  if (inserted.rowCount === 1) return { allowed: true };

  // Refused. Work out which limit it was, so the message is the right one.
  const mine = await pool.query(
    "select count(*)::int as n from question_log where visitor = $1 and created_at > now() - interval '1 hour'",
    [visitor],
  );
  const overVisitorLimit = mine.rows[0].n >= PER_VISITOR_PER_HOUR;
  return { allowed: false, message: overVisitorLimit ? VISITOR_MESSAGE : GLOBAL_MESSAGE };
}

/**
 * Is the limit switched off? Only when DISABLE_RATE_LIMIT=1 is set AND this is
 * not production. "next dev" runs with NODE_ENV=development; "next build" and
 * "next start" use production, and any Vercel deployment (preview or production) sets VERCEL_ENV, so the
 * flag only works on your own machine. Setting the flag there by mistake changes nothing.
 */
function rateLimitDisabled(): boolean {
  return (
    process.env.DISABLE_RATE_LIMIT === "1" &&
    !process.env.VERCEL_ENV &&
    process.env.NODE_ENV !== "production"
  );
}
