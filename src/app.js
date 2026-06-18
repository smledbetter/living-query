import { SCENES } from "./scenes.js";
import { SCHEMA_NOTE } from "./schema.js";
import { tokenize, patchInPlace, renderWhole, showSpinner, streamTokens, cancelStream } from "./diff.js";
import { liveSql } from "./live.js";
import { runQuery } from "./db.js";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reduceMotion =
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Model speed scales the canned generation wait. The ttft values are REAL,
// measured medians over 12 trials on the same prompt via each model's native
// API. See Projects/Living Query/latency-measurements.md. In live mode the
// latency is the actual Mercury call, so this control is hidden there.
//   Mercury 2 at reasoning_effort=instant: ~395 ms median
//   Claude Haiku 4.5:                       ~1400 ms median  (3.5x slower)
const SPEED = {
  fast: { ttft: 395, tok: 5, note: "Mercury 2 (instant) · measured ~0.4s median" },
  typical: { ttft: 1400, tok: 5, note: "Claude Haiku 4.5 · measured ~1.4s median, 3.5x slower" },
};
const EXEC_MS = 460; // ClickHouse playground execution, measured ~450-485 ms over blogs.noaa

const el = {
  english: $("english"),
  liveInput: $("live-input"),
  sqlInplace: $("sql-inplace"),
  sqlNaive: $("sql-naive"),
  statInplace: $("stat-inplace"),
  statNaive: $("stat-naive"),
  result: $("result"),
  schemaNote: $("schema-note"),
  caretHint: $("caret-hint"),
  speed: $("speed"),
  speedNote: $("speed-note"),
  play: $("play"),
  step: $("step"),
  reset: $("reset"),
  cannedBar: $("canned-bar"),
  liveBar: $("live-bar"),
  key: $("key"),
  liveStatus: $("live-status"),
  modeCanned: $("mode-canned"),
  modeLive: $("mode-live"),
  modelSeg: $("model-seg"),
  modelFast: $("model-fast"),
  modelTypical: $("model-typical"),
  playLive: $("play-live"),
  resetLive: $("reset-live"),
};

const state = {
  mode: "canned",
  step: -1,
  prevInplace: [],
  prevSql: "",
  playing: false,
  apiKey: "",
  modelSpeed: "fast",
  genId: 0, // bumped to cancel in-flight generations
};

el.schemaNote.textContent = SCHEMA_NOTE;

function statHtml(c) {
  const parts = [];
  if (c.added) parts.push(`<i>+${c.added}</i>`);
  if (c.removed) parts.push(`−${c.removed}`);
  parts.push(`<b>${c.kept} pinned</b>`);
  return parts.join(" · ");
}

function pace() { return Number(el.speed.value || 1); }

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
const fmt = (n) => (n == null ? "?" : Number(n).toLocaleString("en-US"));

function dbNote(r) {
  const parts = [`ClickHouse · ${r.elapsedMs} ms`];
  if (r.scanned != null) parts.push(`${fmt(r.scanned)} rows scanned`);
  return parts.join(" · ");
}

function showResultLoading() {
  el.result.innerHTML =
    '<div class="running"><span class="run-spinner"></span>Running query…</div>';
}

