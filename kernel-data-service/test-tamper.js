const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("./kernel.db");

try {
  db.exec("UPDATE data_log SET value = '999' WHERE entity_type='film' AND entity_id='joker-2019' AND field='critic_score'");
  console.log("UPDATE SUCCEEDED (this would be bad)");
} catch (err) {
  console.log("UPDATE blocked:", err.message);
}

try {
  db.exec("DELETE FROM data_log WHERE id = 1");
  console.log("DELETE SUCCEEDED (this would be bad)");
} catch (err) {
  console.log("DELETE blocked:", err.message);
}
