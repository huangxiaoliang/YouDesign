"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { STYLE_PROFILE_OPTIONS } from "@/lib/style/profiles";
import type { ModelPreference } from "@/lib/types";

const ELEM_MARKER = "\n\n目标元素（请在原 HTML 中精确定位，以它为锚点选择合适作用域修改，其余保持不变）：\n";
const OLD_ELEM_MARKER = "\n\n目标元素（请在原 HTML 中精确定位并只改这个元素，其余保持不变）：\n";

type StylePreviewKind = "admin" | "commerce" | "antd" | "tdesign" | "mobile" | "gallery" | "editorial" | "docs" | "mesh" | "developer";
type StylePreviewMeta = {
  id: string;
  name: string;
  kind: StylePreviewKind;
  title: string;
  subtitle: string;
  font: string;
  bg: string;
  surface: string;
  ink: string;
  muted: string;
  primary: string;
  accent: string;
  border: string;
  radius: string;
  shadow?: string;
};

export const MODEL_PREFERENCE_OPTIONS: Array<{ value: ModelPreference; label: string }> = [
  { value: "auto", label: "默认模型" },
  { value: "kimiK3", label: "kimi-k3" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "glm", label: "GLM-5.2" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
];
export const VISION_MODEL_PREFERENCE_OPTIONS: Array<{ value: ModelPreference; label: string }> = [
  { value: "glm5v", label: "GLM-5V" },
  { value: "kimiK3", label: "kimi-k3" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
];

const STYLE_PREVIEWS: StylePreviewMeta[] = [
  {
    id: "ant-design",
    name: "Ant Design",
    kind: "antd",
    title: "工作台",
    subtitle: "清晰层级 + 轻量任务概览",
    font: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
    bg: "#F5F5F5",
    surface: "#FFFFFF",
    ink: "rgba(0,0,0,0.88)",
    muted: "rgba(0,0,0,0.45)",
    primary: "#1677FF",
    accent: "#E6F4FF",
    border: "#D9D9D9",
    radius: "6px",
  },
  {
    id: "tdesign",
    name: "TDesign",
    kind: "tdesign",
    title: "运营概览",
    subtitle: "腾讯蓝 + 数据化工作台",
    font: '"PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, sans-serif',
    bg: "#F3F3F3",
    surface: "#FFFFFF",
    ink: "#000000E6",
    muted: "#00000099",
    primary: "#0052D9",
    accent: "#F2F3FF",
    border: "#E7E7E7",
    radius: "6px",
  },
  {
    id: "vant",
    name: "Vant",
    kind: "mobile",
    title: "移动服务",
    subtitle: "轻量 H5 + Cell 列表",
    font: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", sans-serif',
    bg: "#F7F8FA",
    surface: "#FFFFFF",
    ink: "#323233",
    muted: "#969799",
    primary: "#1989FA",
    accent: "#E8F3FF",
    border: "#EBEDF0",
    radius: "8px",
  },
  {
    id: "apple",
    name: "Apple",
    kind: "gallery",
    title: "Product Gallery",
    subtitle: "edge-to-edge tiles",
    font: '"SF Pro Text", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
    bg: "#F5F5F7",
    surface: "#FFFFFF",
    ink: "#1D1D1F",
    muted: "#7A7A7A",
    primary: "#0066CC",
    accent: "#272729",
    border: "#E0E0E0",
    radius: "18px",
  },
  {
    id: "claude",
    name: "Claude",
    kind: "editorial",
    title: "Thinking Partner",
    subtitle: "cream + coral + product mockup",
    font: '"StyreneB", "Inter", -apple-system, BlinkMacSystemFont, sans-serif',
    bg: "#FAF9F5",
    surface: "#EFE9DE",
    ink: "#141413",
    muted: "#6C6A64",
    primary: "#CC785C",
    accent: "#181715",
    border: "#E6DFD8",
    radius: "12px",
  },
  {
    id: "notion",
    name: "Notion",
    kind: "docs",
    title: "Workspace",
    subtitle: "paper calm + one blue",
    font: '"NotionInter", "Inter", -apple-system, BlinkMacSystemFont, sans-serif',
    bg: "#F6F5F4",
    surface: "#FFFFFF",
    ink: "#000000",
    muted: "#615D59",
    primary: "#0075DE",
    accent: "#213183",
    border: "#E6E6E6",
    radius: "12px",
    shadow: "0 4px 18px rgba(0,0,0,0.04)",
  },
  {
    id: "slack",
    name: "Slack",
    kind: "mesh",
    title: "Team Hub",
    subtitle: "aubergine + pastel mesh",
    font: '"Salesforce-Sans", "Inter", system-ui, sans-serif',
    bg: "#F4EDE4",
    surface: "#FFFFFF",
    ink: "#1D1D1D",
    muted: "#696969",
    primary: "#4A154B",
    accent: "#1264A3",
    border: "#E6E6E6",
    radius: "16px",
    shadow: "0 0 32px rgba(0,0,0,0.10)",
  },
  {
    id: "vercel",
    name: "Vercel",
    kind: "developer",
    title: "Deployments",
    subtitle: "Geist + hairline cards",
    font: '"Geist", "Inter", Arial, sans-serif',
    bg: "#FAFAFA",
    surface: "#FFFFFF",
    ink: "#171717",
    muted: "#4D4D4D",
    primary: "#171717",
    accent: "#0070F3",
    border: "#EBEBEB",
    radius: "12px",
    shadow: "0 1px 1px rgba(0,0,0,0.04)",
  },
];

const STYLE_PREVIEW_BY_ID = new Map(STYLE_PREVIEWS.map((p) => [p.id, p]));

export function MsgContent({ content }: { content: string }) {
  const marker = content.includes(ELEM_MARKER) ? ELEM_MARKER : OLD_ELEM_MARKER;
  const idx = content.indexOf(marker);
  if (idx === -1) return <>{content}</>;
  return (
    <>
      {content.slice(0, idx)}
      <details className="msg-code">
        <summary>目标元素代码（点击展开）</summary>
        <pre>{content.slice(idx + marker.length)}</pre>
      </details>
    </>
  );
}

function renderStylePreview(preview: StylePreviewMeta) {
  if (preview.kind === "antd") {
    return (
      <div className="style-preview-app style-preview-antd-app">
        <header>
          <b><i>◆</i> Acme CRM</b>
          <span>工作台</span>
          <span>项目</span>
          <em />
          <label>⌕ 搜索</label>
          <strong>Y</strong>
        </header>
        <main>
          <div className="style-preview-antd-crumb">首页 <i>/</i> 工作台</div>
          <div className="style-preview-antd-heading">
            <div><b>下午好，林一</b><span>开始处理今天的重点工作</span></div>
            <button>+ 新建项目</button>
          </div>
          <section className="style-preview-antd-stats">
            <article><span>待处理任务</span><b>12</b><i>较昨日 +3</i></article>
            <article><span>本周完成</span><b>86%</b><i>↑ 12.5%</i></article>
            <article><span>进行中项目</span><b>08</b><i>正常推进</i></article>
          </section>
          <section className="style-preview-antd-bottom">
            <article>
              <div><b>进行中的项目</b><span>查看全部 ›</span></div>
              <p><i /> 品牌官网改版 <em>进行中</em></p>
              <p><i /> 会员中心优化 <em>待评审</em></p>
            </article>
            <article className="style-preview-antd-tasks">
              <b>我的待办</b>
              <p><i /> 审核需求文档</p>
              <p><i /> 确认本周排期</p>
            </article>
          </section>
        </main>
      </div>
    );
  }

  if (preview.kind === "tdesign") {
    return (
      <div className="style-preview-app style-preview-tdesign-app">
        <header>
          <div><b>运营数据中心</b><span>实时更新 · 07月27日</span></div>
          <button>下载报表</button>
        </header>
        <main>
          <section className="style-preview-tdesign-overview">
            <div className="style-preview-tdesign-period"><b>经营概览</b><span>近 7 天⌄</span></div>
            <div className="style-preview-tdesign-metrics">
              <article><span>访问量</span><b>28,634</b><i>+18.2%</i></article>
              <article><span>新增用户</span><b>1,248</b><i>+8.6%</i></article>
              <article><span>转化率</span><b>7.32%</b><i>+1.4%</i></article>
            </div>
          </section>
          <section className="style-preview-tdesign-content">
            <article className="style-preview-tdesign-chart">
              <div><b>趋势分析</b><span>访问量</span></div>
              <div className="style-preview-tdesign-graph"><i /><i /><i /><i /><i /><i /></div>
              <footer><span>07/21</span><span>07/23</span><span>07/25</span><span>今天</span></footer>
            </article>
            <article className="style-preview-tdesign-notice">
              <b>待处理事项</b>
              <p><i>1</i><span>完成内容审核</span><em>今天</em></p>
              <p><i>2</i><span>跟进异常订单</span><em>明天</em></p>
              <p><i>3</i><span>更新活动配置</span><em>周五</em></p>
            </article>
          </section>
        </main>
      </div>
    );
  }

  if (preview.kind === "mobile") {
    return (
      <div className="style-preview-app style-preview-mobile-app">
        <nav>
          <b>‹</b>
          <strong>客户服务</strong>
          <span>•••</span>
        </nav>
        <section>
          <p>今日待处理</p>
          <div className="style-preview-mobile-card">
            <b>杭州青鹿科技</b>
            <span>客户回访 · 今天 15:00</span>
            <button>去处理</button>
          </div>
          <div className="style-preview-mobile-group">
            <span>客户信息 <i>›</i></span>
            <span>跟进记录 <i>›</i></span>
            <span>AI 建议 <em>新</em><i>›</i></span>
          </div>
        </section>
        <footer><span className="active">首页</span><span>客户</span><span>待办</span><span>我的</span></footer>
      </div>
    );
  }

  if (preview.kind === "gallery") {
    return (
      <div className="style-preview-app style-preview-gallery-app">
        <nav>
          <span>Store</span>
          <span>Mac</span>
          <span>iPad</span>
          <span>iPhone</span>
          <span>Watch</span>
        </nav>
        <section>
          <div>
            <p>MacBook Pro</p>
            <h2>Mind-blowing. Head-turning.</h2>
            <button>Buy</button>
          </div>
          <div className="style-preview-device">
            <i />
            <i />
          </div>
        </section>
        <div className="style-preview-gallery-grid">
          <article>iPhone 16 Pro</article>
          <article>Apple Watch</article>
        </div>
      </div>
    );
  }

  if (preview.kind === "editorial") {
    return (
      <div className="style-preview-app style-preview-editorial-app">
        <nav>
          <b>Claude</b>
          <span>Product</span>
          <span>Research</span>
          <button>Try Claude</button>
        </nav>
        <section>
          <div className="style-preview-editorial-copy">
            <p>AI assistant</p>
            <h2>Meet your thinking partner.</h2>
            <span>Warm editorial pages with calm surfaces and precise coral actions.</span>
          </div>
          <div className="style-preview-chat">
            <b>How can I help shape this flow?</b>
            <span />
            <span />
            <i />
          </div>
        </section>
      </div>
    );
  }

  if (preview.kind === "docs") {
    return (
      <div className="style-preview-app style-preview-docs-app">
        <aside>
          <b>Workspace</b>
          <span>Roadmap</span>
          <span>Projects</span>
          <span>Notes</span>
        </aside>
        <main>
          <p>Product OS</p>
          <h2>Roadmap</h2>
          <div className="style-preview-doc-block strong" />
          <div className="style-preview-doc-block" />
          <div className="style-preview-doc-row">
            <i />
            <i />
            <i />
          </div>
        </main>
      </div>
    );
  }

  if (preview.kind === "mesh") {
    return (
      <div className="style-preview-app style-preview-slack-app">
        <nav>
          <b>slack</b>
          <span>Product</span>
          <span>Enterprise</span>
          <button>Get started</button>
        </nav>
        <section>
          <div>
            <h2>Where work happens.</h2>
            <p>Channels, messages, and shared context in a friendly workspace.</p>
            <button>Start now</button>
          </div>
          <div className="style-preview-slack-panel">
            <b># design-system</b>
            <span />
            <span />
            <i />
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="style-preview-app style-preview-developer-app">
      <nav>
        <b>▲ Vercel</b>
        <span>Dashboard</span>
        <span>Projects</span>
        <button>Deploy</button>
      </nav>
      <section>
        <div>
          <p>Production</p>
          <h2>Deployments</h2>
        </div>
        <div className="style-preview-deploy-card">
          <b>you-design.app</b>
          <span>Ready</span>
          <i />
        </div>
      </section>
      <div className="style-preview-deploy-list">
        <span>main · 42s</span>
        <span>preview · 3m</span>
        <span>edge · 8m</span>
      </div>
    </div>
  );
}

export function StylePreviewCard({ preview, size = "compact" }: { preview: StylePreviewMeta; size?: "compact" | "large" }) {
  return (
    <div
      className={`style-preview-card ${size === "large" ? "style-preview-card-large" : ""} style-preview-${preview.kind}`}
      style={
        {
          "--sp-bg": preview.bg,
          "--sp-surface": preview.surface,
          "--sp-ink": preview.ink,
          "--sp-muted": preview.muted,
          "--sp-primary": preview.primary,
          "--sp-accent": preview.accent,
          "--sp-border": preview.border,
          "--sp-radius": preview.radius,
          "--sp-font": preview.font,
          "--sp-shadow": preview.shadow ?? "none",
        } as CSSProperties
      }
      aria-label={`${preview.name} 风格预览`}
    >
      <div className="style-preview-frame">
        <div className="style-preview-chrome" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        {renderStylePreview(preview)}
      </div>
      <div className="style-preview-caption">
        <b>{preview.name}</b>
        <span>{preview.subtitle}</span>
      </div>
    </div>
  );
}

export function ModelPreferencePicker({
  value,
  onChange,
  disabled,
  title,
  options = MODEL_PREFERENCE_OPTIONS,
}: {
  value: ModelPreference;
  onChange: (value: ModelPreference) => void;
  disabled?: boolean;
  title: string;
  options?: Array<{ value: ModelPreference; label: string }>;
}) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selected = options.find((option) => option.value === value);

  const cancelClose = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 120);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => () => cancelClose(), []);

  return (
    <div
      className="style-picker"
      ref={pickerRef}
      onMouseEnter={() => {
        cancelClose();
        if (!disabled) setOpen(true);
      }}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className={`style-picker-trigger${open ? " open" : ""}`}
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          height: "28px",
          padding: "0 24px 0 12px",
          boxSizing: "border-box",
          lineHeight: "1",
        }}
        onClick={() => !disabled && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            lineHeight: "1",
            whiteSpace: "nowrap",
            fontSize: "11.5px",
          }}
        >
          {selected?.label ?? "默认模型"}
        </span>
        <span
          aria-hidden="true"
          className="dropdown-arrow"
          style={{
            position: "absolute",
            right: "10px",
            top: "50%",
            transform: open
              ? "translateY(-30%) rotate(-135deg) scaleY(0.85)"
              : "translateY(-70%) rotate(45deg) scaleY(0.85)",
            width: "5px",
            height: "5px",
            borderRight: "1px solid currentColor",
            borderBottom: "1px solid currentColor",
            opacity: 0.6,
            boxSizing: "border-box",
            transition: "transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s",
          }}
        />
      </button>
      {open && (
        <div className="style-picker-popover" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          <div className="style-picker-list" role="listbox" aria-label="模型选择">
            {options.map((option) => (
              <button
                type="button"
                key={option.value}
                className={`style-picker-option${option.value === value ? " selected" : ""}`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                role="option"
                aria-selected={option.value === value}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function StyleProfilePicker({
  value,
  onChange,
  disabled,
  noHoverPreview,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** 标注修改弹窗里禁用 hover 预览(弹窗空间小,预览会遮挡);首页不传则保留 */
  noHoverPreview?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selected = STYLE_PROFILE_OPTIONS.find((p) => p.id === value);
  const preview = hoverId ? STYLE_PREVIEW_BY_ID.get(hoverId) : undefined;

  const cancelClose = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      setOpen(false);
      setHoverId(null);
      closeTimerRef.current = null;
    }, 120);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
      setHoverId(null);
    }
  }, [disabled]);

  useEffect(() => {
    if (open) setHoverId(null);
  }, [open]);

  useEffect(() => () => cancelClose(), []);

  return (
    <div
      className="style-picker"
      ref={pickerRef}
      onMouseEnter={() => {
        cancelClose();
        if (!disabled) setOpen(true);
      }}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className={`style-picker-trigger${open ? " open" : ""}`}
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          height: "28px",
          padding: "0 24px 0 12px",
          boxSizing: "border-box",
          lineHeight: "1",
        }}
        onClick={() => !disabled && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        disabled={disabled}
        title="选择产品风格档案，让生成结果贴近该产品设计风格"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            lineHeight: "1",
            whiteSpace: "nowrap",
            fontSize: "11.5px",
          }}
        >
          {selected?.name ?? "默认风格"}
        </span>
        <span
          aria-hidden="true"
          className="dropdown-arrow"
          style={{
            position: "absolute",
            right: "10px",
            top: "50%",
            transform: open
              ? "translateY(-30%) rotate(-135deg) scaleY(0.85)"
              : "translateY(-70%) rotate(45deg) scaleY(0.85)",
            width: "5px",
            height: "5px",
            borderRight: "1px solid currentColor",
            borderBottom: "1px solid currentColor",
            opacity: 0.6,
            boxSizing: "border-box",
            transition: "transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s",
          }}
        />
      </button>
      {open && (
        <div className="style-picker-popover" onMouseLeave={() => setHoverId(null)} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          <div className="style-picker-list" role="listbox" aria-label="产品风格档案">
            <button
              type="button"
              className={`style-picker-option${value === "" ? " selected" : ""}`}
              onMouseEnter={() => setHoverId(null)}
              onFocus={() => setHoverId(null)}
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              role="option"
              aria-selected={value === ""}
            >
              默认风格
            </button>
            {STYLE_PROFILE_OPTIONS.map((p) => (
              <button
                type="button"
                key={p.id}
                className={`style-picker-option${p.id === value ? " selected" : ""}${p.id === hoverId ? " hover" : ""}`}
                onMouseEnter={() => setHoverId(p.id)}
                onFocus={() => setHoverId(p.id)}
                onClick={() => {
                  onChange(p.id);
                  setOpen(false);
                }}
                role="option"
                aria-selected={p.id === value}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {open && preview && !noHoverPreview && (
        <div className="style-picker-hover-preview" aria-hidden="true">
          <StylePreviewCard preview={preview} />
        </div>
      )}
    </div>
  );
}
