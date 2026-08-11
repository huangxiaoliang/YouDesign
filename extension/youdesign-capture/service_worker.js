const DEFAULT_YOUDESIGN_URL = "http://localhost:3000/youdesign";
const DESKTOP_IMPORT_BASE = "http://127.0.0.1:17631";
const DESKTOP_PROTOCOL_URL = "youdesign://capture";
const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;
const MAX_REMOTE_CSS_BYTES = 4 * 1024 * 1024;
// 单个跨源 CSS 文件上限。DPL/CRM 子应用的业务组件样式常打包在单个
// chunk.css 里（business-manage-pc 的 tag/btn 规则就装在一个 1.2MB 的
// chunk 内）。原 1200KB 上限会把这种略超的整包 CSS 跳过，导致内联缺失、
// 渲染侧 removeLiveResources 又删掉对应 <link> 后样式彻底丢失。提到 2MB
// 覆盖常见单 chunk 体积，仍受 MAX_REMOTE_CSS_BYTES 总预算兜底。
const MAX_SINGLE_CSS_BYTES = 2048 * 1024;
// Images are part of the rendered page, but must never make a capture fail as
// a whole. Keep a small, explicit budget after CSS/frame snapshots.
const MAX_REMOTE_IMAGE_BYTES = 900 * 1024;
const MAX_SINGLE_IMAGE_BYTES = 256 * 1024;
const MAX_REMOTE_IMAGES = 32;
const GUIDED_CAPTURE_SESSION_KEY = "youdesignGuidedTabCapture";
const MAX_GUIDED_TAB_SNAPSHOT_BYTES = 3 * 1024 * 1024;
const MAX_GUIDED_STYLE_BYTES = 2 * 1024 * 1024;
const DRAWER_TRACKER_MESSAGE_SOURCE = "youdesign-capture-service-worker";
chrome.action.onClicked.addListener((tab) => {
  void captureAndSend(tab);
});

async function captureAndSend(tab) {
  const sourceTabId = tab?.id;
  if (!sourceTabId) return;
  let failureStage = "capture";
  try {
    await showBadge(sourceTabId, "...", "#1677ff", 1200);
    const payload = await prepareCapturePayload(tab);
    delete payload.guidedTabState;
    failureStage = "delivery";
    await deliverCapturePayload(payload);
    await showBadge(sourceTabId, "OK", "#0f9f6e", 1800);
    const frames = Array.isArray(payload.captureMeta?.frames) ? payload.captureMeta.frames : [];
    return {
      drawerMapping: payload.captureMeta?.interactions?.drawerMapping || null,
      frameCapture: {
        captured: frames.filter((frame) => frame?.status === "captured").length,
        total: frames.length,
        reasons: Array.from(new Set(frames.filter((frame) => frame?.status !== "captured").map((frame) => frame?.reason).filter(Boolean))),
      },
      extensionVersion: String(chrome.runtime.getManifest()?.version || "unknown"),
    };
  } catch (error) {
    console.error("[YouDesign Capture]", error);
    await showBadge(sourceTabId, "ERR", "#d93025", 3000);
    await openResultPage({
      ok: false,
      stage: failureStage,
      message: error instanceof Error ? error.message : String(error || "Unknown capture error."),
    });
  }
}

async function prepareCapturePayload(tab) {
  const payload = await capturePagePayload(tab);
  await recoverTaintedCanvases(tab?.id, payload);
  await inlineRemoteStyles(payload);
  await inlineCapturedFrameStyles(payload);
  await inlineRemoteImages(payload);
  stampCaptureDiagnostics(payload);
  if (capturePayloadBytes(payload) > MAX_CAPTURE_BYTES) {
    throw new Error(`Captured HTML is larger than ${Math.round(MAX_CAPTURE_BYTES / 1024 / 1024)}MB.`);
  }
  return payload;
}

function stampCaptureDiagnostics(payload) {
  const version = String(chrome.runtime.getManifest()?.version || "unknown");
  const frames = Array.isArray(payload?.captureMeta?.frames) ? payload.captureMeta.frames : [];
  const captured = frames.filter((frame) => frame?.status === "captured").length;
  const unavailable = frames.length - captured;
  const reasons = Array.from(new Set(frames.filter((frame) => frame?.status !== "captured").map((frame) => frame?.reason).filter(Boolean)));
  const safeVersion = version.replace(/[&"<>]/g, (char) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[char]);
  const canvasRecovery = payload?.captureMeta?.canvasRecovery;
  const recoveryMeta = canvasRecovery
    ? `<meta name="youdesign-capture-canvas-recovery" content="targets=${canvasRecovery.targets || 0};geometry=${canvasRecovery.geometry || 0};frameTree=${canvasRecovery.frameTree || 0};screenshot=${encodeURIComponent(canvasRecovery.screenshot || "skipped")};recovered=${canvasRecovery.recovered || 0};placeholder=${canvasRecovery.placeholder || 0}${canvasRecovery.error ? `;error=${encodeURIComponent(canvasRecovery.error)}` : ""}">`
    : "";
  // 逐张污染 canvas 的坐标诊断：offset(frame 在 tab 视口偏移)、rectInFrame(canvas 在 frame 视口)、
  // srcX/srcY/w/h(截图位图裁剪框)、result(recovered/out-of-bounds/...)，定位"截图截错位置"类问题。
  const cropsMeta = Array.isArray(canvasRecovery?.crops) && canvasRecovery.crops.length
    ? `<meta name="youdesign-capture-canvas-crops" content="${encodeURIComponent(JSON.stringify(canvasRecovery.crops))}">`
    : "";
  const stamp = [
    `<meta name="youdesign-capture-extension-version" content="${safeVersion}">`,
    `<meta name="youdesign-capture-frame-summary" content="captured=${captured};unavailable=${unavailable};total=${frames.length}">`,
    `<meta name="youdesign-capture-frame-reasons" content="${encodeURIComponent(reasons.join(" | "))}">`,
    recoveryMeta,
    cropsMeta,
  ].filter(Boolean).join("");
  payload.html = String(payload.html || "")
    .replace(/<meta\s+name=["']youdesign-capture-(?:extension-version|frame-summary|frame-reasons|canvas-recovery|canvas-crops)["'][^>]*>/gi, "")
    .replace(/<\/head\s*>/i, `${stamp}</head>`);
  const baseMeta = payload.captureMeta && typeof payload.captureMeta === "object" ? payload.captureMeta : { schemaVersion: 2 };
  payload.captureMeta = { ...baseMeta, extensionVersion: version };
}

async function deliverCapturePayload(payload) {
  const desktop = await tryDeliverToDesktop(payload);
  if (desktop.ok) return;
  const youdesignUrl = await getYouDesignUrl();
  const receiverTab = await chrome.tabs.create({ url: youdesignUrl, active: true });
  await waitForTabComplete(receiverTab.id);
  const [{ result: delivered }] = await chrome.scripting.executeScript({
    target: { tabId: receiverTab.id },
    func: deliverToYouDesign,
    args: [payload],
    world: "MAIN",
  });
  if (!delivered?.ok) throw new Error(delivered?.error || "YouDesign did not acknowledge the captured page.");
}

async function sendDrawerTrackerMessage(tabId, action) {
  return chrome.tabs.sendMessage(tabId, { source: DRAWER_TRACKER_MESSAGE_SOURCE, action });
}

async function prepareDrawerTracker(tabId) {
  try {
    await sendDrawerTrackerMessage(tabId, "drawer-tracker-ping");
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["drawer_tracker.js"] });
  }
  const response = await sendDrawerTrackerMessage(tabId, "prepare-drawer-mappings");
  if (!response?.ok) throw new Error("抽屉交互跟踪器未能准备映射。");
  return response.diagnostics || null;
}

async function captureGuidedTabState(tabId, groups, styleMode, styleSignatures) {
  let trackerPrepared = false;
  try {
    await prepareDrawerTracker(tabId);
    trackerPrepared = true;
  } catch (error) {
    console.warn("[YouDesign Capture] guided drawer tracker unavailable", error);
  }
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: captureGuidedTabPanelInPage,
      args: [groups, styleMode, styleSignatures],
    });
    return result || {};
  } finally {
    if (trackerPrepared) {
      try {
        await sendDrawerTrackerMessage(tabId, "cleanup-drawer-mappings");
      } catch {
        /* The tracker also removes transient attributes on its own TTL. */
      }
    }
  }
}

async function capturePagePayload(tab, options = {}) {
  const sourceTabId = tab?.id;
  let trackerPrepared = false;
  let drawerMappingDiagnostics = null;
  if (sourceTabId) {
    try {
      drawerMappingDiagnostics = await prepareDrawerTracker(sourceTabId);
      trackerPrepared = true;
    } catch (error) {
      console.warn("[YouDesign Capture] drawer tracker unavailable", error);
    }
  }
  try {
    const payload = await capturePagePayloadCore(tab, options);
    if (drawerMappingDiagnostics) {
      const baseMeta = payload.captureMeta && typeof payload.captureMeta === "object" ? payload.captureMeta : { schemaVersion: 2 };
      const interactions = baseMeta.interactions && typeof baseMeta.interactions === "object" ? baseMeta.interactions : {};
      payload.captureMeta = { ...baseMeta, interactions: { ...interactions, drawerMapping: drawerMappingDiagnostics } };
    }
    return payload;
  } finally {
    if (trackerPrepared && sourceTabId) {
      try {
        await sendDrawerTrackerMessage(sourceTabId, "cleanup-drawer-mappings");
      } catch {
        /* The page may have navigated during capture; tracker marks also have a TTL cleanup. */
      }
    }
  }
}

async function capturePagePayloadCore(tab, options = {}) {
  const sourceTabId = tab?.id;
  const sourceUrl = String(tab?.url || "");
  if (!sourceTabId) throw new Error("未找到当前页面标签。");
  if (!/^https?:\/\//i.test(sourceUrl)) {
    throw new Error("当前页面不允许扩展读取。请切换到以 http:// 或 https:// 开头的业务页面后重试。");
  }

  let richFailure = "富抓取脚本未返回内容";
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: sourceTabId },
      func: captureRenderedPage,
      args: [Boolean(options.skipPreloadedTabs)],
    });
    const payload = firstInjectionResult(results);
    if (payload?.html) return captureChildFrames(sourceTabId, payload);
  } catch (error) {
    richFailure = error instanceof Error ? error.message : String(error || richFailure);
  }

  // Some managed/older Windows Chrome builds can complete a large injected
  // function without returning its value. Keep a small, self-contained
  // serializer as a safe fallback so capture still works on those builds.
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: sourceTabId },
      func: captureRenderedPageBasic,
      args: [Boolean(options.skipPreloadedTabs)],
    });
    const payload = firstInjectionResult(results);
    if (payload?.html) {
      console.warn("[YouDesign Capture] rich capture unavailable; using basic fallback", richFailure);
      return captureChildFrames(sourceTabId, payload);
    }
    throw new Error("基础抓取脚本未返回内容");
  } catch (error) {
    const fallbackFailure = error instanceof Error ? error.message : String(error || "基础抓取失败");
    throw new Error(`页面抓取失败。富抓取：${richFailure}；基础抓取：${fallbackFailure}`);
  }
}

function firstInjectionResult(results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  return results.find((item) => item?.frameId === 0)?.result || results[0]?.result || null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.source !== "youdesign-capture-popup") return;
  void handleGuidedCaptureMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

async function handleGuidedCaptureMessage(message, sender) {
  const tabId = Number(message.tabId ?? sender?.tab?.id);
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("未找到当前业务页面。");
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:\/\//i.test(String(tab?.url || ""))) throw new Error("请切换到业务页面后再采集。");
  if (message.action === "show-guided-overlay") {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["capture_overlay.js"] });
    return {};
  }
  if (message.action === "capture-current") {
    return (await captureAndSend(tab)) || {};
  }
  if (message.action === "inspect-tabs") return { catalog: await inspectGuidedTabs(tabId) };
  if (message.action === "start-guided") {
    const catalog = await inspectGuidedTabs(tabId);
    const selectedKeys = new Set(Array.isArray(message.selectedKeys) ? message.selectedKeys.filter((item) => typeof item === "string") : []);
    const selectedCount = catalog.tabs.filter((item) => !item.defaultCaptured && selectedKeys.has(item.key)).length;
    const defaultCount = catalog.tabs.filter((item) => item.defaultCaptured).length;
    if (!selectedCount && !defaultCount) throw new Error("请至少选择一个页签。");
    // 选择性采集必须以开始时的 DOM 为基线：外层 Tab 切换会卸载整个内层
    // 区域，若在最后合并时再抓整页，已采集的内层页签将没有可回填的宿主。
    const baseline = await capturePagePayload(tab, { skipPreloadedTabs: true });
    if (capturePayloadBytes(baseline) > MAX_CAPTURE_BYTES) throw new Error("开始采集时的页面超过 5MB 上限，无法建立安全离线基线。");
    const defaultKeys = new Set(catalog.tabs.filter((item) => item.defaultCaptured).map((item) => item.key));
    const baselineSnapshotByKey = new Map(
      (Array.isArray(baseline.guidedTabState?.snapshots) ? baseline.guidedTabState.snapshots : [])
        .filter((snapshot) => defaultKeys.has(snapshot?.key) && snapshot?.panelHtml)
        .map((snapshot) => [snapshot.key, snapshot])
    );
    // 业务 Tab 可能只挂载当前面板，整页基线的通用序列化不一定能稳定
    // 对应到该面板。再读取一次当前活动面板，补齐默认采集快照，但绝不
    // 据此重算 defaultCaptured 身份。
    const currentState = await captureGuidedTabState(tabId, catalog.groups, "signatures", []);
    const refreshedDefaultKeys = new Set();
    for (const capture of Array.isArray(currentState?.captures) ? currentState.captures : []) {
      const isExternalMobilePanel = typeof capture?.panelHtml === "string" && /data-yd-capture-guided-tab-external-panel="true"/.test(capture.panelHtml);
      const previousSnapshot = baselineSnapshotByKey.get(capture?.key);
      // 外置内容的基线快照会携带嵌套 Tab 的 source marker。后续从真实
      // 页面再次克隆外层内容时没有这些 marker，若直接覆盖，内层 Tab
      // 重建便找不到宿主。只有基线缺失，或它尚未识别为外置内容时才补齐。
      const hasNestedGuidedBaseline = Boolean(previousSnapshot?.panelHtml?.includes("data-yd-capture-guided-tab-panel-host="));
      const hasOwnExternalMarker = Boolean(previousSnapshot?.panelHtml?.includes(`data-yd-capture-guided-tab-external-source="${capture.key}"`));
      const hasMarkedExternalBaseline = hasNestedGuidedBaseline || hasOwnExternalMarker;
      if (defaultKeys.has(capture?.key) && capture?.panelHtml && (!previousSnapshot || (isExternalMobilePanel && !hasMarkedExternalBaseline))) {
        baselineSnapshotByKey.set(capture.key, {
          key: capture.key,
          panelHtml: capture.panelHtml,
          capturedAt: new Date().toISOString(),
        });
        refreshedDefaultKeys.add(capture.key);
      }
    }
    const missingDefaults = Array.from(defaultKeys).filter((key) => !baselineSnapshotByKey.has(key));
    if (missingDefaults.length) throw new Error("当前默认打开页签尚未完成加载，请等待页面稳定后重新开始。");
    const baselineSnapshots = Array.from(baselineSnapshotByKey.values());
    const session = buildGuidedCaptureSession(tab, catalog, selectedKeys, baselineSnapshots, baseline);
    session.drawerSnapshots = (Array.isArray(currentState?.drawerSnapshots) ? currentState.drawerSnapshots : []).filter((item) => refreshedDefaultKeys.has(item?.ownerKey));
    session.styleSignatures = Array.isArray(currentState?.styleSignatures) ? currentState.styleSignatures : [];
    session.additionalStyleBlocks = [];
    session.additionalStyleHrefs = [];
    await chrome.storage.session.set({ [GUIDED_CAPTURE_SESSION_KEY]: session });
    return { session: summarizeGuidedSession(session) };
  }
  const session = (await chrome.storage.session.get(GUIDED_CAPTURE_SESSION_KEY))[GUIDED_CAPTURE_SESSION_KEY];
  if (!session || session.tabId !== tabId) throw new Error("当前页面没有进行中的选择性页签采集。请先选择页签。");
  if (message.action === "guided-status") return { session: summarizeGuidedSession(session) };
  if (message.action === "cancel-guided") {
    await chrome.storage.session.remove(GUIDED_CAPTURE_SESSION_KEY);
    return {};
  }
  if (message.action === "capture-guided-tab") {
    // 按 Tab 组传递稳定身份。不同组中常有 index-1 / index-2，绝不能
    // 用扁平序号做全局 key。准备跟踪标记后再克隆，才能把后加载页签中
    // 位于 body Portal 下的抽屉与页签面板内入口一起带入离线产物。
    const state = await captureGuidedTabState(tabId, session.groups, "delta", Array.isArray(session.styleSignatures) ? session.styleSignatures : []);
    const captures = Array.isArray(state?.captures) ? state.captures.filter((item) => item?.key && item?.panelHtml) : [];
    if (!captures.length) throw new Error(state?.reason || "未识别到当前已加载的页签面板。");
    const selectedCaptures = captures.filter((item) => session.tabs.some((tab) => tab.key === item.key && tab.selected));
    if (!selectedCaptures.length) throw new Error("当前已打开的页签未在本次采集范围内。");
    const nextSnapshots = new Map(session.snapshots.map((item) => [item.key, item]));
    for (const capture of selectedCaptures) nextSnapshots.set(capture.key, { key: capture.key, panelHtml: capture.panelHtml, capturedAt: new Date().toISOString() });
    const capturedKeys = new Set(selectedCaptures.map((item) => item.key));
    const nextDrawerSnapshots = [
      ...(Array.isArray(session.drawerSnapshots) ? session.drawerSnapshots : []).filter((item) => !capturedKeys.has(item?.ownerKey)),
      ...(Array.isArray(state?.drawerSnapshots) ? state.drawerSnapshots : []).filter((item) => capturedKeys.has(item?.ownerKey)),
    ];
    const nextBytes = Array.from(nextSnapshots.values()).reduce((sum, item) => sum + utf8Bytes(item.panelHtml || ""), 0) +
      nextDrawerSnapshots.reduce((sum, item) => sum + utf8Bytes(item?.drawerHtml || "") + utf8Bytes(item?.maskHtml || ""), 0);
    if (nextBytes > MAX_GUIDED_TAB_SNAPSHOT_BYTES) throw new Error("已选页签内容超过选择性采集体积上限，请减少页签或缩小页面内容。");
    const nextStyleBlocks = new Map((Array.isArray(session.additionalStyleBlocks) ? session.additionalStyleBlocks : []).map((item) => [item.signature, item]));
    for (const block of Array.isArray(state?.styleBlocks) ? state.styleBlocks : []) {
      if (block?.signature && block?.cssText) nextStyleBlocks.set(block.signature, block);
    }
    const nextStyleBytes = Array.from(nextStyleBlocks.values()).reduce((sum, item) => sum + utf8Bytes(item.cssText || ""), 0);
    if (nextStyleBytes > MAX_GUIDED_STYLE_BYTES) throw new Error("已选页签的延迟加载样式超过 2MB 上限，请减少页签后重试。");
    session.snapshots = Array.from(nextSnapshots.values());
    session.drawerSnapshots = nextDrawerSnapshots;
    session.styleSignatures = Array.from(new Set([...(Array.isArray(session.styleSignatures) ? session.styleSignatures : []), ...(Array.isArray(state?.styleSignatures) ? state.styleSignatures : [])]));
    session.additionalStyleBlocks = Array.from(nextStyleBlocks.values());
    session.additionalStyleHrefs = Array.from(new Set([...(Array.isArray(session.additionalStyleHrefs) ? session.additionalStyleHrefs : []), ...(Array.isArray(state?.styleHrefs) ? state.styleHrefs : [])]));
    for (const capture of selectedCaptures) {
      const target = session.tabs.find((item) => item.key === capture.key);
      if (target) target.status = "captured";
    }
    await chrome.storage.session.set({ [GUIDED_CAPTURE_SESSION_KEY]: session });
    return { session: summarizeGuidedSession(session), capturedKeys: selectedCaptures.map((item) => item.key) };
  }
  if (message.action === "finish-guided") {
    const payload = session.baseline && typeof session.baseline.html === "string" ? { ...session.baseline, captureMeta: { ...(session.baseline.captureMeta || { schemaVersion: 2 }) } } : null;
    if (!payload) throw new Error("本次采集缺少开始时的页面基线，请取消后重新开始。");
    payload.styleHrefs = Array.from(new Set([...(Array.isArray(payload.styleHrefs) ? payload.styleHrefs : []), ...(Array.isArray(session.additionalStyleHrefs) ? session.additionalStyleHrefs : [])]));
    payload.html = appendGuidedStyleBlocks(payload.html, session.additionalStyleBlocks);
    await inlineRemoteStyles(payload);
    await inlineCapturedFrameStyles(payload);
    await inlineRemoteImages(payload);
    const guidedTabs = {
      groups: (Array.isArray(session.groups) ? session.groups : []).map((group) => ({
        id: group.id,
        tabs: session.tabs.filter((item) => item.groupId === group.id).map((item) => ({
          key: item.key,
          label: item.label,
          selected: Boolean(item.selected),
          status: item.status === "captured" ? "captured" : item.selected ? "failed" : "not-selected",
          reason: item.status === "captured" || !item.selected ? undefined : "本次未采集",
        })),
      })),
      snapshots: session.snapshots,
      drawerSnapshots: Array.isArray(session.drawerSnapshots) ? session.drawerSnapshots : [],
    };
    payload.captureMeta = { ...(payload.captureMeta || { schemaVersion: 2 }), guidedTabs };
    delete payload.guidedTabState;
    if (capturePayloadBytes(payload) > MAX_CAPTURE_BYTES) throw new Error("合并后的选择性页签采集超过 5MB 上限。");
    await deliverCapturePayload(payload);
    await chrome.storage.session.remove(GUIDED_CAPTURE_SESSION_KEY);
    return { delivered: true };
  }
  throw new Error("不支持的页签采集操作。");
}

