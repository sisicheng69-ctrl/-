# 秋招拆弹器 · R1 数据口径冻结（FREEZE v0.2）

状态：待创始人确认，确认后即为开发唯一基准 ｜ 2026-09-22
前置文档：`/workspace/docs/MVP-v0.1.md`（本文件覆盖其节奏划分）

## 0. 冻结的产品核心价值（不再更改）

**不是**「AI 帮用户分析 JD」，而是：
**事前预测 → 真实面试 → 事后验证 → 数据沉淀**

- **H1**：用户认为「基于已确认经历的针对性面试拆弹」比直接问通用 LLM 更有价值。
- **H2**：用户愿意在真实面试后回来记录实际问题，并持续使用产品。
- 任何功能不服务于 H1/H2 → 不进本轮。

## 1. 冻结：预测命中数据口径（R2 实现，口径现在冻结）

### 1.1 指标定义

- **Prediction Precision** = 被实际面试覆盖的预测问题数 / 预测问题总数
- **Interview Coverage** = 被预测覆盖的实际问题数 / 实际问题总数
- 两者都必须展示，禁止只报一个"命中率"。

### 1.2 匹配类型

- `EXACT_MATCH`：核心考察对象一致，且问法基本相同（"讲讲你的 XX 项目" vs "介绍一下你 XX 项目的经历"）
- `SEMANTIC_MATCH`：核心考察对象一致，但切入角度/问法不同（都在考"你如何处理需求变更"，一个问案例一个问方法论）
- `NO_MATCH`：实际被问、但预测未覆盖
- 判定由 LLM 完成（R1 不做），**不做文字级 diff，做语义级判定**。

### 1.3 匹配记录（存储格式，冻结）

```json
// interview_records.matches JSONB
[{
  "actual_question_id": "ir:12:q:3",
  "predicted_question_id": "jd:7:q:5",   // NO_MATCH 时为 null
  "match_type": "SEMANTIC_MATCH",
  "match_reason": "两者都在考察候选人如何量化项目收益：实际问题问'你怎么证明看板带来了转化提升'，预测问题问'你提到的30%提升是怎么测的'"
}]
```

- 匹配行以**实际问题**为主键锚点；未被引用的预测问题 = Precision 的分母差集，可推导，不单独存。
- `match_reason` 必填，前端直接展示——用户必须能看到"AI 为什么认为这是同一个考察点"。

### 1.4 稳定 ID（R1 就必须生成，R2 靠它对账）

- 预测问题：`jd:{jd_id}:a:{analysis_version}:q:{question_id}`（如 `jd:123:a:2:q:7`）
  - 同一 analysis 内 question_id 唯一（服务端按入库顺序赋号 q:1..q:n）
  - ID 生成后随 analysis_json 持久化，**前端排序/分组不改变 ID**
  - 历史 analysis 永不修改 → R2 匹配直接引用 prediction_id
- 实际问题：`ir:{record_id}:q:{n}`

### 1.5 Analysis 版本规则（冻结）

1. 每次拆弹（首次 + reanalyze）insert 一条 jd_analyses 新版本，version 递增。
2. reanalyze 不覆盖历史；jds.current_analysis_id / current_version 指向最新版。
3. **R2 的 interview_records 必须引用「当时实际使用的 analysis_id」**，命中率基于该版本的预测计算——否则无法证明"事前到底预测了什么"。
4. R1 简历导入仅「粘贴全文」，无 PDF parser。

## 2. 冻结：事实纪律（R1 实现，全部在服务端执行）

### 2.1 弹药库数据模型

```json
// experiences.bullets JSONB
[{
  "id": "b8f3c2",                      // 服务端生成的短 uuid
  "text": "独立搭建销售漏斗看板，定位转化率下降原因",
  "source": "user_typed | ai_extracted | ai_inferred",
  "status": "pending | confirmed | edited | rejected"
}]
```

`fact_refs` 全局格式：`"exp:{experience_id}:{bullet_id}"`（引用到 bullet 粒度）。

### 2.2 五条硬规则的代码落点

