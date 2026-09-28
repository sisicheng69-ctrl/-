// Apply db/migrations/NNN_*.sql. Run from install.sh: node app/migrate.cjs
// Fail loud: print the full error to stderr and exit non-zero.
const db = require("../guard_sdk/db");

db.migrate()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[migrate] fatal:", (e && (e.stack || e.message)) || e);
    process.exit(1);
  });
