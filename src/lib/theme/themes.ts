export interface ThemeDef {
  id: string;
  name: string;
  desc: string;
  vars: Record<string, string>;
}

/**
 * 四种主题风格的 CSS 变量映射。
 *
 * 变量命名规范：
 *   --brand        主色调（按钮、链接、高亮）
 *   --brand-soft   主色调浅色底（hover 背景、标签底色）
 *   --bg           页面底色
 *   --panel        面板 / 侧栏底色
 *   --surface      表面 / 卡片 / 小组件底色（按钮边框内部、输入框等）
 *   --border       边框（弱）
 *   --border-strong 边框（强）
 *   --text         主文本
 *   --muted        次要文本
 *   --ok           成功色
 *   --danger       危险 / 错误色
 *   --input-bg     输入框背景
 *   --radius       按钮/输入框圆角
 *   --radius-card  卡片/面板圆角
 *   --font-sans    字体族
 *   --text-on-brand 品牌色上的文本色（浅品牌需暗文字，深品牌需白文字）
 */
export const THEMES: ThemeDef[] = [
  {
    id: "classic",
    name: "晴空蔚蓝风",
    desc: "Ant Design 蓝，8px 圆角，系统字体，初版沿用",
    vars: {
      "--brand": "#1677ff",
      "--brand-soft": "#eaf2ff",
      "--bg": "#fafafb",
      "--panel": "#ffffff",
      "--surface": "#ffffff",
      "--border": "#ececf0",
      "--border-strong": "#e0e0e6",
      "--text": "#1c1c20",
      "--muted": "#8b8b94",
      "--ok": "#16a34a",
      "--danger": "#ff4d4f",
      "--input-bg": "#ffffff",
      "--radius": "8px",
      "--radius-card": "12px",
      "--font-sans": "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
      "--text-on-brand": "#ffffff",
    },
  },
  {
    id: "shimo",
    name: "石磨复古风",
    desc: "暖纸底色，砖红印记，Oswald 字体",
    vars: {
      "--brand": "#A6271C",
      "--brand-soft": "#F3E4C4",
      "--bg": "#F4EDE1",
      "--panel": "#FBF7F0",
      "--surface": "#FFFDF9",
      "--border": "rgba(43,33,24,0.10)",
      "--border-strong": "rgba(43,33,24,0.18)",
      "--text": "#2B2118",
      "--muted": "#6B5D4D",
      "--ok": "#2F5D3A",
      "--danger": "#A6271C",
      "--input-bg": "#FFFDF9",
      "--radius": "8px",
      "--radius-card": "10px",
      "--font-sans": "'Oswald', 'Inter', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
      "--text-on-brand": "#ffffff",
    },
  },
  {
    id: "yemu",
    name: "夜幕苍穹风",
    desc: "深邃夜幕，蓝白辉映，Inter 字体",
    vars: {
      "--brand": "#64CEFB",
      "--brand-soft": "rgba(100,206,251,0.18)",
      "--bg": "#0a0a0a",
      "--panel": "#141414",
      "--surface": "#1c1c1c",
      "--border": "#2e2e2e",
      "--border-strong": "#444444",
      "--text": "#f5f5f5",
      "--muted": "#b0b8c4",
      "--ok": "#34d399",
      "--danger": "#f87171",
      "--input-bg": "#1c1c1c",
      "--radius": "999px",
      "--radius-card": "12px",
      "--font-sans": "'Inter', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
      "--text-on-brand": "#080810",
    },
  },
  {
    id: "nuancheng",
    name: "和煦橙光风",
    desc: "暖橙点缀，圆润明快，Poppins 字体",
    vars: {
      "--brand": "#fe6019",
      "--brand-soft": "#fff3eb",
      "--bg": "#ffffff",
      "--panel": "#ffffff",
      "--surface": "#ffffff",
      "--border": "#dee2e6",
      "--border-strong": "#ffece4",
      "--text": "#222222",
      "--muted": "#666666",
      "--ok": "#16a34a",
      "--danger": "#dc2626",
      "--input-bg": "#ffffff",
      "--radius": "8px",
      "--radius-card": "10px",
      "--font-sans": "'Poppins', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
      "--text-on-brand": "#ffffff",
    },
  },
  {
    id: "yecui",
    name: "浅滩椰林风",
    desc: "暖白底色，苍翠点缀，Geist 字体",
    vars: {
      "--brand": "#5b8b6e",
      "--brand-soft": "#e8f0eb",
      "--bg": "#f5f3f1",
      "--panel": "#fafaf8",
      "--surface": "#ffffff",
      "--border": "#e5e2de",
      "--border-strong": "#d5d0cb",
      "--text": "#1c1c20",
      "--muted": "#7a7572",
      "--ok": "#5b8b6e",
      "--danger": "#c75050",
      "--input-bg": "#ffffff",
      "--radius": "6px",
      "--radius-card": "12px",
      "--font-sans": "'Geist', 'Inter', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
      "--text-on-brand": "#ffffff",
    },
  },
];

/** 默认主题 id */
export const DEFAULT_THEME_ID = "classic";

/** localStorage key */
export const THEME_STORAGE_KEY = "yd_theme";
