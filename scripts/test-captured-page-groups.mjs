#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { buildSync } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";

const require = createRequire(import.meta.url);
const sourcePath = new URL("../src/lib/capturedPage.ts", import.meta.url).pathname;
const bundled = buildSync({ entryPoints: [sourcePath], bundle: true, platform: "node", format: "cjs", write: false, target: "node20" }).outputFiles[0].text;
const compiled = { exports: {} };
new Function("require", "module", "exports", bundled)(require, compiled, compiled.exports);
const { buildCapturedPagePreview } = compiled.exports;
const parserDom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.DOMParser = parserDom.window.DOMParser;

const baseline = `<!doctype html><html><head><title>嵌套页签回归</title></head><body>
<section class="dpl-tabs" id="outer">
  <div role="tablist"><div data-yd-capture-guided-tab-key="outer:overview" data-yd-capture-tab="yd-tab-1" data-yd-capture-tab-group="yd-tab-group-1">客户概况</div><div data-yd-capture-guided-tab-key="outer:care" data-yd-capture-tab="yd-tab-2" data-yd-capture-tab-group="yd-tab-group-1">关怀(3)</div></div>
  <div class="dpl-tabs-content dpl-tabs-content-animated" style="margin-left:-100%;transform:translateX(-100%)" data-yd-capture-guided-tab-panel-host="outer">
    <div data-yd-capture-guided-tab-source-panel="outer:overview"><strong>概况基线</strong><section class="dpl-tabs" id="inner"><div role="tablist"><div data-yd-capture-guided-tab-key="inner:tax">票账税</div><div data-yd-capture-guided-tab-key="inner:module">模块管理</div></div><div class="dpl-tabs-content" data-yd-capture-guided-tab-panel-host="inner"><div data-yd-capture-guided-tab-source-panel="inner:tax">票账税基线</div><div data-yd-capture-guided-tab-source-panel="inner:module">模块管理基线</div></div></section></div>
  </div>
</section>
</body></html>`;

const meta = {
  schemaVersion: 2,
  guidedTabs: {
    groups: [
      { id: "outer", tabs: [{ key: "outer:overview", label: "客户概况", selected: true, status: "captured" }, { key: "outer:care", label: "关怀(3)", selected: true, status: "captured" }] },
      { id: "inner", tabs: [{ key: "inner:tax", label: "票账税", selected: true, status: "captured" }, { key: "inner:module", label: "模块管理", selected: true, status: "captured" }] },
    ],
    snapshots: [
      { key: "outer:overview", panelHtml: '<div><strong>概况新快照</strong><section>不应覆盖内层宿主</section></div>', capturedAt: "2026-07-30T00:00:00.000Z" },
      { key: "outer:care", panelHtml: "<div>关怀记录快照</div>", capturedAt: "2026-07-30T00:00:00.000Z" },
      { key: "inner:tax", panelHtml: "<div>票账税快照</div>", capturedAt: "2026-07-30T00:00:00.000Z" },
      { key: "inner:module", panelHtml: "<div>模块管理快照</div>", capturedAt: "2026-07-30T00:00:00.000Z" },
    ],
  },
};

const rendered = buildCapturedPagePreview(baseline, meta);
const dom = new JSDOM(rendered, { runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
const doc = dom.window.document;
assert.equal(doc.querySelectorAll('[data-yd-capture-tab][data-yd-capture-tab-group="outer"]').length, 2, "外层 Tab 必须独立重建");
assert.equal(doc.querySelectorAll('[data-yd-capture-tab][data-yd-capture-tab-group="inner"]').length, 2, "内层 Tab 必须保留独立宿主并重建");
assert.match(doc.querySelector('[data-yd-capture-tab-panel="outer:care"]')?.textContent || "", /关怀记录快照/, "关怀必须绑定关怀快照，不能串入票账税数据");
assert.match(doc.querySelector('[data-yd-capture-tab-panel="inner:module"]')?.textContent || "", /模块管理快照/, "模块管理必须绑定自己的内层快照");
assert.doesNotMatch(doc.querySelector('[data-yd-capture-tab-panel="outer:care"]')?.textContent || "", /票账税/, "外层关怀不得包含票账税快照");
assert.equal(doc.querySelector('[data-yd-capture-tab="yd-tab-1"]'), null, "选择性采集必须清除同一触发器遗留的通用静态 Tab 标记");
const rebuiltOuterHost = doc.querySelector('[data-yd-capture-guided-tab-panel-host="outer"]');
assert.equal(rebuiltOuterHost?.style.marginLeft, "0px", "重建后必须清除 DPL 内容轨道遗留的负 margin 位移");
assert.equal(rebuiltOuterHost?.style.transform, "none", "重建后必须清除内容轨道遗留的 transform 位移");

const careOnlyMeta = {
  schemaVersion: 2,
  guidedTabs: {
    groups: [{ id: "outer", tabs: [{ key: "outer:overview", label: "客户概况", selected: false, status: "not-selected" }, { key: "outer:care", label: "关怀(3)", selected: true, status: "captured" }] }],
    snapshots: [{ key: "outer:care", panelHtml: "<div>仅关怀记录</div>", capturedAt: "2026-07-30T00:00:00.000Z" }],
  },
};
const careOnlyRendered = buildCapturedPagePreview(baseline, careOnlyMeta);
const careOnlyDoc = new JSDOM(careOnlyRendered).window.document;
const careOnlyHost = careOnlyDoc.querySelector('[data-yd-capture-guided-tab-panel-host="outer"]');
assert.equal(careOnlyHost?.style.marginLeft, "0px", "只采集原第二个 Tab 时内容轨道也必须回到首屏");
assert.match(careOnlyDoc.querySelector('[data-yd-capture-tab-panel="outer:care"]')?.textContent || "", /仅关怀记录/, "只采集关怀时必须保留关怀内容");

const careTrigger = doc.querySelector('[data-yd-capture-tab="outer:care"]');
careTrigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
assert.equal(doc.querySelector('[data-yd-capture-tab-panel="outer:care"]')?.getAttribute("data-yd-capture-tab-panel-state"), "open", "外层关怀点击后必须打开自己的面板");

const moduleTrigger = doc.querySelector('[data-yd-capture-tab="inner:module"]');
moduleTrigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
assert.equal(doc.querySelector('[data-yd-capture-tab-panel="inner:module"]')?.getAttribute("data-yd-capture-tab-panel-state"), "open", "内层模块管理点击后必须打开自己的面板");

const attachmentUtils = require("../desktop/attachment-utils.cjs");
const attachment = attachmentUtils.htmlWithAttachmentCsp(rendered);
assert.equal((attachment.match(/id="__yd_capture_interaction_runtime"/g) || []).length, 1, "附件只能保留一份受控交互运行时");

dom.window.close();
parserDom.window.close();
console.log("captured page grouped-tab regression: ok");
