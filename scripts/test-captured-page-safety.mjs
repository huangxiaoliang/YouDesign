#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { htmlWithAttachmentCsp } = require("../desktop/attachment-utils.cjs");
const { CAPTURE_RUNTIME_SOURCE } = require("../desktop/captured-page-runtime.cjs");
const { normalizeCapturePayload, CAPTURE_IMPORT_MAX_BYTES } = require("../desktop/capture-payload-utils.cjs");
const previewPane = readFileSync(new URL("../src/components/PreviewPane.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
const captureWorker = readFileSync(new URL("../extension/youdesign-capture/service_worker.js", import.meta.url), "utf8");
const captureManifest = readFileSync(new URL("../extension/youdesign-capture/manifest.json", import.meta.url), "utf8");
const capturePopup = readFileSync(new URL("../extension/youdesign-capture/popup.js", import.meta.url), "utf8");
const captureOverlay = readFileSync(new URL("../extension/youdesign-capture/capture_overlay.js", import.meta.url), "utf8");
const urlsEquivalentSource = captureWorker.match(/function urlsEquivalent\(left, right\) \{[\s\S]*?\n\}/)?.[0];
const resolveFrameRefSource = captureWorker.match(/function resolveFrameRef\(parentRefs, frame, siblingFrames\) \{[\s\S]*?\n\}/)?.[0];
assert(urlsEquivalentSource && resolveFrameRefSource, "必须能提取 iframe 映射纯函数进行行为回归");
const resolveFrameRef = new Function(`${urlsEquivalentSource}\n${resolveFrameRefSource}\nreturn resolveFrameRef;`)();
const declaredFrameRef = { ref: "frame-1", sourceUrl: "https://shell.example.test/declared" };
assert.equal(resolveFrameRef([declaredFrameRef], { url: "https://redirected.example.test/final" }, [{ frameId: 7 }]).ref, declaredFrameRef, "单 DOM iframe 与单直接子 frame 在重定向后必须确定性配对");
assert.equal(resolveFrameRef([declaredFrameRef], { url: "https://redirected.example.test/final" }, [{ frameId: 7 }, { frameId: 8 }]).ref, null, "存在多个直接子 frame 时不得按顺序猜测重定向映射");
const namedFrameRef = { ref: "frame-board", sourceUrl: "https://shell.example.test/declared-board", name: "board_page" };
const hiddenFrameRef = { ref: "frame-hidden", sourceUrl: "https://shell.example.test/hidden", name: "hidden_helper" };
assert.equal(resolveFrameRef([namedFrameRef, hiddenFrameRef], { url: "https://redirected.example.test/final", name: "board_page" }, [{ frameId: 7 }, { frameId: 8 }]).ref, namedFrameRef, "多个直接子 frame 时必须通过唯一 window.name 映射主业务 iframe");
assert.equal(resolveFrameRef([{ ...namedFrameRef, sourceUrl: "https://same.example.test/" }, { ...hiddenFrameRef, sourceUrl: "https://same.example.test/" }], { url: "https://same.example.test/", name: "board_page" }, [{ frameId: 7 }, { frameId: 8 }]).ref?.ref, namedFrameRef.ref, "多个同 URL 子 frame 也必须由唯一 window.name 消歧");

const unsafe = `<!doctype html><html><head><script>window.__sourceExecuted = true</script><link rel="stylesheet" href="https://example.test/site.css"></head><body onload="window.__eventExecuted = true"><iframe src="https://business.example.test/app/"></iframe><div data-yd-capture-drawer="yd-drawer-1" data-yd-capture-drawer-state="open"><button data-yd-capture-drawer-close="yd-drawer-1">关闭</button></div></body></html>`;
const safe = htmlWithAttachmentCsp(unsafe);
const safeFrame = htmlWithAttachmentCsp(
  '<!doctype html><html><head></head><body><iframe data-yd-captured-frame="7" sandbox="allow-scripts" srcdoc="&lt;!doctype html&gt;&lt;html&gt;&lt;body&gt;静态子页&lt;/body&gt;&lt;/html&gt;"></iframe></body></html>',
  { allowCapturedFrames: true }
);
// 移动端窄框导出（applyMobileNarrowFrame）产物：纯 srcdoc、无 captured 标记、无 src。
const safeSrcdocOnly = htmlWithAttachmentCsp(
  '<!doctype html><html><body><iframe class="yd-phone-frame" srcdoc="&lt;!doctype html&gt;&lt;html&gt;&lt;body&gt;移动端预览&lt;/body&gt;&lt;/html&gt;"></iframe></body></html>'
);
const safeNestedCapturedSrcdoc = htmlWithAttachmentCsp(
  '<!doctype html><html><body><iframe class="yd-phone-frame" srcdoc="&lt;!doctype html&gt;&lt;html&gt;&lt;head&gt;&lt;meta name=&quot;youdesign-capture-schema&quot; content=&quot;2&quot;&gt;&lt;meta name=&quot;youdesign-captured-from&quot; content=&quot;https://example.test/&quot;&gt;&lt;/head&gt;&lt;body&gt;&lt;div data-yd-capture-drawer=&quot;drawer-1&quot;&gt;离线手机内容&lt;/div&gt;&lt;/body&gt;&lt;/html&gt;"></iframe></body></html>'
);
const safeImage = htmlWithAttachmentCsp('<!doctype html><html><body><img class="avatar" src="https://example.test/avatar.png" alt="负责人头像"></body></html>');
const safeTabs = htmlWithAttachmentCsp('<!doctype html><html><body><button data-yd-capture-tab="yd-tab-1" data-yd-capture-tab-group="yd-tab-group-1">票账税</button><section data-yd-capture-tab-panel="yd-tab-1" data-yd-capture-tab-group="yd-tab-group-1">静态数据</section></body></html>');

assert.doesNotMatch(safe, /<iframe\b/i, "桌面附件不得保留会重新联网的 iframe");
assert.doesNotMatch(safe, /https:\/\/example\.test\/site\.css/i, "桌面附件不得保留远程样式表");
assert.doesNotMatch(safe, /onload=/i, "桌面附件不得保留来源事件属性");
assert.match(safe, /<script type="text\/plain"[^>]*>window\.__sourceExecuted/, "来源脚本必须失活");
assert.match(safe, /script-src 'sha256-[^']+'/i, "有受控交互时 CSP 只能白名单精确脚本 hash");
assert.doesNotMatch(safe, /script-src[^>]*unsafe-inline/i, "CSP 不得以 unsafe-inline 放开来源脚本");
assert.match(safe, new RegExp(CAPTURE_RUNTIME_SOURCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 120)), "桌面附件必须注入自有抽屉运行时");
assert.match(safe, /frame-src 'none'/i, "桌面附件必须禁止再加载 frame");
assert.match(safeFrame, /data-yd-captured-frame="7"/, "桌面端应保留所有纯 srcdoc iframe（含 V2 构建器与移动端窄框导出）");
assert.doesNotMatch(safeFrame, /<iframe[^>]*\ssrc=/i, "允许的静态 frame 也不得具有联网 src");
assert.match(safeSrcdocOnly, /class="yd-phone-frame"/, "纯 srcdoc（无 captured 标记、无 src）iframe 内容已离线，应予保留");
assert.doesNotMatch(safeSrcdocOnly, /内嵌区域未捕获/, "纯 srcdoc iframe 不得被误判为未捕获");
assert.doesNotMatch(safeSrcdocOnly, /<iframe[^>]*\ssrc=/i, "保留的 srcdoc iframe 不得带联网 src");
assert.match(safeNestedCapturedSrcdoc, /class="yd-phone-frame"/, "srcdoc 内含历史抓取标记时桌面附件仍必须保留离线手机框");
assert.doesNotMatch(safeNestedCapturedSrcdoc, /内嵌区域未捕获/, "srcdoc 属性内的抓取标记不得触发联网 iframe 占位");
// 回归：srcdoc 值里含被捕获子页的 <img src=...>（转义成 &lt;img src=&quot;...&quot;&gt;），
// 旧实现用整段 iframe HTML 做 \ssrc= 子串匹配，会误判为 live src 而删掉这个安全的纯 srcdoc iframe。
const safeSrcdocWithImgSrcInside = htmlWithAttachmentCsp(
  '<!doctype html><html><body><iframe data-yd-captured-frame="7" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="&lt;!doctype html&gt;&lt;html&gt;&lt;body&gt;&lt;img src=&quot;data:image/png;base64,iVBORw0KGgo=&quot;&gt;子页&lt;/body&gt;&lt;/html&gt;"></iframe></body></html>'
);
assert.match(safeSrcdocWithImgSrcInside, /data-yd-captured-frame="7"/, "srcdoc 值内的 <img src=> 不得被误判为 iframe 自身的 live src 而删除该纯 srcdoc iframe");
assert.doesNotMatch(safeSrcdocWithImgSrcInside, /内嵌区域未捕获/, "srcdoc 值内的 src= 不得触发联网 iframe 占位");
assert.doesNotMatch(safeSrcdocWithImgSrcInside, /<iframe\b[^>]*\ssrc\s*=\s*"/i, "保留的纯 srcdoc iframe 不得带裸引号的联网 src（srcdoc 值内的转义 src=&quot; 不计）");
assert.doesNotMatch(safeImage, /src="https:\/\/example\.test\/avatar\.png"/i, "桌面附件不得留下远程图片 src");
assert.match(safeImage, /data-yd-capture-resource-omitted="image"/i, "远程图片下载失败时必须转为稳定占位");
assert.match(safeImage, /alt=""/i, "图片占位不得展示原 alt 文字并挤压头像布局");
assert.match(safeTabs, /script-src 'sha256-[^']+'/i, "有受控静态 Tab 时桌面附件必须只白名单自有运行时");
assert.match(safeTabs, /__yd_capture_interaction_runtime/, "桌面附件必须为静态 Tab 注入受控运行时");
assert.match(previewPane, /buildCapturedPagePreview\(preview\?\.html \?\? "", result\?\.captureMeta\)/, "Web 预览必须先构建离线抓取页再注入导航守卫");
assert.match(previewPane, /buildExportHtml[\s\S]*?buildCapturedPagePreview\(html, result\?\.captureMeta\)/, "导出 HTML 必须对抓取页跑 buildCapturedPagePreview 重建，否则导出的 raw 抓取页 iframe 为空、外链 CSS 丢失、脚本失活，离线打开空白");
assert.match(previewPane, /guardPreviewNavigation\(html\)[\s\S]{0,200}?applyMobileNarrowFrame[\s\S]{0,200}?injectHistoryBridge/, "导出移动窄框必须按 guard→窄框→bridge 顺序接线，把浏览器后退接到 iframe 内 guard 的 __ydGoBack；否则导出/分享链接下钻后无法返回上级页面");
assert.match(pageSource, /buildCapturedPageAttachment\(att\.previewContent/, "Web 打开 HTML 附件必须使用离线抓取产物");
assert.match(captureWorker, /allFrames:\s*true/, "插件必须尝试采集同源子 frame 的静态快照");
assert.match(captureWorker, /chrome\.webNavigation\.getAllFrames/, "插件必须读取 frame 父子关系，禁止按 URL 猜测层级");
assert.match(captureWorker, /function resolveFrameRef\(parentRefs, frame, siblingFrames\)/, "iframe 重定向后必须通过受限的唯一父子关系回退匹配");
assert.match(captureWorker, /parentRefs\.length === 1 && siblingFrames\.length === 1/, "iframe URL 不一致时仅允许单 DOM 引用和单直接子 frame 的确定性回退");
assert.match(captureWorker, /frameName:\s*window\.name\s*\|\|\s*""/, "子 frame 快照必须返回 window.name 作为稳定映射键");
assert.match(captureWorker, /ref\.name === frameName/, "多个直接子 frame 必须支持按唯一 iframe name 映射");
assert.doesNotMatch(captureWorker, /nextBytes\s*>\s*1024\s*\*\s*1024/, "业务 iframe 不得再受固定 1MB 上限限制");
assert.match(captureWorker, /MAX_CAPTURE_BYTES\s*-\s*totalBytes/, "业务 iframe 只能按抓取总预算决定是否保留");
assert.match(captureWorker, /youdesign-capture-frame-summary/, "抓取产物必须内嵌 frame 数量诊断");
assert.match(captureWorker, /youdesign-capture-extension-version/, "抓取产物必须内嵌扩展版本诊断");
assert.match(captureWorker, /refs\.length === 1 && directTopFrames\.length === 0 && orphanResults\.length === 1/, "webNavigation 暂缺子 frame 时必须接住唯一的 allFrames 注入结果");
assert.match(captureWorker, /frame\.removeAttribute\("src"\)/, "插件必须在序列化阶段清空业务 iframe src");
assert.match(captureWorker, /data-yd-capture-frame-source/, "插件必须留下只读 frame 来源标记供静态快照匹配");
assert.match(captureWorker, /inlineRemoteImages\(payload\)/, "插件必须在交付前内联受预算保护的远程图片");
assert.match(captureWorker, /imageHrefs: Array\.from\(document\.images\)/, "插件必须从实际已渲染图片收集离线资源候选");
assert.match(captureWorker, /function markPreloadedTabs\(sourceDoc, clonedRoot\)/, "插件必须只标记抓取时已经存在的 Tab 面板");
assert.match(readFileSync(new URL("../src/lib/capturedPage.ts", import.meta.url), "utf8"), /data-yd-capture-tab-panel-state="closed"/, "Web 预览必须确定性隐藏未选静态 Tab 面板");
assert.match(readFileSync(new URL("../src/lib/capturedPage.ts", import.meta.url), "utf8"), /documentFrames\.length === 1 && siblingCandidates\.length === 1/, "重建端必须兼容只有最终 URL 的旧扩展单 iframe payload");
assert.match(readFileSync(new URL("../src/lib/capturedPage.ts", import.meta.url), "utf8"), /candidate\.frameName === frameName/, "重建端必须支持按 iframe name 对应静态子文档");
assert.match(readFileSync(new URL("../src/lib/capturedPage.ts", import.meta.url), "utf8"), /!frame\.hasAttribute\("src"\) && offlineSrcdoc/, "二次重建必须识别并保留已经离线的纯 srcdoc iframe");
assert.match(captureManifest, /"default_popup": "popup\.html"/, "插件必须提供选择性页签采集入口");
assert.match(captureWorker, /MAX_GUIDED_TAB_SNAPSHOT_BYTES/, "选择性采集必须有独立体积上限");
assert.match(captureWorker, /MAX_GUIDED_STYLE_BYTES/, "选择性采集的延迟加载样式必须有独立体积上限");
assert.match(captureWorker, /function captureGuidedTabPanelInPage/, "逐页签采集必须使用轻量当前面板快照，而非整页抓取");
assert.match(captureWorker, /styleMode === "delta"/, "逐页签采集必须区分开始时样式与切换后延迟加载的增量样式");
assert.match(captureWorker, /data-yd-captured-guided-css="true"/, "合并产物必须标记选择性页签的增量 CSS");
assert.match(captureWorker, /skipPreloadedTabs/, "选择性采集基线不得同时写入通用静态 Tab 标记");
assert.match(captureWorker, /defaultCaptured/, "已打开页签必须作为默认采集项记录，不进入待采集清单");
assert.match(capturePopup, /show-guided-overlay/, "选择页签采集必须在业务页面内打开悬浮层");
assert.match(capturePopup, /frameCapture/, "普通采集完成后必须显示内嵌页抓取结果");
assert.doesNotMatch(capturePopup, /chrome\.windows\.create/, "选择页签采集不得再弹出独立窗口");
assert.doesNotMatch(captureManifest, /"sidePanel"|"side_panel"/, "页面悬浮采集不得继续依赖浏览器侧边栏");
assert.match(captureOverlay, /attachShadow\(\{ mode: "open" \}\)/, "页面悬浮层必须用 Shadow DOM 隔离业务页面样式");
assert.match(captureOverlay, /!tab\.defaultCaptured/, "默认已采集页签不得出现在悬浮层待采集列表");
assert.match(captureOverlay, /\.pending\{color:#fa8c16\}/, "待采集状态必须使用橙色");
assert.match(captureOverlay, /\.captured\{color:#52c41a\}/, "已采集状态必须使用绿色");
assert.match(captureWorker, /defaultCaptured: Boolean\(item\.defaultCaptured\)/, "开始采集后必须保留识别阶段的默认页签身份");
assert.match(captureWorker, /missingDefaults/, "默认页签快照缺失时必须阻止开始，不能把默认页签降级为待采集");
assert.match(captureWorker, /#__yd_capture_overlay/, "抓取序列化必须剥除页面内悬浮采集控件");
assert.doesNotMatch(readFileSync(new URL("../src/lib/capturedPage.ts", import.meta.url), "utf8"), /append\(note\)/, "未采集页签旁不得追加“本次未采集”文案");
assert.match(readFileSync(new URL("../src/lib/capturedPage.ts", import.meta.url), "utf8"), /youdesign-captured-from/, "历史 Chrome 抓取页也必须进入离线净化，不能继续加载旧 iframe");

// 导入端 payload 净化（normalizeCapturePayload）行为回归：扩展 v0.2.9 已取消业务
// iframe 的固定 1MB 单帧上限（DPL/CRM 子应用静态化后常带 1~3MB 内联样式），导入端
// 必须同步——否则扩展如实抓到的 CRM 子应用会在导入边界丢 html、渲染端回退“未能静态化”占位。
const bigFrameHtml = "x".repeat(Math.ceil(1.5 * 1024 * 1024));
const crmPayload = {
  html: '<!doctype html><html><body><iframe data-yd-capture-frame-source="https://crm.example.test/board"></iframe></body></html>',
  captureMeta: {
    schemaVersion: 2,
    frames: [{
      frameId: 7,
      parentFrameId: 0,
      url: "https://crm.example.test/final", // 重定向后的最终地址
      sourceUrl: "https://crm.example.test/board", // iframe DOM 声明地址
      frameName: "board_page",
      status: "captured",
      html: bigFrameHtml,
    }],
  },
};
const normalizedCrm = normalizeCapturePayload(crmPayload);
const normalizedFrame = normalizedCrm.captureMeta.frames[0];
assert.equal(normalizedFrame.status, "captured", "导入端必须保留扩展报告的 captured 状态");
assert.equal(normalizedFrame.html, bigFrameHtml, "1.5MB 的 CRM 子应用 frame html 不得被 1MB 旧闸口剥除（v0.2.9 已按总预算放宽单帧上限）");
assert.equal(normalizedFrame.sourceUrl, "https://crm.example.test/board", "导入端必须转发 sourceUrl，重建端才能按声明地址匹配重定向后的子文档");
assert.equal(normalizedFrame.frameName, "board_page", "导入端必须转发 frameName，重建端才能按 window.name 消歧多 iframe");
// 超过导入总预算的 frame html 仍须被剥除（闸口仍在，只是阈值与总预算对齐、不再是 1MB）。
const overCap = normalizeCapturePayload({ html: "<html></html>", captureMeta: { schemaVersion: 2, frames: [{ frameId: 1, parentFrameId: 0, status: "captured", html: "y".repeat(CAPTURE_IMPORT_MAX_BYTES + 1) }] } });
assert.equal(overCap.captureMeta.frames[0].html, undefined, "超过导入总预算的 frame html 仍须被剥除");
assert.equal(overCap.captureMeta.frames[0].status, "captured", "html 被剥除时 status 保留，交由重建端按无 html 的 captured 分支占位");
// 顶层 HTML 超过导入预算必须整体拒绝。
assert.throws(() => normalizeCapturePayload({ html: "z".repeat(CAPTURE_IMPORT_MAX_BYTES + 1), captureMeta: { schemaVersion: 2 } }), /超过客户端导入上限/, "顶层 HTML 超过导入预算必须拒绝");
// unavailable frame 保留诊断 reason、不带 html。
const unavailablePayload = normalizeCapturePayload({ html: "<html></html>", captureMeta: { schemaVersion: 2, frames: [{ frameId: 2, parentFrameId: 0, status: "unavailable", reason: "iframe 无法读取或无权限" }] } });
assert.equal(unavailablePayload.captureMeta.frames[0].status, "unavailable");
assert.equal(unavailablePayload.captureMeta.frames[0].reason, "iframe 无法读取或无权限");
assert.equal(unavailablePayload.captureMeta.frames[0].html, undefined, "unavailable frame 不得携带 html");
// main.cjs 必须从抽取模块引入、不得把净化逻辑内联回 Electron 主入口（否则无法回归）。
const mainCjs = readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
assert.match(mainCjs, /require\("\.\/capture-payload-utils\.cjs"\)/, "main.cjs 必须从 capture-payload-utils 引入 normalizeCapturePayload，不得内联回主入口");
assert.doesNotMatch(mainCjs, /frame\?\.html/, "main.cjs 不得再内联 frame html 闸口逻辑（已抽到 capture-payload-utils）");

console.log("captured page safety regression: ok");