| 规则 | 落点 |
|---|---|
| 1. 只有 confirmed/edited 进 AI Context | 唯一上下文构建器 `getConfirmedFacts(userId)`：SQL `WHERE bullets 中 status IN ('confirmed','edited')`，所有 AI 节点只准用它 |
| 2. 服务端物理过滤 | 同上，过滤发生在 SQL，不在提示词、不在前端 |
| 3. fact_refs 必须指向真实存在且 confirmed/edited 的 bullet | AI 返回后服务端校验：解析每个 fact_refs → 查库验证；无效引用 → 该条目标记 `ungrounded: true`，前端降级渲染为「无确认事实依据的推断」，不作为结论展示 |
| 4. 无事实依据必须标 inference | AI 输出 Schema 强制：mappings/risks/questions 每条都带 `inference` 字段，无 fact_refs 时该字段必须说明推断链 |
| 5. AI 不得把 inference 写回事实库 | 唯一能写 experiences 的 AI 节点是「简历提取」，且只写 pending；mock 复盘发现的新事实（R2）也只写 pending，永不直接 confirmed |

**补充冻结**：用户手动创建/输入的内容 = `source: user_typed, status: confirmed`（用户亲手输入即确认）；AI 提取的一律 `pending` 起步。

## 3. 冻结：AI 输出三标签规范

所有 AI 结构化输出的结论条目必须包含且区分：

- `fact_refs`: []——引用用户已确认事实（可为空，但为空时见规则 4）
- `inference`: ""——AI 基于事实/上下文做出的判断及推理链
- `suggestion`: ""——AI 建议用户下一步怎么准备

前端统一渲染：事实（引用链）绿色标签 / 推断蓝色标签 / 建议橙色标签，三者永不混排。

## 4. R1 范围

### 4.1 页面清单（1 登录页 + 4 主 tab，共 7 个视图状态）

| # | 视图 | 内容 |
|---|---|---|
| 1 | 登录/注册 | 用户名+密码 |
| 2 | 弹药库 | 经历列表 + 手动新建 + 简历导入向导（粘贴→审草稿→逐条确认） |
| 3 | JD 工作台（列表） | JD 列表 + 新建 JD 表单 |
| 4 | JD 详情（拆弹报告） | 四面板：岗位能力 / 我的匹配 / 高风险点 / **Interview Map**；底部「保存为投递」「重新拆弹」 |
| 5 | 投递看板（列表） | 投递列表 + 快速记投递 + 从 JD 转投递 |
| 6 | 投递详情 | 状态时间线 + 添加状态事件 |
| 7 | 数据看板（简版） | 投递总数 / 各状态计数 / 漏斗（按最远到达阶段）/ 最近动态 |

**Interview Map 定义**：拆弹报告的预测层结构——高风险点 × 预测问题 × 追问链，按风险分组的面试预测地图。每问带 fact_refs / inference / 难度，它是 R2 命中率对照的「事前预测」存证。

### 4.2 数据库表：R1 建 6 张，R2 契约冻结 3 张

```sql
-- R1 建表
users(id BIGSERIAL PK, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, created_at TIMESTAMPTZ)
  -- pass_hash: scrypt$N$r$p$salt$hash
app_secrets(key TEXT PK, value TEXT)  -- 首次启动生成 HMAC 签名密钥
experiences(id, user_id FK→users CASCADE, type TEXT, title TEXT, org TEXT, period TEXT,
            skills JSONB, bullets JSONB, origin TEXT DEFAULT 'manual', created_at, updated_at)
  -- type: internship|project|research|campus|competition|other
  -- origin: manual|resume_import
jds(id, user_id FK CASCADE, company TEXT, position TEXT, category TEXT, raw_text TEXT,
    status TEXT DEFAULT 'pending', error_msg TEXT,
    current_analysis_id BIGINT NULL, current_version INT NULL, created_at, analyzed_at)
  -- status: pending|analyzing|done|failed；analysis 本体存 jd_analyses，jds 只存当前版本指针
jd_analyses(id BIGSERIAL PK, jd_id FK→jds CASCADE, version INT NOT NULL,
            analysis_json JSONB NOT NULL, created_at,
            UNIQUE(jd_id, version))
  -- 每次拆弹（含 reanalyze）insert 新版本，version 递增，历史永不修改/删除
applications(id, user_id FK CASCADE, jd_id FK→jds SET NULL, company TEXT, position TEXT,
             channel TEXT, applied_at DATE, current_status TEXT DEFAULT 'applied', created_at, updated_at)
  -- current_status: applied|written_test|interview_1|interview_2|interview_3|offer|rejected|withdrawn
app_events(id, user_id, application_id FK→applications CASCADE, from_status TEXT,
           to_status TEXT, happened_at TIMESTAMPTZ, note TEXT, created_at)

-- R2 契约（现在冻结 Schema，R2 再建）
interview_records(id, user_id, application_id FK CASCADE, round TEXT, interview_date DATE,
                  questions JSONB, matches JSONB, notes TEXT, created_at)
  -- questions: [{id:"ir:{rid}:q:{n}", text}]
  -- matches: 见 §1.3
  -- round: 一面|二面|三面|HR面|群面|其他
mock_sessions(id, user_id, jd_id FK CASCADE, status TEXT, messages JSONB, review JSONB,
              started_at, ended_at)
```

