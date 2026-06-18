// Token-level diff + DOM patch. The point: when the SQL changes, reuse the DOM
// nodes for tokens that did not change so they never move or flash. Only new
// tokens animate in, only removed tokens animate out. That stability is what a
// diffusion model's in-place infill buys you, reproduced here at the view layer.

const KEYWORDS = new Set([
  "select", "from", "where", "group", "by", "order", "having", "limit",
  "and", "or", "not", "as", "on", "join", "left", "right", "inner", "outer",
  "desc", "asc", "distinct", "in", "between", "like", "is", "null", "case",
  "when", "then", "else", "end", "union", "all", "with",
]);
const FUNCS = new Set([
  "sum", "count", "avg", "min", "max", "round", "coalesce", "date_trunc",
  "now", "cast", "extract", "abs",
]);

// Split into tokens, keeping whitespace as its own tokens so layout survives.
export function tokenize(sql) {
  const re = /\s+|'[^']*'|[A-Za-z_][A-Za-z0-9_.]*|\d+(?:\.\d+)?|[^\sA-Za-z0-9_]/g;
  const out = [];
  let m;
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

// Longest common subsequence over token strings. Returns matched index pairs
// [iOld, iNew] in order, so we know which old nodes to reuse for which new
// tokens.
function lcsPairs(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

function makeNode(tok) {
  const cls = classify(tok);
  if (cls === "ws") {
    // whitespace carried as a span too, so node identity stays 1:1 with tokens
    const s = document.createElement("span");
    s.className = "tok t-ws";
    s.textContent = tok;
    s.dataset.tok = tok;
    return s;
  }
  const s = document.createElement("span");
  s.className = `tok t-${cls}`;
  s.textContent = tok;
  s.dataset.tok = tok;
  return s;
}

// Patch `container` to display `newTokens`, reusing nodes for matched tokens.
// SQL edits are monotonic, so reused (kept) nodes never change relative order:
// we leave them untouched, insert new tokens against the next kept node as an
// anchor, and let removed tokens fade out in place. Nothing jumps.
// Returns {added, removed, kept} counts for the stat line.
export function patchInPlace(container, prevTokens, newTokens, animate = true) {
  const oldNodes = Array.from(container.children);
  const pairs = lcsPairs(prevTokens, newTokens);

  const reuseForNew = new Map(); // newIdx -> oldNode
  const matchedOld = new Set();
  for (const [io, jn] of pairs) {
    reuseForNew.set(jn, oldNodes[io]);
    matchedOld.add(io);
  }

  // Build the desired node for each new token (reused node or a fresh one).
  const desired = newTokens.map((tok, j) => {
    const reuse = reuseForNew.get(j);
    if (reuse) {
      reuse.classList.remove("enter", "exit", "settle");
      reuse._isNew = false;
      return reuse;
    }
    const node = makeNode(tok);
    node._isNew = true;
    return node;
  });

  // Remove tokens that are gone — animate out where they sit, then drop.
  let removed = 0;
  oldNodes.forEach((node, i) => {
    if (matchedOld.has(i)) return;
    if (classify(node.dataset.tok || "") !== "ws") removed++;
    if (animate && (node.dataset.tok || "").trim() !== "") {
      node.classList.add("exit");
      node.addEventListener("animationend", () => node.remove(), { once: true });
    } else {
      node.remove();
    }
  });

  // Insert the new tokens. Anchor each on the next kept node so order is exact.
  let added = 0, kept = 0;
  desired.forEach((node, j) => {
    if (!node._isNew) { kept++; return; }
    let anchor = null;
    for (let k = j + 1; k < desired.length; k++) {
      if (!desired[k]._isNew) { anchor = desired[k]; break; }
    }
    container.insertBefore(node, anchor); // null anchor => append at end
    if (classify(node.dataset.tok || "") !== "ws") {
      added++;
      if (animate) {
        node.classList.add("enter");
        node.addEventListener("animationend", () => {
          node.classList.remove("enter");
          node.classList.add("settle");
        }, { once: true });
      }
    }
  });

  return { added, removed, kept };
}

// Static build, no animation. Used to prime the panels.
export function renderWhole(container, tokens) {
  container.textContent = "";
  const frag = document.createDocumentFragment();
  for (const tok of tokens) frag.appendChild(makeNode(tok));
  container.appendChild(frag);
}

// Both panels pay the same generation wait — model latency is common-mode. The
// spinner represents that wait. The same spinner appears on the left while it
// keeps the prior query on screen, and on the right while it blanks to rebuild.
let streamId = 0;
export function cancelStream() { streamId++; }

export function showSpinner(container, label = "Generating SQL") {
  container.textContent = "";
  const s = document.createElement("span");
  s.className = "gen-spinner";
  s.textContent = label;
  container.appendChild(s);
}

// Stream a query in token by token, the way a chat tool displays a fresh
// response. Streaming is a display choice, not a model cost — the cost is the
// generation wait above. Returns a promise that resolves when the stream ends.
export function streamTokens(container, tokens, tokDelay) {
  const myId = ++streamId;
  container.textContent = "";
  const caret = document.createElement("span");
  caret.className = "stream-caret";
  container.appendChild(caret);
  return new Promise((resolve) => {
    let i = 0;
    const tick = () => {
      if (myId !== streamId) return resolve();
      if (i >= tokens.length) {
        caret.remove();
        return resolve();
      }
      container.insertBefore(makeNode(tokens[i]), caret);
      i++;
      setTimeout(tick, tokDelay * (0.5 + Math.random()));
    };
    tick();
  });
}
