export const DIRECT_EDIT_SELECTED_ATTR = "data-yd-direct-edit-selected";
export const DIRECT_EDIT_STYLE_ATTR = "data-yd-direct-edit-style";

export type DirectTextKind = "text" | "value" | "placeholder" | "alt";

export type DirectTextBinding = {
  kind: DirectTextKind;
  label: string;
  value: string;
  /** 当绑定的是元素内某个文本子节点时，记录其在 childNodes 中的索引；undefined 表示整元素 textContent。 */
  nodeIndex?: number;
};

export type DirectStyleState = {
  value: string;
  priority: string;
};

export type DirectTextState = {
  value: string;
  hadAttribute: boolean;
};

export type DirectStyleChange = {
  kind: "style";
  element: HTMLElement;
  property: string;
  before: DirectStyleState;
  after: DirectStyleState;
};

export type DirectTextChange = {
  kind: "text";
  element: HTMLElement;
  textKind: DirectTextKind;
  before: DirectTextState;
  after: DirectTextState;
  /** 绑定到元素内文本子节点时的索引；与 DirectTextBinding.nodeIndex 对应，写入只改该文本节点不动图标等子元素。 */
  nodeIndex?: number;
};

export type DirectEditChange = DirectStyleChange | DirectTextChange;

export type DirectStyleValidation = {
  valid: boolean;
  value: string;
  error?: string;
};

type DirectEditTransaction = {
  changes: DirectEditChange[];
  mergeKey?: string;
};

const TEXT_ATTRIBUTE: Partial<Record<DirectTextKind, string>> = {
  value: "value",
  placeholder: "placeholder",
  alt: "alt",
};

function isHtmlElement(node: Element | null): node is HTMLElement {
  const HtmlElement = node?.ownerDocument.defaultView?.HTMLElement;
  return Boolean(node && HtmlElement && node instanceof HtmlElement);
}

function isInputElement(element: HTMLElement): element is HTMLInputElement {
  return element.tagName === "INPUT";
}

function isTextAreaElement(element: HTMLElement): element is HTMLTextAreaElement {
  return element.tagName === "TEXTAREA";
}

function statesEqual(a: DirectStyleState | DirectTextState, b: DirectStyleState | DirectTextState) {
  if ("priority" in a && "priority" in b) return a.value === b.value && a.priority === b.priority;
  if ("hadAttribute" in a && "hadAttribute" in b) return a.value === b.value && a.hadAttribute === b.hadAttribute;
  return false;
}

export function resolveDirectEditElement(target: EventTarget | null): HTMLElement | null {
  let node = target && (target as Node).nodeType === 1 ? (target as Element) : null;
  while (node && !isHtmlElement(node)) node = node.parentElement;
  if (!isHtmlElement(node)) return null;
  const blocked = new Set(["HTML", "BODY", "HEAD", "SCRIPT", "STYLE", "META", "LINK"]);
  return blocked.has(node.tagName) ? null : node;
}

export function stripDirectEditArtifacts(root: Element, sessionToken: string) {
  if (!sessionToken) return;
  if (root.getAttribute(DIRECT_EDIT_SELECTED_ATTR) === sessionToken) root.removeAttribute(DIRECT_EDIT_SELECTED_ATTR);
  root.querySelector(`style[${DIRECT_EDIT_STYLE_ATTR}="${sessionToken}"]`)?.remove();
  root.querySelectorAll(`[${DIRECT_EDIT_SELECTED_ATTR}="${sessionToken}"]`).forEach((node) => node.removeAttribute(DIRECT_EDIT_SELECTED_ATTR));
}

export function describeDirectEditElement(element: HTMLElement): string {
  const id = element.id ? `#${element.id}` : "";
  const classes = Array.from(element.classList).slice(0, 2);
  const className = classes.length ? `.${classes.join(".")}` : "";
  const text = (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 28);
  return `<${element.tagName.toLowerCase()}${id}${className}>${text ? ` · ${text}` : ""}`;
}

export function getDirectEditElementPath(element: HTMLElement): HTMLElement[] {
  const path: HTMLElement[] = [];
  let current: HTMLElement | null = element;
  while (current && !["HTML", "BODY", "HEAD"].includes(current.tagName)) {
    path.unshift(current);
    current = current.parentElement;
  }
  return path;
}

const TEXT_NODE_TYPE = 3;

/**
 * 用 raw 文本节点的前后空白作前后缀，包裹新的可见文本 core。
 * 这样属性面板 textarea 显示 trim 后的干净文案，写入时仍保留图标与文字之间的渲染间距
 * （混排里文本节点的前导空格常是图标与文字的间距来源，直接 trim 写回会让两者贴在一起）。
 */
function preserveTextWhitespace(raw: string, core: string): string {
  const lead = /^\s*/.exec(raw)?.[0] ?? "";
  const trail = /\s*$/.exec(raw)?.[0] ?? "";
  return lead + core + trail;
}

