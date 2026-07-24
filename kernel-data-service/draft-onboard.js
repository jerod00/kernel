require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { slugify } = require("./slugify");
const { scoreLabel } = require("./score-label");

// Turns a {title, year} into a fully-Tier-1-populated, AI-drafted-prose
// FILMS entry inserted into the widget — but deliberately leaves 3 fields
// as TODOs (critic spread/review count, marketing spend, weekly gross)
// since those require reading Metacritic's and Box Office Mojo's own pages
// by hand: both explicitly prohibit automated/scraped access in their
// terms of use, the same restriction already found for Rotten Tomatoes.
// Never auto-merged — this only ever runs on a branch, for a PR a human
// reviews (see the "Draft new films" workflow step).
//
// Usage (PowerShell):
//   $env:FILMS_JSON = '[{"title":"X","year":"2026"}]'
//   node draft-onboard.js
// Usage (bash):
//   FILMS_JSON='[{"title":"X","year":"2026"}]' node draft-onboard.js
// Reads from an env var rather than argv — passing a JSON string with
// embedded double quotes as a CLI arg gets mangled by PowerShell's argument
// marshaling to native processes (quotes silently stripped); an env var
// assignment sidesteps that entirely and works identically in CI.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"; // same model synopsis.js already uses in production
const WIDGET_PATH = path.join(__dirname, "..", "widget", "index.html");
const DRAFTS_DIR = path.join(__dirname, "drafts");

if (!ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY in kernel-data-service/.env first.");
  process.exit(1);
}

const filmsArg = process.env.FILMS_JSON;
if (!filmsArg) {
  console.error('Usage: set FILMS_JSON to \'[{"title":"X","year":"2026"}]\' then run node draft-onboard.js');
  process.exit(1);
}
const filmsToProcess = JSON.parse(filmsArg);

function runTier1(title, year) {
  execFileSync(process.execPath, ["--experimental-sqlite", "onboard-film.js", title, String(year)], {
    cwd: __dirname,
    stdio: "inherit",
  });
}

async function callAnthropic(system, userPrompt, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data.content && data.content[0] && data.content[0].text;
  if (!text) throw new Error("Anthropic API returned no text");
  return text.trim();
}

const INSIGHT_SYSTEM = `You write short editorial commentary for a film review site called Kernel, matching the direct, data-grounded, slightly wry voice already established across its entries. You are given real numeric facts already fetched from TMDb/OMDb — never invent numbers not given to you, and never invent plot or production details. If a comparison field has no data (e.g. no director filmography), set it to null rather than guessing. Output ONLY strict JSON matching the requested shape — no markdown fences, no commentary outside the JSON.`;

// Excludes the current film from a person's filmography and returns the
// average + delta already computed — the earlier version asked the LLM to
// do this arithmetic itself, and on the very first real test it fabricated
// a wrong average (69.3 instead of the actual 59.4) and got a comparison
// direction backwards. Handing it pre-computed, correct numbers and asking
// only for prose removes that whole class of error.
function otherFilmsStats(person, thisFilmName, thisYear, thisScore) {
  if (!person || !person.films || !person.films.length) return null;
  const others = person.films.filter(f => !(f.title === thisFilmName && f.year === Number(thisYear)));
  if (others.length < 2) return null;
  const avg = others.reduce((sum, f) => sum + f.score, 0) / others.length;
  const best = others.reduce((a, b) => (b.score > a.score ? b : a));
  return {
    count: others.length,
    avg: Math.round(avg * 10) / 10,
    delta: thisScore != null ? Math.round((thisScore - avg) * 10) / 10 : null,
    best,
    // Precomputed on purpose: on the first real test the model correctly
    // used a given average/delta but still miswrote the best-film
    // comparison ("outpacing their best" when this film actually scored
    // lower) — spelling out the true relationship removes that guess too.
    isNewBest: thisScore != null ? thisScore > best.score : null,
  };
}

