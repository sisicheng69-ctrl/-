// 秋招拆弹器 R1 — 单页应用（无路由，tab + state 切换）
import React, { useEffect, useState } from "react";
import { api } from "./api";
import Login from "./views/Login";
import Ammo from "./views/Ammo";
import JdList from "./views/JdList";
import JdDetail from "./views/JdDetail";
import Apps from "./views/Apps";
import AppDetail from "./views/AppDetail";
import Stats from "./views/Stats";

const TABS = [
  { key: "ammo", label: "💣 弹药库" },
  { key: "jds", label: "🎯 JD 拆弹" },
  { key: "apps", label: "📋 投递看板" },
  { key: "stats", label: "📊 数据看板" },
];

export default function App() {
  const [user, setUser] = useState(undefined); // undefined=加载中, null=未登录
  const [view, setView] = useState({ tab: "ammo", jdId: null, appId: null });

  useEffect(() => {
    api("auth/me").then((d) => setUser(d.user)).catch(() => setUser(null));
    const onUnauth = () => setUser(null);
    window.addEventListener("app:unauthorized", onUnauth);
    return () => window.removeEventListener("app:unauthorized", onUnauth);
  }, []);

  if (user === undefined) return <div className="boot">💣 秋招拆弹器启动中…</div>;
  if (!user) return <Login onLogin={setUser} />;

  const logout = () => api("auth/logout", { method: "POST" }).finally(() => setUser(null));

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">💣 秋招拆弹器</div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={"tab" + (view.tab === t.key ? " active" : "")}
              onClick={() => setView({ tab: t.key, jdId: null, appId: null })}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="user-box">
          <span className="username">{user.username}</span>
          <button className="btn btn-ghost btn-sm" onClick={logout}>退出</button>
        </div>
      </header>
      <main className="main">
        {view.tab === "ammo" && <Ammo />}
        {view.tab === "jds" && !view.jdId && <JdList onOpen={(id) => setView({ tab: "jds", jdId: id })} />}
        {view.tab === "jds" && view.jdId && (
          <JdDetail
            id={view.jdId}
            onBack={() => setView({ tab: "jds", jdId: null })}
            onApplied={() => setView({ tab: "apps", appId: null })}
          />
        )}
        {view.tab === "apps" && !view.appId && <Apps onOpen={(id) => setView({ tab: "apps", appId: id })} />}
        {view.tab === "apps" && view.appId && (
          <AppDetail id={view.appId} onBack={() => setView({ tab: "apps", appId: null })} />
        )}
        {view.tab === "stats" && <Stats />}
      </main>
    </div>
  );
}
