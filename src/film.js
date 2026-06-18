// Deterministic "film" renderer for the three blog comparison GIFs.
//
// The whole animation is a pure function of a virtual clock T in ms. Call
// window.__seek(T) and the page shows exactly the state at time T — no
// setTimeout, no requestAnimationFrame timing, no background-tab throttling.
// A capture script steps T from 0 to window.__filmDuration and screenshots each
// frame; ffmpeg assembles the GIF. Opening the page normally autoplays in real
// time for a sanity check (disable with ?cap=1).
//
// Every latency in CONFIGS is a measured median. See
// Projects/Living Query/latency-measurements.md. The render strategy (in place
// vs full rewrite) is the experience axis; the model total is the speed axis.

import { SCENES } from "./scenes.js";

// ---- configs ---------------------------------------------------------------
// total = time to the full SQL (what an in-place diff waits for).
// ttft  = time to first token (when a full-rewrite stream starts).
// price = USD for one full six-step session (input 1664 + output 395 tokens).
const M = {
  mercury: { name: "Mercury 2", total: 395, ttft: 395, price: 0.00071 },
  haiku:   { name: "Haiku 4.5", total: 1402, ttft: 805, price: 0.00364 },
  opus:    { name: "Opus 4.8",  total: 2218, ttft: 1326, price: 0.01820 },
};

const CONFIGS = {
  "1": {
    title: "Fast stack vs typical",
    left:  { ...M.mercury, render: "inplace" },
    right: { ...M.haiku,   render: "rewrite" },
  },
  "2": {
    title: "Claude fast stack vs typical",
    left:  { ...M.haiku, render: "inplace" },
    right: { ...M.haiku, render: "rewrite" },
  },
  "3": {
    title: "Frontier stack vs typical",
    left:  { ...M.opus, render: "inplace" },
    right: { ...M.opus, render: "rewrite" },
  },
};

const params = new URLSearchParams(location.search);
const cfg = CONFIGS[params.get("c") || "1"];
const CAPTURE = params.get("cap") === "1";

// ---- pacing (my choice, not latency) ---------------------------------------
const TYPE_MS = 24;   // per character of the English refinement
const GAP = 200;      // pause after typing before the model "commits"
const HOLD = 750;     // read time after both sides finish
const DECAY = 1100;   // in-place highlight fade
const INTRO = 500;
const OUTRO = 1300;

// ---- tokenizer + classifier (self-contained) -------------------------------
const KEYWORDS = new Set(["select","from","where","group","by","order","having","limit",
  "and","or","not","as","on","join","left","right","inner","outer","desc","asc",
  "distinct","in","between","like","is","null","case","when","then","else","end","union","all","with"]);
const FUNCS = new Set(["sum","count","avg","min","max","round","coalesce","date_trunc",
  "now","cast","extract","abs","toyear","tomonth","tostartofmonth"]);

