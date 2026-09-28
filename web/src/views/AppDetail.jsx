// 投递详情：状态时间线 + 状态事件
import React, { useEffect, useState } from "react";
import { api, fmtDate, fmtDateTime, todayStr } from "../api";
import { Badge, ErrorBanner, STATUS_META, Spinner } from "../ui";

const NEXT_OPTIONS = ["written_test", "interview_1", "interview_2", "interview_3", "offer", "rejected", "withdrawn", "applied"];

export default function AppDetail({ id, onBack }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api(`applications/${id}`).then(setData).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);

  if (err) return <ErrorBanner>{err}</ErrorBanner>;
  if (!data) return <Spinner>投递详情加载中…</Spinner>;

  const { application: a, events } = data;
  const st = STATUS_META[a.current_status] || STATUS_META.applied;

  const del = async () => {
    if (!window.confirm("删除这条投递记录及其状态流水？")) return;
    try { await api(`applications/${id}`, { method: "DELETE" }); onBack(); } catch (e) { alert(e.message); }
  };

  return (
    <div>
      <div className="view-head">
        <div>
          <button className="link" onClick={onBack}>← 返回投递看板</button>
          <h2>{a.company} · {a.position} <Badge cls={st.cls}>{st.label}</Badge></h2>
          <div className="muted small">
            投递于 {fmtDate(a.applied_at || a.created_at)}
            {a.channel && ` ｜ 渠道：${a.channel}`}
            {a.jd_id && ` ｜ 关联 JD：${a.jd_company || ""} ${a.jd_position || ""}（可在 JD 拆弹页看预测问题）`}
          </div>
        </div>
        <button className="btn btn-ghost" onClick={del}>删除</button>
      </div>

      <AddEvent appId={a.id} current={a.current_status} onAdded={load} busy={busy} setBusy={setBusy} />

      <section className="card">
        <h3>状态时间线</h3>
        <div className="timeline">
          {events.map((e) => (
            <div key={e.id} className="tl-item">
              <div className="tl-dot" />
              <div className="tl-body">
                <div>
                  {e.from_status ? (
                    <>{STATUS_META[e.from_status]?.label || e.from_status} → </>
                  ) : null}
                  <b>{STATUS_META[e.to_status]?.label || e.to_status}</b>
                </div>
                {e.note && <div className="muted small">{e.note}</div>}
                <div className="muted small">{fmtDateTime(e.happened_at)}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function AddEvent({ appId, current, onAdded, busy, setBusy }) {
  const [form, setForm] = useState({ to_status: "", happened_at: todayStr(), note: "" });
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    if (!form.to_status) { setErr("选择一个新状态"); return; }
    setBusy(true);
    try {
      await api(`applications/${appId}/events`, { method: "POST", body: form });
      setForm({ to_status: "", happened_at: todayStr(), note: "" });
      onAdded();
    } catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  };

  return (
    <form className="card form-card" onSubmit={submit}>
      <h3>记录状态变化</h3>
      <div className="muted small">当前状态：{STATUS_META[current]?.label || current}。每一步变化都会进入流水（可回填日期，漏记也没关系）。</div>
      {err && <ErrorBanner>{err}</ErrorBanner>}
      <div className="form-grid">
        <label>新状态 *
          <select value={form.to_status} onChange={(e) => setForm({ ...form, to_status: e.target.value })} required>
            <option value="">选择…</option>
            {NEXT_OPTIONS.map((s) => (
              <option key={s} value={s} disabled={s === current}>{STATUS_META[s].label}{s === current ? "（当前）" : ""}</option>
            ))}
          </select>
        </label>
        <label>发生日期<input type="date" value={form.happened_at} onChange={(e) => setForm({ ...form, happened_at: e.target.value })} /></label>
      </div>
      <label>备注（可选）<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="如：一面聊了项目细节，被问指标口径" /></label>
      <div className="btn-row">
        <button className="btn btn-primary" disabled={busy}>{busy ? "保存中…" : "记录"}</button>
      </div>
    </form>
  );
}
