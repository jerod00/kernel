require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { ingest, getLatest, getHistory, listEntities, verifyChain } = require("./db");
const { getSynopsis } = require("./synopsis");

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
app.use(express.json());

const PORT = process.env.PORT || 3002;

app.post("/api/ingest", (req, res) => {
  const { entityType, entityId, field, value, source } = req.body || {};
  try {
    const row = ingest({ entityType, entityId, field, value, source });
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

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Kernel data service listening on port ${PORT}`);
});
