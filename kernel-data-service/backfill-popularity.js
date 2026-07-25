require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// One-time backfill for the popularity field added to
// onboard-film.js/draft-lib.js after every existing film was already
// onboarded. Anchors insertion on the overview: line (every film now has
// one, backfilled in the previous pass) rather than genres — see
// backfill-overview.js's comments for why this uses loadFilms() instead of
// per-entry regex scanning, and why the insertion offset is measured from
// braceIdx rather than the declaration match's own start.

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

function loadFilms(html) {
  const marker = "const FILMS = ";
  const declIdx = html.indexOf(marker);
  const braceIdx = declIdx + marker.length;
  const literalText = extractBalanced(html, braceIdx);
  return new Function(`"use strict"; return (${literalText.text});`)();
}

function assertWidgetScriptParses(html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("Could not find <script> block to validate — aborting, refusing to write.");
  new vm.Script(match[1], { filename: "widget-script-check.js" });
}

(async () => {
  let html = fs.readFileSync(WIDGET_PATH, "utf8");
  const films = loadFilms(html);

  const candidates = Object.entries(films)
    .filter(([, f]) => f.popularity == null)
    .map(([key, f]) => ({ key, name: f.name, year: f.year }));

  console.log(`Found ${candidates.length} film(s) missing popularity: ${candidates.map(c => c.key).join(", ")}`);

  let patched = 0, skipped = 0;
  for (const c of candidates) {
    try {
      console.log(`\n${c.key}: searching TMDb for "${c.name}" (${c.year})...`);
      const search = await tmdb(`/search/movie?query=${encodeURIComponent(c.name)}&year=${c.year}`);
      const match = search.results && search.results[0];
      if (!match) { console.log(`  No TMDb match — skipping.`); skipped++; continue; }
      const details = await tmdb(`/movie/${match.id}`);
      if (typeof details.popularity !== "number") { console.log(`  No popularity value on TMDb — skipping.`); skipped++; continue; }
      console.log(`  Found: popularity=${details.popularity}`);

      const declRe = new RegExp(`\\r?\\n\\s*${c.key}:\\s*\\{`);
      const declMatch = html.match(declRe);
      if (!declMatch) { console.log(`  Could not find this entry's declaration line — skipping.`); skipped++; continue; }
      const braceIdx = declMatch.index + declMatch[0].length - 1;
      const { text: entryText } = extractBalanced(html, braceIdx);

      const overviewLineRe = /(\r?\n\s*overview: "(?:[^"\\]|\\.)*",\r?\n)/;
      const overviewMatch = entryText.match(overviewLineRe);
      if (!overviewMatch) { console.log(`  Could not find an overview: line to anchor the insert — skipping.`); skipped++; continue; }
      const usesCRLF = overviewMatch[0].includes("\r\n");
      const fieldIndent = overviewMatch[0].match(/\r?\n(\s*)overview:/)[1];
      const popularityLine = `${fieldIndent}popularity: ${details.popularity},${usesCRLF ? "\r\n" : "\n"}`;
      const insertAt = braceIdx + overviewMatch.index + overviewMatch[0].length;
      html = html.slice(0, insertAt) + popularityLine + html.slice(insertAt);
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
