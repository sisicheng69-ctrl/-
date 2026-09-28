// 数据看板（R1 简版）：总数 / 状态分布 / 漏斗（最远到达阶段）/ 最近动态
import React, { useEffect, useState } from "react";
import { api, fmtDateTime } from "../api";
import { Badge, Empty, ErrorBanner, STAGE_LABEL, STATUS_META, Spinner } from "../ui";

export default function Stats() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api("stats/overview").then(setData).catch((e) => setErr(e.message));
  }, []);

  if (err) return <ErrorBanner>{err}</ErrorBanner>;
  if (!data) return <Spinner>看板加载中…</Spinner>;

  if (data.total === 0)
    return (
      <div>
        <div className="view-head">
          <div><h2>数据看板</h2></div>
        </div>
        <Empty title="还没有数据" hint="记录几笔投递之后，这里会出现漏斗和状态分布。R2 上线后还会展示「预测命中率」。" />
      </div>
    );

  const maxFunnel = data.funnel[0]?.count || 1;
  const inProgress = ["written_test", "interview_1", "interview_2", "interview_3"].reduce((n, s) => n + (data.by_status[s] || 0), 0);

  return (
    <div>
      <div className="view-head">
        <div>
          <h2>数据看板</h2>
          <div className="muted">漏斗按「最远到达阶段」统计——中途挂掉不回滚，如实在录就好。</div>
        </div>
      </div>

      <div className="stat-cards">
        <div className="stat-card"><div className="stat-num">{data.total}</div><div className="stat-label">总投递</div></div>
        <div className="stat-card"><div className="stat-num">{inProgress}</div><div className="stat-label">流程中</div></div>
        <div className="stat-card"><div className="stat-num">{data.by_status.offer || 0}</div><div className="stat-label">Offer</div></div>
        <div className="stat-card"><div className="stat-num">{data.by_status.rejected || 0}</div><div className="stat-label">已挂</div></div>
      </div>

      <section className="card">
        <h3>投递漏斗（最远到达阶段）</h3>
        <div className="funnel">
          {data.funnel.map((f) => (
            <div key={f.stage} className="funnel-row">
              <div className="funnel-label">{STAGE_LABEL[f.stage]}</div>
              <div className="funnel-bar-wrap">
                <div className="funnel-bar" style={{ width: `${Math.round((f.count / maxFunnel) * 100)}%` }} />
              </div>
              <div className="funnel-num">{f.count}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h3>当前状态分布</h3>
        <div className="chips" style={{ flexWrap: "wrap" }}>
          {Object.entries(data.by_status).filter(([, n]) => n > 0).map(([s, n]) => (
            <Badge key={s} cls={STATUS_META[s].cls}>{STATUS_META[s].label} × {n}</Badge>
          ))}
        </div>
      </section>

      <section className="card">
        <h3>最近动态</h3>
        <div className="recent-list">
          {data.recent_events.map((e) => (
            <div key={e.id} className="recent-item">
              <Badge cls={STATUS_META[e.to_status]?.cls || ""}>{STATUS_META[e.to_status]?.label || e.to_status}</Badge>
              <span>{e.company} · {e.position}</span>
              {e.note && <span className="muted small">{e.note}</span>}
              <span className="muted small">{fmtDateTime(e.happened_at)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