/**
 * 逐页签采集必须轻量：只克隆用户当前已经打开的面板，不能在 popup
 * 生命周期内内联整页 CSS/图片或扫描 iframe。最终合并时才走完整离线化。
 */
function captureGuidedTabPanelInPage(expectedGroups, styleMode = "none", knownStyleSignatures = []) {
  const normalize = (value) => String(value || "").trim().replace(/\s+/g, " ");
  const trackDrawerAttr = "data-yd-drawer-track-id";
  const trackOpenerAttr = "data-yd-drawer-track-opener";
  const trackSourceAttr = "data-yd-drawer-track-source";
  const trackParentAttr = "data-yd-drawer-track-parent";
  const maskSelector = '[class*="drawer-mask" i],[class*="drawer-overlay" i],[class*="drawer-backdrop" i],[class*="modal-mask" i]';
  // Ant Design Mobile v2/v5 常只挂载当前 pane；它们没有 ARIA tablist，
  // 但 vendor class + 活动态 + 内容宿主三重条件足够保守地确认是页签。
  const isActive = (tab) => tab.getAttribute("aria-selected") === "true" || /(?:^|\s)(?:ant-tabs-tab-active|dpl-tabs-tab-active|adm-tabs-tab-active|am-tabs-tab-active|am-tabs-default-bar-tab-active)(?:\s|$)/.test(String(tab.className || ""));
  const sanitizeClone = (root) => {
    root.querySelectorAll("script,base,object,embed").forEach((node) => node.remove());
    for (const element of [root, ...root.querySelectorAll("*")]) for (const attr of Array.from(element.attributes)) {
      if (attr.name.toLowerCase().startsWith("on")) element.removeAttribute(attr.name);
      if (["href", "src", "action", "formaction"].includes(attr.name.toLowerCase()) && /^\s*javascript:/i.test(attr.value)) element.removeAttribute(attr.name);
    }
  };
  const stableId = (ownerKey, trackId) => {
    const value = `${ownerKey}\u0001${trackId}`;
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `yd-guided-drawer-${(hash >>> 0).toString(16)}`;
  };
  const matching = (root, attr, value) => [root, ...root.querySelectorAll(`[${attr}]`)].filter((element) => element.getAttribute(attr) === value);
  const removeTracking = (root) => {
    for (const element of [root, ...root.querySelectorAll("*")]) {
      element.removeAttribute(trackDrawerAttr);
      element.removeAttribute(trackOpenerAttr);
      element.removeAttribute(trackSourceAttr);
      element.removeAttribute(trackParentAttr);
    }
  };
  const visible = (element) => {
    try {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    } catch {
      return false;
    }
  };
  const bestClose = (drawer) => {
    const drawerRect = drawer.getBoundingClientRect();
    const ranked = Array.from(drawer.querySelectorAll('button,a,[role="button"],[class*="close" i]')).map((element) => {
      const label = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""} ${element.textContent || ""}`.toLowerCase();
      const klass = typeof element.className === "string" ? element.className.toLowerCase() : "";
      const rect = element.getBoundingClientRect();
      let score = 0;
      if (/close|关闭/.test(label)) score += 8;
      if (/drawer-close|modal-close|close/.test(klass)) score += 6;
      if (/pure-close|drawer-close|modal-close/.test(klass)) score += 4;
      if (element.parentElement === drawer || element.parentElement?.parentElement === drawer) score += 6;
      const header = element.closest('[class*="drawer-header" i],[class*="modal-header" i]');
      if (header && drawer.contains(header)) score += 5;
      if (element.tagName === "BUTTON") score += 1;
      if (rect.top - drawerRect.top >= -8 && rect.top - drawerRect.top < 160) score += 1;
      return { element, score };
    }).filter((item) => item.score >= 4).sort((left, right) => right.score - left.score);
    return ranked.length && (!ranked[1] || ranked[1].score !== ranked[0].score) ? ranked[0].element : null;
  };
  const markOpener = (root, trackId, id) => {
    for (const opener of matching(root, trackOpenerAttr, trackId)) {
      opener.setAttribute("data-yd-capture-drawer-open", id);
      opener.setAttribute("aria-expanded", "false");
      if (!opener.getAttribute("role") && !opener.matches("button,a")) opener.setAttribute("role", "button");
      if (!opener.matches("button") && !opener.hasAttribute("tabindex")) opener.setAttribute("tabindex", "0");
      if (opener.tagName === "A") opener.removeAttribute("href");
      if (opener.tagName === "BUTTON") opener.setAttribute("type", "button");
    }
  };
  const captureTrackedDrawers = (ownerKey, panelClone) => {
    const snapshots = [];
    const queued = [panelClone, ...panelClone.querySelectorAll(`[${trackOpenerAttr}]`)].map((element) => element.getAttribute(trackOpenerAttr)).filter(Boolean);
    const visited = new Set();
    while (queued.length && snapshots.length < 8) {
      const trackId = queued.shift();
      if (!trackId || visited.has(trackId)) continue;
      visited.add(trackId);
      const sourceDrawers = Array.from(document.querySelectorAll(`[${trackDrawerAttr}]`)).filter((element) => element.getAttribute(trackDrawerAttr) === trackId);
      if (sourceDrawers.length !== 1) continue;
      const sourceDrawer = sourceDrawers[0];
      const id = stableId(ownerKey, trackId);
      markOpener(panelClone, trackId, id);

      const drawerClone = sourceDrawer.cloneNode(true);
      const sourceElements = [sourceDrawer, ...sourceDrawer.querySelectorAll("*")];
      const clonedElements = [drawerClone, ...drawerClone.querySelectorAll("*")];
      const sourceClose = bestClose(sourceDrawer);
      const clonedClose = sourceClose ? clonedElements[sourceElements.indexOf(sourceClose)] : null;
      sanitizeClone(drawerClone);
      drawerClone.setAttribute("data-yd-capture-drawer", id);
      drawerClone.setAttribute("data-yd-capture-drawer-state", "closed");
      drawerClone.setAttribute("aria-hidden", "true");
      if (clonedClose) {
        clonedClose.setAttribute("data-yd-capture-drawer-close", id);
        if (clonedClose.tagName === "A") clonedClose.removeAttribute("href");
        if (clonedClose.tagName === "BUTTON") clonedClose.setAttribute("type", "button");
      }

      const nestedTrackIds = [drawerClone, ...drawerClone.querySelectorAll(`[${trackOpenerAttr}]`)].map((element) => element.getAttribute(trackOpenerAttr)).filter(Boolean);
      for (const nestedTrackId of nestedTrackIds) {
        markOpener(drawerClone, nestedTrackId, stableId(ownerKey, nestedTrackId));
        if (!visited.has(nestedTrackId)) queued.push(nestedTrackId);
      }

      let maskHtml = "";
      const containedMasks = Array.from(sourceDrawer.querySelectorAll(maskSelector)).filter(visible);
      if (containedMasks.length === 1) {
        const clonedMask = clonedElements[sourceElements.indexOf(containedMasks[0])];
        if (clonedMask) {
          clonedMask.setAttribute("data-yd-capture-drawer-mask", id);
          clonedMask.setAttribute("data-yd-capture-drawer-mask-state", "closed");
        }
      } else {
        const siblingMasks = Array.from(document.querySelectorAll(maskSelector)).filter((mask) => visible(mask) && mask.parentElement === sourceDrawer.parentElement);
        if (siblingMasks.length === 1) {
          const maskClone = siblingMasks[0].cloneNode(true);
          sanitizeClone(maskClone);
          maskClone.setAttribute("data-yd-capture-drawer-mask", id);
          maskClone.setAttribute("data-yd-capture-drawer-mask-state", "closed");
          removeTracking(maskClone);
          maskHtml = maskClone.outerHTML;
        }
      }
      const parentTrackId = sourceDrawer.getAttribute(trackParentAttr);
      const parentId = parentTrackId ? stableId(ownerKey, parentTrackId) : "";
      if (parentId) drawerClone.setAttribute("data-yd-capture-drawer-parent", parentId);
      removeTracking(drawerClone);
      snapshots.push({ ownerKey, id, drawerHtml: drawerClone.outerHTML, maskHtml: maskHtml || undefined, parentId: parentId || undefined });
    }
    removeTracking(panelClone);
    return snapshots;
  };
  const discover = (doc) => {
    const semanticRoots = Array.from(doc.querySelectorAll('[role="tablist"]'));
    const componentRoots = Array.from(doc.querySelectorAll('.ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs')).filter((root) => !root.querySelector('[role="tablist"]'));
    const groups = [];
    for (const root of Array.from(new Set([...semanticRoots, ...componentRoots]))) {
      const tabs = root.matches('.ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs')
        ? Array.from(root.querySelectorAll('[role="tab"],.ant-tabs-nav .ant-tabs-tab,.dpl-tabs-tab,.adm-tabs-tab,.am-tabs-tab,.am-tabs-default-bar-tab')).filter((tab) => tab.closest('.ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs') === root && Boolean(normalize(tab.textContent)))
        : Array.from(root.querySelectorAll('[role="tab"]')).filter((tab) => tab.closest('[role="tablist"]') === root && Boolean(normalize(tab.textContent)));
      if (tabs.length < 2 || tabs.length > 16) continue;
      const scope = root.matches('.ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs') ? root : root.closest(".dpl-tabs,.ant-tabs,.adm-tabs,.am-tabs") || root.parentElement;
      const directHost = scope && Array.from(scope.children).find((child) => child.matches?.(".dpl-tabs-content,.ant-tabs-content-holder,.ant-tabs-content,.adm-tabs-content,.am-tabs-content,.am-tabs-content-wrap"));
      const host = directHost || scope?.querySelector?.(".dpl-tabs-content,.ant-tabs-content-holder,.ant-tabs-content,.adm-tabs-content,.am-tabs-content,.am-tabs-content-wrap") || null;
      const componentScope = scope?.matches?.(".dpl-tabs,.ant-tabs,.adm-tabs,.am-tabs") ? scope : null;
      const panels = Array.from((host || scope || root).querySelectorAll?.('[role="tabpanel"],.ant-tabs-tabpane,.dpl-tabs-tabpane,.am-tabs-pane-wrap') || [])
        .filter((panel) => !componentScope || panel.closest(".dpl-tabs,.ant-tabs,.adm-tabs,.am-tabs") === componentScope);
      const mobileActivePanel = root.matches(".adm-tabs,.am-tabs") && host
        ? Array.from(host.children).find((child) => child.matches?.(".adm-tabs-content-inner,.am-tabs-pane-wrap-active,.am-tabs-pane-wrap")) || host.firstElementChild
        : null;
      const activeIndex = tabs.findIndex((tab) => isActive(tab));
      // 某些旧版 Ant Mobile 业务页将 Tabs 的 pane 保留为空壳，实际当前
      // 内容渲染在 Tabs 外层容器的紧邻 sibling。仅在已确认的 am-tabs、当前
      // pane 为空、且在三层内找到有内容的 sibling 时才采用，避免误抓普通区块。
      const activePane = activeIndex >= 0 ? panels[activeIndex] || mobileActivePanel : null;
      const hasContent = (panel) => Boolean(panel && (panel.children.length || normalize(panel.textContent)));
      let externalActivePanel = null;
      if (scope?.matches?.(".am-tabs") && activeIndex >= 0 && !hasContent(activePane)) {
        let owner = scope;
        for (let depth = 0; owner && depth < 3; depth += 1, owner = owner.parentElement) {
          const sibling = owner.nextElementSibling;
          if (!sibling || sibling.matches(".am-tabs,.adm-tabs,.ant-tabs,.dpl-tabs") || !hasContent(sibling)) continue;
          externalActivePanel = sibling;
          break;
        }
      }
      const resolvedPanels = tabs.map((tab, index) => {
        const control = tab.getAttribute("aria-controls");
        if (control && doc.getElementById(control)) return doc.getElementById(control);
        const key = tab.getAttribute("data-node-key") || tab.getAttribute("data-key");
        return panels.find((panel) => key && (panel.getAttribute("data-node-key") === key || panel.getAttribute("data-key") === key)) || (externalActivePanel && index === activeIndex ? externalActivePanel : null) || (panels.length === tabs.length ? panels[index] : null) || (panels.length === 1 && index === activeIndex ? panels[0] : null) || (mobileActivePanel && index === activeIndex ? mobileActivePanel : null);
      });
      if (!resolvedPanels.some(Boolean) || !host) continue;
      groups.push({ tabs, panels: resolvedPanels, labels: tabs.map((tab) => normalize(tab.textContent)), externalActivePanel });
    }
    return groups;
  };
  const expected = Array.isArray(expectedGroups) ? expectedGroups.filter((group) => group?.id && Array.isArray(group.tabs)) : [];
  const current = discover(document);
  const captures = [];
  const drawerSnapshots = [];
  for (const group of expected) {
    const expectedTabs = group.tabs.map((tab) => ({ key: String(tab?.key || ""), label: String(tab?.label || "") })).filter((tab) => tab.key && tab.label);
    if (!expectedTabs.length) continue;
    const wantedLabels = expectedTabs.map((tab) => normalize(tab.label)).join("\u0001");
    const currentGroup = current.find((candidate) => candidate.labels.join("\u0001") === wantedLabels);
    if (!currentGroup) continue; // 外层切换后被卸载的内层组，保留已有快照即可。
    const activeIndex = currentGroup.tabs.findIndex((tab) => isActive(tab));
    if (activeIndex < 0 || !currentGroup.panels[activeIndex]) continue;
    const expectedTab = expectedTabs[activeIndex];
    const clone = currentGroup.panels[activeIndex].cloneNode(true);
    sanitizeClone(clone);
    if (currentGroup.externalActivePanel === currentGroup.panels[activeIndex]) clone.setAttribute("data-yd-capture-guided-tab-external-panel", "true");
    drawerSnapshots.push(...captureTrackedDrawers(expectedTab.key, clone));
    clone.setAttribute("data-yd-capture-guided-tab-panel", expectedTab.key);
    captures.push({ key: expectedTab.key, panelHtml: clone.outerHTML });
  }
  const styleState = collectStyleState();
  return captures.length ? { captures, drawerSnapshots, ...styleState } : { ...styleState, reason: "当前已打开的页签未在本次采集范围内，或其面板尚未加载。" };

  function collectStyleState() {
    if (styleMode === "none") return {};
    const known = new Set(Array.isArray(knownStyleSignatures) ? knownStyleSignatures : []);
    const styleSignatures = [];
    const styleBlocks = [];
    const styleHrefs = Array.from(document.querySelectorAll('link[rel~="stylesheet"][href]')).map((link) => link.href).filter((href) => /^https?:\/\//i.test(href));
    const seenSheets = new Set();
    for (const sheet of Array.from(document.styleSheets || [])) {
      if (!sheet || seenSheets.has(sheet)) continue;
      seenSheets.add(sheet);
      let rules;
      try {
        rules = Array.from(sheet.cssRules || []);
      } catch {
        continue;
      }
      if (!rules.length) continue;
      const baseHref = sheet.href || location.href;
      const cssText = rules.map((rule) => String(rule.cssText || "")).filter(Boolean).join("\n").replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, (full, quote, rawUrl) => {
        const value = String(rawUrl || "").trim();
        if (!value || value.startsWith("#") || /^(?:data:|blob:|javascript:|mailto:|tel:)/i.test(value)) return full;
        try {
          return `url("${new URL(value, baseHref).href}")`;
        } catch {
          return full;
        }
      });
      if (!cssText.trim()) continue;
      let hash = 2166136261;
      for (let index = 0; index < cssText.length; index++) {
        hash ^= cssText.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      const signature = `${cssText.length}:${(hash >>> 0).toString(16)}`;
      styleSignatures.push(signature);
      if (styleMode === "delta" && !known.has(signature)) styleBlocks.push({ signature, cssText });
    }
    return { styleSignatures, styleBlocks, styleHrefs };
  }
}

function appendGuidedStyleBlocks(html, blocks) {
  const usable = Array.isArray(blocks) ? blocks.filter((item) => item?.cssText) : [];
  if (!usable.length) return html;
  const css = usable.map((item) => item.cssText).join("\n\n").replace(/<\/style/gi, "<\\/style");
  const tag = `<style data-yd-captured-guided-css="true">${css}</style>`;
  return /<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i, `${tag}</head>`) : `${tag}${html}`;
}

function summarizeGuidedSession(session) {
  return {
    tabs: session.tabs.map((item) => ({ key: item.key, label: item.label, selected: Boolean(item.selected), defaultCaptured: Boolean(item.defaultCaptured), status: item.status })),
    capturedCount: session.tabs.filter((item) => !item.defaultCaptured && item.status === "captured").length,
    selectedCount: session.tabs.filter((item) => !item.defaultCaptured && item.selected).length,
    defaultCapturedCount: session.tabs.filter((item) => item.defaultCaptured).length,
  };
}

function buildGuidedCaptureSession(tab, catalog, selectedKeys, baselineSnapshots, baseline) {
  return {
    tabId: tab.id,
    sourceUrl: String(tab.url || ""),
    groups: catalog.groups,
    tabs: catalog.tabs.map((item) => ({
      ...item,
      // defaultCaptured 是初次识别事实，不能由后续快照是否生成成功反推。
      defaultCaptured: Boolean(item.defaultCaptured),
      selected: Boolean(item.defaultCaptured) || selectedKeys.has(item.key),
      status: item.defaultCaptured ? "captured" : selectedKeys.has(item.key) ? "pending" : "not-selected",
    })),
    snapshots: baselineSnapshots,
    drawerSnapshots: [],
    baseline,
    startedAt: new Date().toISOString(),
  };
}

async function inspectGuidedTabs(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: inspectGuidedTabsInPage });
  if (!result?.tabs?.length) throw new Error("当前页面未识别到可选择性采集的标准、Ant Design 或 Ant Design Mobile 页签。");
  return result;
}

function inspectGuidedTabsInPage() {
  const normalize = (value) => String(value || "").trim().replace(/\s+/g, " ");
  const isActive = (tab) => tab.getAttribute("aria-selected") === "true" || /(?:^|\s)(?:ant-tabs-tab-active|dpl-tabs-tab-active|adm-tabs-tab-active|am-tabs-tab-active|am-tabs-default-bar-tab-active)(?:\s|$)/.test(String(tab.className || ""));
  const discover = (doc) => {
    const semanticRoots = Array.from(doc.querySelectorAll('[role="tablist"]'));
    const componentRoots = Array.from(doc.querySelectorAll('.ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs')).filter((root) => !root.querySelector('[role="tablist"]'));
    const groups = [];
    for (const root of Array.from(new Set([...semanticRoots, ...componentRoots]))) {
      const tabs = root.matches('.ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs')
        ? Array.from(root.querySelectorAll('[role="tab"],.ant-tabs-nav .ant-tabs-tab,.dpl-tabs-tab,.adm-tabs-tab,.am-tabs-tab,.am-tabs-default-bar-tab')).filter((tab) => tab.closest('.ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs') === root && Boolean(normalize(tab.textContent)))
        : Array.from(root.querySelectorAll('[role="tab"]')).filter((tab) => tab.closest('[role="tablist"]') === root && Boolean(normalize(tab.textContent)));
      if (tabs.length < 2 || tabs.length > 16) continue;
      const scope = root.matches('.ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs') ? root : root.closest(".dpl-tabs,.ant-tabs,.adm-tabs,.am-tabs") || root.parentElement;
      const directHost = scope && Array.from(scope.children).find((child) => child.matches?.(".dpl-tabs-content,.ant-tabs-content-holder,.ant-tabs-content,.adm-tabs-content,.am-tabs-content,.am-tabs-content-wrap"));
      const host = directHost || scope?.querySelector?.(".dpl-tabs-content,.ant-tabs-content-holder,.ant-tabs-content,.adm-tabs-content,.am-tabs-content,.am-tabs-content-wrap") || null;
      const componentScope = scope?.matches?.(".dpl-tabs,.ant-tabs,.adm-tabs,.am-tabs") ? scope : null;
      const panels = Array.from((host || scope || root).querySelectorAll?.('[role="tabpanel"],.ant-tabs-tabpane,.dpl-tabs-tabpane,.am-tabs-pane-wrap') || [])
        .filter((panel) => !componentScope || panel.closest(".dpl-tabs,.ant-tabs,.adm-tabs,.am-tabs") === componentScope);
      const mobileActivePanel = root.matches(".adm-tabs,.am-tabs") && host
        ? Array.from(host.children).find((child) => child.matches?.(".adm-tabs-content-inner,.am-tabs-pane-wrap-active,.am-tabs-pane-wrap")) || host.firstElementChild
        : null;
      const activeIndex = tabs.findIndex((tab) => isActive(tab));
      const resolvedPanels = tabs.map((tab, index) => {
        const control = tab.getAttribute("aria-controls");
        if (control && doc.getElementById(control)) return doc.getElementById(control);
        const key = tab.getAttribute("data-node-key") || tab.getAttribute("data-key");
        return panels.find((panel) => key && (panel.getAttribute("data-node-key") === key || panel.getAttribute("data-key") === key)) || (panels.length === tabs.length ? panels[index] : null) || (panels.length === 1 && index === activeIndex ? panels[0] : null) || (mobileActivePanel && index === activeIndex ? mobileActivePanel : null);
      });
      if (!resolvedPanels.some(Boolean) || !host) continue;
      groups.push({ tabs, activeIndex, hasActivePanel: Boolean(activeIndex >= 0 && resolvedPanels[activeIndex]) });
    }
    return groups;
  };
  const groups = discover(document).map((group, index) => {
    const id = `yd-guided-tab-group-${index + 1}`;
    return { id, activeKey: group.hasActivePanel ? `${id}:tab-${group.activeIndex + 1}` : "", tabs: group.tabs.map((tab, tabIndex) => ({ key: `${id}:tab-${tabIndex + 1}`, label: normalize(tab.textContent).slice(0, 80), groupId: id, defaultCaptured: group.hasActivePanel && tabIndex === group.activeIndex })) };
  });
  return { groups, tabs: groups.flatMap((group) => group.tabs) };
}

function normalizeGuidedTabLabel(value) { return String(value || "").trim().replace(/\s+/g, " "); }
function isGuidedTabActive(tab) { return tab.getAttribute("aria-selected") === "true" || /(?:^|\s)(?:ant-tabs-tab-active|dpl-tabs-tab-active|adm-tabs-tab-active|am-tabs-tab-active|am-tabs-default-bar-tab-active)(?:\s|$)/.test(String(tab.className || "")); }
function discoverGuidedTabGroupsInPage(doc) {
  const semanticRoots = Array.from(doc.querySelectorAll('[role="tablist"]'));
  const componentRoots = Array.from(doc.querySelectorAll('.ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs')).filter((root) => !root.querySelector('[role="tablist"]'));
  const roots = Array.from(new Set([...semanticRoots, ...componentRoots]));
  const groups = [];
  for (const root of roots) {
    const tabs = root.matches('.ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs')
      ? Array.from(root.querySelectorAll('[role="tab"],.ant-tabs-nav .ant-tabs-tab,.dpl-tabs-tab,.adm-tabs-tab,.am-tabs-tab,.am-tabs-default-bar-tab')).filter((tab) => tab.closest('.ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs') === root && Boolean(normalizeGuidedTabLabel(tab.textContent)))
      : Array.from(root.querySelectorAll('[role="tab"]')).filter((tab) => tab.closest('[role="tablist"]') === root && Boolean(normalizeGuidedTabLabel(tab.textContent)));
    if (tabs.length < 2 || tabs.length > 16) continue;
    const scope = root.matches('.ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs') ? root : root.closest(".dpl-tabs,.ant-tabs,.adm-tabs,.am-tabs") || root.parentElement;
    const directHost = scope && Array.from(scope.children).find((child) => child.matches?.(".dpl-tabs-content,.ant-tabs-content-holder,.ant-tabs-content,.adm-tabs-content,.am-tabs-content,.am-tabs-content-wrap"));
    const host = directHost || scope?.querySelector?.(".dpl-tabs-content,.ant-tabs-content-holder,.ant-tabs-content,.adm-tabs-content,.am-tabs-content,.am-tabs-content-wrap") || null;
    const componentScope = scope?.matches?.(".dpl-tabs,.ant-tabs,.adm-tabs,.am-tabs") ? scope : null;
    const panels = Array.from((host || scope || root).querySelectorAll?.('[role="tabpanel"],.ant-tabs-tabpane,.dpl-tabs-tabpane,.am-tabs-pane-wrap') || [])
      .filter((panel) => !componentScope || panel.closest(".dpl-tabs,.ant-tabs,.adm-tabs,.am-tabs") === componentScope);
    const activeIndex = tabs.findIndex((tab) => isGuidedTabActive(tab));
    const mobileActivePanel = root.matches(".adm-tabs,.am-tabs") && host
      ? Array.from(host.children).find((child) => child.matches?.(".adm-tabs-content-inner,.am-tabs-pane-wrap-active,.am-tabs-pane-wrap")) || host.firstElementChild
      : null;
    const resolvedPanels = tabs.map((tab, index) => {
      const control = tab.getAttribute("aria-controls");
      if (control && doc.getElementById(control)) return doc.getElementById(control);
      const key = tab.getAttribute("data-node-key") || tab.getAttribute("data-key");
      return panels.find((panel) => key && (panel.getAttribute("data-node-key") === key || panel.getAttribute("data-key") === key)) || (panels.length === tabs.length ? panels[index] : null) || (panels.length === 1 && index === activeIndex ? panels[0] : null) || (mobileActivePanel && index === activeIndex ? mobileActivePanel : null);
    });
    if (!resolvedPanels.some(Boolean) || !host) continue;
    groups.push({ root, host, tabs, panels: resolvedPanels, labels: tabs.map((tab) => normalizeGuidedTabLabel(tab.textContent)) });
  }
  return groups;
}

function urlsEquivalent(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.href === b.href;
  } catch {
    return String(left || "") === String(right || "");
  }
}

function resolveFrameRef(parentRefs, frame, siblingFrames) {
  const exactMatches = parentRefs.filter((ref) => ref.sourceUrl && urlsEquivalent(ref.sourceUrl, frame.url));
  if (exactMatches.length === 1) return { ref: exactMatches[0], source: "url", ambiguous: false };
  // SPA 外壳常让 iframe 的声明 URL、最终 URL 与 webNavigation URL 出现
  // 短暂差异；iframe name 会同时落在父文档节点和子文档 window.name，
  // 因而可作为不依赖顺序的稳定关联键。URL 多匹配时也允许唯一 name
  // 继续消歧，但绝不按 frame 顺序猜测。
  const frameName = String(frame.name || "");
  const nameMatches = frameName
    ? parentRefs.filter((ref) => ref.name && ref.name === frameName)
    : [];
  if (nameMatches.length === 1) return { ref: nameMatches[0], source: "name", ambiguous: false };
  if (exactMatches.length > 1) return { ref: null, source: "url", ambiguous: true };
  if (nameMatches.length > 1) return { ref: null, source: "name", ambiguous: true };
  // iframe 的声明地址可能在真正提交导航后发生重定向。只有同一父文档
  // 恰好一个 DOM iframe、浏览器也恰好一个直接子 frame 时，父子关系
  // 才是唯一的，可安全回退；多 iframe 页面仍拒绝按顺序猜测。
  if (parentRefs.length === 1 && siblingFrames.length === 1) {
    return { ref: parentRefs[0], source: "unique-child", ambiguous: false };
  }
  return { ref: null, source: "none", ambiguous: false };
}

function frameDepth(frameId, framesById) {
  let current = framesById.get(frameId);
  let depth = 0;
  const visited = new Set();
  while (current && current.parentFrameId > 0 && !visited.has(current.frameId)) {
    visited.add(current.frameId);
    depth += 1;
    current = framesById.get(current.parentFrameId);
  }
  return depth;
}

function capturePayloadBytes(payload) {
  const frameBytes = Array.isArray(payload?.captureMeta?.frames)
    ? payload.captureMeta.frames.reduce((sum, frame) => sum + utf8Bytes(frame?.html || ""), 0)
    : 0;
  const guidedTabBytes = Array.isArray(payload?.captureMeta?.guidedTabs?.snapshots)
    ? payload.captureMeta.guidedTabs.snapshots.reduce((sum, snapshot) => sum + utf8Bytes(snapshot?.panelHtml || ""), 0)
    : 0;
  const guidedDrawerBytes = Array.isArray(payload?.captureMeta?.guidedTabs?.drawerSnapshots)
    ? payload.captureMeta.guidedTabs.drawerSnapshots.reduce((sum, snapshot) => sum + utf8Bytes(snapshot?.drawerHtml || "") + utf8Bytes(snapshot?.maskHtml || ""), 0)
    : 0;
  return utf8Bytes(payload?.html || "") + frameBytes + guidedTabBytes + guidedDrawerBytes;
}

/**
 * 业务 iframe 必须成为静态子文档或确定性占位，不能把 src 留给预览/附件再次联网。
 * allFrames 不能读取的跨域 frame 会落到 unavailable，而不会影响顶层抓取成功。
 */
async function captureChildFrames(tabId, payload) {
  const baseMeta = payload.captureMeta && typeof payload.captureMeta === "object" ? payload.captureMeta : { schemaVersion: 2 };
  const refs = Array.isArray(payload.frameRefs) ? payload.frameRefs : [];
  if (!refs.length) return { ...payload, captureMeta: { ...baseMeta, frames: [], resources: { ...(baseMeta.resources || {}), frames: { captured: 0, unavailable: 0 } } } };

  let injectionResults = [];
  let frameTree = [];
  try {
    [injectionResults, frameTree] = await Promise.all([
      chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: captureRenderedPage }),
      chrome.webNavigation.getAllFrames({ tabId }),
    ]);
  } catch (error) {
    console.warn("[YouDesign Capture] child frames unavailable", error);
    const unavailable = refs.map((ref) => ({ frameId: -1, parentFrameId: 0, url: ref.sourceUrl || "", status: "unavailable", reason: "iframe 无法读取或无权限" }));
    return { ...payload, captureMeta: { ...baseMeta, frames: unavailable, resources: { ...(baseMeta.resources || {}), frames: { captured: 0, unavailable: unavailable.length } } } };
  }

  frameTree = Array.isArray(frameTree) ? frameTree : [];
  injectionResults = Array.isArray(injectionResults) ? injectionResults : [];
  const resultsById = new Map(injectionResults.map((item) => [item.frameId, item.result]).filter(([, result]) => result?.html));
  const knownFrameIds = new Set(frameTree.map((frame) => frame.frameId));
  const directTopFrames = frameTree.filter((frame) => frame.frameId !== 0 && frame.parentFrameId === 0);
  const orphanResults = Array.from(resultsById.entries()).filter(([frameId]) => frameId !== 0 && !knownFrameIds.has(frameId));
  // 部分受管 Chrome 能在 allFrames 注入中返回子文档，却暂时不把该
  // browsing context 暴露给 webNavigation。顶层也只有一个 iframe 与
  // 一个孤立注入结果时，仍然存在唯一映射，可以补齐父子关系。
  if (refs.length === 1 && directTopFrames.length === 0 && orphanResults.length === 1) {
    const [frameId, result] = orphanResults[0];
    frameTree.push({ frameId, parentFrameId: 0, url: result.url || refs[0].sourceUrl || "" });
  }
  const framesById = new Map(frameTree.map((frame) => [frame.frameId, frame]));
  const payloadByFrameId = new Map([[0, payload]]);
  for (const [frameId, result] of resultsById) if (frameId !== 0) payloadByFrameId.set(frameId, result);

  const snapshots = [];
  let totalBytes = utf8Bytes(payload.html);
  for (const frame of frameTree) {
    if (frame.frameId === 0) continue;
    const parentPayload = payloadByFrameId.get(frame.parentFrameId);
    const parentRefs = Array.isArray(parentPayload?.frameRefs) ? parentPayload.frameRefs : [];
    const result = resultsById.get(frame.frameId);
    const finalUrl = result?.url || frame.url;
    const siblingFrames = frameTree.filter((candidate) => candidate.frameId !== 0 && candidate.parentFrameId === frame.parentFrameId);
    const frameName = result?.frameName || "";
    const resolution = resolveFrameRef(parentRefs, { ...frame, url: finalUrl, name: frameName }, siblingFrames);
    const sourceUrl = resolution.ref?.sourceUrl || "";
    const depth = frameDepth(frame.frameId, framesById);
    if (depth > 3 || snapshots.length >= 12) {
      snapshots.push({ frameId: frame.frameId, parentFrameId: frame.parentFrameId, url: finalUrl, sourceUrl, frameName, status: "omitted", reason: "超过内嵌页面抓取上限" });
      continue;
    }
    if (!resolution.ref || !result?.html) {
      snapshots.push({ frameId: frame.frameId, parentFrameId: frame.parentFrameId, url: finalUrl, sourceUrl, frameName, status: "unavailable", reason: resolution.ambiguous ? "iframe 映射不唯一" : "iframe 无法读取或无权限" });
      continue;
    }
    const nextBytes = utf8Bytes(result.html);
    const remainingBytes = Math.max(0, MAX_CAPTURE_BYTES - totalBytes);
    // 不再对单个业务 iframe 施加 1MB 的额外限制。DPL/CRM 子应用在
    // 静态化后通常携带 1~3MB 的内联样式；只要整个安全 payload 不超过
    // 5MB，就应保留主业务 frame。
    if (nextBytes > remainingBytes) {
      const frameMb = (nextBytes / 1024 / 1024).toFixed(2);
      const remainingMb = (remainingBytes / 1024 / 1024).toFixed(2);
      snapshots.push({ frameId: frame.frameId, parentFrameId: frame.parentFrameId, url: finalUrl, sourceUrl, frameName, status: "omitted", reason: `内嵌页面 ${frameMb}MB，超过剩余 ${remainingMb}MB 总预算` });
      continue;
    }
    totalBytes += nextBytes;
    snapshots.push({ frameId: frame.frameId, parentFrameId: frame.parentFrameId, url: finalUrl, sourceUrl, frameName, status: "captured", html: result.html, styleHrefs: result.styleHrefs, failedCanvases: Array.isArray(result.failedCanvases) ? result.failedCanvases : [] });
  }
  const captured = snapshots.filter((frame) => frame.status === "captured").length;
  return {
    ...payload,
    captureMeta: {
      ...baseMeta,
      frames: snapshots,
      resources: { ...(baseMeta.resources || {}), frames: { captured, unavailable: snapshots.length - captured } },
    },
  };
}

/**
 * 被跨域图片污染的 ECharts canvas，toDataURL 会抛 SecurityError、读不出像素。
 * 对抓取瞬间可见的污染 canvas，改用 chrome.tabs.captureVisibleTab 截整张 tab 可见区，
 * 按 canvas 在 tab 视口的坐标裁剪成 <img> 贴回（保真）；不可见 / 坐标越界 / 截图失败 /
 * 体积超限 / 非 toDataURL-threw（zero-size、empty-dataurl）的失败 canvas 退回诚实占位。
 * 任何异常都不阻断抓取——最坏等价于现在留空白 canvas 的行为（退化为占位）。
 */
async function recoverTaintedCanvases(tabId, payload) {
  // 收集每个 frame 的失败 canvas：顶层 frameId=0，子 frame 走 captureMeta.frames。
  // 每条带 {frameId, reason, detail, width, height, rectInFrame}。
  const items = [];
  const topFails = Array.isArray(payload?.failedCanvases) ? payload.failedCanvases : [];
  topFails.forEach((fail, idx) => items.push({ frameId: 0, failIdx: idx, fail }));
  for (const frame of Array.isArray(payload?.captureMeta?.frames) ? payload.captureMeta.frames : []) {
    if (frame?.status !== "captured" || !Array.isArray(frame.failedCanvases)) continue;
    frame.failedCanvases.forEach((fail, idx) => items.push({ frameId: frame.frameId, failIdx: idx, fail }));
  }
  // 诊断：记录 recover 各阶段状态，写进产物 meta，失败时不用靠猜。
  const diag = { targets: 0, geometry: 0, frameTree: 0, screenshot: "skipped", recovered: 0, placeholder: 0, error: "" };

  // 只有 toDataURL-threw（被污染）才值得尝试可见区截图；其余（zero-size / empty-dataurl）
  // 直接退占位。先记下哪些要占位、哪些要尝试截图。
  const screenshotTargets = items.filter((item) => item.fail.reason === "toDataURL-threw");
  diag.targets = screenshotTargets.length;
  if (!screenshotTargets.length) {
    // 没有可截图的，但仍需把所有失败 canvas 转成占位（不留死 canvas）。
    markAllFailedCanvasesAsPlaceholder(payload);
    diag.placeholder = items.length;
    payload.captureMeta = { ...(payload.captureMeta || { schemaVersion: 2 }), canvasRecovery: diag };
    return;
  }

  // 1) 注入每个 frame，拿本 frame 文档内所有 iframe 的 rect + 本 frame 的滚动量，
  //    用来把子 frame 内 canvas 的视口坐标换算成 tab 视口坐标。
  let frameGeometryById = new Map(); // frameId -> { iframeRects: [{x,y,w,h,src,name}], scrollX, scrollY }
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: collectFrameGeometry });
    for (const item of Array.isArray(results) ? results : []) {
      const fid = item.frameId;
      const r = item.result;
      if (Number.isInteger(fid) && r && typeof r === "object") frameGeometryById.set(fid, r);
    }
    diag.geometry = frameGeometryById.size;
  } catch (error) {
    diag.error = `geometry: ${error instanceof Error ? error.message : String(error)}`;
    console.warn("[YouDesign Capture] frame geometry unavailable, tainted canvases fall back to placeholder", error);
  }

  // 2) 用 webNavigation frameTree + 父 frame 的 iframeRects，算每个 frame 相对 tab 视口的偏移。
  let frameOffsetById = new Map(); // frameId -> {x, y}
  frameOffsetById.set(0, { x: 0, y: 0 });
  try {
    const frameTree = await chrome.webNavigation.getAllFrames({ tabId });
    if (Array.isArray(frameTree)) {
      diag.frameTree = frameTree.length;
      // 自顶向下按 parentFrameId 累加：子 frame 偏移 = 父 frame 偏移 + 父文档里对应 iframe 的 rect - 父滚动
      const byId = new Map(frameTree.map((f) => [f.frameId, f]));
      // 拓扑顺序：parentFrameId 小的先算
      const ordered = [...byId.values()].sort((a, b) => a.parentFrameId - b.parentFrameId || a.frameId - b.frameId);
      for (const f of ordered) {
        if (f.frameId === 0) continue;
        const parentOffset = frameOffsetById.get(f.parentFrameId);
        if (!parentOffset) continue; // 父偏移没算出来，跳过（该 frame 失败 canvas 走占位）
        const parentGeo = frameGeometryById.get(f.parentFrameId);
        if (!parentGeo) continue;
        // 在父文档的 iframe 列表里找对应本 frame 的那个 iframe rect（按 url/name 匹配）
        const iframeRect = matchIframeRect(parentGeo.iframeRects, f);
        if (!iframeRect) continue;
        // iframe rect 来自父 frame 的 getBoundingClientRect，已是父 frame 视口坐标
        // （滚动已反映在 rect 里）。父 frame 视口原点在 tab 视口 = 父 frame 的 offset。
        // 所以子 frame 偏移 = 父偏移 + iframeRect，不再减父滚动（减了会重复，致截图位置偏移）。
        // 子 frame 内 canvas 的 rectInFrame 也是视口坐标，叠加时同理。
        frameOffsetById.set(f.frameId, {
          x: parentOffset.x + iframeRect.x,
          y: parentOffset.y + iframeRect.y,
        });
      }
    }
  } catch (error) {
    console.warn("[YouDesign Capture] webNavigation frameTree unavailable", error);
  }

  // 3) 截整张 tab 可见区。截图位图像素 = 视口 CSS × DPR，裁剪源坐标需按 DPR 放大。
  //    注意 chrome.tabs.captureVisibleTab 第一个参数是 windowId（不是 tabId），
  //    需先 chrome.tabs.get(tabId) 取 windowId，再截该窗口的可见 tab。
  const topGeo = frameGeometryById.get(0);
  const dpr = topGeo && Number(topGeo.devicePixelRatio) > 0 ? Number(topGeo.devicePixelRatio) : 1;
  let screenshotDataUrl = null;
  let screenshotWidth = 0;
  let screenshotHeight = 0;
  try {
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab?.windowId, { format: "png" });
    if (dataUrl && dataUrl !== "data:,") {
      const bitmap = await loadImageBitmap(dataUrl);
      screenshotWidth = bitmap.width;
      screenshotHeight = bitmap.height;
      screenshotDataUrl = dataUrl;
      diag.screenshot = `${bitmap.width}x${bitmap.height}`;
      bitmap.close && bitmap.close();
    } else {
      diag.screenshot = "empty";
    }
  } catch (error) {
    diag.screenshot = "failed";
    diag.error = diag.error || `screenshot: ${error instanceof Error ? error.message : String(error)}`;
    console.warn("[YouDesign Capture] captureVisibleTab unavailable, tainted canvases fall back to placeholder", error);
  }

  // 4) 对每个 toDataURL-threw 的失败 canvas，算它在 tab 视口的裁剪框（CSS 像素），按 DPR 放大到截图位图像素后裁出 PNG。
  //    逐张裁；裁不出（坐标越界 / 无 offset / 截图缺失）的标记走占位。
  const recoveredByFrame = new Map(); // frameId -> Map(failIdx -> {dataUrl, w, h, style})
  const placeholderFailures = new Set(); // "frameId:failIdx" 走占位
  // 先把非 toDataURL-threw 的全部标占位
  for (const item of items) {
    if (item.fail.reason !== "toDataURL-threw") placeholderFailures.add(`${item.frameId}:${item.failIdx}`);
  }
  let recoveredBytes = 0;
  const budget = Math.max(0, MAX_CAPTURE_BYTES - capturePayloadBytes(payload));
  diag.crops = [];
  if (screenshotDataUrl) {
    for (const item of screenshotTargets) {
      const offset = frameOffsetById.get(item.frameId);
      const r = item.fail.rectInFrame;
      const key = `${item.frameId}:${item.failIdx}`;
      const cropInfo = { frameId: item.frameId, failIdx: item.failIdx, offset: offset || null, rectInFrame: r || null, dpr, shot: `${screenshotWidth}x${screenshotHeight}` };
      if (!offset || !r || r.w <= 0 || r.h <= 0) { placeholderFailures.add(key); cropInfo.result = "no-offset-or-rect"; diag.crops.push(cropInfo); continue; }
      // canvas 在 tab 视口的 CSS 坐标 -> 截图位图像素坐标（× DPR）。
      const srcX = Math.round((offset.x + r.x) * dpr);
      const srcY = Math.round((offset.y + r.y) * dpr);
      const w = Math.round(r.w * dpr);
      const h = Math.round(r.h * dpr);
      cropInfo.srcX = srcX; cropInfo.srcY = srcY; cropInfo.w = w; cropInfo.h = h;
      // 裁剪框必须完全落在截图位图内（部分可见的图不裁，避免半截图误导）。
      if (srcX < 0 || srcY < 0 || srcX + w > screenshotWidth || srcY + h > screenshotHeight || w <= 0 || h <= 0) {
        placeholderFailures.add(key); cropInfo.result = "out-of-bounds"; diag.crops.push(cropInfo); continue;
      }
      try {
        const bitmap = await loadImageBitmap(screenshotDataUrl);
        const oc = new OffscreenCanvas(w, h);
        const ctx = oc.getContext("2d");
        ctx.drawImage(bitmap, srcX, srcY, w, h, 0, 0, w, h);
        bitmap.close && bitmap.close();
        const blob = await oc.convertToBlob({ type: "image/png" });
        const pieceDataUrl = await blobToDataUrl(blob);
        if (!pieceDataUrl || pieceDataUrl === "data:,") { placeholderFailures.add(key); cropInfo.result = "empty-crop"; diag.crops.push(cropInfo); continue; }
        recoveredBytes += utf8Bytes(pieceDataUrl);
        if (recoveredBytes > budget) { placeholderFailures.add(key); cropInfo.result = "over-budget"; diag.crops.push(cropInfo); continue; }
        if (!recoveredByFrame.has(item.frameId)) recoveredByFrame.set(item.frameId, new Map());
        // rectW/rectH 用 CSS 像素（显示尺寸），w/h 用 canvas source 像素（img 属性）。
        recoveredByFrame.get(item.frameId).set(item.failIdx, { dataUrl: pieceDataUrl, w: item.fail.width, h: item.fail.height, rectW: Math.round(r.w), rectH: Math.round(r.h) });
        cropInfo.result = "recovered";
        diag.crops.push(cropInfo);
      } catch (error) {
        console.warn("[YouDesign Capture] canvas crop failed, fall back to placeholder", error);
        placeholderFailures.add(key);
        cropInfo.result = `crop-threw: ${error instanceof Error ? error.message : String(error)}`;
        diag.crops.push(cropInfo);
      }
    }
  } else {
    // 截图不可用：所有 toDataURL-threw 全走占位
    for (const item of screenshotTargets) placeholderFailures.add(`${item.frameId}:${item.failIdx}`);
  }

  // 5) 把裁出的 <img> 贴回 / 把占位的失败 canvas 换成占位 div。逐 frame 改 html 字符串。
  applyRecoveryToTopDoc(payload, recoveredByFrame, placeholderFailures);
  for (const frame of Array.isArray(payload?.captureMeta?.frames) ? payload.captureMeta.frames : []) {
    if (frame?.status === "captured" && typeof frame.html === "string") {
      applyRecoveryToFrameHtml(frame, recoveredByFrame, placeholderFailures);
    }
  }
  for (const map of recoveredByFrame.values()) diag.recovered += map.size;
  diag.placeholder = placeholderFailures.size;
  payload.captureMeta = { ...(payload.captureMeta || { schemaVersion: 2 }), canvasRecovery: diag };
}

async function loadImageBitmap(dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

function blobToDataUrl(blob) {
  // Service worker 没有 FileReader，用 arrayBuffer + 分块 btoa 拼 base64。
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return `data:${blob.type || "image/png"};base64,${btoa(binary)}`;
  });
}

// 注入到每个 frame：返回本 frame 文档里所有 iframe 的视口 rect（带 src/name 供匹配）+ 滚动量 + 视口/DPR。
function collectFrameGeometry() {
  const iframes = Array.from(document.querySelectorAll("iframe"));
  const iframeRects = [];
  for (const frame of iframes) {
    const rect = frame.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    let src = "";
    try { src = frame.src || ""; } catch { src = ""; }
    iframeRects.push({
      x: Math.round(rect.x * 100) / 100,
      y: Math.round(rect.y * 100) / 100,
      w: Math.round(rect.width * 100) / 100,
      h: Math.round(rect.height * 100) / 100,
      src,
      name: frame.name || "",
    });
  }
  return {
    iframeRects,
    // scrollX/Y 仅作诊断，不参与坐标换算：getBoundingClientRect 已是视口坐标（含滚动），
    // iframe rect 直接与父偏移相加即可，再减滚动会重复致截图位置偏移。
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    // captureVisibleTab 截图位图像素 = 视口 CSS 尺寸 × devicePixelRatio；
    // 裁剪源坐标需按 DPR 放大。各 frame DPR 通常一致，取顶层 frame 的即可。
    viewportCssWidth: Math.round(window.innerWidth),
    viewportCssHeight: Math.round(window.innerHeight),
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

// 在父 frame 的 iframe rect 列表里找对应某个子 frame（按 url 末段/name 匹配）。
function matchIframeRect(iframeRects, childFrame) {
  if (!Array.isArray(iframeRects) || !iframeRects.length) return null;
  const childUrl = String(childFrame.url || "");
  // 按 src 完全相等或末段路径匹配
  let bySrc = iframeRects.filter((r) => r.src && (r.src === childUrl || sameUrlTail(r.src, childUrl)));
  if (bySrc.length === 1) return bySrc[0];
  // 按 name 匹配
  const childName = String(childFrame.name || "");
  if (childName) {
    const byName = iframeRects.filter((r) => r.name && r.name === childName);
    if (byName.length === 1) return byName[0];
  }
  // 唯一一个 iframe 就直接用它
  if (iframeRects.length === 1) return iframeRects[0];
  return null;
}

function sameUrlTail(a, b) {
  if (!a || !b) return false;
  const ta = a.split("?")[0].split("#")[0].replace(/\/$/, "");
  const tb = b.split("?")[0].split("#")[0].replace(/\/$/, "");
  if (ta === tb) return true;
  // 比较最后一段 path
  const sa = ta.split("/").pop();
  const sb = tb.split("/").pop();
  return sa && sb && sa === sb;
}

// 顶层文档：把失败 canvas（按 data-yd-canvas-fail-idx）替换成 <img> 或占位 div。
function applyRecoveryToTopDoc(payload, recoveredByFrame, placeholderFailures) {
  if (typeof payload.html !== "string" || !payload.html.includes("data-yd-canvas-fail-idx")) return;
  const recovered = recoveredByFrame.get(0);
  payload.html = replaceFailedCanvasesInHtml(payload.html, 0, recovered, placeholderFailures);
}

function applyRecoveryToFrameHtml(frame, recoveredByFrame, placeholderFailures) {
  if (typeof frame.html !== "string" || !frame.html.includes("data-yd-canvas-fail-idx")) return;
  const recovered = recoveredByFrame.get(frame.frameId);
  frame.html = replaceFailedCanvasesInHtml(frame.html, frame.frameId, recovered, placeholderFailures);
}

// 把某 frame html 里每个带 data-yd-canvas-fail-idx="N" 的 <canvas ...></canvas> 整体替换。
function replaceFailedCanvasesInHtml(html, frameId, recovered, placeholderFailures) {
  // 匹配 <canvas ... data-yd-canvas-fail-idx="N" ...></canvas>，N 已知。
  // canvas 标签内不会再嵌 canvas，用非贪婪到第一个 </canvas>。
  const re = /<canvas\b[^>]*\bdata-yd-canvas-fail-idx="(\d+)"[^>]*>(?:[\s\S]*?)<\/canvas>/g;
  return html.replace(re, (whole, idxStr) => {
    const idx = Number(idxStr);
    const key = `${frameId}:${idx}`;
    if (recovered && recovered.has(idx)) {
      const r = recovered.get(idx);
      return buildRecoveredImg(r);
    }
    // 占位
    const reason = placeholderFailures.has(key) ? "tainted-or-unavailable" : "failed";
    return buildPlaceholderDiv(reason);
  });
}

function buildRecoveredImg(r) {
  // 保真：用截图裁出的图。尺寸用 canvas source 尺寸（与成功快照口径一致）。
  const w = r.rectW || r.w || 0;
  const h = r.rectH || r.h || 0;
  const style = `display:block;width:${w}px;height:${h}px;`;
  return `<img src="${r.dataUrl}" data-yd-canvas-snapshot="true" data-yd-canvas-recovered="visible-screenshot" width="${r.w || w}" height="${r.h || h}" style="${style}">`;
}

function buildPlaceholderDiv(reason) {
  const text = reason === "tainted-or-unavailable"
    ? "图表含跨域图片，未能静态化"
    : "图表未渲染或不可见，未能静态化";
  return `<div data-yd-canvas-failed="${reason}" style="display:flex;align-items:center;justify-content:center;color:#999;font-size:12px;background:#fafafa;border:1px dashed #ddd;">${text}</div>`;
}

// 没有 toDataURL-threw 时，把所有失败 canvas（含 zero-size/empty-dataurl）转占位。
function markAllFailedCanvasesAsPlaceholder(payload) {
  applyRecoveryToTopDoc(payload, new Map(), new Set());
  for (const frame of Array.isArray(payload?.captureMeta?.frames) ? payload.captureMeta.frames : []) {
    if (frame?.status === "captured" && typeof frame.html === "string") {
      applyRecoveryToFrameHtml(frame, new Map(), new Set());
    }
  }
}

async function inlineCapturedFrameStyles(payload) {
  const frames = Array.isArray(payload?.captureMeta?.frames) ? payload.captureMeta.frames : [];
  let totalBytes = capturePayloadBytes(payload);
  for (const frame of frames) {
    const beforeBytes = utf8Bytes(frame.html);
    const framePayload = { html: frame.html, styleHrefs: Array.isArray(frame.styleHrefs) ? frame.styleHrefs : [] };
    await inlineRemoteStyles(framePayload);
    const afterBytes = utf8Bytes(framePayload.html);
    if (totalBytes - beforeBytes + afterBytes > MAX_CAPTURE_BYTES) {
      frame.status = "omitted";
      frame.reason = "内嵌页面样式内联后超过总体积上限";
      delete frame.html;
      delete frame.styleHrefs;
      continue;
    }
    totalBytes = totalBytes - beforeBytes + afterBytes;
    frame.html = framePayload.html;
    frame.remoteCss = framePayload.remoteCss;
    delete frame.styleHrefs;
  }
  const captured = frames.filter((frame) => frame?.status === "captured").length;
  payload.captureMeta.resources = {
    ...(payload.captureMeta.resources || {}),
    frames: { captured, unavailable: frames.length - captured },
  };
}

/**
 * The desktop attachment CSP intentionally blocks all network images. Turn
 * small, rendered <img> resources into data URLs while the extension still
 * has host permission; anything unavailable or over budget remains a safe
 * visual placeholder in the renderer instead of a broken-image icon.
 */
async function inlineRemoteImages(payload) {
  const hrefs = Array.from(new Set((payload.imageHrefs || []).filter(isHttpUrl))).slice(0, MAX_REMOTE_IMAGES);
  const remainingCaptureBytes = Math.max(0, MAX_CAPTURE_BYTES - capturePayloadBytes(payload));
  let remainingBytes = Math.min(MAX_REMOTE_IMAGE_BYTES, remainingCaptureBytes);
  const replacements = new Map();
  const failed = [];
  let totalBytes = 0;

  for (const href of hrefs) {
    if (remainingBytes <= 0) {
      failed.push(`${href} -> image budget reached`);
      continue;
    }
    try {
      const res = await fetch(href, { credentials: "include", cache: "force-cache" });
      if (!res.ok) {
        failed.push(`${href} -> HTTP ${res.status}`);
        continue;
      }
      const contentType = (res.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
      if (!/^image\/(?:png|jpe?g|gif|webp|svg\+xml|avif|bmp|x-icon|vnd\.microsoft\.icon)$/i.test(contentType)) {
        failed.push(`${href} -> not image`);
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_SINGLE_IMAGE_BYTES) {
        failed.push(`${href} -> skipped ${Math.round(bytes.length / 1024)}KB`);
        continue;
      }
      const encodedBytes = Math.ceil(bytes.length / 3) * 4;
      if (encodedBytes > remainingBytes) {
        failed.push(`${href} -> image budget reached`);
        continue;
      }
      replacements.set(href, `data:${contentType};base64,${bytesToBase64(bytes)}`);
      totalBytes += encodedBytes;
      remainingBytes -= encodedBytes;
    } catch (error) {
      failed.push(`${href} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (replacements.size) payload.html = replaceImageSourcesInHtml(payload.html, replacements);
  payload.remoteImages = { inlined: replacements.size, bytes: totalBytes, failed: failed.slice(0, 12) };
  delete payload.imageHrefs;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function replaceImageSourcesInHtml(html, replacements) {
  return String(html || "").replace(/<img\b[^>]*>/gi, (tag) => {
    const srcMatch = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (!srcMatch) return tag;
    const source = decodeHtmlAttribute(srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? "");
    const replacement = replacements.get(source);
    if (!replacement) return tag;
    const withoutSrcset = tag.replace(/\ssrcset\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    return withoutSrcset
      .replace(/\ssrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, ` src="${replacement}"`)
      .replace(/\sdata-yd-capture-image-inlined(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, "")
      .replace(/<img\b/i, '<img data-yd-capture-image-inlined="true"');
  });
}

function decodeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

async function tryDeliverToDesktop(payload) {
  if (!(await isDesktopReady())) {
    await tryLaunchDesktop();
    if (!(await waitForDesktopReady(5000))) return { ok: false, reason: "desktop-unavailable" };
  }

  const res = await fetchWithTimeout(`${DESKTOP_IMPORT_BASE}/capture/import`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-youdesign-capture": "chrome-extension",
    },
    body: JSON.stringify(payload),
  }, 8000);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `YouDesign desktop import failed: HTTP ${res.status}`);
  }
  return { ok: true };
}

async function isDesktopReady() {
  try {
    const res = await fetchWithTimeout(`${DESKTOP_IMPORT_BASE}/capture/health`, { method: "GET" }, 500);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForDesktopReady(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isDesktopReady()) return true;
    await sleep(350);
  }
  return false;
}

async function tryLaunchDesktop() {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: DESKTOP_PROTOCOL_URL, active: false });
    tabId = tab?.id ?? null;
  } catch {
    return;
  }
  if (tabId != null) {
    setTimeout(() => {
      chrome.tabs.remove(tabId).catch(() => {});
    }, 3000);
  }
}