**漏斗口径**：每个投递取「到达过的最远阶段」（applied=1 → offer=6），漏斗各层 = 最远阶段 ≥ 该层的投递数。状态允许自由流转（录错可改），rejected/withdrawn 为终态但不回滚已到达阶段——录入错误不污染漏斗。

### 4.3 API 清单（19 个，全部 /api 前缀；除 auth 外都要求会话且 WHERE user_id）

```
POST /api/auth/register            {username, password} → 建号+发cookie
POST /api/auth/login               {username, password} → 发cookie
POST /api/auth/logout              清cookie
GET  /api/auth/me                  → {user} | 401

GET  /api/experiences              列表（含bullets及状态）
POST /api/experiences              手动新建（bullets=user_typed+confirmed）
POST /api/experiences/import       {resume_text} → AI①提取 → 只建pending草稿
PUT  /api/experiences/:id          整体编辑（bullets变更→status: edited）
PATCH /api/experiences/:id/bullets/:bulletId   单条 confirm/edit/reject
DELETE /api/experiences/:id

GET  /api/jds                      JD列表（含状态）
POST /api/jds                      {company,position,category,raw_text} → 建+同步拆弹
GET  /api/jds/:id                  详情含analysis
POST /api/jds/:id/reanalyze        弹药库更新后重拆（覆盖analysis）
DELETE /api/jds/:id

GET  /api/applications             列表（含当前状态+jd关联）
POST /api/applications             {jd_id?|company,position,channel,applied_at}
GET  /api/applications/:id         详情+事件时间线
POST /api/applications/:id/events  {to_status, happened_at, note} → 事务内改状态+记流水
PATCH /api/applications/:id        改基本字段
DELETE /api/applications/:id

GET  /api/stats/overview           {total, by_status, funnel[], recent_events[]}
```

### 4.4 AI 节点：R1 只有两个

| # | 节点 | 时机 |
|---|---|---|
| AI-① | 简历→经历草稿 | 导入向导提交时 |
| AI-② | JD 拆弹（能力/映射/风险/Interview Map 一次产出） | JD 创建或 reanalyze 时 |

R2 冻结预留：AI-③ Mock 逐轮、AI-④ Mock 复盘、AI-⑤ 命中匹配。

**调用纪律**：同步调用（MVP 不做队列）；输出先过 JSON Schema 校验，失败带错误信息重试 1 次，再失败 → `jds.status='failed'` + `error_msg`，用户可重试；全程事务，不留半成品数据。

### 4.5 AI Schema

**AI-① 简历提取**

```json
// 输入: {resume_text: string}
// 输出:
{
  "experiences": [{
    "type": "internship|project|research|campus|competition|other",
    "title": "string", "org": "string", "period": "string",
    "bullets": [{"text": "string", "source": "ai_extracted|ai_inferred"}],
    "skills": ["string"]
  }],
  "warnings": ["string"]   // 如"检测到'提升30%'缺少基线说明，已标为推断"
}
```
约束：ai_extracted 必须可回溯到原文；ai_inferred 用于上下文判断出的内容；服务端入库时全部 status=pending。

**AI-② JD 拆弹**

