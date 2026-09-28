// 秋招拆弹器 R1 — Express 后端
// 铁律（FREEZE-R1.md）：
//   1. 只有 confirmed/edited 的 bullet 才能进 AI Context（getConfirmedFacts 是唯一入口，SQL 层过滤）
//   2. 所有资源查询强制 WHERE user_id（多用户隔离）
//   3. AI 输出的 fact_refs 服务端二次校验，无效 → ungrounded 降级
//   4. 无总分，只有 capability 粒度 coverage
//   5. 每次拆弹 insert jd_analyses 新版本，历史永不修改
//   6. 预测问题 ID：jd:{jd_id}:a:{version}:q:{n}，服务端生成后随版本固化

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const db = require("../guard_sdk/db");
const ai = require("../guard_sdk/ai");

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));

const STATIC_DIR = path.resolve(__dirname, "..", "static");
const COOKIE_NAME = "bomb_session";
const COOKIE_TTL_MS = 30 * 24 * 3600 * 1000;

const APP_STATUSES = ["applied", "written_test", "interview_1", "interview_2", "interview_3", "offer", "rejected", "withdrawn"];
const STAGE_ORDER = ["applied", "written_test", "interview_1", "interview_2", "interview_3", "offer"];
const EXP_TYPES = ["internship", "project", "research", "campus", "competition", "other"];

// ---------------------------------------------------------------- helpers ---
// 导出仅供测试使用（require.main 守卫见文件末尾）
module.exports = { getConfirmedFacts, validateFactRefs, groundAnalysis, validateAnalysis };

// URL 参数整数化：非法（非正整数）返回 null，路由层转 404，避免 NaN 打崩 SQL
function intParam(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const bad = (res, code, msg) => res.status(code).json({ error: msg });
const ok = (res, data) => res.json(data);

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`AI 调用超时（${ms / 1000}s）`)), ms)),
  ]);
}

function newBulletId() {
  return crypto.randomBytes(3).toString("hex");
}

// ---------------------------------------------------------------- secrets ---

let _sessionSecret = null;
async function getSessionSecret() {
  if (_sessionSecret) return _sessionSecret;
  const pool = db.getPool();
  const value = crypto.randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO app_secrets(key, value) VALUES ('session_secret', $1) ON CONFLICT (key) DO NOTHING",
    [value]
  );
  const { rows } = await pool.query("SELECT value FROM app_secrets WHERE key='session_secret'");
  _sessionSecret = rows[0].value;
  return _sessionSecret;
}

