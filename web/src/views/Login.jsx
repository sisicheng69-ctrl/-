import React, { useState } from "react";
import { api } from "../api";
import { ErrorBanner } from "../ui";

export default function Login({ onLogin }) {
  const [mode, setMode] = useState("login"); // login | register
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const d = await api(`auth/${mode === "login" ? "login" : "register"}`, {
        method: "POST",
        body: { username: username.trim(), password },
      });
      onLogin(d.user);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-brand">💣 秋招拆弹器</div>
        <div className="login-slogan">事前预测 → 真实面试 → 事后验证 → 数据沉淀</div>
        {err && <ErrorBanner>{err}</ErrorBanner>}
        <form onSubmit={submit} className="login-form">
          <label>
            用户名
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="2-24 位，中文/字母/数字/下划线"
              autoComplete="username"
            />
          </label>
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 6 位"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </label>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "请稍候…" : mode === "login" ? "登录" : "注册并登录"}
          </button>
        </form>
        <div className="login-switch">
          {mode === "login" ? (
            <>还没有账号？<button className="link" onClick={() => setMode("register")}>注册一个</button></>
          ) : (
            <>已有账号？<button className="link" onClick={() => setMode("login")}>直接登录</button></>
          )}
        </div>
        <div className="login-note muted">
          你的经历库、JD、投递记录都是你自己的数据，按账号隔离存储。
        </div>
      </div>
    </div>
  );
}
