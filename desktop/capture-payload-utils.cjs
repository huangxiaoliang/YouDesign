// 抓取扩展导入 payload 的纯净化逻辑。从 desktop/main.cjs 抽出以便单元回归：
// main.cjs 是 Electron 主入口（无 require.main 守卫），直接 require 会拉起 app。
const CAPTURE_IMPORT_MAX_BYTES = 6 * 1024 * 1024;

function normalizeGuidedTabCapture(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const normalizeTab = (tab) => ({
    key: typeof tab?.key === "string" ? tab.key.slice(0, 160) : "",
    label: typeof tab?.label === "string" ? tab.label.slice(0, 160) : "",
    selected: Boolean(tab?.selected),
    status: ["captured", "not-selected", "failed"].includes(tab?.status) ? tab.status : "failed",
    reason: typeof tab?.reason === "string" ? tab.reason.slice(0, 160) : undefined,
  });
  const normalizeSnapshot = (snapshot) => ({
    key: typeof snapshot?.key === "string" ? snapshot.key.slice(0, 160) : "",
    panelHtml: typeof snapshot?.panelHtml === "string" && Buffer.byteLength(snapshot.panelHtml, "utf8") <= 768 * 1024 ? snapshot.panelHtml : "",
    capturedAt: typeof snapshot?.capturedAt === "string" ? snapshot.capturedAt.slice(0, 80) : "",
  });
  const rawGroups = Array.isArray(raw.groups)
    ? raw.groups.slice(0, 8).map((group) => ({
        id: typeof group?.id === "string" ? group.id.slice(0, 120) : "",
        tabs: Array.isArray(group?.tabs) ? group.tabs.slice(0, 16).map(normalizeTab).filter((tab) => tab.key) : [],
      })).filter((group) => group.id && group.tabs.length)
    : [];
  // 兼容 0.1.8 及之前落盘的单组抓取元数据。
  const groups = rawGroups.length
    ? rawGroups
    : typeof raw.groupId === "string" && Array.isArray(raw.tabs)
      ? [{ id: raw.groupId.slice(0, 120), tabs: raw.tabs.slice(0, 16).map(normalizeTab).filter((tab) => tab.key) }]
      : [];
  const snapshots = Array.isArray(raw.snapshots) ? raw.snapshots.slice(0, 32).map(normalizeSnapshot).filter((snapshot) => snapshot.key && snapshot.panelHtml) : [];
  return groups.length || snapshots.length ? { groups, snapshots } : undefined;
}

function normalizeCapturePayload(raw) {
  const payload = raw && typeof raw === "object" ? raw : {};
  const html = typeof payload.html === "string" ? payload.html : "";
  if (!html.trim()) throw new Error("导入内容缺少 HTML");
  if (Buffer.byteLength(html, "utf8") > CAPTURE_IMPORT_MAX_BYTES) {
    throw new Error(`HTML 超过客户端导入上限 ${Math.round(CAPTURE_IMPORT_MAX_BYTES / 1024 / 1024)}MB`);
  }
  const captureMeta = payload.captureMeta && typeof payload.captureMeta === "object" && payload.captureMeta.schemaVersion === 2
    ? {
        schemaVersion: 2,
        interactions: payload.captureMeta.interactions && typeof payload.captureMeta.interactions === "object" ? payload.captureMeta.interactions : undefined,
        frames: Array.isArray(payload.captureMeta.frames)
          ? payload.captureMeta.frames.slice(0, 12).map((frame) => ({
              frameId: Number.isInteger(frame?.frameId) ? frame.frameId : -1,
              parentFrameId: Number.isInteger(frame?.parentFrameId) ? frame.parentFrameId : 0,
              url: typeof frame?.url === "string" ? frame.url : "",
              // 转发 iframe 声明地址与 window.name：扩展 v0.2.9 的 captureChildFrames
              // 产出这两个字段，重建端（capturedPage.ts）按 sourceUrl/frameName 匹配
              // 重定向后的子文档。漏转发会让重建端退化成只比对最终 url，多 iframe 或
              // 重定向场景匹配失败、回退“未能静态化”占位。
              sourceUrl: typeof frame?.sourceUrl === "string" ? frame.sourceUrl.slice(0, 2048) : undefined,
              frameName: typeof frame?.frameName === "string" ? frame.frameName.slice(0, 256) : undefined,
              status: ["captured", "unavailable", "omitted"].includes(frame?.status) ? frame.status : "unavailable",
              reason: typeof frame?.reason === "string" ? frame.reason.slice(0, 160) : undefined,
              // 扩展 v0.2.9 已取消业务 iframe 的固定 1MB 单帧上限（DPL/CRM 子应用
              // 静态化后常带 1~3MB 内联样式），改按 5MB 抓取总预算决定是否保留。
              // 导入端不得再以 1MB 剥 frame html，否则扩展如实抓到的 CRM 子应用会
              // 在导入边界丢 html、渲染端看到“已捕获但无内容”回退占位。整份 payload
              // 已由 readRequestBody 按 CAPTURE_IMPORT_MAX_BYTES 限流，单帧不再另设小闸。
              html: typeof frame?.html === "string" && Buffer.byteLength(frame.html, "utf8") <= CAPTURE_IMPORT_MAX_BYTES ? frame.html : undefined,
            }))
          : [],
        resources: payload.captureMeta.resources && typeof payload.captureMeta.resources === "object" ? payload.captureMeta.resources : undefined,
        guidedTabs: normalizeGuidedTabCapture(payload.captureMeta.guidedTabs),
      }
    : undefined;
  return {
    html,
    title: typeof payload.title === "string" ? payload.title : "",
    url: typeof payload.url === "string" ? payload.url : "",
    capturedAt: typeof payload.capturedAt === "string" ? payload.capturedAt : new Date().toISOString(),
    remoteCss: payload.remoteCss && typeof payload.remoteCss === "object" ? payload.remoteCss : undefined,
    captureMeta,
  };
}

module.exports = {
  CAPTURE_IMPORT_MAX_BYTES,
  normalizeCapturePayload,
  normalizeGuidedTabCapture,
};
