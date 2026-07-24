require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { slugify } = require("./slugify");

// Keeps the landing page's "Now Playing" gallery and "New, but not in
// theaters" slider current:
//   1. Any film currently flagged nowPlaying: true that TMDb no longer lists
//      as playing gets flipped to nowPlaying: false — purely mechanical, no
//      editorial judgment, safe to commit automatically.
//   2. Any prominent new theatrical release TMDb lists that isn't onboarded
//      at all yet is reported (title/year/TMDb link) so a human can run the
//      normal onboard-film.js -> Tier 2 research -> ingest-film.js flow —
//      Tier 2 fields have no free API and still need a person, same as ever.
//   3. Same as #2, but for recent (last 90 days) releases that never showed
//      in theaters at all or already left — the site's own "recent, not in
//      theaters" window (RECENT_RELEASE_WINDOW_MS in the widget), so nothing
//      recent slips through just because it skipped/finished its theatrical
//      run before this job ever noticed it.
//
// Usage: node refresh-now-playing.js
// Writes GITHUB_OUTPUT keys `removed`, `new-films-json` (auto-draft
// candidates, each tagged category:"theatrical"|"recent"), and `new-films`
// (the remainder, for the manual-onboarding issue) for the CI workflow.

const TMDB_ACCESS_TOKEN = process.env.TMDB_ACCESS_TOKEN;
const TMDB_BASE = "https://api.themoviedb.org/3";
const WIDGET_PATH = path.join(__dirname, "..", "widget", "index.html");
const NEW_FILM_ALERT_CAP = 10; // top N by TMDb's own ordering, per category — avoids flooding an issue with minor/limited releases
const AUTO_DRAFT_CAP = 3; // theatrical films auto-drafted into a PR per run — bounds API cost and PR review burden
const RECENT_AUTO_DRAFT_CAP = 3; // same, for recent non-theatrical releases
const RECENT_WINDOW_DAYS = 90; // matches RECENT_RELEASE_WINDOW_MS in widget/index.html
const RECENT_MIN_VOTE_COUNT = 20; // floor to avoid drafting obscure straight-to-VOD titles nobody's heard of

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

