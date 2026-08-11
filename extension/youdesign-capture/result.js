const params = new URLSearchParams(location.search);
const ok = params.get("ok") === "1";
const stage = params.get("stage") || "delivery";
const message = params.get("message") || "Unknown error.";

document.getElementById("title").textContent = ok ? "导入完成" : "导入失败";
document.getElementById("message").textContent = message;
document.getElementById("hint").textContent = stage === "capture"
  ? "请确认当前标签是以 http:// 或 https:// 开头的业务页面。更新扩展后请在 chrome://extensions 中点击一次“重新加载”。"
  : "请确认 YouDesign 客户端正在运行、YouDesign 已登录，并且扩展设置里的地址正确。";
document.getElementById("close").addEventListener("click", () => {
  window.close();
});
