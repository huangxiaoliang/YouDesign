"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cssColorToHex, validateDirectStyleInput, type DirectTextBinding } from "@/lib/directHtmlEditor";

export type DirectHtmlInspectorSelection = {
  selectionKey: number;
  label: string;
  breadcrumbs: string[];
  text: DirectTextBinding | null;
  styles: Record<string, string>;
};

type Props = {
  selection: DirectHtmlInspectorSelection | null;
  canUndo: boolean;
  canRedo: boolean;
  canReset: boolean;
  dirty: boolean;
  onTextChange: (value: string) => void;
  onStyleChange: (property: string, value: string) => void;
  onSelectAncestor: (index: number) => void;
  onSelectParent: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onReset: () => void;
  onDiscard: () => void;
  onSave: () => void;
};

const typographyFields = [
  ["font-family", "字体"],
  ["font-size", "字号"],
  ["font-weight", "字重"],
  ["line-height", "行高"],
  ["letter-spacing", "字间距"],
] as const;

const spacingFields = [
  ["padding", "内边距"],
  ["margin", "外边距"],
  ["gap", "元素间距"],
] as const;

const containerFields = [
  ["border-width", "边框粗细"],
  ["border-radius", "圆角"],
  ["box-shadow", "阴影"],
  ["opacity", "透明度"],
] as const;

/**
 * 把 computedStyle 返回的 rgb()/rgba() 颜色归一成 HEX 用于展示与输入。
 * - 空值保持空（否则 cssColorToHex("") 会落到 #ffffff，误导用户以为设了白色）
 * - 已是 HEX 就规范化小写
 * - 带透明度（alpha != 1）的 rgba 原样保留：原生 <input type="color"> 本就不支持 alpha，
 *   转成 #hex 会丢掉透明度，显示成不透明会造成假信息
 */
