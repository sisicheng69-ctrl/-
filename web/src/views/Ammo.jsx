// 弹药库：经历事实库（列表 / 手动新建 / 编辑 / 简历导入向导）
import React, { useEffect, useState } from "react";
import { api } from "../api";
import {
  Badge, BULLET_STATUS, ErrorBanner, InfoBanner, SOURCE_LABEL, Spinner,
  TYPE_LABEL, TYPE_OPTIONS, Empty,
} from "../ui";

export default function Ammo() {
  const [exps, setExps] = useState(null);
  const [err, setErr] = useState(null);
  const [mode, setMode] = useState("list"); // list | new | wizard
  const [editingId, setEditingId] = useState(null);

  const load = () => api("experiences")
    .then((d) => setExps(d.experiences))
    .catch((e) => setErr(e.message));

  useEffect(() => { load(); }, []);

  if (mode === "wizard")
    return <ImportWizard onDone={() => { setMode("list"); load(); }} />;

  if (err) return <ErrorBanner>{err}</ErrorBanner>;
  if (!exps) return <Spinner>弹药库加载中…</Spinner>;

  const confirmedBullets = exps.reduce(
    (n, e) => n + (e.bullets || []).filter((b) => b.status === "confirmed" || b.status === "edited").length, 0
  );
  const pendingBullets = exps.reduce(
    (n, e) => n + (e.bullets || []).filter((b) => b.status === "pending").length, 0
  );

  return (
    <div>
      <div className="view-head">
        <div>
          <h2>弹药库</h2>
          <div className="muted">
            事实层：<b>{exps.length}</b> 条经历 · <b>{confirmedBullets}</b> 条已确认事实点
            {pendingBullets > 0 && <span className="warn-text">（{pendingBullets} 条待确认——未确认的内容不会进入 AI 分析）</span>}
          </div>
        </div>
        <div className="btn-row">
          <button className="btn" onClick={() => setMode("wizard")}>📄 粘贴简历导入</button>
          <button className="btn btn-primary" onClick={() => setMode("new")}>＋ 手动添加经历</button>
        </div>
      </div>

      {exps.length === 0 && (
        <Empty
          title="弹药库还是空的"
          hint="粘贴简历让 AI 帮你拆成草稿，或手动添加一条经历。只有你确认过的事实，才会被用于 JD 拆弹和面试预判。"
        />
      )}

      {(mode === "new" || editingId) && (
        <ExpForm
          exp={editingId ? exps.find((e) => e.id === editingId) : null}
          onDone={() => { setMode("list"); setEditingId(null); load(); }}
          onCancel={() => { setMode("list"); setEditingId(null); }}
        />
      )}

      <div className="card-list">
        {exps.map((e) => (
          <ExperienceCard
            key={e.id}
            exp={e}
            onChanged={(ne) => setExps((l) => l.map((x) => (x.id === ne.id ? ne : x)))}
            onDeleted={() => setExps((l) => l.filter((x) => x.id !== e.id))}
            onEdit={() => setEditingId(e.id)}
          />
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- 经历卡片 -----

function ExperienceCard({ exp, onChanged, onDeleted, onEdit }) {
  const [busy, setBusy] = useState(false);
  const [editingBullet, setEditingBullet] = useState(null); // {id, text}
  const [confirmDel, setConfirmDel] = useState(false);

  const patchBullet = async (bulletId, body) => {
    setBusy(true);
    try {
      const d = await api(`experiences/${exp.id}/bullets/${bulletId}`, { method: "PATCH", body });
      onChanged(d.experience);
      setEditingBullet(null);
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  };

  const confirmAll = async () => {
    setBusy(true);
    try {
      let cur = exp;
      for (const b of exp.bullets.filter((x) => x.status === "pending")) {
        const d = await api(`experiences/${exp.id}/bullets/${b.id}`, { method: "PATCH", body: { action: "confirm" } });
        cur = d.experience;
      }
      onChanged(cur);
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  };

  const pendingCount = exp.bullets.filter((b) => b.status === "pending").length;
  const skills = (exp.skills || []).join("、");

  return (
    <div className={"card" + (pendingCount ? " card-attention" : "")}>
      <div className="card-head">
        <div>
          <span className="badge bs-type">{TYPE_LABEL[exp.type]}</span>
          <b className="exp-title">{exp.title}</b>
          <span className="muted">{exp.org} {exp.period && `· ${exp.period}`}</span>
          {exp.origin === "resume_import" && <Badge cls="bs-pending" title="来自简历导入">导入</Badge>}
        </div>
        <div className="btn-row">
          {pendingCount > 0 && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={confirmAll}>
              全部确认（{pendingCount}）
            </button>
          )}
          <button className="btn btn-sm" disabled={busy} onClick={onEdit}>编辑</button>
          {confirmDel ? (
            <span className="btn-row">
              <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => api(`experiences/${exp.id}`, { method: "DELETE" }).then(onDeleted).catch((e) => alert(e.message))}>确认删除</button>
              <button className="btn btn-sm" onClick={() => setConfirmDel(false)}>取消</button>
            </span>
          ) : (
            <button className="btn btn-sm btn-ghost" onClick={() => setConfirmDel(true)}>删除</button>
          )}
        </div>
      </div>

      <ul className="bullet-list">
        {exp.bullets.map((b) => (
          <li key={b.id} className={"bullet " + (b.status === "rejected" ? "bullet-rejected" : "")}>
            {editingBullet && editingBullet.id === b.id ? (
              <div className="bullet-edit">
                <textarea
                  value={editingBullet.text}
                  onChange={(e) => setEditingBullet({ ...editingBullet, text: e.target.value })}
                  rows={2}
                />
                <div className="btn-row">
                  <button className="btn btn-sm btn-primary" disabled={busy}
                    onClick={() => patchBullet(b.id, { action: "edit", text: editingBullet.text })}>保存（记为已编辑）</button>
                  <button className="btn btn-sm" onClick={() => setEditingBullet(null)}>取消</button>
                </div>
              </div>
            ) : (
              <>
                <span className="bullet-text">{b.text}</span>
                <span className="bullet-meta">
                  <Badge cls={BULLET_STATUS[b.status].cls} title={`来源：${SOURCE_LABEL[b.source]}`}>
                    {SOURCE_LABEL[b.source]}·{BULLET_STATUS[b.status].label}
                  </Badge>
                  {b.status !== "rejected" && (
                    <span className="btn-row">
                      {b.status === "pending" && (
                        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => patchBullet(b.id, { action: "confirm" })}>确认</button>
                      )}
                      {b.status === "rejected" ? null : (
                        <>
                          <button className="btn btn-sm" disabled={busy} onClick={() => setEditingBullet({ id: b.id, text: b.text })}>编辑</button>
                          <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => patchBullet(b.id, { action: "reject" })}>拒绝</button>
                        </>
                      )}
                    </span>
                  )}
                  {b.status === "rejected" && (
                    <button className="btn btn-sm" disabled={busy} onClick={() => patchBullet(b.id, { action: "confirm" })}>恢复</button>
                  )}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
      {skills && <div className="exp-skills muted">技能：{skills}</div>}
    </div>
  );
}

// --------------------------------------------------------- 新建/编辑表单 -----

function ExpForm({ exp, onDone, onCancel }) {
  const [form, setForm] = useState(
    exp
      ? {
          type: exp.type, title: exp.title, org: exp.org, period: exp.period,
          skills: (exp.skills || []).join("，"),
          bullets: exp.bullets.map((b) => b.text).join("\n"),
        }
      : { type: "internship", title: "", org: "", period: "", skills: "", bullets: "" }
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const body = {
      type: form.type, title: form.title, org: form.org, period: form.period,
      skills: form.skills.split(/[，,、\s]+/).filter(Boolean),
      bullets: exp
        ? form.bullets.split("\n").map((t, i) => ({ id: (exp.bullets[i] || {}).id, text: t }))
        : form.bullets.split("\n"),
    };
    try {
      if (exp) await api(`experiences/${exp.id}`, { method: "PUT", body });
      else await api("experiences", { method: "POST", body });
      onDone();
    } catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  };

  return (
    <form className="card form-card" onSubmit={submit}>
      <h3>{exp ? "编辑经历" : "手动添加经历"}</h3>
      {err && <ErrorBanner>{err}</ErrorBanner>}
      <div className="form-grid">
        <label>类型
          <select value={form.type} onChange={set("type")}>
            {TYPE_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
        </label>
        <label>经历名称 *
          <input value={form.title} onChange={set("title")} placeholder="如：销售数据分析实习生" required />
        </label>
        <label>组织/公司
          <input value={form.org} onChange={set("org")} placeholder="如：某电商平台" />
        </label>
        <label>时间段
          <input value={form.period} onChange={set("period")} placeholder="如：2025.06-2025.09" />
        </label>
      </div>
      <label>技能（逗号分隔）
        <input value={form.skills} onChange={set("skills")} placeholder="如：SQL，Python，Tableau" />
      </label>
      <label>事实要点（每行一条：做了什么/结果是什么）
        <textarea rows={5} value={form.bullets} onChange={set("bullets")}
          placeholder={"独立搭建销售漏斗看板\n用 SQL 清洗 3 张业务表\n输出每周转化率周报"} required />
      </label>
      <div className="muted small">手动输入的内容 = 你亲手写的事实，直接记为「已确认」。{exp ? "编辑时改动过的条目会记为「已编辑」。" : ""}</div>
      <div className="btn-row">
        <button className="btn btn-primary" disabled={busy}>{busy ? "保存中…" : "保存"}</button>
        <button type="button" className="btn" onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}

// ----------------------------------------------------------- 简历导入向导 -----

function ImportWizard({ onDone }) {
  const [step, setStep] = useState(1);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [exps, setExps] = useState([]);

  const extract = async () => {
    setErr(null);
    if (text.trim().length < 30) { setErr("简历内容太短（至少 30 字）"); return; }
    setBusy(true);
    try {
      const d = await api("experiences/import", { method: "POST", body: { resume_text: text.trim() } });
      setExps(d.experiences);
      setWarnings(d.warnings || []);
      setStep(2);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const patchBullet = async (expId, bulletId, body) => {
    const d = await api(`experiences/${expId}/bullets/${bulletId}`, { method: "PATCH", body });
    setExps((l) => l.map((x) => (x.id === d.experience.id ? d.experience : x)));
  };

  const pendingTotal = exps.reduce((n, e) => n + e.bullets.filter((b) => b.status === "pending").length, 0);

  if (step === 1) {
    return (
      <div>
        <div className="view-head"><h2>导入简历 · 第 1 步 / 共 2 步</h2></div>
        <InfoBanner>
          把简历全文粘贴进来，AI 会拆成一条条「经历草稿」。<b>所有草稿默认「待确认」</b>——
          未经你确认的内容绝不会进入 JD 拆弹和面试预判。
        </InfoBanner>
        {err && <ErrorBanner>{err}</ErrorBanner>}
        <div className="card form-card">
          <label>简历全文（纯文本）
            <textarea rows={14} value={text} onChange={(e) => setText(e.target.value)}
              placeholder="把简历全文复制粘贴到这里（教育背景、实习、项目、技能…）" />
          </label>
          <div className="btn-row">
            <button className="btn btn-primary" disabled={busy} onClick={extract}>
              {busy ? "AI 提取中，约 10-60 秒…" : "提交给 AI 提取"}
            </button>
            <button className="btn" onClick={onDone}>返回弹药库</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="view-head">
        <div>
          <h2>导入简历 · 第 2 步：逐条确认</h2>
          <div className="muted">
            拆出 <b>{exps.length}</b> 条经历，剩余 <b className="warn-text">{pendingTotal}</b> 条事实点待确认。
            确认 = 这是真的事实；编辑 = 改成真的；拒绝 = AI 拆错了/不重要。
          </div>
        </div>
        <div className="btn-row">
          <button className="btn btn-primary" onClick={onDone}>完成导入</button>
        </div>
      </div>
      {warnings.length > 0 && <InfoBanner>AI 提示：{warnings.join("；")}</InfoBanner>}
      {exps.map((e) => (
        <ImportDraftCard key={e.id} exp={e} patchBullet={patchBullet}
          onDeleted={() => setExps((l) => l.filter((x) => x.id !== e.id))} />
      ))}
      <div className="btn-row center">
        <button className="btn btn-primary" onClick={onDone}>完成导入，返回弹药库</button>
      </div>
    </div>
  );
}

function ImportDraftCard({ exp, patchBullet, onDeleted }) {
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (bid, body) => { setBusy(true); try { await patchBullet(exp.id, bid, body); } catch (e) { alert(e.message); } finally { setBusy(false); setEditing(null); } };
  const pending = exp.bullets.filter((b) => b.status === "pending");

  return (
    <div className={"card" + (pending.length ? " card-attention" : "")}>
      <div className="card-head">
        <div>
          <span className="badge bs-type">{TYPE_LABEL[exp.type]}</span>
          <b>{exp.title}</b>
          <span className="muted">{exp.org} {exp.period && `· ${exp.period}`}</span>
        </div>
        <div className="btn-row">
          {pending.length > 0 && (
            <button className="btn btn-sm btn-primary" disabled={busy}
              onClick={async () => { for (const b of pending) await run(b.id, { action: "confirm" }); }}>
              全部确认
            </button>
          )}
          <button className="btn btn-sm btn-ghost" onClick={onDeleted}>删掉这条经历</button>
        </div>
      </div>
      <ul className="bullet-list">
        {exp.bullets.map((b) => (
          <li key={b.id} className={"bullet " + (b.status === "rejected" ? "bullet-rejected" : "")}>
            {editing && editing.id === b.id ? (
              <div className="bullet-edit">
                <textarea rows={2} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
                <div className="btn-row">
                  <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(b.id, { action: "edit", text: editing.text })}>保存</button>
                  <button className="btn btn-sm" onClick={() => setEditing(null)}>取消</button>
                </div>
              </div>
            ) : (
              <>
                <span className="bullet-text">{b.text}</span>
                <span className="bullet-meta">
                  <Badge cls={BULLET_STATUS[b.status].cls} title={`来源：${SOURCE_LABEL[b.source]}`}>
                    {SOURCE_LABEL[b.source]}·{BULLET_STATUS[b.status].label}
                  </Badge>
                  {b.status !== "rejected" && (
                    <span className="btn-row">
                      {b.status === "pending" && <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(b.id, { action: "confirm" })}>确认</button>}
                      <button className="btn btn-sm" disabled={busy} onClick={() => setEditing({ id: b.id, text: b.text })}>编辑</button>
                      <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => run(b.id, { action: "reject" })}>拒绝</button>
                    </span>
                  )}
                  {b.status === "rejected" && <button className="btn btn-sm" disabled={busy} onClick={() => run(b.id, { action: "confirm" })}>恢复</button>}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
