// Required first by the dev-* wrapper scripts so DB_PATH is set in
// process.env before db.js (which reads it at load time) gets required.
// Keeps all local testing — review submissions, tamper tests, whatever —
// off the real kernel.db, so it stops polluting production data.
process.env.DB_PATH = require("node:path").join(__dirname, "kernel.dev.db");
