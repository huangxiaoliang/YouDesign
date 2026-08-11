const { contextBridge, ipcRenderer } = require("electron");

// 注意:preload 运行在 sandbox:true 的沙箱渲染进程,只能 require electron,
// 不能 require 本地文件或 node:crypto/fs 等。sha256 计算挪到主进程 IPC,
 // 否则 require("./desktop-utils.cjs") 会在加载期抛错、整个 youdesignDesktop 桥失效。

const pendingCaptureImports = [];
const captureImportCallbacks = new Set();

ipcRenderer.on("desktop-capture:import", (_event, payload) => {
  if (captureImportCallbacks.size === 0) {
    pendingCaptureImports.push(payload);
    if (pendingCaptureImports.length > 3) pendingCaptureImports.shift();
    return;
  }
  for (const callback of captureImportCallbacks) callback(payload);
});

contextBridge.exposeInMainWorld("youdesignDesktop", {
  openConfigFolder() {
    return ipcRenderer.invoke("desktop-setup:open-config");
  },
  openAttachment(payload) {
    return ipcRenderer.invoke("desktop-attachment:open", payload);
  },
  getClaudeStatus() {
    return ipcRenderer.invoke("desktop-claude:status");
  },
  sha256Text(value) {
    if (typeof value !== "string") throw new TypeError("SHA-256 输入必须是字符串");
    return ipcRenderer.invoke("desktop:sha256-text", value);
  },
  runClaudeHtmlEdit(payload) {
    return ipcRenderer.invoke("desktop-claude:edit-html", payload);
  },
  cancelClaudeHtmlEdit(jobId) {
    return ipcRenderer.invoke("desktop-claude:cancel-current", jobId);
  },
  openClaudeLog(rawLogPath) {
    return ipcRenderer.invoke("desktop-claude:open-log", rawLogPath);
  },
  onClaudeProgress(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("desktop-claude:progress", listener);
    return () => ipcRenderer.removeListener("desktop-claude:progress", listener);
  },
  onCaptureImport(callback) {
    if (typeof callback !== "function") return () => {};
    captureImportCallbacks.add(callback);
    while (pendingCaptureImports.length > 0) callback(pendingCaptureImports.shift());
    return () => captureImportCallbacks.delete(callback);
  },
  // 导出下载完成通知（主进程 will-download done 后发送保存路径）
  onExportSaved(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, savePath) => callback(savePath);
    ipcRenderer.on("youdesign:export-saved", listener);
    return () => ipcRenderer.removeListener("youdesign:export-saved", listener);
  },
  // 在 Finder 中显示导出文件
  revealExportFile(filePath) {
    return ipcRenderer.invoke("desktop:reveal-path", filePath);
  },
});
