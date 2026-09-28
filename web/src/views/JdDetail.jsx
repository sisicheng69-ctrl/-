// JD 详情：拆弹报告（岗位能力 / 我的匹配 / 高风险点 / Interview Map）
import React, { useEffect, useState } from "react";
import { api, fmtDateTime } from "../api";
import {
  Badge, COVERAGE, Empty, ErrorBanner, FactChips, LEVEL, Spinner, UngroundedNote, buildFactsIndex,
} from "../ui";

export default function JdDetail({ id, onBack, onApplied }) {
  const [jd, setJd] = useState(null);
  const [factsIdx, setFactsIdx] = useState({});
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false); // reanalyze / 转投递
  const [applied, setApplied] = useState(false);

  const load = () =>
    Promise.all([api(`jds/${id}`), api("experiences")])
      .then(([d1, d2]) => {
        setJd(d1.jd);
        setFactsIdx(buildFactsIndex(d2.experiences));
        setErr(null);
      })
      .catch((e) => setErr(e.message));

  useEffect(() => { load(); }, [id]);

  if (err) return <ErrorBanner>{err}</ErrorBanner>;
  if (!jd) return <Spinner>拆弹报告加载中…</Spinner>;

  const a = jd.analysis;

  const reanalyze = async () => {
    setBusy(true);
    try {
      const d = await api(`jds/${id}/reanalyze`, { method: "POST" });
      setJd(d.jd);
      // 事实索引不需要变
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  };

  const toApplication = async () => {
    setBusy(true);
    try {
      await api("applications", { method: "POST", body: { jd_id: jd.id } });
      setApplied(true);
      setTimeout(onApplied, 600);
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  };

  const del = async () => {
    if (!window.confirm("删除这个 JD 及其全部拆弹历史？")) return;
    try { await api(`jds/${id}`, { method: "DELETE" }); onBack(); } catch (e) { alert(e.message); }
  };

  return (
    <div>
      <div className="view-head">
        <div>
          <button className="link" onClick={onBack}>← 返回 JD 列表</button>
          <h2>
            {jd.company} · {jd.position}
            {jd.category && <Badge cls="bs-type">{jd.category}</Badge>}
            {jd.current_version ? <Badge cls="bs-neutral" title="当前拆弹版本（历史版本已留存）">v{jd.current_version}</Badge> : null}
          </h2>
          <div className="muted small">
            {jd.analyzed_at ? `最近拆弹：${fmtDateTime(jd.analyzed_at)}` : "尚未拆弹"}
            {a && a.meta && ` ｜ 引用已确认事实 ${a.meta.confirmed_fact_count} 条`}
          </div>
        </div>
        <div className="btn-row">
          <button className="btn" disabled={busy} onClick={reanalyze}>
            {busy ? "处理中…" : "🔄 重新拆弹"}
          </button>
          <button className="btn btn-primary" disabled={busy || applied} onClick={toApplication}>
            {applied ? "✓ 已创建" : "📋 转为投递记录"}
          </button>
          <button className="btn btn-ghost" onClick={del}>删除</button>
        </div>
      </div>

      {jd.status === "analyzing" || jd.status === "pending" ? (
        <Spinner>AI 拆弹中，约需 30-90 秒…</Spinner>
      ) : jd.status === "failed" ? (
        <div>
          <ErrorBanner>拆弹失败：{jd.error_msg}</ErrorBanner>
          <button className="btn btn-primary" disabled={busy} onClick={reanalyze}>重试拆弹</button>
        </div>
      ) : !a ? (
        <Empty title="暂无拆弹结果" hint="点击「重新拆弹」生成报告。" />
      ) : (
        <Report jd={jd} a={a} factsIdx={factsIdx} />
      )}
    </div>
  );
}

function Report({ jd, a, factsIdx }) {
  const capById = Object.fromEntries((a.capabilities || []).map((c) => [c.id, c]));
  const mappingByCap = Object.fromEntries((a.mappings || []).map((m) => [m.capability_id, m]));
  const risks = a.risks || [];
  const qs = (a.interview_map && a.interview_map.predicted_questions) || [];
  const unattached = qs.filter((q) => !q.risk_id || !risks.some((r) => r.id === q.risk_id));

  return (
    <div className="report">
      {/* ---------- 1. 岗位能力 ---------- */}
      <section className="card">
        <h3>① 岗位能力拆解</h3>
        <div className="cap-grid">
          {(a.capabilities || []).map((c) => (
            <div key={c.id} className="cap-item">
              <div className="cap-head">
                <b>{c.name}</b>
                <Badge cls={LEVEL[c.importance] ? LEVEL[c.importance].cls : "lv-low"}
                  title="重要度（依据 JD 原文）">{c.importance === "high" ? "高要求" : c.importance === "medium" ? "中要求" : "低要求"}</Badge>
              </div>
              {c.jd_evidence && c.jd_evidence.length > 0 && (
                <blockquote className="jd-quote">{c.jd_evidence.map((s, i) => <div key={i}>“{s}”</div>)}</blockquote>
              )}
              <div className="inference"><span className="tag tag-inference">AI 推断</span>{c.inference}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- 2. 我的匹配 ---------- */}
      <section className="card">
        <h3>② 我的匹配（弹药库 × JD）</h3>
        <div className="muted small">只基于你「已确认」的事实点做匹配。没有总分——每一项都要讲得清依据。</div>
        <div className="mapping-list">
          {(a.capabilities || []).map((c) => {
            const m = mappingByCap[c.id];
            if (!m) return null;
            const cov = COVERAGE[m.coverage] || COVERAGE.none;
            return (
              <div key={c.id} className="mapping-item">
                <div className="mapping-head">
                  <b>{c.name}</b>
                  <Badge cls={cov.cls}>{cov.label}</Badge>
                </div>
                <FactChips refs={m.fact_refs} invalidRefs={m.invalid_fact_refs} index={factsIdx} />
                {m.ungrounded && <UngroundedNote />}
                {m.inference && <div className="inference"><span className="tag tag-inference">AI 推断</span>{m.inference}</div>}
                {m.suggestion && <div className="suggestion"><span className="tag tag-suggestion">建议</span>{m.suggestion}</div>}
              </div>
            );
          })}
        </div>
      </section>

      {/* ---------- 3. 高风险点 ---------- */}
      <section className="card">
        <h3>③ 高风险点（大概率被拷打的雷区）</h3>
        <div className="risk-list">
          {risks.map((r) => (
            <div key={r.id} className="risk-item">
              <div className="risk-head">
                <b>{r.title}</b>
                <Badge cls={LEVEL[r.severity] ? LEVEL[r.severity].cls : "lv-low"}
                  title="风险等级">{r.severity === "high" ? "高危" : r.severity === "medium" ? "中危" : "低危"}</Badge>
              </div>
              {r.jd_evidence && r.jd_evidence.length > 0 && (
                <blockquote className="jd-quote">{r.jd_evidence.map((s, i) => <div key={i}>“{s}”</div>)}</blockquote>
              )}
              <FactChips refs={r.fact_refs} invalidRefs={r.invalid_fact_refs} index={factsIdx} />
              {r.ungrounded && <UngroundedNote />}
              <div className="inference"><span className="tag tag-inference">AI 推断</span>{r.inference}</div>
              {r.suggestion && <div className="suggestion"><span className="tag tag-suggestion">建议</span>{r.suggestion}</div>}
            </div>
          ))}
        </div>
      </section>

      {/* ---------- 4. Interview Map ---------- */}
      <section className="card">
        <h3>④ Interview Map · 预测问题地图</h3>
        <div className="muted small">
          面试官大概率会问的问题，按风险分组。每条带全局唯一 ID（<code>jd:{jd.id}:a:{jd.current_version}:q:N</code>）——
          R2 记录真实面试题后将用它对账「预测 vs 实际」命中率。
        </div>
        {risks.map((r) => {
          const group = qs.filter((q) => q.risk_id === r.id);
          if (!group.length) return null;
          return (
            <div key={r.id} className="q-group">
              <div className="q-group-title">
                <Badge cls={LEVEL[r.severity] ? LEVEL[r.severity].cls : "lv-low"}>雷区</Badge> {r.title}
              </div>
              {group.map((q) => <QuestionCard key={q.prediction_id || q.question} q={q} factsIdx={factsIdx} capById={capById} />)}
            </div>
          );
        })}
        {unattached.length > 0 && (
          <div className="q-group">
            <div className="q-group-title">其他预测问题</div>
            {unattached.map((q) => <QuestionCard key={q.prediction_id || q.question} q={q} factsIdx={factsIdx} capById={capById} />)}
          </div>
        )}
      </section>
    </div>
  );
}

function QuestionCard({ q, factsIdx, capById }) {
  const [open, setOpen] = useState(false);
  const cap = q.capability_id && capById[q.capability_id];
  return (
    <div className="q-item">
      <div className="q-head" onClick={() => setOpen((o) => !o)}>
        <span className="q-text">{q.question}</span>
        <span className="q-meta">
          {cap && <Badge cls="bs-type" title={`考察能力：${cap.name}`}>{cap.name}</Badge>}
          <Badge cls={q.difficulty === "hard" ? "lv-high" : q.difficulty === "medium" ? "lv-med" : "lv-low"}
            title="预测难度">{q.difficulty === "hard" ? "难" : q.difficulty === "medium" ? "中" : "易"}</Badge>
        </span>
      </div>
      <div className="q-id muted small">{q.prediction_id || q.id}</div>
      {open && (
        <div className="q-detail">
          <div className="inference"><span className="tag tag-inference">AI 推断</span>{q.inference}</div>
          <FactChips refs={q.fact_refs} invalidRefs={q.invalid_fact_refs} index={factsIdx} />
          {q.ungrounded && <UngroundedNote />}
          {q.followups && q.followups.length > 0 && (
            <div className="followups">
              <span className="tag tag-followup">预测追问</span>
              <ul>{q.followups.map((f, i) => <li key={i}>{f}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      {!open && <div className="muted small">点击展开：为什么问 / 引用事实 / 预测追问</div>}
    </div>
  );
}
