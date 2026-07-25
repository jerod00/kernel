require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// One-time backfill for the trailer field draft-lib.js's buildFilmsEntryText()
// silently dropped from every automated draft until this fix (see the
// draft-lib.js diff in the same commit as this file) — onboard-film.js always
// fetched trailer data, it just never made it into the widget entry. Fixes
// the pipeline going forward; this patches the films that already merged
// without one.

const TMDB_ACCESS_TOKEN = process.env.TMDB_ACCESS_TOKEN;
const TMDB_BASE = "https://api.themoviedb.org/3";
const WIDGET_PATH = path.join(__dirname, "..", "widget", "index.html");

if (!TMDB_ACCESS_TOKEN) {
  console.error("Set TMDB_ACCESS_TOKEN in kernel-data-service/.env first.");
  process.exit(1);
}

async function tmdb(pathName) {
  const res = await fetch(`${TMDB_BASE}${pathName}`, {
    headers: { Authorization: `Bearer ${TMDB_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`TMDb ${pathName} failed: ${res.status}`);
  return res.json();
}

// Same ranking as onboard-film.js's pickBestVideo — kept identical on
// purpose so a backfilled trailer is indistinguishable from one the normal
// pipeline would have picked.
function pickBestVideo(results) {
  const yt = (results || []).filter(v => v.site === "YouTube");
  const rank = v => (v.type === "Trailer" && v.official ? 0 : v.type === "Trailer" ? 1 : v.type === "Teaser" && v.official ? 2 : v.type === "Teaser" ? 3 : 9);
  yt.sort((a, b) => rank(a) - rank(b) || new Date(a.published_at) - new Date(b.published_at));
  return yt.find(v => rank(v) < 9) || null;
}

function extractBalanced(src, startIdx) {
  const stack = [];
  let mode = null;
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i], prev = src[i - 1];
    if (mode === "line") { if (c === "\n") mode = null; continue; }
    if (mode === "block") { if (prev === "*" && c === "/") mode = null; continue; }
    if (mode === "single") { if (c === "'" && prev !== "\\") mode = null; continue; }
    if (mode === "double") { if (c === '"' && prev !== "\\") mode = null; continue; }
    if (mode === "template") {
      if (c === "`" && prev !== "\\") { mode = null; continue; }
      if (c === "{" && prev === "$") { stack.push("tpl"); mode = null; continue; }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { mode = "line"; continue; }
    if (c === "/" && src[i + 1] === "*") { mode = "block"; continue; }
    if (c === "'") { mode = "single"; continue; }
    if (c === '"') { mode = "double"; continue; }
    if (c === "`") { mode = "template"; continue; }
    if (c === "{" || c === "[") { stack.push("brace"); continue; }
    if (c === "}" || c === "]") {
      const top = stack.pop();
      if (top === "tpl") { mode = "template"; continue; }
      if (stack.length === 0) return { text: src.slice(startIdx, i + 1), end: i + 1 };
      continue;
    }
  }
  throw new Error("Unterminated literal — reached end of file while scanning");
}

function assertWidgetScriptParses(html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("Could not find <script> block to validate — aborting, refusing to write.");
  new vm.Script(match[1], { filename: "widget-script-check.js" });
}

(async () => {
  let html = fs.readFileSync(WIDGET_PATH, "utf8");

  // Find every top-level FILMS entry missing a trailer field.
  const entryRe = /^ {4}(\w+): \{/gm;
  const candidates = [];
  let m;
  while ((m = entryRe.exec(html))) {
    const key = m[1];
    const braceIdx = html.indexOf("{", m.index);
    const { text, end } = extractBalanced(html, braceIdx);
    if (!/trailer:/.test(text)) {
      const nameMatch = text.match(/name:\s*"((?:[^"\\]|\\.)*)"/);
      const yearMatch = text.match(/year:\s*"?(\d{4})"?/);
      if (nameMatch && yearMatch) {
        candidates.push({ key, name: nameMatch[1].replace(/\\"/g, '"'), year: yearMatch[1], blockEnd: end });
      }
    }
  }

  console.log(`Found ${candidates.length} film(s) missing a trailer field: ${candidates.map(c => c.key).join(", ")}`);

  // Patch furthest-in-the-file first so earlier insertions don't shift the
  // string offsets already recorded for later ones.
  candidates.sort((a, b) => b.blockEnd - a.blockEnd);

  let patched = 0, skipped = 0;
  for (const c of candidates) {
    try {
      console.log(`\n${c.key}: searching TMDb for "${c.name}" (${c.year})...`);
      const search = await tmdb(`/search/movie?query=${encodeURIComponent(c.name)}&year=${c.year}`);
      const match = search.results && search.results[0];
      if (!match) { console.log(`  No TMDb match — skipping.`); skipped++; continue; }
      const videosRes = await tmdb(`/movie/${match.id}/videos?language=en-US`);
      const best = pickBestVideo(videosRes.results);
      if (!best) { console.log(`  No usable YouTube trailer/teaser on TMDb — skipping.`); skipped++; continue; }
      console.log(`  Found: "${best.name}" (${best.type}) — https://www.youtube.com/watch?v=${best.key}`);

      const posterLineRe = /(\r?\n {6}poster: [^\r\n]*,\r?\n)/;
      const before = html.slice(0, c.blockEnd);
      const entryStart = before.lastIndexOf(`\n    ${c.key}: {`);
      const entryText = html.slice(entryStart, c.blockEnd);
      const posterMatch = entryText.match(posterLineRe);
      if (!posterMatch) { console.log(`  Could not find a poster: line to anchor the insert — skipping.`); skipped++; continue; }
      const usesCRLF = posterMatch[0].includes("\r\n");
      const trailerLine = `      trailer: ${JSON.stringify({ key: best.key, name: best.name, type: best.type })},${usesCRLF ? "\r\n" : "\n"}`;
      const insertAt = entryStart + posterMatch.index + posterMatch[0].length;
      html = html.slice(0, insertAt) + trailerLine + html.slice(insertAt);
      patched++;
    } catch (err) {
      console.log(`  Error: ${err.message} — skipping.`);
      skipped++;
    }
  }

  assertWidgetScriptParses(html);
  fs.writeFileSync(WIDGET_PATH, html);
  console.log(`\nDone. Patched ${patched}, skipped ${skipped}.`);
})();
