#!/usr/bin/env python3
"""Proof for the speed claim: time-to-finished-query for Mercury 2, Haiku 4.5,
and Opus 4.8 on the same six-step NL2SQL storyline.

Each model is called on its own native API. The clock starts the instant the
request is sent and stops when the full response is back. That total is what an
in-place diff waits for before it can patch. We also record time-to-first-token.
Median over N rounds is reported.

Run:
  export INCEPTION_API_KEY=...     # https://platform.inceptionlabs.ai
  export ANTHROPIC_API_KEY=...     # https://console.anthropic.com
  python3 latency.py               # writes results/latency.json
"""
import json, os, statistics, time, urllib.request, urllib.error
from pathlib import Path

ROUNDS = int(os.environ.get("ROUNDS", "8"))

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


def stream(req):
    """Send a streaming request. Return (ttft_ms, total_ms, text). Works for both
    Inception (OpenAI SSE) and Anthropic (event SSE)."""
    t0 = time.perf_counter()
    ttft = None
    out = []
    with urllib.request.urlopen(req, timeout=120) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload in ("", "[DONE]"):
                continue
            try:
                ev = json.loads(payload)
            except Exception:
                continue
            piece = ""
            if ev.get("type") == "content_block_delta":               # anthropic
                piece = ev.get("delta", {}).get("text", "")
            elif ev.get("choices"):                                    # openai/inception
                piece = (ev["choices"][0].get("delta") or {}).get("content") or ""
            if piece:
                if ttft is None:
                    ttft = (time.perf_counter() - t0) * 1000
                out.append(piece)
    return ttft, (time.perf_counter() - t0) * 1000, "".join(out)


def mercury(text, prev):
    key = (os.environ.get("INCEPTION_API_KEY") or os.environ.get("MERCURY_API_KEY") or "").strip()
    body = json.dumps({"model": "mercury-2", "temperature": 0.5, "reasoning_effort": "instant",
        "stream": True, "messages": [{"role": "system", "content": SYS},
        {"role": "user", "content": user_msg(text, prev)}]}).encode()
    req = urllib.request.Request("https://api.inceptionlabs.ai/v1/chat/completions", data=body,
        method="POST", headers={"Authorization": f"Bearer {key}", "content-type": "application/json"})
    return stream(req)


def anthropic(model, with_temp, text, prev):
    key = os.environ["ANTHROPIC_API_KEY"].strip()
    body = {"model": model, "max_tokens": 400, "system": SYS, "stream": True,
            "messages": [{"role": "user", "content": user_msg(text, prev)}]}
    if with_temp:
        body["temperature"] = 0.5
    req = urllib.request.Request("https://api.anthropic.com/v1/messages",
        data=json.dumps(body).encode(), method="POST",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    return stream(req)


MODELS = {
    "mercury-2":  lambda t, p: mercury(t, p),
    "haiku-4.5":  lambda t, p: anthropic("claude-haiku-4-5-20251001", True, t, p),
    "opus-4.8":   lambda t, p: anthropic("claude-opus-4-8", False, t, p),  # temperature deprecated for opus 4.8
}


def main():
    results = {}
    for name, fn in MODELS.items():
        ttfts, totals = [], []
        print(f"\n=== {name} ===", flush=True)
        for rnd in range(ROUNDS):
            prev, text = "", ""
            for i, r in enumerate(REFINES):
                text = (text + "\n" + r).strip() if text else r
                ttft, total, sql = fn(text, prev)
                prev = sql.strip().strip("`")
                ttfts.append(ttft or total); totals.append(total)
                if rnd == 0:
                    print(f"  step{i} '{r}': ttft={ttft or total:.0f}ms total={total:.0f}ms", flush=True)
        results[name] = {"n": len(totals),
                         "median_ttft_ms": round(statistics.median(ttfts)),
                         "median_total_ms": round(statistics.median(totals))}
        print(f"  --> N={len(totals)} median TTFT={results[name]['median_ttft_ms']}ms "
              f"median TOTAL={results[name]['median_total_ms']}ms", flush=True)

    base = results["opus-4.8"]["median_total_ms"]
    print("\nTime to a finished query (median):")
    for k, v in results.items():
        print(f"  {k:11s} {v['median_total_ms']/1000:.2f}s   {base/v['median_total_ms']:.1f}x faster than Opus")
    Path("results").mkdir(exist_ok=True)
    Path("results/latency.json").write_text(json.dumps(results, indent=2))
    print("\nwrote results/latency.json")


if __name__ == "__main__":
    main()
