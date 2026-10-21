#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""
score.py: score Safety Line answers against the gold set.

Calls POST {base}/api/ask for each gold question, reads the JSON-lines stream
(passages, text, notice, done/error), and scores each answer for:

  - refusal correctness  answered vs. declined ("The documents I have don't answer that.")
  - citation precision   share of distinct cited (doc, page/section) tags that hit a gold ref
  - citation recall      share of gold (doc, page/section) refs hit by at least one citation
  - doc recall           share of gold docs cited at all
  - retrieval hit        share of gold refs present among the retrieved passages (diagnostic)
  - answer correctness   keyword coverage of the gold answer (always), and an
                         optional LLM judge (--judge) using ANTHROPIC_API_KEY

Writes results.jsonl (one record per question) and summary.md (tables ready to
paste into the README) into --out-dir.

Only the Python standard library is used, so `uv run eval/score.py ...` works
with no install step (the dependency block above is PEP 723 inline metadata).

Local runs (the documented path for the full 50): start the dev server with
the rate limit off, then turn off this script's pacing with --per-hour 0.
  terminal 1:  DISABLE_RATE_LIMIT=1 npm run dev     # http://localhost:3000
  terminal 2:  uv run eval/score.py --per-hour 0
DISABLE_RATE_LIMIT is ignored in production (see lib/rate-limit.ts). Without
it, the dev server enforces the same limits as production against the same
Neon table: 10 per visitor per hour and 200 per day shared with production.
The default --per-hour 10 respects that (about 5 hours for 50 questions);
a per-visitor 429 is retried after --rate-wait, a daily-limit 429 stops the run.

Gold fields read: id, question, type (answerable|multi_doc|refuse), gold_docs,
gold_pages, gold_answer, key_quote, and optionally key_points,
reference_answer and any_of. With "any_of": true, the gold pages are
alternatives: citation recall (and retrieval hit) is 1 when any one is hit.

Quick examples (run from the repo root):
  uv run eval/score.py --per-hour 0 --ids q01,q41       # local, limit off
  uv run eval/score.py --per-hour 0 --limit 5 --tolerance 1   # first 5, +/-1 page
  uv run eval/score.py --prod --ids q01 --max-calls 1    # production, one call
  uv run eval/score.py --rescore eval/results/<run>/results.jsonl --tolerance 1
  uv run eval/score.py --check-gold                      # validate gold file, no calls
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent
REPO_DIR = EVAL_DIR.parent
DEFAULT_GOLD = EVAL_DIR / "gold_draft.jsonl"
SOURCES_JSON = REPO_DIR / "data" / "pdfs" / "sources.json"
LOCAL_URL = "http://localhost:3000"
PROD_URL = "https://safety-line-smoky.vercel.app"
NO_ANSWER = "The documents I have don't answer that."
TYPE_MAP = {"answerable": "single", "single": "single", "multi_doc": "multi", "multi": "multi", "refuse": "refuse"}
TYPE_ORDER = ["single", "multi", "refuse"]
# OSHA section order, so a tolerance of 1 can accept a neighbouring section label.
SECTION_ORDER = [f"sec. {r}" for r in "I II III IV V VI VII VIII IX X XI".split()] + ["app. 1", "app. 2"]

# --------------------------------------------------------------------------
# Secrets: read the Anthropic key without ever printing it
# --------------------------------------------------------------------------
_SECRETS: list[str] = []


def redact(text: str) -> str:
    for s in _SECRETS:
        if s:
            text = text.replace(s, "[REDACTED]")
    return re.sub(r"sk-ant-[A-Za-z0-9_\-]{8,}", "[REDACTED]", text)


def read_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        m = re.match(r"^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$", line)
        if not m:
            continue
        val = m.group(2).strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        out[m.group(1)] = val
    return out


def app_env() -> dict[str, str]:
    """The app keeps keys in .env.local (Next.js convention); .env is a fallback."""
    env: dict[str, str] = {}
    for name in (".env", ".env.local"):  # later wins, like Next.js
        env.update(read_env_file(REPO_DIR / name))
    return env


