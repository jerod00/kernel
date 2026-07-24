require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
// Must run before cors() — cors() short-circuits and ends the response for
// OPTIONS preflight requests, so middleware registered after it never runs
// for those. Chrome's Private Network Access policy preflights any request
// from a public origin (e.g. an https://claude.ai-hosted page) to a local/
// private address like localhost, and requires this header on the response
// before it'll allow the real request through.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  next();
});
app.use(cors());

const PORT = process.env.PORT || 3001;
const TMDB_ACCESS_TOKEN = process.env.TMDB_ACCESS_TOKEN;
const OMDB_API_KEY = process.env.OMDB_API_KEY;

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";
const OMDB_BASE = "https://www.omdbapi.com";
const TMDB_ATTRIBUTION = "This website uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — artwork for a released film essentially never changes
const cache = new Map(); // "title::year" -> { data, expiresAt }

function cacheKey(title, year) {
  return `${title.trim().toLowerCase()}::${year || ""}`;
}

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key, data) {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function fetchFromTMDb(title, year) {
  if (!TMDB_ACCESS_TOKEN) return null;
  const params = new URLSearchParams({ query: title });
  if (year) params.set("year", year);

  // Bearer token is TMDb's current recommended auth method — a single
  // token that works across both their v3 and v4 endpoints, replacing the
  // older ?api_key= query-param style.
  const res = await fetch(`${TMDB_BASE}/search/movie?${params}`, {
    headers: { Authorization: `Bearer ${TMDB_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`TMDb search failed: ${res.status}`);
  const data = await res.json();

  const match = data.results && data.results[0];
  if (!match || !match.poster_path) return null;

  return {
    source: "tmdb",
    title: match.title,
    year: (match.release_date || "").slice(0, 4) || null,
    poster: `${TMDB_IMAGE_BASE}/w500${match.poster_path}`,
    backdrop: match.backdrop_path ? `${TMDB_IMAGE_BASE}/w1280${match.backdrop_path}` : null,
    attribution: TMDB_ATTRIBUTION,
  };
}

async function fetchFromOMDb(title, year) {
  if (!OMDB_API_KEY) return null;
  const params = new URLSearchParams({ apikey: OMDB_API_KEY, t: title });
  if (year) params.set("y", year);

  const res = await fetch(`${OMDB_BASE}/?${params}`);
  if (!res.ok) throw new Error(`OMDb lookup failed: ${res.status}`);
  const data = await res.json();

  if (data.Response === "False" || !data.Poster || data.Poster === "N/A") return null;

  return {
    source: "omdb",
    title: data.Title,
    year: data.Year || null,
    poster: data.Poster,
    backdrop: null,
    attribution: "Poster data provided by OMDb API.",
  };
}

app.get("/api/artwork", async (req, res) => {
  const title = (req.query.title || "").toString().trim();
  const year = (req.query.year || "").toString().trim();

  if (!title) {
    return res.status(400).json({ error: "Missing required query param: title" });
  }
  if (!TMDB_ACCESS_TOKEN && !OMDB_API_KEY) {
    return res.status(500).json({
      error: "No API keys configured. Set TMDB_ACCESS_TOKEN and/or OMDB_API_KEY in the environment.",
    });
  }

  const key = cacheKey(title, year);
  const cached = getCached(key);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    let result = await fetchFromTMDb(title, year);
    if (!result) result = await fetchFromOMDb(title, year);

    if (!result) {
      return res.status(404).json({ error: "No artwork found", title, year: year || null });
    }

    setCached(key, result);
    res.json({ ...result, cached: false });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Upstream lookup failed", detail: err.message });
  }
});

app.get("/healthz", (req, res) => {
  res.json({ ok: true, tmdbConfigured: Boolean(TMDB_ACCESS_TOKEN), omdbConfigured: Boolean(OMDB_API_KEY) });
});

app.listen(PORT, () => {
  console.log(`Kernel artwork service listening on port ${PORT}`);
});
