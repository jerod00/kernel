require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// One-time backfill for originalLanguage/productionCountries/runtimeMinutes
// — all three come straight off the same /movie/{id} details response
// onboard-film.js already fetches, just never captured before. Anchored on
// the overview: line, same proven pattern as backfill-metrics.js.

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

  // runtimeMinutes === undefined is the unambiguous "never processed"
  // marker (null is a legitimate "TMDb had no runtime" outcome).
  const candidates = Object.entries(films)
    .filter(([, f]) => f.runtimeMinutes === undefined)
    .map(([key, f]) => ({ key, name: f.name, year: f.year }));

  console.log(`Found ${candidates.length} film(s) missing origin/runtime data: ${candidates.map(c => c.key).join(", ")}`);

  let patched = 0, skipped = 0;
  for (const c of candidates) {
    try {
      console.log(`\n${c.key}: searching TMDb for "${c.name}" (${c.year})...`);
      const search = await tmdb(`/search/movie?query=${encodeURIComponent(c.name)}&year=${c.year}`);
      const match = search.results && search.results[0];
      if (!match) { console.log(`  No TMDb match — skipping.`); skipped++; continue; }
      const details = await tmdb(`/movie/${match.id}`);

      const originalLanguage = details.original_language || null;
      const productionCountries = (details.production_countries || []).map(cn => cn.name);
      const runtimeMinutes = typeof details.runtime === "number" && details.runtime > 0 ? details.runtime : null;
      console.log(`  language=${originalLanguage || "n/a"}, countries=${productionCountries.join(", ") || "n/a"}, runtime=${runtimeMinutes ?? "n/a"}`);

      const declRe = new RegExp(`\\r?\\n\\s*${c.key}:\\s*\\{`);
      const declMatch = html.match(declRe);
      if (!declMatch) { console.log(`  Could not find this entry's declaration line — skipping.`); skipped++; continue; }
      const braceIdx = declMatch.index + declMatch[0].length - 1;
      const { text: entryText } = extractBalanced(html, braceIdx);

      const overviewLineRe = /(\r?\n\s*overview: (?:null|"(?:[^"\\]|\\.)*"),\r?\n)/;
      const overviewMatch = entryText.match(overviewLineRe);
      if (!overviewMatch) { console.log(`  Could not find an overview: line to anchor the insert — skipping.`); skipped++; continue; }
      const usesCRLF = overviewMatch[0].includes("\r\n");
      const nl = usesCRLF ? "\r\n" : "\n";
      const fieldIndent = overviewMatch[0].match(/\r?\n(\s*)overview:/)[1];

      const lines = [
        `originalLanguage: ${originalLanguage ? JSON.stringify(originalLanguage) : "null"}`,
        `productionCountries: ${JSON.stringify(productionCountries)}`,
        `runtimeMinutes: ${runtimeMinutes != null ? runtimeMinutes : "null"}`,
      ];
      const insertBlock = lines.map(l => `${fieldIndent}${l},${nl}`).join("");
      const insertAt = braceIdx + overviewMatch.index + overviewMatch[0].length;
      html = html.slice(0, insertAt) + insertBlock + html.slice(insertAt);
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