/**
 * 构造一次文字编辑后的状态。text kind 保留原始前后空白（间距不丢）；其余 kind（value/placeholder/alt）原样透传。
 */
export function composeDirectTextAfter(
  before: DirectTextState,
  kind: DirectTextKind,
  input: string
): DirectTextState {
  if (kind === "text") {
    return { value: preserveTextWhitespace(before.value, input.trim()), hadAttribute: true };
  }
  return { value: input, hadAttribute: input.length > 0 };
}

/**
 * 在元素的 childNodes 中找第一个含非空白内容的文本节点，返回其索引；找不到返回 -1。
 * 用于图标+文字混排区块：绑定到这个文本节点，写入时只改 nodeValue，不冲掉图标等子元素。
 */
function findFirstNonEmptyTextNodeIndex(element: HTMLElement): number {
  const nodes = element.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.nodeType === TEXT_NODE_TYPE && (node.nodeValue || "").trim().length > 0) {
      return i;
    }
  }
  return -1;
}

export function readDirectTextBinding(element: HTMLElement): DirectTextBinding | null {
  if (isInputElement(element)) {
    const type = element.type.toLowerCase();
    if (["button", "submit", "reset"].includes(type)) {
      return { kind: "value", label: "按钮文案", value: element.value };
    }
    if (element.hasAttribute("value") && element.value) {
      return { kind: "value", label: "输入值", value: element.value };
    }
    return { kind: "placeholder", label: "占位文案", value: element.placeholder };
  }
  if (isTextAreaElement(element)) {
    if (element.hasAttribute("placeholder") && !element.value) {
      return { kind: "placeholder", label: "占位文案", value: element.placeholder };
    }
    return { kind: "value", label: "输入值", value: element.value };
  }
  if (element.tagName === "IMG") {
    return { kind: "alt", label: "图片说明", value: (element as HTMLImageElement).alt };
  }
  if (element.childElementCount === 0 && !["BR", "HR", "INPUT"].includes(element.tagName)) {
    return { kind: "text", label: "文案", value: (element.textContent || "").trim() };
  }
  // 图标+文字混排：childElementCount > 0，绑定到第一个非空文本子节点，写入只改该 nodeValue 不动子元素。
  const textNodeIndex = findFirstNonEmptyTextNodeIndex(element);
  if (textNodeIndex !== -1) {
    const node = element.childNodes[textNodeIndex];
    // 显示值 trim 掉源码缩进空白；写入时由 composeDirectTextAfter 保留前后空白，间距不丢。
    return { kind: "text", label: "文案", value: (node.nodeValue || "").trim(), nodeIndex: textNodeIndex };
  }
  return null;
}

export function captureDirectStyle(element: HTMLElement, property: string): DirectStyleState {
  return {
    value: element.style.getPropertyValue(property),
    priority: element.style.getPropertyPriority(property),
  };
}

export function captureDirectText(
  element: HTMLElement,
  kind: DirectTextKind,
  nodeIndex?: number
): DirectTextState {
  if (kind === "text") {
    if (typeof nodeIndex === "number") {
      const node = element.childNodes[nodeIndex];
      if (node && node.nodeType === TEXT_NODE_TYPE) {
        return { value: node.nodeValue || "", hadAttribute: true };
      }
    }
    return { value: element.textContent || "", hadAttribute: true };
  }
  const attr = TEXT_ATTRIBUTE[kind];
  if (!attr) return { value: "", hadAttribute: false };
  const liveValue =
    kind === "value" && (isInputElement(element) || isTextAreaElement(element))
      ? (element as HTMLInputElement | HTMLTextAreaElement).value
      : element.getAttribute(attr) || "";
  return { value: liveValue, hadAttribute: element.hasAttribute(attr) };
}

export function applyDirectEditChange(change: DirectEditChange, direction: "before" | "after") {
  if (change.kind === "style") {
    const state = change[direction];
    if (state.value) change.element.style.setProperty(change.property, state.value, state.priority);
    else change.element.style.removeProperty(change.property);
    return;
  }
  const state = change[direction];
  if (change.textKind === "text") {
    if (typeof change.nodeIndex === "number") {
      const node = change.element.childNodes[change.nodeIndex];
      if (node && node.nodeType === TEXT_NODE_TYPE) {
        node.nodeValue = state.value;
      }
      // node 不再是文本节点（DOM 被外部改动）时安全跳过，不回退到整段 textContent 以免冲掉图标。
      return;
    }
    change.element.textContent = state.value;
    return;
  }
  const attr = TEXT_ATTRIBUTE[change.textKind];
  if (!attr) return;
  if (state.hadAttribute) change.element.setAttribute(attr, state.value);
  else change.element.removeAttribute(attr);
  if (change.textKind === "value" && (isInputElement(change.element) || isTextAreaElement(change.element))) {
    (change.element as HTMLInputElement | HTMLTextAreaElement).value = state.value;
  }
}

