const status = document.getElementById("status");
let activeTabId = null;

function setStatus(message, error = false, warning = false) {
  status.textContent = message || "";
  status.style.color = error ? "#cf1322" : warning ? "#d97706" : "#6b7280";
}

async function call(action) {
  const response = await chrome.runtime.sendMessage({
    source: "youdesign-capture-popup",
    action,
    tabId: activeTabId,
  });
  if (!response?.ok) throw new Error(response?.error || "操作失败");
  return response;
}

document.getElementById("capture-current").addEventListener("click", async () => {
  try {
    setStatus("正在抓取…");
    const response = await call("capture-current");
    const unmapped = Number(response.drawerMapping?.unmapped || 0);
    const frameCaptured = Number(response.frameCapture?.captured || 0);
    const frameTotal = Number(response.frameCapture?.total || 0);
    const frameReason = Array.isArray(response.frameCapture?.reasons) ? response.frameCapture.reasons.filter(Boolean).join("；") : "";
    if (frameTotal > frameCaptured) setStatus(`v${response.extensionVersion || "?"} 已发送；内嵌页 ${frameCaptured}/${frameTotal}${frameReason ? `（${frameReason}）` : ""}`, false, true);
    else if (unmapped > 0) setStatus(`v${response.extensionVersion || "?"} 已发送；${unmapped} 个抽屉未记录入口，只支持关闭`, false, true);
    else setStatus(`v${response.extensionVersion || "?"} 已发送到 YouDesign；内嵌页 ${frameCaptured}/${frameTotal}`);
  } catch (error) {
    setStatus(error.message, true);
  }
});

document.getElementById("inspect-tabs").addEventListener("click", async () => {
  try {
    await call("show-guided-overlay");
    window.close();
  } catch (error) {
    setStatus(error.message, true);
  }
});

(async () => {
  document.getElementById("extension-version").textContent = `v${chrome.runtime.getManifest().version}`;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  if (!activeTabId) setStatus("未找到当前业务页面", true);
})();
