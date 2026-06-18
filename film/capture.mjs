// Recreate the three comparison GIFs deterministically.
//
// Film mode (film.html + src/film.js) animates each side at its REAL measured
// median latency from a virtual clock, so capture is reproducible with no
// background-tab throttling. This script drives that clock frame by frame with
// Playwright, screenshots each frame, then assembles a GIF with ffmpeg.
//
// Prereqs:
//   - the dev server running:   npm start         (in another terminal)
//   - Google Chrome installed
//   - ffmpeg on PATH
//   - npm i playwright-core      (drives the installed Chrome, no download)
//
// Run from the repo root:
//   node film/capture.mjs                 # all three GIFs -> assets/
//   CONFIGS=1 FPS=15 node film/capture.mjs # just the first

import { chromium } from "playwright-core";
import { mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const FPS = Number(process.env.FPS || 15);
const CONFIGS = (process.env.CONFIGS || "1,2,3").split(",");
const BASE = process.env.BASE || "http://localhost:3000/film.html";
const WIDTH = Number(process.env.WIDTH || 820);
const DSF = 2;

const NAMES = {
  "1": "living-query-1-fast-vs-typical",
  "2": "living-query-2-claude-fast-vs-typical",
  "3": "living-query-3-frontier-vs-typical",
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1080, height: 760 }, deviceScaleFactor: DSF });
const page = await ctx.newPage();

for (const c of CONFIGS) {
  const dir = `film/frames/c${c}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  await page.goto(`${BASE}?c=${c}&cap=1`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const dur = await page.evaluate(() => window.__filmDuration);
  const stage = page.locator("#stage");

  const dt = 1000 / FPS;
  const nFrames = Math.ceil(dur / dt) + 1;
  console.log(`config ${c}: ${Math.round(dur)}ms, ${nFrames} frames @ ${FPS}fps`);

  for (let f = 0; f < nFrames; f++) {
    const T = Math.min(f * dt, dur);
    await page.evaluate((t) => window.__seek(t), T);
    await stage.screenshot({ path: `${dir}/f${String(f).padStart(4, "0")}.png` });
  }

  // assemble GIF: build an optimized palette, then apply it
  mkdirSync("assets", { recursive: true });
  const pal = `${dir}/palette.png`;
  const gif = `assets/${NAMES[c] || "living-query-" + c}.gif`;
  const scale = `scale=${WIDTH}:-1:flags=lanczos`;
  execFileSync("ffmpeg", ["-y", "-framerate", String(FPS), "-i", `${dir}/f%04d.png`,
    "-vf", `${scale},palettegen=max_colors=128:stats_mode=diff`, pal], { stdio: "ignore" });
  execFileSync("ffmpeg", ["-y", "-framerate", String(FPS), "-i", `${dir}/f%04d.png`, "-i", pal,
    "-lavfi", `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`, gif], { stdio: "ignore" });
  console.log(`config ${c}: wrote ${gif}`);
}

await browser.close();
console.log("ALL DONE");
