require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// One-time backfill for the overview (plot synopsis) field added to
// onboard-film.js/draft-lib.js after every existing film was already
// onboarded — every film in the catalog is missing it until this runs once.

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

// Same technique as scripts/build-seo-pages.js: evaluate the FILMS object
// literal directly rather than regex-matching entry text. Deliberately NOT
// relying on consistent indentation to find/bound entries — a real bug hit
// here the first time: some entries (a batch onboarded much earlier this
// project, apparently pasted in with inconsistent formatting) use 0 or 2
// spaces instead of the usual 4/6, so a fixed-width /^ {4}(\w+): \{/ regex
// silently missed 31 of 76 films with no error, and a bare /name:\s*"..."/
// search matched a nested trailer object's own "name" key instead of the
// film's when trailer happened to appear earlier in the entry. Using the
// real evaluated object for name/year sidesteps both problems entirely.
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
    .filter(([, f]) => !f.overview)
    .map(([key, f]) => ({ key, name: f.name, year: f.year }));

  console.log(`Found ${candidates.length} film(s) missing overview: ${candidates.map(c => c.key).join(", ")}`);

  let patched = 0, skipped = 0;
  for (const c of candidates) {
    try {
      console.log(`\n${c.key}: searching TMDb for "${c.name}" (${c.year})...`);
      const search = await tmdb(`/search/movie?query=${encodeURIComponent(c.name)}&year=${c.year}`);
      const match = search.results && search.results[0];
      if (!match) { console.log(`  No TMDb match — skipping.`); skipped++; continue; }
      const details = await tmdb(`/movie/${match.id}`);
      if (!details.overview) { console.log(`  No overview on TMDb — skipping.`); skipped++; continue; }
      console.log(`  Found: "${details.overview.slice(0, 70)}..."`);

      // Not anchored to a fixed indentation width — just "this key's own
      // declaration line", found by requiring the colon+brace immediately
      // after the key name (so "avatar:" can't match inside
      // "avatarAangTheLastAirbender:", which has no colon right after
      // "avatar"), whatever whitespace precedes or follows it.
      const declRe = new RegExp(`\\r?\\n\\s*${c.key}:\\s*\\{`);
      const declMatch = html.match(declRe);
      if (!declMatch) { console.log(`  Could not find this entry's declaration line — skipping.`); skipped++; continue; }
      const braceIdx = declMatch.index + declMatch[0].length - 1;
      const { text: entryText, end: blockEnd } = extractBalanced(html, braceIdx);

      const genresLineRe = /(\r?\n\s*genres: \[[^\r\n]*\],\r?\n)/;
      const genresMatch = entryText.match(genresLineRe);
      if (!genresMatch) { console.log(`  Could not find a genres: line to anchor the insert — skipping.`); skipped++; continue; }
      const usesCRLF = genresMatch[0].includes("\r\n");
      // Matches this entry's own field indentation rather than a hardcoded
      // width, so the inserted line doesn't stick out in an already
      // inconsistently-indented entry any worse than it already is.
      const fieldIndent = genresMatch[0].match(/\r?\n(\s*)genres:/)[1];
      const overviewLine = `${fieldIndent}overview: ${JSON.stringify(details.overview)},${usesCRLF ? "\r\n" : "\n"}`;
      // entryText (and therefore genresMatch.index) is measured from
      // braceIdx, not declMatch.index — those differ by the length of
      // "\r\n<key>: " (~15-25 chars). Using declMatch.index here once
      // undershot the real position by exactly that gap and spliced the
      // new field into the middle of the genres array instead of after
      // it — caught by assertWidgetScriptParses before anything was
      // written to disk, not by luck.
      const insertAt = braceIdx + genresMatch.index + genresMatch[0].length;
      html = html.slice(0, insertAt) + overviewLine + html.slice(insertAt);
      patched++;
      void blockEnd; // only needed to compute entryText's extent above
    } catch (err) {
      console.log(`  Error: ${err.message} — skipping.`);
      skipped++;
    }
  }

  assertWidgetScriptParses(html);
  fs.writeFileSync(WIDGET_PATH, html);
  console.log(`\nDone. Patched ${patched}, skipped ${skipped}.`);
})();