// ------------------------------------------------------------------- auth ---

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const N = 16384, r = 8, p = 1;
  const hash = crypto.scryptSync(password, salt, 64, { N, r, p }).toString("hex");
  return `scrypt$${N}$${r}$${p}$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, salt, hash] = stored.split("$");
    if (alg !== "scrypt") return false;
    const calc = crypto.scryptSync(password, salt, 64, { N: +N, r: +r, p: +p });
    const expect = Buffer.from(hash, "hex");
    return calc.length === expect.length && crypto.timingSafeEqual(calc, expect);
  } catch {
    return false;
  }
}

function signPayload(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, req, userId) {
  const exp = Date.now() + COOKIE_TTL_MS;
  const payload = `${userId}.${exp}`;
  getSessionSecret().then((secret) => {
    const token = `${payload}.${signPayload(secret, payload)}`;
    res.append(
      "Set-Cookie",
      `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_TTL_MS / 1000}` +
        (req.secure ? "; Secure" : "")
    );
    res.json({ user: { id: userId, username: res.locals.username } });
  });
}

function clearSessionCookie(res) {
  res.append("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// requireAuth: 校验 HMAC 签名 cookie + 用户存在，挂 req.userId
async function requireAuth(req, res, next) {
  try {
    const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!raw) return bad(res, 401, "未登录");
    const parts = raw.split(".");
    if (parts.length !== 3) return bad(res, 401, "会话无效");
    const [uid, exp, sig] = parts;
    const secret = await getSessionSecret();
    const expect = signPayload(secret, `${uid}.${exp}`);
    if (sig !== expect || +exp < Date.now()) return bad(res, 401, "会话已过期，请重新登录");
    const { rows } = await db
      .getPool()
      .query("SELECT id, username FROM users WHERE id=$1", [uid]);
    if (!rows.length) return bad(res, 401, "用户不存在");
    req.user = rows[0];
    req.userId = rows[0].id;
    next();
  } catch (e) {
    next(e);
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ------------------------------------------------------- 事实纪律（核心） ---

// 唯一的 AI 上下文构建入口：只取 confirmed/edited 的 bullet（SQL 层物理过滤）
async function getConfirmedFacts(userId) {
  const { rows } = await db
    .getPool()
    .query("SELECT id, type, title, org, period, skills, bullets FROM experiences WHERE user_id=$1 ORDER BY created_at", [userId]);
  const facts = [];
  for (const exp of rows) {
    const bullets = (exp.bullets || []).filter((b) => b.status === "confirmed" || b.status === "edited");
    if (!bullets.length) continue;
    facts.push({
      exp_id: exp.id, type: exp.type, title: exp.title, org: exp.org,
      period: exp.period, skills: exp.skills || [], bullets,
    });
  }
  return facts;
}

// fact_refs 二次校验：返回 {valid:Set, invalid:Set}
async function validateFactRefs(userId, refs) {
  const facts = await getConfirmedFacts(userId);
  const valid = new Set();
  for (const f of facts) for (const b of f.bullets) valid.add(`exp:${f.exp_id}:${b.id}`);
  const uniq = [...new Set(refs.filter((r) => typeof r === "string" && r.trim()))];
  const validSet = new Set(uniq.filter((r) => valid.has(r)));
  const invalidSet = new Set(uniq.filter((r) => !valid.has(r)));
  return { valid: validSet, invalid: invalidSet };
}

// 遍历 analysis 中所有带 fact_refs 的条目：无效引用移入 invalid_fact_refs 并打 ungrounded
async function groundAnalysis(userId, analysis) {
  const allRefs = [];
  const items = [];
  for (const m of analysis.mappings || []) if (Array.isArray(m.fact_refs)) { items.push(m); allRefs.push(...m.fact_refs); }
  for (const r of analysis.risks || []) if (Array.isArray(r.fact_refs)) { items.push(r); allRefs.push(...r.fact_refs); }
  for (const q of (analysis.interview_map && analysis.interview_map.predicted_questions) || [])
    if (Array.isArray(q.fact_refs)) { items.push(q); allRefs.push(...q.fact_refs); }
  if (!items.length) return analysis;
  const { valid, invalid } = await validateFactRefs(userId, allRefs);
  for (const item of items) {
    const badRefs = item.fact_refs.filter((r) => invalid.has(r));
    if (badRefs.length) {
      item.invalid_fact_refs = badRefs;
      item.fact_refs = item.fact_refs.filter((r) => valid.has(r));
      item.ungrounded = true;
    }
  }
  return analysis;
}

function formatFactsForPrompt(facts) {
  if (!facts.length) return "（空——用户还没有确认过任何经历事实。mappings 全部给 none，fact_refs 全部留空，risks 要包含「经历空白」相关风险。）";
  const lines = [];
  for (const f of facts) {
    lines.push(`- 经历 #${f.exp_id}（${f.type} · ${f.title} · ${f.org || "无组织名"} · ${f.period || "时间未知"}）`);
    for (const b of f.bullets) lines.push(`  · exp:${f.exp_id}:${b.id} —— ${b.text}`);
    if (f.skills.length) lines.push(`  技能：${f.skills.join("、")}`);
  }
  return lines.join("\n");
}

// ------------------------------------------------------------- AI 调用层 ---

function extractJSON(text) {
  if (!text) throw new Error("AI 返回为空");
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("AI 返回中没有 JSON 对象");
  return JSON.parse(t.slice(s, e + 1));
}

async function callAIJSON(system, userContent, { maxTokens = 8000, timeoutMs = 120000 } = {}) {
  const attempt = async (extraHint) => {
    const content = extraHint ? `${userContent}\n\n【上次输出的问题】${extraHint}\n请修正后重新只输出 JSON。` : userContent;
    const text = await withTimeout(
      ai.chat([{ role: "user", content }], { system, maxTokens }),
      timeoutMs
    );
    return extractJSON(text);
  };
  let out;
  try {
    out = await attempt(null);
  } catch (e1) {
    out = await attempt(e1.message.slice(0, 300)); // 重试 1 次（FREEZE §4.4）
  }
  return out;
}

// ---- AI-① 简历提取 ----
const EXTRACT_SYSTEM = `你是简历结构化助手。任务：把用户粘贴的简历全文拆解为结构化经历数据。
严格纪律：
1. 只输出一个 JSON 对象，不要输出任何解释、markdown 代码块或其他文本。
2. bullets 中每一条必须是独立、可验证的事实点（做了什么/结果是什么），拆得越细越好，每条不超过 40 字。
3. 简历原文能直接找到的内容用 source="ai_extracted"；你根据上下文推断或补全的内容用 source="ai_inferred"（尽量少用）。
4. 绝不编造：原文没有的数字、成果、职务一律不得出现。宁可少拆，不可编造。
5. period 尽量统一为 "YYYY.MM-YYYY.MM" 或 "YYYY.MM-至今"。
输出 JSON Schema（严格遵循）：
{"experiences":[{"type":"internship|project|research|campus|competition|other","title":"经历名称","org":"组织/公司","period":"时间段","bullets":[{"text":"事实点","source":"ai_extracted|ai_inferred"}],"skills":["技能"]}],"warnings":["存疑提示"]}
warnings 用于提示哪些内容存疑或缺少信息，没有则为空数组。`;

