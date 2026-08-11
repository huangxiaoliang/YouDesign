#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../extension/youdesign-capture/service_worker.js", import.meta.url), "utf8");
const homeSource = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
const homeStyles = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

assert.doesNotMatch(source, /ensureBaseHref/, "抓取结果不应再注入 base href");
assert.match(source, /sanitizeCapturedDocument\(cloned\)/, "序列化前必须清理浏览器扩展残留");
assert.match(source, /normalizeCapturedDocument\(cloned\)/, "序列化前必须规范化 html\/head\/body 骨架");
assert.match(source, /querySelectorAll\("base"\)/, "净化阶段必须移除已有 base 标签");
assert.match(source, /"plasmo-csui"/, "必须清理 Plasmo 注入节点");
assert.match(source, /dreamafar-site-blocker-overlay/, "必须清理已知的全屏遮罩残留");
assert.match(source, /\[id\^=\\?"goog-gt-/, "必须清理 Google 翻译注入节点");
assert.match(source, /classList\.remove\("translated-ltr", "translated-rtl"\)/, "必须移除 Google 翻译根节点状态类");
assert.match(source, /document\.implementation\.createHTMLDocument\(""\)/, "必须重建标准文档骨架");
assert.match(source, /styleHrefs:[\s\S]*?filter\(\(href\) => !isCaptureNoiseUrl\(href\)\)/, "远程样式列表必须过滤扩展与翻译资源");
assert.match(source, /func: captureRenderedPageBasic/, "富抓取无返回值时必须回退基础 DOM 抓取");
assert.match(source, /captureMode: "basic-fallback"/, "基础抓取结果必须携带降级诊断标记");
assert.match(source, /\^https\?:\\\/\\\//, "注入前必须拒绝 Chrome 内部页与扩展页");
assert.match(source, /stage: failureStage/, "错误页必须区分抓取阶段和投递阶段");
assert.equal(
  source.match(/attr\.replaceAll\(":", "\\\\:"\)/g)?.length,
  2,
  "富抓取与基础抓取的 xlink:href 选择器都必须转义冒号"
);
assert.match(
  homeSource,
  /setCaptureImportNotice\(\{ text: "页面已添加到对话框，请开始修改" \}\)/,
  "Chrome 页面成功加入对话框后必须提示用户开始修改"
);
assert.match(homeSource, /CAPTURE_IMPORT_NOTICE_MS = 4_000/, "导入成功浮层应在 3-5 秒范围内自动消失");
assert.match(homeSource, /setTimeout\(\(\) => setCaptureImportNotice\(null\), CAPTURE_IMPORT_NOTICE_MS\)/, "导入成功浮层必须自动关闭");
assert.match(homeSource, /className="capture-import-notice" role="status"/, "导入成功提示必须使用独立浮层而非对话消息");
assert.match(homeSource, /aria-label="关闭提示"/, "导入成功浮层必须提供手动关闭按钮");
assert.match(homeStyles, /\.capture-import-notice \{[\s\S]*?position: absolute;/, "导入提示必须浮动显示在附件区上方");
assert.doesNotMatch(homeSource, /className="msg assistant capture-import-notice"/, "导入提示不得重新放入对话消息列表");

console.log("capture sanitization regression: ok");
