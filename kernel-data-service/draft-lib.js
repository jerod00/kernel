require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { slugify } = require("./slugify");
const { scoreLabel } = require("./score-label");

// Shared drafting core used by draft-onboard.js (theatrical/recent releases,
// driven by an explicit title/year list) and historical-backfill.js (older
// films, driven by its own TMDb-discover + cursor logic) — extracted so both
// produce FILMS entries the exact same way instead of maintaining two
// slightly-different copies of this logic.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"; // same model synopsis.js already uses in production
const WIDGET_PATH = path.join(__dirname, "..", "widget", "index.html");
const DRAFTS_DIR = path.join(__dirname, "drafts");
const DATA_SERVICE_URL = process.env.DATA_SERVICE_URL || "https://kernel-data-service-themoviekernel.fly.dev";
const PIPELINE_INGEST_TOKEN = process.env.PIPELINE_INGEST_TOKEN;

function runTier1(title, year) {
  execFileSync(process.execPath, ["--experimental-sqlite", "onboard-film.js", title, String(year)], {
    cwd: __dirname,
    stdio: "inherit",
  });
}

// One retry after a short pause — execFileSync only returns once the child
// process has exited, but a real (if rare) case surfaced during testing
// where the file it just wrote wasn't yet readable back in the parent
// process (a filesystem-timing hiccup, seen once locally on Windows). A
// single retry costs nothing on the common path and turns a one-off skip
// into a success.
function readDraftWithRetry(draftPath) {
  try {
    return JSON.parse(fs.readFileSync(draftPath, "utf8"));
  } catch (err) {
    const until = Date.now() + 200; // brief synchronous pause — no native sleep in Node, and this only ever runs on the rare retry path
    while (Date.now() < until) {}
    return JSON.parse(fs.readFileSync(draftPath, "utf8"));
  }
}

// draftInsightText()'s output only ever gets embedded into the widget's
// FILMS entry text — it was never written back into the draft JSON file
// itself, which meant review-draft-pr.js's prose-consistency check always
// found insight/directorInsight/actorInsight null (n/a on every single
// film, confirmed the first time this ran for real). Persisting it back
// here is what that check actually needs to read.
function saveAiTextToDraft(draftPath, data, aiText) {
  data.insight = aiText.insight;
  data.directorInsight = aiText.directorInsight;
  data.actorInsight = aiText.actorInsight;
  fs.writeFileSync(draftPath, JSON.stringify(data, null, 2));
}

// onboard-film.js always fetches cold-start seed content (a starting score +
// up to 3 excerpted TMDb reviews), but this pipeline runs in a GitHub Actions
// runner with no access to the Fly volume kernel.db actually lives on — the
// only other ingestion path (ingest-film.js) writes to that file directly
// and simply doesn't work from here. This bridges it over HTTPS instead.
// Non-fatal on failure: seed content is a nice-to-have for new films, not
// something that should ever block a draft over a network hiccup.
async function ingestSeedContent(data) {
  if (data.seedScore == null && (!data.seedReviews || !data.seedReviews.length)) return;
  if (!PIPELINE_INGEST_TOKEN) {
    console.warn("  (PIPELINE_INGEST_TOKEN not set — skipping seed-content ingestion)");
    return;
  }
  try {
    const res = await fetch(`${DATA_SERVICE_URL}/admin/api/ingest-seed-content`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ingest-token": PIPELINE_INGEST_TOKEN },
      body: JSON.stringify({
        filmId: data.dataId,
        seedScore: data.seedScore,
        seedScoreUrl: data.seedScoreUrl,
        seedReviews: data.seedReviews,
      }),
    });
    if (!res.ok) {
      console.warn(`  (Seed-content ingest failed: ${res.status} ${await res.text()} — continuing without it)`);
      return;
    }
    const result = await res.json();
    console.log(`  Ingested ${result.ingested} seed-content fact(s) for ${data.dataId}`);
  } catch (err) {
    console.warn(`  (Seed-content ingest request failed: ${err.message} — continuing without it)`);
  }
}