def anthropic_key() -> str:
    key = os.environ.get("ANTHROPIC_API_KEY") or app_env().get("ANTHROPIC_API_KEY", "")
    if not key or "REPLACE_ME" in key:
        sys.exit("--judge needs ANTHROPIC_API_KEY (environment, .env.local or .env). Not found.")
    _SECRETS.append(key)
    return key


# --------------------------------------------------------------------------
# Gold set
# --------------------------------------------------------------------------
def load_sources() -> tuple[dict[str, str], dict[str, str]]:
    """Returns (doc id -> shortName, lowercase shortName -> doc id)."""
    data = json.loads(SOURCES_JSON.read_text())
    id_to_short = {s["id"]: s["shortName"] for s in data}
    short_to_id = {s["shortName"].lower(): s["id"] for s in data}
    for s in data:  # tolerate the model citing by id or by the doc's title
        short_to_id.setdefault(s["id"].lower(), s["id"])
    return id_to_short, short_to_id


def norm_loc(loc) -> str | int:
    """Gold page: an int (PDF page index) or a section label like 'sec. VIII'."""
    if isinstance(loc, int):
        return loc
    s = str(loc).strip()
    if s.isdigit():
        return int(s)
    m = re.match(r"^(sec|app)\.?\s*(\w+)$", s, re.I)
    return f"{m.group(1).lower()}. {m.group(2).upper() if m.group(1).lower() == 'sec' else m.group(2)}" if m else s


def gold_refs(item: dict, warnings: list[str]) -> list[tuple[str, str | int]]:
    docs, pages = item.get("gold_docs") or [], item.get("gold_pages") or []
    if not docs:
        return []
    if len(docs) == 1:  # single-doc: every page belongs to that doc
        return [(docs[0], norm_loc(p)) for p in pages]
    if len(docs) == len(pages):  # multi-doc: gold_pages[i] belongs to gold_docs[i]
        return [(d, norm_loc(p)) for d, p in zip(docs, pages)]
    warnings.append(f"{item['id']}: {len(docs)} gold_docs but {len(pages)} gold_pages; cannot pair them")
    return []


def load_gold(path: Path) -> tuple[list[dict], list[str]]:
    items, warnings = [], []
    id_to_short, _ = load_sources()
    for n, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        item = json.loads(line)
        for field in ("id", "question", "type"):
            if field not in item:
                warnings.append(f"line {n}: missing '{field}'")
        if item.get("type") not in TYPE_MAP:
            warnings.append(f"{item.get('id')}: unknown type {item.get('type')!r}")
        for d in item.get("gold_docs") or []:
            if d not in id_to_short:
                warnings.append(f"{item.get('id')}: gold doc {d!r} not in sources.json")
        item["_type"] = TYPE_MAP.get(item.get("type"), item.get("type"))
        item["_refs"] = gold_refs(item, warnings)
        if item["_type"] != "refuse" and not item["_refs"]:
            warnings.append(f"{item['id']}: answerable item with no gold refs")
        if item["_type"] != "refuse" and not (item.get("key_points") or item.get("gold_answer") or item.get("reference_answer")):
            warnings.append(f"{item['id']}: no key_points / gold_answer / reference_answer for correctness")
        items.append(item)
    return items, warnings


def select(items: list[dict], ids: str | None, types: str | None, limit: int | None) -> list[dict]:
    if ids:
        wanted: list[str] = []
        for part in ids.split(","):
            part = part.strip()
            m = re.match(r"^q?(\d+)-q?(\d+)$", part)
            if m:
                wanted += [f"q{i:02d}" for i in range(int(m.group(1)), int(m.group(2)) + 1)]
            elif part:
                wanted.append(part if part.startswith("q") else f"q{int(part):02d}")
        by_id = {i["id"]: i for i in items}
        missing = [w for w in wanted if w not in by_id]
        if missing:
            sys.exit(f"Unknown ids: {', '.join(missing)}")
        items = [by_id[w] for w in dict.fromkeys(wanted)]
    if types:
        allowed = {TYPE_MAP.get(t.strip(), t.strip()) for t in types.split(",")}
        items = [i for i in items if i["_type"] in allowed]
    return items[:limit] if limit else items