function validateExtraction(obj) {
  if (!obj || !Array.isArray(obj.experiences) || !obj.experiences.length)
    throw new Error("返回缺少 experiences 数组");
  const out = [];
  for (const e of obj.experiences) {
    if (!e || typeof e.title !== "string" || !e.title.trim()) continue;
    const bullets = [];
    for (const b of e.bullets || []) {
      if (!b || typeof b.text !== "string" || !b.text.trim()) continue;
      bullets.push({
        id: newBulletId(),
        text: b.text.trim().slice(0, 200),
        source: b.source === "ai_inferred" ? "ai_inferred" : "ai_extracted",
        status: "pending",
      });
    }
    if (!bullets.length) continue;
    out.push({
      type: EXP_TYPES.includes(e.type) ? e.type : "other",
      title: e.title.trim().slice(0, 120),
      org: String(e.org || "").trim().slice(0, 120),
      period: String(e.period || "").trim().slice(0, 60),
      skills: Array.isArray(e.skills) ? e.skills.filter((s) => typeof s === "string").map((s) => s.trim().slice(0, 30)).slice(0, 15) : [],
      bullets,
    });
  }
  if (!out.length) throw new Error("没有解析出任何有效经历");
  return { experiences: out, warnings: Array.isArray(obj.warnings) ? obj.warnings.slice(0, 10) : [] };
}

// ---- AI-② JD 拆弹 ----
const ANALYSIS_SYSTEM = `你是校招面试拆弹专家。任务：基于 JD 原文和用户「已确认事实库」，输出面试拆弹报告。
事实纪律（最高优先级）：
1. fact_refs 只能引用【用户已确认事实库】中列出的条目，格式必须是 "exp:经历ID:bulletID"（事实库已给出每条完整引用 ID）。事实库中不存在的内容绝不能出现在 fact_refs 里。
2. 某个判断没有事实支撑时，fact_refs 留空数组，并在 inference 里说明这是基于 JD 的推断。
3. 不得编造 JD 没有的要求；jd_evidence 必须是 JD 原文的直接引用，每条不超过 40 字。
4. 禁止输出总体匹配度分数。匹配度只体现在 mappings 的 coverage（strong/partial/none），且必须逐项给依据。
5. predicted_questions 的 question 必须像真实面试官的中文口语问法，具体到细节（如"你刚才说的 30% 是怎么测出来的"），不要泛泛的"请介绍一下你自己"。
只输出一个 JSON 对象，不要任何解释或 markdown。输出 JSON Schema：
{"capabilities":[{"id":"cap:1","name":"能力名","jd_evidence":["JD原文引用"],"importance":"high|medium|low","inference":"从JD哪里推出这项能力"}],
"mappings":[{"capability_id":"cap:1","fact_refs":["exp:12:9f2a"],"coverage":"strong|partial|none","inference":"用户经历如何支撑该能力","suggestion":"建议如何准备/怎么讲"}],
"risks":[{"id":"risk:1","title":"风险名","jd_evidence":["JD原文引用"],"capability_id":"cap:1","severity":"high|medium|low","fact_refs":[],"inference":"为什么这是高风险点","suggestion":"如何排雷"}],
"interview_map":{"predicted_questions":[{"question":"面试官问法","risk_id":"risk:1","capability_id":"cap:1","difficulty":"easy|medium|hard","fact_refs":["exp:12:9f2a"],"inference":"为什么会问这个问题（JD要求×经历现状）","followups":["追问1","追问2"]}]}}
数量要求：capabilities 3-6 项；每个 capability 恰好一条 mapping；risks 2-5 个（优先「JD 高要求 × 事实库薄弱/空白」的交叉点，以及量化成果被深挖的风险）；predicted_questions 10-15 条，必须覆盖所有 high 级 risk，且每个 capability 至少一条，每条带 1-3 个 followups。`;

