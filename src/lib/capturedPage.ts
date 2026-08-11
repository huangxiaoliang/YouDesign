import capturedRuntimeModule from "../../desktop/captured-page-runtime.cjs";

export type CaptureFrameStatus = "captured" | "unavailable" | "omitted";

export interface CapturedFrame {
  frameId: number;
  parentFrameId: number;
  /** iframe DOM 中声明的地址；url 则保留浏览器提交导航后的最终地址。 */
  sourceUrl?: string;
  /** 子文档 window.name；与父文档 iframe[name] 对应。 */
  frameName?: string;
  url: string;
  status: CaptureFrameStatus;
  reason?: string;
  html?: string;
}

export interface CaptureInteractionMeta {
  drawers?: Array<{
    id: string;
    hasMask?: boolean;
    hasOpener?: boolean;
    parentId?: string;
    mappingSource?: "observed-click" | "semantic" | "user-confirmed";
    closeKind?: "button" | "link" | "other";
  }>;
  drawerMapping?: {
    detected: number;
    mapped: number;
    unmapped: number;
    observed: number;
    semantic: number;
    ambiguous: number;
  };
  /** 仅记录抓取时已存在的 Tab 面板；不会驱动原页面加载任何新数据。 */
  tabs?: Array<{ id: string; activeTabId: string; tabIds: string[] }>;
}

export interface GuidedTabItem {
  key: string;
  label: string;
  selected: boolean;
  status: "captured" | "not-selected" | "failed";
  reason?: string;
}

export interface GuidedTabGroup {
  id: string;
  tabs: GuidedTabItem[];
}

export interface GuidedTabCapture {
  /** V3：每个嵌套 Tab 组拥有独立宿主和组内稳定 key。 */
  groups?: GuidedTabGroup[];
  /** V2 兼容字段：历史抓取页仍按单组重建。 */
  groupId?: string;
  tabs?: GuidedTabItem[];
  snapshots: Array<{ key: string; panelHtml: string; capturedAt: string }>;
  /** 后加载页签中由 Portal 挂到 body 的抽屉；入口已写入对应 panelHtml。 */
  drawerSnapshots?: Array<{
    ownerKey: string;
    id: string;
    drawerHtml: string;
    maskHtml?: string;
    parentId?: string;
  }>;
}

export interface CaptureResourceMeta {
  styles?: { inlined?: number; failed?: string[] };
  frames?: { captured?: number; unavailable?: number };
}

export interface CaptureMeta {
  schemaVersion: 2;
  /** 生成本次 frame 快照的 Chrome 扩展版本，供离线产物诊断。 */
  extensionVersion?: string;
  interactions?: CaptureInteractionMeta;
  frames?: CapturedFrame[];
  resources?: CaptureResourceMeta;
  guidedTabs?: GuidedTabCapture;
}

type CapturedRuntime = {
  CAPTURE_RUNTIME_ID: string;
  captureRuntimeScriptTag(): string;
};

const capturedRuntime = capturedRuntimeModule as CapturedRuntime;
const CAPTURE_STYLE_ID = "__yd_captured_page_style";

function resolvedUrl(value: string, base: string) {
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

function framePlaceholder(doc: Document, frame: Element, reason: string) {
  const placeholder = doc.createElement("section");
  placeholder.setAttribute("data-yd-capture-frame-placeholder", "true");
  placeholder.setAttribute("role", "status");
  placeholder.className = "yd-capture-frame-placeholder";
  const style = frame.getAttribute("style");
  if (style) placeholder.setAttribute("style", style);
  placeholder.innerHTML = `<strong>内嵌区域未捕获</strong><span>${reason}</span>`;
  frame.replaceWith(placeholder);
}

function sanitizeSourceExecutableNodes(doc: Document) {
  doc.querySelectorAll("script,base,object,embed").forEach((node) => node.remove());
  for (const element of doc.querySelectorAll("*")) {
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) element.removeAttribute(attr.name);
      if ((name === "href" || name === "src" || name === "action" || name === "formaction") && /^\s*javascript:/i.test(attr.value)) {
        element.removeAttribute(attr.name);
      }
    }
  }
}

