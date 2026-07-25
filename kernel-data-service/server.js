require("dotenv").config();
const path = require("node:path");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { ingest, getLatest, getHistory, listEntities, verifyChain } = require("./db");
const { getSynopsis } = require("./synopsis");
const {
  requireAdminToken,
  requireNotifyToken,
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

app.listen(PORT, () => {
  console.log(`Kernel data service listening on port ${PORT}`);
});