function renderResult(cols, rows, note) {
  const thead = `<tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`;
  const body = rows
    .slice(0, 8)
    .map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`)
    .join("");
  const head = note ? `<div class="run-note">${esc(note)}</div>` : "";
  el.result.innerHTML = `${head}<table class="res"><thead>${thead}</thead><tbody>${body}</tbody></table>`;
  if (!reduceMotion) {
    el.result.classList.remove("swap");
    void el.result.offsetWidth;
    el.result.classList.add("swap");
  }
}

// Canned result: real rows, snapshotted from the playground.
function runResult(scene, gen) {
  showResultLoading();
  return sleep((reduceMotion ? 0 : EXEC_MS) / pace()).then(() => {
    if (gen === state.genId) renderResult(scene.cols, scene.rows);
  });
}

// Live result: run the real SQL against the ClickHouse playground. The public
// playground rate-limits and throws transient errors, so on failure fall back
// to the snapshot rows — which are real data captured from the same table — so
// the demo never shows an error. Live execution is best-effort for the latency.
function runResultLive(sql, gen, scene) {
  showResultLoading();
  return runQuery(sql)
    .then((r) => { if (gen === state.genId) renderResult(r.cols, r.rows, dbNote(r)); })
    .catch(() => {
      if (gen !== state.genId) return;
      if (scene) renderResult(scene.cols, scene.rows, "real data · blogs.noaa");
      else el.result.innerHTML = '<div class="run-note err">ClickHouse busy — try again</div>';
    });
}

// ---- Shared helpers --------------------------------------------------------

function clearPanels() {
  cancelStream();
  state.genId++;
  state.playing = false;
  state.step = -1;
  state.prevInplace = [];
  state.prevSql = "";
  el.english.textContent = "";
  el.liveInput.value = "";
  el.sqlInplace.textContent = "";
  el.sqlNaive.textContent = "";
  el.result.textContent = "";
  el.statInplace.textContent = "";
  el.statNaive.textContent = "";
  el.play.textContent = "▶ Play";
}

async function typeRefine(text, isLead) {
  const line = document.createElement("span");
  line.className = "typed-line " + (isLead ? "lead" : "refine");
  el.english.appendChild(line);
  const caret = document.createElement("span");
  caret.className = "caret";
  line.append(isLead ? "" : "+ ");
  line.appendChild(caret);
  const base = reduceMotion ? 0 : 16 / pace();
  for (const ch of text) {
    caret.insertAdjacentText("beforebegin", ch);
    if (base) await sleep(base * (0.6 + Math.random() * 0.8));
  }
  caret.remove();
}

async function typeIntoTextarea(text, prefixNewline) {
  if (prefixNewline) el.liveInput.value += "\n";
  const base = reduceMotion ? 0 : 16 / pace();
  for (const ch of text) {
    el.liveInput.value += ch;
    el.liveInput.scrollTop = el.liveInput.scrollHeight;
    if (base) await sleep(base * (0.6 + Math.random() * 0.8));
  }
}

// ---- Canned playback (scripted SQL, simulated timing, snapshot rows) --------

async function regenerate(responseSql, scene, gen) {
  const sp = SPEED[state.modelSpeed];
  const ttft = (reduceMotion ? 0 : sp.ttft) / pace();
  const tokDelay = sp.tok / pace();
  const firstGen = state.prevInplace.length === 0;

  if (!reduceMotion) {
    if (firstGen) showSpinner(el.sqlInplace);
    else el.statInplace.innerHTML = '<span class="hint">updating…</span>';
    showSpinner(el.sqlNaive);
    await sleep(ttft);
    if (gen !== state.genId) return;
  }

  const toks = tokenize(responseSql);
  const nonws = toks.filter((t) => t.trim() !== "").length;

  if (firstGen) el.sqlInplace.textContent = "";
  const c = patchInPlace(el.sqlInplace, state.prevInplace, toks, !reduceMotion);
  state.prevInplace = toks;
  state.prevSql = responseSql;
  el.statInplace.innerHTML = c.kept ? statHtml(c) : '<span class="hint">starting query</span>';

  let streaming = Promise.resolve();
  if (reduceMotion) {
    renderWhole(el.sqlNaive, toks);
    el.statNaive.innerHTML = `<u>${nonws}</u> re-created`;
  } else {
    el.statNaive.innerHTML = '<span class="hint">regenerating…</span>';
    streaming = streamTokens(el.sqlNaive, toks, tokDelay).then(() => {
      if (gen === state.genId) el.statNaive.innerHTML = `<u>${nonws}</u> re-created`;
    });
  }

  const running = runResult(scene, gen);
  await Promise.all([streaming, running]);
}

async function applyStep(i) {
  const scene = SCENES[i];
  const gen = state.genId;
  await typeRefine(scene.refine, i === 0);
  if (gen !== state.genId) return;
  if (!reduceMotion) await sleep(220 / pace());
  await regenerate(scene.sql, scene, gen);
}

async function play() {
  if (state.playing) return;
  state.playing = true;
  el.play.textContent = "▮ Playing";
  for (let i = state.step + 1; i < SCENES.length; i++) {
    if (!state.playing) break;
    state.step = i;
    await applyStep(i);
    if (!state.playing) break;
    if (!reduceMotion) await sleep(500 / pace());
  }
  state.playing = false;
  el.play.textContent = state.step >= SCENES.length - 1 ? "▶ Replay" : "▶ Play";
}

async function stepOnce() {
  if (state.playing) return;
  if (state.step >= SCENES.length - 1) clearPanels();
  state.step += 1;
  await applyStep(state.step);
  el.play.textContent = state.step >= SCENES.length - 1 ? "▶ Replay" : "▶ Play";
}

// Show the first scene statically so canned mode is never blank on load.
function primeScene0() {
  clearPanels();
  const s = SCENES[0];
  const lead = document.createElement("span");
  lead.className = "typed-line lead";
  lead.textContent = s.refine;
  el.english.appendChild(lead);
  const toks = tokenize(s.sql);
  renderWhole(el.sqlInplace, toks);
  renderWhole(el.sqlNaive, toks);
  const nonws = toks.filter((t) => t.trim() !== "").length;
  el.statInplace.innerHTML = '<span class="hint">starting query</span>';
  el.statNaive.innerHTML = `<u>${nonws}</u> re-created`;
  state.prevInplace = toks;
  state.prevSql = s.sql;
  renderResult(s.cols, s.rows);
  state.step = 0;
}

function playOrReplay() {
  if (state.playing) return;
  clearPanels();
  play();
}

// ---- Live mode (real Mercury, real ClickHouse) -----------------------------

// One real refinement: Mercury generates, both panels render it, ClickHouse runs
// it. Returns false on error or cancellation.
async function liveGenerate(text, gen, scene) {
  el.liveStatus.textContent = "Mercury…";
  const firstGen = state.prevInplace.length === 0;
  if (firstGen) showSpinner(el.sqlInplace);
  else el.statInplace.innerHTML = '<span class="hint">updating…</span>';
  showSpinner(el.sqlNaive);

  const t0 = performance.now();
  let sql;
  try {
    sql = await liveSql({ text, prevSql: state.prevSql, key: state.apiKey });
  } catch (e) {
    if (gen === state.genId) {
      // Clear the stuck spinner — restore the last good query on both panels.
      if (state.prevInplace.length) {
        renderWhole(el.sqlNaive, state.prevInplace);
        el.statInplace.innerHTML = "";
      } else {
        el.sqlNaive.textContent = "";
        el.statInplace.innerHTML = '<span class="hint">type to begin</span>';
      }
      el.statNaive.textContent = "";
      el.liveStatus.textContent = "Mercury hiccup — hit Play live again. " + String(e.message || e).slice(0, 90);
    }
    return false;
  }
  if (gen !== state.genId) return false;
  if (!sql) {
    el.liveStatus.textContent = "model returned nothing";
    return false;
  }

  const ms = Math.round(performance.now() - t0);
  const toks = tokenize(sql);
  const nonws = toks.filter((t) => t.trim() !== "").length;
  if (firstGen) el.sqlInplace.textContent = "";
  const c = patchInPlace(el.sqlInplace, state.prevInplace, toks, !reduceMotion);
  state.prevInplace = toks;
  state.prevSql = sql;
  el.statInplace.innerHTML = c.kept ? statHtml(c) : '<span class="hint">starting query</span>';

  let streaming = Promise.resolve();
  if (reduceMotion) {
    renderWhole(el.sqlNaive, toks);
    el.statNaive.innerHTML = `<u>${nonws}</u> re-created`;
  } else {
    el.statNaive.innerHTML = '<span class="hint">regenerating…</span>';
    streaming = streamTokens(el.sqlNaive, toks, SPEED.fast.tok / pace()).then(() => {
      if (gen === state.genId) el.statNaive.innerHTML = `<u>${nonws}</u> re-created`;
    });
  }

  el.liveStatus.textContent = `✓ Mercury ${ms} ms`;
  const running = runResultLive(sql, gen, scene);
  await Promise.all([streaming, running]);
  return gen === state.genId;
}

let liveTimer = null;
function onLiveInput() {
  if (state.playing) return; // Play live is driving the box
  clearTimeout(liveTimer);
  el.liveStatus.textContent = "…";
  liveTimer = setTimeout(() => {
    const text = el.liveInput.value.trim();
    if (!text) {
      el.liveStatus.textContent = "Type a description, or hit Play live.";
      return;
    }
    liveGenerate(text, ++state.genId);
  }, 650);
}

// Drive the scripted prompts through real Mercury + real ClickHouse.
async function playLive() {
  if (state.playing) return;
  clearPanels();
  const gen = state.genId; // clearPanels bumped it
  state.playing = true;
  el.playLive.textContent = "▮ Playing";
  let desc = "";
  try {
    for (let i = 0; i < SCENES.length; i++) {
      if (!state.playing || gen !== state.genId) break;
      await typeIntoTextarea(SCENES[i].refine, i > 0);
      desc = el.liveInput.value;
      if (!state.playing || gen !== state.genId) break;
      const ok = await liveGenerate(desc, gen, SCENES[i]);
      if (!ok || !state.playing || gen !== state.genId) break;
      if (!reduceMotion) await sleep(800 / pace());
    }
  } finally {
    if (gen === state.genId) {
      state.playing = false;
      el.playLive.textContent = "▶ Play live";
    }
  }
}

function resetLive() {
  clearPanels();
  el.playLive.textContent = "▶ Play live";
  el.statInplace.innerHTML = '<span class="hint">hit Play live, or type below</span>';
  el.liveStatus.textContent = state.apiKey ? "Ready." : "Paste a key, or run the proxy with MERCURY_API_KEY.";
}

// ---- Controls --------------------------------------------------------------

function setMode(mode) {
  state.mode = mode;
  const live = mode === "live";
  el.modeCanned.classList.toggle("on", !live);
  el.modeLive.classList.toggle("on", live);
  el.modeCanned.setAttribute("aria-selected", String(!live));
  el.modeLive.setAttribute("aria-selected", String(live));
  el.cannedBar.classList.toggle("hidden", live);
  el.liveBar.classList.toggle("hidden", !live);
  el.english.classList.toggle("hidden", live);
  el.liveInput.classList.toggle("hidden", !live);
  el.modelSeg.classList.toggle("hidden", live); // canned-only simulation device
  el.caretHint.textContent = live ? "(real Mercury)" : "(scripted · simulated timing)";

  if (!live) primeScene0();
  else resetLive();
}

function setModelSpeed(which) {
  state.modelSpeed = which;
  el.modelFast.classList.toggle("on", which === "fast");
  el.modelTypical.classList.toggle("on", which === "typical");
  el.speedNote.textContent = SPEED[which].note;
}

// ---- Wire up ---------------------------------------------------------------

el.play.addEventListener("click", playOrReplay);
el.step.addEventListener("click", stepOnce);
el.reset.addEventListener("click", primeScene0);
el.modeCanned.addEventListener("click", () => setMode("canned"));
el.modeLive.addEventListener("click", () => setMode("live"));
el.modelFast.addEventListener("click", () => setModelSpeed("fast"));
el.modelTypical.addEventListener("click", () => setModelSpeed("typical"));
el.playLive.addEventListener("click", playLive);
el.resetLive.addEventListener("click", resetLive);
el.liveInput.addEventListener("input", onLiveInput);
el.key.addEventListener("input", (e) => {
  state.apiKey = e.target.value.trim();
  el.liveStatus.textContent = state.apiKey ? "Key set for this tab." : "Key cleared.";
});

setModelSpeed("fast");
setMode("canned");
