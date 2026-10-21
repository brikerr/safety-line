# Safety Line

A small web app that answers questions about safety guidance for physical and ambient AI: systems that sense, decide and act around people, such as vehicles, medical devices and industrial robots.

It answers from eight public documents and nothing else. Every claim carries a citation that links to the page it came from, and when the documents do not cover a question, the app says so.

The question it was built around: **what counts as a safety-related control, and when must a human confirm before a system acts?**

> Answers come only from the listed public documents. Not legal, medical, or engineering advice.

## Status of this version

Read this first. It says what has been checked and what has not.

| Check | Result |
| --- | --- |
| All 8 documents downloaded from their official URLs | Done (2026-10-10) |
| Ingestion parses and chunks all 8 documents | Done: 826 passages, counts below |
| Parse quality reviewed against the source PDFs | Done, by a separate reviewer pass. Known defects are listed under "Known limits" |
| Full pipeline (ingest, store, retrieve, stream, render) | Tested end to end against a local Postgres with pgvector, using stand-in model servers |
| Typecheck, lint, production build | Pass |
| Neon database, real ingestion (826 passages embedded and stored) | Done (2026-10-11) |
| Answers from the real models (Anthropic chat, OpenAI embeddings) | Checked on 2026-10-11 with `npm run check`. The robot and NIST answers were verified claim by claim against the cited passages, and every claim is there. The pizza question is declined as intended |
| The driver confirmation example question | Declined, correctly: the documents barely cover a person confirming before a system acts. It points to the nearest NHTSA material instead. See "Known limits" |
| Rate limit, About line, fixed answer for questions about the app | Checked on 2026-10-11 against the real database: requests 1 to 10 answered, request 11 refused with the limit message |
| Vercel preview deployment | **Not deployed** |

## The documents

The list lives in [`data/pdfs/sources.json`](data/pdfs/sources.json), which is the single source of truth for titles, URLs and licenses. The page footer reads from the same file.