async function callAnthropic(system, userPrompt, maxTokens) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
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
// average + delta already computed — handing the LLM pre-computed, correct
// numbers and asking only for prose removes a whole class of arithmetic
// error (an earlier version asked it to compute the average itself and it
// fabricated a wrong number on the very first real test).
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
  return films.map(f => `        { title: ${JSON.stringify(f.title)}, year: ${f.year}, score: ${f.score} },`).join("\n");
}

function personBlock(kind, person, insightText) {
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

// category controls the nowPlaying/releaseDate fields, matching the
// conventions already established by hand across the widget:
//   "theatrical" -> nowPlaying: true, releaseDate included
//   "recent"     -> nowPlaying: false (+ comment), releaseDate included so
//                   the widget's own 90-day "New, but not in theaters"
//                   slider picks it up automatically
//   "historical" -> no nowPlaying key at all, no releaseDate — matches every
//                   hand-authored back-catalog entry (Joker, the 23 genre
//                   classics, etc.)
function buildFilmsEntryText(key, data, aiText, category) {
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

  let nowPlayingLine = "";
  let releaseDateLine = "";
  if (category === "theatrical") {
    nowPlayingLine = "      nowPlaying: true,\n";
    releaseDateLine = `      releaseDate: ${JSON.stringify(data.releaseDate)},\n`;
  } else if (category === "recent") {
    nowPlayingLine = "      nowPlaying: false, // recent release, not currently in theaters — auto-drafted\n";
    releaseDateLine = `      releaseDate: ${JSON.stringify(data.releaseDate)},\n`;
  }
  // "historical" gets neither line, matching every hand-authored back-catalog entry.

  return `
    ${key}: {
      dataId: ${JSON.stringify(data.dataId)},
${nowPlayingLine}${releaseDateLine}      genres: ${JSON.stringify(data.genres)},
      overview: ${data.overview ? JSON.stringify(data.overview) : "null"},
      name: ${JSON.stringify(data.name)}, year: ${JSON.stringify(data.year)}, score: ${scoreField}, ci: null, label: ${labelField},
      spread: null /* TODO: Metacritic critic spread [pos, mixed, neg] */, n: null /* TODO: Metacritic review count */,
      poster: ${JSON.stringify(data.poster)},
      trailer: ${data.trailer ? JSON.stringify({ key: data.trailer.key, name: data.trailer.name, type: data.trailer.type }) : "null"},
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

function readWidget() {
  return fs.readFileSync(WIDGET_PATH, "utf8");
}

function existingDataIds(html) {
  return new Set([...html.matchAll(/dataId:\s*"([^"]+)"/g)].map(m => m[1]));
}

function existingKeys(html) {
  return [...html.matchAll(/^ {4}(\w+):\s*\{/gm)].map(m => m[1]);
}

// Inserts entriesText just before the FILMS object's closing brace and
// writes the file — throws (refusing to write) if the result doesn't parse.
function insertEntriesAndWrite(html, entriesText) {
  const usesCRLF = html.includes("\r\n");
  const closingMatch = html.match(/\r?\n {2}\};\r?\n/);
  if (!closingMatch) throw new Error("Could not find the FILMS object's closing brace — aborting, refusing to write.");
  const insertText = usesCRLF ? entriesText.replace(/\n/g, "\r\n") : entriesText;
  const newline = usesCRLF ? "\r\n" : "\n";
  const newHtml = html.slice(0, closingMatch.index) + newline + insertText + html.slice(closingMatch.index);
  assertWidgetScriptParses(newHtml);
  fs.writeFileSync(WIDGET_PATH, newHtml);
  return newHtml;
}

module.exports = {
  WIDGET_PATH,
  DRAFTS_DIR,
  runTier1,
  readDraftWithRetry,
  saveAiTextToDraft,
  ingestSeedContent,
  draftInsightText,
  buildFilmsEntryText,
  pickEntryKey,
  assertWidgetScriptParses,
  readWidget,
  existingDataIds,
  existingKeys,
  insertEntriesAndWrite,
  slugify,
};