export function directEditChangeKey(change: DirectEditChange) {
  return change.kind === "style" ? `style:${change.property}` : `text:${change.textKind}`;
}

export class DirectEditHistory {
  private past: DirectEditTransaction[] = [];
  private future: DirectEditTransaction[] = [];

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  get hasChanges() {
    return this.past.length > 0;
  }

  clear() {
    this.past = [];
    this.future = [];
  }

  record(changes: DirectEditChange[], mergeKey?: string) {
    const effective = changes.filter((change) => !statesEqual(change.before, change.after));
    if (!effective.length) return;
    this.future = [];
    const previous = this.past[this.past.length - 1];
    if (mergeKey && previous?.mergeKey === mergeKey && previous.changes.length === 1 && effective.length === 1) {
      const existing = previous.changes[0];
      const incoming = effective[0];
      if (existing.kind === incoming.kind && existing.element === incoming.element && directEditChangeKey(existing) === directEditChangeKey(incoming)) {
        if (existing.kind === "style" && incoming.kind === "style") existing.after = incoming.after;
        else if (existing.kind === "text" && incoming.kind === "text") existing.after = incoming.after;
        if (statesEqual(existing.before, existing.after)) this.past.pop();
        return;
      }
    }
    this.past.push({ changes: effective, mergeKey });
  }

  undo() {
    const transaction = this.past.pop();
    if (!transaction) return false;
    for (let i = transaction.changes.length - 1; i >= 0; i--) applyDirectEditChange(transaction.changes[i], "before");
    this.future.push(transaction);
    return true;
  }

  redo() {
    const transaction = this.future.pop();
    if (!transaction) return false;
    for (const change of transaction.changes) applyDirectEditChange(change, "after");
    this.past.push(transaction);
    return true;
  }
}

export class DirectEditBaselineRegistry {
  private values = new WeakMap<HTMLElement, Map<string, DirectEditChange>>();

  clear() {
    this.values = new WeakMap<HTMLElement, Map<string, DirectEditChange>>();
  }

  remember(change: DirectEditChange) {
    let entries = this.values.get(change.element);
    if (!entries) {
      entries = new Map();
      this.values.set(change.element, entries);
    }
    const key = directEditChangeKey(change);
    if (!entries.has(key)) entries.set(key, change);
  }

  buildResetChanges(element: HTMLElement): DirectEditChange[] {
    const entries = this.values.get(element);
    if (!entries) return [];
    const changes: DirectEditChange[] = [];
    for (const baseline of entries.values()) {
      if (baseline.kind === "style") {
        changes.push({
          kind: "style",
          element,
          property: baseline.property,
          before: captureDirectStyle(element, baseline.property),
          after: baseline.before,
        });
      } else {
        changes.push({
          kind: "text",
          element,
          textKind: baseline.textKind,
          nodeIndex: baseline.nodeIndex,
          before: captureDirectText(element, baseline.textKind, baseline.nodeIndex),
          after: baseline.before,
        });
      }
    }
    return changes.filter((change) => !statesEqual(change.before, change.after));
  }
}

export function normalizeDirectStyleInput(property: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const lengthProperties = new Set([
    "font-size",
    "letter-spacing",
    "padding",
    "margin",
    "gap",
    "border-width",
    "border-radius",
  ]);
  if (lengthProperties.has(property) && !trimmed.includes("(")) {
    return trimmed.replace(
      /(^|[\s/])(-?(?:\d+(?:\.\d+)?|\.\d+))(?=$|[\s/])/g,
      (_match, prefix: string, number: string) => `${prefix}${Number(number) === 0 ? "0" : `${number}px`}`
    );
  }
  return trimmed;
}

export function validateDirectStyleInput(
  property: string,
  rawValue: string,
  supports?: (property: string, value: string) => boolean
): DirectStyleValidation {
  const value = normalizeDirectStyleInput(property, rawValue);
  if (!value) return { valid: true, value };
  const cssSupports =
    supports ||
    ((candidateProperty: string, candidateValue: string) => {
      const css = globalThis.CSS;
      return typeof css?.supports === "function" ? css.supports(candidateProperty, candidateValue) : true;
    });
  try {
    if (cssSupports(property, value)) return { valid: true, value };
  } catch {
    /* 按无效值处理，避免异常输入绕过保存门禁 */
  }
  return {
    valid: false,
    value,
    error: "格式无效，请检查数值、单位或 CSS 写法",
  };
}

export function cssColorToHex(value: string): string {
  const hex = value.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (hex) {
    const raw = hex[1];
    return raw.length === 3 ? `#${raw.split("").map((c) => c + c).join("")}`.toLowerCase() : `#${raw.toLowerCase()}`;
  }
  const rgb = value.match(/rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i);
  if (!rgb) return "#ffffff";
  return `#${rgb.slice(1, 4).map((part) => Math.max(0, Math.min(255, Math.round(Number(part)))).toString(16).padStart(2, "0")).join("")}`;
}
