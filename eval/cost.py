#!/usr/bin/env python3
"""Proof for the cost claim: real token usage and dollar cost for one six-step
editing session, per model.

It runs the same six-step storyline through each model once, reads the actual
input and output token counts the API reports, and multiplies by the published
per-token prices. No estimates. The render strategy adds nothing, because both
in-place and full-rewrite send the same prompt and get the same query back. The
only thing that moves the bill is the model.

Run:
  export INCEPTION_API_KEY=...     # or MERCURY_API_KEY
  export ANTHROPIC_API_KEY=...
  python3 cost.py                  # writes results/cost.json
"""
import json, os, urllib.request
from pathlib import Path

# published direct-API prices, USD per million tokens, (input, output)
PRICES = {
    "mercury-2": (0.25, 0.75),
    "haiku-4.5": (1.0, 5.0),
    "opus-4.8":  (5.0, 25.0),
}

SCHEMA = """Table blogs.noaa (global daily weather, ~1.08B rows):
  station_id String, date Date, tempAvg Int32, tempMax Int32, tempMin Int32,
  precipitation UInt32, snowfall UInt32, snowDepth UInt32, percentDailySun UInt8,
  averageWindSpeed UInt32, maxWindSpeed UInt32, weatherType Enum, elevation Float32, name String
Temperatures are in tenths of degrees Celsius. This is ClickHouse SQL."""
SYS = ("You convert an analyst's running, comma- or newline-separated description into ONE SQL query over this schema:\n"
       + SCHEMA + "\nRules:\n- Return ONLY SQL. No prose. No markdown fences.\n"
       "- Prefer minimal edits versus the previous query so unchanged clauses stay byte-identical.\n"
       "- Use the column names exactly as given.")
REFINES = ["average high temperature by year", "summer months only", "and the record high",
           "only well-sampled years", "warmest first", "top 10"]


def user_msg(text, prev):
    return f"Previous query:\n{prev or '(none yet)'}\n\nDescription:\n{text}\n\nSQL:"


def mercury(text, prev):
    key = (os.environ.get("INCEPTION_API_KEY") or os.environ.get("MERCURY_API_KEY") or "").strip()
    body = json.dumps({"model": "mercury-2", "temperature": 0.5, "reasoning_effort": "instant",
        "messages": [{"role": "system", "content": SYS},
                     {"role": "user", "content": user_msg(text, prev)}]}).encode()
    req = urllib.request.Request("https://api.inceptionlabs.ai/v1/chat/completions", data=body,
        method="POST", headers={"Authorization": f"Bearer {key}", "content-type": "application/json"})
    d = json.loads(urllib.request.urlopen(req, timeout=90).read())
    u = d.get("usage", {})
    return u.get("prompt_tokens", 0), u.get("completion_tokens", 0), d["choices"][0]["message"]["content"] or ""


def anthropic(model, with_temp, text, prev):
    key = os.environ["ANTHROPIC_API_KEY"].strip()
    body = {"model": model, "max_tokens": 400, "system": SYS,
            "messages": [{"role": "user", "content": user_msg(text, prev)}]}
    if with_temp:
        body["temperature"] = 0.5
    req = urllib.request.Request("https://api.anthropic.com/v1/messages",
        data=json.dumps(body).encode(), method="POST",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    d = json.loads(urllib.request.urlopen(req, timeout=120).read())
    u = d.get("usage", {})
    txt = "".join(b.get("text", "") for b in d.get("content", []))
    return u.get("input_tokens", 0), u.get("output_tokens", 0), txt


MODELS = {
    "mercury-2": lambda t, p: mercury(t, p),
    "haiku-4.5": lambda t, p: anthropic("claude-haiku-4-5-20251001", True, t, p),
    "opus-4.8":  lambda t, p: anthropic("claude-opus-4-8", False, t, p),
}


def main():
    results = {}
    for name, fn in MODELS.items():
        tin = tout = 0
        prev = text = ""
        for r in REFINES:
            text = (text + "\n" + r).strip() if text else r
            a, b, sql = fn(text, prev)
            prev = sql.strip().strip("`")
            tin += a; tout += b
        pin, pout = PRICES[name]
        cost = tin * pin / 1e6 + tout * pout / 1e6
        results[name] = {"session_input_tokens": tin, "session_output_tokens": tout,
                         "session_cost_usd": round(cost, 6),
                         "sessions_per_dollar": round(1 / cost) if cost else None}
        print(f"{name:11s} in={tin:5d} out={tout:4d}  ${cost:.5f}/session  ~{round(1/cost):>4} sessions/$", flush=True)

    Path("results").mkdir(exist_ok=True)
    Path("results/cost.json").write_text(json.dumps(results, indent=2))
    print("\nwrote results/cost.json")


if __name__ == "__main__":
    main()
