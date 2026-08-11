#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const overlaySource = readFileSync(new URL("../extension/youdesign-capture/capture_overlay.js", import.meta.url), "utf8");
const popupSource = readFileSync(new URL("../extension/youdesign-capture/popup.html", import.meta.url), "utf8");
const workerSource = readFileSync(new URL("../extension/youdesign-capture/service_worker.js", import.meta.url), "utf8");
assert.match(popupSource, />多页签采集<\//, "插件入口必须显示“多页签采集”");
const defaultTab = { key: "group:tax", label: "票账税", groupId: "group", defaultCaptured: true };
const pendingTab = { key: "group:service", label: "微企服", groupId: "group", defaultCaptured: false };
let phase = "select";

const sessionBuilderMatch = workerSource.match(/function buildGuidedCaptureSession\(tab, catalog, selectedKeys, baselineSnapshots, baseline\) \{[\s\S]*?\n\}/);
assert(sessionBuilderMatch, "必须能取得选择采集会话构建器");
const buildGuidedCaptureSession = new Function(`${sessionBuilderMatch[0]}; return buildGuidedCaptureSession;`)();
const builtSession = buildGuidedCaptureSession(
  { id: 7, url: "https://example.test/business" },
  { groups: [{ id: "group", tabs: [defaultTab, pendingTab] }], tabs: [defaultTab, pendingTab] },
  new Set(["group:service"]),
  [{ key: "group:tax", panelHtml: "<div>票账税</div>" }],
  { html: "<html></html>" }
);
assert.equal(builtSession.tabs[0].defaultCaptured, true, "开始采集后必须保留票账税的默认采集身份");
assert.equal(builtSession.tabs[0].status, "captured", "默认页签开始后必须保持已采集状态");
assert.equal(builtSession.tabs[1].status, "pending", "只有用户选择的未打开页签才能进入待采集状态");

const dom = new JSDOM("<!doctype html><html><body><main>业务页面</main></body></html>", {
  runScripts: "outside-only",
  url: "https://example.test/business",
});
dom.window.chrome = {
  runtime: {
    sendMessage: async (message) => {
      if (message.action === "guided-status" && phase === "select") return { ok: false, error: "没有进行中的采集" };
      if (message.action === "inspect-tabs") {
        return { ok: true, catalog: { groups: [{ id: "group", tabs: [defaultTab, pendingTab] }], tabs: [defaultTab, pendingTab] } };
      }
      if (message.action === "start-guided") {
        assert.equal(Array.from(message.selectedKeys || []).join(","), "group:service", "开始采集只能提交待采集页签，默认页签不应再次进入选择范围");
        phase = "progress";
        return {
          ok: true,
          session: {
            tabs: [
              { ...defaultTab, selected: true, status: "captured" },
              { ...pendingTab, selected: true, status: "pending" },
            ],
            capturedCount: 0,
            selectedCount: 1,
            defaultCapturedCount: 1,
          },
        };
      }
      if (message.action === "capture-guided-tab") {
        return {
          ok: true,
          session: {
            tabs: [
              { ...defaultTab, selected: true, status: "captured" },
              { ...pendingTab, selected: true, status: "captured" },
            ],
            capturedCount: 1,
            selectedCount: 1,
            defaultCapturedCount: 1,
          },
        };
      }
      if (message.action === "cancel-guided") return { ok: true };
      return { ok: false, error: `unexpected action: ${message.action}` };
    },
  },
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
dom.window.eval(overlaySource);
await flush();
await flush();

const host = dom.window.document.getElementById("__yd_capture_overlay");
assert(host, "选择采集必须渲染为业务页面内悬浮层");
assert.equal(host.getAttribute("data-yd-capture-extension-ui"), "true", "悬浮层必须带可剥除标记");
const shadow = host.shadowRoot;
assert(shadow, "悬浮层必须使用 Shadow DOM 隔离业务样式");
assert.doesNotMatch(shadow.querySelector(".list").textContent, /票账税/, "默认打开的票账税不得出现在待采集列表");
assert.match(shadow.querySelector(".list").textContent, /微企服.*待采集/, "未打开页签应以待采集状态展示");

shadow.querySelector(".start").click();
await flush();
assert.doesNotMatch(shadow.querySelector(".list").textContent, /票账税/, "开始采集后默认页签不得重新出现在待采集列表");
assert.match(shadow.querySelector(".note").textContent, /默认已采集 1 个/, "默认页签应保持已采集计数");
assert.equal(shadow.querySelector(".finish").textContent, "合并发送", "合并按钮必须显示“合并发送”");
assert.equal(shadow.querySelector(".status").textContent, "已采集 0/1", "采集进度文案必须保持已采集数量格式");
assert.match(shadow.querySelector(".status").className, /success/, "已采集数量必须使用绿色成功状态");

shadow.querySelector(".capture").click();
await flush();
assert.match(shadow.querySelector(".list .state").className, /captured/, "采集后的页签必须切换为绿色已采集状态");
assert.equal(shadow.querySelector(".status").textContent, "已采集 1/1", "采集后必须更新绿色已采集数量");

dom.window.eval(overlaySource);
await flush();
assert.equal(dom.window.document.querySelectorAll("#__yd_capture_overlay").length, 1, "重复点击插件不得创建多个悬浮层");

shadow.querySelector(".cancel").click();
await flush();
assert.equal(dom.window.document.getElementById("__yd_capture_overlay"), null, "取消后必须移除悬浮层");

dom.window.close();
console.log("capture overlay regression: ok");
