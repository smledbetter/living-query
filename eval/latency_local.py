#!/usr/bin/env python3
"""Local-model latency on this machine: time to a finished SQL query for MLX
models, on the same six-step NL2SQL storyline as latency.py.

No network round-trip — this is pure on-device compute, the honest "what does
the fast stack cost on a laptop" number. Reports median time-to-finished-query,
time-to-first-token, and decode tokens/sec.

Run (via uv, no global install):
  uv run --python 3.13 --with mlx-lm python eval/latency_local.py \
    mlx-community/Qwen2.5-Coder-3B-Instruct-4bit \
    mlx-community/Qwen2.5-Coder-7B-Instruct-4bit
"""
import json, re, statistics, sys, time
from pathlib import Path
from mlx_lm import load, stream_generate

ROUNDS = 5

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


def strip(s):
    s = s.strip()
    s = re.sub(r"^```(?:sql)?\s*", "", s); s = re.sub(r"\s*```$", "", s)
    return s.strip()


def run_model(model_id):
    tag = model_id.split("/")[-1]
    print(f"\n=== loading {tag} ===", flush=True)
    t_load = time.perf_counter()
    model, tok = load(model_id)
    print(f"  loaded in {time.perf_counter()-t_load:.1f}s", flush=True)

    ttfts, totals, tpss = [], [], []
    for rnd in range(ROUNDS):
        prev, text = "", ""
        for i, r in enumerate(REFINES):
            text = (text + "\n" + r).strip() if text else r
            user = f"Previous query:\n{prev or '(none yet)'}\n\nDescription:\n{text}\n\nSQL:"
            prompt = tok.apply_chat_template(
                [{"role": "system", "content": SYS}, {"role": "user", "content": user}],
                add_generation_prompt=True)
            t0 = time.perf_counter(); ttft = None; out = []; gtps = None
            for resp in stream_generate(model, tok, prompt, max_tokens=200):
                if ttft is None:
                    ttft = (time.perf_counter() - t0) * 1000
                out.append(resp.text)
                gtps = getattr(resp, "generation_tps", None)
            total = (time.perf_counter() - t0) * 1000
            prev = strip("".join(out))
            ttfts.append(ttft or total); totals.append(total)
            if gtps:
                tpss.append(gtps)
            if rnd == 0:
                print(f"  step{i} '{r}': total={total:.0f}ms ttft={ttft or total:.0f}ms "
                      f"{gtps:.0f} tok/s | {len(prev)} chars", flush=True)
    res = {"model": tag, "n": len(totals),
           "median_total_ms": round(statistics.median(totals)),
           "median_ttft_ms": round(statistics.median(ttfts)),
           "median_decode_tps": round(statistics.median(tpss)) if tpss else None}
    print(f"  --> median TOTAL={res['median_total_ms']}ms  TTFT={res['median_ttft_ms']}ms  "
          f"{res['median_decode_tps']} tok/s", flush=True)
    return res


def main():
    ids = sys.argv[1:] or ["mlx-community/Qwen2.5-Coder-3B-Instruct-4bit"]
    results = [run_model(m) for m in ids]
    print("\n=== SUMMARY (time to a finished query, this machine) ===")
    for r in results:
        print(f"  {r['model']:34s} {r['median_total_ms']/1000:.2f}s   {r['median_decode_tps']} tok/s")
    Path("results").mkdir(exist_ok=True)
    Path("results/latency_local.json").write_text(json.dumps(results, indent=2))
    print("\nwrote results/latency_local.json")


if __name__ == "__main__":
    main()