function removeLiveResources(doc: Document) {
  doc.querySelectorAll('link[rel~="stylesheet"][href]').forEach((link) => {
    if (/^https?:/i.test(link.getAttribute("href") || "")) link.remove();
  });
  doc.querySelectorAll("img").forEach((image) => {
    const src = image.getAttribute("src") || "";
    const srcset = image.getAttribute("srcset") || "";
    if (/^https?:/i.test(src) || /(?:^|,)\s*https?:/i.test(srcset)) neutralizeOmittedImage(image);
  });
}

function findByAttribute<T extends Element>(doc: ParentNode, attribute: string, value: string): T | undefined {
  return Array.from(doc.querySelectorAll<T>(`[${attribute}]`)).find((item) => item.getAttribute(attribute) === value);
}

function recoverGuidedTabGroupHost(doc: Document, group: GuidedTabGroup): HTMLElement | undefined {
  const normalize = (value: string | null | undefined) => String(value || "").trim().replace(/\s+/g, " ");
  const active = (tab: Element) => tab.getAttribute("aria-selected") === "true" || /(?:^|\s)(?:ant-tabs-tab-active|dpl-tabs-tab-active|adm-tabs-tab-active|am-tabs-tab-active|am-tabs-default-bar-tab-active)(?:\s|$)/.test(String(tab.className || ""));
  const semanticRoots = Array.from(doc.querySelectorAll<HTMLElement>('[role="tablist"]'));
  const componentRoots = Array.from(doc.querySelectorAll<HTMLElement>(".ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs")).filter((root) => !root.querySelector('[role="tablist"]'));
  const expectedLabels = group.tabs.map((tab) => normalize(tab.label));
  for (const root of Array.from(new Set([...semanticRoots, ...componentRoots]))) {
    const scope = root.matches(".ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs") ? root : root.closest<HTMLElement>(".dpl-tabs,.ant-tabs,.adm-tabs,.am-tabs") || root.parentElement;
    if (!scope) continue;
    const tabs = root.matches(".ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs")
      ? Array.from(root.querySelectorAll<HTMLElement>('[role="tab"],.ant-tabs-nav .ant-tabs-tab,.dpl-tabs-tab,.adm-tabs-tab,.am-tabs-tab,.am-tabs-default-bar-tab')).filter((tab) => tab.closest(".ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs") === root && Boolean(normalize(tab.textContent)))
      : Array.from(root.querySelectorAll<HTMLElement>('[role="tab"]')).filter((tab) => tab.closest('[role="tablist"]') === root && Boolean(normalize(tab.textContent)));
    if (tabs.length !== expectedLabels.length || tabs.some((tab, index) => normalize(tab.textContent) !== expectedLabels[index])) continue;
    const directHost = Array.from(scope.children).find((child): child is HTMLElement => child instanceof HTMLElement && child.matches(".dpl-tabs-content,.ant-tabs-content-holder,.ant-tabs-content,.adm-tabs-content,.am-tabs-content,.am-tabs-content-wrap"));
    const host = directHost || scope.querySelector<HTMLElement>(".dpl-tabs-content,.ant-tabs-content-holder,.ant-tabs-content,.adm-tabs-content,.am-tabs-content,.am-tabs-content-wrap");
    if (!host) continue;
    const componentScope = scope.matches(".dpl-tabs,.ant-tabs,.adm-tabs,.am-tabs") ? scope : null;
    const panels = Array.from((host || scope).querySelectorAll<HTMLElement>('[role="tabpanel"],.ant-tabs-tabpane,.dpl-tabs-tabpane,.am-tabs-pane-wrap'))
      .filter((panel) => !componentScope || panel.closest(".dpl-tabs,.ant-tabs,.adm-tabs,.am-tabs") === componentScope);
    const activeIndex = tabs.findIndex(active);
    const hasContent = (element: Element | null | undefined) => Boolean(element && (element.children.length || normalize(element.textContent)));
    const activePane = activeIndex >= 0 ? panels[activeIndex] : null;
    let externalActivePanel: HTMLElement | null = null;
    if (scope.matches(".am-tabs") && activeIndex >= 0 && !hasContent(activePane)) {
      let owner: HTMLElement | null = scope;
      for (let depth = 0; owner && depth < 3; depth += 1, owner = owner.parentElement) {
        const sibling = owner.nextElementSibling;
        if (!(sibling instanceof HTMLElement) || sibling.matches(".am-tabs,.adm-tabs,.ant-tabs,.dpl-tabs") || !hasContent(sibling)) continue;
        externalActivePanel = sibling;
        break;
      }
    }
    tabs.forEach((tab, index) => {
      const key = group.tabs[index].key;
      tab.setAttribute("data-yd-capture-guided-tab-key", key);
      tab.setAttribute("data-yd-capture-guided-tab-group", group.id);
      const panel = panels.length === tabs.length ? panels[index] : panels.length === 1 && index === activeIndex ? panels[0] : null;
      if (panel) panel.setAttribute("data-yd-capture-guided-tab-source-panel", key);
    });
    if (externalActivePanel && activeIndex >= 0) externalActivePanel.setAttribute("data-yd-capture-guided-tab-external-source", group.tabs[activeIndex].key);
    host.setAttribute("data-yd-capture-guided-tab-panel-host", group.id);
    return host;
  }
  return undefined;
}