async function draftInsightText(data) {
  const criticLine = data.critic.score != null
    ? `Metascore ${data.critic.score} ("${scoreLabel(data.critic.score)}")`
    : "no critic score available yet";
  const budgetLine = data.econ.budget != null ? `$${data.econ.budget}M budget` : "budget undisclosed";
  const boxOfficeLine = data.econ.boxOfficeWorldwide != null
    ? `$${data.econ.boxOfficeWorldwide}M worldwide gross so far`
    : "box office not yet reported";

  const directorStats = otherFilmsStats(data.director, data.name, data.year, data.critic.score);
  const actorStats = otherFilmsStats(data.actor, data.name, data.year, data.critic.score);

  const prompt = `Film: ${data.name} (${data.year})
${criticLine}
${budgetLine}, ${boxOfficeLine}

${directorStats
    ? `Director: ${data.director.displayName}. Average Metascore across their other ${directorStats.count} scored films: ${directorStats.avg}. This film is ${directorStats.delta >= 0 ? "+" : ""}${directorStats.delta} vs. that average. Their best other film: ${directorStats.best.title} (${directorStats.best.score}). This film ${directorStats.isNewBest ? "IS their new best-reviewed film, exceeding" : "does NOT exceed"} that best film's score.`
    : "No usable director filmography data."}

${actorStats
    ? `Lead actor: ${data.actor.displayName}. Average Metascore across their other ${actorStats.count} scored films: ${actorStats.avg}. This film is ${actorStats.delta >= 0 ? "+" : ""}${actorStats.delta} vs. that average. Their best other film: ${actorStats.best.title} (${actorStats.best.score}). This film ${actorStats.isNewBest ? "IS their new best-reviewed film, exceeding" : "does NOT exceed"} that best film's score.`
    : "No usable lead-actor filmography data."}

Return JSON: {"insight": string|null, "directorInsight": string|null, "actorInsight": string|null}
- insight: 1-2 sentences relating the critic score to budget/box office so far. null if no critic score.
- directorInsight: 1 sentence built from the director stats given above — use the average, delta, and best-film relationship EXACTLY as given, do not recompute or reinterpret them. If it does NOT exceed the best film, do not say it does, exceeds, surpasses, or outpaces it — say it trails/falls short of it instead. null if no usable director data.
- actorInsight: same rule, for the lead actor stats given above. null if no usable actor data.
Match this exact style: "The Odyssey (88) sits well above Christopher Nolan's own 78.7-point average across 11 scored films — one of his best-reviewed works to date, in a filmography that already skews high for a working director."`;

  const raw = await callAnthropic(INSIGHT_SYSTEM, prompt, 600);
  // Defensive: the model sometimes wraps its answer in a ```json fence
  // despite being told not to — strip one off if present before parsing.
  const unfenced = raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  return JSON.parse(unfenced);
}

function buildRevenuePoints(data) {
  const points = [{ day: 0, value: 0, label: "Release" }];
  if (data.releaseDate && data.econ.boxOfficeWorldwide != null) {
    const release = new Date(data.releaseDate);
    const days = Math.max(1, Math.round((Date.now() - release.getTime()) / 86400000));
    const today = new Date().toISOString().slice(0, 10);
    points.push({ day: days, value: data.econ.boxOfficeWorldwide, label: `Cumulative through ${today}` });
  }
  return points;
}

function filmArrayLiteral(films) {
  // Deliberately flush with "films: [" rather than nested +2, matching the
  // existing hand-authored entries' own (slightly unusual) indentation.
  return films.map(f => `        { title: ${JSON.stringify(f.title)}, year: ${f.year}, score: ${f.score} },`).join("\n");
}

function personBlock(kind, person, insightText) {
  // kind: "director" | "actor"
  if (!person || !person.name) return { block: "", insightLine: `      ${kind}Insight: null,` };
  const films = person.films || [];
  const block = `
      ${kind}: {
        name: ${JSON.stringify(person.displayName)},
        thisFilm: ${JSON.stringify(person._filmName)},
        films: [
${filmArrayLiteral(films)}
        ],
      },`;
  const insightLine = `\n      ${kind}Insight: ${insightText ? JSON.stringify(insightText) : "null"},`;
  return { block, insightLine };
}

