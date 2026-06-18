// Execute a query against the public ClickHouse playground, through the bundled
// proxy (same-origin, dodges browser CORS). The playground is read-only and
// keyless, so this works with no credentials. Returns columns, rows, and the
// real server-side elapsed time.

export async function runQuery(sql) {
  // Strip a trailing semicolon so appending FORMAT does not break the statement.
  const clean = sql.trim().replace(/;\s*$/, "");
  const body = clean + "\nFORMAT JSONCompact";

  // The public playground throws transient errors and rate-limits. Retry a
  // couple of times with a short backoff before surfacing the error.
  let text = "", ok = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch("/api/clickhouse", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
    });
    text = await res.text();
    if (res.ok) { ok = true; break; }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
  }
  if (!ok) throw new Error(text.slice(0, 300).trim() || "ClickHouse request failed");

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(text.slice(0, 300).trim() || "bad response");
  }

  const cols = (data.meta || []).map((m) => m.name);
  const rows = (data.data || []).map((r) => r.map((v) => (v === null ? "∅" : String(v))));
  const elapsed = data.statistics?.elapsed; // seconds
  const elapsedMs = elapsed != null ? Math.round(elapsed * 1000) : null;
  const scanned = data.statistics?.rows_read ?? null;
  return { cols, rows, elapsedMs, scanned, total: data.rows ?? rows.length };
}
