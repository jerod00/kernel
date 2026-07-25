require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const {
  DRAFTS_DIR,
  runTier1,
  readDraftWithRetry,
  saveAiTextToDraft,
  ingestSeedContent,
  draftInsightText,
  buildFilmsEntryText,
  pickEntryKey,
  readWidget,
  existingDataIds,
  existingKeys,
  insertEntriesAndWrite,
  slugify,
} = require("./draft-lib");

// Builds out the back-catalog (genre-classics-style roster) 10 well-known
// films at a time, working backward from the newest eligible release date
// to the oldest, one day's worth of progress at a time — a persistent
// cursor (historical-cursor.json) tracks where the backfill left off so
// each day continues strictly further into the past rather than
// re-surfacing the same films. Never overlaps the site's own "recent
// releases" window (RECENT_RELEASE_WINDOW_MS in the widget) — the initial
// cursor starts just past it.
//
// Quality bar is TMDb's own vote_count (a rough proxy for "well-known"),
// not release date — each day's discover query is sorted by vote_count
// descending within the date bound, so it surfaces genuinely notable films
// first rather than whatever happened to release on a given date.
//
// Usage: node historical-backfill.js
// Writes GITHUB_OUTPUT keys `historical-drafted`, `historical-pr-title`,
// `historical-pr-body-list` for the CI workflow to open a PR with.

const TMDB_ACCESS_TOKEN = process.env.TMDB_ACCESS_TOKEN;
const TMDB_BASE = "https://api.themoviedb.org/3";
const CURSOR_PATH = path.join(__dirname, "historical-cursor.json");
const DAILY_COUNT = 10;
const MIN_VOTE_COUNT = 1000; // "well-known" quality bar — tune if the backfill surfaces titles that feel too obscure (raise) or runs dry too fast (lower)
const RECENT_WINDOW_DAYS = 90; // matches RECENT_RELEASE_WINDOW_MS in widget/index.html — must not overlap it
const MAX_PAGES = 5; // bounds worst-case TMDb calls per run if a date window is unusually sparse in eligible titles

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

function readCursor() {
  if (!fs.existsSync(CURSOR_PATH)) {
    const initial = new Date(Date.now() - (RECENT_WINDOW_DAYS + 1) * 86400000).toISOString().slice(0, 10);
    return { beforeDate: initial };
  }
  return JSON.parse(fs.readFileSync(CURSOR_PATH, "utf8"));
}

function writeCursor(cursor) {
  fs.writeFileSync(CURSOR_PATH, JSON.stringify(cursor, null, 2) + "\n");
}

function writeGithubOutput(key, value) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) return;
  fs.appendFileSync(outPath, `${key}<<EOF\n${value}\nEOF\n`);
}

const normalizeTitle = t => t.toLowerCase().replace(/[^a-z0-9]+/g, "");

async function findCandidates(beforeDate, onboardedIds, onboardedTitles, limit) {
  const picked = [];
  const seenIds = new Set();
  for (let page = 1; page <= MAX_PAGES && picked.length < limit; page++) {
    const data = await tmdb(
      `/discover/movie?sort_by=vote_count.desc&primary_release_date.lte=${beforeDate}&vote_count.gte=${MIN_VOTE_COUNT}&page=${page}`
    );
    if (!data.results || !data.results.length) break;
    for (const m of data.results) {
      if (picked.length >= limit) break;
      if (seenIds.has(m.id)) continue;
      seenIds.add(m.id);
      const year = (m.release_date || "").slice(0, 4);
      if (!year) continue;
      const dataId = slugify(m.title, year);
      if (onboardedIds.has(dataId)) continue;
      if (onboardedTitles.has(normalizeTitle(m.title))) continue; // same-title-different-year dedup, mirrors refresh-now-playing.js
      picked.push({ title: m.title, year, releaseDate: m.release_date, voteCount: m.vote_count });
    }
    if (page >= data.total_pages) break;
  }
  return picked;
}

(async () => {
  const cursor = readCursor();
  console.log(`Historical backfill: looking for well-known films released on or before ${cursor.beforeDate}...`);

  const html = readWidget();
  const onboardedIds = existingDataIds(html);
  const onboardedTitles = new Set([...html.matchAll(/name:\s*"((?:[^"\\]|\\.)*)"/g)].map(m => normalizeTitle(m[1].replace(/\\"/g, '"'))));

  const candidates = await findCandidates(cursor.beforeDate, onboardedIds, onboardedTitles, DAILY_COUNT);

  if (!candidates.length) {
    console.log(`No eligible candidates found on or before ${cursor.beforeDate} (vote_count >= ${MIN_VOTE_COUNT}) — leaving cursor unchanged, nothing to do today.`);
    writeGithubOutput("historical-drafted", "[]");
    return;
  }

  console.log(`Found ${candidates.length} candidate(s):`);
  candidates.forEach(c => console.log(`  - ${c.title} (${c.year}), released ${c.releaseDate}, vote_count ${c.voteCount}`));

  const keys = existingKeys(html);
  let entriesText = "";
  const processed = [];
  const skipped = [];

  for (const c of candidates) {
    console.log(`\n=== Drafting ${c.title} (${c.year}) [historical] ===`);
    try {
      runTier1(c.title, c.year);
      const dataId = slugify(c.title, String(c.year));
      const draftPath = path.join(DRAFTS_DIR, `${dataId}.json`);
      const data = readDraftWithRetry(draftPath);
      await ingestSeedContent(data);

      const key = pickEntryKey(data.dataId, keys);
      keys.push(key);

      const aiText = await draftInsightText(data);
      saveAiTextToDraft(draftPath, data, aiText);
      entriesText += buildFilmsEntryText(key, data, aiText, "historical");
      processed.push({ title: c.title, year: c.year, dataId: data.dataId, key });
      console.log(`  -> FILMS.${key} drafted (score=${data.critic.score ?? "n/a"})`);
    } catch (err) {
      console.error(`  Skipping "${c.title}" (${c.year}): ${err.message}`);
      skipped.push({ title: c.title, year: c.year, reason: err.message });
    }
  }

  // Advance the cursor to just before the OLDEST release date actually
  // considered today (drafted or skipped) — a skip still counts as
  // "looked at," so a single bad title (e.g. a TMDb match failure) can't
  // stall the whole backfill on the same day forever.
  const oldestDate = candidates.reduce((oldest, c) => (c.releaseDate < oldest ? c.releaseDate : oldest), candidates[0].releaseDate);
  const newCursorDate = new Date(new Date(oldestDate).getTime() - 86400000).toISOString().slice(0, 10);
  writeCursor({ beforeDate: newCursorDate });
  console.log(`\nCursor advanced to ${newCursorDate}.`);

  if (!processed.length) {
    console.log("Nothing successfully drafted today — no widget changes.");
    writeGithubOutput("historical-drafted", "[]");
    return;
  }

  insertEntriesAndWrite(html, entriesText); // hard gate inside: never writes a widget file that doesn't parse
  console.log(`Wrote ${processed.length} historical draft entr${processed.length === 1 ? "y" : "ies"}.`);

  writeGithubOutput("historical-drafted", JSON.stringify(processed));
  writeGithubOutput("historical-pr-title", `Historical backfill: ${processed.map(p => p.title).join(", ")}`);
  writeGithubOutput("historical-pr-body-list", processed.map(p => `- **${p.title}** (${p.year}) as \`FILMS.${p.key}\``).join("\n"));
})().catch(err => {
  console.error("Failed:", err.message);
  process.exit(1);
});