function validateAnalysis(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object") throw new Error("返回不是 JSON 对象");
  if (!Array.isArray(obj.capabilities) || obj.capabilities.length < 2)
    errors.push("capabilities 至少 2 项");
  if (!Array.isArray(obj.mappings)) errors.push("缺少 mappings");
  if (!Array.isArray(obj.risks) || obj.risks.length < 1) errors.push("risks 至少 1 项");
  if (!obj.interview_map || !Array.isArray(obj.interview_map.predicted_questions) || obj.interview_map.predicted_questions.length < 3)
    errors.push("predicted_questions 至少 3 条");
  if (errors.length) throw new Error(errors.join("；"));

  const str = (v, d = "") => (typeof v === "string" ? v.trim() : d);
  const enums = (v, list, d) => (list.includes(v) ? v : d);

  const capabilities = obj.capabilities.map((c, i) => ({
    id: str(c.id) || `cap:${i + 1}`,
    name: str(c.name, `能力${i + 1}`).slice(0, 40),
    jd_evidence: (Array.isArray(c.jd_evidence) ? c.jd_evidence : []).filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim().slice(0, 80)).slice(0, 3),
    importance: enums(c.importance, ["high", "medium", "low"], "medium"),
    inference: str(c.inference).slice(0, 300),
  }));
  const capIds = new Set(capabilities.map((c) => c.id));

  const mappings = obj.mappings
    .map((m) => ({
      capability_id: str(m.capability_id),
      fact_refs: Array.isArray(m.fact_refs) ? m.fact_refs.filter((r) => typeof r === "string") : [],
      coverage: enums(m.coverage, ["strong", "partial", "none"], "none"),
      inference: str(m.inference).slice(0, 300),
      suggestion: str(m.suggestion).slice(0, 300),
    }))
    .filter((m) => capIds.has(m.capability_id));
  if (!mappings.length) throw new Error("mappings 全部无效（capability_id 对不上）");

  const riskIds = new Set();
  const risks = obj.risks.map((r, i) => {
    const id = str(r.id) || `risk:${i + 1}`;
    riskIds.add(id);
    return {
      id,
      title: str(r.title, `风险${i + 1}`).slice(0, 60),
      jd_evidence: (Array.isArray(r.jd_evidence) ? r.jd_evidence : []).filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim().slice(0, 80)).slice(0, 3),
      capability_id: capIds.has(r.capability_id) ? r.capability_id : null,
      severity: enums(r.severity, ["high", "medium", "low"], "medium"),
      fact_refs: Array.isArray(r.fact_refs) ? r.fact_refs.filter((r2) => typeof r2 === "string") : [],
      inference: str(r.inference).slice(0, 300),
      suggestion: str(r.suggestion).slice(0, 300),
    };
  });

  const questions = obj.interview_map.predicted_questions
    .map((q) => ({
      question: str(q.question).slice(0, 200),
      risk_id: riskIds.has(q.risk_id) ? q.risk_id : null,
      capability_id: capIds.has(q.capability_id) ? q.capability_id : null,
      difficulty: enums(q.difficulty, ["easy", "medium", "hard"], "medium"),
      fact_refs: Array.isArray(q.fact_refs) ? q.fact_refs.filter((r) => typeof r === "string") : [],
      inference: str(q.inference).slice(0, 300),
      followups: (Array.isArray(q.followups) ? q.followups : []).filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim().slice(0, 150)).slice(0, 4),
    }))
    .filter((q) => q.question);
  if (questions.length < 3) throw new Error("有效 predicted_questions 不足 3 条");

  return { capabilities, mappings, risks, interview_map: { predicted_questions: questions } };
}

// 拆弹主流程：AI → 校验 → grounding → 版本固化（事务）
async function runAnalysis(jdId, userId) {
  const pool = db.getPool();
  const { rows: jdRows } = await pool.query(
    "SELECT id, company, position, category, raw_text FROM jds WHERE id=$1 AND user_id=$2",
    [jdId, userId]
  );
  if (!jdRows.length) throw Object.assign(new Error("JD 不存在"), { status: 404 });
  const jd = jdRows[0];

  await pool.query("UPDATE jds SET status='analyzing', error_msg=NULL WHERE id=$1", [jdId]);
  try {
    const facts = await getConfirmedFacts(userId);
    const userContent = [
      `【岗位信息】公司：${jd.company} ｜ 职位：${jd.position} ｜ 类别：${jd.category || "未分类"}`,
      `【JD 原文】\n${jd.raw_text}`,
      `【用户已确认事实库】\n${formatFactsForPrompt(facts)}`,
    ].join("\n\n");

    const raw = await callAIJSON(ANALYSIS_SYSTEM, userContent, { maxTokens: 8000, timeoutMs: 150000 });
    const analysis = validateAnalysis(raw);
    await groundAnalysis(userId, analysis);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: vRows } = await client.query(
        "SELECT COALESCE(MAX(version),0)+1 AS v FROM jd_analyses WHERE jd_id=$1",
        [jdId]
      );
      const version = vRows[0].v;
      analysis.interview_map.predicted_questions.forEach((q, i) => {
        q.id = `q:${i + 1}`;
        q.prediction_id = `jd:${jdId}:a:${version}:q:${i + 1}`;
      });
      analysis.meta = { jd_id: jdId, version, generated_at: new Date().toISOString(), confirmed_fact_count: facts.length };

      const { rows: aRows } = await client.query(
        "INSERT INTO jd_analyses(jd_id, version, analysis_json) VALUES ($1,$2,$3) RETURNING id",
        [jdId, version, JSON.stringify(analysis)]
      );
      await client.query(
        "UPDATE jds SET status='done', current_analysis_id=$1, current_version=$2, analyzed_at=now(), error_msg=NULL WHERE id=$3",
        [aRows[0].id, version, jdId]
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    const msg = String(e.message || e).slice(0, 500);
    await pool.query("UPDATE jds SET status='failed', error_msg=$1 WHERE id=$2", [msg, jdId]);
    throw Object.assign(new Error(`拆弹失败：${msg}`), { status: 502 });
  }
}