function rebuildGuidedTabGroup(doc: Document, group: GuidedTabGroup, snapshots: GuidedTabCapture["snapshots"]) {
  const groupId = group.id;
  const host = findByAttribute<HTMLElement>(doc, "data-yd-capture-guided-tab-panel-host", groupId) || recoverGuidedTabGroupHost(doc, group);
  if (!host) return;
  const snapshotByKey = new Map(snapshots.filter((item) => typeof item?.panelHtml === "string").map((item) => [item.key, item]));
  const captured = group.tabs.filter((tab) => tab.selected && tab.status === "captured" && snapshotByKey.has(tab.key));
  if (!captured.length) return;
  const firstKey = captured[0].key;
  const sourceTemplateByKey = new Map(
    Array.from(host.querySelectorAll<HTMLElement>("[data-yd-capture-guided-tab-source-panel]")).map((panel) => [panel.getAttribute("data-yd-capture-guided-tab-source-panel") || "", panel.cloneNode(true) as HTMLElement])
  );

  host.replaceChildren();
  // DPL/Ant 的动画内容轨道会用 margin-left/transform 表示原活动页签
  // 的序号。离线重建会删除未采集面板，原来的 -100% 等位移已不再
  // 有意义；若保留，唯一的已采集面板会被整体推到视口外形成空白。
  host.style.setProperty("margin-left", "0px");
  host.style.setProperty("transform", "none");
  host.style.setProperty("translate", "none");
  for (const tab of group.tabs) {
    const trigger = findByAttribute<HTMLElement>(doc, "data-yd-capture-guided-tab-key", tab.key);
    if (!trigger) continue;
    const isCaptured = tab.selected && tab.status === "captured" && snapshotByKey.has(tab.key);
    // 选择性采集接管同一组后，不能让抓取基线遗留的通用静态 Tab
    // 标记继续参与运行时；否则外层会按旧组隐藏面板，内层按新组打开面板。
    for (const name of ["data-yd-capture-tab", "data-yd-capture-tab-group", "data-yd-capture-tab-state"]) trigger.removeAttribute(name);
    trigger.removeAttribute("data-yd-capture-guided-tab-key");
    trigger.removeAttribute("data-yd-capture-guided-tab-group");
    if (!isCaptured) {
      trigger.setAttribute("data-yd-capture-tab-unavailable", "true");
      trigger.setAttribute("aria-disabled", "true");
      trigger.setAttribute("tabindex", "-1");
      trigger.setAttribute("title", tab.status === "failed" ? tab.reason || "本次采集失败" : "该页签未被采集，离线页面不可用");
      trigger.querySelectorAll(".yd-capture-tab-unavailable-note").forEach((note) => note.remove());
      continue;
    }
    const isActive = tab.key === firstKey;
    trigger.setAttribute("data-yd-capture-tab", tab.key);
    trigger.setAttribute("data-yd-capture-tab-group", groupId);
    trigger.setAttribute("data-yd-capture-tab-state", isActive ? "open" : "closed");
    trigger.setAttribute("role", "tab");
    trigger.setAttribute("aria-selected", isActive ? "true" : "false");
    trigger.setAttribute("tabindex", isActive ? "0" : "-1");

    const template = sourceTemplateByKey.get(tab.key);
    // 基线面板中若包含另一组待重建的 Tab 宿主，保留它而不以外层快照
    // 覆盖；否则内层的 marker 会被删除，造成“关怀”面板写入票账税数据。
    const keepNestedGroupHost = Boolean(template?.querySelector("[data-yd-capture-guided-tab-panel-host]"));
    const snapshotDoc = keepNestedGroupHost ? null : new DOMParser().parseFromString(snapshotByKey.get(tab.key)!.panelHtml, "text/html");
    if (snapshotDoc) {
      sanitizeSourceExecutableNodes(snapshotDoc);
      removeLiveResources(snapshotDoc);
    }
    const panel = (keepNestedGroupHost ? template! : snapshotDoc?.body.firstElementChild) as HTMLElement | null | undefined;
    if (!panel) continue;
    if (panel.getAttribute("data-yd-capture-guided-tab-external-panel") === "true") {
      // 旧版 Ant Mobile 会把真实内容渲染到 Tabs 外部。快照装回
      // .am-tabs-content-wrap 后必须成为完整的一页，否则 flex 的 auto
      // basis 会按内容固有宽度收缩，并反向撑宽页签轨道。
      panel.style.setProperty("box-sizing", "border-box");
      panel.style.setProperty("width", "100%");
      panel.style.setProperty("min-width", "0px");
      panel.style.setProperty("max-width", "100%");
      panel.style.setProperty("flex", "0 0 100%");
    }
    panel.removeAttribute("data-yd-capture-guided-tab-source-panel");
    for (const name of ["data-yd-capture-tab", "data-yd-capture-tab-group", "data-yd-capture-tab-panel-state"]) panel.removeAttribute(name);
    panel.setAttribute("data-yd-capture-tab-panel", tab.key);
    panel.setAttribute("data-yd-capture-tab-group", groupId);
    panel.setAttribute("data-yd-capture-tab-panel-state", isActive ? "open" : "closed");
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-hidden", isActive ? "false" : "true");
    host.appendChild(doc.importNode(panel, true));
    // 某些旧版 Ant Mobile 将真实内容作为 Tabs 外的相邻 sibling 渲染。
    // 该 sibling 已被当前快照装回 host，必须移除基线中的原节点，避免
    // 离线页同时显示原内容和可切换快照。
    for (const source of Array.from(doc.querySelectorAll<HTMLElement>(`[data-yd-capture-guided-tab-external-source="${tab.key}"]`))) {
      if (!host.contains(source)) source.remove();
    }
  }
  for (const source of Array.from(doc.querySelectorAll<HTMLElement>("[data-yd-capture-guided-tab-external-source]"))) {
    if ((source.getAttribute("data-yd-capture-guided-tab-external-source") || "").startsWith(`${groupId}:`) && !host.contains(source)) source.remove();
  }
}

