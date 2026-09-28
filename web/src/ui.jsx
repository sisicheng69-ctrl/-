// 共享 UI 元件 + 标签字典
import React from "react";

export const STATUS_META = {
  applied: { label: "已投递", cls: "st-applied" },
  written_test: { label: "笔试", cls: "st-test" },
  interview_1: { label: "一面", cls: "st-interview" },
  interview_2: { label: "二面", cls: "st-interview" },
  interview_3: { label: "三面", cls: "st-interview" },
  offer: { label: "Offer 🎉", cls: "st-offer" },
  rejected: { label: "已挂", cls: "st-rejected" },
  withdrawn: { label: "已放弃", cls: "st-withdrawn" },
};
export const STAGE_LABEL = { applied: "已投递", written_test: "笔试", interview_1: "一面", interview_2: "二面", interview_3: "三面", offer: "Offer" };

export const TYPE_LABEL = { internship: "实习", project: "项目", research: "科研", campus: "校园经历", competition: "竞赛", other: "其他" };
export const TYPE_OPTIONS = Object.entries(TYPE_LABEL).map(([v, l]) => ({ v, l }));

export const SOURCE_LABEL = { user_typed: "手动输入", ai_extracted: "AI提取", ai_inferred: "AI推断" };
export const BULLET_STATUS = {
  pending: { label: "待确认", cls: "bs-pending" },
  confirmed: { label: "已确认", cls: "bs-confirmed" },
  edited: { label: "已编辑", cls: "bs-confirmed" },
  rejected: { label: "已拒绝", cls: "bs-rejected" },
};
export const COVERAGE = {
  strong: { label: "强匹配", cls: "cv-strong" },
  partial: { label: "部分匹配", cls: "cv-partial" },
  none: { label: "空白", cls: "cv-none" },
};
export const LEVEL = {
  high: { label: "高", cls: "lv-high" },
  medium: { label: "中", cls: "lv-med" },
  low: { label: "低", cls: "lv-low" },
};
export const JD_STATUS = {
  pending: { label: "排队中", cls: "bs-pending" },
  analyzing: { label: "拆弹中…", cls: "bs-pending" },
  done: { label: "完成", cls: "bs-confirmed" },
  failed: { label: "失败", cls: "bs-rejected" },
};

export function Badge({ cls, children, title }) {
  return <span className={`badge ${cls || ""}`} title={title}>{children}</span>;
}

export function Spinner({ children }) {
  return (
    <div className="spinner-wrap">
      <div className="spinner" />
      <span>{children || "加载中…"}</span>
    </div>
  );
}

export function ErrorBanner({ children }) {
  return <div className="banner banner-error">⚠ {children}</div>;
}

export function InfoBanner({ children }) {
  return <div className="banner banner-info">{children}</div>;
}

export function Empty({ title, hint }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {hint && <div className="muted">{hint}</div>}
    </div>
  );
}

// 事实引用索引：exp:3:abc → { exp, bullet }
export function buildFactsIndex(experiences) {
  const idx = {};
  for (const e of experiences || []) {
    for (const b of e.bullets || []) idx[`exp:${e.id}:${b.id}`] = { exp: e, bullet: b };
  }
  return idx;
}

export function FactChips({ refs, invalidRefs, index }) {
  const valid = refs || [];
  const invalid = invalidRefs || [];
  if (!valid.length && !invalid.length)
    return <span className="muted small">（无事实引用）</span>;
  return (
    <div className="chips">
      {valid.map((r) => {
        const hit = index[r];
        return hit ? (
          <span key={r} className="chip chip-ok" title={`${hit.exp.title}｜${hit.bullet.text}（${SOURCE_LABEL[hit.bullet.source]}·${BULLET_STATUS[hit.bullet.status].label}）`}>
            {hit.exp.title}：{hit.bullet.text.length > 18 ? hit.bullet.text.slice(0, 18) + "…" : hit.bullet.text}
          </span>
        ) : (
          <span key={r} className="chip chip-bad" title="引用未通过服务端事实校验">无效引用</span>
        );
      })}
      {invalid.map((r) => (
        <span key={r} className="chip chip-bad" title="AI 引用了不存在或未确认的内容，已被服务端标记">无效引用：{r}</span>
      ))}
    </div>
  );
}

export function UngroundedNote() {
  return <div className="ungrounded-note">⚠ 该条目引用了未确认的事实，已降级为「无依据推断」</div>;
}