async function fetchRecentReleases(pageCount) {
  const today = new Date().toISOString().slice(0, 10);
  const windowStart = new Date(Date.now() - RECENT_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const results = [];
  for (let page = 1; page <= pageCount; page++) {
    const data = await tmdb(
      `/discover/movie?region=US&sort_by=popularity.desc&primary_release_date.gte=${windowStart}&primary_release_date.lte=${today}&vote_count.gte=${RECENT_MIN_VOTE_COUNT}&page=${page}`
    );
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

  console.log(`Fetching TMDb recent releases (last ${RECENT_WINDOW_DAYS} days, region=US)...`);
  const recentRaw = await fetchRecentReleases(2);
  const recentWithIds = recentRaw
    .map(m => ({ ...m, dataId: slugify(m.title, (m.release_date || "").slice(0, 4)) }))
    // Anything TMDb also lists as now_playing is handled by the theatrical
    // path above — this is specifically for films NOT currently in theaters.
    .filter(m => !currentDataIds.has(m.dataId));
  console.log(`TMDb reports ${recentWithIds.length} recent non-theatrical release(s) after excluding now_playing overlap.`);

  const html = fs.readFileSync(WIDGET_PATH, "utf8");
  const dataIdMatches = [...html.matchAll(/dataId:\s*"([^"]+)"/g)];
  const existingDataIds = new Set(dataIdMatches.map(m => m[1]));

  // dataId is derived from (title, year), so a re-release or a title/year
  // TMDb tags inconsistently across listings (e.g. an anniversary
  // re-release with a different "year" than the original) can slip past the
  // dataId check entirely and get auto-drafted as a duplicate — this
  // happened for real the first time this ran (Neon Genesis Evangelion: The
  // End of Evangelion showed up as "new" under a 2024 re-release date, when
  // it was already onboarded under its true 1997 release year). A
  // normalized-title check catches that class of near-duplicate even when
  // the year differs.
  const normalizeTitle = t => t.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const existingTitles = new Set([...html.matchAll(/name:\s*"((?:[^"\\]|\\.)*)"/g)].map(m => normalizeTitle(m[1].replace(/\\"/g, '"'))));
  const isLikelyDuplicate = title => existingTitles.has(normalizeTitle(title));

  // --- Step 1: retire theatrical films no longer in theaters ---
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
  const notYetOnboarded = m => !existingDataIds.has(m.dataId);
  const likelyDuplicates = [];
  const notDuplicate = m => {
    if (isLikelyDuplicate(m.title)) {
      likelyDuplicates.push(m);
      return false;
    }
    return true;
  };

  const newTheatrical = nowPlayingWithIds
    .filter(notYetOnboarded)
    .filter(notDuplicate)
    .slice(0, NEW_FILM_ALERT_CAP)
    .map(m => ({ ...m, category: "theatrical" }));
  const newRecent = recentWithIds
    .filter(notYetOnboarded)
    .filter(notDuplicate)
    .slice(0, NEW_FILM_ALERT_CAP)
    .map(m => ({ ...m, category: "recent" }));

  if (likelyDuplicates.length) {
    console.log(`${likelyDuplicates.length} title(s) matched an existing entry under a different dataId (likely a re-release/year mismatch) — excluded from auto-draft, needs a human look:`);
    likelyDuplicates.forEach(m => console.log(`  - ${m.title} (${(m.release_date || "").slice(0, 4)}) — https://www.themoviedb.org/movie/${m.id}`));
  }

  const describe = m => `${m.title} (${(m.release_date || "").slice(0, 4)}) [${m.category}] — https://www.themoviedb.org/movie/${m.id}`;
  if (newTheatrical.length) {
    console.log(`${newTheatrical.length} new theatrical film(s) to consider onboarding:`);
    newTheatrical.forEach(m => console.log(`  - ${describe(m)}`));
  } else {
    console.log("No new theatrical films to onboard.");
  }
  if (newRecent.length) {
    console.log(`${newRecent.length} new recent (non-theatrical) release(s) to consider onboarding:`);
    newRecent.forEach(m => console.log(`  - ${describe(m)}`));
  } else {
    console.log("No new recent releases to onboard.");
  }

  const toAutoDraft = [
    ...newTheatrical.slice(0, AUTO_DRAFT_CAP),
    ...newRecent.slice(0, RECENT_AUTO_DRAFT_CAP),
  ].map(m => ({ title: m.title, year: (m.release_date || "").slice(0, 4), category: m.category }));
  // Films beyond each category's auto-draft cap still get listed in the
  // issue, just without a PR — same manual "run onboard-film.js yourself"
  // path as today.
  const remainder = [...newTheatrical.slice(AUTO_DRAFT_CAP), ...newRecent.slice(RECENT_AUTO_DRAFT_CAP)];

  writeGithubOutput("removed", removedTitles.join(", "));
  writeGithubOutput("new-films-json", JSON.stringify(toAutoDraft));
  const remainderText = remainder.map(m => `- **${m.title}** (${(m.release_date || "").slice(0, 4)}) [${m.category}] — https://www.themoviedb.org/movie/${m.id}\n  \`node onboard-film.js "${m.title.replace(/"/g, '\\"')}" ${(m.release_date || "").slice(0, 4)}\``).join("\n");
  const duplicatesText = likelyDuplicates.length
    ? `\n\n**Possible re-release/year mismatch — title matches an existing entry, but under a different dataId. Verify by hand before onboarding (don't just run the command below without checking):**\n` +
      likelyDuplicates.map(m => `- ${m.title} (${(m.release_date || "").slice(0, 4)}) — https://www.themoviedb.org/movie/${m.id}`).join("\n")
    : "";
  writeGithubOutput("new-films", remainderText + duplicatesText);
})().catch(err => {
  console.error("Failed:", err.message);
  process.exit(1);
});
