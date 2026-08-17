require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { assertWidgetScriptParses } = require("./draft-lib");

// Keeps auto-drafted films' Tier-1 econ numbers current while they're still
// actually playing, WITHOUT ever touching a film a human has already done
// real Tier 2 research on. TMDb's own budget/revenue figures genuinely
// change as a film's theatrical run continues (crowd-sourced, updated over
// time) — but once a human replaces the TODO-marked placeholder with a real
// Box-Office-Mojo-cited figure, that figure is authoritative and strictly
// better than TMDb's; silently overwriting it here would be a real accuracy
// regression, not a refresh. So the only films this ever touches are ones
// that are (a) nowPlaying: true and (b) still carry the "TODO: Box Office
// Mojo weekend-by-weekend" marker in their own entry — the one reliable
// signal that nobody's done that research yet.
//
// Usage: node refresh-tier1-econ.js
// Writes GITHUB_OUTPUT key `econ-updated` (human-readable summary) for the
// CI workflow's commit-message step.

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

function toMillions(n) {
  return n == null || n === 0 ? null : +(n / 1e6).toFixed(3);
}

function writeGithubOutput(key, value) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) return;
  fs.appendFileSync(outPath, `${key}<<EOF\n${value}\nEOF\n`);
}

// Slices out just this entry's own text (from its dataId line up to the
// next entry's dataId line, or the end of the FILMS object) — bounded so a
// regex can never accidentally reach into a neighboring entry.
function sliceEntry(html, startIndex, allDataIdPositions) {
  const next = allDataIdPositions.find(p => p > startIndex);
  return html.slice(startIndex, next != null ? next : html.length);
}

// Re-locates one entry's [start, end) bounds by its own dataId, fresh
// against whatever `html` currently is (not the original scan positions,
// which go stale the moment an earlier edit in this same run changes the
// string length). dataId is unique per film, so this is always exact.
function findEntryBounds(html, dataId) {
  const marker = `dataId: "${dataId}"`;
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const nextDataId = html.slice(start + marker.length).match(/dataId:\s*"/);
  const end = nextDataId ? start + marker.length + nextDataId.index : html.length;
  return [start, end];
}

(async () => {
  let html = fs.readFileSync(WIDGET_PATH, "utf8");

  const dataIdRegex = /dataId:\s*"([^"]+)"/g;
  const allMatches = [...html.matchAll(dataIdRegex)];
  const allPositions = allMatches.map(m => m.index);

  const candidates = [];
  allMatches.forEach((m, i) => {
    const dataId = m[1];
    const entryText = sliceEntry(html, m.index, allPositions);
    if (!/nowPlaying:\s*true/.test(entryText)) return;
    if (!entryText.includes("TODO: Box Office Mojo")) return; // Tier 2 already done — never touch

    const nameMatch = entryText.match(/name:\s*"((?:[^"\\]|\\.)*)",\s*year:\s*"(\d{4})"/);
    const econMatch = entryText.match(/econ:\s*\{\s*budget:\s*([^,]+),\s*marketing:\s*([^,]+),\s*boxOffice:\s*([^,]+),\s*domesticTotal:\s*([^}]+?)\s*\}/);
    if (!nameMatch || !econMatch) {
      console.log(`  ${dataId}: couldn't locate name/year/econ cleanly — skipping rather than risk a bad edit.`);
      return;
    }
    candidates.push({
      dataId,
      name: nameMatch[1].replace(/\\"/g, '"'),
      year: nameMatch[2],
      oldEconBlock: econMatch[0],
      marketing: econMatch[2].trim(),
      domesticTotal: econMatch[4].trim(),
      oldBudget: econMatch[1].trim() === "null" ? null : Number(econMatch[1]),
      oldBoxOffice: econMatch[3].trim() === "null" ? null : Number(econMatch[3]),
    });
  });

  console.log(`${candidates.length} still-TODO nowPlaying film(s) eligible for a Tier-1 econ refresh.`);

  const updated = [];
  for (const c of candidates) {
    try {
      const search = await tmdb(`/search/movie?query=${encodeURIComponent(c.name)}&year=${c.year}`);
      const match = search.results && search.results[0];
      if (!match) { console.log(`  ${c.name}: no TMDb match on re-search, skipping.`); continue; }
      const details = await tmdb(`/movie/${match.id}`);
      const newBudget = toMillions(details.budget);
      const newBoxOffice = toMillions(details.revenue);

      if (newBudget === c.oldBudget && newBoxOffice === c.oldBoxOffice) {
        console.log(`  ${c.name}: no change.`);
        continue;
      }

      const newEconBlock = `econ: { budget: ${newBudget != null ? newBudget : "null"}, marketing: ${c.marketing}, boxOffice: ${newBoxOffice != null ? newBoxOffice : "null"}, domesticTotal: ${c.domesticTotal} }`;
      // Scoped to this film's own entry (re-found by its unique dataId,
      // fresh against the current html) rather than a bare html.replace —
      // dozens of films share byte-identical placeholder econ blocks (e.g.
      // every still-all-null one), so an unscoped string replace silently
      // edits whichever film happens to appear first in the file instead
      // of the one actually being processed. Caught live: this is exactly
      // what was corrupting unrelated films' budget/boxOffice numbers.
      const bounds = findEntryBounds(html, c.dataId);
      if (!bounds) {
        console.log(`  ${c.name}: entry not found — skipping to be safe.`);
        continue;
      }
      const [entryStart, entryEnd] = bounds;
      const entrySlice = html.slice(entryStart, entryEnd);
      if (!entrySlice.includes(c.oldEconBlock)) {
        console.log(`  ${c.name}: entry text changed since scan started — skipping to be safe.`);
        continue;
      }
      html = html.slice(0, entryStart) + entrySlice.replace(c.oldEconBlock, newEconBlock) + html.slice(entryEnd);
      updated.push(`${c.name} (budget ${c.oldBudget ?? "null"}→${newBudget ?? "null"}, box office ${c.oldBoxOffice ?? "null"}→${newBoxOffice ?? "null"})`);
      console.log(`  ${c.name}: updated — budget ${c.oldBudget ?? "null"}→${newBudget ?? "null"}, box office ${c.oldBoxOffice ?? "null"}→${newBoxOffice ?? "null"}.`);
    } catch (err) {
      console.log(`  ${c.name}: failed (${err.message}), skipping.`);
    }
  }

  if (updated.length) {
    assertWidgetScriptParses(html); // hard gate: never write a widget file that doesn't parse
    fs.writeFileSync(WIDGET_PATH, html);
    console.log(`\nWrote ${updated.length} Tier-1 econ update(s).`);
  } else {
    console.log("\nNo econ updates to write.");
  }

  writeGithubOutput("econ-updated", updated.join("; "));
})().catch(err => {
  console.error("Failed:", err.message);
  process.exit(1);
});
