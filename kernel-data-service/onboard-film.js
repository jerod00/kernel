require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { slugify } = require("./slugify");

// Tier 1 of the data pipeline: pulls what real, free, ToS-compliant APIs can
// actually provide (TMDb + OMDb), cross-checks them against each other, and
// writes a draft for the Tier 2 fields (weekly gross, marketing spend, critic
// spread%, editorial insight text) that have no legal free API and still
// need manual research — same method as the current 11 films (WebSearch /
// WebFetch reading real pages, never scraping).
//
// Usage: node onboard-film.js "Film Title" [year]

const TMDB_ACCESS_TOKEN = process.env.TMDB_ACCESS_TOKEN;
const OMDB_API_KEY = process.env.OMDB_API_KEY;
const TMDB_BASE = "https://api.themoviedb.org/3";
const OMDB_BASE = "https://www.omdbapi.com";
const PERSON_CREDIT_CAP = 30; // keep OMDb calls/person bounded

if (!TMDB_ACCESS_TOKEN) {
  console.error("Set TMDB_ACCESS_TOKEN in kernel-data-service/.env first — see .env.example.");
  process.exit(1);
}
if (!OMDB_API_KEY) {
  console.warn("OMDB_API_KEY not set — proceeding with TMDb data only (no Metascore, no domestic box office, no filmography scores).");
}

const [, , titleArg, yearArg] = process.argv;
if (!titleArg) {
  console.error('Usage: node onboard-film.js "Film Title" [year]');
  process.exit(1);
}