function rebuildGuidedTabs(doc: Document, guided?: GuidedTabCapture) {
  if (!guided || !Array.isArray(guided.snapshots)) return;
  const groups = Array.isArray(guided.groups) && guided.groups.length
    ? guided.groups
    : guided.groupId && Array.isArray(guided.tabs) ? [{ id: guided.groupId, tabs: guided.tabs }] : [];
  for (const group of groups) {
    if (!group?.id || !Array.isArray(group.tabs)) continue;
    rebuildGuidedTabGroup(doc, group, guided.snapshots);
  }
  const availableKeys = new Set(groups.flatMap((group) => group.tabs.filter((tab) => tab.selected && tab.status === "captured").map((tab) => tab.key)));
  const appendedIds = new Set<string>();
  for (const snapshot of Array.isArray(guided.drawerSnapshots) ? guided.drawerSnapshots : []) {
    if (!snapshot?.id || !snapshot.drawerHtml || !availableKeys.has(snapshot.ownerKey) || appendedIds.has(snapshot.id)) continue;
    const fragmentDoc = new DOMParser().parseFromString(`<body>${snapshot.maskHtml || ""}${snapshot.drawerHtml}</body>`, "text/html");
    sanitizeSourceExecutableNodes(fragmentDoc);
    removeLiveResources(fragmentDoc);
    const drawer = findByAttribute<HTMLElement>(fragmentDoc, "data-yd-capture-drawer", snapshot.id);
    if (!drawer) continue;
    drawer.setAttribute("data-yd-capture-drawer-state", "closed");
    drawer.setAttribute("aria-hidden", "true");
    const mask = findByAttribute<HTMLElement>(fragmentDoc, "data-yd-capture-drawer-mask", snapshot.id);
    if (mask) mask.setAttribute("data-yd-capture-drawer-mask-state", "closed");
    for (const child of Array.from(fragmentDoc.body.children)) doc.body.appendChild(doc.importNode(child, true));
    appendedIds.add(snapshot.id);
  }
}