function tokenize(sql) {
  const re = /\s+|'[^']*'|[A-Za-z_][A-Za-z0-9_.]*|\d+(?:\.\d+)?|[^\sA-Za-z0-9_]/g;
  const out = []; let m;
  while ((m = re.exec(sql))) out.push(m[0]);
  return out;
}
function classify(tok) {
  if (/^\s+$/.test(tok)) return "ws";
  const low = tok.toLowerCase();
  if (KEYWORDS.has(low)) return "kw";
  if (FUNCS.has(low)) return "fn";
  if (tok[0] === "'") return "str";
  if (/^\d/.test(tok)) return "num";
  if (/^[A-Za-z_]/.test(tok)) return "ident";
  return "punct";
}
// indices of newTokens that already existed (matched) in prevTokens, via LCS.
function lcsMatchedNew(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const matched = new Set(); let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { matched.add(j); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return matched;
}

// ---- precompute steps + timeline -------------------------------------------
const steps = SCENES.map((s, i) => {
  const toks = tokenize(s.sql);
  const prev = i > 0 ? tokenize(SCENES[i - 1].sql) : [];
  const matched = lcsMatchedNew(prev, toks);
  const changed = new Set();
  toks.forEach((t, idx) => { if (!matched.has(idx) && t.trim() !== "") changed.add(idx); });
  const nonws = toks.filter((t) => t.trim() !== "").length;
  const added = changed.size;
  const kept = toks.filter((t, idx) => matched.has(idx) && t.trim() !== "").length;
  return { refine: s.refine, toks, prevToks: prev, changed, nonws, added, kept };
});

let T0 = INTRO;
const tl = steps.map((st) => {
  const typeDur = st.refine.length * TYPE_MS;
  const commit = T0 + typeDur + GAP;
  const wait = Math.max(cfg.left.total, cfg.right.total);
  const doneAt = commit + wait;
  const endAt = doneAt + HOLD;
  const seg = { ...st, start: T0, typeDur, commit, wait, doneAt, endAt };
  T0 = endAt;
  return seg;
});
const DURATION = T0 + OUTRO;

// ---- DOM refs --------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const sqlLeft = $("sql-left"), sqlRight = $("sql-right");
const clockLeft = $("clock-left"), clockRight = $("clock-right");
const statLeft = $("stat-left"), statRight = $("stat-right");
const english = $("english");

// header / labels
$("title-left").textContent = cfg.left.name;
$("title-right").textContent = cfg.right.name;
$("badge-left").textContent = "in place";
$("badge-right").textContent = "full rewrite";
$("name-left").textContent = cfg.left.name;
$("name-right").textContent = cfg.right.name;
$("price-left").textContent = fmtPrice(cfg.left.price);
$("price-right").textContent = fmtPrice(cfg.right.price);
$("subtitle").textContent = cfg.title;

function fmtPrice(p) {
  return "$" + p.toFixed(4) + " / session";
}
function clk(ms, done) {
  return (done ? "● " : "") + (ms / 1000).toFixed(2) + "s";
}

// ---- token rendering -------------------------------------------------------
function tokSpan(tok, hl) {
  const s = document.createElement("span");
  s.className = "tok t-" + classify(tok);
  s.textContent = tok;
  if (hl) {
    const { age } = hl;
    const a = Math.max(0, 0.5 * (1 - age / DECAY));
    const ring = Math.max(0, 0.42 * (1 - age / DECAY));
    s.style.display = "inline-block";
    s.style.borderRadius = "4px";
    s.style.background = `rgba(63,148,80,${a.toFixed(3)})`;
    s.style.boxShadow = `0 0 0 2px rgba(63,148,80,${ring.toFixed(3)})`;
    if (age < 200) {
      const p = age / 200;
      s.style.transform = `translateY(${(-6 * (1 - p)).toFixed(1)}px) scale(${(0.94 + 0.06 * p).toFixed(3)})`;
    }
  }
  return s;
}

function renderTokens(container, tokens, { upto = tokens.length, changed = null, age = 0, caret = false } = {}) {
  container.textContent = "";
  const frag = document.createDocumentFragment();
  for (let i = 0; i < upto && i < tokens.length; i++) {
    const hl = changed && changed.has(i) ? { age } : null;
    frag.appendChild(tokSpan(tokens[i], hl));
  }
  if (caret) {
    const c = document.createElement("span");
    c.className = "stream-caret";
    frag.appendChild(c);
  }
  container.appendChild(frag);
}

function spinner(container) {
  container.textContent = "";
  const s = document.createElement("span");
  s.className = "gen-spinner gen-spinner-static";
  s.textContent = "Generating SQL";
  container.appendChild(s);
}

// ---- English transcript ----------------------------------------------------
function renderEnglish(curIdx, charsInCur) {
  english.textContent = "";
  for (let j = 0; j <= curIdx && j < steps.length; j++) {
    const line = document.createElement("span");
    line.className = "typed-line " + (j === 0 ? "lead" : "refine");
    let text = steps[j].refine;
    if (j === curIdx && charsInCur != null) text = text.slice(0, charsInCur);
    line.textContent = (j === 0 ? "" : "+ ") + text;
    english.appendChild(line);
    if (j === curIdx && charsInCur != null && charsInCur < steps[j].refine.length) {
      const c = document.createElement("span");
      c.className = "caret";
      english.appendChild(c);
    }
  }
}

// ---- the seek function -----------------------------------------------------
function seek(T) {
  T = Math.max(0, Math.min(T, DURATION));
  // find current segment
  let idx = tl.findIndex((s) => T < s.endAt);
  if (idx === -1) idx = tl.length - 1;
  const seg = tl[idx];

  // English
  if (T < seg.commit) {
    const chars = Math.max(0, Math.min(seg.refine.length, Math.floor((T - seg.start) / TYPE_MS)));
    renderEnglish(idx, chars);
  } else {
    renderEnglish(idx, null);
  }

  const r = T - seg.commit; // time since the model committed for this step
  const prevSeg = idx > 0 ? tl[idx - 1] : null;

  if (r < 0) {
    // still typing / gap — show the previous finished query, stable.
    paintFinal(prevSeg);
    return;
  }
  paintLeft(seg, r);
  paintRight(seg, r);
}

function paintFinal(prevSeg) {
  if (!prevSeg) {
    sqlLeft.textContent = ""; sqlRight.textContent = "";
    statLeft.textContent = ""; statRight.textContent = "";
    clockLeft.textContent = ""; clockRight.textContent = "";
    return;
  }
  renderTokens(sqlLeft, prevSeg.toks);
  renderTokens(sqlRight, prevSeg.toks);
  statLeft.innerHTML = stat(prevSeg);
  statRight.innerHTML = `<u>${prevSeg.nonws}</u> re-created`;
  clockLeft.textContent = clk(cfg.left.total, true);
  clockRight.textContent = clk(cfg.right.total, true);
}

function stat(seg) {
  if (seg.added === 0 && seg.kept === 0) return '<span class="hint">starting query</span>';
  const parts = [];
  if (seg.added) parts.push(`<i>+${seg.added}</i>`);
  parts.push(`<b>${seg.kept} pinned</b>`);
  return parts.join(" · ");
}

function paintLeft(seg, r) {
  const L = cfg.left;
  if (r < L.total) {
    // waiting: keep the prior query on screen (or "writing" for the first step)
    if (seg.prevToks.length) {
      renderTokens(sqlLeft, seg.prevToks);
      statLeft.innerHTML = '<span class="hint">updating in place…</span>';
    } else {
      spinner(sqlLeft);
      statLeft.innerHTML = '<span class="hint">writing query…</span>';
    }
    clockLeft.textContent = clk(r, false);
  } else {
    const age = r - L.total;
    renderTokens(sqlLeft, seg.toks, { changed: seg.changed, age });
    statLeft.innerHTML = stat(seg);
    clockLeft.textContent = clk(L.total, true);
  }
}

function paintRight(seg, r) {
  const R = cfg.right;
  if (r < R.ttft) {
    spinner(sqlRight);
    statRight.innerHTML = '<span class="hint">regenerating…</span>';
    clockRight.textContent = clk(r, false);
  } else if (r < R.total) {
    const frac = (r - R.ttft) / (R.total - R.ttft);
    const n = Math.max(1, Math.round(seg.toks.length * frac));
    renderTokens(sqlRight, seg.toks, { upto: n, caret: true });
    statRight.innerHTML = '<span class="hint">regenerating…</span>';
    clockRight.textContent = clk(r, false);
  } else {
    renderTokens(sqlRight, seg.toks);
    statRight.innerHTML = `<u>${seg.nonws}</u> re-created`;
    clockRight.textContent = clk(R.total, true);
  }
}

// ---- expose + autoplay -----------------------------------------------------
window.__seek = seek;
window.__filmDuration = DURATION;
window.__config = params.get("c") || "1";

seek(0);

if (!CAPTURE) {
  // real-time preview when opened in a normal browser
  const start = performance.now();
  function loop(now) {
    const T = now - start;
    seek(T % (DURATION + 600));
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}
