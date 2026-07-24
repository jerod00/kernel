const fs = require("node:fs");
const path = require("node:path");
const {
  DRAFTS_DIR,
  runTier1,
  readDraftWithRetry,
  saveAiTextToDraft,
  draftInsightText,
  buildFilmsEntryText,
  pickEntryKey,
  readWidget,
  existingDataIds,
  existingKeys,
  insertEntriesAndWrite,
  slugify,
} = require("./draft-lib");

// Turns a {title, year, category} into a fully-Tier-1-populated, AI-drafted-
// prose FILMS entry inserted into the widget — but deliberately leaves 3
// fields as TODOs (critic spread/review count, marketing spend, weekly
// gross) since those require reading Metacritic's and Box Office Mojo's own
// pages by hand: both explicitly prohibit automated/scraped access in their
// terms of use, the same restriction already found for Rotten Tomatoes.
// Never auto-merged — this only ever runs on a branch, for a PR a human
// reviews (see the "Draft new films" workflow step).
//
// category is "theatrical" (nowPlaying: true), "recent" (nowPlaying: false,
// still gets releaseDate so the widget's own 90-day slider picks it up), or
// "historical" (no nowPlaying/releaseDate at all, matching every
// hand-authored back-catalog entry) — see draft-lib.js's buildFilmsEntryText.
//
// Usage (PowerShell):
//   $env:FILMS_JSON = '[{"title":"X","year":"2026","category":"theatrical"}]'
//   node draft-onboard.js
// Usage (bash):
//   FILMS_JSON='[{"title":"X","year":"2026","category":"theatrical"}]' node draft-onboard.js
// Reads from an env var rather than argv — passing a JSON string with
// embedded double quotes as a CLI arg gets mangled by PowerShell's argument
// marshaling to native processes (quotes silently stripped); an env var
// assignment sidesteps that entirely and works identically in CI.

const filmsArg = process.env.FILMS_JSON;
if (!filmsArg) {
  console.error('Usage: set FILMS_JSON to \'[{"title":"X","year":"2026","category":"theatrical"}]\' then run node draft-onboard.js');
  process.exit(1);
}
const filmsToProcess = JSON.parse(filmsArg);

(async () => {
  let html = readWidget();
  const keys = existingKeys(html);
  let entriesText = "";
  const processed = [];
  const skipped = [];

  for (const { title, year, category } of filmsToProcess) {
    console.log(`\n=== Drafting ${title} (${year}) [${category || "theatrical"}] ===`);
    try {
      runTier1(title, year);
      const dataId = slugify(title, String(year));
      const draftPath = path.join(DRAFTS_DIR, `${dataId}.json`);
      const data = readDraftWithRetry(draftPath);

      const key = pickEntryKey(data.dataId, keys);
      keys.push(key);

      const aiText = await draftInsightText(data);
      saveAiTextToDraft(draftPath, data, aiText);
      entriesText += buildFilmsEntryText(key, data, aiText, category || "theatrical");
      processed.push({ title, year, dataId: data.dataId, key });
      console.log(`  -> FILMS.${key} drafted (score=${data.critic.score ?? "n/a"}, director=${!!data.director}, actor=${!!data.actor})`);
    } catch (err) {
      console.error(`  Skipping "${title}" (${year}): ${err.message}`);
      skipped.push({ title, year, reason: err.message });
    }
  }

  const outPath = process.env.GITHUB_OUTPUT;
  if (outPath) fs.appendFileSync(outPath, `skipped<<EOF\n${JSON.stringify(skipped)}\nEOF\n`);

  if (!processed.length) {
    console.log("\nNothing drafted — no changes to write.");
    if (outPath) fs.appendFileSync(outPath, `drafted<<EOF\n[]\nEOF\n`);
    return;
  }

  insertEntriesAndWrite(html, entriesText); // hard gate inside: never writes a widget file that doesn't parse
  console.log(`\nWrote ${processed.length} draft entr${processed.length === 1 ? "y" : "ies"} into ${DRAFTS_DIR}/../../widget/index.html`);
  console.log("Remaining TODOs per entry: critic spread/review count (Metacritic), marketing spend (trade press), weekly gross (Box Office Mojo), legsInsight (after weekly gross).");

  if (outPath) {
    fs.appendFileSync(outPath, `drafted<<EOF\n${JSON.stringify(processed)}\nEOF\n`);
    const prTitle = `Draft: ${processed.map(p => p.title).join(", ")}`;
    const prBodyList = processed.map(p => `- **${p.title}** (${p.year}) as \`FILMS.${p.key}\``).join("\n");
    fs.appendFileSync(outPath, `pr-title<<EOF\n${prTitle}\nEOF\n`);
    fs.appendFileSync(outPath, `pr-body-list<<EOF\n${prBodyList}\nEOF\n`);
  }
})().catch(err => {
  console.error("Failed:", err.message);
  process.exit(1);
});
