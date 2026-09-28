# RESTORE — 秋招拆弹器迁移恢复指南

> 给接手的 agent：这是已通过 12 项验收的 R1 完整工程，按序恢复，**不要重构**。

## 这是什么

guard WEB_APP 工程：React SPA（`web/`，Vite 构建到 `static/`）+ Express（`app/server.js`，全部 API）+ PostgreSQL（`db/migrations/`）+ 平台 AI 网关（`guard_sdk/ai.js`）。

**动手前必读**：`SPEC-FREEZE-R1.md`（产品口径，含数据契约与事实纪律）。

核心纪律（代码里已实现，改动时别破坏）：
1. 弹药库只有 `confirmed/edited` 的 bullet 才能进 AI 上下文——`getConfirmedFacts(userId)` 是唯一入口，SQL 层过滤；
2. AI 输出的 `fact_refs` 服务端二次校验，无效引用 → `ungrounded` 降级；
3. 无总分，只有 capability 粒度 coverage；
4. `jd_analyses` 版本表只增不改；预测问题 ID `jd:{jd_id}:a:{version}:q:{n}`。

## 恢复步骤（沙箱内）

```sh
# 假设解压到 /workspace/autumn-bomber（顶层应有 install.sh/start.sh/health.sh）
cd /workspace/autumn-bomber && npm install

# 本地 PG（注意：先建目录再启动，否则 PGlite 建目录失败）
mkdir -p /workspace/.devpg/autumn-bomber
nohup redcowork-devpg --project /workspace/autumn-bomber --port 5432 > /workspace/.logs/devpg.log 2>&1 &
# 等待就绪后建表
node app/migrate.cjs && node app/seed_db.cjs

npm run build

mkdir -p /workspace/.logs
FORCE_COLOR=1 APP_PORT=3030 APP_HOSTNAME=0.0.0.0 nohup sh start.sh > /workspace/.logs/app.log 2>&1 &

# 自检（必须全过再注册预览）
curl -fsS http://127.0.0.1:3030/healthz
curl -fsS http://127.0.0.1:3030/ -o /dev/null

redcowork-preview start 3030 /workspace/autumn-bomber
```

## 环境坑（前人踩过）

- 容器里 `pkill`/`ps` 不可用（静默失败）：杀进程用 `/proc/PID/comm == node` + cmdline 匹配；
- `jq` 取值要 `-r`，否则带引号进 URL；
- AI 调用耗时：简历提取 ~10s，JD 拆弹 ~110s，前端已有等待提示；
- 上线流程读 `skills/guard-skill/SKILL.md`，别凭记忆。

## 测试账号（devpg 测试数据，非生产）

- 测试同学A / pass123（3 条经历 + JD「字节跳动·数据分析师」v1/v2 拆弹 + 2 条投递）
- 同学B / pass456（隔离验证用）
