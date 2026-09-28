// 投递看板：列表 + 快速记投递
import React, { useEffect, useState } from "react";
import { api, fmtDate, todayStr } from "../api";
import { Badge, Empty, ErrorBanner, STATUS_META, Spinner } from "../ui";

export default function Apps({ onOpen }) {
  const [apps, setApps] = useState(null);
  const [err, setErr] = useState(null);
  const [showForm, setShowForm] = useState(false);

  const load = () => api("applications").then((d) => setApps(d.applications)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <ErrorBanner>{err}</ErrorBanner>;
  if (!apps) return <Spinner>投递记录加载中…</Spinner>;

  return (
    <div>
      <div className="view-head">
        <div>
          <h2>投递看板</h2>
          <div className="muted">每次投递和状态变化都会留痕——这是你自己的求职数据资产。</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "收起" : "＋ 记一笔投递"}
        </button>
      </div>

      {showForm && (
        <QuickAdd onDone={() => { setShowForm(false); load(); }} onCancel={() => setShowForm(false)} />
      )}

      {apps.length === 0 && <Empty title="还没有投递记录" hint="从 JD 详情页「转为投递」，或在这里快速记一笔。" />}

      <div className="card-list">
        {apps.map((a) => {
          const st = STATUS_META[a.current_status] || STATUS_META.applied;
          return (
            <div key={a.id} className="card clickable" onClick={() => onOpen(a.id)}>
              <div className="card-head">
                <div>
                  <b>{a.company}</b> <span className="sep">·</span> {a.position}
                  {a.channel && <Badge cls="bs-neutral">{a.channel}</Badge>}
                  {a.jd_id && <Badge cls="bs-type" title="来自 JD 拆弹，可对照预测问题">有JD拆弹</Badge>}
                </div>
                <Badge cls={st.cls}>{st.label}</Badge>
              </div>
              <div className="muted small">投递于 {fmtDate(a.applied_at || a.created_at)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function QuickAdd({ onDone, onCancel }) {
  const [form, setForm] = useState({ company: "", position: "", channel: "", applied_at: todayStr() });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api("applications", { method: "POST", body: form });
      onDone();
    } catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  };

  return (
    <form className="card form-card" onSubmit={submit}>
      <h3>快速记投递（不关联 JD）</h3>
      {err && <ErrorBanner>{err}</ErrorBanner>}
      <div className="form-grid">
        <label>公司 *<input value={form.company} onChange={set("company")} required /></label>
        <label>职位 *<input value={form.position} onChange={set("position")} required /></label>
        <label>渠道<input value={form.channel} onChange={set("channel")} placeholder="如：官网 / Boss / 内推" /></label>
        <label>投递日期<input type="date" value={form.applied_at} onChange={set("applied_at")} /></label>
      </div>
      <div className="btn-row">
        <button className="btn btn-primary" disabled={busy}>{busy ? "保存中…" : "保存"}</button>
        <button type="button" className="btn" onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}
