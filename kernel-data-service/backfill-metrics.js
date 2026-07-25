require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// One-time backfill for the five fields added after every existing film was
// already onboarded: rottenTomatoes, awards (both OMDb), keywords, watch
// providers, and collection (all TMDb). Combined into one script since they
// all come from the same per-film TMDb/OMDb lookups — no point re-searching
// TMDb five separate times per film. Anchored on the overview: line, same
// proven-correct pattern as backfill-popularity.js (loadFilms() for
// candidate detection + real data, braceIdx-based offsets for insertion,
// dry-run verified before ever touching the real file).

const TMDB_ACCESS_TOKEN = process.env.TMDB_ACCESS_TOKEN;
const OMDB_API_KEY = process.env.OMDB_API_KEY;
const TMDB_BASE = "https://api.themoviedb.org/3";
const OMDB_BASE = "https://www.omdbapi.com";
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

async function omdbLookup({ imdbId, title, year }) {
  if (!OMDB_API_KEY) return null;
  const params = new URLSearchParams({ apikey: OMDB_API_KEY });
  if (imdbId) params.set("i", imdbId);
  else { params.set("t", title); if (year) params.set("y", year); }
  const res = await fetch(`${OMDB_BASE}/?${params}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.Response === "False" ? null : data;
}

function extractRottenTomatoes(omdb) {
  if (!omdb || !Array.isArray(omdb.Ratings)) return null;
  const rt = omdb.Ratings.find(r => r.Source === "Rotten Tomatoes");
  if (!rt || !rt.Value) return null;
  const n = Number(rt.Value.replace("%", ""));
  return Number.isFinite(n) ? n : null;
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

  // f.keywords === undefined is the only unambiguous "never processed"
  // marker — rottenTomatoes/awards/collectionId can legitimately be null
  // even after a successful fetch, but every processed film always gets a
  // keywords array (possibly empty) written.
  const candidates = Object.entries(films)
    .filter(([, f]) => f.keywords === undefined)
    .map(([key, f]) => ({ key, name: f.name, year: f.year }));

  console.log(`Found ${candidates.length} film(s) missing the new fields: ${candidates.map(c => c.key).join(", ")}`);

  let patched = 0, skipped = 0;
  for (const c of candidates) {
    try {
      console.log(`\n${c.key}: searching TMDb for "${c.name}" (${c.year})...`);
      const search = await tmdb(`/search/movie?query=${encodeURIComponent(c.name)}&year=${c.year}`);
      const match = search.results && search.results[0];
      if (!match) { console.log(`  No TMDb match — skipping.`); skipped++; continue; }

      const [details, externalIds, keywordsRes, providersRes] = await Promise.all([
        tmdb(`/movie/${match.id}`),
        tmdb(`/movie/${match.id}/external_ids`),
        tmdb(`/movie/${match.id}/keywords`).catch(() => ({ keywords: [] })),
        tmdb(`/movie/${match.id}/watch/providers`).catch(() => ({ results: {} })),
      ]);
      const omdb = await omdbLookup({ imdbId: externalIds.imdb_id });

      const rottenTomatoes = extractRottenTomatoes(omdb);
      const awards = omdb && omdb.Awards && omdb.Awards !== "N/A" ? omdb.Awards : null;
      const keywords = (keywordsRes.keywords || []).map(k => k.name).slice(0, 10);
      const us = providersRes.results && providersRes.results.US;
      const watchProviders = us
        ? {
            flatrate: (us.flatrate || []).map(p => p.provider_name),
            rent: (us.rent || []).map(p => p.provider_name),
            buy: (us.buy || []).map(p => p.provider_name),
          }
        : null;
      const collectionId = details.belongs_to_collection ? details.belongs_to_collection.id : null;
      const collectionName = details.belongs_to_collection ? details.belongs_to_collection.name : null;

      console.log(`  RT=${rottenTomatoes ?? "n/a"}, awards=${awards ? "yes" : "no"}, keywords=${keywords.length}, watchProviders=${watchProviders ? "yes" : "no"}, collection=${collectionName || "none"}`);

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
        `rottenTomatoes: ${rottenTomatoes != null ? rottenTomatoes : "null"}`,
        `awards: ${awards ? JSON.stringify(awards) : "null"}`,
        `keywords: ${JSON.stringify(keywords)}`,
        `watchProviders: ${watchProviders ? JSON.stringify(watchProviders) : "null"}`,
        `collectionId: ${collectionId != null ? collectionId : "null"}`,
        `collectionName: ${collectionName ? JSON.stringify(collectionName) : "null"}`,
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
