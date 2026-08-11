"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/lib/theme/ThemeContext";

interface MoreMenuProps {
  onLogout: () => void;
}

export function MoreMenu({ onLogout }: MoreMenuProps) {
  const { theme, setTheme, themes } = useTheme();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Escape 关闭
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  const handleThemeClick = useCallback(
    (id: string) => {
      setTheme(id);
      setOpen(false);
    },
    [setTheme],
  );

  const handleLogout = useCallback(() => {
    setOpen(false);
    onLogout();
  }, [onLogout]);

  return (
    <div className="more-menu" ref={menuRef}>
      <button
        type="button"
        className="more-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        title="更多操作"
      >
        <span className="more-text">更多</span><span className="more-arrow" data-open={open ? "" : undefined} />
      </button>

      {open && (
        <div className="more-dropdown" role="menu">
          <div className="more-label">🎨 主题</div>
          {themes.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`more-item theme-option${theme.id === t.id ? " active" : ""}`}
              role="menuitemradio"
              aria-checked={theme.id === t.id}
              title={t.desc}
              onClick={() => handleThemeClick(t.id)}
            >
              <span className="theme-dot" data-theme-dot={t.id} />
              <span className="theme-name">{t.name}</span>
              {theme.id === t.id && <span className="theme-check">✓</span>}
            </button>
          ))}
          <div className="more-divider" />
          <button
            type="button"
            className="more-item more-logout"
            role="menuitem"
            onClick={handleLogout}
          >
            退出登录
          </button>
        </div>
      )}
    </div>
  );
}