# --------------------------------------------------------------------------
# Calling the app
# --------------------------------------------------------------------------
class GlobalLimit(Exception):
    pass


class Pacer:
    """Keeps requests under `per_hour` in any rolling hour, plus a min gap."""

    def __init__(self, per_hour: int, min_interval: float):
        self.per_hour, self.min_interval = per_hour, min_interval
        self.sent: deque[float] = deque()

    def wait(self) -> None:
        now = time.time()
        if self.sent and now - self.sent[-1] < self.min_interval:
            time.sleep(self.min_interval - (now - self.sent[-1]))
        if self.per_hour > 0:
            while self.sent and time.time() - self.sent[0] > 3600:
                self.sent.popleft()
            if len(self.sent) >= self.per_hour:
                pause = 3600 - (time.time() - self.sent[0]) + 2
                log(f"  pacing: {self.per_hour}/hour reached, waiting {pause/60:.1f} min")
                time.sleep(max(pause, 0))
                self.sent.popleft()
        self.sent.append(time.time())


def log(msg: str) -> None:
    print(redact(msg), file=sys.stderr, flush=True)


def ask_once(base: str, question: str, timeout: float) -> dict:
    req = urllib.request.Request(
        f"{base}/api/ask",
        data=json.dumps({"question": question}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "safety-line-eval/1.0"},
        method="POST",
    )
    out = {"status": None, "answer": "", "passages": [], "notice": None, "error": None, "done": False}
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            out["status"] = resp.status
            for raw in resp:
                line = raw.decode("utf-8").strip()
                if not line:
                    continue
                ev = json.loads(line)
                t = ev.get("type")
                if t == "passages":
                    out["passages"] = ev.get("passages", [])
                elif t == "text":
                    out["answer"] += ev.get("text", "")
                elif t == "notice":
                    out["notice"] = ev.get("message")
                elif t == "done":
                    out["done"] = True
                elif t == "error":
                    out["error"] = ev.get("message", "stream error")
    except urllib.error.HTTPError as e:
        out["status"] = e.code
        try:
            out["error"] = json.loads(e.read().decode()).get("error") or f"HTTP {e.code}"
        except Exception:
            out["error"] = f"HTTP {e.code}"
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
        out["error"] = f"network: {e}"
    if out["status"] == 200 and not out["done"] and not out["error"]:
        out["error"] = "stream ended without a done event"
    return out


def ask(base: str, question: str, pacer: Pacer, args) -> dict:
    attempts = 0
    while True:
        pacer.wait()
        attempts += 1
        args._calls += 1
        t0 = time.time()
        r = ask_once(base, question, args.timeout)
        r["seconds"] = round(time.time() - t0, 1)
        r["attempts"] = attempts
        if not r["error"]:
            return r
        if r["status"] == 429:
            if "today" in (r["error"] or "").lower():
                raise GlobalLimit(r["error"])
            wait = args.rate_wait
        elif r["status"] in (400, 404):
            return r  # not retryable
        else:
            wait = args.backoff * (3 ** (attempts - 1))
        if attempts > args.max_retries or (args.max_calls and args._calls >= args.max_calls):
            return r
        log(f"  {r['status'] or 'no response'}: {r['error']}. Retry {attempts}/{args.max_retries} in {wait:.0f}s")
        time.sleep(wait)


# --------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------
TAG_RE = re.compile(r"\[([^\[\]\n]{3,90})\]")  # same pattern as app/ask.tsx
LOC_RE = re.compile(r"^(?:(?P<doc>.+?),\s*)?(?P<loc>(?:pp?|sec|app)\.\s*.+)$", re.I)


