// guard_sdk/db.js — PostgreSQL access for Guard sub-apps (Node).
//
// This is PLAIN PostgreSQL via the `pg` driver. It connects to whatever
// db.properties points at and does not know or care whether that endpoint is
// the platform's real PG (prod) or a local dev PG (sandbox). Do not add any
// dev-database-specific code here — parity between sandbox and prod depends on
// this file being identical in both.
//
// Platform contract (do not fight it):
// - The ONLY config source is ./db.properties, injected by the platform before
//   install.sh runs. EXACTLY 6 keys: db.type/host/port/username/password/database.
//   Never invent extra keys — the platform does not inject them.
// - All persistence goes here. The Pod filesystem is ephemeral; never use files
//   as a database.
//
// File storage uses a BYTEA column (see attachments in 001_init.sql), not
// PostgreSQL Large Objects: LO's auto-cleanup trigger needs the `lo` contrib
// extension, which the sandbox dev PG (PGlite) does not bundle — CREATE
// EXTENSION lo would break migrate. BYTEA is plain SQL, identical in sandbox
// and prod.
//
// Exports: readProps, isDbConfigured, getPool, migrate, seedStructured,
//          uploadFile, readFile

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PROPS_PATH = process.env.DB_PROPERTIES_PATH || path.join(PROJECT_ROOT, "db.properties");
const MIG_DIR = path.join(PROJECT_ROOT, "db", "migrations");
const SEED_DIR = path.join(PROJECT_ROOT, "app", "seed");

// table -> natural key column for ON CONFLICT. The column MUST have a UNIQUE
// constraint in some migration. Maintain per business reality.
const NATURAL_KEY = {};

let _pool = null;

function readProps(p = PROPS_PATH) {
  // k=v lines (NOT INI). Throws if missing — do not fall back to a local file.
  const raw = fs.readFileSync(p, "utf-8");
  const out = {};
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 0) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return out;
}

function isDbConfigured(p = PROPS_PATH) {
  try {
    const props = readProps(p);
    return ["db.host", "db.port", "db.username", "db.password", "db.database"].every(
      (k) => props[k]
    );
  } catch (_) {
    return false;
  }
}

function getPool() {
  // Object config — never string-concat a DSN (passwords with @ : / break it).
  // max:10 because a BYTEA upload/download holds a connection for the transfer.
  if (_pool) return _pool;
  const p = readProps();
  _pool = new Pool({
    host: p["db.host"],
    port: parseInt(p["db.port"], 10),
    user: p["db.username"],
    password: p["db.password"],
    database: p["db.database"],
    max: 10,
    // TCP keepalive: the OS probes idle sockets, so a connection dropped by the
    // server (PG restart, network blip) is detected instead of discovered as a
    // hang on the next query. Standard best practice against real PG; harmless
    // on the sandbox dev PG. NOT a workaround — do not remove.
    keepAlive: true,
  });
  // REQUIRED by node-postgres, not optional (see https://node-postgres.com/apis/pool):
  // when the server closes an idle pooled client's socket, that client emits an
  // 'error' event on the pool; with NO listener Node re-throws it as an
  // uncaught 'error' and "will potentially crash the process". With this
  // listener, pg instead terminates + evicts the dead client from the pool, so
  // the next getPool().query() transparently opens a fresh connection. This is
  // what makes "app sat idle for hours, then a request comes in" just work — on
  // real PG (backend restart / network partition) and dev PG alike. Do not
  // delete this handler and do not "rebuild the pool" manually; pg's built-in
  // eviction already handles recovery correctly.
  _pool.on("error", (err) => {
    console.error(`[db] idle client dropped, evicted from pool: ${err.code || err.message}`);
  });
  return _pool;
}

async function migrate() {
  // Apply db/migrations/NNN_*.sql once each, tracked. Append-only.
  const pool = getPool();
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  const { rows } = await pool.query("SELECT version FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.version));

  if (!fs.existsSync(MIG_DIR)) {
    console.log("[migrate] no migrations dir");
    return;
  }
  const files = fs
    .readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const version = f.replace(/\.sql$/, "");
    if (applied.has(version)) {
      console.log(`[migrate] skip ${version}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIG_DIR, f), "utf-8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // pg supports multiple statements in one query() call.
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
      await client.query("COMMIT");
      console.log(`[migrate] apply ${version}`);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  console.log("[migrate] done");
}

async function seedStructured() {
  // app/seed/<table>.json -> INSERT ... ON CONFLICT (natural key) DO NOTHING
  if (!fs.existsSync(SEED_DIR)) return;
  const pool = getPool();
  const files = fs
    .readdirSync(SEED_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const f of files) {
    const table = f.replace(/\.json$/, "");
    const rows = JSON.parse(fs.readFileSync(path.join(SEED_DIR, f), "utf-8"));
    if (!rows.length) continue;
    const key = NATURAL_KEY[table];
    if (!key) {
      throw new Error(
        `[seed] ${table}.json present but no NATURAL_KEY mapping; add it to ` +
          `guard_sdk/db.js NATURAL_KEY and a UNIQUE constraint`
      );
    }
    const cols = Object.keys(rows[0]);
    for (const row of rows) {
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
      const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) ON CONFLICT (${key}) DO NOTHING`;
      await pool.query(sql, cols.map((c) => row[c]));
    }
    console.log(`[seed] ${table}: ${rows.length} rows ensured`);
  }
}

// --- File storage: BYTEA column (business tables store only attachments.id) - //
// Plain standard SQL — no `lo` extension, no superuser, works on any PG. Fine
// for small/medium files; the whole payload lives in memory per request, so do
// not use this for very large (100MB+) uploads.

const crypto = require("crypto");

async function uploadFile({ name, mime, data, ownerId = null }) {
  // data: Buffer. Returns attachments.id. sha256-dedup.
  const pool = getPool();
  const sha = crypto.createHash("sha256").update(data).digest("hex");
  const existing = await pool.query("SELECT id FROM attachments WHERE sha256=$1", [sha]);
  if (existing.rows.length) return existing.rows[0].id;
  const { rows } = await pool.query(
    `INSERT INTO attachments (name, mime, size_bytes, sha256, owner_id, content)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (sha256) DO UPDATE SET sha256 = attachments.sha256
     RETURNING id`,
    [name, mime, data.length, sha, ownerId, data]
  );
  return rows[0].id;
}

async function readFile(id) {
  // Returns { name, mime, data: Buffer } or null.
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT name, mime, content FROM attachments WHERE id=$1",
    [id]
  );
  if (!rows.length) return null;
  const { name, mime, content } = rows[0];
  return { name, mime, data: content };
}

module.exports = {
  readProps,
  isDbConfigured,
  getPool,
  migrate,
  seedStructured,
  uploadFile,
  readFile,
  NATURAL_KEY,
};
