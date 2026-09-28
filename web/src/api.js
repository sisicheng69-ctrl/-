// 统一 API 请求：相对路径 + JSON + 401 全局事件
export async function api(path, opts = {}) {
  const res = await fetch("api/" + path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* ignore */ }
  if (res.status === 401 && !path.startsWith("auth/")) {
    window.dispatchEvent(new Event("app:unauthorized"));
  }
  if (!res.ok) throw new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
  return data;
}

export function fmtDate(d) {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }); } catch { return d; }
}
export function fmtDateTime(d) {
  if (!d) return "—";
  try { return new Date(d).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return d; }
}
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
