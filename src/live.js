// Live mode: turn the running description into SQL via Mercury. Calls go through
// the bundled proxy at /api/complete so the key never sits in page state on a
// static host. If you paste a key into the UI it is sent per-request as a header
// and the proxy forwards it — it is not stored anywhere.

import { SCHEMA_TEXT } from "./schema.js";

const SYSTEM = `You convert an analyst's running, comma- or newline-separated description into ONE SQL query over this schema:
${SCHEMA_TEXT}
Rules:
- Return ONLY SQL. No prose. No markdown fences.
- Prefer minimal edits versus the previous query so unchanged clauses stay byte-identical.
- Use the column names exactly as given.`;

function stripFences(s) {
  return s.replace(/^```(?:sql)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

export async function liveSql({ text, prevSql, key, model = "mercury-2" }) {
  const messages = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content:
        `Previous query:\n${prevSql || "(none yet)"}\n\nDescription:\n${text}\n\nSQL:`,
    },
  ];

  const headers = { "content-type": "application/json" };
  if (key) headers["x-mercury-key"] = key;
  // reasoning_effort=instant is the documented low-latency setting for turns
  // that do not need tool calling. NL-to-SQL is exactly that. Measured ~0.4s
  // median vs ~1.0s at the default medium effort.
  const body = JSON.stringify({ model, messages, temperature: 0.5, reasoning_effort: "instant" });

  // The model API occasionally returns a transient 5xx. Retry those a couple of
  // times with a short backoff; do not retry client errors (bad key, etc.).
  let res, detail;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch("/api/complete", { method: "POST", headers, body });
    if (res.ok) break;
    detail = await res.text().catch(() => "");
    if (res.status < 500) break;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }

  if (!res.ok) throw new Error(`proxy ${res.status}: ${detail.slice(0, 200)}`);
  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content ?? "";
  return stripFences(out);
}