function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getYouDesignUrl() {
  const stored = await chrome.storage.sync.get({ youdesignUrl: DEFAULT_YOUDESIGN_URL });
  return normalizeYouDesignUrl(stored.youdesignUrl || DEFAULT_YOUDESIGN_URL);
}

function normalizeYouDesignUrl(raw) {
  const value = String(raw || "").trim() || DEFAULT_YOUDESIGN_URL;
  return value.replace(/\/+$/, "") + "/";
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    if (!tabId) return reject(new Error("Missing receiver tab id."));
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Timed out while opening YouDesign."));
    }, 15000);
    function onUpdated(updatedTabId, info) {
      if (updatedTabId !== tabId || info.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab?.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    });
  });
}

async function showBadge(tabId, text, color, durationMs) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
    if (durationMs > 0) {
      setTimeout(() => {
        void chrome.action.setBadgeText({ tabId, text: "" });
      }, durationMs);
    }
  } catch {
    /* Badge feedback is best-effort. */
  }
}

async function openResultPage(result) {
  const params = new URLSearchParams({
    ok: result.ok ? "1" : "0",
    stage: result.stage || "delivery",
    message: result.message || "",
  });
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`result.html?${params.toString()}`),
    active: true,
  });
}

function captureRenderedPageBasic(skipPreloadedTabs = false) {
  const cloned = document.documentElement?.cloneNode(true);
  if (!cloned) return null;
  const drawerPlans = markOpenDrawers(document, cloned);
  const tabPlans = skipPreloadedTabs ? [] : markPreloadedTabs(document, cloned);
  const guidedTabState = markGuidedTabState(document, cloned);
  const frameRefs = freezeFrameRefs(cloned);
  cloned.querySelectorAll('[data-yd-capture-extension-ui],#__yd_capture_overlay').forEach((node) => node.remove());

  const sourceInputs = document.querySelectorAll("input");
  const clonedInputs = cloned.querySelectorAll("input");
  sourceInputs.forEach((input, index) => {
    const clone = clonedInputs[index];
    if (!clone) return;
    const type = (input.getAttribute("type") || "").toLowerCase();
    if (type === "password") clone.setAttribute("value", "");
    else if (type === "checkbox" || type === "radio") {
      if (input.checked) clone.setAttribute("checked", "");
      else clone.removeAttribute("checked");
    } else clone.setAttribute("value", input.value || "");
  });

  const sourceTextareas = document.querySelectorAll("textarea");
  const clonedTextareas = cloned.querySelectorAll("textarea");
  sourceTextareas.forEach((textarea, index) => {
    if (clonedTextareas[index]) clonedTextareas[index].textContent = textarea.value || "";
  });

  const sourceSelects = document.querySelectorAll("select");
  const clonedSelects = cloned.querySelectorAll("select");
  sourceSelects.forEach((select, index) => {
    const clone = clonedSelects[index];
    if (!clone) return;
    const selected = new Set(Array.from(select.selectedOptions).map((option) => option.index));
    Array.from(clone.options).forEach((option, optionIndex) => {
      if (selected.has(optionIndex)) option.setAttribute("selected", "");
      else option.removeAttribute("selected");
    });
  });

  const urlAttrs = ["src", "href", "poster", "data", "action", "formaction", "xlink:href"];
  const urlSelector = urlAttrs.map((attr) => `[${attr.replaceAll(":", "\\:")}]`).join(",");
  for (const el of cloned.querySelectorAll(urlSelector)) {
    for (const attr of urlAttrs) {
      const value = el.getAttribute(attr);
      if (!value || value.startsWith("#") || /^(?:data:|blob:|javascript:|mailto:|tel:)/i.test(value)) continue;
      try {
        el.setAttribute(attr, new URL(value, location.href).href);
      } catch {
        /* Leave invalid URLs as-is. */
      }
    }
  }

  cloned.querySelectorAll("script,base").forEach((el) => el.remove());
  for (const el of cloned.querySelectorAll("*")) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value || "";
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      if ((name === "href" || name === "src" || name === "action") && /^javascript:/i.test(value.trim())) {
        el.removeAttribute(attr.name);
      }
    }
  }

  const head = cloned.querySelector("head");
  if (head) {
    const source = document.createElement("meta");
    source.setAttribute("name", "youdesign-captured-from");
    source.setAttribute("content", location.href);
    const mode = document.createElement("meta");
    mode.setAttribute("name", "youdesign-capture-mode");
    mode.setAttribute("content", "basic-fallback");
    const schema = document.createElement("meta");
    schema.setAttribute("name", "youdesign-capture-schema");
    schema.setAttribute("content", "2");
    head.append(source, mode, schema);
  }

  return {
    html: `<!doctype html>\n${cloned.outerHTML}`,
    title: document.title || location.hostname || "captured-page",
    url: location.href,
    frameName: window.name || "",
    capturedAt: new Date().toISOString(),
    captureMode: "basic-fallback",
    drawerPlans,
    frameRefs,
    captureMeta: { schemaVersion: 2, interactions: { drawers: drawerPlans, tabs: tabPlans } },
    styleHrefs: Array.from(document.querySelectorAll('link[rel~="stylesheet"][href]')).map((link) => link.href),
    imageHrefs: Array.from(document.images)
      .map((image) => image.currentSrc || image.src)
      .filter((href) => /^https?:\/\//i.test(href)),
    guidedTabState: readGuidedTabSnapshot(cloned, guidedTabState),
  };

  // This fallback is injected as a standalone function by Chrome. Keep the
  // detection self-contained; it deliberately reuses the same conservative
  // rules as the rich serializer instead of depending on extension globals.
  function markOpenDrawers(sourceDoc, clonedRoot) {
    const sourceElements = Array.from(sourceDoc.querySelectorAll("*"));
    // querySelectorAll("*") on Document includes <html>, while the same call
    // on the cloned <html> root starts at its children. Include the root so
    // source and clone stay index-aligned.
    const clonedElements = [clonedRoot, ...clonedRoot.querySelectorAll("*")];
    const cloneBySource = new Map(sourceElements.map((el, index) => [el, clonedElements[index]]));
    const plans = [];
    const captureIdByTrackId = new Map();
    const pendingParents = [];
    const trackDrawerAttr = "data-yd-drawer-track-id";
    const trackOpenerAttr = "data-yd-drawer-track-opener";
    const trackSourceAttr = "data-yd-drawer-track-source";
    const trackParentAttr = "data-yd-drawer-track-parent";
    const drawerSelector = '[role="dialog"],[aria-modal="true"],[class*="drawer" i],[class*="side-panel" i],[class*="offcanvas" i],[class*="sheet" i]';
    const maskSelector = '[class*="drawer-mask" i],[class*="drawer-overlay" i],[class*="drawer-backdrop" i],[class*="modal-mask" i]';

    function classText(el) {
      return typeof el?.className === "string" ? el.className.toLowerCase() : "";
    }
    function drawerNameSignal(el) {
      const tokens = classText(el).split(/\s+/).filter(Boolean);
      return tokens.some((token) => /(?:^|[-_])(?:drawer|offcanvas)$/.test(token) || /(?:^|[-_])side[-_]panel$/.test(token) || /(?:^|[-_])(?:bottom|action|side)[-_]sheet$/.test(token) || token === "sheet");
    }
    function visibleDrawer(el) {
      try {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const positioned = /^(fixed|absolute)$/i.test(style.position || "");
        const edgeTolerance = 32;
        const edgeAttached = rect.left <= edgeTolerance || rect.right >= innerWidth - edgeTolerance || rect.top <= edgeTolerance || rect.bottom >= innerHeight - edgeTolerance;
        const semantic = el.getAttribute("role") === "dialog" || el.getAttribute("aria-modal") === "true";
        return style.display !== "none" && style.visibility !== "hidden" && rect.width >= 160 && rect.height >= 100 &&
          positioned && edgeAttached && (drawerNameSignal(el) || semantic);
      } catch {
        return false;
      }
    }
    function visible(el) {
      try {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      } catch {
        return false;
      }
    }
    function bestClose(drawer) {
      const drawerRect = drawer.getBoundingClientRect();
      const candidates = Array.from(drawer.querySelectorAll('button,a,[role="button"],[class*="close" i]'));
      const ranked = candidates
        .map((el) => {
          const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${el.textContent || ""}`.toLowerCase();
          const klass = classText(el);
          const rect = el.getBoundingClientRect();
          let score = 0;
          if (/close|关闭/.test(label)) score += 8;
          if (/drawer-close|modal-close|close/.test(klass)) score += 6;
          if (/pure-close|drawer-close|modal-close/.test(klass)) score += 4;
          if (el.parentElement === drawer || el.parentElement?.parentElement === drawer) score += 6;
          const header = el.closest('[class*="drawer-header" i],[class*="modal-header" i]');
          if (header && drawer.contains(header)) score += 5;
          if (el.tagName === "BUTTON") score += 1;
          if (rect.top - drawerRect.top >= -8 && rect.top - drawerRect.top < 160) score += 1;
          return { el, score };
        })
        .filter((item) => item.score >= 4)
        .sort((a, b) => b.score - a.score);
      if (!ranked.length || (ranked[1] && ranked[1].score === ranked[0].score)) return null;
      return ranked[0].el;
    }

    const drawerCandidates = Array.from(sourceDoc.querySelectorAll(drawerSelector)).filter(visibleDrawer);
    const outerDrawerCandidates = drawerCandidates.filter(
      (sourceDrawer) => sourceDrawer.hasAttribute(trackDrawerAttr) || !drawerCandidates.some(
        (otherDrawer) => otherDrawer !== sourceDrawer && otherDrawer.contains(sourceDrawer)
      )
    );
    for (const sourceDrawer of outerDrawerCandidates) {
      if (plans.length >= 8) continue;
      const trackId = sourceDrawer.getAttribute(trackDrawerAttr) || "";
      const sourceClose = bestClose(sourceDrawer);
      const clonedDrawer = cloneBySource.get(sourceDrawer);
      const clonedClose = sourceClose ? cloneBySource.get(sourceClose) : null;
      if (!clonedDrawer || (!clonedClose && !trackId)) continue;
      const id = `yd-drawer-${plans.length + 1}`;
      clonedDrawer.setAttribute("data-yd-capture-drawer", id);
      clonedDrawer.setAttribute("data-yd-capture-drawer-state", "open");
      if (clonedClose) {
        clonedClose.setAttribute("data-yd-capture-drawer-close", id);
        if (clonedClose.tagName === "A") clonedClose.removeAttribute("href");
        if (clonedClose.tagName === "BUTTON") clonedClose.setAttribute("type", "button");
      }

      const sourceOpeners = trackId ? sourceElements.filter((element) => element.getAttribute(trackOpenerAttr) === trackId && !sourceDrawer.contains(element)) : [];
      const clonedOpener = sourceOpeners.length === 1 ? cloneBySource.get(sourceOpeners[0]) : null;
      if (clonedOpener) {
        clonedOpener.setAttribute("data-yd-capture-drawer-open", id);
        clonedOpener.setAttribute("aria-expanded", "true");
        if (!clonedOpener.getAttribute("role") && !clonedOpener.matches("button,a")) clonedOpener.setAttribute("role", "button");
        if (!clonedOpener.matches("button") && !clonedOpener.hasAttribute("tabindex")) clonedOpener.setAttribute("tabindex", "0");
        if (clonedOpener.tagName === "A") clonedOpener.removeAttribute("href");
        if (clonedOpener.tagName === "BUTTON") clonedOpener.setAttribute("type", "button");
      }

      const masks = Array.from(sourceDoc.querySelectorAll(maskSelector)).filter((mask) =>
        visible(mask) && (mask.parentElement === sourceDrawer.parentElement || sourceDrawer.contains(mask))
      );
      const clonedMask = masks.length === 1 ? cloneBySource.get(masks[0]) : null;
      if (clonedMask) {
        clonedMask.setAttribute("data-yd-capture-drawer-mask", id);
        clonedMask.setAttribute("data-yd-capture-drawer-mask-state", "open");
      }
      const plan = { id, hasMask: Boolean(clonedMask) };
      if (clonedOpener) plan.hasOpener = true;
      const mappingSource = sourceDrawer.getAttribute(trackSourceAttr);
      if (mappingSource && clonedOpener) plan.mappingSource = mappingSource;
      plans.push(plan);
      if (trackId) captureIdByTrackId.set(trackId, id);
      const parentTrackId = sourceDrawer.getAttribute(trackParentAttr);
      if (parentTrackId) pendingParents.push({ clonedDrawer, parentTrackId, plan });
    }
    for (const item of pendingParents) {
      const parentId = captureIdByTrackId.get(item.parentTrackId);
      if (!parentId) continue;
      item.clonedDrawer.setAttribute("data-yd-capture-drawer-parent", parentId);
      item.plan.parentId = parentId;
    }
    for (const element of clonedElements) {
      element.removeAttribute(trackDrawerAttr);
      element.removeAttribute(trackOpenerAttr);
      element.removeAttribute(trackSourceAttr);
      element.removeAttribute(trackParentAttr);
    }
    return plans;
  }

  // 方案 B：只重建抓取瞬间已在 DOM 中的标准/Ant Design Tab 面板；
  // 不点击来源页面，不等待懒加载，也不触发任何业务请求。
  function markPreloadedTabs(sourceDoc, clonedRoot) {
    const sourceElements = Array.from(sourceDoc.querySelectorAll("*"));
    const clonedElements = [clonedRoot, ...clonedRoot.querySelectorAll("*")];
    const cloneBySource = new Map(sourceElements.map((el, index) => [el, clonedElements[index]]));
    const roots = Array.from(new Set(Array.from(sourceDoc.querySelectorAll('[role="tablist"],.ant-tabs,.dpl-tabs')).map((root) => root.matches(".dpl-tabs") ? root : root.closest(".dpl-tabs") || root)));
    const usedTabs = new Set();
    const plans = [];

    function tabCandidates(root) {
      const semantic = Array.from(root.querySelectorAll('[role="tab"]'));
      const ant = root.matches(".ant-tabs") ? Array.from(root.querySelectorAll(".ant-tabs-nav .ant-tabs-tab")) : [];
      const candidates = semantic.length ? semantic : ant;
      return candidates.filter((tab) => !usedTabs.has(tab) && !tab.hasAttribute("disabled") && Boolean((tab.textContent || "").trim()));
    }
    function byDataKey(root, key) {
      if (!key) return null;
      const panels = ownedPanels(root);
      return panels.find((panel) => panel.getAttribute("data-node-key") === key || panel.getAttribute("data-key") === key) || null;
    }
    function ownedPanels(root) {
      const componentScope = root.matches?.(".dpl-tabs,.ant-tabs") ? root : null;
      return Array.from(root.querySelectorAll('[role="tabpanel"],.ant-tabs-tabpane,.dpl-tabs-tabpane'))
        .filter((panel) => !componentScope || panel.closest(".dpl-tabs,.ant-tabs") === componentScope);
    }
    function panelFor(root, tab, index, tabs) {
      const control = tab.getAttribute("aria-controls");
      if (control) {
        const byId = sourceDoc.getElementById(control);
        if (byId) return byId;
      }
      const keyed = byDataKey(root, tab.getAttribute("data-node-key") || tab.getAttribute("data-key"));
      if (keyed) return keyed;
      const panels = ownedPanels(root);
      return panels.length === tabs.length ? panels[index] : null;
    }
    function selected(tab, panel) {
      if (tab.getAttribute("aria-selected") === "true" || /(?:^|\\s)ant-tabs-tab-active(?:\\s|$)/.test(String(tab.className || ""))) return true;
      try {
        const style = getComputedStyle(panel);
        return style.display !== "none" && style.visibility !== "hidden";
      } catch {
        return false;
      }
    }

    for (const root of roots) {
      if (plans.length >= 8) break;
      const tabs = tabCandidates(root).slice(0, 16);
      if (tabs.length < 2) continue;
      const panels = tabs.map((tab, index) => panelFor(root, tab, index, tabs));
      if (panels.some((panel) => !panel) || new Set(panels).size !== tabs.length) continue;
      const clonedTabs = tabs.map((tab) => cloneBySource.get(tab));
      const clonedPanels = panels.map((panel) => cloneBySource.get(panel));
      if (clonedTabs.some((tab) => !tab) || clonedPanels.some((panel) => !panel)) continue;
      const explicitActiveIndex = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true" || /(?:^|\s)(?:ant-tabs-tab-active|dpl-tabs-tab-active)(?:\s|$)/.test(String(tab.className || "")));
      const activeIndex = explicitActiveIndex >= 0 ? explicitActiveIndex : Math.max(0, panels.findIndex((panel, index) => selected(tabs[index], panel)));
      const groupId = `yd-tab-group-${plans.length + 1}`;
      const tabIds = [];
      for (let index = 0; index < tabs.length; index++) {
        const tabId = `yd-tab-${index + 1}`;
        const isActive = index === activeIndex;
        const clonedTab = clonedTabs[index];
        const clonedPanel = clonedPanels[index];
        tabIds.push(tabId);
        clonedTab.setAttribute("data-yd-capture-tab", tabId);
        clonedTab.setAttribute("data-yd-capture-tab-group", groupId);
        clonedTab.setAttribute("data-yd-capture-tab-state", isActive ? "open" : "closed");
        clonedTab.setAttribute("role", "tab");
        clonedTab.setAttribute("aria-selected", isActive ? "true" : "false");
        clonedTab.setAttribute("tabindex", isActive ? "0" : "-1");
        if (clonedTab.tagName === "A") clonedTab.removeAttribute("href");
        clonedPanel.setAttribute("data-yd-capture-tab-panel", tabId);
        clonedPanel.setAttribute("data-yd-capture-tab-group", groupId);
        clonedPanel.setAttribute("data-yd-capture-tab-panel-state", isActive ? "open" : "closed");
        clonedPanel.setAttribute("role", "tabpanel");
        clonedPanel.setAttribute("aria-hidden", isActive ? "false" : "true");
        usedTabs.add(tabs[index]);
      }
      plans.push({ id: groupId, activeTabId: tabIds[activeIndex], tabIds });
    }
    return plans;
  }

  function markGuidedTabState(sourceDoc, clonedRoot) {
    const sourceElements = Array.from(sourceDoc.querySelectorAll("*"));
    const clonedElements = [clonedRoot, ...clonedRoot.querySelectorAll("*")];
    const cloneBySource = new Map(sourceElements.map((el, index) => [el, clonedElements[index]]));
    const groups = [];
    const normalizeLabel = (value) => String(value || "").trim().replace(/\s+/g, " ");
    const active = (tab) => tab.getAttribute("aria-selected") === "true" || /(?:^|\s)(?:ant-tabs-tab-active|dpl-tabs-tab-active|adm-tabs-tab-active|am-tabs-tab-active|am-tabs-default-bar-tab-active)(?:\s|$)/.test(String(tab.className || ""));
    const semanticRoots = Array.from(sourceDoc.querySelectorAll('[role="tablist"]'));
    const componentRoots = Array.from(sourceDoc.querySelectorAll('.ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs')).filter((root) => !root.querySelector('[role="tablist"]'));
    const roots = Array.from(new Set([...semanticRoots, ...componentRoots]));
    for (const root of roots) {
      if (groups.length >= 8) break;
      const tabs = root.matches('.ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs')
        ? Array.from(root.querySelectorAll('[role="tab"],.ant-tabs-nav .ant-tabs-tab,.dpl-tabs-tab,.adm-tabs-tab,.am-tabs-tab,.am-tabs-default-bar-tab')).filter((tab) => tab.closest('.ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs') === root && Boolean(normalizeLabel(tab.textContent)))
        : Array.from(root.querySelectorAll('[role="tab"]')).filter((tab) => tab.closest('[role="tablist"]') === root && Boolean(normalizeLabel(tab.textContent)));
      if (tabs.length < 2 || tabs.length > 16) continue;
      const scope = root.matches('.ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs') ? root : root.closest(".dpl-tabs,.ant-tabs,.adm-tabs,.am-tabs") || root.parentElement;
      const directHost = scope && Array.from(scope.children).find((child) => child.matches?.(".dpl-tabs-content,.ant-tabs-content-holder,.ant-tabs-content,.adm-tabs-content,.am-tabs-content,.am-tabs-content-wrap"));
      const panelHost = directHost || scope?.querySelector?.(".dpl-tabs-content,.ant-tabs-content-holder,.ant-tabs-content,.adm-tabs-content,.am-tabs-content,.am-tabs-content-wrap") || null;
      // Ant Design Mobile may only mount the active pane. Keep the mapping scoped to a known
      // tab component and its direct content child so arbitrary horizontal controls stay ignored.
      const mobileActivePanel = root.matches(".adm-tabs,.am-tabs") && panelHost
        ? Array.from(panelHost.children).find((child) => child.matches?.(".adm-tabs-content-inner,.am-tabs-pane-wrap-active,.am-tabs-pane-wrap")) || panelHost.firstElementChild
        : null;
      const activeIndex = tabs.findIndex((tab) => active(tab));
      const hasContent = (panel) => Boolean(panel && (panel.children.length || normalizeLabel(panel.textContent)));
      const activePane = activeIndex >= 0 ? Array.from((panelHost || scope || root).querySelectorAll('[role="tabpanel"],.ant-tabs-tabpane,.dpl-tabs-tabpane,.am-tabs-pane-wrap'))
        .filter((panel) => panel.closest(".dpl-tabs,.ant-tabs,.adm-tabs,.am-tabs") === scope)[activeIndex] || mobileActivePanel : null;
      let externalActivePanel = null;
      if (scope?.matches?.(".am-tabs") && activeIndex >= 0 && !hasContent(activePane)) {
        let owner = scope;
        for (let depth = 0; owner && depth < 3; depth += 1, owner = owner.parentElement) {
          const sibling = owner.nextElementSibling;
          if (!sibling || sibling.matches(".am-tabs,.adm-tabs,.ant-tabs,.dpl-tabs") || !hasContent(sibling)) continue;
          externalActivePanel = sibling;
          break;
        }
      }
      const panelFor = (tab, index) => {
        const control = tab.getAttribute("aria-controls");
        if (control && sourceDoc.getElementById(control)) return sourceDoc.getElementById(control);
        const key = tab.getAttribute("data-node-key") || tab.getAttribute("data-key");
        const componentScope = scope?.matches?.(".dpl-tabs,.ant-tabs,.adm-tabs,.am-tabs") ? scope : null;
        const panels = Array.from((panelHost || scope || root).querySelectorAll('[role="tabpanel"],.ant-tabs-tabpane,.dpl-tabs-tabpane,.am-tabs-pane-wrap'))
          .filter((panel) => !componentScope || panel.closest(".dpl-tabs,.ant-tabs,.adm-tabs,.am-tabs") === componentScope);
        return panels.find((panel) => key && (panel.getAttribute("data-node-key") === key || panel.getAttribute("data-key") === key)) || (externalActivePanel && index === activeIndex ? externalActivePanel : null) || (panels.length === tabs.length ? panels[index] : null) || (panels.length === 1 && active(tab) ? panels[0] : null) || (mobileActivePanel && active(tab) ? mobileActivePanel : null);
      };
      const panels = tabs.map(panelFor);
      if (!panels.some(Boolean)) continue;
      const clonedHost = panelHost ? cloneBySource.get(panelHost) : null;
      const clonedTabs = tabs.map((tab) => cloneBySource.get(tab));
      if (!clonedHost || clonedTabs.some((tab) => !tab)) continue;
      const groupId = `yd-guided-tab-group-${groups.length + 1}`;
      const descriptors = [];
      for (let index = 0; index < tabs.length; index++) {
        const tab = tabs[index];
        const key = `${groupId}:tab-${index + 1}`;
        const clonedTab = clonedTabs[index];
        const clonedPanel = panels[index] ? cloneBySource.get(panels[index]) : null;
        clonedTab.setAttribute("data-yd-capture-guided-tab-key", key);
        clonedTab.setAttribute("data-yd-capture-guided-tab-group", groupId);
        if (clonedPanel) {
          clonedPanel.setAttribute("data-yd-capture-guided-tab-source-panel", key);
          if (panels[index] === externalActivePanel) clonedPanel.setAttribute("data-yd-capture-guided-tab-external-source", key);
        }
        if (clonedTab.tagName === "A") clonedTab.removeAttribute("href");
        descriptors.push({ key, label: normalizeLabel(tab.textContent).slice(0, 80) });
      }
      clonedHost.setAttribute("data-yd-capture-guided-tab-panel-host", groupId);
      groups.push({ id: groupId, activeKey: descriptors.find((_, index) => active(tabs[index]))?.key || descriptors[0]?.key || "", tabs: descriptors });
    }
    return groups.length ? { groups } : null;
  }

  function readGuidedTabSnapshot(clonedRoot, state) {
    if (!state?.groups) return null;
    const snapshots = [];
    for (const group of state.groups) {
      if (!group?.activeKey) continue;
      const panel = Array.from(clonedRoot.querySelectorAll("[data-yd-capture-guided-tab-source-panel]")).find((item) => item.getAttribute("data-yd-capture-guided-tab-source-panel") === group.activeKey);
      if (panel) snapshots.push({ key: group.activeKey, panelHtml: panel.outerHTML, capturedAt: new Date().toISOString() });
    }
    return { ...state, snapshots };
  }

  function freezeFrameRefs(clonedRoot) {
    const refs = [];
    for (const [index, frame] of Array.from(clonedRoot.querySelectorAll("iframe")).entries()) {
      const rawSource = frame.getAttribute("src") || "";
      let sourceUrl = rawSource;
      try {
        sourceUrl = rawSource ? new URL(rawSource, location.href).href : "";
      } catch {
        /* Keep an invalid URL only as diagnostic metadata; never retain it as iframe src. */
      }
      frame.setAttribute("data-yd-capture-frame", "pending");
      frame.setAttribute("data-yd-capture-frame-ref", `frame-${index + 1}`);
      if (sourceUrl) frame.setAttribute("data-yd-capture-frame-source", sourceUrl);
      frame.removeAttribute("src");
      frame.removeAttribute("srcdoc");
      refs.push({ ref: `frame-${index + 1}`, sourceUrl, name: frame.getAttribute("name") || "" });
    }
    return refs;
  }
}

function utf8Bytes(text) {
  return new TextEncoder().encode(String(text || "")).length;
}

async function inlineRemoteStyles(payload) {
  const hrefs = Array.from(new Set((payload.styleHrefs || []).filter(isHttpUrl))).slice(0, 60);
  if (!hrefs.length) return;

  const blocks = [];
  let totalBytes = 0;
  const failed = [];
  for (const href of hrefs) {
    try {
      const res = await fetch(href, { credentials: "include", cache: "force-cache" });
      if (!res.ok) {
        failed.push(`${href} -> HTTP ${res.status}`);
        continue;
      }
      const contentType = res.headers.get("content-type") || "";
      const text = await res.text();
      const bytes = utf8Bytes(text);
      if (bytes > MAX_SINGLE_CSS_BYTES) {
        failed.push(`${href} -> skipped ${Math.round(bytes / 1024)}KB`);
        continue;
      }
      if (!/css|text|octet-stream/i.test(contentType) && !/\\.css(?:$|[?#])/.test(href)) {
        failed.push(`${href} -> not css`);
        continue;
      }
      if (totalBytes + bytes > MAX_REMOTE_CSS_BYTES) {
        failed.push(`${href} -> total css budget reached`);
        continue;
      }
      totalBytes += bytes;
      blocks.push(`/* yd remote stylesheet: ${href} */\n${absolutizeCssUrlsForWorker(text, href)}`);
    } catch (error) {
      failed.push(`${href} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!blocks.length) {
    payload.remoteCss = { inlined: 0, bytes: 0, failed };
    return;
  }

  const styleTag = `<style data-yd-remote-css="true">\n${escapeStyleTextForHtml(blocks.join("\n\n"))}\n</style>`;
  payload.html = insertBeforeHeadEnd(payload.html, styleTag);
  payload.remoteCss = { inlined: blocks.length, bytes: totalBytes, failed: failed.slice(0, 12) };
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function insertBeforeHeadEnd(html, snippet) {
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, `${snippet}\n</head>`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${snippet}</head>`);
  return `${snippet}\n${html}`;
}

function escapeStyleTextForHtml(css) {
  return String(css || "").replace(/<\/style/gi, "<\\/style");
}

function absolutizeCssUrlsForWorker(css, baseHref) {
  return String(css || "")
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, quote, rawUrl) => {
      const url = String(rawUrl || "").trim();
      if (!shouldAbsolutizeWorkerUrl(url)) return full;
      try {
        return `url("${new URL(url, baseHref).href}")`;
      } catch {
        return full;
      }
    })
    .replace(/@import\s+(?:url\()?\s*(['"])([^'"]+)\1\s*\)?/gi, (full, quote, rawUrl) => {
      const url = String(rawUrl || "").trim();
      if (!shouldAbsolutizeWorkerUrl(url)) return full;
      try {
        return full.replace(rawUrl, new URL(url, baseHref).href);
      } catch {
        return full;
      }
    });
}

function shouldAbsolutizeWorkerUrl(value) {
  const v = value.trim();
  return Boolean(v) && !v.startsWith("#") && !/^(?:data:|blob:|javascript:|mailto:|tel:)/i.test(v);
}

function captureRenderedPage(skipPreloadedTabs = false) {
  const cloned = document.documentElement.cloneNode(true);

  syncFormState(document, cloned);
  const drawerPlans = markOpenDrawers(document, cloned);
  const tabPlans = skipPreloadedTabs ? [] : markPreloadedTabs(document, cloned);
  const guidedTabState = markGuidedTabState(document, cloned);
  const frameRefs = freezeFrameRefs(cloned);
  cloned.querySelectorAll('[data-yd-capture-extension-ui],#__yd_capture_overlay').forEach((node) => node.remove());
  absolutizeCommonUrls(cloned);
  absolutizeInlineStyleUrls(cloned);
  const failedCanvases = [];
  snapshotCanvases(document, cloned, failedCanvases);
  captureOpenShadowRoots(document, cloned);
  inlineReadableStyleSheets(cloned);
  disableScriptsAndHandlers(cloned);
  sanitizeCapturedDocument(cloned);
  const normalized = normalizeCapturedDocument(cloned);
  addCaptureMetadata(normalized);

  return {
    html: `<!doctype html>\n${normalized.outerHTML}`,
    title: document.title || location.hostname || "captured-page",
    url: location.href,
    frameName: window.name || "",
    capturedAt: new Date().toISOString(),
    drawerPlans,
    frameRefs,
    captureMeta: { schemaVersion: 2, interactions: { drawers: drawerPlans, tabs: tabPlans } },
    styleHrefs: Array.from(document.querySelectorAll('link[rel~="stylesheet"][href]'))
      .map((link) => link.href)
      .filter((href) => !isCaptureNoiseUrl(href)),
    imageHrefs: Array.from(document.images)
      .map((image) => image.currentSrc || image.src)
      .filter((href) => /^https?:\/\//i.test(href) && !isCaptureNoiseUrl(href)),
    guidedTabState: readGuidedTabSnapshot(normalized, guidedTabState),
    failedCanvases,
  };

  function syncFormState(sourceDoc, clonedRoot) {
    const sourceInputs = sourceDoc.querySelectorAll("input");
    const clonedInputs = clonedRoot.querySelectorAll("input");
    sourceInputs.forEach((input, index) => {
      const clone = clonedInputs[index];
      if (!clone) return;
      const type = (input.getAttribute("type") || "").toLowerCase();
      if (type === "password") {
        clone.setAttribute("value", "");
      } else if (type === "checkbox" || type === "radio") {
        if (input.checked) clone.setAttribute("checked", "");
        else clone.removeAttribute("checked");
      } else {
        clone.setAttribute("value", input.value || "");
      }
    });

    const sourceTextareas = sourceDoc.querySelectorAll("textarea");
    const clonedTextareas = clonedRoot.querySelectorAll("textarea");
    sourceTextareas.forEach((textarea, index) => {
      const clone = clonedTextareas[index];
      if (clone) clone.textContent = textarea.value || "";
    });

    const sourceSelects = sourceDoc.querySelectorAll("select");
    const clonedSelects = clonedRoot.querySelectorAll("select");
    sourceSelects.forEach((select, index) => {
      const clone = clonedSelects[index];
      if (!clone) return;
      const selected = new Set(Array.from(select.selectedOptions).map((option) => option.index));
      Array.from(clone.options).forEach((option, optionIndex) => {
        if (selected.has(optionIndex)) option.setAttribute("selected", "");
        else option.removeAttribute("selected");
      });
    });
  }

  function markOpenDrawers(sourceDoc, clonedRoot) {
    const sourceElements = Array.from(sourceDoc.querySelectorAll("*"));
    // querySelectorAll("*") on Document includes <html>, while the same call
    // on the cloned <html> root starts at its children. Include the root so
    // source and clone stay index-aligned.
    const clonedElements = [clonedRoot, ...clonedRoot.querySelectorAll("*")];
    const cloneBySource = new Map(sourceElements.map((el, index) => [el, clonedElements[index]]));
    const plans = [];
    const captureIdByTrackId = new Map();
    const pendingParents = [];
    const trackDrawerAttr = "data-yd-drawer-track-id";
    const trackOpenerAttr = "data-yd-drawer-track-opener";
    const trackSourceAttr = "data-yd-drawer-track-source";
    const trackParentAttr = "data-yd-drawer-track-parent";
    const drawerSelector = '[role="dialog"],[aria-modal="true"],[class*="drawer" i],[class*="side-panel" i],[class*="offcanvas" i],[class*="sheet" i]';
    const maskSelector = '[class*="drawer-mask" i],[class*="drawer-overlay" i],[class*="drawer-backdrop" i],[class*="modal-mask" i]';

    function classText(el) {
      return typeof el?.className === "string" ? el.className.toLowerCase() : "";
    }
    function drawerNameSignal(el) {
      const tokens = classText(el).split(/\s+/).filter(Boolean);
      return tokens.some((token) => /(?:^|[-_])(?:drawer|offcanvas)$/.test(token) || /(?:^|[-_])side[-_]panel$/.test(token) || /(?:^|[-_])(?:bottom|action|side)[-_]sheet$/.test(token) || token === "sheet");
    }
    function visibleDrawer(el) {
      try {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const positioned = /^(fixed|absolute)$/i.test(style.position || "");
        const edgeTolerance = 32;
        const edgeAttached = rect.left <= edgeTolerance || rect.right >= innerWidth - edgeTolerance || rect.top <= edgeTolerance || rect.bottom >= innerHeight - edgeTolerance;
        const semantic = el.getAttribute("role") === "dialog" || el.getAttribute("aria-modal") === "true";
        return style.display !== "none" && style.visibility !== "hidden" && rect.width >= 160 && rect.height >= 100 &&
          positioned && edgeAttached && (drawerNameSignal(el) || semantic);
      } catch {
        return false;
      }
    }
    function visible(el) {
      try {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      } catch {
        return false;
      }
    }
    function bestClose(drawer) {
      const drawerRect = drawer.getBoundingClientRect();
      const candidates = Array.from(drawer.querySelectorAll('button,a,[role="button"],[class*="close" i]'));
      const ranked = candidates
        .map((el) => {
          const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${el.textContent || ""}`.toLowerCase();
          const klass = classText(el);
          const rect = el.getBoundingClientRect();
          let score = 0;
          if (/close|关闭/.test(label)) score += 8;
          if (/drawer-close|modal-close|close/.test(klass)) score += 6;
          if (/pure-close|drawer-close|modal-close/.test(klass)) score += 4;
          if (el.parentElement === drawer || el.parentElement?.parentElement === drawer) score += 6;
          const header = el.closest('[class*="drawer-header" i],[class*="modal-header" i]');
          if (header && drawer.contains(header)) score += 5;
          if (el.tagName === "BUTTON") score += 1;
          if (rect.top - drawerRect.top >= -8 && rect.top - drawerRect.top < 160) score += 1;
          return { el, score };
        })
        .filter((item) => item.score >= 4)
        .sort((a, b) => b.score - a.score);
      if (!ranked.length || (ranked[1] && ranked[1].score === ranked[0].score)) return null;
      return ranked[0].el;
    }

    const drawerCandidates = Array.from(sourceDoc.querySelectorAll(drawerSelector)).filter(visibleDrawer);
    const outerDrawerCandidates = drawerCandidates.filter(
      (sourceDrawer) => sourceDrawer.hasAttribute(trackDrawerAttr) || !drawerCandidates.some(
        (otherDrawer) => otherDrawer !== sourceDrawer && otherDrawer.contains(sourceDrawer)
      )
    );
    for (const sourceDrawer of outerDrawerCandidates) {
      if (plans.length >= 8) continue;
      const trackId = sourceDrawer.getAttribute(trackDrawerAttr) || "";
      const sourceClose = bestClose(sourceDrawer);
      const clonedDrawer = cloneBySource.get(sourceDrawer);
      const clonedClose = sourceClose ? cloneBySource.get(sourceClose) : null;
      if (!clonedDrawer || (!clonedClose && !trackId)) continue;
      const id = `yd-drawer-${plans.length + 1}`;
      clonedDrawer.setAttribute("data-yd-capture-drawer", id);
      clonedDrawer.setAttribute("data-yd-capture-drawer-state", "open");
      if (clonedClose) {
        clonedClose.setAttribute("data-yd-capture-drawer-close", id);
        if (clonedClose.tagName === "A") clonedClose.removeAttribute("href");
        if (clonedClose.tagName === "BUTTON") clonedClose.setAttribute("type", "button");
      }

      const sourceOpeners = trackId ? sourceElements.filter((element) => element.getAttribute(trackOpenerAttr) === trackId && !sourceDrawer.contains(element)) : [];
      const clonedOpener = sourceOpeners.length === 1 ? cloneBySource.get(sourceOpeners[0]) : null;
      if (clonedOpener) {
        clonedOpener.setAttribute("data-yd-capture-drawer-open", id);
        clonedOpener.setAttribute("aria-expanded", "true");
        if (!clonedOpener.getAttribute("role") && !clonedOpener.matches("button,a")) clonedOpener.setAttribute("role", "button");
        if (!clonedOpener.matches("button") && !clonedOpener.hasAttribute("tabindex")) clonedOpener.setAttribute("tabindex", "0");
        if (clonedOpener.tagName === "A") clonedOpener.removeAttribute("href");
        if (clonedOpener.tagName === "BUTTON") clonedOpener.setAttribute("type", "button");
      }

      const masks = Array.from(sourceDoc.querySelectorAll(maskSelector)).filter((mask) =>
        visible(mask) && (mask.parentElement === sourceDrawer.parentElement || sourceDrawer.contains(mask))
      );
      const clonedMask = masks.length === 1 ? cloneBySource.get(masks[0]) : null;
      if (clonedMask) {
        clonedMask.setAttribute("data-yd-capture-drawer-mask", id);
        clonedMask.setAttribute("data-yd-capture-drawer-mask-state", "open");
      }
      const plan = { id, hasMask: Boolean(clonedMask) };
      if (clonedOpener) plan.hasOpener = true;
      const mappingSource = sourceDrawer.getAttribute(trackSourceAttr);
      if (mappingSource && clonedOpener) plan.mappingSource = mappingSource;
      plans.push(plan);
      if (trackId) captureIdByTrackId.set(trackId, id);
      const parentTrackId = sourceDrawer.getAttribute(trackParentAttr);
      if (parentTrackId) pendingParents.push({ clonedDrawer, parentTrackId, plan });
    }
    for (const item of pendingParents) {
      const parentId = captureIdByTrackId.get(item.parentTrackId);
      if (!parentId) continue;
      item.clonedDrawer.setAttribute("data-yd-capture-drawer-parent", parentId);
      item.plan.parentId = parentId;
    }
    for (const element of clonedElements) {
      element.removeAttribute(trackDrawerAttr);
      element.removeAttribute(trackOpenerAttr);
      element.removeAttribute(trackSourceAttr);
      element.removeAttribute(trackParentAttr);
    }
    return plans;
  }

  function freezeFrameRefs(clonedRoot) {
    const refs = [];
    for (const [index, frame] of Array.from(clonedRoot.querySelectorAll("iframe")).entries()) {
      const rawSource = frame.getAttribute("src") || "";
      let sourceUrl = rawSource;
      try {
        sourceUrl = rawSource ? new URL(rawSource, location.href).href : "";
      } catch {
        /* Keep an invalid URL only as diagnostic metadata; never retain it as iframe src. */
      }
      frame.setAttribute("data-yd-capture-frame", "pending");
      frame.setAttribute("data-yd-capture-frame-ref", `frame-${index + 1}`);
      if (sourceUrl) frame.setAttribute("data-yd-capture-frame-source", sourceUrl);
      frame.removeAttribute("src");
      frame.removeAttribute("srcdoc");
      refs.push({ ref: `frame-${index + 1}`, sourceUrl, name: frame.getAttribute("name") || "" });
    }
    return refs;
  }

  // Keep this self-contained: captureRenderedPage is injected into the page
  // and cannot rely on extension-worker helpers.
  function markPreloadedTabs(sourceDoc, clonedRoot) {
    const sourceElements = Array.from(sourceDoc.querySelectorAll("*"));
    const clonedElements = [clonedRoot, ...clonedRoot.querySelectorAll("*")];
    const cloneBySource = new Map(sourceElements.map((el, index) => [el, clonedElements[index]]));
    const roots = Array.from(new Set(Array.from(sourceDoc.querySelectorAll('[role="tablist"],.ant-tabs,.dpl-tabs')).map((root) => root.matches(".dpl-tabs") ? root : root.closest(".dpl-tabs") || root)));
    const usedTabs = new Set();
    const plans = [];

    function tabCandidates(root) {
      const semantic = Array.from(root.querySelectorAll('[role="tab"]'));
      const ant = root.matches(".ant-tabs") ? Array.from(root.querySelectorAll(".ant-tabs-nav .ant-tabs-tab")) : [];
      const candidates = semantic.length ? semantic : ant;
      return candidates.filter((tab) => !usedTabs.has(tab) && !tab.hasAttribute("disabled") && Boolean((tab.textContent || "").trim()));
    }
    function byDataKey(root, key) {
      if (!key) return null;
      const panels = ownedPanels(root);
      return panels.find((panel) => panel.getAttribute("data-node-key") === key || panel.getAttribute("data-key") === key) || null;
    }
    function ownedPanels(root) {
      const componentScope = root.matches?.(".dpl-tabs,.ant-tabs") ? root : null;
      return Array.from(root.querySelectorAll('[role="tabpanel"],.ant-tabs-tabpane,.dpl-tabs-tabpane'))
        .filter((panel) => !componentScope || panel.closest(".dpl-tabs,.ant-tabs") === componentScope);
    }
    function panelFor(root, tab, index, tabs) {
      const control = tab.getAttribute("aria-controls");
      if (control) {
        const byId = sourceDoc.getElementById(control);
        if (byId) return byId;
      }
      const keyed = byDataKey(root, tab.getAttribute("data-node-key") || tab.getAttribute("data-key"));
      if (keyed) return keyed;
      const panels = ownedPanels(root);
      return panels.length === tabs.length ? panels[index] : null;
    }
    function selected(tab, panel) {
      if (tab.getAttribute("aria-selected") === "true" || /(?:^|\\s)ant-tabs-tab-active(?:\\s|$)/.test(String(tab.className || ""))) return true;
      try {
        const style = getComputedStyle(panel);
        return style.display !== "none" && style.visibility !== "hidden";
      } catch {
        return false;
      }
    }

    for (const root of roots) {
      if (plans.length >= 8) break;
      const tabs = tabCandidates(root).slice(0, 16);
      if (tabs.length < 2) continue;
      const panels = tabs.map((tab, index) => panelFor(root, tab, index, tabs));
      if (panels.some((panel) => !panel) || new Set(panels).size !== tabs.length) continue;
      const clonedTabs = tabs.map((tab) => cloneBySource.get(tab));
      const clonedPanels = panels.map((panel) => cloneBySource.get(panel));
      if (clonedTabs.some((tab) => !tab) || clonedPanels.some((panel) => !panel)) continue;
      const explicitActiveIndex = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true" || /(?:^|\s)(?:ant-tabs-tab-active|dpl-tabs-tab-active)(?:\s|$)/.test(String(tab.className || "")));
      const activeIndex = explicitActiveIndex >= 0 ? explicitActiveIndex : Math.max(0, panels.findIndex((panel, index) => selected(tabs[index], panel)));
      const groupId = `yd-tab-group-${plans.length + 1}`;
      const tabIds = [];
      for (let index = 0; index < tabs.length; index++) {
        const tabId = `yd-tab-${index + 1}`;
        const isActive = index === activeIndex;
        const clonedTab = clonedTabs[index];
        const clonedPanel = clonedPanels[index];
        tabIds.push(tabId);
        clonedTab.setAttribute("data-yd-capture-tab", tabId);
        clonedTab.setAttribute("data-yd-capture-tab-group", groupId);
        clonedTab.setAttribute("data-yd-capture-tab-state", isActive ? "open" : "closed");
        clonedTab.setAttribute("role", "tab");
        clonedTab.setAttribute("aria-selected", isActive ? "true" : "false");
        clonedTab.setAttribute("tabindex", isActive ? "0" : "-1");
        if (clonedTab.tagName === "A") clonedTab.removeAttribute("href");
        clonedPanel.setAttribute("data-yd-capture-tab-panel", tabId);
        clonedPanel.setAttribute("data-yd-capture-tab-group", groupId);
        clonedPanel.setAttribute("data-yd-capture-tab-panel-state", isActive ? "open" : "closed");
        clonedPanel.setAttribute("role", "tabpanel");
        clonedPanel.setAttribute("aria-hidden", isActive ? "false" : "true");
        usedTabs.add(tabs[index]);
      }
      plans.push({ id: groupId, activeTabId: tabIds[activeIndex], tabIds });
    }
    return plans;
  }

  function markGuidedTabState(sourceDoc, clonedRoot) {
    const sourceElements = Array.from(sourceDoc.querySelectorAll("*"));
    const clonedElements = [clonedRoot, ...clonedRoot.querySelectorAll("*")];
    const cloneBySource = new Map(sourceElements.map((el, index) => [el, clonedElements[index]]));
    const groups = [];
    const normalizeLabel = (value) => String(value || "").trim().replace(/\s+/g, " ");
    const active = (tab) => tab.getAttribute("aria-selected") === "true" || /(?:^|\s)(?:ant-tabs-tab-active|dpl-tabs-tab-active|adm-tabs-tab-active|am-tabs-tab-active|am-tabs-default-bar-tab-active)(?:\s|$)/.test(String(tab.className || ""));
    const semanticRoots = Array.from(sourceDoc.querySelectorAll('[role="tablist"]'));
    const componentRoots = Array.from(sourceDoc.querySelectorAll('.ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs')).filter((root) => !root.querySelector('[role="tablist"]'));
    const roots = Array.from(new Set([...semanticRoots, ...componentRoots]));
    for (const root of roots) {
      if (groups.length >= 8) break;
      const tabs = root.matches('.ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs')
        ? Array.from(root.querySelectorAll('[role="tab"],.ant-tabs-nav .ant-tabs-tab,.dpl-tabs-tab,.adm-tabs-tab,.am-tabs-tab,.am-tabs-default-bar-tab')).filter((tab) => tab.closest('.ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs') === root && Boolean(normalizeLabel(tab.textContent)))
        : Array.from(root.querySelectorAll('[role="tab"]')).filter((tab) => tab.closest('[role="tablist"]') === root && Boolean(normalizeLabel(tab.textContent)));
      if (tabs.length < 2 || tabs.length > 16) continue;
      const scope = root.matches('.ant-tabs,.dpl-tabs,.adm-tabs,.am-tabs') ? root : root.closest(".dpl-tabs,.ant-tabs,.adm-tabs,.am-tabs") || root.parentElement;
      const directHost = scope && Array.from(scope.children).find((child) => child.matches?.(".dpl-tabs-content,.ant-tabs-content-holder,.ant-tabs-content,.adm-tabs-content,.am-tabs-content,.am-tabs-content-wrap"));
      const panelHost = directHost || scope?.querySelector?.(".dpl-tabs-content,.ant-tabs-content-holder,.ant-tabs-content,.adm-tabs-content,.am-tabs-content,.am-tabs-content-wrap") || null;
      // Ant Design Mobile may only mount the active pane. Keep the mapping scoped to a known
      // tab component and its direct content child so arbitrary horizontal controls stay ignored.
      const mobileActivePanel = root.matches(".adm-tabs,.am-tabs") && panelHost
        ? Array.from(panelHost.children).find((child) => child.matches?.(".adm-tabs-content-inner,.am-tabs-pane-wrap-active,.am-tabs-pane-wrap")) || panelHost.firstElementChild
        : null;
      const activeIndex = tabs.findIndex((tab) => active(tab));
      const hasContent = (panel) => Boolean(panel && (panel.children.length || normalizeLabel(panel.textContent)));
      const activePane = activeIndex >= 0 ? Array.from((panelHost || scope || root).querySelectorAll('[role="tabpanel"],.ant-tabs-tabpane,.dpl-tabs-tabpane,.am-tabs-pane-wrap'))
        .filter((panel) => panel.closest(".dpl-tabs,.ant-tabs,.adm-tabs,.am-tabs") === scope)[activeIndex] || mobileActivePanel : null;
      let externalActivePanel = null;
      if (scope?.matches?.(".am-tabs") && activeIndex >= 0 && !hasContent(activePane)) {
        let owner = scope;
        for (let depth = 0; owner && depth < 3; depth += 1, owner = owner.parentElement) {
          const sibling = owner.nextElementSibling;
          if (!sibling || sibling.matches(".am-tabs,.adm-tabs,.ant-tabs,.dpl-tabs") || !hasContent(sibling)) continue;
          externalActivePanel = sibling;
          break;
        }
      }
      const panelFor = (tab, index) => {
        const control = tab.getAttribute("aria-controls");
        if (control && sourceDoc.getElementById(control)) return sourceDoc.getElementById(control);
        const key = tab.getAttribute("data-node-key") || tab.getAttribute("data-key");
        const componentScope = scope?.matches?.(".dpl-tabs,.ant-tabs,.adm-tabs,.am-tabs") ? scope : null;
        const panels = Array.from((panelHost || scope || root).querySelectorAll('[role="tabpanel"],.ant-tabs-tabpane,.dpl-tabs-tabpane,.am-tabs-pane-wrap'))
          .filter((panel) => !componentScope || panel.closest(".dpl-tabs,.ant-tabs,.adm-tabs,.am-tabs") === componentScope);
        return panels.find((panel) => key && (panel.getAttribute("data-node-key") === key || panel.getAttribute("data-key") === key)) || (externalActivePanel && index === activeIndex ? externalActivePanel : null) || (panels.length === tabs.length ? panels[index] : null) || (panels.length === 1 && active(tab) ? panels[0] : null) || (mobileActivePanel && active(tab) ? mobileActivePanel : null);
      };
      const panels = tabs.map(panelFor);
      if (!panels.some(Boolean)) continue;
      const clonedHost = panelHost ? cloneBySource.get(panelHost) : null;
      const clonedTabs = tabs.map((tab) => cloneBySource.get(tab));
      if (!clonedHost || clonedTabs.some((tab) => !tab)) continue;
      const groupId = `yd-guided-tab-group-${groups.length + 1}`;
      const descriptors = [];
      for (let index = 0; index < tabs.length; index++) {
        const tab = tabs[index];
        const key = `${groupId}:tab-${index + 1}`;
        const clonedTab = clonedTabs[index];
        const clonedPanel = panels[index] ? cloneBySource.get(panels[index]) : null;
        clonedTab.setAttribute("data-yd-capture-guided-tab-key", key);
        clonedTab.setAttribute("data-yd-capture-guided-tab-group", groupId);
        if (clonedPanel) {
          clonedPanel.setAttribute("data-yd-capture-guided-tab-source-panel", key);
          if (panels[index] === externalActivePanel) clonedPanel.setAttribute("data-yd-capture-guided-tab-external-source", key);
        }
        if (clonedTab.tagName === "A") clonedTab.removeAttribute("href");
        descriptors.push({ key, label: normalizeLabel(tab.textContent).slice(0, 80) });
      }
      clonedHost.setAttribute("data-yd-capture-guided-tab-panel-host", groupId);
      groups.push({ id: groupId, activeKey: descriptors.find((_, index) => active(tabs[index]))?.key || descriptors[0]?.key || "", tabs: descriptors });
    }
    return groups.length ? { groups } : null;
  }

  function readGuidedTabSnapshot(clonedRoot, state) {
    if (!state?.groups) return null;
    const snapshots = [];
    for (const group of state.groups) {
      if (!group?.activeKey) continue;
      const panel = Array.from(clonedRoot.querySelectorAll("[data-yd-capture-guided-tab-source-panel]")).find((item) => item.getAttribute("data-yd-capture-guided-tab-source-panel") === group.activeKey);
      if (panel) snapshots.push({ key: group.activeKey, panelHtml: panel.outerHTML, capturedAt: new Date().toISOString() });
    }
    return { ...state, snapshots };
  }

  function absolutizeCommonUrls(clonedRoot) {
    const urlAttrs = ["src", "href", "poster", "data", "action", "formaction", "xlink:href"];
    const urlSelector = urlAttrs.map((attr) => `[${attr.replaceAll(":", "\\:")}]`).join(",");
    for (const el of clonedRoot.querySelectorAll(urlSelector)) {
      for (const attr of urlAttrs) {
        const value = el.getAttribute(attr);
        if (!value || !shouldAbsolutize(value)) continue;
        try {
          el.setAttribute(attr, new URL(value, location.href).href);
        } catch {
          /* Leave invalid URLs as-is. */
        }
      }
    }
    for (const el of clonedRoot.querySelectorAll("[srcset]")) {
      const srcset = el.getAttribute("srcset");
      if (srcset) el.setAttribute("srcset", absolutizeSrcset(srcset));
    }
  }

  function absolutizeInlineStyleUrls(clonedRoot) {
    for (const el of clonedRoot.querySelectorAll("[style]")) {
      const style = el.getAttribute("style");
      if (style) el.setAttribute("style", absolutizeCssUrls(style, location.href));
    }
  }

  function shouldAbsolutize(value) {
    const v = value.trim();
    return Boolean(v) && !v.startsWith("#") && !/^(?:data:|blob:|javascript:|mailto:|tel:)/i.test(v);
  }

  function absolutizeSrcset(srcset) {
    return srcset
      .split(",")
      .map((part) => {
        const trimmed = part.trim();
        if (!trimmed) return "";
        const pieces = trimmed.split(/\s+/);
        if (shouldAbsolutize(pieces[0])) {
          try {
            pieces[0] = new URL(pieces[0], location.href).href;
          } catch {
            /* Leave invalid URLs as-is. */
          }
        }
        return pieces.join(" ");
      })
      .filter(Boolean)
      .join(", ");
  }

  function snapshotCanvases(sourceDoc, clonedRoot, failedCanvases) {
    const sourceCanvases = Array.from(sourceDoc.querySelectorAll("canvas"));
    const clonedCanvases = Array.from(clonedRoot.querySelectorAll("canvas"));
    sourceCanvases.forEach((canvas, index) => {
      const clone = clonedCanvases[index];
      if (!clone) {
        console.warn("[YouDesign Capture] canvas snapshot: clone missing at index", index);
        return;
      }
      // rect 在抓取瞬间、当前 frame 视口坐标系下取，供 service_worker 侧
      // 可见区截图按坐标裁剪用（被污染 canvas 像素读不出，只能靠截图保真）。
      const rectInFrame = canvas.getBoundingClientRect();
      const recordFailure = (reason, detail) => {
        const failIdx = failedCanvases ? failedCanvases.length : 0;
        clone.setAttribute("data-yd-canvas-failed", reason);
        clone.setAttribute("data-yd-canvas-fail-idx", String(failIdx));
        if (detail) clone.setAttribute("data-yd-canvas-detail", String(detail).slice(0, 200));
        if (failedCanvases) {
          failedCanvases.push({
            reason,
            detail: detail ? String(detail).slice(0, 200) : "",
            width: canvas.width,
            height: canvas.height,
            rectInFrame: {
              x: Math.round(rectInFrame.x * 100) / 100,
              y: Math.round(rectInFrame.y * 100) / 100,
              w: Math.round(rectInFrame.width * 100) / 100,
              h: Math.round(rectInFrame.height * 100) / 100,
            },
          });
        }
      };
      if (canvas.width <= 0 || canvas.height <= 0) {
        recordFailure("zero-size", `${canvas.width}x${canvas.height}`);
        return;
      }
      let dataUrl = "";
      let toDataUrlError = null;
      try {
        dataUrl = canvas.toDataURL("image/png");
      } catch (error) {
        toDataUrlError = error;
      }
      if (toDataUrlError) {
        // canvas 被跨域图片污染（SecurityError），浏览器不允许读像素。
        recordFailure(
          "toDataURL-threw",
          `${toDataUrlError.name || "Error"}: ${toDataUrlError.message || ""}`,
        );
        return;
      }
      if (!dataUrl || dataUrl === "data:,") {
        recordFailure("empty-dataurl");
        return;
      }

      const img = document.createElement("img");
      for (const attr of Array.from(clone.attributes)) {
        if (attr.name === "width" || attr.name === "height") continue;
        img.setAttribute(attr.name, attr.value);
      }
      img.setAttribute("src", dataUrl);
      img.setAttribute("data-yd-canvas-snapshot", "true");
      img.setAttribute("width", String(canvas.width));
      img.setAttribute("height", String(canvas.height));

      const rect = canvas.getBoundingClientRect();
      const sourceStyle = canvas.getAttribute("style") || "";
      if (sourceStyle) img.setAttribute("style", sourceStyle);
      if (rect.width > 0 && !/width\s*:/i.test(img.getAttribute("style") || "")) {
        img.style.width = `${Math.round(rect.width * 100) / 100}px`;
      }
      if (rect.height > 0 && !/height\s*:/i.test(img.getAttribute("style") || "")) {
        img.style.height = `${Math.round(rect.height * 100) / 100}px`;
      }
      if (!/display\s*:/i.test(img.getAttribute("style") || "")) img.style.display = "block";

      clone.replaceWith(img);
    });
  }

  function disableScriptsAndHandlers(clonedRoot) {
    for (const script of clonedRoot.querySelectorAll("script")) {
      script.setAttribute("type", "text/plain");
      script.setAttribute("data-yd-disabled-script", script.getAttribute("src") || "inline");
      script.removeAttribute("src");
    }
    clonedRoot.querySelectorAll('link[rel~="modulepreload"],link[rel~="prefetch"][as="script"],link[rel~="preload"][as="script"]').forEach((el) => el.remove());
    for (const el of clonedRoot.querySelectorAll("*")) {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value || "";
        if (name.startsWith("on")) el.removeAttribute(attr.name);
        if ((name === "href" || name === "src" || name === "action") && /^javascript:/i.test(value.trim())) {
          el.removeAttribute(attr.name);
        }
      }
    }
  }

  function inlineReadableStyleSheets(clonedRoot) {
    const head = clonedRoot.querySelector("head");
    if (!head) return;
    const blocks = [];
    const seen = new Set();

    for (const sheet of Array.from(document.styleSheets)) {
      const block = serializeStyleSheet(sheet, seen);
      if (block) blocks.push(block);
    }

    if (Array.isArray(document.adoptedStyleSheets)) {
      for (const sheet of document.adoptedStyleSheets) {
        const block = serializeStyleSheet(sheet, seen);
        if (block) blocks.push(block);
      }
    }

    if (!blocks.length) return;
    const style = document.createElement("style");
    style.setAttribute("data-yd-captured-css", "true");
    style.textContent = blocks.join("\n\n");
    head.appendChild(style);
  }

  function serializeStyleSheet(sheet, seen) {
    if (!sheet || seen.has(sheet)) return "";
    seen.add(sheet);
    if (isCaptureNoiseUrl(sheet.href || "")) return "";
    let rules;
    try {
      rules = Array.from(sheet.cssRules || []);
    } catch {
      return "";
    }
    if (!rules.length) return "";
    const css = rules
      .map((rule) => serializeCssRule(rule, seen))
      .filter(Boolean)
      .join("\n");
    if (!css.trim()) return "";
    const href = sheet.href || "";
    const owner = sheet.ownerNode;
    const media =
      owner && owner instanceof HTMLLinkElement && owner.media && owner.media !== "all"
        ? owner.media
        : sheet.media && sheet.media.mediaText
          ? sheet.media.mediaText
          : "";
    const sourceComment = href ? `/* captured stylesheet: ${href} */\n` : "";
    const wrapped = media ? `@media ${media} {\n${css}\n}` : css;
    return sourceComment + wrapped;
  }

  function serializeCssRule(rule, seen) {
    if (!rule) return "";
    const hrefBase = rule.parentStyleSheet?.href || location.href;

    if (typeof CSSImportRule !== "undefined" && rule instanceof CSSImportRule) {
      try {
        const nested = serializeStyleSheet(rule.styleSheet, seen);
        if (nested) return nested;
      } catch {
        /* Fall through to cssText. */
      }
    }

    if (typeof CSSMediaRule !== "undefined" && rule instanceof CSSMediaRule) {
      const inner = Array.from(rule.cssRules || [])
        .map((child) => serializeCssRule(child, seen))
        .filter(Boolean)
        .join("\n");
      return inner ? `@media ${rule.conditionText} {\n${inner}\n}` : "";
    }

    if (typeof CSSSupportsRule !== "undefined" && rule instanceof CSSSupportsRule) {
      const inner = Array.from(rule.cssRules || [])
        .map((child) => serializeCssRule(child, seen))
        .filter(Boolean)
        .join("\n");
      return inner ? `@supports ${rule.conditionText} {\n${inner}\n}` : "";
    }

    if (typeof CSSLayerBlockRule !== "undefined" && rule instanceof CSSLayerBlockRule) {
      const inner = Array.from(rule.cssRules || [])
        .map((child) => serializeCssRule(child, seen))
        .filter(Boolean)
        .join("\n");
      return inner ? `@layer ${rule.name || ""} {\n${inner}\n}` : "";
    }

    if (typeof CSSContainerRule !== "undefined" && rule instanceof CSSContainerRule) {
      const inner = Array.from(rule.cssRules || [])
        .map((child) => serializeCssRule(child, seen))
        .filter(Boolean)
        .join("\n");
      return inner ? `@container ${rule.conditionText} {\n${inner}\n}` : "";
    }

    return absolutizeCssUrls(rule.cssText || "", hrefBase);
  }

  function absolutizeCssUrls(css, baseHref) {
    return String(css || "")
      .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, quote, rawUrl) => {
        const url = String(rawUrl || "").trim();
        if (!shouldAbsolutize(url)) return full;
        try {
          return `url("${new URL(url, baseHref).href}")`;
        } catch {
          return full;
        }
      })
      .replace(/@import\s+(?:url\()?\s*(['"])([^'"]+)\1\s*\)?/gi, (full, quote, rawUrl) => {
        const url = String(rawUrl || "").trim();
        if (!shouldAbsolutize(url)) return full;
        try {
          return full.replace(rawUrl, new URL(url, baseHref).href);
        } catch {
          return full;
        }
      });
  }

  function captureOpenShadowRoots(sourceDoc, clonedRoot) {
    const sourceElements = Array.from(sourceDoc.querySelectorAll("*"));
    const clonedElements = Array.from(clonedRoot.querySelectorAll("*"));
    sourceElements.forEach((sourceEl, index) => {
      const shadow = sourceEl.shadowRoot;
      const cloneEl = clonedElements[index];
      if (!shadow || shadow.mode !== "open" || !cloneEl) return;
      const template = document.createElement("template");
      template.setAttribute("shadowrootmode", "open");
      template.innerHTML = shadow.innerHTML;
      absolutizeCommonUrls(template.content);
      absolutizeInlineStyleUrls(template.content);
      disableScriptsAndHandlers(template.content);
      cloneEl.appendChild(template);
      cloneEl.setAttribute("data-yd-shadow-host", "open");
    });
  }

  function isCaptureNoiseUrl(value) {
    const url = String(value || "").trim();
    return (
      /^(?:chrome|moz|safari-web)-extension:\/\//i.test(url) ||
      /(?:translate\.googleapis\.com|translate\.google\.com|www\.gstatic\.com\/_\/translate_http\/)/i.test(url)
    );
  }

  function sanitizeCapturedDocument(clonedRoot) {
    const noiseSelectors = [
      "plasmo-csui",
      "#dreamafar-site-blocker-overlay",
      '[id^="goog-gt-"]',
      ".goog-te-spinner-pos",
      'iframe[name="votingFrame"]',
      '[data-yd-disabled-script^="chrome-extension://"]',
      '[data-yd-disabled-script^="moz-extension://"]',
      '[data-yd-disabled-script^="safari-web-extension://"]',
    ];
    clonedRoot.querySelectorAll(noiseSelectors.join(",")).forEach((el) => el.remove());

    for (const el of clonedRoot.querySelectorAll("[src],[href]")) {
      const resourceUrl = el.getAttribute("src") || el.getAttribute("href") || "";
      if (isCaptureNoiseUrl(resourceUrl)) el.remove();
    }

    for (const template of clonedRoot.querySelectorAll('template[shadowrootmode]')) {
      if (template.content?.querySelector?.("#plasmo-shadow-container")) template.remove();
    }
    for (const host of clonedRoot.querySelectorAll("[data-yd-shadow-host]")) {
      if (!host.querySelector('template[shadowrootmode]')) host.removeAttribute("data-yd-shadow-host");
    }

    for (const wrapper of clonedRoot.querySelectorAll('font[dir="auto"]')) {
      if ((wrapper.getAttribute("style") || "").toLowerCase().includes("vertical-align: inherit")) {
        wrapper.replaceWith(...wrapper.childNodes);
      }
    }

    clonedRoot.classList.remove("translated-ltr", "translated-rtl");
    clonedRoot.querySelectorAll("base").forEach((base) => base.remove());
  }

  function normalizeCapturedDocument(clonedRoot) {
    const normalizedDoc = document.implementation.createHTMLDocument("");
    const normalizedHtml = normalizedDoc.documentElement;
    for (const attr of Array.from(clonedRoot.attributes)) {
      normalizedHtml.setAttribute(attr.name, attr.value);
    }

    const sourceHead = Array.from(clonedRoot.children).find((el) => el.tagName === "HEAD");
    const sourceBody = Array.from(clonedRoot.children).find((el) => el.tagName === "BODY");
    if (sourceHead) {
      const nextHead = normalizedDoc.importNode(sourceHead, true);
      normalizedDoc.head.replaceWith(nextHead);
    }
    if (sourceBody) {
      const nextBody = normalizedDoc.importNode(sourceBody, true);
      normalizedDoc.body.replaceWith(nextBody);
    }
    return normalizedDoc.documentElement;
  }

  function addCaptureMetadata(clonedRoot) {
    let head = clonedRoot.querySelector("head");
    if (!head) return;
    const metaSource = document.createElement("meta");
    metaSource.setAttribute("name", "youdesign-captured-from");
    metaSource.setAttribute("content", location.href);
    const metaTime = document.createElement("meta");
    metaTime.setAttribute("name", "youdesign-captured-at");
    metaTime.setAttribute("content", new Date().toISOString());
    const metaSchema = document.createElement("meta");
    metaSchema.setAttribute("name", "youdesign-capture-schema");
    metaSchema.setAttribute("content", "2");
    head.append(metaSource, metaTime, metaSchema);
  }
}

