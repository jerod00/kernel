require("dotenv").config();
const fs = require("node:fs");
const { ingest, verifyChain } = require("./db");

// Takes a finished draft (onboard-film.js output, Tier 2 fields filled in by
// hand) and logs each fact through the same append-only ingest() path
// seed.js uses — same entity-type conventions, so old and new films stay
// consistent in the log. Unlike onboard-film.js's draft step, this writes to
// the real kernel.db: run it only once a draft is actually finished.
//
// Usage: node ingest-film.js drafts/<dataId>.json

const draftPath = process.argv[2];
if (!draftPath) {
  console.error("Usage: node ingest-film.js drafts/<dataId>.json");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(draftPath, "utf8"));
const filmId = data.dataId;
if (!filmId) throw new Error("Draft is missing dataId");

const sources = data.sources || {};
const today = new Date().toISOString().slice(0, 10);
const cite = url => (url ? `${url} (fetched ${today})` : "SOURCE MISSING — fix before trusting this fact");

let count = 0;
let uncited = 0;

function logIngest(entityType, entityId, field, value, sourceUrl) {
  if (value == null) return;
  const source = cite(sourceUrl);
  if (!sourceUrl) uncited++;
  ingest({ entityType, entityId, field, value, source });
  count++;
}

logIngest("film", filmId, "genres", data.genres && data.genres.length ? data.genres : null, sources.genres);

for (const [field, value] of Object.entries(data.critic || {})) {
  logIngest("film", filmId, `critic_${field}`, value, sources.critic);
}
for (const [field, value] of Object.entries(data.econ || {})) {
  logIngest("film", filmId, `econ_${field}`, value, sources[field] || sources.econ);
}
(data.weeklyGross || []).forEach((gross, i) => {
  logIngest("film_weekend_gross", `${filmId}:week${i + 1}`, "gross_millions_usd", gross, sources.weeklyGross);
});
if (data.director && data.director.name) {
  for (const [creditedFilm, score] of Object.entries(data.director.films || {})) {
    logIngest("director_filmography", data.director.name, creditedFilm, score, sources.filmography);
  }
}
if (data.actor && data.actor.name) {
  for (const [creditedFilm, score] of Object.entries(data.actor.films || {})) {
    logIngest("actor_filmography", data.actor.name, creditedFilm, score, sources.filmography);
  }
}

logIngest("seed_content", filmId, "score", data.seedScore, data.seedScoreUrl);
(data.seedReviews || []).forEach((r, i) => {
  logIngest("seed_content", filmId, `review_${i}`, r, r.url);
});

console.log(`Ingested ${count} facts for ${filmId}.`);
if (uncited) console.log(`WARNING: ${uncited} of those facts had no source URL — fix the draft's "sources" map.`);
console.log(verifyChain());