| # | Document | Publisher, year | License | Pages | Passages |
| --- | --- | --- | --- | --- | --- |
| 1 | [AI Risk Management Framework 1.0 (NIST AI 100-1)](https://doi.org/10.6028/NIST.AI.100-1) | NIST, 2023 | Public domain (U.S. Government work) | 48 | 43 |
| 2 | [Generative AI Profile (NIST AI 600-1)](https://doi.org/10.6028/NIST.AI.600-1) | NIST, 2024 | Public domain (U.S. Government work) | 64 | 56 |
| 3 | [International AI Safety Report 2026](https://internationalaisafetyreport.org/publication/international-ai-safety-report-2026) | UK DSIT, 2026 | Open Government Licence v3.0 | 220 | 225 |
| 4 | [Visual-Manual NHTSA Driver Distraction Guidelines (78 FR 24818)](https://www.govinfo.gov/app/details/FR-2013-04-26/2013-09883) | NHTSA, Federal Register, 2013 | Public domain (U.S. Government work) | 73 | 221 |
| 5 | [Human Factors Design Guidance for Level 2 and Level 3 Automated Driving Concepts (DOT HS 812 555)](https://www.nhtsa.gov/sites/nhtsa.gov/files/documents/13494_812555_l2l3automationhfguidance.pdf) | NHTSA, prepared by Battelle, 2018 | **Unclear, see below** | 127 | 116 |
| 6 | [AI-Enabled Device Software Functions: Lifecycle Management and Marketing Submission Recommendations](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/artificial-intelligence-enabled-device-software-functions-lifecycle-management-and-marketing) | FDA, draft, January 2025 | Public domain (U.S. Government work) | 67 | 75 |
| 7 | [Applying Human Factors and Usability Engineering to Medical Devices](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/applying-human-factors-and-usability-engineering-medical-devices) | FDA, revised August 2026 | Public domain (U.S. Government work) | 45 | 48 |
| 8 | [OSHA Technical Manual, Section IV, Chapter 4: Industrial Robot Systems and Industrial Robot System Safety](https://www.osha.gov/otm/section-4-safety-hazards/chapter-4) | OSHA, about 2021 | Public domain (U.S. Government work) | web page | 42 |

Contains public sector information licensed under the Open Government Licence v3.0.

### License flags

These are the places where a license or a date is not as clean as the table suggests. Nothing here was guessed silently.

- **Document 5 (NHTSA Level 2 and Level 3 guidance): license unclear.** U.S. Government works are public domain only when written by federal employees. This report was written by Battelle under an NHTSA contract, and a contractor can hold copyright in a report the government paid for. It has no copyright notice and NHTSA distributes it freely, so quoting short passages with attribution is low risk, but it is not confirmed public domain. Check before you describe the whole corpus as openly licensed.
- **Document 3 (International AI Safety Report):** licensed under OGL v3.0 "except where otherwise stated". Third-party figures inside it may need separate permission. This app stores text only. OGL requires attribution, which the line above and the page footer provide.
- **Documents 1 and 2 (NIST):** neither prints a license. Public domain status rests on 17 U.S.C. 105 and NIST's general site policy, which asks for credit.
- **Document 6 (FDA AI devices) is a draft**, marked "Not for Implementation". The system prompt tells the model to say so when it cites it.
- **Document 7 (FDA human factors)** was reissued on August 3, 2026 (originally February 3, 2016). The copy here is that current revision.
- **Document 8 (OSHA):** the web page shows no date. The 2021 date comes from the OSHA notice that announced the chapter update (directive TED 01-00-015, information date 09/01/2021). Treat it as approximate.
- **Document 3 download URL:** the report site links to a file ending in `_1.pdf`, which replaced an earlier upload. That newer file is the one used.

## How RAG works here, in five steps

RAG means retrieval-augmented generation: find the relevant passages first, then have a model answer only from them.

1. **Read.** `scripts/ingest.ts` pulls the text out of each document, page by page, and throws away what is not body text: running headers and footers, page numbers, the line numbers printed on FDA draft pages, footnotes, and reference lists.
2. **Chunk.** The text is cut into passages of roughly 300 to 500 words. Each passage starts with the last sentence or so of the one before it, so an idea that falls across a cut can still be found. Each passage remembers its document, page numbers and nearest section heading.
3. **Embed.** Every passage is sent to an embedding model, which returns a list of 1,536 numbers (a vector). Passages about similar things get vectors that point in similar directions. The passages and their vectors are stored in Postgres using the pgvector extension.
4. **Retrieve.** When you ask a question, the question is embedded with the same model, and Postgres returns the 6 passages whose vectors are closest to it. See `lib/retrieve.ts`.
5. **Generate.** Those 6 passages, and only those, are sent to the chat model with strict rules: answer only from the passages, cite each claim with the passage's tag, and say "The documents I have don't answer that" when they do not. See `lib/prompt.ts`. The answer streams back to the page, where each citation tag becomes a link.

Steps 1 to 3 happen once, on your machine. Steps 4 and 5 happen on every question.

## Run it locally

You need Node.js 22.9 or newer, a Postgres database with pgvector, an Anthropic API key and an OpenAI API key.

```bash
# 1. Install
npm install

# 2. Keys
cp .env.example .env.local
#    then edit .env.local and fill in DATABASE_URL, ANTHROPIC_API_KEY, OPENAI_API_KEY

# 3. Get the documents (skips files that are already in data/pdfs/)
npm run fetch

# 4. See what ingestion will produce, without spending anything
npm run ingest -- --dry-run
#    writes one text file per document to data/debug/ so you can read the passages

# 5. Ingest for real: embed the passages and write them to the database
npm run ingest

# 6. Start the app
npm run dev
#    open http://localhost:3000
```

**Database.** The simplest route is Neon through the Vercel Marketplace (Vercel dashboard, Storage, Create Database, Neon). Copy the pooled connection string into `DATABASE_URL`. You do not need to create tables or enable pgvector by hand; `npm run ingest` runs `db/schema.sql`, which does both.

**Ingestion is safe to rerun.** Each run drops and rebuilds the `passages` table inside one transaction. If a run fails halfway, the previous data is still there.

**Cost.** Embedding all 826 passages is about half a million tokens, which costs a few cents at most with `text-embedding-3-small`. Each question costs one tiny embedding call plus one chat call with roughly 4,000 input tokens.

**The documents are not in the repository.** They are about 16 MB of PDFs, so git ignores them and `npm run fetch` downloads them from their official URLs. `npm run fetch -- --check` tests all eight links without saving anything.

**One download needs a browser.** Checked on 2026-10-11: seven of the eight links download cleanly. The NHTSA Level 2 and Level 3 guidance (`nhtsa-l2l3.pdf`) returns HTTP 403 to scripts, because nhtsa.gov only serves it to browsers. The script says so and prints the URL: open it in a browser, save the file, and put it in `data/pdfs/` as `nhtsa-l2l3.pdf`. The same applies if any other site starts refusing the script.

### Check that it works

With `npm run dev` running in one terminal, run this in another:

```bash
npm run check
```

It asks four questions and prints the answers, then sends 11 quick questions as one pretend visitor to try the rate limit. It makes about 13 real model calls, a few cents in total. Add `-- --no-limit-test` to skip the second part, or `-- https://your-preview-url` to check a deployed copy.

What to expect:

1. "Is a robot speed reduction near workers a safety-related control?" A cited answer from the OSHA chapter.
2. "When should a driver-facing system require confirmation before acting?" Starts with "The documents I have don't answer that", then points to the nearest material in the NHTSA guidance.
3. "What does NIST say about human oversight?" A cited answer from the NIST documents, finished, with no "cut short" note.
4. "What does this website do?" The fixed explanation of the app, with no passages.
5. Rate limit: requests 1 to 10 answered, request 11 refused with "You've reached the question limit for now. Please try again in an hour."

In the browser, also try "What is the best pizza in Seattle?" It should start with "The documents I have don't answer that."

### Run the eval without the rate limit

The local dev server counts questions in the same `question_log` table as production, so a full run of the 50-question gold set would hit the limit after 10 questions. For local runs only, start the dev server with the limit switched off:

```bash
# terminal 1
DISABLE_RATE_LIMIT=1 npm run dev

# terminal 2
uv run eval/score.py --per-hour 0            # all 50 questions
uv run eval/score.py --per-hour 0 --ids q01  # one question
```

With `DISABLE_RATE_LIMIT=1`, `/api/ask` skips both limits and writes nothing to `question_log`, so local runs do not use up the shared daily count. The flag only works when the app is not running in production: it is ignored when `NODE_ENV` is `production` (`next build`, `next start`) or `VERCEL_ENV` is `production` (the live site). `--per-hour 0` turns off the scorer's own pacing; leave it at the default of 10 when the limit is on. Each question still costs one embedding call and one chat call.

## Environment variables

| Name | Required | What it is |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Postgres connection string. On Neon, use the pooled one |
| `ANTHROPIC_API_KEY` | Yes | Writes the answers |
| `OPENAI_API_KEY` | Yes | Makes the embeddings, at ingestion and for each question |
| `CHAT_MODEL` | No | Default `claude-sonnet-5-5`. Any Anthropic model id |
| `EMBEDDING_MODEL` | No | Default `text-embedding-3-small`. Any OpenAI embedding model id |
| `EMBEDDING_DIMENSIONS` | No | Default `1536`. Must match the embedding model |
| `DISABLE_RATE_LIMIT` | No | Set to `1` to skip the rate limit in local development. Ignored in production. See "Run the eval without the rate limit" |

Keys live in `.env.local`, which git ignores. `.env.example` holds placeholders only. No key appears anywhere in the code.

## Rate limits

Each answered question costs money and the page is public, so `/api/ask` has two limits. Both numbers are in `lib/config.ts`.

| Limit | Value | Message when reached |
| --- | --- | --- |
| Per visitor | 10 questions in any hour | "You've reached the question limit for now. Please try again in an hour." |
| Everyone together | 200 questions in any 24 hours | "Safety Line has answered its limit of questions for today. Please try again tomorrow." |

How it works (`lib/rate-limit.ts`): each answered question adds a row to a small `question_log` table in the same Postgres database as the passages, and the recent rows are counted before the next question is answered. The table is created automatically the first time it is needed. No new service or account is involved.

- A visitor is identified by IP address, taken from the `x-forwarded-for` header that Vercel sets. Only a hash of the address is stored, and rows are deleted after two days.
- Questions about the app itself ("What does this website do?") get a fixed explanation from `lib/about.ts`. They cost nothing and do not count.
- Limits by IP are approximate: people behind one office or mobile network share an address, and a determined person can change theirs. The daily cap is the backstop for that.
- To clear the counts by hand, run `delete from question_log;` in the Neon SQL editor.

**Why two providers.** Anthropic does not offer an embedding model, so embeddings need a second provider. `text-embedding-3-small` was chosen because it is the most widely documented embedding model, it is cheap, and its 1,536 dimensions suit pgvector. Both choices sit in one file, `lib/models.ts`.

**Changing the embedding model** means running `npm run ingest` again. Vectors from two different models cannot be compared.

## Deploy a preview on Vercel

Not done yet. The project needs exactly three environment variables on Vercel, the same three as `.env.local`:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | The same Neon pooled connection string you use locally |
| `ANTHROPIC_API_KEY` | Your Anthropic key |
| `OPENAI_API_KEY` | Your OpenAI key. Needed on the server too, because every question is embedded before the search |

`CHAT_MODEL`, `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS` are optional and only needed to override the defaults.

**Use the same database.** The 826 passages you loaded from your machine live in Neon, not on your laptop, so the deployment reads them through the same `DATABASE_URL`. There is nothing to ingest again. If you ever point Vercel at a different database, run `npm run ingest` once against that one.

```bash
npm i -g vercel
vercel link                 # connect this folder to a Vercel project
vercel env add DATABASE_URL preview
vercel env add ANTHROPIC_API_KEY preview
vercel env add OPENAI_API_KEY preview
vercel                      # builds and returns a preview URL
```

If you created the Neon database through the Vercel Marketplace and connected it to this project, `DATABASE_URL` is already set there; check the project's Environment Variables page before adding it twice. Plain `vercel` makes a preview deployment. Production is `vercel --prod`, which this project should not run until you decide to.

Local testing and the preview share one database, so they also share the rate-limit counts.

## Where things are

```
app/
  page.tsx            the single page (static parts, document list)
  ask.tsx             question box, streamed answer, passages used
  api/ask/route.ts    the question API
  globals.css         all styles; design tokens at the top
lib/
  config.ts           model names, top-k, limits
  about.ts            the About line and the fixed answer about the app
  rate-limit.ts       10 per visitor per hour, 200 per day overall
  models.ts           which AI providers are used (the one file to change)
  db.ts               Postgres connection
  retrieve.ts         step 4: similarity search
  prompt.ts           step 5: the rules given to the model
  sources.ts          typed view of sources.json
scripts/
  fetch-sources.ts    downloads the documents
  ingest.ts           steps 1 to 3
  check.mjs           asks the test questions and tries the rate limit
  lib/pdf.ts          PDF text clean-up and reading order
  lib/html.ts         the OSHA web page
  lib/chunk.ts        cutting text into passages
db/schema.sql         the passages table (question_log creates itself)
data/pdfs/            the documents and sources.json
data/debug/           dry-run output, one text file per document
```

## How the PDFs are cleaned

A PDF stores positioned fragments of text, not paragraphs, so `scripts/lib/pdf.ts` uses position and font size to decide what is body text. Each rule is a short function with a comment explaining it.

- **Headers, footers, page numbers:** a line in the top or bottom band of the page that repeats on at least two pages (with digits ignored, so "Page 7" matches "Page 8"), or that is only a page number.
- **FDA line numbers:** digit-only fragments that sit to the left of all other text on the page.
- **Footnotes:** a block at the foot of a page that starts with a small raised number and is set smaller than the page's main text. Clearly small text elsewhere (reference lists) is dropped too. Small capitals inside a sentence are kept.
- **Reading order:** each document is marked `stream` or `columns` in `sources.json`. `stream` trusts the order stored in the file, which works for documents exported from Word and keeps their tables intact. `columns` is for the Federal Register notice (three columns) and the International AI Safety Report (two columns): the page is cut into blocks, column gutters are found in each block, and each column is read top to bottom.
- **Skipped pages:** covers, contents pages and reference lists are skipped by page range, listed with a reason in `sources.json`.
- **One glyph fix:** the International AI Safety Report uses a font whose full stop has no text mapping, so it comes out as an unknown character. `sources.json` tells the script to read it as a full stop. This was confirmed against a second PDF reader on 141 of 144 affected pages.

## Baseline results (Oct 20, 2026)

Run on Oct 20, 2026 against the local dev server (rate limit off), all 50 questions in `eval/gold_draft.jsonl`, exact page matching, judge model `claude-sonnet-5-5`. Full output: `eval/results/20261020-180851-local/`.

| Slice | n | errors | Refusal acc. | Cit. precision | Cit. recall | Doc recall | Retrieval hit | Keyword cov. | Keyword pass | Judge score |
|---|---|---|---|---|---|---|---|---|---|---|
| Overall | 50 | 0 | 90% | 30% | 61% | 95% | 66% | 69% | 82% | 77% |
| single | 36 | 0 | 89% | 32% | 65% | 97% | 71% | 72% | 83% | 76% |
| multi | 4 | 0 | 75% | 11% | 25% | 75% | 25% | 41% | 25% | 38% |
| refuse | 10 | 0 | 100% | n/a | n/a | n/a | n/a | n/a | 100% | 94% |

**How to read it:** refusal accuracy covers every question (answered when it should, declined when it should). Citation precision and recall check whether the cited pages match the gold pages; doc recall checks only the document. Retrieval hit is whether any retrieved passage covered the gold page, cited or not. Keyword and judge scores grade the answer text. Refuse questions have no gold pages, so they show n/a there.

**Takeaway:** the answers are mostly sound and the app refuses out-of-scope questions reliably. The weak spot is page-level retrieval and citation precision: the app usually finds the right document but often not the right page, and it cites extra pages. Five answerable questions were refused because retrieval missed the gold pages. Multi-document questions are weakest. The next step is better search (for example hybrid keyword plus vector search, or reranking).

Note: after this run, q37 was reworded to ask only about the OSHA robot chapter (its NHTSA half was dropped during gold review), so q37's row in this run used the older question.

## Known limits

**Citations**

- **"p. 12" means the 12th page of the PDF file**, which is the page the link opens. It can differ from the number printed on the page. The Federal Register notice is the clearest case: its printed pages run 24818 to 24890, and the app calls them 1 to 73.
- The OSHA chapter is a web page with no page numbers, so it is cited by section ("sec. VIII") and links to that section. Sections are long, so several passages share one tag.
- A passage that spans two pages is cited as a range ("pp. 12-13"). The claim could be on either page.
- Whether a PDF link jumps to the right page depends on the browser's PDF viewer. Chrome, Edge and Firefox honour `#page=N`. Safari is less reliable.
- Nothing checks that a cited passage really supports the claim next to it. A citation tag that matches no retrieved passage is shown in grey with no yellow mark and no link, which catches invented citations but not misattributed ones.

**Parsing, from the review against the source PDFs**

Page numbers were checked for all 784 PDF passages, by matching each passage's words against the text of the pages it cites, and no wrong citation was found. The defects below are about text quality.

- **Footnotes are dropped**, in every document. A few leak into body text instead: 3 of 15 in the NIST Generative AI Profile and on about 3 pages of the FDA draft.
- **Columns read across on 3 pages:** International AI Safety Report PDF pages 17 and 27, and Federal Register page 65 (a short band of text between two tables). Passages from those pages are jumbled.
- **Tables are flattened to text.** Simple tables read row by row. Wide ones lose their structure: Table 3 of the Federal Register notice keeps its rows but its Yes and No marks are detached, and several tables in the International AI Safety Report (for example Table 3.10) read as a run of cell text.
- **Figure captions and labels** sometimes land in the middle of a paragraph, most often in the International AI Safety Report and the NIST framework.
- **Equations are garbled** in the NHTSA Level 2 and Level 3 guidance.
- **The Federal Register notice** has the most rough edges: its own contents listing survives as about six low-value passages (PDF pages 1 and 2), sub-bullets appear as "Æ", and its section labels are the first line of a heading only.
- **Section labels are a best guess.** They are found from font size and numbering. Some passages carry the wrong one, for example four passages of the NIST Generative AI Profile are labelled "1. Introduction" but belong to section 2. Labels are shown for orientation and are not part of the citation.
- **Reference lists and indexes are skipped**, so the app cannot answer "which paper says X".

**Retrieval and answers**

- **The documents say little about a person confirming before a system acts**, which is half of the headline question. The driving documents cover the reverse: the system confirming things to the driver. The second example question is therefore declined, with a pointer to the nearest material. Adding a document on human oversight or confirmation would fix this.
- Search is by meaning only. An exact term such as a clause number or an acronym can be missed. Keyword search is not built yet.
- Always exactly 6 passages, even when none is relevant. The model is trusted to notice and decline. There is no similarity cut-off.
- No reranking, no filter by domain, no evaluation set, no chat history. Each question stands alone.
- The model can still make mistakes within the rules, such as overstating what a passage says. Read the passages.

**Operations**

- The rate limit is by IP address, so it is approximate. See "Rate limits".
- A question about the app is recognised by a short list of phrasings in `lib/about.ts`. An unusual phrasing falls through to the normal search, where the model is told to answer it briefly anyway.
- The documents are a snapshot from 2026-10-10. Nothing checks for new revisions.

## Decisions and guesses to review

Things the brief left open, and what was chosen.

1. **Embedding model:** OpenAI `text-embedding-3-small`. This means a second API key.
2. **Chat model default:** `claude-sonnet-5-5`. A smaller, cheaper model would likely do; change `CHAT_MODEL` to try one.
3. **Footnotes are removed.** The brief asked for headers, footers and line numbers to go. Dropping footnotes was an extra decision, because they interrupt sentences that continue on the next page.
4. **Covers, contents pages, reference lists and indexes are skipped**, for the same reason: they match many questions and answer none.
5. **Citations use PDF page positions**, not printed page numbers, so that the link and the citation agree.
6. **The document label is embedded with each passage** ("NIST AI RMF: 3.2 Safe" in front of the text) to give the vector some context. Only the plain passage is stored and shown.
7. **No vector index.** With 826 rows an exact scan takes milliseconds and never misses a match.
8. **The response format is JSON lines**, not the AI SDK chat protocol, because there is no chat history and it keeps the browser code short and readable.
9. **Source files are not committed to git.** `npm run fetch` gets them. They are in this folder already.
10. **The OSHA date** (2021) is inferred, as noted above.

## Not in this version

Each has a `TODO` comment where it will go.

| Feature | Where |
| --- | --- |
| Keyword and hybrid search | `lib/retrieve.ts`, `db/schema.sql` |
| Reranking | `lib/retrieve.ts` |
| Filter by domain | `lib/retrieve.ts` |
| Scoring and evals | `app/api/ask/route.ts` |
| Chat history | `app/api/ask/route.ts` |
| Vector index for a larger corpus | `db/schema.sql` |
| Keeping footnotes as their own passages | `scripts/lib/pdf.ts` |

## Design

The look is "spec sheet", borrowed from engineering standards and data sheets: one sans family with its matching mono (IBM Plex Sans and IBM Plex Mono, SIL Open Font License 1.1, self-hosted in `public/fonts/`), hard black rules, small uppercase labels, and light and dark modes that follow the system setting.

There is one signal colour, safety yellow, and it appears in exactly two places: the line under the header, and the mark behind a citation that matches a retrieved passage. A citation that matches nothing gets no mark and stays grey, so an invented source stands out by what it lacks.

Every colour, size and typeface is a token at the top of `app/globals.css`. There are no third-party requests from the page.