def parse_loc(loc: str):
    """'p. 12' -> (12, 12); 'pp. 19-20' -> (19, 20); 'sec. VIII' -> 'sec. VIII'."""
    loc = loc.strip().rstrip(".")
    m = re.match(r"^pp?\.\s*(\d+)\s*(?:[-\u2013\u2014]\s*(\d+))?$", loc, re.I)
    if m:
        a = int(m.group(1))
        return (a, int(m.group(2) or a))
    m = re.match(r"^(sec|app)\.\s*(\w+)$", loc, re.I)
    if m:
        return norm_loc(loc)
    return loc


def parse_citations(answer: str, short_to_id: dict[str, str]) -> list[dict]:
    cites, seen = [], set()
    for m in TAG_RE.finditer(answer):
        prev_doc = None
        for part in m.group(1).split(";"):
            part = part.strip()
            lm = LOC_RE.match(part)
            if not lm:
                continue  # not a citation, e.g. "[sic]"
            short = (lm.group("doc") or prev_doc or "").strip()
            prev_doc = short or prev_doc
            doc_id = short_to_id.get(short.lower())
            loc = parse_loc(lm.group("loc"))
            tag = f"[{short}, {lm.group('loc').strip()}]"
            key = (doc_id or short, str(loc))
            if key in seen:
                continue
            seen.add(key)
            cites.append({"tag": tag, "doc": doc_id, "doc_name": short, "loc": loc})
    return cites


def loc_matches(cited, gold, tol: int) -> bool:
    if isinstance(gold, int) and isinstance(cited, tuple):
        return cited[0] - tol <= gold <= cited[1] + tol
    if isinstance(gold, str) and isinstance(cited, str):
        if cited == gold:
            return True
        if tol and cited in SECTION_ORDER and gold in SECTION_ORDER:
            return abs(SECTION_ORDER.index(cited) - SECTION_ORDER.index(gold)) <= tol
    return False


def ref_hit(doc, loc, refs, tol) -> list[int]:
    return [i for i, (gd, gl) in enumerate(refs) if gd == doc and loc_matches(loc, gl, tol)]


STOP = set("""a an and are as at be been being but by can could did do does doing for from had has have how if in
into is it its itself may might more most must no not of on or other our over own so some such than that the their
them then there these they this those through to too under until up very was we were what when where which while who
why will with would you your also each any both only same says say said should shall per such via about above after
again against all am because before below between during few further here just nor once out off same than whom
document documents guidance report chapter section draft""".split())


def stem(w: str) -> str:
    for suf in ("ing", "ed", "es", "s"):
        if w.endswith(suf) and len(w) - len(suf) >= 4:
            return w[: -len(suf)]
    return w


def content_tokens(text: str) -> list[str]:
    text = TAG_RE.sub(" ", text or "").lower().replace("\u2019", "'")
    words = re.findall(r"[a-z0-9]+(?:[-'][a-z0-9]+)*", text)
    out = []
    for w in words:
        w = w.replace("'s", "")
        for piece in w.split("-"):
            if len(piece) >= 3 and piece not in STOP or piece.isdigit():
                out.append(stem(piece))
    return out


def coverage(reference: str, answer_tokens: set[str]) -> float | None:
    ref = set(content_tokens(reference))
    return round(len(ref & answer_tokens) / len(ref), 3) if ref else None