function deliverToYouDesign(payload) {
  return new Promise((resolve) => {
    if (document.querySelector(".login-input") || /\/login(?:$|[?#/])/.test(location.pathname)) {
      resolve({ ok: false, error: "YouDesign opened the login page. Please log in to YouDesign, then click the extension again." });
      return;
    }

    const requestId = `ydcap-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let attempts = 0;
    const timeout = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      clearInterval(retryTimer);
      resolve({ ok: false, error: "Timed out waiting for YouDesign. Make sure you are logged in." });
    }, 12000);

    function onMessage(event) {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data;
      if (data?.source !== "youdesign-app" || data.type !== "YD_CAPTURE_IMPORT_ACK" || data.requestId !== requestId) return;
      clearTimeout(timeout);
      clearInterval(retryTimer);
      window.removeEventListener("message", onMessage);
      resolve({ ok: Boolean(data.ok) });
    }

    function postImportMessage() {
      attempts += 1;
      window.postMessage({
        source: "youdesign-capture-extension",
        type: "YD_CAPTURE_IMPORT",
        requestId,
        payload,
      }, window.location.origin);
      if (attempts >= 16) clearInterval(retryTimer);
    }

    window.addEventListener("message", onMessage);
    const retryTimer = setInterval(postImportMessage, 700);
    postImportMessage();
  });
}
