// JD 工作台：列表 + 新建（创建即同步拆弹）
import React, { useEffect, useState } from "react";
import { api, fmtDate } from "../api";
import { Badge, Empty, ErrorBanner, JD_STATUS, Spinner } from "../ui";

const CATEGORY_SUGGEST = ["技术/研发", "产品", "数据", "运营", "市场", "金融", "咨询", "管培生", "其他"];

export default function JdList({ onOpen }) {
  const [jds, setJds] = useState(null);
  const [err, setErr] = useState(null);
  const [showForm, setShowForm] = useState(false);

  const load = () => api("jds").then((d) => setJds(d.jds)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const del = async (id) => {
    if (!window.confirm("删除这个 JD 及其全部拆弹历史？关联的投递记录会保留（解除关联）。")) return;
    try { await api(`jds/${id}`, { method: "DELETE" }); load(); } catch (e) { alert(e.message); }
  };

  if (err) return <ErrorBanner>{err}</ErrorBanner>;
  if (!jds) return <Spinner>JD 列表加载中…</Spinner>;

  return (
    <div>
      <div className="view-head">
        <div>
          <h2>JD 拆弹</h2>
          <div className="muted">贴入 JD → 拆解岗位能力 → 匹配你的已确认经历 → 生成高风险追问预测。</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "收起" : "＋ 新建 JD"}
        </button>
      </div>

      {showForm && <NewJdForm onCreated={(jd) => { setShowForm(false); onOpen(jd.id); }} onCancel={() => setShowForm(false)} />}

      {jds.length === 0 && <Empty title="还没有 JD" hint="先去弹药库确认几条经历，再贴入第一个 JD，拆弹效果最好。" />}

      <div className="card-list">
        {jds.map((j) => {
          const st = JD_STATUS[j.status] || JD_STATUS.pending;
          return (
            <div key={j.id} className="card clickable" onClick={() => onOpen(j.id)}>
              <div className="card-head">
                <div>
                  <b>{j.company}</b> <span className="sep">·</span> {j.position}
                  {j.category && <Badge cls="bs-type">{j.category}</Badge>}
                </div>
                <div className="btn-row" onClick={(e) => e.stopPropagation()}>
                  <Badge cls={st.cls}>{st.label}</Badge>
                  {j.current_version ? <Badge cls="bs-neutral" title="当前拆弹版本">v{j.current_version}</Badge> : null}
                  <button className="btn btn-sm btn-ghost" onClick={() => del(j.id)}>删除</button>
                </div>
              </div>
              <div className="muted small">
                创建于 {fmtDate(j.created_at)}
                {j.analyzed_at ? ` ｜ 最近拆弹 ${fmtDate(j.analyzed_at)}` : ""}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NewJdForm({ onCreated, onCancel }) {
  const [form, setForm] = useState({ company: "", position: "", category: "", raw_text: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const d = await api("jds", { method: "POST", body: form });
      if (d.jd.status === "failed") {
        setErr(`${d.analysis_error}——JD 已保存，可点击「重试拆弹」。`);
        onCreated(d.jd);
      } else {
        onCreated(d.jd);
      }
    } catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  };

  return (
    <form className="card form-card" onSubmit={submit}>
      <h3>新建 JD</h3>
      {err && <ErrorBanner>{err}</ErrorBanner>}
      <div className="form-grid">
        <label>公司 *
          <input value={form.company} onChange={set("company")} placeholder="如：字节跳动" required />
        </label>
        <label>职位 *
          <input value={form.position} onChange={set("position")} placeholder="如：数据分析师" required />
        </label>
        <label>类别
          <input list="cat-suggest" value={form.category} onChange={set("category")} placeholder="如：数据" />
          <datalist id="cat-suggest">
            {CATEGORY_SUGGEST.map((c) => <option key={c} value={c} />)}
          </datalist>
        </label>
      </div>
      <label>JD 原文 *（职责描述 + 任职要求，越完整拆弹越准）
        <textarea rows={10} value={form.raw_text} onChange={set("raw_text")}
          placeholder={"岗位职责：\n1. …\n\n任职要求：\n1. …"} required />
      </label>
      <div className="btn-row">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "拆弹中…AI 正在拆解能力、匹配经历、生成预测（约 30-90 秒）" : "提交并拆弹"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}
