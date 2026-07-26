require("dotenv").config();
const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const {
  ingest, getLatest, getHistory, listEntities, verifyChain,
  logPageview, getPageviewSummary, logError, getRecentErrors, getRecentAudienceReviews,
  saveRedditOpportunity, getKnownRedditPostIds, getRedditOpportunities, setRedditOpportunityStatus,
} = require("./db");
const { looksLikeSpam } = require("./spam-filter");
const { getSynopsis } = require("./synopsis");
const { scoreLabel } = require("./score-label");
const {
  requireAdminToken,
  requireNotifyToken,
  requireIngestToken,
  requireRedditToken,
  listOpenPRs,
  mergePR,
  closePR,
  adminPageHtml,
  adminManifestJson,
  SERVICE_WORKER_JS,
} = require("./admin");
const { saveSubscription, sendPushNotification } = require("./push");

const app = express();
// Fly.io (and most hosts) put this behind a single reverse-proxy hop, so
// req.ip needs the trust-proxy setting to read the real client IP from
// X-Forwarded-For rather than the proxy's own address — without it every
// visitor would share one rate-limit bucket (the proxy's IP).
app.set("trust proxy", 1);
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
app.use(express.json());

// The only public write path (see /api/ingest below) — cheap insurance
// against a script spamming hundreds of fake reviews a minute. Generous
// enough that a real person leaving a few reviews across films never hits it.
const ingestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many review submissions from this address — try again later." },
});

// Generous compared to ingestLimiter — a real visitor fires one of these per
// route change while browsing, easily a dozen+ in a session, vs. the review
// form which a person submits a handful of times at most.
const pageviewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many pageview pings." },
});

// Defense in depth alongside the admin token itself — the token's own
// entropy is the real protection, this just blunts a brute-force scan.
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many admin requests — try again later." },
});

const PORT = process.env.PORT || 3002;

// Every other entityType (film facts, filmography, weekly gross, seed
// content, trailers…) is ingested by trusted local scripts that call
// ingest() from db.js directly — none of them go through this HTTP route.
// Now that this server is reachable from the public internet rather than
// just localhost, this route is the ONLY thing an anonymous visitor can
// reach, so it's locked to the one entityType the widget's review form
// actually sends. Without this, anyone could POST a fake entityType:"film"
// critic_score/econ_* fact and have getLatest() serve it back as if it were
// a real, sourced number — silently overwriting every trusted figure on the
// site, not just adding a review.
const MAX_RATING = 100, MIN_RATING = 0, MAX_COMMENT_LEN = 140;

