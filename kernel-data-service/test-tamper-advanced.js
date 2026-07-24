const { DatabaseSync } = require("node:sqlite");
const dbPath = "./kernel-tamper-test-copy.db";
const fs = require("node:fs");
fs.copyFileSync("./kernel.db", dbPath); // work on a throwaway copy, never touch the real kernel.db

const db = new DatabaseSync(dbPath);

console.log("Dropping the safety triggers (simulating a sophisticated attacker)...");
db.exec("DROP TRIGGER data_log_no_update");
db.exec("DROP TRIGGER data_log_no_delete");

console.log("Tampering with Joker's score directly in the DB file...");
db.exec("UPDATE data_log SET value = '99' WHERE entity_type='film' AND entity_id='joker-2019' AND field='critic_score'");
console.log("Tamper succeeded at the SQL level (triggers were bypassed) — now checking if verifyChain() catches it...\n");

// Re-require db.js pointed at the tampered copy to reuse the real verifyChain() logic.
process.env.DB_PATH = dbPath;
require("dotenv").config();
delete require.cache[require.resolve("./db")];
const { db: dbFromModule, verifyChain } = require("./db");
console.log(JSON.stringify(verifyChain(), null, 2));

db.close();
dbFromModule.close();
fs.unlinkSync(dbPath);