/** Keep the layout contract of a captured <img>, but never leave browser
 * fallback text/icon behind when its source cannot be made offline-safe. */
function neutralizeOmittedImage(image: HTMLImageElement) {
  image.removeAttribute("src");
  image.removeAttribute("srcset");
  image.setAttribute("alt", "");
  image.setAttribute("aria-hidden", "true");
  image.setAttribute("data-yd-capture-resource-omitted", "image");
}

function renderCapturedDocument(html: string, frames: CapturedFrame[], parentFrameId: number, baseUrl: string, includeRuntime: boolean, guidedTabs?: GuidedTabCapture, renderDepth = 0): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  sanitizeSourceExecutableNodes(doc);
  removeLiveResources(doc);
  rebuildGuidedTabs(doc, parentFrameId === 0 ? guidedTabs : undefined);

  const documentFrames = Array.from(doc.querySelectorAll("iframe"));
  const siblingCandidates = frames.filter((candidate) => candidate.parentFrameId === parentFrameId);
  for (const frame of documentFrames) {
    const offlineFrameId = Number(frame.getAttribute("data-yd-captured-frame"));
    const offlineSrcdoc = frame.getAttribute("srcdoc") || "";
    // buildCapturedPageAttachment / PreviewPane 可能对同一抓取页连续调用。
    // 第一次已经构造好的纯 srcdoc iframe 不应再次拿来源 URL 做匹配；
    // 递归净化其 srcdoc 并保留，使整个转换具备幂等性。
    if (!frame.hasAttribute("src") && offlineSrcdoc && Number.isInteger(offlineFrameId) && offlineFrameId >= 0) {
      if (renderDepth >= 4) {
        framePlaceholder(doc, frame, "超过离线内嵌页面重建深度上限。");
        continue;
      }
      const offlineMeta = frames.find((candidate) => candidate.frameId === offlineFrameId);
      frame.removeAttribute("data-yd-capture-frame-source");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.setAttribute("srcdoc", renderCapturedDocument(offlineSrcdoc, frames, offlineFrameId, offlineMeta?.url || baseUrl, true, undefined, renderDepth + 1));
      continue;
    }
    const source = frame.getAttribute("data-yd-capture-frame-source") || frame.getAttribute("src") || "";
    const sourceUrl = resolvedUrl(source, baseUrl);
    const frameName = frame.getAttribute("name") || "";
    let matches = siblingCandidates.filter((candidate) =>
      [candidate.sourceUrl, candidate.url].some((value) => Boolean(value) && resolvedUrl(value!, baseUrl) === sourceUrl));
    if (matches.length !== 1 && frameName) {
      const nameMatches = siblingCandidates.filter((candidate) => candidate.frameName === frameName);
      if (nameMatches.length) matches = nameMatches;
    }
    // 兼容旧扩展 payload：只有最终 frame URL、没有 sourceUrl。仅当当前
    // 文档和元数据都各自只有一个直接子 frame 时，映射才是确定的。
    if (!matches.length && documentFrames.length === 1 && siblingCandidates.length === 1) matches = siblingCandidates;
    const captured = matches.length === 1 && matches[0].status === "captured" && matches[0].html ? matches[0] : undefined;
    if (!captured) {
      const reason = matches.length > 1
        ? "内嵌页面映射不唯一，已按安全策略静态占位。"
        : matches[0]?.reason || (siblingCandidates.length === 0
          ? "Chrome 扩展未返回该内嵌页面的静态快照，请重新加载扩展并刷新来源页面后重试。"
          : siblingCandidates.length > 1
            ? "检测到多个内嵌页面快照，但无法与当前 iframe 唯一对应。请重新加载最新版扩展并刷新来源页面后重试。"
            : "该内嵌页面未能静态化，已按安全策略移除联网内容。");
      framePlaceholder(doc, frame, reason);
      continue;
    }
    const nested = doc.createElement("iframe");
    nested.setAttribute("data-yd-captured-frame", String(captured.frameId));
    nested.setAttribute("sandbox", "allow-scripts");
    nested.setAttribute("referrerpolicy", "no-referrer");
    nested.setAttribute("srcdoc", renderCapturedDocument(captured.html!, frames, captured.frameId, captured.url, true, undefined, renderDepth + 1));
    for (const name of ["class", "style", "title", "name", "width", "height"] as const) {
      const value = frame.getAttribute(name);
      if (value) nested.setAttribute(name, value);
    }
    frame.replaceWith(nested);
  }

  if (includeRuntime && !doc.getElementById(capturedRuntime.CAPTURE_RUNTIME_ID)) {
    doc.getElementById(CAPTURE_STYLE_ID)?.remove();
    const styles = `<style id="${CAPTURE_STYLE_ID}">
[data-yd-capture-drawer-state="closed"],[data-yd-capture-drawer-mask-state="closed"]{display:none!important}
[data-yd-capture-tab-panel-state="closed"]{display:none!important}
[data-yd-capture-tab-unavailable]{pointer-events:none!important;opacity:.56;cursor:not-allowed!important;position:relative}.yd-capture-tab-unavailable-note{margin-left:6px;color:#8c8c8c;font-size:12px;font-weight:400}
html[data-yd-capture-drawer-all-closed],html[data-yd-capture-drawer-all-closed] body{overflow:auto!important}
.yd-capture-frame-placeholder{min-height:160px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;border:1px dashed #b6c2d9;background:#f7f9fc;color:#52627d;font:14px/1.5 system-ui,sans-serif;box-sizing:border-box}.yd-capture-frame-placeholder strong{color:#253858}.yd-capture-frame-placeholder span{max-width:420px;text-align:center}
img[data-yd-capture-resource-omitted="image"]{color:transparent!important;font-size:0!important;line-height:0!important;background:linear-gradient(135deg,#e8edf5,#d8e1ee)!important;object-fit:cover;overflow:hidden}
</style>`;
    doc.head.insertAdjacentHTML("beforeend", `${styles}${capturedRuntime.captureRuntimeScriptTag()}`);
  }
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function isMarkedCapturedDocument(html: string): boolean {
  if (typeof DOMParser === "undefined") {
    const outerHtml = String(html || "").replace(/\bsrcdoc\s*=\s*(?:"[^"]*"|'[^']*')/gi, 'srcdoc=""');
    return (
      /<meta\s+name=["']youdesign-capture-schema["']\s+content=["']2["']/i.test(outerHtml) ||
      /<meta\s+name=["']youdesign-captured-from["']/i.test(outerHtml) ||
      /\bdata-yd-capture-(?:drawer|frame)[-\w]*\s*=/i.test(outerHtml)
    );
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (doc.querySelector('meta[name="youdesign-capture-schema"][content="2"],meta[name="youdesign-captured-from"]')) return true;
  for (const element of Array.from(doc.querySelectorAll("*"))) {
    for (const attr of Array.from(element.attributes)) {
      if (/^data-yd-capture-(?:drawer|frame)/i.test(attr.name)) return true;
    }
  }
  return false;
}

/** 只对 Chrome V2 抓取页执行的离线预览构建。普通上传 HTML 保持原有路径。 */
export function buildCapturedPagePreview(html: string, meta?: CaptureMeta): string {
  // 合并产物（抽屉直嵌 / 导航 iframe）不是 captured 页，跳过 captured 重渲染。
  // 否则会误删主页继承的外部 <link> 样式表（个人入口页等 captured 主页带的 youdesign-captured-from 标记触发误判）。
  if (/yd-merge-scope|yd-nav-scope/.test(html)) return html;
  // srcdoc 可能内联一份历史抓取页。只检查外层真实 DOM，不能让属性值里的
  // 抓取标记把普通手机窄框误判成顶层抓取页并替换掉安全的离线 iframe。
  const isMarkedCapture = isMarkedCapturedDocument(html);
  if ((!meta || meta.schemaVersion !== 2) && !isMarkedCapture) return html;
  return renderCapturedDocument(html, meta?.frames || [], 0, "about:blank", true, meta?.guidedTabs);
}

/** 桌面/Blob 打开附件共用的离线产物，不携带来源站点 iframe、脚本或远程资源。 */
export function buildCapturedPageAttachment(html: string, meta?: CaptureMeta): string {
  return buildCapturedPagePreview(html, meta);
}