def is_refusal(answer: str) -> bool:
    a = answer.strip().replace("\u2019", "'").lower()
    return a.startswith(NO_ANSWER.lower().rstrip(".")) or a.startswith("the documents i have do not answer")


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def score_item(item: dict, resp: dict, args, short_to_id) -> dict:
    t = item["_type"]
    refs = item["_refs"]
    answer = resp.get("answer") or ""
    rec = {
        "id": item["id"], "type": t, "gold_type": item.get("type"), "question": item["question"],
        "status": resp.get("status"), "error": resp.get("error"), "notice": resp.get("notice"),
        "seconds": resp.get("seconds"), "attempts": resp.get("attempts"),
        "answer": answer,
        "passages": [{"citation": p.get("citation"), "docShortName": p.get("docShortName"),
                      "locator": p.get("locator"), "similarity": round(p.get("similarity", 0), 3)}
                     for p in resp.get("passages") or []],
        "gold_refs": [[d, l] for d, l in refs],
        "tolerance": args.tolerance,
    }
    if resp.get("error") and not answer:
        rec["scored"] = False
        return rec
    rec["scored"] = True
    refused = is_refusal(answer)
    rec["refused"] = refused
    rec["should_refuse"] = t == "refuse"
    rec["refusal_correct"] = refused == (t == "refuse")

    cites = parse_citations(answer, short_to_id)
    passage_tags = {p["citation"] for p in rec["passages"]}
    rec["citations"] = [{"tag": c["tag"], "doc": c["doc"], "loc": list(c["loc"]) if isinstance(c["loc"], tuple) else c["loc"]}
                        for c in cites]
    rec["citations_not_in_passages"] = [c["tag"] for c in cites if c["tag"] not in passage_tags]

    if t != "refuse" and refs:
        hits = [ref_hit(c["doc"], c["loc"], refs, args.tolerance) for c in cites]
        rec["citation_precision"] = round(sum(1 for h in hits if h) / len(cites), 3) if cites else None
        covered = {i for h in hits for i in h}
        any_of = item.get("any_of") is True
        rec["any_of"] = any_of
        rec["citation_recall"] = (1.0 if covered else 0.0) if any_of else round(len(covered) / len(refs), 3)
        gold_docs = set(item.get("gold_docs") or [])
        rec["doc_recall"] = round(len(gold_docs & {c["doc"] for c in cites}) / len(gold_docs), 3)
        id_by_short = short_to_id
        ret_hit = set()
        for p in resp.get("passages") or []:
            d = id_by_short.get((p.get("docShortName") or "").lower())
            ret_hit |= set(ref_hit(d, parse_loc(p.get("locator") or ""), refs, args.tolerance))
        rec["retrieval_recall"] = (1.0 if ret_hit else 0.0) if any_of else round(len(ret_hit) / len(refs), 3)
    else:
        rec["citation_precision"] = rec["citation_recall"] = rec["doc_recall"] = rec["retrieval_recall"] = None
        rec["n_citations"] = len(cites)

    ans_tokens = set(content_tokens(answer))
    if t == "refuse":
        # gold_answer for refuse items is a rubric, not a reference answer.
        rec["keyword_coverage"] = None
        rec["key_quote_coverage"] = None
        rec["keyword_correct"] = refused
    else:
        if item.get("key_points"):
            per = [coverage(kp, ans_tokens) or 0 for kp in item["key_points"]]
            rec["key_points_hit"] = [round(p, 3) for p in per]
            rec["keyword_coverage"] = round(sum(1 for p in per if p >= args.kw_threshold) / len(per), 3)
        else:
            ref = item.get("reference_answer") or item.get("gold_answer") or ""
            rec["keyword_coverage"] = coverage(ref, ans_tokens)
        rec["key_quote_coverage"] = coverage(item.get("key_quote") or "", ans_tokens)
        rec["keyword_correct"] = (not refused) and (rec["keyword_coverage"] or 0) >= args.kw_threshold
    return rec


# --------------------------------------------------------------------------
# Optional judge
# --------------------------------------------------------------------------
JUDGE_PROMPT = """You are grading one answer from Safety Line, a tool that must answer only from eight public safety documents, cite them, and decline when they do not cover the question (declines start with "The documents I have don't answer that.").

Question: {question}
Item type: {type}
Reference ({ref_kind}):
{reference}
{key_quote}
Answer to grade:
<answer>
{answer}
</answer>

Grading rules:
- For type "refuse": score 1 if the answer declines and does not answer from outside knowledge (no invented clause text, numbers, rules or policies); for a false premise it should also not accept the premise. Score 0.5 if it declines but adds unsupported or misleading detail. Score 0 if it answers the question.
- Otherwise: score 1 if the answer states the essential facts of the reference without contradicting it; 0.5 if it gets part of them or is vague; 0 if it is wrong, missing the core point, or declines.
- Do not judge citations or style here; only substance.

Reply with only a JSON object: {{"score": 0 | 0.5 | 1, "reason": "<one sentence>"}}"""