app.post("/api/ingest", ingestLimiter, (req, res) => {
  const { entityType, entityId, field, value, source } = req.body || {};
  if (entityType !== "audience_review") {
    return res.status(403).json({ error: "This endpoint only accepts audience_review submissions." });
  }
  if (typeof entityId !== "string" || !entityId) {
    return res.status(400).json({ error: "entityId must be a non-empty string." });
  }
  if (typeof field !== "string" || !/^review_\d+_[a-z0-9]+$/.test(field)) {
    return res.status(400).json({ error: "field must match the widget's own review_<timestamp>_<random> format." });
  }
  const rating = value && Number(value.rating);
  if (!Number.isFinite(rating) || rating < MIN_RATING || rating > MAX_RATING) {
    return res.status(400).json({ error: `value.rating must be a number between ${MIN_RATING} and ${MAX_RATING}.` });
  }
  const comment = value && value.comment != null ? String(value.comment).slice(0, MAX_COMMENT_LEN) : null;
  const spamReason = looksLikeSpam(comment);
  if (spamReason) {
    return res.status(400).json({ error: `Comment rejected (${spamReason}) — please write a genuine review.` });
  }
  try {
    const row = ingest({
      entityType,
      entityId,
      field,
      value: { rating, comment },
      source: "Self-reported (unverified) — Kernel widget submission",
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const MAX_PATH_LEN = 200, MAX_REFERRER_LEN = 300;

// Public, unauthenticated pageview beacon — deliberately minimal: no raw IP
// is ever stored. The visitor hash mixes in today's UTC date, so it can
// answer "roughly how many distinct visitors today" without being usable to
// link the same person's visits across different days.
app.post("/api/pageview", pageviewLimiter, (req, res) => {
  const { path: pagePath, referrer } = req.body || {};
  if (typeof pagePath !== "string" || !pagePath) {
    return res.status(400).json({ error: "path is required." });
  }
  const today = new Date().toISOString().slice(0, 10);
  const visitorHash = crypto
    .createHash("sha256")
    .update(`${req.ip}|${req.get("user-agent") || ""}|${today}`)
    .digest("hex")
    .slice(0, 16);
  try {
    logPageview({
      path: pagePath.slice(0, MAX_PATH_LEN),
      referrer: referrer ? String(referrer).slice(0, MAX_REFERRER_LEN) : null,
      visitorHash,
    });
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/entity/:type/:id", (req, res) => {
  const rows = getLatest(req.params.type, req.params.id);
  if (!rows.length) return res.status(404).json({ error: "No data for this entity" });
  const fields = {};
  for (const r of rows) fields[r.field] = { value: r.value, recordedAt: r.recorded_at, source: r.source };
  res.json({ entityType: req.params.type, entityId: req.params.id, fields });
});

app.get("/api/history/:type/:id", (req, res) => {
  const rows = getHistory(req.params.type, req.params.id, req.query.field);
  res.json({ entityType: req.params.type, entityId: req.params.id, field: req.query.field || null, history: rows });
});

app.get("/api/entities", (req, res) => {
  res.json(listEntities());
});

// Computed server-side rather than the client fetching every film's
// reviews individually (76+ requests) just to sort them — a cheap O(n) scan
// today given how few real reviews exist yet, revisit with caching if that
// changes. Public/unauthenticated: aggregated stats only, no reviewer
// identity or comment text leaves this endpoint.
const DIVISIVE_MIN_REVIEWS = 3;

app.get("/api/leaderboards/divisive", (req, res) => {
  const entities = listEntities().filter(e => e.entity_type === "audience_review");
  const results = [];
  for (const { entity_id } of entities) {
    const rows = getLatest("audience_review", entity_id);
    const ratings = rows
      .map(r => { try { return JSON.parse(r.value).rating; } catch { return null; } })
      .filter(r => typeof r === "number");
    if (ratings.length < DIVISIVE_MIN_REVIEWS) continue;
    const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
    const variance = ratings.reduce((sum, r) => sum + (r - avg) ** 2, 0) / ratings.length;
    results.push({ dataId: entity_id, n: ratings.length, avg: +avg.toFixed(1), stddev: +Math.sqrt(variance).toFixed(2) });
  }
  results.sort((a, b) => b.stddev - a.stddev);
  res.json(results.slice(0, 20));
});

// Same "enough real reviews to trust" bar as DIVISIVE_MIN_REVIEWS above and
// the widget's own MIN_REAL_REVIEWS constant — this is the threshold at
// which "Kernel Score" stops being the critic-sourced number baked into
// FILMS at draft time and switches to this real, self-reported average.
// Both the widget (at boot) and build-seo-pages.js (at deploy time) call
// this to override f.score/f.n/f.spread/f.label for any film that qualifies.
const AUDIENCE_SCORE_MIN_REVIEWS = 3;

app.get("/api/leaderboards/audience-scores", (req, res) => {
  const entities = listEntities().filter(e => e.entity_type === "audience_review");
  const results = {};
  for (const { entity_id } of entities) {
    const rows = getLatest("audience_review", entity_id);
    const ratings = rows
      .map(r => { try { return JSON.parse(r.value).rating; } catch { return null; } })
      .filter(r => typeof r === "number");
    if (ratings.length < AUDIENCE_SCORE_MIN_REVIEWS) continue;
    const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
    const positive = ratings.filter(r => r >= 70).length;
    const negative = ratings.filter(r => r < 40).length;
    const mixed = ratings.length - positive - negative;
    const score = Math.round(avg);
    results[entity_id] = {
      score,
      n: ratings.length,
      label: scoreLabel(score),
      spread: [
        Math.round((positive / ratings.length) * 100),
        Math.round((mixed / ratings.length) * 100),
        Math.round((negative / ratings.length) * 100),
      ],
    };
  }
  res.json(results);
});

app.get("/api/verify", (req, res) => {
  const result = verifyChain();
  res.status(result.valid ? 200 : 409).json(result);
});

app.get("/api/synopsis/:dataId", async (req, res) => {
  const filmName = (req.query.name || req.params.dataId).toString();
  const year = (req.query.year || "").toString();
  try {
    const result = await getSynopsis(req.params.dataId, filmName, year);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(502).json({ status: "error", message: "Synopsis generation failed" });
  }
});

// Admin panel — reachable via a link in the daily email, gated by a long
// random shared secret (ADMIN_TOKEN) rather than a login flow. Merging here
// is a real merge via GitHub's own API — nothing bypassed, and it pushes to
// main exactly like clicking "Merge" on github.com, which the existing
// gh-pages deploy workflow already picks up automatically.
app.get("/admin", adminLimiter, requireAdminToken, (req, res) => {
  const token = req.query.token || req.get("x-admin-token") || "";
  res.type("html").send(adminPageHtml(token));
});

// PWA icons — public/static, no admin token needed (just app iconography,
// nothing sensitive, and they must be fetchable before any auth context
// exists). Registered after the exact "/admin" route above on purpose:
// express.static redirects a request for its own mount path with no
// remainder ("/admin") to "/admin/" looking for an index file, which would
// otherwise hijack the real admin page before requireAdminToken ever runs.
app.use("/admin", express.static(path.join(__dirname, "public")));

// Gated like the page itself — see the comment on adminManifestJson in
// admin.js for why this isn't a static file.
app.get("/admin/manifest.webmanifest", adminLimiter, requireAdminToken, (req, res) => {
  const token = req.query.token || req.get("x-admin-token") || "";
  res.type("application/manifest+json").json(adminManifestJson(token));
});

// Public — generic push/notification-click logic, no secrets or user data.
app.get("/admin/sw.js", (req, res) => {
  res.type("application/javascript").send(SERVICE_WORKER_JS);
});

app.post("/admin/api/push-subscribe", adminLimiter, requireAdminToken, (req, res) => {
  saveSubscription(req.body);
  res.json({ ok: true });
});

// Called by the daily pipeline's GitHub Actions workflow right after it
// opens a PR — a machine caller, so it authenticates with its own token
// rather than the human ADMIN_TOKEN (see requireNotifyToken in admin.js).
app.post("/admin/api/notify-pr", adminLimiter, requireNotifyToken, async (req, res) => {
  const { title, url } = req.body || {};
  if (typeof title !== "string" || !title || typeof url !== "string" || !url) {
    return res.status(400).json({ error: "title and url are required strings." });
  }
  try {
    const sent = await sendPushNotification({
      title: `New PR: ${title}`,
      body: "Tap to review, merge, or close.",
      url,
    });
    res.json({ sent });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Called by the daily pipeline right after Tier 1 fetch, so an auto-drafted
// film's cold-start seed content (see the "seed_content" entity type)
// actually reaches the production log — ingest-film.js already does this
// exact thing for manually-onboarded films, but it writes to db.js's
// ingest() directly, which only works against a local kernel.db. The
// GitHub Actions runner has no access to the Fly volume the real database
// lives on, so this is the bridge: same entity shape, reachable over HTTPS.
app.post("/admin/api/ingest-seed-content", adminLimiter, requireIngestToken, (req, res) => {
  const { filmId, seedScore, seedScoreUrl, seedReviews } = req.body || {};
  if (typeof filmId !== "string" || !filmId) {
    return res.status(400).json({ error: "filmId is required." });
  }
  let count = 0;
  try {
    if (seedScore != null) {
      if (typeof seedScore !== "number") {
        return res.status(400).json({ error: "seedScore must be a number." });
      }
      ingest({
        entityType: "seed_content",
        entityId: filmId,
        field: "score",
        value: seedScore,
        source: seedScoreUrl || "SOURCE MISSING — fix before trusting this fact",
      });
      count++;
    }
    if (Array.isArray(seedReviews)) {
      seedReviews.slice(0, 3).forEach((r, i) => {
        if (!r || typeof r.content !== "string") return;
        ingest({
          entityType: "seed_content",
          entityId: filmId,
          field: `review_${i}`,
          value: { author: r.author || null, content: r.content, url: r.url || null },
          source: r.url || "SOURCE MISSING — fix before trusting this fact",
        });
        count++;
      });
    }
    res.json({ ingested: count });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/admin/api/analytics/summary", adminLimiter, requireAdminToken, (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  res.json(getPageviewSummary(days));
});

app.get("/admin/api/errors", adminLimiter, requireAdminToken, (req, res) => {
  res.json(getRecentErrors(50));
});

app.get("/admin/api/recent-reviews", adminLimiter, requireAdminToken, (req, res) => {
  res.json(getRecentAudienceReviews(50));
});

// Called by the daily reddit-listening pipeline before it drafts anything —
// letting it skip posts it's already surfaced avoids wasting an Anthropic
// call drafting a reply for a post already sitting in the queue. Read-only,
// gated by its own token (see requireRedditToken in admin.js) rather than
// PIPELINE_INGEST_TOKEN, since it has nothing to do with the hash-chained log.
app.get("/admin/api/reddit-opportunities/known-ids", adminLimiter, requireRedditToken, (req, res) => {
  res.json(getKnownRedditPostIds());
});

// Draft-and-approve only — this never posts to Reddit itself, it just stores
// a suggestion for a human to review in the admin panel. INSERT OR IGNORE in
// saveRedditOpportunity() means a duplicate postId is a harmless no-op.
app.post("/admin/api/reddit-opportunities/ingest", adminLimiter, requireRedditToken, (req, res) => {
  const { filmKey, filmName, subreddit, postId, postTitle, postUrl, postExcerpt, draftedReply } = req.body || {};
  const requiredStrings = { filmKey, filmName, subreddit, postId, postTitle, postUrl, draftedReply };
  for (const [key, value] of Object.entries(requiredStrings)) {
    if (typeof value !== "string" || !value) {
      return res.status(400).json({ error: `${key} must be a non-empty string.` });
    }
  }
  try {
    const inserted = saveRedditOpportunity({
      filmKey, filmName, subreddit, postId, postTitle, postUrl,
      postExcerpt: postExcerpt != null ? String(postExcerpt) : null,
      draftedReply,
    });
    res.json({ inserted });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/admin/api/reddit-opportunities", adminLimiter, requireAdminToken, (req, res) => {
  res.json(getRedditOpportunities(req.query.status || "new"));
});

app.post("/admin/api/reddit-opportunities/:id/dismiss", adminLimiter, requireAdminToken, (req, res) => {
  const found = setRedditOpportunityStatus(Number(req.params.id), "dismissed");
  if (!found) return res.status(404).json({ error: "No opportunity with that id." });
  res.json({ ok: true });
});

app.post("/admin/api/reddit-opportunities/:id/mark-posted", adminLimiter, requireAdminToken, (req, res) => {
  const found = setRedditOpportunityStatus(Number(req.params.id), "posted");
  if (!found) return res.status(404).json({ error: "No opportunity with that id." });
  res.json({ ok: true });
});

app.get("/admin/api/prs", adminLimiter, requireAdminToken, async (req, res) => {
  try {
    res.json(await listOpenPRs());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/admin/api/prs/:number/merge", adminLimiter, requireAdminToken, async (req, res) => {
  try {
    res.json(await mergePR(req.params.number));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.post("/admin/api/prs/:number/close", adminLimiter, requireAdminToken, async (req, res) => {
  try {
    res.json(await closePR(req.params.number));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

// Best-effort push alert reusing the same admin-PWA push channel the daily
// pipeline already uses for "new PR opened" — a crash is just another thing
// the admin should get pinged about. Cooldown avoids a crash loop paging
// every single time it happens; the errors are all still logged to
// error_log regardless, so nothing is lost, just the alert is throttled.
let lastErrorAlertAt = 0;
const ERROR_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

function alertOnError(message) {
  const now = Date.now();
  if (now - lastErrorAlertAt < ERROR_ALERT_COOLDOWN_MS) return;
  lastErrorAlertAt = now;
  sendPushNotification({
    title: "Kernel backend error",
    body: String(message).slice(0, 120),
    url: "/admin",
  }).catch(() => {
    /* best-effort — a failed alert shouldn't itself throw */
  });
}

function captureError(err, context) {
  console.error(err);
  try {
    logError({ message: err.message, stack: err.stack, context });
  } catch (logErr) {
    console.error("Failed to persist error to error_log:", logErr);
  }
  alertOnError(err.message);
}

// Catches anything a route handler passes to next(err), or throws
// synchronously — everything here already has its own try/catch and
// responds directly, so this is a safety net for whatever isn't.
app.use((err, req, res, next) => {
  captureError(err, { path: req.path, method: req.method });
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error." });
});

process.on("uncaughtException", (err) => {
  captureError(err, { type: "uncaughtException" });
  // The process is in an undefined state after this — Fly's health check
  // will restart the machine, which is safer than continuing to run.
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  captureError(err, { type: "unhandledRejection" });
});

app.listen(PORT, () => {
  console.log(`Kernel data service listening on port ${PORT}`);
});
