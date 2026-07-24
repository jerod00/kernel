require("dotenv").config();
const { verifyChain } = require("./db");

const result = verifyChain();
console.log(JSON.stringify(result, null, 2));
process.exit(result.valid ? 0 : 1);
