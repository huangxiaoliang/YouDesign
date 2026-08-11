"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  THEMES,
  DEFAULT_THEME_ID,
  THEME_STORAGE_KEY,
  type ThemeDef,
} from "./themes";

interface ThemeContextValue {
  theme: ThemeDef;
  setTheme: (id: string) => void;
  themes: ThemeDef[];
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** SSR 与首次客户端渲染必须使用同一主题；挂载后再恢复本地偏好。 */
function getStoredTheme(): ThemeDef {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    const found = saved ? THEMES.find((t) => t.id === saved) : undefined;
    return found || THEMES.find((t) => t.id === DEFAULT_THEME_ID) || THEMES[0];
  } catch {
    return THEMES[0];
  }
}

/**
 * 将主题变量批量写入 :root，并设置 data-theme 属性。
 */
function applyThemeToDOM(theme: ThemeDef) {
  const root = document.documentElement;
  Object.entries(theme.vars).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });
  root.setAttribute("data-theme", theme.id);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeDef>(() => THEMES.find((t) => t.id === DEFAULT_THEME_ID) || THEMES[0]);
  const appliedRef = useRef<string | null>(null);

  // 只在挂载后读取浏览器存储，避免 SSR/水合首帧的文本、属性不一致。
  useEffect(() => {
    const storedTheme = getStoredTheme();
    if (storedTheme.id !== theme.id) {
      setThemeState(storedTheme);
      return;
    }
    if (appliedRef.current !== theme.id) {
      applyThemeToDOM(theme);
      appliedRef.current = theme.id;
    }
  }, [theme]);

  const setTheme = useCallback((id: string) => {
    const t = THEMES.find((t) => t.id === id);
    if (!t) return;
    setThemeState(t);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, id);
    } catch {
      /* storage 不可用时静默忽略 */
    }
    applyThemeToDOM(t);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, themes: THEMES }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