function toDisplayHex(value: string): string {
  const v = value.trim();
  if (!v) return "";
  if (/^#([\da-f]{3}|[\da-f]{6})$/i.test(v)) return v.toLowerCase();
  const rgba = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
  if (!rgba) return v; // 命名色等其它格式，computed 实际不会出现，原样保留
  if (rgba[4] !== undefined && Number(rgba[4]) !== 1) return v; // 半透明保留 rgba
  return cssColorToHex(v);
}

function CssValueInput({
  property,
  label,
  value,
  onApply,
  onValidityChange,
  resetKey,
  placeholder,
}: {
  property: string;
  label: string;
  value: string;
  onApply: (value: string) => void;
  onValidityChange: (property: string, error: string | null) => void;
  resetKey: number;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const focusedRef = useRef(false);
  const latestValueRef = useRef(value);
  const errorId = useId();
  latestValueRef.current = value;

  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  useEffect(() => {
    focusedRef.current = false;
    setDraft(value);
    setError(null);
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  function applyDraft(next: string) {
    setDraft(next);
    const validation = validateDirectStyleInput(property, next);
    const nextError = validation.valid ? null : validation.error || "格式无效";
    setError(nextError);
    onValidityChange(property, nextError);
    if (validation.valid) onApply(validation.value);
    return validation.valid;
  }

  return (
    <label className="direct-inspector-field">
      <span>{label}</span>
      <input
        value={draft}
        placeholder={placeholder}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onChange={(event) => {
          applyDraft(event.target.value);
        }}
        onBlur={() => {
          focusedRef.current = false;
          if (applyDraft(draft)) window.requestAnimationFrame(() => setDraft(latestValueRef.current));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
      />
      {error && <small id={errorId} className="direct-inspector-field-error">{error}</small>}
    </label>
  );
}

function ColorField({
  property,
  label,
  value,
  onApply,
  onValidityChange,
  resetKey,
  normalizeHex = true,
}: {
  property: string;
  label: string;
  value: string;
  onApply: (value: string) => void;
  onValidityChange: (property: string, error: string | null) => void;
  resetKey: number;
  /** true=文本框展示归一成 HEX（默认）；false=保留 computed 原值 rgb/rgba（用于背景颜色等带透明度场景） */
  normalizeHex?: boolean;
}) {
  const displayValue = normalizeHex ? toDisplayHex(value) : value;
  return (
    <div className="direct-inspector-color-field">
      <CssValueInput
        property={property}
        label={label}
        value={displayValue}
        onApply={onApply}
        onValidityChange={onValidityChange}
        resetKey={resetKey}
        placeholder="#1677ff / rgba(...)"
      />
      <input
        className="direct-inspector-color-picker"
        type="color"
        value={cssColorToHex(value)}
        aria-label={`${label}取色器`}
        onChange={(event) => {
          onValidityChange(property, null);
          onApply(event.target.value);
        }}
      />
    </div>
  );
}

export function DirectHtmlInspector({
  selection,
  canUndo,
  canRedo,
  canReset,
  dirty,
  onTextChange,
  onStyleChange,
  onSelectAncestor,
  onSelectParent,
  onUndo,
  onRedo,
  onReset,
  onDiscard,
  onSave,
}: Props) {
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const selectionKey = selection?.selectionKey || 0;

  // 普通编辑模式下，属性面板可按住头部拖动到预览区任意位置。
  // dragPos 为 null 时保持默认右侧吸附布局（CSS 的 top/right/bottom）；
  // 一旦越过阈值真正进入拖动，才切换为自由定位（left/top + 显式 width/height），
  // 避免纯点击/抖动悄悄改变布局语义。
  const DRAG_THRESHOLD = 4; // px，低于此视为点击
  const rootRef = useRef<HTMLElement | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
    width: number;
    height: number;
    parentWidth: number;
    parentHeight: number;
    engaged: boolean; // 是否已越过阈值、真正进入拖动
  } | null>(null);
  const [dragPos, setDragPos] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    setValidationErrors({});
  }, [selectionKey]);

  useEffect(() => {
    if (!dragging) return;
    function onMove(event: PointerEvent) {
      const s = dragStateRef.current;
      if (!s || event.pointerId !== s.pointerId) return; // 忽略其它指针，防多点触控跳变
      const dx = event.clientX - s.startX;
      const dy = event.clientY - s.startY;
      if (!s.engaged) {
        if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return; // 未越过阈值，当作点击
        s.engaged = true;
        // 此刻把吸附位置固化为自由定位原点，originLeft/Top 已在 pointerdown 记录，切换布局无跳变
      }
      const maxLeft = Math.max(0, s.parentWidth - s.width);
      const maxTop = Math.max(0, s.parentHeight - s.height);
      const left = Math.min(Math.max(s.originLeft + dx, 0), maxLeft);
      const top = Math.min(Math.max(s.originTop + dy, 0), maxTop);
      setDragPos({ left, top, width: s.width, height: s.height });
    }
    function onEnd() {
      setDragging(false);
      dragStateRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  }, [dragging]);

  // 父容器尺寸变化时（缩窗、切移动端预览、全屏等）重新裁剪已落定位置，
  // 避免面板跑到视口外抓不回来。
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const parent = root.offsetParent as HTMLElement | null;
    if (!parent) return;
    const ro = new ResizeObserver(() => {
      setDragPos((cur) => {
        if (!cur) return cur;
        const pr = parent.getBoundingClientRect();
        const maxLeft = Math.max(0, pr.width - cur.width);
        const maxTop = Math.max(0, pr.height - cur.height);
        const left = Math.min(Math.max(cur.left, 0), maxLeft);
        const top = Math.min(Math.max(cur.top, 0), maxTop);
        if (left === cur.left && top === cur.top) return cur;
        return { ...cur, left, top };
      });
    });
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  function handleHeadPointerDown(event: React.PointerEvent) {
    if (event.button !== 0) return; // 仅主键
    // 点击到头部内的按钮（撤销/重做等）时不触发拖动，让按钮正常工作。
    if ((event.target as Element).closest("button")) return;
    const root = rootRef.current;
    if (!root) return;
    const parent = root.offsetParent as HTMLElement | null;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const rect = root.getBoundingClientRect();
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: rect.left - parentRect.left,
      originTop: rect.top - parentRect.top,
      width: rect.width,
      height: rect.height,
      parentWidth: parentRect.width,
      parentHeight: parentRect.height,
      engaged: false,
    };
    // 捕获指针：拖动经过 iframe 预览区时，pointermove 不会被 iframe 吞掉而卡顿。
    try {
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
    } catch {
      // 极少数合成事件 pointerId 无效，忽略，退化为普通监听
    }
    setDragging(true);
  }

  function handleHeadDoubleClick(event: React.MouseEvent) {
    // 双击头部空白处一键归位到右侧吸附；点在按钮上则不处理。
    if ((event.target as Element).closest("button")) return;
    setDragPos(null);
  }

  function handleValidityChange(property: string, error: string | null) {
    setValidationErrors((current) => {
      if (!error) {
        if (!current[property]) return current;
        const next = { ...current };
        delete next[property];
        return next;
      }
      if (current[property] === error) return current;
      return { ...current, [property]: error };
    });
  }

  const hasValidationErrors = Object.keys(validationErrors).length > 0;

  return (
    <aside
      ref={rootRef}
      className={`direct-inspector${dragging ? " dragging" : ""}`}
      style={
        dragPos
          ? { left: dragPos.left, top: dragPos.top, width: dragPos.width, height: dragPos.height, right: "auto", bottom: "auto" }
          : undefined
      }
      aria-label="元素属性编辑器"
    >
      <div
        className="direct-inspector-head"
        onPointerDown={handleHeadPointerDown}
        onDoubleClick={handleHeadDoubleClick}
      >
        <div
          className="direct-inspector-title"
          title="按住拖动 · 双击归位"
        >
          <i className="direct-inspector-grip" aria-hidden="true" />
          <div className="direct-inspector-title-text">
            <strong>元素属性</strong>
            <span>{selection?.label || "请在原型中选择一个元素"}</span>
            {dirty && <em>有未保存修改</em>}
          </div>
        </div>
        <div className="direct-inspector-history">
          <button type="button" onClick={onUndo} disabled={!canUndo} title="撤销上一步">
            ↶
          </button>
          <button type="button" onClick={onRedo} disabled={!canRedo} title="重做上一步">
            ↷
          </button>
        </div>
      </div>

      {!selection ? (
        <div className="direct-inspector-empty">
          点击原型中的文字、按钮或容器。选中后可直接修改文案和视觉属性，修改会即时显示。
        </div>
      ) : (
        <div className="direct-inspector-scroll">
          <div className="direct-inspector-tree">
            <div className="direct-inspector-breadcrumbs" aria-label="元素层级">
              {selection.breadcrumbs.map((item, index) => (
                <button
                  key={`${item}-${index}`}
                  type="button"
                  className={index === selection.breadcrumbs.length - 1 ? "active" : ""}
                  onClick={() => onSelectAncestor(index)}
                  aria-current={index === selection.breadcrumbs.length - 1 ? "page" : undefined}
                  title={item}
                >
                  {item}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="direct-inspector-parent"
              onClick={onSelectParent}
              disabled={selection.breadcrumbs.length < 2}
            >
              ↑ 选择父级
            </button>
          </div>
          {selection.text && (
            <section className="direct-inspector-section">
              <h3>内容</h3>
              <label className="direct-inspector-copy">
                <span>{selection.text.label}</span>
                <textarea value={selection.text.value} onChange={(event) => onTextChange(event.target.value)} />
              </label>
            </section>
          )}

          <section className="direct-inspector-section">
            <h3>文字</h3>
            {typographyFields.map(([property, label]) => (
              <CssValueInput
                key={property}
                property={property}
                label={label}
                value={selection.styles[property] || ""}
                onApply={(value) => onStyleChange(property, value)}
                onValidityChange={handleValidityChange}
                resetKey={selectionKey}
              />
            ))}
            <label className="direct-inspector-field">
              <span>对齐</span>
              <select value={selection.styles["text-align"] || "start"} onChange={(event) => onStyleChange("text-align", event.target.value)}>
                <option value="start">默认</option>
                <option value="left">左对齐</option>
                <option value="center">居中</option>
                <option value="right">右对齐</option>
                <option value="justify">两端对齐</option>
              </select>
            </label>
            <ColorField
              property="color"
              label="文字颜色"
              value={selection.styles.color || ""}
              onApply={(value) => onStyleChange("color", value)}
              onValidityChange={handleValidityChange}
              resetKey={selectionKey}
            />
          </section>

          <section className="direct-inspector-section">
            <h3>间距</h3>
            {spacingFields.map(([property, label]) => (
              <CssValueInput
                key={property}
                property={property}
                label={label}
                value={selection.styles[property] || ""}
                onApply={(value) => onStyleChange(property, value)}
                onValidityChange={handleValidityChange}
                resetKey={selectionKey}
                placeholder="如 8px 12px"
              />
            ))}
          </section>

          <section className="direct-inspector-section">
            <h3>容器外观</h3>
            <ColorField
              property="background-color"
              label="背景颜色"
              value={selection.styles["background-color"] || ""}
              onApply={(value) => onStyleChange("background-color", value)}
              onValidityChange={handleValidityChange}
              resetKey={selectionKey}
              normalizeHex={false}
            />
            <ColorField
              property="border-color"
              label="边框颜色"
              value={selection.styles["border-color"] || ""}
              onApply={(value) => onStyleChange("border-color", value)}
              onValidityChange={handleValidityChange}
              resetKey={selectionKey}
            />
            {containerFields.map(([property, label]) => (
              <CssValueInput
                key={property}
                property={property}
                label={label}
                value={selection.styles[property] || ""}
                onApply={(value) => onStyleChange(property, value)}
                onValidityChange={handleValidityChange}
                resetKey={selectionKey}
              />
            ))}
            <label className="direct-inspector-field">
              <span>边框样式</span>
              <select value={selection.styles["border-style"] || "none"} onChange={(event) => onStyleChange("border-style", event.target.value)}>
                <option value="none">无</option>
                <option value="solid">实线</option>
                <option value="dashed">虚线</option>
                <option value="dotted">点线</option>
                <option value="double">双线</option>
              </select>
            </label>
          </section>
        </div>
      )}

      <div className="direct-inspector-foot">
        <div className="direct-inspector-reset-row">
          <button type="button" className="link" onClick={onReset} disabled={!selection || !canReset}>
            重置当前元素
          </button>
          <span className={hasValidationErrors ? "error" : ""}>
            {hasValidationErrors ? "请先修正无效属性" : "支持 px、%、em、rem 与 CSS 颜色值"}
          </span>
        </div>
        <div className="direct-inspector-actions">
          <button type="button" className="link" onClick={onDiscard}>放弃</button>
          <button type="button" className="send sm" onClick={onSave} disabled={!dirty || hasValidationErrors}>保存修改</button>
        </div>
      </div>
    </aside>
  );
}
