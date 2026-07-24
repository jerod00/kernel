require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { slugify } = require("./slugify");

// Keeps the landing page's "Now Playing" gallery current:
//   1. Any film currently flagged nowPlaying: true that TMDb no longer lists
//      as playing gets flipped to nowPlaying: false — purely mechanical, no
//      editorial judgment, safe to commit automatically.
//   2. Any prominent new release TMDb lists that isn't onboarded at all yet
//      is reported (title/year/TMDb link) so a human can run the normal
//      onboard-film.js -> Tier 2 research -> ingest-film.js flow — Tier 2
//      fields have no free API and still need a person, same as ever.
//
// Usage: node refresh-now-playing.js
// Writes GITHUB_OUTPUT keys `removed` and `new-films` for the CI workflow to
// use when deciding whether to commit / open an issue.

const TMDB_ACCESS_TOKEN = process.env.TMDB_ACCESS_TOKEN;
const TMDB_BASE = "https://api.themoviedb.org/3";
const WIDGET_PATH = path.join(__dirname, "..", "widget", "index.html");
const NEW_FILM_ALERT_CAP = 10; // top N by TMDb's own now_playing ordering — avoids flooding an issue with minor/limited releases
const AUTO_DRAFT_CAP = 3; // of those, how many get the full AI-drafting + PR treatment per run — bounds API cost and PR review burden

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

async function fetchNowPlaying(pageCount) {
  const results = [];
  for (let page = 1; page <= pageCount; page++) {
    const data = await tmdb(`/movie/now_playing?region=US&page=${page}`);
    results.push(...data.results);
    if (page >= data.total_pages) break;
  }
  return results;
}

function writeGithubOutput(key, value) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) return; // running locally, not in CI — nothing to write to
  fs.appendFileSync(outPath, `${key}<<EOF\n${value}\nEOF\n`);
}

(async () => {
  // Fetch a few pages so a currently-tracked film isn't prematurely retired
  // just for slipping a few slots in TMDb's ordering — this is the "is it
  // still playing anywhere" check, deliberately broader than the alert cap.
  console.log("Fetching TMDb now_playing (region=US)...");
  const nowPlaying = await fetchNowPlaying(3);
  const nowPlayingWithIds = nowPlaying.map(m => ({
    ...m,
    dataId: slugify(m.title, (m.release_date || "").slice(0, 4)),
  }));
  const currentDataIds = new Set(nowPlayingWithIds.map(m => m.dataId));
  console.log(`TMDb reports ${currentDataIds.size} films currently playing (across ${Math.ceil(nowPlaying.length / 20)} page(s)).`);

  const html = fs.readFileSync(WIDGET_PATH, "utf8");
  const dataIdMatches = [...html.matchAll(/dataId:\s*"([^"]+)"/g)];
  const existingDataIds = new Set(dataIdMatches.map(m => m[1]));

  // --- Step 1: retire films no longer in theaters ---
  let updatedHtml = html;
  const removedTitles = [];
  for (const { 1: dataId } of dataIdMatches) {
    const flagPattern = new RegExp(`(dataId:\\s*"${dataId}",\\s*\\n\\s*nowPlaying:\\s*)true`);
    if (flagPattern.test(updatedHtml) && !currentDataIds.has(dataId)) {
      updatedHtml = updatedHtml.replace(flagPattern, "$1false");
      removedTitles.push(dataId);
    }
  }

  if (removedTitles.length) {
    fs.writeFileSync(WIDGET_PATH, updatedHtml);
    console.log(`Flipped nowPlaying: false for ${removedTitles.length} film(s) no longer in theaters: ${removedTitles.join(", ")}`);
  } else {
    console.log("No films to remove from Now Playing.");
  }

  // --- Step 2: flag prominent new releases not onboarded at all yet ---
  const newFilms = nowPlayingWithIds
    .filter(m => !existingDataIds.has(m.dataId))
    .slice(0, NEW_FILM_ALERT_CAP);

  if (newFilms.length) {
    console.log(`${newFilms.length} new film(s) to consider onboarding:`);
    for (const m of newFilms) {
      console.log(`  - ${m.title} (${(m.release_date || "").slice(0, 4)}) — https://www.themoviedb.org/movie/${m.id}`);
    }
  } else {
    console.log("No new films to onboard.");
  }

  const toAutoDraft = newFilms.slice(0, AUTO_DRAFT_CAP).map(m => ({
    title: m.title,
    year: (m.release_date || "").slice(0, 4),
  }));
  // Films beyond the auto-draft cap still get listed in the issue, just
  // without a PR — same manual "run onboard-film.js yourself" path as today.
  const remainder = newFilms.slice(AUTO_DRAFT_CAP);

  writeGithubOutput("removed", removedTitles.join(", "));
  writeGithubOutput("new-films-json", JSON.stringify(toAutoDraft));
  writeGithubOutput(
    "new-films",
    remainder.map(m => `- **${m.title}** (${(m.release_date || "").slice(0, 4)}) — https://www.themoviedb.org/movie/${m.id}\n  \`node onboard-film.js "${m.title.replace(/"/g, '\\"')}" ${(m.release_date || "").slice(0, 4)}\``).join("\n")
  );
})().catch(err => {
  console.error("Failed:", err.message);
  process.exit(1);
});
