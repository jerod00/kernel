require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
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

// One-time bulk backfill of the top 200 highest-vote-count films of all
// time (TMDb's vote_count, no date bound at all — genuinely "most iconic
// ever", not bounded to any era) that aren't already in the catalog.
// Separate and independent from historical-backfill.js's daily cursor —
// deliberately does NOT read or write historical-cursor.json, so it has
// zero effect on that pipeline's ongoing chronological march.
//
// Commits in batches of BATCH_SIZE on a single branch (one commit per
// batch, pushed incrementally) rather than opening a separate PR per
// batch — two PRs that both insert new entries at the same spot in
// widget/index.html produce exactly the merge conflict already hit once
// today (PR #8 vs #9). One branch/one PR with several commits gives the
// same "review in digestible chunks" benefit without that risk.
//
// Usage: node backfill-top200.js

const TMDB_ACCESS_TOKEN = process.env.TMDB_ACCESS_TOKEN;
const TMDB_BASE = "https://api.themoviedb.org/3";
const TARGET_COUNT = 200;
const BATCH_SIZE = 20;
const MIN_VOTE_COUNT = 1000; // same "well-known" bar as historical-backfill.js
const MAX_PAGES = 60; // generous cap — bounds worst-case TMDb calls if dedup rate is high
const BRANCH_NAME = "top-200-backfill";

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

const normalizeTitle = t => t.toLowerCase().replace(/[^a-z0-9]+/g, "");

async function findCandidates(onboardedIds, onboardedTitles, limit) {
  const picked = [];
  const seenIds = new Set();
  for (let page = 1; page <= MAX_PAGES && picked.length < limit; page++) {
    const data = await tmdb(`/discover/movie?sort_by=vote_count.desc&vote_count.gte=${MIN_VOTE_COUNT}&page=${page}`);
    if (!data.results || !data.results.length) break;
    for (const m of data.results) {
      if (picked.length >= limit) break;
      if (seenIds.has(m.id)) continue;
      seenIds.add(m.id);
      const year = (m.release_date || "").slice(0, 4);
      if (!year) continue;
      const dataId = slugify(m.title, year);
      if (onboardedIds.has(dataId)) continue;
      if (onboardedTitles.has(normalizeTitle(m.title))) continue;
      picked.push({ title: m.title, year, releaseDate: m.release_date, voteCount: m.vote_count });
    }
    if (page >= data.total_pages) break;
  }
  return picked;
}

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: path.join(__dirname, ".."), stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
}

(async () => {
  console.log(`Finding top ${TARGET_COUNT} highest-vote-count films not already in the catalog...`);
  const html = readWidget();
  const onboardedIds = existingDataIds(html);
  const onboardedTitles = new Set(
    [...html.matchAll(/name:\s*"((?:[^"\\]|\\.)*)"/g)].map(m => normalizeTitle(m[1].replace(/\\"/g, '"')))
  );

  const candidates = await findCandidates(onboardedIds, onboardedTitles, TARGET_COUNT);
  console.log(`Found ${candidates.length} candidate(s) (target was ${TARGET_COUNT}).`);
  if (!candidates.length) {
    console.log("Nothing to do.");
    return;
  }

  git(`checkout -B ${BRANCH_NAME} origin/main`);

  let keys = existingKeys(readWidget());
  let batchEntriesText = "";
  let batchProcessed = [];
  let totalProcessed = 0;
  let totalSkipped = 0;
  let batchNum = 0;

  async function flushBatch() {
    if (!batchProcessed.length) return;
    batchNum++;
    const currentHtml = readWidget();
    insertEntriesAndWrite(currentHtml, batchEntriesText); // hard gate: never writes a file that doesn't parse
    git(`add widget/index.html`);
    const titles = batchProcessed.map(p => p.title).join(", ");
    const msgFile = path.join(__dirname, "_batch-commit-msg.txt");
    fs.writeFileSync(msgFile, `Top-200 backfill batch ${batchNum}: ${titles}\n`);
    git(`commit -F "${msgFile}"`);
    fs.unlinkSync(msgFile);
    git(`push origin ${BRANCH_NAME}`);
    console.log(`\n--- Batch ${batchNum} committed and pushed (${batchProcessed.length} films) ---\n`);
    batchEntriesText = "";
    batchProcessed = [];
  }

  for (const c of candidates) {
    console.log(`\n=== Drafting ${c.title} (${c.year}) [top-200] (${totalProcessed + totalSkipped + 1}/${candidates.length}) ===`);
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
      batchEntriesText += buildFilmsEntryText(key, data, aiText, "historical");
      batchProcessed.push({ title: c.title, year: c.year, dataId: data.dataId, key });
      totalProcessed++;
      console.log(`  -> FILMS.${key} drafted (score=${data.critic.score ?? "n/a"})`);
    } catch (err) {
      console.error(`  Skipping "${c.title}" (${c.year}): ${err.message}`);
      totalSkipped++;
    }

    if (batchProcessed.length >= BATCH_SIZE) {
      await flushBatch();
    }
  }
  await flushBatch(); // final partial batch, if any

  console.log(`\nDone. Processed ${totalProcessed}, skipped ${totalSkipped}.`);

  if (totalProcessed > 0) {
    console.log(`\nBranch ${BRANCH_NAME} pushed with ${batchNum} commit(s). Open the PR with:`);
    console.log(`  gh pr create --title "Top 200 backfill: ${totalProcessed} highest-vote-count classics" --base main --head ${BRANCH_NAME} --body "One-time bulk backfill of the most iconic films by TMDb vote count, independent of the daily historical-backfill cursor. ${batchNum} commits, ~${BATCH_SIZE} films each — review commit-by-commit. Each entry still needs Tier 2 research (Metacritic spread, marketing spend, weekly gross) before merging, same as every other auto-drafted film."`);
  }
})().catch(err => {
  console.error("Failed:", err.message);
  process.exit(1);
});
