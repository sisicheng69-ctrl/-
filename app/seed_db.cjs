// Seed the DB (idempotent, every install). Run AFTER migrate:
//   node app/seed_db.cjs
// No-op if app/seed/ has no JSON files.
const db = require("../guard_sdk/db");

db.seedStructured()
  .then(() => {
    console.log("[seed] done");
    process.exit(0);
  })
  .catch((e) => {
    console.error("[seed] fatal:", (e && (e.stack || e.message)) || e);
    process.exit(1);
  });
