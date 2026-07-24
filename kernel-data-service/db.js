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

module.exports = { db, ingest, getLatest, getHistory, listEntities, verifyChain };