async function jdDetail(jdId, userId) {
  const { rows } = await db.getPool().query(
    `SELECT j.id, j.company, j.position, j.category, j.status, j.error_msg,
            j.current_version, j.created_at, j.analyzed_at,
            a.id AS analysis_id, a.version AS analysis_version, a.analysis_json, a.created_at AS analysis_created_at
     FROM jds j LEFT JOIN jd_analyses a ON a.id = j.current_analysis_id
     WHERE j.id=$1 AND j.user_id=$2`,
    [jdId, userId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r.id, company: r.company, position: r.position, category: r.category,
    status: r.status, error_msg: r.error_msg,
    current_version: r.current_version, created_at: r.created_at, analyzed_at: r.analyzed_at,
    analysis: r.analysis_json || null,
  };
}

// ------------------------------------------------------------------ auth API --

app.post("/api/auth/register", wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const uname = String(username || "").trim();
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,24}$/.test(uname))
    return bad(res, 400, "用户名需 2-24 位（中文/字母/数字/下划线）");
  if (typeof password !== "string" || password.length < 6)
    return bad(res, 400, "密码至少 6 位");
  const pool = db.getPool();
  const { rows: dup } = await pool.query("SELECT 1 FROM users WHERE username=$1", [uname]);
  if (dup.length) return bad(res, 409, "用户名已被占用");
  const { rows } = await pool.query(
    "INSERT INTO users(username, pass_hash) VALUES ($1,$2) RETURNING id",
    [uname, hashPassword(password)]
  );
  res.locals.username = uname;
  setSessionCookie(res, req, rows[0].id);
}));

app.post("/api/auth/login", wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const uname = String(username || "").trim();
  const { rows } = await db
    .getPool()
    .query("SELECT id, username, pass_hash FROM users WHERE username=$1", [uname]);
  if (!rows.length || !verifyPassword(String(password || ""), rows[0].pass_hash))
    return bad(res, 401, "用户名或密码错误");
  res.locals.username = rows[0].username;
  setSessionCookie(res, req, rows[0].id);
}));

app.post("/api/auth/logout", (req, res) => {
  clearSessionCookie(res);
  ok(res, { ok: true });
});

app.get("/api/auth/me", requireAuth, (req, res) => ok(res, { user: req.user }));

// ---------------------------------------------------------- experiences API --

const EXP_COLS = "id, type, title, org, period, skills, bullets, origin, created_at, updated_at";

app.get("/api/experiences", requireAuth, wrap(async (req, res) => {
  const { rows } = await db
    .getPool()
    .query(`SELECT ${EXP_COLS} FROM experiences WHERE user_id=$1 ORDER BY created_at DESC`, [req.userId]);
  ok(res, { experiences: rows });
}));

function normalizeManualBullets(arr) {
  const out = [];
  const ids = new Set();
  for (const b of arr || []) {
    const text = typeof b === "string" ? b.trim() : typeof b?.text === "string" ? b.text.trim() : "";
    if (!text) continue;
    let id = newBulletId();
    while (ids.has(id)) id = newBulletId();
    ids.add(id);
    out.push({ id, text: text.slice(0, 200), source: "user_typed", status: "confirmed" });
  }
  return out;
}

app.post("/api/experiences", requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || "").trim();
  if (!title) return bad(res, 400, "经历名称不能为空");
  const bullets = normalizeManualBullets(b.bullets);
  if (!bullets.length) return bad(res, 400, "至少填写一条事实要点");
  const { rows } = await db.getPool().query(
    `INSERT INTO experiences(user_id, type, title, org, period, skills, bullets, origin)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'manual') RETURNING ${EXP_COLS}`,
    [
      req.userId,
      EXP_TYPES.includes(b.type) ? b.type : "other",
      title.slice(0, 120),
      String(b.org || "").trim().slice(0, 120),
      String(b.period || "").trim().slice(0, 60),
      JSON.stringify(Array.isArray(b.skills) ? b.skills.slice(0, 15) : []),
      JSON.stringify(bullets),
    ]
  );
  ok(res, { experience: rows[0] });
}));