function buildFilmsEntryText(key, data, aiText) {
  const label = data.critic.score != null ? scoreLabel(data.critic.score) : null;
  const revenuePoints = buildRevenuePoints(data);
  const scoreField = data.critic.score != null ? data.critic.score : "null /* TODO: Metacritic score */";
  const labelField = label ? JSON.stringify(label) : "null /* TODO */";
  const budgetField = data.econ.budget != null ? data.econ.budget : "null";
  const boxOfficeField = data.econ.boxOfficeWorldwide != null ? data.econ.boxOfficeWorldwide : "null";
  const domesticField = data.econ.domesticTotal != null ? data.econ.domesticTotal : "null";

  const director = data.director ? { ...data.director, _filmName: data.name } : null;
  const actor = data.actor ? { ...data.actor, _filmName: data.name } : null;
  const directorParts = personBlock("director", director, aiText.directorInsight);
  const actorParts = personBlock("actor", actor, aiText.actorInsight);

  return `
    ${key}: {
      dataId: ${JSON.stringify(data.dataId)},
      nowPlaying: true,
      genres: ${JSON.stringify(data.genres)},
      name: ${JSON.stringify(data.name)}, year: ${JSON.stringify(data.year)}, score: ${scoreField}, ci: null, label: ${labelField},
      spread: null /* TODO: Metacritic critic spread [pos, mixed, neg] */, n: null /* TODO: Metacritic review count */,
      poster: ${JSON.stringify(data.poster)},
      econ: { budget: ${budgetField}, marketing: null /* TODO: trade press estimate */, boxOffice: ${boxOfficeField}, domesticTotal: ${domesticField} },
      revenuePoints: ${JSON.stringify(revenuePoints)},
      insight: ${aiText.insight ? JSON.stringify(aiText.insight) : "null"},
      weeklyGross: [] /* TODO: Box Office Mojo weekend-by-weekend */,
      domesticTotal: ${domesticField},${directorParts.block}${directorParts.insightLine}${actorParts.block}${actorParts.insightLine}
      legsInsight: null /* TODO: write once weeklyGross is filled in */,
    },
`;
}

function pickEntryKey(dataId, existingKeys) {
  let base = dataId.replace(/-\d{4}$/, "").replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
  if (!/^[a-zA-Z_$]/.test(base)) base = `f${base}`;
  let key = base, i = 2;
  while (existingKeys.includes(key)) key = `${base}${i++}`;
  return key;
}

function assertWidgetScriptParses(html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("Could not find <script> block to validate — aborting, refusing to write.");
  new vm.Script(match[1], { filename: "widget-script-check.js" }); // throws SyntaxError on bad JS, never executes it
}

(async () => {
  let html = fs.readFileSync(WIDGET_PATH, "utf8");
  const existingKeys = [...html.matchAll(/^ {4}(\w+):\s*\{/gm)].map(m => m[1]);
  let entriesText = "";
  const processed = [];

  for (const { title, year } of filmsToProcess) {
    console.log(`\n=== Drafting ${title} (${year}) ===`);
    try {
      runTier1(title, year);
      const dataId = slugify(title, String(year));
      const draftPath = path.join(DRAFTS_DIR, `${dataId}.json`);
      const data = JSON.parse(fs.readFileSync(draftPath, "utf8"));

      const key = pickEntryKey(data.dataId, existingKeys);
      existingKeys.push(key);

      const aiText = await draftInsightText(data);
      entriesText += buildFilmsEntryText(key, data, aiText);
      processed.push({ title, year, dataId: data.dataId, key });
      console.log(`  -> FILMS.${key} drafted (score=${data.critic.score ?? "n/a"}, director=${!!data.director}, actor=${!!data.actor})`);
    } catch (err) {
      console.error(`  Skipping "${title}" (${year}): ${err.message}`);
    }
  }

  if (!processed.length) {
    console.log("\nNothing drafted — no changes to write.");
    return;
  }

  // Tolerate either line ending — a plain `git checkout` on Windows is
  // enough to flip this file from LF to CRLF (core.autocrlf), which broke
  // an earlier LF-only version of this regex outright.
  const usesCRLF = html.includes("\r\n");
  const closingMatch = html.match(/\r?\n {2}\};\r?\n/);
  if (!closingMatch) throw new Error("Could not find the FILMS object's closing brace — aborting, refusing to write.");
  const insertText = usesCRLF ? entriesText.replace(/\n/g, "\r\n") : entriesText;
  const newline = usesCRLF ? "\r\n" : "\n";
  html = html.slice(0, closingMatch.index) + newline + insertText + html.slice(closingMatch.index);

  assertWidgetScriptParses(html); // hard gate: never write a widget file that doesn't parse

  fs.writeFileSync(WIDGET_PATH, html);
  console.log(`\nWrote ${processed.length} draft entr${processed.length === 1 ? "y" : "ies"} into ${WIDGET_PATH}`);
  console.log("Remaining TODOs per entry: critic spread/review count (Metacritic), marketing spend (trade press), weekly gross (Box Office Mojo), legsInsight (after weekly gross).");

  const outPath = process.env.GITHUB_OUTPUT;
  if (outPath) fs.appendFileSync(outPath, `drafted<<EOF\n${JSON.stringify(processed)}\nEOF\n`);
})().catch(err => {
  console.error("Failed:", err.message);
  process.exit(1);
});
