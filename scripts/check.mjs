/**
 * check.mjs: ask the test questions and try the rate limit, from the terminal.
 *
 *   npm run check                        against http://localhost:3000 (start "npm run dev" first)
 *   npm run check -- https://some.url    against a deployed copy
 *   npm run check -- --no-limit-test     only the four questions
 *
 * Part 1 asks four questions and prints each answer with the passages found.
 * Part 2 sends 11 quick questions as one pretend visitor. The first 10
 * should be accepted and the 11th refused with the "question limit" message.
 *
 * Cost: this makes about 13 real model calls, a few cents in total.
 * On your own machine the pretend visitor has its own address, so the test
 * does not use up your own allowance. On Vercel that header is replaced
 * with your real address, so there the 11 requests do count against you.
 */

const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith("http")) ?? "http://localhost:3000").replace(/\/$/, "");
const skipLimitTest = args.includes("--no-limit-test");

const QUESTIONS = [
  "Is a robot speed reduction near workers a safety-related control?",
  "When should a driver-facing system require confirmation before acting?",
  "What does NIST say about human oversight?",
  "What does this website do?",
];

/** Send one question. Returns the HTTP status, the answer text and the passages. */
async function ask(question, headers = {}) {
  const response = await fetch(`${base}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ question }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { status: response.status, error: body.error ?? "(no message)" };
  }
  let answer = "";
  let passages = [];
  let notice = "";
  for (const line of (await response.text()).split("\n")) {
    if (line.trim() === "") continue;
    const event = JSON.parse(line);
    if (event.type === "passages") passages = event.passages;
    if (event.type === "text") answer += event.text;
    if (event.type === "notice") notice = event.message;
    if (event.type === "error") return { status: response.status, error: event.message };
  }
  return { status: response.status, answer, passages, notice };
}

console.log(`Checking ${base}\n`);

// Part 1: the four questions.
for (const question of QUESTIONS) {
  console.log("=".repeat(78));
  console.log(`Q: ${question}\n`);
  const result = await ask(question);
  if (result.error) {
    console.log(`  FAILED (HTTP ${result.status}): ${result.error}\n`);
    continue;
  }
  console.log(result.answer.trim());
  if (result.notice) console.log(`\n  NOTE: ${result.notice}`);
  const words = result.answer.trim().split(/\s+/).length;
  const found = result.passages.map((p) => `${p.citation} ${p.similarity.toFixed(2)}`).join("; ");
  console.log(`\n  [${words} words. Passages: ${found || "none, fixed answer"}]\n`);
}

// Part 2: the rate limit.
if (!skipLimitTest) {
  console.log("=".repeat(78));
  const visitor = `203.0.113.${1 + Math.floor(Math.random() * 250)}`; // a reserved test address
  console.log(`Rate limit test: 11 questions as pretend visitor ${visitor}\n`);
  // One at a time. The limit is checked before the answer is written, so
  // there is no need to wait for each answer in full, but it keeps this simple.
  for (let i = 1; i <= 11; i++) {
    const result = await ask("What is a safeguarded space?", { "x-forwarded-for": visitor });
    const outcome = result.error ? `refused: "${result.error}"` : "answered";
    console.log(`  request ${String(i).padStart(2)}: HTTP ${result.status}  ${outcome}`);
  }
  console.log('\nExpected: requests 1 to 10 answered, request 11 refused with HTTP 429 and "You\'ve reached the question limit for now. Please try again in an hour."');
}
