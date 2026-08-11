const DEFAULT_YOUDESIGN_URL = "http://localhost:3000/youdesign";

const input = document.getElementById("url");
const save = document.getElementById("save");
const status = document.getElementById("status");

chrome.storage.sync.get({ youdesignUrl: DEFAULT_YOUDESIGN_URL }, (data) => {
  input.value = data.youdesignUrl || DEFAULT_YOUDESIGN_URL;
});

save.addEventListener("click", () => {
  const value = normalizeUrl(input.value);
  input.value = value;
  chrome.storage.sync.set({ youdesignUrl: value }, () => {
    status.textContent = "已保存";
    setTimeout(() => {
      status.textContent = "";
    }, 1600);
  });
});

function normalizeUrl(raw) {
  const value = String(raw || "").trim() || DEFAULT_YOUDESIGN_URL;
  return value.replace(/\/+$/, "");
}
