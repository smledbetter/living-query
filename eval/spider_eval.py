#!/usr/bin/env python3
"""Spider 1.0 execution-accuracy eval for Mercury 2 vs Haiku 4.5 vs Opus 4.8.

Single-call zero-shot. Same prompt for every model; only the model changes.
Schema is the DB's real CREATE TABLE statements. Correctness = execution match
against the gold query (ordered if gold has ORDER BY, set-wise otherwise).

Usage:
  python3 spider_eval.py --model gold   --limit 1034          # Gate 0 plumbing
  python3 spider_eval.py --model mercury --limit 50           # Gate 1 smoke
  python3 spider_eval.py --model haiku   --limit 50
  python3 spider_eval.py --model opus    --limit 50
"""
import argparse, json, os, re, sqlite3, sys, time, urllib.request, urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# data dir is either spider/ or spider_data/ after unzip
DATA = next((ROOT / d for d in ("spider_data", "spider") if (ROOT / d).is_dir()), None)

def find(name):
    hits = list(DATA.rglob(name))
    if not hits:
        sys.exit(f"missing {name} under {DATA}")
    return hits[0]

def db_path(db_id):
    return DATA / "database" / db_id / f"{db_id}.sqlite"

_schema_cache = {}
def schema_for(db_id):
    if db_id in _schema_cache:
        return _schema_cache[db_id]
    con = sqlite3.connect(f"file:{db_path(db_id)}?mode=ro", uri=True)
    rows = con.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL ORDER BY name"
    ).fetchall()
    con.close()
    ddl = "\n".join(r[0].strip() + ";" for r in rows)
    _schema_cache[db_id] = ddl
    return ddl

def execute(db_id, sql, timeout_s=5.0):
    """Return ('ok', rows) or ('err', message). Aborts runaway queries."""
    try:
        con = sqlite3.connect(f"file:{db_path(db_id)}?mode=ro", uri=True)
        con.text_factory = lambda b: b.decode("utf-8", "replace")
        deadline = time.time() + timeout_s
        # progress handler fires every N vm ops; returning non-zero aborts.
        con.set_progress_handler(lambda: 1 if time.time() > deadline else 0, 100000)
        cur = con.execute(sql)
        rows = cur.fetchall()
        con.close()
        return "ok", rows
    except Exception as e:
        return "err", str(e)[:160]

def norm(rows):
    return [tuple(str(v) for v in r) for r in rows]

def matches(gold_rows, pred_rows, gold_sql):
    g, p = norm(gold_rows), norm(pred_rows)
    if "order by" in gold_sql.lower():
        return g == p
    return sorted(g) == sorted(p)

# ---- model clients ---------------------------------------------------------
SYS = ("You are an expert data analyst. Given a SQLite schema and a question, "
       "write ONE SQLite SQL query that answers it. Return ONLY the SQL on a single "
       "logical statement, no prose, no markdown fences.")

def build_prompt(db_id, question):
    return f"Schema (SQLite):\n{schema_for(db_id)}\n\nQuestion: {question}\nSQL:"

def strip_sql(s):
    s = s.strip()
    s = re.sub(r"^```(?:sql)?\s*", "", s, flags=re.I)
    s = re.sub(r"\s*```$", "", s, flags=re.I)
    s = "\n".join(l for l in s.splitlines() if not l.strip().startswith("--")).strip()
    return s.rstrip(";").strip()

def call_mercury(db_id, question):
    key = (os.environ.get("INCEPTION_API_KEY") or os.environ.get("MERCURY_API_KEY") or "").strip()
    body = json.dumps({"model": "mercury-2", "temperature": 0.5, "reasoning_effort": "instant",
        "messages": [{"role": "system", "content": SYS},
                     {"role": "user", "content": build_prompt(db_id, question)}]}).encode()
    req = urllib.request.Request("https://api.inceptionlabs.ai/v1/chat/completions", data=body,
        method="POST", headers={"Authorization": f"Bearer {key}", "content-type": "application/json"})
    d = json.loads(urllib.request.urlopen(req, timeout=90).read())
    return strip_sql(d["choices"][0]["message"]["content"] or "")

def call_anthropic(model, with_temp, db_id, question):
    key = os.environ["ANTHROPIC_API_KEY"].strip()
    body = {"model": model, "max_tokens": 600, "system": SYS,
            "messages": [{"role": "user", "content": build_prompt(db_id, question)}]}
    if with_temp:
        body["temperature"] = 0
    req = urllib.request.Request("https://api.anthropic.com/v1/messages",
        data=json.dumps(body).encode(), method="POST",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    d = json.loads(urllib.request.urlopen(req, timeout=120).read())
    txt = "".join(b.get("text", "") for b in d.get("content", []))
    return strip_sql(txt)

def predict(model, db_id, question):
    if model == "mercury":
        return call_mercury(db_id, question)
    if model == "haiku":
        return call_anthropic("claude-haiku-4-5-20251001", True, db_id, question)
    if model == "opus":
        return call_anthropic("claude-opus-4-8", False, db_id, question)
    raise ValueError(model)

def with_retry(fn, *a, tries=4):
    for i in range(tries):
        try:
            return fn(*a)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 529) and i < tries - 1:
                time.sleep(2 * (i + 1)); continue
            raise

# ---- main ------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, choices=["gold", "mercury", "haiku", "opus"])
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    dev = json.loads(find("dev.json").read_text())
    if args.limit:
        dev = dev[:args.limit]
    print(f"[{args.model}] {len(dev)} examples; data={DATA}", flush=True)

    n = valid = correct = 0
    fails = []
    t0 = time.time()
    for i, ex in enumerate(dev):
        db_id, q, gold = ex["db_id"], ex["question"], ex["query"]
        gst, grows = execute(db_id, gold)
        if gst != "ok":
            # gold itself errored — skip from denominator, note it
            fails.append({"i": i, "db": db_id, "kind": "GOLD_ERR", "msg": grows})
            continue
        if args.model == "gold":
            pred, prows, pst = gold, grows, "ok"
        else:
            try:
                pred = with_retry(predict, args.model, db_id, q)
            except Exception as e:
                fails.append({"i": i, "db": db_id, "kind": "API_ERR", "msg": str(e)[:160]})
                n += 1
                continue
            pst, prows = execute(db_id, pred)
        n += 1
        ok = pst == "ok"
        cor = ok and matches(grows, prows, gold)
        valid += ok; correct += cor
        if not cor and len(fails) < 40:
            fails.append({"i": i, "db": db_id, "kind": "WRONG" if ok else "EXEC_ERR",
                          "q": q, "gold": gold, "pred": pred if args.model != "gold" else "",
                          "msg": "" if ok else prows})
        if (i + 1) % 50 == 0:
            print(f"  {i+1}/{len(dev)}  valid={valid} correct={correct} "
                  f"({correct/max(n,1)*100:.1f}%)  {time.time()-t0:.0f}s", flush=True)

    dur = time.time() - t0
    print(f"\n=== {args.model} ===")
    print(f"scored N={n}  valid={valid} ({valid/max(n,1)*100:.1f}%)  "
          f"correct={correct} ({correct/max(n,1)*100:.1f}%)  {dur:.0f}s", flush=True)
    out = args.out or f"results_{args.model}.json"
    Path(ROOT / out).write_text(json.dumps(
        {"model": args.model, "n": n, "valid": valid, "correct": correct,
         "exec_acc": correct / max(n, 1), "seconds": dur, "fails": fails}, indent=2))
    print(f"wrote {out}; {len(fails)} fail samples logged", flush=True)

if __name__ == "__main__":
    main()
