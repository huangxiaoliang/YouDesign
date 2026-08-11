"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { withBase } from "@/lib/basePath";
import { DEFAULT_THEME_ID, THEME_STORAGE_KEY, THEMES } from "@/lib/theme/themes";

function getThemeId(): string {
  if (typeof window === "undefined") return DEFAULT_THEME_ID;
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) || DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [themeId, setThemeId] = useState(DEFAULT_THEME_ID);

  useEffect(() => {
    const id = getThemeId();
    setThemeId(id);
    // 把主题 CSS 变量写到 <html> 上，确保 var(--brand) 等在登录页也生效
    const theme = THEMES.find(t => t.id === id) || THEMES[0];
    const root = document.documentElement;
    Object.entries(theme.vars).forEach(([key, value]) => {
      root.style.setProperty(key, value);
    });
    root.setAttribute("data-theme", id);
  }, []);

  const isDark = themeId === "yemu";

  async function submit() {
    if (!password || loading) return;
    setLoading(true);
    setErr("");
    try {
      const res = await fetch(withBase("/api/login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        sessionStorage.setItem("yd_fresh_login", "1");
        router.replace("/");
        router.refresh();
      } else {
        const d = await res.json().catch(() => ({}));
        setErr(d.error || "口令不正确");
      }
    } catch {
      setErr("网络错误，请重试");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap" data-theme={themeId} suppressHydrationWarning>
      <div className="login-card">
        <img
          className="login-logo"
          src={withBase(isDark ? "/logo/logo-dark.svg" : "/logo/logo-light.svg")}
          alt="YouDesign"
          style={{ width: '180px', height: 'auto' }}
        />
        <p className="login-sub">高保真原型设计 · Product Design Agent</p>
        <p className="login-sub2">原生 HTML · 预置产品风格 · 点选修改</p>
        <input
          className="login-input"
          type="password"
          value={password}
          placeholder="请输入访问口令"
          autoFocus
          onChange={(e) => {
            setPassword(e.target.value);
            setErr("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <div className={`login-err${err ? " show" : ""}`}>{err || " "}</div>
        <button className="login-btn" onClick={submit} disabled={loading || !password}>
          {loading ? "进入中…" : "进入"}
        </button>
      </div>
    </div>
  );
}
