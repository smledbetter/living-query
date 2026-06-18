// Zero-dependency static server + Mercury proxy.
//   node server.mjs            -> serves the demo at http://localhost:3000
//   MERCURY_API_KEY=sk-... node server.mjs   -> live mode works with no UI key
//
// The proxy forwards POST /api/complete to Inception's OpenAI-compatible API.
// The key comes from the MERCURY_API_KEY env var, or from a per-request
// `x-mercury-key` header sent by the page. It is never written to disk.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = process.env.PORT || 3000;
const UPSTREAM = "https://api.inceptionlabs.ai/v1/chat/completions";
// Public, read-only, keyless ClickHouse playground.
const CLICKHOUSE = "https://play.clickhouse.com/?user=explorer";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function send(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "content-type": type });
  res.end(body);
}

async function serveStatic(req, res) {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/") path = "/index.html";
  const full = normalize(join(ROOT, path));
  if (!full.startsWith(ROOT)) return send(res, 403, "forbidden");
  try {
    const data = await readFile(full);
    send(res, 200, data, MIME[extname(full)] || "application/octet-stream");
  } catch {
    send(res, 404, "not found");
  }
}

async function proxyComplete(req, res) {
  const key = req.headers["x-mercury-key"] || process.env.MERCURY_API_KEY;
  if (!key) {
    return send(
      res,
      400,
      "No API key. Set MERCURY_API_KEY in the environment or paste a key in the UI."
    );
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: raw,
    });
    const text = await upstream.text();
    send(res, upstream.status, text, "application/json; charset=utf-8");
  } catch (e) {
    send(res, 502, `upstream error: ${e.message || e}`);
  }
}

async function proxyClickhouse(req, res) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    const upstream = await fetch(CLICKHOUSE, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: raw,
    });
    const text = await upstream.text();
    send(res, upstream.status, text, "application/json; charset=utf-8");
  } catch (e) {
    send(res, 502, `clickhouse error: ${e.message || e}`);
  }
}

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/complete") {
    return proxyComplete(req, res);
  }
  if (req.method === "POST" && req.url === "/api/clickhouse") {
    return proxyClickhouse(req, res);
  }
  serveStatic(req, res);
}).listen(PORT, () => {
  console.log(`Living Query running at http://localhost:${PORT}`);
  console.log(
    process.env.MERCURY_API_KEY
      ? "Live mode: MERCURY_API_KEY found in env."
      : "Live mode: paste a key in the UI, or restart with MERCURY_API_KEY set."
  );
});
