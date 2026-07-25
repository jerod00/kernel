const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const path = require("node:path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "kernel.db");
const HMAC_SECRET = process.env.HMAC_SECRET;
if (!HMAC_SECRET) {
  throw new Error("HMAC_SECRET must be set — it's what makes the chain unforgeable without the key. Set it in .env.");
}

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS data_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    source TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    row_hash TEXT NOT NULL
  );
`);

// Belt-and-suspenders: block ordinary UPDATE/DELETE through this or any other
// connection to this file. Defense in depth — the HMAC chain (below) is what
// actually detects tampering that bypasses this (e.g. someone editing the
// .db file directly, or issuing PRAGMA writable_schema tricks).
db.exec(`
  CREATE TRIGGER IF NOT EXISTS data_log_no_update
  BEFORE UPDATE ON data_log
  BEGIN
    SELECT RAISE(ABORT, 'data_log is append-only: UPDATE is not allowed');
  END;
`);
db.exec(`
  CREATE TRIGGER IF NOT EXISTS data_log_no_delete
  BEFORE DELETE ON data_log
  BEGIN
    SELECT RAISE(ABORT, 'data_log is append-only: DELETE is not allowed');
  END;
`);

// Pageviews and errors are operational telemetry, not audited facts — they
// don't belong in the hash chain above (no source to cite, no reason a user
// would ever need to verify one wasn't tampered with), so they get their own
// plain, mutable tables instead.
db.exec(`
  CREATE TABLE IF NOT EXISTS pageviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at TEXT NOT NULL,
    path TEXT NOT NULL,
    referrer TEXT,
    visitor_hash TEXT NOT NULL
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS error_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at TEXT NOT NULL,
    message TEXT NOT NULL,
    stack TEXT,
    context TEXT
  );
`);

const GENESIS = hmac("GENESIS");

function hmac(input) {
  return crypto.createHmac("sha256", HMAC_SECRET).update(input).digest("hex");
}

function rowSigningString({ recordedAt, entityType, entityId, field, value, source, prevHash }) {
  return [prevHash, recordedAt, entityType, entityId, field, value, source].join("|");
}

function lastRow() {
  const stmt = db.prepare("SELECT * FROM data_log ORDER BY id DESC LIMIT 1");
  return stmt.get();
}

function ingest({ entityType, entityId, field, value, source }) {
  if (!entityType || !entityId || !field || value === undefined || !source) {
    throw new Error("ingest() requires entityType, entityId, field, value, and source");
  }
  const recordedAt = new Date().toISOString();
  const valueStr = typeof value === "string" ? value : JSON.stringify(value);
  const prev = lastRow();
  const prevHash = prev ? prev.row_hash : GENESIS;
  const rowHash = hmac(rowSigningString({ recordedAt, entityType, entityId, field, value: valueStr, source, prevHash }));

  const stmt = db.prepare(`
    INSERT INTO data_log (recorded_at, entity_type, entity_id, field, value, source, prev_hash, row_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(recordedAt, entityType, entityId, field, valueStr, source, prevHash, rowHash);
  return { recordedAt, entityType, entityId, field, value: valueStr, source, prevHash, rowHash };
}

function getLatest(entityType, entityId) {
  const stmt = db.prepare(`
    SELECT d.field, d.value, d.recorded_at, d.source
    FROM data_log d
    INNER JOIN (
      SELECT field, MAX(id) AS max_id
      FROM data_log
      WHERE entity_type = ? AND entity_id = ?
      GROUP BY field
    ) latest ON d.id = latest.max_id
    ORDER BY d.field
  `);
  return stmt.all(entityType, entityId);
}

function getHistory(entityType, entityId, field) {
  if (field) {
    const stmt = db.prepare(`
      SELECT * FROM data_log WHERE entity_type = ? AND entity_id = ? AND field = ? ORDER BY id ASC
    `);
    return stmt.all(entityType, entityId, field);
  }
  const stmt = db.prepare(`
    SELECT * FROM data_log WHERE entity_type = ? AND entity_id = ? ORDER BY id ASC
  `);
  return stmt.all(entityType, entityId);
}

function listEntities() {
  const stmt = db.prepare(`SELECT DISTINCT entity_type, entity_id FROM data_log ORDER BY entity_type, entity_id`);
  return stmt.all();
}

function verifyChain() {
  const stmt = db.prepare("SELECT * FROM data_log ORDER BY id ASC");
  const rows = stmt.all();
  let expectedPrev = GENESIS;
  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) {
      return { valid: false, brokenAtId: row.id, reason: "prev_hash does not match the preceding row's row_hash (a row was likely deleted or reordered)" };
    }
    const recomputed = hmac(rowSigningString({
      recordedAt: row.recorded_at, entityType: row.entity_type, entityId: row.entity_id,
      field: row.field, value: row.value, source: row.source, prevHash: row.prev_hash,
    }));
    if (recomputed !== row.row_hash) {
      return { valid: false, brokenAtId: row.id, reason: "row_hash does not match its recomputed HMAC (this row's contents were altered)" };
    }
    expectedPrev = row.row_hash;
  }
  return { valid: true, rowsVerified: rows.length };
}

function logPageview({ path: pagePath, referrer, visitorHash }) {
  const stmt = db.prepare(`
    INSERT INTO pageviews (recorded_at, path, referrer, visitor_hash) VALUES (?, ?, ?, ?)
  `);
  stmt.run(new Date().toISOString(), pagePath, referrer || null, visitorHash);
}

function getPageviewSummary(days = 7) {
  const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM pageviews WHERE recorded_at >= ?`).get(sinceIso).n;
  const uniqueVisitors = db.prepare(`SELECT COUNT(DISTINCT visitor_hash) AS n FROM pageviews WHERE recorded_at >= ?`).get(sinceIso).n;
  const topPaths = db.prepare(`
    SELECT path, COUNT(*) AS n FROM pageviews WHERE recorded_at >= ? GROUP BY path ORDER BY n DESC LIMIT 15
  `).all(sinceIso);
  const topReferrers = db.prepare(`
    SELECT COALESCE(referrer, '(direct)') AS referrer, COUNT(*) AS n FROM pageviews WHERE recorded_at >= ? GROUP BY referrer ORDER BY n DESC LIMIT 15
  `).all(sinceIso);
  const byDay = db.prepare(`
    SELECT substr(recorded_at, 1, 10) AS day, COUNT(*) AS n FROM pageviews WHERE recorded_at >= ? GROUP BY day ORDER BY day ASC
  `).all(sinceIso);
  return { since: sinceIso, days, total, uniqueVisitors, topPaths, topReferrers, byDay };
}

function logError({ message, stack, context }) {
  const stmt = db.prepare(`
    INSERT INTO error_log (recorded_at, message, stack, context) VALUES (?, ?, ?, ?)
  `);
  stmt.run(
    new Date().toISOString(),
    String(message).slice(0, 2000),
    stack ? String(stack).slice(0, 4000) : null,
    context ? JSON.stringify(context).slice(0, 1000) : null
  );
}

function getRecentErrors(limit = 50) {
  return db.prepare(`SELECT * FROM error_log ORDER BY id DESC LIMIT ?`).all(limit);
}

module.exports = {
  db, ingest, getLatest, getHistory, listEntities, verifyChain,
  logPageview, getPageviewSummary, logError, getRecentErrors,
};
