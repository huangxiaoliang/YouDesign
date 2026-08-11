import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundled = await build({
  entryPoints: ["src/lib/directHtmlEditor.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`;
const editor = await import(moduleUrl);

const dom = new JSDOM(`<!doctype html><html><head></head><body>
  <button id="save" class="primary"><span>保存</span></button>
  <input id="search" placeholder="搜索客户">
  <div id="card" style="padding:4px;color:red">卡片</div>
</body></html>`);
Object.assign(globalThis, {
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  HTMLImageElement: dom.window.HTMLImageElement,
});

const document = dom.window.document;
const buttonText = document.querySelector("#save span");
const card = document.querySelector("#card");
const input = document.querySelector("#search");
assert.ok(buttonText instanceof HTMLElement && card instanceof HTMLElement && input instanceof HTMLInputElement);

assert.equal(editor.resolveDirectEditElement(buttonText), buttonText, "单选应命中实际点击的叶子元素");
assert.equal(editor.resolveDirectEditElement(document.body), null, "body 不能作为可编辑目标");
const iframeRealm = new JSDOM(`<!doctype html><button id="inside">iframe 按钮</button>`);
const iframeButton = iframeRealm.window.document.querySelector("#inside");
assert.equal(editor.resolveDirectEditElement(iframeButton), iframeButton, "跨 iframe realm 的元素也必须可以选中");
assert.match(editor.describeDirectEditElement(card), /^<div#card>/, "选中描述应包含稳定 id");
assert.deepEqual(
  editor.getDirectEditElementPath(buttonText).map((element) => element.tagName),
  ["BUTTON", "SPAN"],
  "元素层级应从可编辑根节点排列到当前元素，并排除 body/html"
);
assert.deepEqual(editor.readDirectTextBinding(buttonText), { kind: "text", label: "文案", value: "保存" });
assert.deepEqual(editor.readDirectTextBinding(input), { kind: "placeholder", label: "占位文案", value: "搜索客户" });

const history = new editor.DirectEditHistory();
const baseline = new editor.DirectEditBaselineRegistry();
const firstBefore = editor.captureDirectStyle(card, "color");
card.style.setProperty("color", "blue", "important");
const firstChange = {
  kind: "style",
  element: card,
  property: "color",
  before: firstBefore,
  after: editor.captureDirectStyle(card, "color"),
};
baseline.remember(firstChange);
history.record([firstChange], "style:color");

const secondBefore = editor.captureDirectStyle(card, "color");
card.style.setProperty("color", "green", "important");
history.record(
  [{ kind: "style", element: card, property: "color", before: secondBefore, after: editor.captureDirectStyle(card, "color") }],
  "style:color"
);
assert.equal(card.style.getPropertyValue("color"), "green");
assert.equal(history.undo(), true);
assert.equal(card.style.getPropertyValue("color"), "red", "连续输入同一属性应合并为一次撤销");
assert.equal(card.style.getPropertyPriority("color"), "", "撤销应恢复原始 important 优先级");
assert.equal(history.canUndo, false);
assert.equal(history.redo(), true);
assert.equal(card.style.getPropertyValue("color"), "green");
assert.equal(card.style.getPropertyPriority("color"), "important");

const paddingBefore = editor.captureDirectStyle(card, "padding");
card.style.setProperty("padding", "16px", "important");
const paddingChange = {
  kind: "style",
  element: card,
  property: "padding",
  before: paddingBefore,
  after: editor.captureDirectStyle(card, "padding"),
};
baseline.remember(paddingChange);
history.record([paddingChange], "style:padding");
const resetChanges = baseline.buildResetChanges(card);
assert.equal(resetChanges.length, 2, "重置当前元素应覆盖该元素本次编辑过的全部属性");
for (const change of resetChanges) editor.applyDirectEditChange(change, "after");
history.record(resetChanges);
assert.equal(card.style.getPropertyValue("color"), "red");
assert.equal(card.style.getPropertyValue("padding"), "4px");
assert.equal(history.undo(), true);
assert.equal(card.style.getPropertyValue("color"), "green", "重置本身必须可撤销");
assert.equal(card.style.getPropertyValue("padding"), "16px");

const textHistory = new editor.DirectEditHistory();
const textBefore = editor.captureDirectText(buttonText, "text");
const textChange = {
  kind: "text",
  element: buttonText,
  textKind: "text",
  before: textBefore,
  after: { value: "提交", hadAttribute: true },
};
editor.applyDirectEditChange(textChange, "after");
textHistory.record([textChange], "text:text");
assert.equal(buttonText.textContent, "提交");
textHistory.undo();
assert.equal(buttonText.textContent, "保存", "文案修改必须可撤销");

const clone = document.documentElement.cloneNode(true);
const sessionToken = "yd-test-session";
clone.querySelector("head").insertAdjacentHTML("beforeend", `<style ${editor.DIRECT_EDIT_STYLE_ATTR}="${sessionToken}">x{}</style>`);
clone.querySelector("#card").setAttribute(editor.DIRECT_EDIT_SELECTED_ATTR, sessionToken);
clone.querySelector("#save").setAttribute(editor.DIRECT_EDIT_SELECTED_ATTR, "business-marker");
clone.querySelector("head").insertAdjacentHTML("beforeend", `<style id="__yd_direct_edit_style">business{}</style>`);
editor.stripDirectEditArtifacts(clone, sessionToken);
assert.equal(clone.querySelector(`[${editor.DIRECT_EDIT_STYLE_ATTR}="${sessionToken}"]`), null, "编辑器样式不能进入保存结果");
assert.equal(clone.querySelector(`[${editor.DIRECT_EDIT_SELECTED_ATTR}="${sessionToken}"]`), null, "本会话选中标记不能进入保存结果");
assert.equal(clone.querySelector("#save").getAttribute(editor.DIRECT_EDIT_SELECTED_ATTR), "business-marker", "不得清理业务页面的同名属性");
assert.notEqual(clone.querySelector("#__yd_direct_edit_style"), null, "清理编辑器节点不得误删业务页面的同名 id");

assert.equal(editor.normalizeDirectStyleInput("font-size", "16"), "16px");
assert.equal(editor.normalizeDirectStyleInput("line-height", "1.8"), "1.8", "无单位行高必须保留为倍数");
assert.equal(editor.normalizeDirectStyleInput("padding", "10 12"), "10px 12px", "多值间距应逐项补 px");
assert.equal(editor.normalizeDirectStyleInput("margin", "0 auto 8"), "0 auto 8px");
assert.equal(editor.normalizeDirectStyleInput("border-radius", "8 / 4"), "8px / 4px");
assert.equal(editor.normalizeDirectStyleInput("opacity", "0.6"), "0.6");
assert.deepEqual(
  editor.validateDirectStyleInput("padding", "10 12", (_property, value) => value === "10px 12px"),
  { valid: true, value: "10px 12px" },
  "合法值应在归一化后通过校验"
);
assert.equal(
  editor.validateDirectStyleInput("padding", "10 nope", () => false).valid,
  false,
  "无效 CSS 值必须被保存门禁识别"
);
assert.equal(editor.cssColorToHex("rgb(22, 119, 255)"), "#1677ff");

console.log("direct HTML editor regression: ok");
