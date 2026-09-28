-- 002_bomb.sql — 秋招拆弹器 R1 业务表
-- 规则：全部 IF NOT EXISTS，可重复执行；不用 DO $$ 块；不 CREATE EXTENSION。

-- 用户：用户名+密码（scrypt），无邮箱/验证/找回（R1 冻结口径）
CREATE TABLE IF NOT EXISTS users (
  id         BIGSERIAL PRIMARY KEY,
  username   TEXT UNIQUE NOT NULL,
  pass_hash  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 应用级密钥（HMAC cookie 签名密钥等），首启生成
CREATE TABLE IF NOT EXISTS app_secrets (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 弹药库：经历 = 元信息 + bullets[{id,text,source,status}]
-- 事实纪律：只有 status IN ('confirmed','edited') 的 bullet 才能进 AI Context（服务端 SQL 过滤）
CREATE TABLE IF NOT EXISTS experiences (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL DEFAULT 'other',
  title      TEXT NOT NULL,
  org        TEXT NOT NULL DEFAULT '',
  period     TEXT NOT NULL DEFAULT '',
  skills     JSONB NOT NULL DEFAULT '[]',
  bullets    JSONB NOT NULL DEFAULT '[]',
  origin     TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_experiences_user ON experiences(user_id);

-- JD：raw_text + 状态；analysis 本体存 jd_analyses，这里只存当前版本指针
CREATE TABLE IF NOT EXISTS jds (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company             TEXT NOT NULL,
  position            TEXT NOT NULL,
  category            TEXT NOT NULL DEFAULT '',
  raw_text            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',   -- pending|analyzing|done|failed
  error_msg           TEXT,
  current_analysis_id BIGINT,
  current_version     INT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  analyzed_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_jds_user ON jds(user_id);

-- JD 拆弹历史版本：每次拆弹（含 reanalyze）insert 新版本，历史永不修改
-- R2 的 interview_records 必须引用「当时实际使用的 analysis_id」
CREATE TABLE IF NOT EXISTS jd_analyses (
  id            BIGSERIAL PRIMARY KEY,
  jd_id         BIGINT NOT NULL REFERENCES jds(id) ON DELETE CASCADE,
  version       INT NOT NULL,
  analysis_json JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (jd_id, version)
);

-- 投递记录：jd_id 可空（快速记投递）；状态枚举在应用层校验
CREATE TABLE IF NOT EXISTS applications (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jd_id          BIGINT REFERENCES jds(id) ON DELETE SET NULL,
  company        TEXT NOT NULL,
  position       TEXT NOT NULL,
  channel        TEXT NOT NULL DEFAULT '',
  applied_at     DATE,
  current_status TEXT NOT NULL DEFAULT 'applied',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_applications_user ON applications(user_id);

-- 投递状态流水：状态变更留痕，看板/漏斗的数据源
CREATE TABLE IF NOT EXISTS app_events (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL,
  application_id BIGINT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_status    TEXT,
  to_status      TEXT NOT NULL,
  happened_at    TIMESTAMPTZ NOT NULL,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_app_events_user ON app_events(user_id);
CREATE INDEX IF NOT EXISTS idx_app_events_app ON app_events(application_id);