def judge(item: dict, rec: dict, args) -> dict:
    ref_kind = "key points" if item.get("key_points") else ("rubric" if item["_type"] == "refuse" else "reference answer")
    reference = "\n".join(f"- {k}" for k in item["key_points"]) if item.get("key_points") else (
        item.get("reference_answer") or item.get("gold_answer") or "(none)")
    kq = f"Key quote from the source: \"{item['key_quote']}\"\n" if item.get("key_quote") else ""
    prompt = JUDGE_PROMPT.format(question=item["question"], type=item["_type"], ref_kind=ref_kind,
                                 reference=reference, key_quote=kq, answer=rec["answer"])
    body = json.dumps({"model": args.judge_model, "max_tokens": 300,
                       "messages": [{"role": "user", "content": prompt}]}).encode()
    for attempt in range(1, 4):
        req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, method="POST", headers={
            "x-api-key": args._key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                data = json.loads(resp.read())
            text = "".join(b.get("text", "") for b in data.get("content", []))
            m = re.search(r"\{.*\}", text, re.S)
            j = json.loads(m.group(0)) if m else {}
            s = float(j.get("score"))
            return {"judge_score": s, "judge_reason": j.get("reason", ""), "judge_model": args.judge_model}
        except urllib.error.HTTPError as e:
            msg = redact(e.read().decode(errors="replace")[:300])
            if e.code in (429, 500, 502, 503, 529) and attempt < 3:
                time.sleep(10 * attempt)
                continue
            return {"judge_score": None, "judge_reason": f"judge HTTP {e.code}: {msg}", "judge_model": args.judge_model}
        except Exception as e:  # parse or network problem
            if attempt < 3:
                time.sleep(5)
                continue
            return {"judge_score": None, "judge_reason": redact(f"judge failed: {e}"), "judge_model": args.judge_model}
    return {"judge_score": None, "judge_reason": "judge failed", "judge_model": args.judge_model}


# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
def pct(x):
    return "n/a" if x is None else f"{100 * x:.0f}%"


def summarize(records: list[dict], args, base: str) -> str:
    use_judge = any("judge_score" in r for r in records)
    groups = [("Overall", records)] + [(t, [r for r in records if r["type"] == t]) for t in TYPE_ORDER]
    head = ["Slice", "n", "errors", "Refusal acc.", "Cit. precision", "Cit. recall", "Doc recall",
            "Retrieval hit", "Keyword cov.", "Keyword pass"]
    if use_judge:
        head.append("Judge score")
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    for name, rs in groups:
        if not rs:
            continue
        ok = [r for r in rs if r.get("scored")]
        row = [name, str(len(rs)), str(len(rs) - len(ok)),
               pct(mean([1.0 if r["refusal_correct"] else 0.0 for r in ok])),
               pct(mean([r.get("citation_precision") for r in ok])),
               pct(mean([r.get("citation_recall") for r in ok])),
               pct(mean([r.get("doc_recall") for r in ok])),
               pct(mean([r.get("retrieval_recall") for r in ok])),
               pct(mean([r.get("keyword_coverage") for r in ok])),
               pct(mean([1.0 if r.get("keyword_correct") else 0.0 for r in ok]))]
        if use_judge:
            row.append(pct(mean([r.get("judge_score") for r in ok])))
        lines.append("| " + " | ".join(row) + " |")

    per_head = ["id", "type", "refused", "refusal ok", "P", "R", "retrieval", "kw cov.", "kw pass"] + (["judge"] if use_judge else []) + ["citations"]
    per = ["| " + " | ".join(per_head) + " |", "|" + "---|" * len(per_head)]
    for r in records:
        if not r.get("scored"):
            per.append(f"| {r['id']} | {r['type']} | error: {r.get('status')} {str(r.get('error'))[:60]} |" + " |" * (len(per_head) - 3))
            continue
        cells = [r["id"], r["type"], "yes" if r["refused"] else "no", "yes" if r["refusal_correct"] else "**no**",
                 pct(r.get("citation_precision")), pct(r.get("citation_recall")), pct(r.get("retrieval_recall")),
                 pct(r.get("keyword_coverage")), "yes" if r.get("keyword_correct") else "no"]
        if use_judge:
            cells.append("n/a" if r.get("judge_score") is None else f"{r['judge_score']:g}")
        cites = "; ".join(c["tag"] for c in r.get("citations", [])) or "none"
        cells.append(cites.replace("|", "/"))
        per.append("| " + " | ".join(cells) + " |")

    counts = {t: sum(1 for r in records if r["type"] == t) for t in TYPE_ORDER}
    when = dt.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M %Z")
    md = [
        "## Eval results", "",
        f"Run {when} against `{base}`, gold file `{args.gold_name}`, {len(records)} questions"
        " (" + ", ".join(f"{t} {counts[t]}" for t in TYPE_ORDER) + ").",
        f"Page tolerance: {'exact' if args.tolerance == 0 else f'+/-{args.tolerance} (OSHA: neighbouring section)'}."
        f" Keyword pass threshold: {args.kw_threshold:g}." + (f" Judge model: `{args.judge_model}`." if use_judge else ""), "",
        *lines, "",
        "How to read it: refusal accuracy covers every item (answered when it should answer, declined when it should decline)."
        " Citation precision, citation recall, doc recall, retrieval hit and keyword coverage are averaged over single and multi items only;"
        " refuse items show n/a. A range citation such as pp. 19-20 matches a gold page inside it. Retrieval hit is whether a retrieved"
        " passage covers the gold page, whether or not the answer cited it. Keyword pass on refuse items means the item was declined.", "",
        "<details><summary>Per question</summary>", "", *per, "", "</details>", "",
    ]
    return "\n".join(md)


# --------------------------------------------------------------------------
def main() -> None:
    p = argparse.ArgumentParser(description="Score Safety Line against the gold set.",
                                formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("Quick examples")[1])
    p.add_argument("--base-url", default=None, help=f"app URL (default {LOCAL_URL})")
    p.add_argument("--prod", action="store_true", help=f"use production, {PROD_URL}")
    p.add_argument("--gold", type=Path, default=DEFAULT_GOLD)
    p.add_argument("--ids", help="comma list and/or ranges, e.g. q01,q05,q41-q43")
    p.add_argument("--types", help="filter: single,multi,refuse")
    p.add_argument("--limit", type=int, help="score only the first N selected questions")
    p.add_argument("--tolerance", type=int, default=0, choices=[0, 1, 2], help="page tolerance (default 0; 1 = +/-1 page)")
    p.add_argument("--kw-threshold", type=float, default=0.5, help="keyword coverage needed to pass (default 0.5)")
    p.add_argument("--judge", action="store_true", help="also grade correctness with an Anthropic judge model")
    p.add_argument("--judge-model", default=None, help="default: CHAT_MODEL from .env.local, else claude-sonnet-5-5")
    p.add_argument("--per-hour", type=int, default=10, help="max app calls per rolling hour (default 10 = app limit; use 0 with DISABLE_RATE_LIMIT=1 npm run dev)")
    p.add_argument("--min-interval", type=float, default=2.0, help="seconds between app calls (default 2)")
    p.add_argument("--max-retries", type=int, default=3)
    p.add_argument("--backoff", type=float, default=5.0, help="first retry wait for 5xx/network errors, x3 each time")
    p.add_argument("--rate-wait", type=float, default=600.0, help="wait after a per-visitor 429 (default 600 s)")
    p.add_argument("--max-calls", type=int, default=0, help="hard cap on app calls this run, retries included (0 = none)")
    p.add_argument("--timeout", type=float, default=120.0)
    p.add_argument("--out-dir", type=Path, help="default eval/results/<timestamp>-<local|prod>")
    p.add_argument("--rescore", type=Path, help="re-score a saved results.jsonl without calling the app")
    p.add_argument("--check-gold", action="store_true", help="validate the gold file and exit (no calls)")
    args = p.parse_args()
    args._calls = 0
    args.gold_name = os.path.relpath(args.gold, REPO_DIR)

    items, warnings = load_gold(args.gold)
    for w in warnings:
        log(f"gold warning: {w}")
    if args.check_gold:
        counts = {t: sum(1 for i in items if i["_type"] == t) for t in TYPE_ORDER}
        print(f"{len(items)} items: {counts}; {len(warnings)} warnings")
        return
    _, short_to_id = load_sources()
    if args.judge:
        args._key = anthropic_key()
        args.judge_model = args.judge_model or app_env().get("CHAT_MODEL") or os.environ.get("CHAT_MODEL") or "claude-sonnet-5-5"

    base = (args.base_url or (PROD_URL if args.prod else LOCAL_URL)).rstrip("/")
    selected = select(items, args.ids, args.types, args.limit)
    saved: dict[str, dict] = {}
    if args.rescore:
        for line in args.rescore.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                saved[r["id"]] = r
        selected = [i for i in selected if i["id"] in saved]
        base = f"{base} (rescored from {args.rescore})"

    tag = "prod" if "vercel.app" in base else ("rescore" if args.rescore else "local")
    out_dir = args.out_dir or EVAL_DIR / "results" / f"{dt.datetime.now():%Y%m%d-%H%M%S}-{tag}"
    out_dir.mkdir(parents=True, exist_ok=True)
    log(f"Scoring {len(selected)} questions against {base}; writing to {out_dir}")

    pacer = Pacer(args.per_hour, args.min_interval)
    records = []
    with open(out_dir / "results.jsonl", "w") as fh:
        for n, item in enumerate(selected, 1):
            if args.rescore:
                s = saved[item["id"]]
                resp = {k: s.get(k) for k in ("status", "answer", "error", "notice", "seconds", "attempts")}
                resp["passages"] = s.get("passages") or []
                resp["done"] = True
            else:
                if args.max_calls and args._calls >= args.max_calls:
                    log(f"--max-calls {args.max_calls} reached; stopping before {item['id']}")
                    break
                log(f"[{n}/{len(selected)}] {item['id']} ({item['_type']}): {item['question'][:70]}")
                try:
                    resp = ask(base, item["question"], pacer, args)
                except GlobalLimit as e:
                    log(f"Global daily limit hit ({e}). Stopping; partial results kept.")
                    break
            rec = score_item(item, resp, args, short_to_id)
            if args.judge and rec.get("scored"):
                rec.update(judge(item, rec, args))
            elif args.rescore and "judge_score" in saved[item["id"]]:
                rec.update({k: saved[item["id"]].get(k) for k in ("judge_score", "judge_reason", "judge_model")})
            records.append(rec)
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fh.flush()
            if rec.get("scored"):
                log(f"    {rec['id']}: refused={rec['refused']} refusal_ok={rec['refusal_correct']} P={pct(rec.get('citation_precision'))}"
                    f" R={pct(rec.get('citation_recall'))} kw={pct(rec.get('keyword_coverage'))}"
                    + (f" judge={rec.get('judge_score')}" if args.judge else "") + f" ({rec.get('seconds')}s)")
            else:
                log(f"    ERROR {rec.get('status')}: {rec.get('error')}")

    md = summarize(records, args, base)
    (out_dir / "summary.md").write_text(md)
    print(md)
    log(f"Wrote {out_dir / 'results.jsonl'} and {out_dir / 'summary.md'} ({args._calls} app calls)")


if __name__ == "__main__":
    main()
