-- 001_init.sql — baseline schema
-- RULES:
--   * Published migrations are append-only. NEVER edit this file after deploy;
--     add 002_*.sql, 003_*.sql for any change.
--   * Everything IF NOT EXISTS / DROP IF EXISTS + CREATE, so re-running on an
--     existing DB is a no-op.
--   * No DO $$ ... $$ blocks — the migration runner splits on ; and would
--     break dollar-quoted bodies.

-- attachments: binary files stored inline as BYTEA. Business tables reference
-- id. BYTEA (not Large Object) so no `lo` extension is needed — the sandbox dev
-- PG (PGlite) does not bundle it — and the same code runs in sandbox and prod.
-- Deleting a row frees the bytes automatically.
CREATE TABLE IF NOT EXISTS attachments (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL,
  sha256       TEXT UNIQUE,
  owner_id     UUID,
  content      BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