// AI-①：简历全文 → 经历草稿（全部 pending）
app.post("/api/experiences/import", requireAuth, wrap(async (req, res) => {
  const resumeText = String((req.body || {}).resume_text || "").trim();
  if (resumeText.length < 30) return bad(res, 400, "简历内容太短（至少 30 字）");
  if (resumeText.length > 60000) return bad(res, 400, "简历内容过长（上限 6 万字）");

  const raw = await callAIJSON(EXTRACT_SYSTEM, `【简历全文】\n${resumeText}`, { maxTokens: 8000, timeoutMs: 120000 });
  const parsed = validateExtraction(raw);

  const pool = db.getPool();
  const client = await pool.connect();
  const created = [];
  try {
    await client.query("BEGIN");
    for (const e of parsed.experiences) {
      const { rows } = await client.query(
        `INSERT INTO experiences(user_id, type, title, org, period, skills, bullets, origin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'resume_import') RETURNING ${EXP_COLS}`,
        [req.userId, e.type, e.title, e.org, e.period, JSON.stringify(e.skills), JSON.stringify(e.bullets)]
      );
      created.push(rows[0]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw e;
  }
  client.release();
  ok(res, { experiences: created, warnings: parsed.warnings });
}));

app.put("/api/experiences/:id", requireAuth, wrap(async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return bad(res, 404, "资源不存在");
  const pool = db.getPool();
  const { rows: cur } = await pool.query(
    "SELECT * FROM experiences WHERE id=$1 AND user_id=$2", [id, req.userId]
  );
  if (!cur.length) return bad(res, 404, "经历不存在");
  const b = req.body || {};
  const title = String(b.title ?? cur[0].title).trim();
  if (!title) return bad(res, 400, "经历名称不能为空");

  // 语义（FREEZE）：text 变更 → status='edited'；新增 bullet → user_typed+confirmed；未变 → 原样
  const oldMap = new Map((cur[0].bullets || []).map((x) => [x.id, x]));
  const ids = new Set();
  const bullets = [];
  for (const ib of b.bullets || []) {
    const text = String(ib?.text ?? "").trim();
    if (!text) continue;
    if (ib?.id && oldMap.has(ib.id)) {
      const old = oldMap.get(ib.id);
      bullets.push({
        id: old.id, text: text.slice(0, 200), source: old.source,
        status: text === old.text ? old.status : "edited",
      });
      ids.add(old.id);
    } else {
      let nid = newBulletId();
      while (ids.has(nid)) nid = newBulletId();
      ids.add(nid);
      bullets.push({ id: nid, text: text.slice(0, 200), source: "user_typed", status: "confirmed" });
    }
  }
  if (!bullets.length) return bad(res, 400, "至少保留一条事实要点");

  const { rows } = await pool.query(
    `UPDATE experiences SET type=$3, title=$4, org=$5, period=$6, skills=$7, bullets=$8, updated_at=now()
     WHERE id=$1 AND user_id=$2 RETURNING ${EXP_COLS}`,
    [
      id, req.userId,
      EXP_TYPES.includes(b.type) ? b.type : cur[0].type,
      title.slice(0, 120),
      String(b.org ?? cur[0].org).trim().slice(0, 120),
      String(b.period ?? cur[0].period).trim().slice(0, 60),
      JSON.stringify(Array.isArray(b.skills) ? b.skills.slice(0, 15) : []),
      JSON.stringify(bullets),
    ]
  );
  ok(res, { experience: rows[0] });
}));

// 单条 bullet 状态操作：confirm / reject / edit
app.patch("/api/experiences/:id/bullets/:bulletId", requireAuth, wrap(async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return bad(res, 404, "资源不存在");
  const bulletId = String(req.params.bulletId);
  const { action, text } = req.body || {};
  const pool = db.getPool();
  const { rows: cur } = await pool.query(
    "SELECT bullets FROM experiences WHERE id=$1 AND user_id=$2", [id, req.userId]
  );
  if (!cur.length) return bad(res, 404, "经历不存在");
  const bullets = cur[0].bullets || [];
  const idx = bullets.findIndex((x) => x.id === bulletId);
  if (idx < 0) return bad(res, 404, "事实点不存在");

  if (action === "confirm") bullets[idx].status = "confirmed";
  else if (action === "reject") bullets[idx].status = "rejected";
  else if (action === "edit") {
    const t = String(text ?? "").trim();
    if (!t) return bad(res, 400, "内容不能为空");
    bullets[idx].text = t.slice(0, 200);
    bullets[idx].status = "edited";
  } else return bad(res, 400, "action 必须是 confirm/reject/edit");

  const { rows } = await pool.query(
    `UPDATE experiences SET bullets=$3, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING ${EXP_COLS}`,
    [id, req.userId, JSON.stringify(bullets)]
  );
  ok(res, { experience: rows[0] });
}));

app.delete("/api/experiences/:id", requireAuth, wrap(async (req, res) => {
  const { rowCount } = await db
    .getPool()
    .query("DELETE FROM experiences WHERE id=$1 AND user_id=$2", [intParam(req.params.id), req.userId]);
  if (!rowCount) return bad(res, 404, "经历不存在");
  ok(res, { ok: true });
}));

// ------------------------------------------------------------------ jds API --

app.get("/api/jds", requireAuth, wrap(async (req, res) => {
  const { rows } = await db
    .getPool()
    .query(
      `SELECT id, company, position, category, status, current_version, created_at, analyzed_at
       FROM jds WHERE user_id=$1 ORDER BY created_at DESC`,
      [req.userId]
    );
  ok(res, { jds: rows });
}));