function parseMoney(str) {
  if (!str || str === "N/A") return null;
  const n = Number(str.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toMillions(n) {
  return n == null ? null : +(n / 1e6).toFixed(3);
}

// Cuts at the last word boundary before maxLen and appends an ellipsis —
// used for TMDb review text so only a short excerpt (never the full review)
// ever enters the append-only log, regardless of what the widget renders.
function excerpt(text, maxLen) {
  if (!text || text.length <= maxLen) return text || "";
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim() + "…";
}

async function tmdb(pathName) {
  // Bearer token: TMDb's current recommended auth method, a single token
  // that works across both their v3 and v4 endpoints.
  const res = await fetch(`${TMDB_BASE}${pathName}`, {
    headers: { Authorization: `Bearer ${TMDB_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`TMDb ${pathName} failed: ${res.status}`);
  return res.json();
}

let omdbDisabled = false; // set once a 401 proves the key itself is bad — stops hammering it 30x in the filmography loop

async function omdbLookup({ imdbId, title, year }) {
  if (!OMDB_API_KEY || omdbDisabled) return null;
  // Never let a bad/inactive/rate-limited OMDb key take down the whole run —
  // TMDb data alone is still a useful partial draft, and this same code path
  // starts working automatically the moment the key is fixed, no changes needed.
  try {
    const params = new URLSearchParams({ apikey: OMDB_API_KEY });
    if (imdbId) params.set("i", imdbId);
    else {
      params.set("t", title);
      if (year) params.set("y", year);
    }
    const res = await fetch(`${OMDB_BASE}/?${params}`);
    if (res.status === 401) {
      console.warn("  (OMDb key rejected (401) — is it activated? Skipping OMDb for the rest of this run.)");
      omdbDisabled = true;
      return null;
    }
    if (!res.ok) {
      console.warn(`  (OMDb unavailable: ${res.status} — continuing without it)`);
      return null;
    }
    const data = await res.json();
    return data.Response === "False" ? null : data;
  } catch (err) {
    console.warn(`  (OMDb lookup failed: ${err.message} — continuing without it)`);
    return null;
  }
}

async function buildPersonFilmography(personId, isDirector) {
  const credits = await tmdb(`/person/${personId}/movie_credits`);
  const list = isDirector ? credits.crew.filter(c => c.job === "Director") : credits.cast;
  // Array of {title, year, score} rather than a {slug: score} map — the
  // widget's own director/actor track-record chart needs the real title and
  // year to render, not just the slug used as the DB's field key.
  const films = [];
  for (const c of list.slice(0, PERSON_CREDIT_CAP)) {
    const y = (c.release_date || "").slice(0, 4);
    if (!y) continue;
    const omdb = await omdbLookup({ title: c.title, year: y });
    if (omdb && omdb.Metascore && omdb.Metascore !== "N/A") {
      films.push({ title: c.title, year: Number(y), score: Number(omdb.Metascore) });
    }
  }
  return films;
}

(async () => {
  const title = titleArg;
  const year = yearArg;

  console.log(`\nSearching TMDb for "${title}"${year ? ` (${year})` : ""}...`);
  const search = await tmdb(`/search/movie?query=${encodeURIComponent(title)}${year ? `&year=${year}` : ""}`);
  const match = search.results && search.results[0];
  if (!match) throw new Error(`No TMDb match for "${title}"${year ? ` (${year})` : ""}`);

  const details = await tmdb(`/movie/${match.id}`);
  const externalIds = await tmdb(`/movie/${match.id}/external_ids`);
  const credits = await tmdb(`/movie/${match.id}/credits`);

  const resolvedYear = (details.release_date || "").slice(0, 4);
  const dataId = slugify(details.title, resolvedYear);
  const tmdbUrl = `https://www.themoviedb.org/movie/${details.id}`;

  console.log(`TMDb resolved: "${details.title}" (${resolvedYear}) — ${tmdbUrl}`);

  const omdb = await omdbLookup({ imdbId: externalIds.imdb_id });
  const omdbUrl = externalIds.imdb_id ? `https://www.omdbapi.com/?i=${externalIds.imdb_id}` : null;
  // A human-checkable page (unlike the bare OMDb API URL, which 401s without
  // a key if anyone actually clicks the citation) for the IMDb-rating seed.
  const imdbUrl = externalIds.imdb_id ? `https://www.imdb.com/title/${externalIds.imdb_id}/` : null;

  // Cross-check: the exact class of mistake that produced the wrong Whale
  // score earlier this project — a same-titled, different film.
  const mismatches = [];
  if (omdb) {
    const omdbYear = (omdb.Year || "").slice(0, 4);
    if (omdbYear && omdbYear !== resolvedYear) {
      mismatches.push(`OMDb year (${omdbYear}) != TMDb year (${resolvedYear}) for "${omdb.Title}" vs "${details.title}" — VERIFY same film before trusting Metascore.`);
    }
  } else {
    const reason = omdbDisabled ? "OMDb key was rejected (401)" : !OMDB_API_KEY ? "no OMDB_API_KEY configured" : "OMDb had no match for this IMDb id";
    mismatches.push(`${reason} — Metascore/domestic box office unavailable, needs manual research.`);
  }

  const director = credits.crew.find(c => c.job === "Director");
  const leadActor = credits.cast[0];

  const draft = {
    dataId,
    name: details.title,
    year: resolvedYear,
    releaseDate: details.release_date || null,
    poster: details.poster_path,
    genres: (details.genres || []).map(g => g.name),
    critic: {
      score: omdb && omdb.Metascore !== "N/A" ? Number(omdb.Metascore) : null,
      ci: null, label: null, spreadPositive: null, spreadMixed: null, spreadNegative: null, reviewCount: null,
    },
    econ: {
      budget: toMillions(details.budget) || null,
      marketing: null,
      boxOfficeWorldwide: toMillions(details.revenue) || null,
      domesticTotal: omdb ? toMillions(parseMoney(omdb.BoxOffice)) : null,
    },
    weeklyGross: [],
    // name: slugified, used as the DB entityId (existing convention).
    // displayName: the real name, for anything that renders to a person.
    director: director ? { name: slugify(director.name), displayName: director.name, films: [] } : null,
    actor: leadActor ? { name: slugify(leadActor.name), displayName: leadActor.name, films: [] } : null,
    // Cold-start seed content (Tier 1, fully automatic) — a starting score +
    // up to 3 excerpted, attributed reviews shown only until the film has
    // enough real self-submitted Kernel reviews. Full review text is never
    // captured here (see excerpt() above) — only a short quote plus a link
    // back to the original, which is what a reader actually verifies against.
    seedScore: null,
    seedScoreUrl: null,
    seedReviews: [],
    sources: {
      genres: tmdbUrl,
      budget: tmdbUrl,
      boxOfficeWorldwide: tmdbUrl,
      critic: omdbUrl,
      domesticTotal: omdbUrl,
      marketing: null,
      weeklyGross: null,
      filmography: null,
    },
    mismatches,
  };

  if (omdb && omdb.imdbRating && omdb.imdbRating !== "N/A") {
    draft.seedScore = Math.round(Number(omdb.imdbRating) * 10);
    draft.seedScoreUrl = imdbUrl;
  }

  try {
    const reviewsRes = await tmdb(`/movie/${match.id}/reviews?language=en-US`);
    draft.seedReviews = (reviewsRes.results || []).slice(0, 3).map(r => ({
      author: r.author,
      content: excerpt(r.content, 280),
      url: r.url,
    }));
  } catch (err) {
    console.warn(`  (TMDb reviews fetch failed: ${err.message} — continuing without seed reviews)`);
  }

  console.log("\n--- TIER 1 (auto-fetched, fill nothing here unless flagged) ---");
  console.log(`dataId: ${dataId}`);
  console.log(`genres: ${JSON.stringify(draft.genres)}   [TMDb]`);
  console.log(`econ.budget: ${draft.econ.budget != null ? draft.econ.budget + "M" : "not disclosed by TMDb"}`);
  console.log(`econ.boxOfficeWorldwide: ${draft.econ.boxOfficeWorldwide != null ? draft.econ.boxOfficeWorldwide + "M" : "not disclosed by TMDb"}`);
  console.log(`critic.score (Metascore): ${draft.critic.score != null ? draft.critic.score : "not available from OMDb"}`);
  console.log(`econ.domesticTotal (OMDb): ${draft.econ.domesticTotal != null ? draft.econ.domesticTotal + "M" : "not available from OMDb"}`);
  console.log(`director: ${director ? director.name : "not found"}`);
  console.log(`leadActor: ${leadActor ? leadActor.name : "not found"}`);
  console.log(`seedScore (IMDb rating x10): ${draft.seedScore != null ? draft.seedScore : "not available from OMDb"}`);
  console.log(`seedReviews (TMDb, excerpted, capped at 3): ${draft.seedReviews.length} found`);

  if (mismatches.length) {
    console.log("\n--- MISMATCH WARNINGS ---");
    mismatches.forEach(m => console.log(`  ! ${m}`));
  }

  console.log("\n--- TIER 2 (no free API exists — research manually, same as the current 11) ---");
  console.log("  [ ] critic.ci, critic.label, critic.spreadPositive/Mixed/Negative, critic.reviewCount — Metacritic's own page");
  console.log("  [ ] econ.marketing — trade press estimate (Forbes etc.)");
  console.log("  [ ] weeklyGross[] — Box Office Mojo weekend-by-weekend (read the page directly, do not scrape)");
  console.log("  [ ] insight / legsInsight / directorInsight / actorInsight — editorial text for the widget, written by hand");
  console.log("  [ ] fill in the matching url under \"sources\" for every Tier 2 field you complete");

  let filmographyFromOmdb = false;
  if (director) {
    console.log(`\nFetching director filmography for ${director.name}...`);
    draft.director.films = await buildPersonFilmography(director.id, true);
    console.log(`  ${draft.director.films.length} scored titles found via OMDb`);
    if (draft.director.films.length) filmographyFromOmdb = true;
  }
  if (leadActor) {
    console.log(`\nFetching lead actor filmography for ${leadActor.name}...`);
    draft.actor.films = await buildPersonFilmography(leadActor.id, false);
    console.log(`  ${draft.actor.films.length} scored titles found via OMDb`);
    if (draft.actor.films.length) filmographyFromOmdb = true;
  }
  // OMDb has no single permalink for "this person's whole filmography" — each
  // title was looked up individually by name+year (visible in the draft
  // itself), so this points at the API rather than one clickable URL.
  if (filmographyFromOmdb) draft.sources.filmography = "https://www.omdbapi.com/ (each title above looked up individually by name+year)";

  const outDir = path.join(__dirname, "drafts");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${dataId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(draft, null, 2));
  console.log(`\nDraft written to ${outPath}`);
  console.log("Fill in the Tier 2 fields and their sources, then run: node ingest-film.js drafts/" + dataId + ".json");
})().catch(err => {
  console.error("Failed:", err.message);
  process.exit(1);
});