```json
// 输入: {jd_text, jd_meta{company,position,category},
//        confirmed_facts: getConfirmedFacts(userId) 的输出}
// 输出:
{
  "capabilities": [{
    "id": "cap:1", "name": "数据分析",
    "jd_evidence": ["JD原文引用"],
    "importance": "high|medium|low",
    "inference": "为什么从这段JD推出这项能力"
  }],
  "mappings": [{
    "capability_id": "cap:1",
    "fact_refs": ["exp:3:b8f3c2"],
    "coverage": "strong|partial|none",
    "inference": "该经历如何支撑此能力的判断",
    "suggestion": "建议怎么讲/补什么"
  }],
  "risks": [{
    "id": "risk:1", "title": "量化成果可能被深挖",
    "jd_evidence": ["JD原文引用"], "capability_id": "cap:1",
    "severity": "high|medium|low",
    "fact_refs": [], "inference": "为什么这是雷区", "suggestion": "怎么排"
  }],
  "interview_map": {
    "predicted_questions": [{
      "prediction_id": "jd:123:a:2:q:7",   // 服务端按 jd_id+version+q:n 生成后回填存储
      "question": "你提到的30%提升是怎么测量的？",
      "risk_id": "risk:1", "capability_id": "cap:1",
      "difficulty": "easy|medium|hard",
      "fact_refs": ["exp:3:b8f3c2"],
      "inference": "为什么会问（JD要求×经历现状）",
      "followups": ["追问1", "追问2"]
    }]
    // 10-15条，按风险分组展示
  }
}
```

**服务端后校验（硬规则 3 的执行）**：遍历所有 fact_refs → 解析 `exp:{id}:{bid}` → 查库验证存在且 status ∈ {confirmed, edited}；失败 → 该条目加 `ungrounded: true`，前端渲染「无确认事实依据」降级标签。**无总分，匹配度只有 capability 粒度的 strong/partial/none**，每项可点开看证据链。

### 4.6 验收测试清单（R1 Done 的定义）

1. **鉴权**：注册/登录/登出全通；错密码 401；cookie httpOnly+HMAC 签名。
2. **数据隔离**：A 账号 GET/PUT/DELETE B 账号的 experiences/jds/applications → 全部 404；API 层无一例外。
3. **事实纪律（自动化断言）**：造一条 pending bullet → 跑拆弹 → 返回的 analysis 中（含全文 JSON 递归搜索）不出现该 bullet 的任何引用。
4. **fact_refs 校验**：人为构造含伪造 ref 的 AI 返回（测试钩子）→ 该条目 ungrounded，不展示为结论。
5. **导入向导**：粘贴简历 → 草稿全部 pending → 逐条确认后变 confirmed → 未确认的直接删掉，弹药库无残留。
6. **拆弹完整性**：≥3 capabilities（各带 jd_evidence）、mappings 带 fact_refs、interview_map 10-15 问且 id 格式 `q:{n}`、无总分。
7. **reanalyze**：弹药库新增一条确认经历 → 重拆 → 新经历的 fact_refs 出现在结果中。
8. **投递流转**：从 JD 转投递（jd_id 关联）+ 快速记投递（无 JD）都通；状态变更落 app_events；改状态走事务（事件和主表一致）。
9. **看板一致**：stats/overview 的计数、漏斗与 applications/app_events 手工核算一致；漏斗按最远阶段。
10. **错误恢复**：AI 调用失败（模拟超时）→ jd.status=failed + 可读 error_msg → 重试成功 → done；无半成品 analysis。
11. **全流程 happy path**：注册→手动建经历→确认→建 JD→拆弹→看四面板→保存为投递→投递列表可见→看板计数+1。
12. **预览可用**：redcowork-preview 注册成功，端到端可操作。

## 5. R2 预告（契约已冻结，本轮不建）

Mock Interview（AI-③④）、真实面试记录、命中匹配（AI-⑤，口径见 §1）、数据分析深化。
R1 的 jds.analysis.interview_map.predicted_questions[].id 就是 R2 对账的事前存证——R1 不生成稳定 ID，R2 就对不上账，所以本表现在冻结。

## 6. 明确不做（本轮重申）

Mock 语音、复杂动画、PDF 解析、爬虫、岗位推荐、复杂预测模型、付费、社区、分享、移动端。