app.post("/api/jds", requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const company = String(b.company || "").trim();
  const position = String(b.position || "").trim();
  const rawText = String(b.raw_text || "").trim();
  if (!company || !position) return bad(res, 400, "公司和职位不能为空");
  if (rawText.length < 50) return bad(res, 400, "JD 原文太短（至少 50 字）");

  const { rows } = await db
    .getPool()
    .query(
      `INSERT INTO jds(user_id, company, position, category, raw_text)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [req.userId, company.slice(0, 120), position.slice(0, 120), String(b.category || "").trim().slice(0, 40), rawText.slice(0, 30000)]
    );
  const jdId = rows[0].id;
  let analysisError = null;
  try {
    await runAnalysis(jdId, req.userId);
  } catch (e) {
    analysisError = e.message; // JD 已创建，拆弹失败 → failed 状态可重试
  }
  const detail = await jdDetail(jdId, req.userId);
  ok(res, { jd: detail, analysis_error: analysisError });
}));

app.get("/api/jds/:id", requireAuth, wrap(async (req, res) => {
  const detail = await jdDetail(intParam(req.params.id), req.userId);
  if (!detail) return bad(res, 404, "JD 不存在");
  ok(res, { jd: detail });
}));

app.post("/api/jds/:id/reanalyze", requireAuth, wrap(async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return bad(res, 404, "资源不存在");
  await runAnalysis(id, req.userId); // 404/502 由错误处理给出
  const detail = await jdDetail(id, req.userId);
  ok(res, { jd: detail });
}));

app.delete("/api/jds/:id", requireAuth, wrap(async (req, res) => {
  const { rowCount } = await db
    .getPool()
    .query("DELETE FROM jds WHERE id=$1 AND user_id=$2", [intParam(req.params.id), req.userId]);
  if (!rowCount) return bad(res, 404, "JD 不存在");
  ok(res, { ok: true });
}));

// --------------------------------------------------------- applications API --

app.get("/api/applications", requireAuth, wrap(async (req, res) => {
  const { rows } = await db.getPool().query(
    `SELECT a.id, a.company, a.position, a.channel, a.applied_at, a.current_status,
            a.created_at, a.jd_id, j.company AS jd_company, j.position AS jd_position
     FROM applications a LEFT JOIN jds j ON j.id = a.jd_id
     WHERE a.user_id=$1 ORDER BY a.created_at DESC`,
    [req.userId]
  );
  ok(res, { applications: rows });
}));

app.post("/api/applications", requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const pool = db.getPool();

  let company = String(b.company || "").trim();
  let position = String(b.position || "").trim();
  let jdId = null;

  if (b.jd_id != null) {
    const jdNum = Number(b.jd_id);
    if (!Number.isInteger(jdNum) || jdNum <= 0) return bad(res, 404, "JD 不存在");
    const { rows: jdRows } = await pool.query(
      "SELECT id, company, position FROM jds WHERE id=$1 AND user_id=$2", [jdNum, req.userId]
    );
    if (!jdRows.length) return bad(res, 404, "JD 不存在");
    jdId = jdRows[0].id;
    company = company || jdRows[0].company;
    position = position || jdRows[0].position;
  }
  if (!company || !position) return bad(res, 400, "公司和职位不能为空");

  const appliedAt = /^\d{4}-\d{2}-\d{2}$/.test(String(b.applied_at || "")) ? b.applied_at : null;
  const channel = String(b.channel || "").trim().slice(0, 40);
  const when = appliedAt ? `${appliedAt} 12:00:00+08` : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO applications(user_id, jd_id, company, position, channel, applied_at, current_status)
       VALUES ($1,$2,$3,$4,$5,$6,'applied') RETURNING id`,
      [req.userId, jdId, company.slice(0, 120), position.slice(0, 120), channel, appliedAt]
    );
    await client.query(
      `INSERT INTO app_events(user_id, application_id, from_status, to_status, happened_at, note)
       VALUES ($1,$2,NULL,'applied',COALESCE($3, now()),'创建投递记录')`,
      [req.userId, rows[0].id, when]
    );
    await client.query("COMMIT");
    ok(res, { id: rows[0].id });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

app.get("/api/applications/:id", requireAuth, wrap(async (req, res) => {
  const pool = db.getPool();
  const { rows } = await pool.query(
    `SELECT a.*, j.company AS jd_company, j.position AS jd_position
     FROM applications a LEFT JOIN jds j ON j.id=a.jd_id
     WHERE a.id=$1 AND a.user_id=$2`,
    [intParam(req.params.id), req.userId]
  );
  if (!rows.length) return bad(res, 404, "投递记录不存在");
  const { rows: events } = await pool.query(
    "SELECT id, from_status, to_status, happened_at, note FROM app_events WHERE application_id=$1 ORDER BY happened_at ASC, id ASC",
    [intParam(req.params.id)]
  );
  ok(res, { application: rows[0], events });
}));

app.post("/api/applications/:id/events", requireAuth, wrap(async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return bad(res, 404, "资源不存在");
  const b = req.body || {};
  const to = String(b.to_status || "");
  if (!APP_STATUSES.includes(to)) return bad(res, 400, `无效状态，可选：${APP_STATUSES.join(" / ")}`);
  const note = String(b.note || "").trim().slice(0, 300);
  const when = /^\d{4}-\d{2}-\d{2}/.test(String(b.happened_at || "")) ? b.happened_at : null;

  const pool = db.getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT id, current_status FROM applications WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [id, req.userId]
    );
    if (!rows.length) { await client.query("ROLLBACK"); return bad(res, 404, "投递记录不存在"); }
    if (rows[0].current_status === to) { await client.query("ROLLBACK"); return bad(res, 400, "状态未变化"); }
    await client.query(
      `INSERT INTO app_events(user_id, application_id, from_status, to_status, happened_at, note)
       VALUES ($1,$2,$3,$4,COALESCE($5, now()),$6)`,
      [req.userId, id, rows[0].current_status, to, when, note]
    );
    await client.query("UPDATE applications SET current_status=$2, updated_at=now() WHERE id=$1", [id, to]);
    await client.query("COMMIT");
    ok(res, { ok: true });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

app.patch("/api/applications/:id", requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  if (!intParam(req.params.id)) return bad(res, 404, "资源不存在");
  const sets = [];
  const vals = [];
  if (b.channel !== undefined) { vals.push(String(b.channel).trim().slice(0, 40)); sets.push(`channel=$${vals.length}`); }
  if (b.applied_at !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(b.applied_at))) { vals.push(b.applied_at); sets.push(`applied_at=$${vals.length}`); }
  if (!sets.length) return bad(res, 400, "没有可更新字段");
  sets.push("updated_at=now()");
  vals.push(intParam(req.params.id), req.userId);
  const { rowCount } = await db
    .getPool()
    .query(`UPDATE applications SET ${sets.join(", ")} WHERE id=$${vals.length - 1} AND user_id=$${vals.length}`, vals);
  if (!rowCount) return bad(res, 404, "投递记录不存在");
  ok(res, { ok: true });
}));

