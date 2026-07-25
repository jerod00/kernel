require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");

// One-time (and reusable) backfill for cold-start seed content on films the
// automated pipeline drafted before ingestSeedContent() existed in
// draft-lib.js — see that file's comment for why the pipeline couldn't push
// this to production at all until the new /admin/api/ingest-seed-content
// endpoint existed. Finds every FILMS entry with no seed_content in
// production (by comparing against the live entity list) and backfills it.

const TMDB_ACCESS_TOKEN = process.env.TMDB_ACCESS_TOKEN;
const OMDB_API_KEY = process.env.OMDB_API_KEY;
const PIPELINE_INGEST_TOKEN = process.env.PIPELINE_INGEST_TOKEN;
const DATA_SERVICE_URL = process.env.DATA_SERVICE_URL || "https://kernel-data-service-themoviekernel.fly.dev";
const TMDB_BASE = "https://api.themoviedb.org/3";
const OMDB_BASE = "https://www.omdbapi.com";
const WIDGET_PATH = path.join(__dirname, "..", "widget", "index.html");

if (!TMDB_ACCESS_TOKEN) { console.error("Set TMDB_ACCESS_TOKEN first."); process.exit(1); }
if (!PIPELINE_INGEST_TOKEN) { console.error("Set PIPELINE_INGEST_TOKEN first."); process.exit(1); }

async function tmdb(pathName) {
  const res = await fetch(`${TMDB_BASE}${pathName}`, { headers: { Authorization: `Bearer ${TMDB_ACCESS_TOKEN}` } });
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

// Identical to onboard-film.js's excerpt() — full review text must never
// leave this script, only a short excerpt + a link back to the original.
function excerpt(text, maxLen) {
  if (!text || text.length <= maxLen) return text || "";
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim() + "…";
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
      if (stack.length === 0) return src.slice(startIdx, i + 1);
      continue;
    }
  }
  throw new Error("Unterminated literal");
}

function loadFilms(html) {
  const marker = "const FILMS = ";
  const declIdx = html.indexOf(marker);
  const braceIdx = declIdx + marker.length;
  const literalText = extractBalanced(html, braceIdx);
  return new Function(`"use strict"; return (${literalText});`)();
}

(async () => {
  const html = fs.readFileSync(WIDGET_PATH, "utf8");
  const films = loadFilms(html);

  const entitiesRes = await fetch(`${DATA_SERVICE_URL}/api/entities`);
  const entities = await entitiesRes.json();
  const haveSeedContent = new Set(entities.filter(e => e.entity_type === "seed_content").map(e => e.entity_id));

  const missing = Object.entries(films).filter(([, f]) => !haveSeedContent.has(f.dataId));
  console.log(`${Object.keys(films).length} films total, ${haveSeedContent.size} already have seed content, ${missing.length} missing: ${missing.map(([k]) => k).join(", ")}`);

  let done = 0, skipped = 0;
  for (const [key, f] of missing) {
    console.log(`\n${key}: searching TMDb for "${f.name}" (${f.year})...`);
    try {
      const search = await tmdb(`/search/movie?query=${encodeURIComponent(f.name)}&year=${f.year}`);
      const match = search.results && search.results[0];
      if (!match) { console.log("  No TMDb match — skipping."); skipped++; continue; }

      const externalIds = await tmdb(`/movie/${match.id}/external_ids`);
      const omdb = await omdbLookup({ imdbId: externalIds.imdb_id });

      let seedScore = null, seedScoreUrl = null;
      if (omdb && omdb.imdbRating && omdb.imdbRating !== "N/A" && externalIds.imdb_id) {
        seedScore = Math.round(Number(omdb.imdbRating) * 10);
        seedScoreUrl = `https://www.imdb.com/title/${externalIds.imdb_id}/`;
      }

      const reviewsRes = await tmdb(`/movie/${match.id}/reviews?language=en-US`);
      const seedReviews = (reviewsRes.results || []).slice(0, 3).map(r => ({
        author: r.author,
        content: excerpt(r.content, 280),
        url: r.url,
      }));

      if (seedScore == null && !seedReviews.length) {
        console.log("  Nothing to seed (no IMDb rating, no TMDb reviews) — skipping.");
        skipped++;
        continue;
      }

      console.log(`  seedScore=${seedScore ?? "n/a"}, seedReviews=${seedReviews.length}`);
      const res = await fetch(`${DATA_SERVICE_URL}/admin/api/ingest-seed-content`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-ingest-token": PIPELINE_INGEST_TOKEN },
        body: JSON.stringify({ filmId: f.dataId, seedScore, seedScoreUrl, seedReviews }),
      });
      if (!res.ok) {
        console.log(`  Ingest failed: ${res.status} ${await res.text()}`);
        skipped++;
        continue;
      }
      const result = await res.json();
      console.log(`  Ingested ${result.ingested} fact(s) for ${f.dataId}.`);
      done++;
    } catch (err) {
      console.log(`  Error: ${err.message} — skipping.`);
      skipped++;
    }
  }

  console.log(`\nDone. Backfilled ${done}, skipped ${skipped}.`);
})();
