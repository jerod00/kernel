#!/usr/bin/env node
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");

// Populates the landing page's "Coming Soon" trailer strip — deliberately a
// separate, lightweight data source from FILMS rather than a new FILMS
// category: these are pre-release films with no score, no econ, no
// reviews, nothing the rest of the site's machinery (leaderboards, Hidden
// Gems, the audience-review form) has any use for. Re-running this
// replaces the whole list — it's meant to reflect "what's coming soon
// right now," not accumulate.
//
// Usage: node fetch-upcoming-trailers.js [count]

const TMDB_ACCESS_TOKEN = process.env.TMDB_ACCESS_TOKEN;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const TMDB_BASE = "https://api.themoviedb.org/3";
const YOUTUBE_BASE = "https://www.googleapis.com/youtube/v3";
const WIDGET_PATH = path.join(__dirname, "..", "widget", "index.html");
const TARGET_COUNT = Number(process.argv[2]) || 8;
const MAX_PAGES = 4; // TMDb upcoming, 20/page — plenty of headroom to find TARGET_COUNT with real trailers

if (!TMDB_ACCESS_TOKEN) {
  console.error("Set TMDB_ACCESS_TOKEN in kernel-data-service/.env first.");
  process.exit(1);
}

async function tmdb(pathName) {
  const res = await fetch(`${TMDB_BASE}${pathName}`, { headers: { Authorization: `Bearer ${TMDB_ACCESS_TOKEN}` } });
  if (!res.ok) throw new Error(`TMDb ${pathName} failed: ${res.status}`);
  return res.json();
}

// Same selection rule as onboard-film.js's pickBestVideo, so a trailer
// chosen here matches what a film would get once it's actually onboarded.
function pickBestVideo(results) {
  const yt = (results || []).filter(v => v.site === "YouTube");
  const rank = v => (v.type === "Trailer" && v.official ? 0 : v.type === "Trailer" ? 1 : v.type === "Teaser" && v.official ? 2 : v.type === "Teaser" ? 3 : 9);
  yt.sort((a, b) => rank(a) - rank(b) || new Date(a.published_at) - new Date(b.published_at));
  return yt.find(v => rank(v) < 9) || null;
}

async function fetchYoutubeStats(videoId) {
  if (!YOUTUBE_API_KEY) return null;
  try {
    const res = await fetch(`${YOUTUBE_BASE}/videos?part=statistics&id=${videoId}&key=${YOUTUBE_API_KEY}`);
    if (!res.ok) return null;
    const data = await res.json();
    const stats = data.items && data.items[0] && data.items[0].statistics;
    if (!stats) return null;
    return {
      viewCount: stats.viewCount != null ? Number(stats.viewCount) : null,
      likeCount: stats.likeCount != null ? Number(stats.likeCount) : null,
    };
  } catch {
    return null;
  }
}

(async () => {
  console.log(`Fetching TMDb upcoming releases (region=US)...`);
  const rawCandidates = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await tmdb(`/movie/upcoming?region=US&page=${page}`);
    rawCandidates.push(...data.results);
    if (page >= data.total_pages) break;
  }
  // TMDb's "upcoming" list means "has a screening coming up somewhere,"
  // which — same as now_playing — includes anniversary/revival re-releases
  // of films that already came out. Caught for real on a live run: it
  // returned La La Land (2016), Your Name. (2017), Train to Busan (2016),
  // and Spider-Man: Brand New Day (already released 2026-07-31) alongside
  // genuinely new titles. release_date is the film's true original release
  // date even for a rerelease entry (same TMDb behavior behind the Willy
  // Wonka now_playing bug), so filtering to strictly-future dates is a
  // reliable, deterministic fix — no title-based guessing needed.
  const today = new Date().toISOString().slice(0, 10);
  const candidates = rawCandidates.filter(c => c.release_date && c.release_date > today);
  const droppedCount = rawCandidates.length - candidates.length;
  if (droppedCount) console.log(`Filtered out ${droppedCount} result(s) already released (rerelease/revival screenings, not new releases).`);
  // TMDb's own popularity ordering, not release-date order — the point of
  // this strip is "biggest things coming soon," not a release calendar.
  candidates.sort((a, b) => b.popularity - a.popularity);

  const picked = [];
  for (const c of candidates) {
    if (picked.length >= TARGET_COUNT) break;
    if (!c.poster_path) continue;
    try {
      const videosRes = await tmdb(`/movie/${c.id}/videos?language=en-US`);
      const best = pickBestVideo(videosRes.results);
      if (!best) continue; // no real trailer — nothing to show in a trailer strip
      const ytStats = await fetchYoutubeStats(best.key);
      picked.push({
        title: c.title,
        releaseDate: c.release_date,
        poster: c.poster_path,
        backdrop: c.backdrop_path,
        trailerKey: best.key,
        trailerName: best.name,
        viewCount: ytStats && ytStats.viewCount,
        likeCount: ytStats && ytStats.likeCount,
      });
      console.log(`  + ${c.title} (${c.release_date}) — trailer found`);
    } catch (err) {
      console.warn(`  (skipping ${c.title}: ${err.message})`);
    }
  }

  if (!picked.length) {
    console.log("No upcoming films with a real trailer found — leaving widget unchanged.");
    return;
  }

  const literal = picked.map(f => `  {
    title: ${JSON.stringify(f.title)},
    releaseDate: ${JSON.stringify(f.releaseDate)},
    poster: ${JSON.stringify(f.poster)},
    backdrop: ${JSON.stringify(f.backdrop)},
    trailerKey: ${JSON.stringify(f.trailerKey)},
    trailerName: ${JSON.stringify(f.trailerName)},
    viewCount: ${f.viewCount != null ? f.viewCount : "null"},
    likeCount: ${f.likeCount != null ? f.likeCount : "null"},
  },`).join("\n");
  const block = `const UPCOMING_TRAILERS = [\n${literal}\n];`;

  const html = fs.readFileSync(WIDGET_PATH, "utf8");
  const marker = "const UPCOMING_TRAILERS = [";
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error(`Could not find "${marker}" in widget/index.html — has the landing-page markup been wired in yet?`);
  const endIdx = html.indexOf("];", startIdx) + 2;
  const updated = html.slice(0, startIdx) + block + html.slice(endIdx);
  fs.writeFileSync(WIDGET_PATH, updated);
  console.log(`\nWrote ${picked.length} upcoming trailer(s) to widget/index.html.`);
})().catch(err => {
  console.error("Failed:", err.message);
  process.exit(1);
});