app.delete("/api/applications/:id", requireAuth, wrap(async (req, res) => {
  const { rowCount } = await db
    .getPool()
    .query("DELETE FROM applications WHERE id=$1 AND user_id=$2", [intParam(req.params.id), req.userId]);
  if (!rowCount) return bad(res, 404, "投递记录不存在");
  ok(res, { ok: true });
}));

// ------------------------------------------------------------------ stats API --

app.get("/api/stats/overview", requireAuth, wrap(async (req, res) => {
  const pool = db.getPool();
  const { rows: apps } = await pool.query(
    "SELECT id, current_status FROM applications WHERE user_id=$1", [req.userId]
  );
  const { rows: events } = await pool.query(
    "SELECT application_id, to_status FROM app_events WHERE user_id=$1", [req.userId]
  );
  const depth = { applied: 1, written_test: 2, interview_1: 3, interview_2: 4, interview_3: 5, offer: 6 };
  const maxDepth = new Map(); // application_id -> 最远阶段序号
  for (const e of events) {
    const d = depth[e.to_status] || 0;
    if (d > (maxDepth.get(e.application_id) || 0)) maxDepth.set(e.application_id, d);
  }
  const funnel = STAGE_ORDER.map((stage, i) => ({
    stage,
    count: [...maxDepth.values()].filter((d) => d >= i + 1).length,
  }));
  const byStatus = {};
  for (const s of APP_STATUSES) byStatus[s] = 0;
  for (const a of apps) byStatus[a.current_status] = (byStatus[a.current_status] || 0) + 1;

  const { rows: recent } = await pool.query(
    `SELECT e.id, e.to_status, e.happened_at, e.note, a.company, a.position
     FROM app_events e JOIN applications a ON a.id=e.application_id
     WHERE e.user_id=$1 ORDER BY e.happened_at DESC, e.id DESC LIMIT 12`,
    [req.userId]
  );
  ok(res, { total: apps.length, by_status: byStatus, funnel, recent_events: recent });
}));

// ------------------------------------------------------------- misc / static --

app.get(["/health", "/healthz"], async (_req, res) => {
  try {
    await db.getPool().query("SELECT 1");
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ status: "error", detail: e.message });
  }
});

// 统一错误出口：保证 JSON 响应
app.use((err, _req, res, _next) => {
  const code = err.status || 500;
  if (code >= 500) console.error("[server]", err);
  if (!res.headersSent) bad(res, code, code >= 500 ? "服务器内部错误，请稍后重试" : err.message);
});

app.use(express.static(STATIC_DIR, { index: "index.html" }));

const PORT = parseInt(process.env.APP_PORT || "3000", 10);
const HOST = process.env.APP_HOSTNAME || "0.0.0.0";
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`listening on ${HOST}:${PORT}`);
  });
}
