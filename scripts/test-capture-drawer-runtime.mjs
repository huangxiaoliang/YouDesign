#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { buildSync } from "esbuild";
import { chromium } from "playwright";

const source = readFileSync(new URL("../extension/youdesign-capture/service_worker.js", import.meta.url), "utf8");
const trackerSource = readFileSync(new URL("../extension/youdesign-capture/drawer_tracker.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../extension/youdesign-capture/manifest.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);
const capturedPageBundle = buildSync({
  entryPoints: [new URL("../src/lib/capturedPage.ts", import.meta.url).pathname],
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "CapturedPageTest",
  write: false,
  target: "chrome120",
}).outputFiles[0].text;
const { CAPTURE_RUNTIME_SOURCE, captureRuntimeScriptTag } = require("../desktop/captured-page-runtime.cjs");
const runtime = `<style>[data-yd-capture-drawer-state="closed"],[data-yd-capture-drawer-mask-state="closed"],[data-yd-capture-tab-panel-state="closed"]{display:none!important}</style>${captureRuntimeScriptTag()}`;

assert.match(runtime, /data-yd-capture-drawer-state="closed"/, "关闭态必须确定性隐藏抽屉");
assert.match(runtime, /data-yd-capture-drawer-mask-state="closed"/, "关闭态必须确定性隐藏遮罩");
assert.match(CAPTURE_RUNTIME_SOURCE, /event\.key !== 'Escape'/, "必须支持 Escape 关闭抽屉");
assert.match(CAPTURE_RUNTIME_SOURCE, /event\.key === 'Enter'/, "链接式关闭控件必须支持 Enter 键关闭");
assert.match(CAPTURE_RUNTIME_SOURCE, /function openDrawer\(id\)/, "受控运行时必须能重新打开已关闭抽屉");
assert.match(CAPTURE_RUNTIME_SOURCE, /data-yd-capture-drawer-parent/, "受控运行时必须维护嵌套抽屉关系");
assert.match(CAPTURE_RUNTIME_SOURCE, /data-yd-capture-tab-panel-state/, "受控运行时必须能够切换静态 Tab 面板");
assert.match(CAPTURE_RUNTIME_SOURCE, /event\.key === 'ArrowLeft'/, "静态 Tab 必须支持方向键切换");
assert.match(CAPTURE_RUNTIME_SOURCE, /am-tabs-default-bar-tab-active/, "静态 Tab 切换必须同步旧版 Ant Mobile 选中样式类");
assert.match(CAPTURE_RUNTIME_SOURCE, /function ensureTabVisible\(tab, smooth\)/, "静态 Tab 切换必须把当前页签自动滚动到可视区域");
assert.match(CAPTURE_RUNTIME_SOURCE, /panel\.animate/, "静态 Tab 面板必须保留轻量切换动画");
assert.match(CAPTURE_RUNTIME_SOURCE, /function originalPanelMotion\(panel\)/, "静态 Tab 动画必须读取原页面板或轨道的运动参数");
assert.doesNotMatch(CAPTURE_RUNTIME_SOURCE, /duration:\s*220|transform 220ms/, "静态 Tab 不得继续写死统一动画时长");
assert.doesNotMatch(CAPTURE_RUNTIME_SOURCE, /\b(?:fetch|XMLHttpRequest|WebSocket|window\.open)\b/, "抽屉运行时不得发起网络或打开窗口");
assert.doesNotMatch(source, /CAPTURE_DRAWER_RUNTIME/, "插件产物不得携带可执行运行时，运行时必须由受控预览层提供");
assert.match(source, /clonedClose\.removeAttribute\("href"\)/, "被重建的链接式关闭控件必须移除 href，避免被预览导航守卫抢先拦截");
assert.match(source, /clonedClose\.setAttribute\("type", "button"\)/, "被重建的 button 关闭控件不得提交原表单");
assert.match(source, /prepareDrawerTracker\(sourceTabId\)/, "每次抓取前必须向页面跟踪器准备抽屉映射");
assert.match(source, /cleanup-drawer-mappings/, "抓取结束后必须清理来源页临时标记");
assert.match(source, /isExternalMobilePanel/, "旧版 Ant Mobile 的外置活动内容必须覆盖空 pane 的基线快照");
assert.match(source, /hasNestedGuidedBaseline/, "外置内容基线必须按嵌套页签宿主判断是否可被实时快照覆盖");
assert.match(source, /!hasMarkedExternalBaseline/, "带嵌套页签标记的外置内容基线不得被无标记的实时外层快照覆盖");
assert(manifest.content_scripts?.some((item) => item.js?.includes("drawer_tracker.js") && item.run_at === "document_start"), "抽屉跟踪器必须从页面加载时启用（content_scripts document_start 全域注入）");
assert.doesNotMatch(trackerSource, /\b(?:fetch|XMLHttpRequest|WebSocket|window\.open)\b/, "入口跟踪器不得发起网络或打开窗口");
assert.doesNotMatch(trackerSource, /(?:localStorage|sessionStorage|chrome\.storage)/, "入口跟踪器只能在页面内存中保留短期关系");
assert.equal((source.match(/const outerDrawerCandidates = drawerCandidates\.filter/g) || []).length, 2, "丰富采集和降级采集都必须排除嵌套抽屉容器");
assert.equal((source.match(/function freezeFrameRefs\(clonedRoot\)/g) || []).length, 2, "丰富采集和降级采集都必须冻结业务 iframe");
assert.equal((source.match(/function markPreloadedTabs\(sourceDoc, clonedRoot\)/g) || []).length, 2, "丰富采集和降级采集都必须只标记预加载 Tab");
assert.equal((source.match(/interactions: \{ drawers: drawerPlans, tabs: tabPlans \}/g) || []).length, 2, "Tab 采集计划必须随两条抓取路径交付");

const basicCaptureMatch = source.match(/function captureRenderedPageBasic\(skipPreloadedTabs = false\) \{[\s\S]*?\n\}\n\nfunction utf8Bytes/);
assert(basicCaptureMatch, "必须能取得降级采集函数以验证抽屉标记");
const basicCaptureSource = basicCaptureMatch[0].replace(/\n\nfunction utf8Bytes$/, "");
const guidedPanelMatch = source.match(/function captureGuidedTabPanelInPage\(expectedGroups, styleMode = "none", knownStyleSignatures = \[\]\) \{[\s\S]*?\n\}\n\nfunction appendGuidedStyleBlocks/);
assert(guidedPanelMatch, "必须能取得轻量当前页签采集函数");
const guidedPanelSource = guidedPanelMatch[0].replace(/\n\nfunction appendGuidedStyleBlocks$/, "");
const appendGuidedStylesMatch = source.match(/function appendGuidedStyleBlocks\(html, blocks\) \{[\s\S]*?\n\}\n\nfunction summarizeGuidedSession/);
assert(appendGuidedStylesMatch, "必须能取得增量页签样式合并函数");
const appendGuidedStylesSource = appendGuidedStylesMatch[0].replace(/\n\nfunction summarizeGuidedSession$/, "");
const inspectTabsMatch = source.match(/function inspectGuidedTabsInPage\(\) \{[\s\S]*?\n\}\n\nfunction normalizeGuidedTabLabel/);
assert(inspectTabsMatch, "必须能取得页签目录识别函数");
const inspectTabsSource = inspectTabsMatch[0].replace(/\n\nfunction normalizeGuidedTabLabel$/, "");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const drawerPage = await browser.newPage();

async function mount() {
  // 每个附件都是独立文档；测试也隔离夹具，避免上一轮事件监听影响结果。
  await drawerPage.goto("data:text/html,<title>fixture-reset</title>");
  await drawerPage.goto("about:blank");
  await drawerPage.setContent(`<!doctype html><html><head>${runtime}</head><body style="overflow:hidden">
    <main id="content"><div id="opener" data-yd-capture-drawer-open="yd-drawer-1" aria-expanded="true">数据卡片 <strong id="opener-value">1005</strong></div></main>
    <div id="mask" style="position:fixed;inset:0;z-index:1" data-yd-capture-drawer-mask="yd-drawer-1" data-yd-capture-drawer-mask-state="open"></div>
    <aside id="drawer" style="position:fixed;right:0;top:0;width:240px;height:100%;z-index:2" data-yd-capture-drawer="yd-drawer-1" data-yd-capture-drawer-state="open">
      <a id="close" href="/must-not-navigate" data-yd-capture-drawer-close="yd-drawer-1"><span id="close-icon">×</span></a>
    </aside>
  </body></html>`);
}

async function mountNested() {
  await drawerPage.goto("about:blank");
  await drawerPage.setContent(`<!doctype html><html><head>${runtime}</head><body>
    <button id="outer-opener" data-yd-capture-drawer-open="outer">打开外层</button>
    <section id="outer" data-yd-capture-drawer="outer" data-yd-capture-drawer-state="open">
      <button id="inner-opener" data-yd-capture-drawer-open="inner">打开内层</button>
      <button id="outer-close" data-yd-capture-drawer-close="outer">关闭外层</button>
    </section>
    <section id="inner" data-yd-capture-drawer="inner" data-yd-capture-drawer-parent="outer" data-yd-capture-drawer-state="open">
      <button id="inner-close" data-yd-capture-drawer-close="inner">关闭内层</button>
    </section>
  </body></html>`);
}

async function trackObservedDrawerFixture() {
  await page.goto("about:blank");
  await page.setContent(`<!doctype html><html><body>
    <section id="card" style="width:180px;height:70px;cursor:pointer"><span>任意指标</span><strong id="card-value">1005</strong></section>
    <section id="unrelated" style="width:180px;height:70px;cursor:pointer">其他卡片 715</section>
    <div id="tracked-drawer" class="ant-drawer" style="display:none;position:fixed;inset:0;width:900px;height:650px">
      <div id="tracked-mask" class="ant-drawer-mask" style="position:absolute;inset:0"></div>
      <div class="ant-drawer-content-wrapper" style="position:absolute;right:0;top:0;width:420px;height:650px">
        <button id="tracked-close" class="ant-drawer-close" aria-label="关闭">×</button><h2>动态明细</h2>
      </div>
    </div>
  </body></html>`);
  await page.addScriptTag({ content: trackerSource });
  await page.evaluate(() => {
    document.querySelector("#card").addEventListener("pointerdown", () => {
      document.querySelector("#tracked-drawer").style.display = "block";
    });
  });
  await page.locator("#card-value").click();
  await page.waitForTimeout(350);
  const diagnostics = await page.evaluate(() => globalThis.__ydDrawerInteractionTrackerV1.prepareMappings());
  const captured = await page.evaluate((functionSource) => {
    const capture = new Function(`${functionSource}; return captureRenderedPageBasic;`)();
    return capture();
  }, basicCaptureSource);
  await page.evaluate(() => globalThis.__ydDrawerInteractionTrackerV1.clearTransientMarks());
  const sourceClean = await page.evaluate(() => !document.querySelector("[data-yd-drawer-track-id],[data-yd-drawer-track-opener]"));
  return { diagnostics, captured, sourceClean };
}

async function capturePaymentExplanationModalFixture() {
  await page.goto("about:blank");
  await page.setContent(`<!doctype html><html><body>
    <section class="am-tabs am-tabs-horizontal am-tabs-top">
      <div class="am-tabs-default-bar-content" role="tablist">
        <div class="am-tabs-default-bar-tab" role="tab">基本信息</div>
        <div class="am-tabs-default-bar-tab am-tabs-default-bar-tab-active" role="tab">缴费分析</div>
      </div>
      <div class="am-tabs-content-wrap"><div class="am-tabs-pane-wrap"></div><div class="am-tabs-pane-wrap am-tabs-pane-wrap-active"></div></div>
    </section>
    <div class="institution-info-page-content"><div id="payment-tips" class="tips" style="width:72px;height:28px;cursor:pointer">口径说明</div></div>
  </body></html>`);
  await page.addScriptTag({ content: trackerSource });
  await page.evaluate(() => {
    document.querySelector("#payment-tips").addEventListener("click", () => {
      const mask = document.createElement("div");
      mask.className = "am-modal-mask";
      mask.style.cssText = "position:fixed;inset:0;z-index:999";
      const wrap = document.createElement("div");
      wrap.className = "am-modal-wrap";
      wrap.setAttribute("role", "dialog");
      wrap.style.cssText = "position:fixed;inset:0;z-index:999";
      wrap.innerHTML = '<div role="document" class="am-modal am-modal-activity am-modal-transparent" style="width:80%;height:460px"><div class="am-modal-content"><button aria-label="Close" class="am-modal-close"><span class="am-modal-close-x"></span></button><div class="modal-payment-analysis"><h2>字段定义</h2><textarea disabled>有效收费订单统计口径</textarea></div></div></div>';
      document.body.append(mask, wrap);
    });
  });
  await page.locator("#payment-tips").click();
  await page.waitForTimeout(350);
  const diagnostics = await page.evaluate(() => globalThis.__ydDrawerInteractionTrackerV1.prepareMappings());
  const snapshot = await page.evaluate((functionSource) => {
    const capture = new Function(`${functionSource}; return captureGuidedTabPanelInPage;`)();
    return capture([{ id: "payment-group", tabs: [{ key: "payment:basic", label: "基本信息" }, { key: "payment:analysis", label: "缴费分析" }] }]);
  }, guidedPanelSource);
  return { diagnostics, snapshot };
}

async function trackSemanticAndAmbiguousFixtures() {
  await page.goto("about:blank");
  await page.setContent(`<!doctype html><html><body>
    <button id="semantic-opener" aria-controls="semantic-drawer">语义入口</button>
    <aside id="semantic-drawer" role="dialog" aria-modal="true" style="position:fixed;right:0;top:0;width:320px;height:500px"><button aria-label="关闭">×</button></aside>
  </body></html>`);
  await page.addScriptTag({ content: trackerSource });
  const semantic = await page.evaluate(() => {
    const diagnostics = globalThis.__ydDrawerInteractionTrackerV1.prepareMappings();
    return {
      diagnostics,
      opener: document.querySelector("#semantic-opener").getAttribute("data-yd-drawer-track-opener"),
      source: document.querySelector("#semantic-drawer").getAttribute("data-yd-drawer-track-source"),
    };
  });

  await page.goto("about:blank");
  await page.setContent(`<!doctype html><html><body>
    <button id="ambiguous-opener">同时打开</button>
    <aside id="ambiguous-a" class="custom-drawer" style="display:none;position:fixed;left:0;top:0;width:260px;height:500px"></aside>
    <aside id="ambiguous-b" class="custom-drawer" style="display:none;position:fixed;right:0;top:0;width:260px;height:500px"></aside>
  </body></html>`);
  await page.addScriptTag({ content: trackerSource });
  await page.evaluate(() => {
    document.querySelector("#ambiguous-opener").addEventListener("click", () => {
      document.querySelector("#ambiguous-a").style.display = "block";
      document.querySelector("#ambiguous-b").style.display = "block";
    });
  });
  await page.locator("#ambiguous-opener").click();
  await page.waitForTimeout(350);
  const ambiguous = await page.evaluate(() => globalThis.__ydDrawerInteractionTrackerV1.prepareMappings());
  return { semantic, ambiguous };
}

async function trackReusedDrawerFixture() {
  await page.goto("about:blank");
  await page.setContent(`<!doctype html><html><body>
    <button id="row-a">查看 A</button><button id="row-b">查看 B</button>
    <aside id="shared" class="custom-drawer" style="display:none;position:fixed;right:0;top:0;width:300px;height:500px"></aside>
  </body></html>`);
  await page.addScriptTag({ content: trackerSource });
  await page.evaluate(() => {
    for (const id of ["row-a", "row-b"]) document.querySelector(`#${id}`).addEventListener("click", () => {
      document.querySelector("#shared").style.display = "block";
    });
  });
  await page.locator("#row-a").click();
  await page.waitForTimeout(350);
  await page.evaluate(() => { document.querySelector("#shared").style.display = "none"; });
  await page.locator("#row-b").click();
  await page.waitForTimeout(350);
  return page.evaluate(() => {
    globalThis.__ydDrawerInteractionTrackerV1.prepareMappings();
    return {
      rowA: document.querySelector("#row-a").getAttribute("data-yd-drawer-track-opener"),
      rowB: document.querySelector("#row-b").getAttribute("data-yd-drawer-track-opener"),
    };
  });
}

async function trackDelayedCompetingClicksFixture() {
  await page.goto("about:blank");
  await page.setContent(`<!doctype html><html><body>
    <button id="delayed-a">延迟打开 A</button><button id="later-b">随后点击 B</button>
    <aside id="delayed-drawer" class="custom-drawer" style="display:none;position:fixed;right:0;top:0;width:300px;height:500px"><h2>延迟明细</h2></aside>
  </body></html>`);
  await page.addScriptTag({ content: trackerSource });
  await page.evaluate(() => {
    document.querySelector("#delayed-a").addEventListener("click", () => setTimeout(() => { document.querySelector("#delayed-drawer").style.display = "block"; }, 450));
  });
  await page.locator("#delayed-a").click();
  await page.waitForTimeout(100);
  await page.locator("#later-b").click();
  await page.waitForTimeout(850);
  return page.evaluate(() => {
    const diagnostics = globalThis.__ydDrawerInteractionTrackerV1.prepareMappings();
    return {
      diagnostics,
      openerA: document.querySelector("#delayed-a").getAttribute("data-yd-drawer-track-opener"),
      openerB: document.querySelector("#later-b").getAttribute("data-yd-drawer-track-opener"),
    };
  });
}

async function trackRerenderedNodesFixture() {
  await page.goto("about:blank");
  await page.setContent(`<!doctype html><html><body>
    <button id="rerender-opener" data-testid="detail-trigger">打开详情</button>
    <aside id="rerender-drawer" class="custom-drawer" style="display:none;position:fixed;right:0;top:0;width:300px;height:500px"><h2>稳定详情</h2></aside>
  </body></html>`);
  await page.addScriptTag({ content: trackerSource });
  await page.evaluate(() => document.querySelector("#rerender-opener").addEventListener("click", () => { document.querySelector("#rerender-drawer").style.display = "block"; }));
  await page.locator("#rerender-opener").click();
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    const opener = document.querySelector("#rerender-opener");
    const drawer = document.querySelector("#rerender-drawer");
    opener.replaceWith(opener.cloneNode(true));
    drawer.replaceWith(drawer.cloneNode(true));
  });
  await page.waitForTimeout(100);
  return page.evaluate(() => {
    const diagnostics = globalThis.__ydDrawerInteractionTrackerV1.prepareMappings();
    return { diagnostics, opener: document.querySelector("#rerender-opener").getAttribute("data-yd-drawer-track-opener") };
  });
}

async function trackVisibleDrawerContentSwitchFixture() {
  await page.goto("about:blank");
  await page.setContent(`<!doctype html><html><body>
    <button id="content-a">查看 A</button><button id="content-b">查看 B</button>
    <aside id="content-drawer" class="custom-drawer" style="display:none;position:fixed;right:0;top:0;width:300px;height:500px"><h2 id="content-title">A 明细</h2></aside>
  </body></html>`);
  await page.addScriptTag({ content: trackerSource });
  await page.evaluate(() => {
    document.querySelector("#content-a").addEventListener("click", () => { document.querySelector("#content-drawer").style.display = "block"; });
    document.querySelector("#content-b").addEventListener("click", () => { document.querySelector("#content-title").textContent = "B 明细"; });
  });
  await page.locator("#content-a").click();
  await page.waitForTimeout(350);
  await page.locator("#content-b").click();
  await page.waitForTimeout(350);
  return page.evaluate(() => {
    globalThis.__ydDrawerInteractionTrackerV1.prepareMappings();
    return {
      openerA: document.querySelector("#content-a").getAttribute("data-yd-drawer-track-opener"),
      openerB: document.querySelector("#content-b").getAttribute("data-yd-drawer-track-opener"),
    };
  });
}

async function trackNestedDrawerFixture() {
  await page.goto("about:blank");
  await page.setContent(`<!doctype html><html><body>
    <button id="open-outer">打开外层</button>
    <section id="tracked-outer" class="custom-drawer" style="display:none;position:fixed;right:0;top:0;width:520px;height:620px">
      <button id="close-outer" aria-label="关闭">×</button><button id="open-inner">打开内层</button>
    </section>
    <section id="tracked-inner" class="custom-drawer" style="display:none;position:fixed;right:0;top:80px;width:320px;height:420px">
      <button id="close-inner" aria-label="关闭">×</button>
    </section>
  </body></html>`);
  await page.addScriptTag({ content: trackerSource });
  await page.evaluate(() => {
    document.querySelector("#open-outer").addEventListener("click", () => { document.querySelector("#tracked-outer").style.display = "block"; });
    document.querySelector("#open-inner").addEventListener("click", () => { document.querySelector("#tracked-inner").style.display = "block"; });
  });
  await page.locator("#open-outer").click();
  await page.waitForTimeout(350);
  await page.locator("#open-inner").click();
  await page.waitForTimeout(350);
  await page.evaluate(() => globalThis.__ydDrawerInteractionTrackerV1.prepareMappings());
  return page.evaluate((functionSource) => {
    const capture = new Function(`${functionSource}; return captureRenderedPageBasic;`)();
    return capture();
  }, basicCaptureSource);
}

async function captureNestedDrawerFixture() {
  await page.setContent(`<!doctype html><html><head><title>抽屉采集回归</title></head><body>
    <main>到期企业明细列表</main>
    <div id="drawer-root" class="ant-drawer ant-drawer-open" style="position:fixed;inset:0;width:1000px;height:700px">
      <div id="mask" class="ant-drawer-mask" style="position:absolute;inset:0;width:1000px;height:700px"></div>
      <div class="ant-drawer-content-wrapper" style="position:absolute;right:0;top:0;width:480px;height:700px">
        <a id="close" class="ant-drawer-close" aria-label="关闭" href="/itcrm/board"><span id="close-icon">×</span></a>
        <section>到期企业明细</section>
      </div>
    </div>
    <iframe id="business-frame" src="https://business.example.test/app/#/board"></iframe>
  </body></html>`);
  return page.evaluate((functionSource) => {
    const capture = new Function(`${functionSource}; return captureRenderedPageBasic;`)();
    return capture();
  }, basicCaptureSource);
}

async function captureSpreadsheetFixture() {
  await page.setContent(`<!doctype html><html><body>
    <main id="financial-spreadsheet" class="financial-spreadsheet data-sheet-grid" style="position:fixed;inset:0;width:1000px;height:700px">普通表格区域</main>
  </body></html>`);
  return page.evaluate((functionSource) => {
    const capture = new Function(`${functionSource}; return captureRenderedPageBasic;`)();
    return capture();
  }, basicCaptureSource);
}

async function captureDplCloseCollisionFixture() {
  await page.setContent(`<!doctype html><html><body>
    <div id="dpl-root" class="dpl-drawer-layout component-identification-drawer" style="position:fixed;inset:0;width:1000px;height:700px">
      <div class="dpl-drawer-area">
        <div class="dpl-drawer-header"><div class="dpl-drawer-title">网点的企业</div></div>
        <i id="full-screen" class="dpl-common-iconfont dpl-common-icon-quanping dpl-drawer-icon dpl-drawer-full-screen-icon"></i>
        <i id="real-close" class="dpl-common-iconfont dpl-common-icon-pure-close dpl-drawer-icon"></i>
        <div class="dpl-drawer-body">
          <span class="dpl-select-selection__clear"><i id="filter-clear" class="dpl-anticon dpl-anticon-close-circle dpl-select-clear-icon"></i></span>
          <span class="dpl-select-selection__choice__remove"><i id="choice-remove" class="dpl-select-selection__choice__remove-icon">×</i></span>
        </div>
      </div>
    </div>
  </body></html>`);
  return page.evaluate((functionSource) => {
    const capture = new Function(`${functionSource}; return captureRenderedPageBasic;`)();
    return capture();
  }, basicCaptureSource);
}

async function capturePreloadedTabFixture() {
  await page.setContent(`<!doctype html><html><head><title>页签采集回归</title></head><body>
    <section class="ant-tabs">
      <div class="ant-tabs-nav">
        <div id="tab-tax" class="ant-tabs-tab ant-tabs-tab-active" data-node-key="tax">票账税</div>
        <a id="tab-service" class="ant-tabs-tab" data-node-key="service" href="/must-not-navigate">微企服</a>
        <div id="tab-einvoice" class="ant-tabs-tab" data-node-key="einvoice">数电票</div>
        <div id="tab-compliance" class="ant-tabs-tab" data-node-key="compliance">合规</div>
      </div>
      <div class="ant-tabs-content-holder">
        <div id="panel-tax" class="ant-tabs-tabpane" data-node-key="tax">票账税静态数据</div>
        <div id="panel-service" class="ant-tabs-tabpane ant-tabs-tabpane-hidden" data-node-key="service">微企服静态数据</div>
        <div id="panel-einvoice" class="ant-tabs-tabpane ant-tabs-tabpane-hidden" data-node-key="einvoice">数电票静态数据</div>
        <div id="panel-compliance" class="ant-tabs-tabpane ant-tabs-tabpane-hidden" data-node-key="compliance">合规静态数据</div>
      </div>
    </section>
  </body></html>`);
  return page.evaluate((functionSource) => {
    const capture = new Function(`${functionSource}; return captureRenderedPageBasic;`)();
    return capture();
  }, basicCaptureSource);
}

async function captureDplTabFixture() {
  await page.setContent(`<!doctype html><html><head><title>DPL 页签采集回归</title></head><body>
    <section class="dpl-tabs dpl-tabs-top">
      <div class="dpl-tabs-bar" role="tablist"><div class="dpl-tabs-nav"><div id="dpl-basic" class="dpl-tabs-tab" role="tab">基础信息</div><div id="dpl-care" class="dpl-tabs-tab dpl-tabs-tab-active" role="tab">关怀</div></div></div>
      <div class="dpl-tabs-content"><div id="dpl-panel-basic" class="dpl-tabs-tabpane dpl-tabs-tabpane-inactive" role="tabpanel">基础信息静态数据</div><div id="dpl-panel-care" class="dpl-tabs-tabpane dpl-tabs-tabpane-active" role="tabpanel">关怀静态数据</div></div>
    </section>
  </body></html>`);
  return page.evaluate((functionSource) => {
    const capture = new Function(`${functionSource}; return captureRenderedPageBasic;`)();
    return capture();
  }, basicCaptureSource);
}

try {
  const observed = await trackObservedDrawerFixture();
  assert.equal(observed.diagnostics.mapped, 1, "用户点击后唯一新打开的抽屉必须建立因果映射");
  assert.equal(observed.diagnostics.observed, 1, "点击因果映射必须标记为 observed-click");
  assert.deepEqual(observed.captured.drawerPlans, [{ id: "yd-drawer-1", hasMask: true, hasOpener: true, mappingSource: "observed-click" }], "通用映射必须进入抓取交互计划");
  assert.match(observed.captured.html, /id="card"[^>]*data-yd-capture-drawer-open="yd-drawer-1"/, "应标记真正的可点击卡片，而不是写死业务文案");
  assert.doesNotMatch(observed.captured.html, /id="unrelated"[^>]*data-yd-capture-drawer-open=/, "无关卡片不得被误绑定");
  assert.doesNotMatch(observed.captured.html, /data-yd-drawer-track-(?:id|opener|source|parent)/, "最终 HTML 不得遗留跟踪器临时标记");
  assert.equal(observed.sourceClean, true, "抓取后来源页的临时映射标记必须被清理");

  const paymentModal = await capturePaymentExplanationModalFixture();
  assert.equal(paymentModal.diagnostics.observed, 1, "点击口径说明后必须识别实际的 Ant Mobile modal 因果关系");
  assert.equal(paymentModal.snapshot.drawerSnapshots?.length, 1, "缴费分析的口径说明 modal 必须随当前页签形成独立离线快照");
  assert.match(paymentModal.snapshot.captures?.[0]?.panelHtml || "", /id="payment-tips"[^>]*data-yd-capture-drawer-open=/, "口径说明入口必须绑定到离线弹层");
  assert.match(paymentModal.snapshot.drawerSnapshots?.[0]?.drawerHtml || "", /modal-payment-analysis/, "口径说明的字段定义内容必须完整进入弹层快照");
  assert.match(paymentModal.snapshot.drawerSnapshots?.[0]?.maskHtml || "", /am-modal-mask/, "口径说明弹层必须保留独立遮罩");

  const fallbackMappings = await trackSemanticAndAmbiguousFixtures();
  assert.equal(fallbackMappings.semantic.diagnostics.semantic, 1, "明确 aria-controls 关系应在无点击历史时安全映射");
  assert(fallbackMappings.semantic.opener, "语义入口必须获得临时关系 id");
  assert.equal(fallbackMappings.semantic.source, "semantic", "语义映射来源必须可诊断");
  assert.equal(fallbackMappings.ambiguous.mapped, 0, "一次点击同时打开多个抽屉时必须拒绝猜测映射");

  const reused = await trackReusedDrawerFixture();
  assert.equal(reused.rowA, null, "复用抽屉切换到新数据实例后不得保留旧行入口");
  assert(reused.rowB, "复用抽屉只能映射当前打开实例的入口");

  const delayedCompeting = await trackDelayedCompetingClicksFixture();
  assert.equal(delayedCompeting.diagnostics.mapped, 0, "异步抽屉打开前若又发生其它候选点击，必须判为歧义而不是归给最后一次点击");
  assert.equal(delayedCompeting.openerA, null, "延迟打开且存在竞争点击时不得猜测原入口");
  assert.equal(delayedCompeting.openerB, null, "后续无关点击不得劫持先前异步打开的抽屉");

  const rerendered = await trackRerenderedNodesFixture();
  assert.equal(rerendered.diagnostics.observed, 1, "入口和抽屉被框架重建后，应通过唯一稳定指纹找回已观察关系");
  assert(rerendered.opener, "框架重建后的新入口节点必须获得映射");

  const switchedContent = await trackVisibleDrawerContentSwitchFixture();
  assert.equal(switchedContent.openerA, null, "同一可见抽屉切换数据实例后必须撤销旧入口关系");
  assert(switchedContent.openerB, "同一可见抽屉内容切换后必须映射到触发新实例的入口");

  const nestedCaptured = await trackNestedDrawerFixture();
  assert.equal(nestedCaptured.drawerPlans.length, 2, "通用跟踪必须分别保留外层和内层抽屉实例");
  assert.equal(nestedCaptured.drawerPlans[1].parentId, nestedCaptured.drawerPlans[0].id, "内层抽屉必须映射到实际父抽屉");
  assert.match(nestedCaptured.html, /id="tracked-inner"[^>]*data-yd-capture-drawer-parent="yd-drawer-1"/, "嵌套关系必须进入最终离线 HTML");

  const captured = await captureNestedDrawerFixture();
  assert.deepEqual(captured.drawerPlans, [{ id: "yd-drawer-1", hasMask: true }], "嵌套的抽屉根节点和内容容器只能标记为一个可关闭抽屉");
  assert.match(captured.html, /id="drawer-root"[^>]*data-yd-capture-drawer="yd-drawer-1"/, "必须标记外层抽屉根节点，关闭时才能同时隐藏内容和遮罩");
  assert.match(captured.html, /id="mask"[^>]*data-yd-capture-drawer-mask="yd-drawer-1"/, "同一抽屉的遮罩必须被标记");
  assert.match(captured.html, /id="close"[^>]*data-yd-capture-drawer-close="yd-drawer-1"/, "关闭控件必须映射到抽屉根节点");
  assert.doesNotMatch(captured.html, /id="close"[^>]*href=/, "链接式关闭控件在采集结果中不得遗留 href");
  assert.match(captured.html, /id="business-frame"[^>]*data-yd-capture-frame-source="https:\/\/business\.example\.test\/app\/#\/board"/, "业务 iframe 必须记录来源，仅用于静态快照匹配");
  assert.doesNotMatch(captured.html, /id="business-frame"[^>]*\ssrc=/, "抓取结果不得保留会重新联网的业务 iframe src");

  const spreadsheetCaptured = await captureSpreadsheetFixture();
  assert.deepEqual(spreadsheetCaptured.drawerPlans, [], "类名含 spreadsheet/data-sheet 的普通大区域不得被误判成抽屉");
  assert.doesNotMatch(spreadsheetCaptured.html, /id="financial-spreadsheet"[^>]*data-yd-capture-drawer=/, "普通表格区域不得被写入抽屉运行时标记");

  const dplCloseCollision = await captureDplCloseCollisionFixture();
  assert.equal(dplCloseCollision.drawerPlans.length, 1, "DPL 抽屉内部存在筛选清除图标时仍必须保留抽屉交互");
  assert.match(dplCloseCollision.html, /id="real-close"[^>]*data-yd-capture-drawer-close="yd-drawer-1"/, "必须优先标记抽屉壳层的 pure-close 图标");
  assert.doesNotMatch(dplCloseCollision.html, /id="filter-clear"[^>]*data-yd-capture-drawer-close=/, "筛选项清除图标不得被误标为抽屉关闭按钮");
  assert.doesNotMatch(dplCloseCollision.html, /id="choice-remove"[^>]*data-yd-capture-drawer-close=/, "多选项删除图标不得被误标为抽屉关闭按钮");

  const tabCaptured = await capturePreloadedTabFixture();
  assert.deepEqual(tabCaptured.captureMeta.interactions.tabs, [{ id: "yd-tab-group-1", activeTabId: "yd-tab-1", tabIds: ["yd-tab-1", "yd-tab-2", "yd-tab-3", "yd-tab-4"] }], "预加载 Ant Tab 必须作为静态切换计划被记录");
  assert.match(tabCaptured.html, /id="tab-service"[^>]*data-yd-capture-tab="yd-tab-2"/, "非活动 Tab 触发器必须被标记");
  assert.match(tabCaptured.html, /id="panel-service"[^>]*data-yd-capture-tab-panel-state="closed"/, "非活动预加载面板必须被静态关闭而不是删除");
  assert.doesNotMatch(tabCaptured.html, /id="tab-service"[^>]*href=/, "链接式 Tab 不得遗留真实导航 href");
  assert.deepEqual(tabCaptured.guidedTabState?.groups?.[0]?.tabs.map((tab) => tab.key), ["yd-guided-tab-group-1:tab-1", "yd-guided-tab-group-1:tab-2", "yd-guided-tab-group-1:tab-3", "yd-guided-tab-group-1:tab-4"], "选择性采集必须提供带组前缀的稳定页签 key");
  assert.equal(tabCaptured.guidedTabState?.groups?.[0]?.activeKey, "yd-guided-tab-group-1:tab-1", "选择性采集必须记录抓取瞬间活动页签");

  const dplCaptured = await captureDplTabFixture();
  assert.deepEqual(dplCaptured.guidedTabState?.groups?.[0]?.tabs.map((tab) => tab.label), ["基础信息", "关怀"], "DPL Tab 必须被识别为同一个选择性采集组");
  assert.equal(dplCaptured.guidedTabState?.groups?.[0]?.activeKey, "yd-guided-tab-group-1:tab-2", "DPL 当前活动 Tab 必须映射到同级 dpl-tabs-content 面板");
  const lightDplSnapshot = await page.evaluate((functionSource) => {
    const capture = new Function(`${functionSource}; return captureGuidedTabPanelInPage;`)();
    return capture([{ id: "yd-guided-tab-group-1", tabs: [{ key: "yd-guided-tab-group-1:tab-1", label: "基础信息" }, { key: "yd-guided-tab-group-1:tab-2", label: "关怀" }] }]);
  }, guidedPanelSource);
  assert.deepEqual(lightDplSnapshot.captures?.map((item) => item.key), ["yd-guided-tab-group-1:tab-2"], "逐页签采集必须读取 DPL 的活动 Tab，而非第一个面板");
  assert.match(lightDplSnapshot.captures?.[0]?.panelHtml || "", /关怀静态数据/, "逐页签采集必须快速返回当前 DPL 面板快照");
  const remappedDplSnapshot = await page.evaluate((functionSource) => {
    const capture = new Function(`${functionSource}; return captureGuidedTabPanelInPage;`)();
    // 模拟 DPL 切换后重建内部 key；页面标签及顺序仍保持不变。
    return capture([{ id: "first-group", tabs: [{ key: "initial-basic-key", label: "基础信息" }, { key: "initial-care-key", label: "关怀" }] }]);
  }, guidedPanelSource);
  assert.deepEqual(remappedDplSnapshot.captures?.map((item) => item.key), ["initial-care-key"], "DPL 重建内部 key 后必须按稳定标签回映射到开始采集时的页签");
  assert.match(remappedDplSnapshot.captures?.[0]?.panelHtml || "", /关怀静态数据/, "按标签回映射后仍必须采集活动 DPL 面板");

  await page.setContent(`<!doctype html><html><body>
    <section class="dpl-tabs"><div role="tablist"><div role="tab" class="dpl-tabs-tab dpl-tabs-tab-active">客户概况</div><div role="tab" class="dpl-tabs-tab">关怀</div></div><div class="dpl-tabs-content"><div class="dpl-tabs-tabpane">客户概况数据</div><div class="dpl-tabs-tabpane">关怀数据</div></div>
      <section class="dpl-tabs"><div role="tablist"><div role="tab" class="dpl-tabs-tab">票账税</div><div role="tab" class="dpl-tabs-tab dpl-tabs-tab-active">模块管理</div></div><div class="dpl-tabs-content"><div class="dpl-tabs-tabpane">票账税数据</div><div class="dpl-tabs-tabpane">模块管理数据</div></div></section>
    </section>
  </body></html>`);
  const nestedActiveSnapshots = await page.evaluate((functionSource) => {
    const capture = new Function(`${functionSource}; return captureGuidedTabPanelInPage;`)();
    return capture([
      { id: "outer", tabs: [{ key: "outer:overview", label: "客户概况" }, { key: "outer:care", label: "关怀" }] },
      { id: "inner", tabs: [{ key: "inner:tax", label: "票账税" }, { key: "inner:module", label: "模块管理" }] },
    ]);
  }, guidedPanelSource);
  assert.deepEqual(nestedActiveSnapshots.captures?.map((item) => item.key), ["outer:overview", "inner:module"], "嵌套 Tab 同时激活时必须采集各组活动面板，不能反复覆盖首个页签");
  assert.match(nestedActiveSnapshots.captures?.[1]?.panelHtml || "", /模块管理数据/, "嵌套 Tab 的后续活动面板必须被实际采集");

  await page.setContent(`<!doctype html><html><body>
    <section class="dpl-tabs"><div role="tablist"><div role="tab" class="dpl-tabs-tab">客户概况</div><div role="tab" class="dpl-tabs-tab dpl-tabs-tab-active">关怀(3)</div></div><div class="dpl-tabs-content"><div class="dpl-tabs-tabpane">客户概况数据</div><div class="dpl-tabs-tabpane">关怀数据</div></div>
      <section class="dpl-tabs"><div role="tablist"><div role="tab" class="dpl-tabs-tab dpl-tabs-tab-active">中介关怀记录（3）</div><div role="tab" class="dpl-tabs-tab">企业关怀记录（0）</div></div><div class="dpl-tabs-content"><div class="dpl-tabs-tabpane">中介关怀数据</div><div class="dpl-tabs-tabpane">企业关怀数据</div></div></section>
    </section>
  </body></html>`);
  const dynamicNestedSnapshots = await page.evaluate((functionSource) => {
    const capture = new Function(`${functionSource}; return captureGuidedTabPanelInPage;`)();
    return capture([
      { id: "outer", tabs: [{ key: "start-overview", label: "客户概况" }, { key: "start-care", label: "关怀(3)" }] },
      { id: "core", tabs: [{ key: "start-tax", label: "票账税" }, { key: "start-service", label: "微企服" }, { key: "start-module", label: "模块管理" }, { key: "start-einvoice", label: "数电票" }, { key: "start-compliance", label: "合规" }] },
    ]);
  }, guidedPanelSource);
  assert.deepEqual(dynamicNestedSnapshots.captures?.map((item) => item.key), ["start-care"], "外层 Tab 切换导致内层组替换后，仍必须采集匹配的外层页签而非报组不一致");
  assert.match(dynamicNestedSnapshots.captures?.[0]?.panelHtml || "", /关怀数据/, "动态嵌套组出现时必须保留当前外层 Tab 面板数据");

  await page.setContent(`<!doctype html><html><body>
    <section class="dpl-tabs outer-tabs">
      <div class="dpl-tabs-bar" role="tablist"><div role="tab" class="dpl-tabs-tab dpl-tabs-tab-active" aria-selected="true">客户概况</div><div role="tab" class="dpl-tabs-tab" aria-selected="false">关怀(3)</div></div>
      <div class="dpl-tabs-content">
        <div role="tabpanel" class="dpl-tabs-tabpane dpl-tabs-tabpane-active">客户概况数据
          <section class="dpl-tabs inner-tabs">
            <div class="dpl-tabs-bar" role="tablist"><div role="tab" class="dpl-tabs-tab dpl-tabs-tab-active" aria-selected="true">票账税</div><div role="tab" class="dpl-tabs-tab">微企服</div><div role="tab" class="dpl-tabs-tab">模块管理</div><div role="tab" class="dpl-tabs-tab">数电票</div><div role="tab" class="dpl-tabs-tab">合规</div></div>
            <div class="dpl-tabs-content"><div role="tabpanel" class="dpl-tabs-tabpane">票账税数据</div><div role="tabpanel" class="dpl-tabs-tabpane">微企服数据</div><div role="tabpanel" class="dpl-tabs-tabpane">模块管理数据</div><div role="tabpanel" class="dpl-tabs-tabpane">数电票数据</div><div role="tabpanel" class="dpl-tabs-tabpane">合规数据</div></div>
          </section>
        </div>
      </div>
    </section>
  </body></html>`);
  const nestedCatalog = await page.evaluate((functionSource) => {
    const inspect = new Function(`${functionSource}; return inspectGuidedTabsInPage;`)();
    return inspect();
  }, inspectTabsSource);
  const outerCatalog = nestedCatalog.groups.find((group) => group.tabs.some((tab) => tab.label === "关怀(3)"));
  assert(outerCatalog, "内容面板内嵌其它 Tab 时，外层客户概况/关怀组仍必须被识别");
  assert.deepEqual(outerCatalog.tabs.map((tab) => tab.label), ["客户概况", "关怀(3)"], "外层组不得混入票账税等内层 Tab");
  assert.equal(outerCatalog.tabs.find((tab) => tab.label === "关怀(3)")?.defaultCaptured, false, "未打开的关怀必须进入待采集范围");

  await page.setContent(`<!doctype html><html><head><style>.baseline-care{color:#333}</style></head><body>
    <section class="dpl-tabs"><div role="tablist"><div role="tab" class="dpl-tabs-tab">客户概况</div><div role="tab" class="dpl-tabs-tab dpl-tabs-tab-active">关怀(3)</div></div><div class="dpl-tabs-content"><div class="dpl-tabs-tabpane">关怀延迟挂载数据</div></div></section>
  </body></html>`);
  const partialDplSnapshot = await page.evaluate((functionSource) => {
    const capture = new Function(`${functionSource}; return captureGuidedTabPanelInPage;`)();
    return capture([{ id: "outer", tabs: [{ key: "outer:overview", label: "客户概况" }, { key: "outer:care", label: "关怀(3)" }] }]);
  }, guidedPanelSource);
  assert.deepEqual(partialDplSnapshot.captures?.map((item) => item.key), ["outer:care"], "仅挂载当前 DPL 面板时仍必须采集当前外层页签");
  assert.match(partialDplSnapshot.captures?.[0]?.panelHtml || "", /关怀延迟挂载数据/, "延迟挂载面板必须保留实际数据");

  await page.setContent(`<!doctype html><html><body>
    <div class="institution-info-page-tabs"><section class="am-tabs am-tabs-horizontal am-tabs-top">
      <div class="am-tabs-default-bar-content" role="tablist">
        <div id="mobile-overview" class="am-tabs-default-bar-tab am-tabs-default-bar-tab-active" role="tab">客户概况</div>
        <div id="mobile-service" class="am-tabs-default-bar-tab" role="tab">服务信息</div>
        <div id="mobile-operation" class="am-tabs-default-bar-tab" role="tab">经营信息</div>
      </div>
      <div class="am-tabs-content-wrap"><div class="am-tabs-pane-wrap am-tabs-pane-wrap-active" role="tabpanel"></div><div class="am-tabs-pane-wrap" role="tabpanel"></div><div class="am-tabs-pane-wrap" role="tabpanel"></div></div>
    </section></div>
    <div class="institution-info-page-content">客户概况移动端数据</div>
    <div class="toolbar"><button>不是页签的普通按钮</button><button>也不应采集</button></div>
  </body></html>`);
  const mobileCatalog = await page.evaluate((functionSource) => {
    const inspect = new Function(`${functionSource}; return inspectGuidedTabsInPage;`)();
    return inspect();
  }, inspectTabsSource);
  assert.equal(mobileCatalog.groups.length, 1, "Ant Design Mobile 页签应被识别为一个采集组，普通横向按钮不得误入");
  assert.deepEqual(mobileCatalog.tabs.map((tab) => tab.label), ["客户概况", "服务信息", "经营信息"], "移动端页签标签必须按页面顺序保留");
  assert.deepEqual(mobileCatalog.tabs.map((tab) => tab.defaultCaptured), [true, false, false], "仅当前挂载的移动端页签应作为默认已采集页");
  const mobileBaseline = await page.evaluate((functionSource) => {
    const capture = new Function(`${functionSource}; return captureRenderedPageBasic;`)();
    return capture();
  }, basicCaptureSource);
  assert.equal(mobileBaseline.guidedTabState?.groups?.[0]?.activeKey, "yd-guided-tab-group-1:tab-1", "基础抓取必须把移动端当前页签写入默认快照状态");
  assert.match(mobileBaseline.guidedTabState?.snapshots?.[0]?.panelHtml || "", /客户概况移动端数据/, "空 pane 的默认快照必须改为相邻的真实移动端内容区");
  const mobileOverviewSnapshot = await page.evaluate((functionSource) => {
    const capture = new Function(`${functionSource}; return captureGuidedTabPanelInPage;`)();
    return capture([{ id: "yd-guided-tab-group-1", tabs: [{ key: "yd-guided-tab-group-1:tab-1", label: "客户概况" }, { key: "yd-guided-tab-group-1:tab-2", label: "服务信息" }, { key: "yd-guided-tab-group-1:tab-3", label: "经营信息" }] }]);
  }, guidedPanelSource);
  assert.deepEqual(mobileOverviewSnapshot.captures?.map((item) => item.key), ["yd-guided-tab-group-1:tab-1"], "移动端默认页签必须能轻量采集");
  assert.match(mobileOverviewSnapshot.captures?.[0]?.panelHtml || "", /客户概况移动端数据/, "移动端默认页签内容不得丢失");
  await page.evaluate(() => {
    document.querySelector("#mobile-overview").classList.remove("am-tabs-default-bar-tab-active");
    document.querySelector("#mobile-service").classList.add("am-tabs-default-bar-tab-active");
    document.querySelector(".institution-info-page-content").textContent = "服务信息移动端数据";
  });
  const mobileServiceSnapshot = await page.evaluate((functionSource) => {
    const capture = new Function(`${functionSource}; return captureGuidedTabPanelInPage;`)();
    return capture([{ id: "yd-guided-tab-group-1", tabs: [{ key: "yd-guided-tab-group-1:tab-1", label: "客户概况" }, { key: "yd-guided-tab-group-1:tab-2", label: "服务信息" }, { key: "yd-guided-tab-group-1:tab-3", label: "经营信息" }] }]);
  }, guidedPanelSource);
  assert.deepEqual(mobileServiceSnapshot.captures?.map((item) => item.key), ["yd-guided-tab-group-1:tab-2"], "切换后必须按当前移动端页签回填到开始采集时的稳定 key");
  assert.match(mobileServiceSnapshot.captures?.[0]?.panelHtml || "", /服务信息移动端数据/, "切换后的移动端内容必须被实际采集");
  await page.addScriptTag({ content: capturedPageBundle });
  const nestedCapturedSrcdoc = '<!doctype html><html><head><meta name="youdesign-capture-schema" content="2"><meta name="youdesign-captured-from" content="https://example.test/"></head><body><div data-yd-capture-drawer="drawer-1">离线手机内容</div></body></html>';
  const escapedNestedCapturedSrcdoc = nestedCapturedSrcdoc.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const mobileFrameWrapper = `<!doctype html><html><body><iframe class="yd-phone-frame" srcdoc="${escapedNestedCapturedSrcdoc}"></iframe></body></html>`;
  const preservedMobileFrame = await page.evaluate((html) => globalThis.CapturedPageTest.buildCapturedPageAttachment(html), mobileFrameWrapper);
  assert.match(preservedMobileFrame, /class="yd-phone-frame"/, "手机窄框 srcdoc 内含抓取标记时仍必须按普通外层 HTML 原样保留");
  assert.doesNotMatch(preservedMobileFrame, /内嵌区域未捕获/, "srcdoc 属性内的抓取标记不得让外层 iframe 被误判为联网 frame");
  const redirectedFrameHtml = await page.evaluate(() => globalThis.CapturedPageTest.buildCapturedPageAttachment(
    '<!doctype html><html><head><meta name="youdesign-captured-from" content="https://shell.example.test/"></head><body><iframe data-yd-capture-frame-source="https://shell.example.test/declared"></iframe></body></html>',
    { schemaVersion: 2, frames: [{ frameId: 7, parentFrameId: 0, url: "https://redirected.example.test/final", status: "captured", html: "<!doctype html><html><body>重定向后的静态子页</body></html>" }] }
  ));
  assert.match(redirectedFrameHtml, /data-yd-captured-frame="7"/, "旧扩展只有最终 URL 时，单 iframe 仍必须按唯一父子关系挂回静态子页");
  assert.match(redirectedFrameHtml, /重定向后的静态子页/, "重定向子 frame 的实际内容必须进入 srcdoc");
  assert.doesNotMatch(redirectedFrameHtml, /内嵌区域未捕获/, "已采集的重定向子 frame 不得再降级为占位");
  const missingFrameHtml = await page.evaluate(() => globalThis.CapturedPageTest.buildCapturedPageAttachment(
    '<!doctype html><html><body><iframe data-yd-capture-frame-source="https://shell.example.test/missing"></iframe></body></html>',
    { schemaVersion: 2, frames: [] }
  ));
  assert.match(missingFrameHtml, /Chrome 扩展未返回该内嵌页面的静态快照/, "完全没有 frame 元数据时必须给出可诊断提示，不能继续显示笼统安全占位");
  const rebuiltMobileHtml = await page.evaluate(({ html, snapshots }) => globalThis.CapturedPageTest.buildCapturedPageAttachment(html, {
    schemaVersion: 2,
    guidedTabs: {
      groups: [{ id: "yd-guided-tab-group-1", tabs: [
        { key: "yd-guided-tab-group-1:tab-1", label: "客户概况", selected: true, status: "captured" },
        { key: "yd-guided-tab-group-1:tab-2", label: "服务信息", selected: true, status: "captured" },
        { key: "yd-guided-tab-group-1:tab-3", label: "经营信息", selected: false, status: "not-selected" },
      ] }],
      snapshots,
    },
  }), { html: mobileBaseline.html, snapshots: [...mobileOverviewSnapshot.captures, ...mobileServiceSnapshot.captures].map((item) => ({ ...item, capturedAt: "2026-08-01T00:00:00.000Z" })) });
  await page.setContent(rebuiltMobileHtml);
  await page.locator('[data-yd-capture-tab="yd-guided-tab-group-1:tab-2"]').click();
  assert.match(await page.locator('[data-yd-capture-tab-panel="yd-guided-tab-group-1:tab-2"]').innerText(), /服务信息移动端数据/, "离线重建后点击移动端页签必须显示对应的外置内容快照");
  const rebuiltExternalPanelBox = await page.locator('[data-yd-capture-tab-panel="yd-guided-tab-group-1:tab-2"]').evaluate((panel) => ({
    width: panel.getBoundingClientRect().width,
    hostWidth: panel.parentElement.getBoundingClientRect().width,
    minWidth: panel.style.minWidth,
    flex: panel.style.flex,
  }));
  assert.deepEqual(rebuiltExternalPanelBox, { width: rebuiltExternalPanelBox.hostWidth, hostWidth: rebuiltExternalPanelBox.hostWidth, minWidth: "0px", flex: "0 0 100%" }, "外置移动端面板必须归一为完整宿主宽度，且不能以内容固有宽度撑开轨道");
  assert.equal(await page.locator("[data-yd-capture-guided-tab-external-source]").count(), 0, "外置内容被回填后必须移除基线原节点，避免重复显示");

  await page.setContent(`<!doctype html><html><body>
    <div class="customer-main-tabs"><section class="am-tabs am-tabs-horizontal am-tabs-top">
      <div class="am-tabs-default-bar-content" role="tablist">
        <div class="am-tabs-default-bar-tab am-tabs-default-bar-tab-active" role="tab">详情</div>
        <div class="am-tabs-default-bar-tab" role="tab">联系人</div>
        <div class="am-tabs-default-bar-tab" role="tab">跟进记录</div>
      </div>
      <div class="am-tabs-content-wrap"><div class="am-tabs-pane-wrap am-tabs-pane-wrap-active" role="tabpanel"></div><div class="am-tabs-pane-wrap" role="tabpanel"></div><div class="am-tabs-pane-wrap" role="tabpanel"></div></div>
    </section></div>
    <div class="customer-main-content">
      <div class="institution-info-page-tabs"><div class="am-tabs-wrapper"><section class="am-tabs am-tabs-horizontal am-tabs-top">
        <div class="am-tabs-default-bar-content" role="tablist">
          <div id="nested-basic" class="am-tabs-default-bar-tab am-tabs-default-bar-tab-active" role="tab">基本信息</div>
          <div id="nested-overview" class="am-tabs-default-bar-tab" role="tab">客户概况</div>
          <div id="nested-activity" class="am-tabs-default-bar-tab" role="tab">客户活跃</div>
        </div>
        <div class="am-tabs-content-wrap"><div class="am-tabs-pane-wrap am-tabs-pane-wrap-active" role="tabpanel"></div><div class="am-tabs-pane-wrap" role="tabpanel"></div><div class="am-tabs-pane-wrap" role="tabpanel"></div></div>
      </section></div></div>
      <div id="nested-content" class="institution-info-page-content">基本信息真实数据</div>
    </div>
  </body></html>`);
  const nestedMobileCatalog = await page.evaluate((functionSource) => {
    const inspect = new Function(`${functionSource}; return inspectGuidedTabsInPage;`)();
    return inspect();
  }, inspectTabsSource);
  assert.equal(nestedMobileCatalog.groups.length, 2, "详情页中的旧版 Ant Mobile 子页签必须识别成独立嵌套组");
  const nestedMobileBaseline = await page.evaluate((functionSource) => {
    const capture = new Function(`${functionSource}; return captureRenderedPageBasic;`)();
    return capture(true);
  }, basicCaptureSource);
  const outerBaselineSnapshot = nestedMobileBaseline.guidedTabState?.snapshots?.find((item) => item.key === "yd-guided-tab-group-1:tab-1");
  assert.match(outerBaselineSnapshot?.panelHtml || "", /data-yd-capture-guided-tab-panel-host="yd-guided-tab-group-2"/, "外层详情基线必须保留内层页签宿主标记");
  const nestedBasicState = await page.evaluate(({ functionSource, groups }) => {
    const capture = new Function(`${functionSource}; return captureGuidedTabPanelInPage;`)();
    return capture(groups);
  }, { functionSource: guidedPanelSource, groups: nestedMobileCatalog.groups });
  const liveOuterSnapshot = nestedBasicState.captures?.find((item) => item.key === "yd-guided-tab-group-1:tab-1");
  assert.doesNotMatch(liveOuterSnapshot?.panelHtml || "", /data-yd-capture-guided-tab-panel-host=/, "实时外层克隆本身不携带内层离线宿主，不得覆盖已标记基线");
  await page.evaluate(() => {
    document.querySelector("#nested-basic").classList.remove("am-tabs-default-bar-tab-active");
    document.querySelector("#nested-activity").classList.add("am-tabs-default-bar-tab-active");
    document.querySelector("#nested-content").textContent = "客户活跃真实数据";
  });
  const nestedActivityState = await page.evaluate(({ functionSource, groups }) => {
    const capture = new Function(`${functionSource}; return captureGuidedTabPanelInPage;`)();
    return capture(groups);
  }, { functionSource: guidedPanelSource, groups: nestedMobileCatalog.groups });
  const nestedSnapshots = [
    outerBaselineSnapshot,
    nestedBasicState.captures?.find((item) => item.key === "yd-guided-tab-group-2:tab-1"),
    nestedActivityState.captures?.find((item) => item.key === "yd-guided-tab-group-2:tab-3"),
  ].filter(Boolean).map((item) => ({ ...item, capturedAt: "2026-08-01T00:00:00.000Z" }));
  const rebuiltNestedMobileHtml = await page.evaluate(({ html, snapshots }) => globalThis.CapturedPageTest.buildCapturedPageAttachment(html, {
    schemaVersion: 2,
    guidedTabs: {
      groups: [
        { id: "yd-guided-tab-group-1", tabs: [
          { key: "yd-guided-tab-group-1:tab-1", label: "详情", selected: true, status: "captured" },
          { key: "yd-guided-tab-group-1:tab-2", label: "联系人", selected: false, status: "not-selected" },
          { key: "yd-guided-tab-group-1:tab-3", label: "跟进记录", selected: false, status: "not-selected" },
        ] },
        { id: "yd-guided-tab-group-2", tabs: [
          { key: "yd-guided-tab-group-2:tab-1", label: "基本信息", selected: true, status: "captured" },
          { key: "yd-guided-tab-group-2:tab-2", label: "客户概况", selected: false, status: "not-selected" },
          { key: "yd-guided-tab-group-2:tab-3", label: "客户活跃", selected: true, status: "captured" },
        ] },
      ],
      snapshots,
    },
  }), { html: nestedMobileBaseline.html, snapshots: nestedSnapshots });
  await page.setContent(rebuiltNestedMobileHtml);
  assert.equal(await page.locator('[data-yd-capture-tab-group="yd-guided-tab-group-2"][data-yd-capture-tab]').count(), 2, "离线详情面板必须重建已采集的两个子页签");
  await page.locator('[data-yd-capture-tab="yd-guided-tab-group-2:tab-3"]').click();
  assert.match(await page.locator('[data-yd-capture-tab-panel="yd-guided-tab-group-2:tab-3"]').innerText(), /客户活跃真实数据/, "离线点击客户活跃必须显示它自己的子页签快照");
  const unmarkedNestedSnapshots = [
    liveOuterSnapshot,
    nestedBasicState.captures?.find((item) => item.key === "yd-guided-tab-group-2:tab-1"),
    nestedActivityState.captures?.find((item) => item.key === "yd-guided-tab-group-2:tab-3"),
  ].filter(Boolean).map((item) => ({ ...item, capturedAt: "2026-08-01T00:00:00.000Z" }));
  const recoveredNestedMobileHtml = await page.evaluate(({ html, snapshots }) => globalThis.CapturedPageTest.buildCapturedPageAttachment(html, {
    schemaVersion: 2,
    guidedTabs: {
      groups: [
        { id: "yd-guided-tab-group-1", tabs: [
          { key: "yd-guided-tab-group-1:tab-1", label: "详情", selected: true, status: "captured" },
          { key: "yd-guided-tab-group-1:tab-2", label: "联系人", selected: false, status: "not-selected" },
          { key: "yd-guided-tab-group-1:tab-3", label: "跟进记录", selected: false, status: "not-selected" },
        ] },
        { id: "yd-guided-tab-group-2", tabs: [
          { key: "yd-guided-tab-group-2:tab-1", label: "基本信息", selected: true, status: "captured" },
          { key: "yd-guided-tab-group-2:tab-2", label: "客户概况", selected: false, status: "not-selected" },
          { key: "yd-guided-tab-group-2:tab-3", label: "客户活跃", selected: true, status: "captured" },
        ] },
      ],
      snapshots,
    },
  }), { html: nestedMobileBaseline.html, snapshots: unmarkedNestedSnapshots });
  await page.setContent(recoveredNestedMobileHtml);
  assert.equal(await page.locator('[data-yd-capture-tab-group="yd-guided-tab-group-2"][data-yd-capture-tab]').count(), 2, "外层实时快照缺少临时标记时，重建端必须按完整标签组恢复子页签宿主");
  await page.locator('[data-yd-capture-tab="yd-guided-tab-group-2:tab-3"]').click();
  assert.match(await page.locator('[data-yd-capture-tab-panel="yd-guided-tab-group-2:tab-3"]').innerText(), /客户活跃真实数据/, "恢复子页签宿主后点击客户活跃必须显示自己的快照");
  assert.doesNotMatch(await page.locator("body").innerText(), /基本信息真实数据.*客户活跃真实数据/s, "恢复嵌套组后不得遗留原活动内容形成重复面板");

  await page.setContent(`<!doctype html><html><body>
    <section class="dpl-tabs"><div role="tablist"><button role="tab">客户概况</button><button role="tab" class="dpl-tabs-tab-active" aria-selected="true">关怀</button></div>
      <div class="dpl-tabs-content"><div role="tabpanel"><button id="portal-opener" data-yd-drawer-track-opener="portal-track">打开关怀明细</button></div></div>
    </section>
    <aside id="portal-drawer" class="custom-drawer" data-yd-drawer-track-id="portal-track" data-yd-drawer-track-source="observed-click" style="position:fixed;right:0;top:0;width:360px;height:600px">
      <button id="portal-close" aria-label="关闭">×</button><h2>关怀 Portal 明细</h2>
    </aside>
  </body></html>`);
  const portalSnapshot = await page.evaluate((functionSource) => {
    const capture = new Function(`${functionSource}; return captureGuidedTabPanelInPage;`)();
    return capture([{ id: "outer", tabs: [{ key: "outer:overview", label: "客户概况" }, { key: "outer:care", label: "关怀" }] }]);
  }, guidedPanelSource);
  assert.equal(portalSnapshot.drawerSnapshots?.length, 1, "后加载页签的 body Portal 抽屉必须作为独立快照采集");
  const portalDrawerId = portalSnapshot.drawerSnapshots?.[0]?.id;
  assert(portalDrawerId, "Portal 抽屉快照必须具有稳定离线 id");
  assert.match(portalSnapshot.captures?.[0]?.panelHtml || "", new RegExp(`id="portal-opener"[^>]*data-yd-capture-drawer-open="${portalDrawerId}"`), "页签面板内入口必须指向 Portal 抽屉快照");
  assert.match(portalSnapshot.drawerSnapshots?.[0]?.drawerHtml || "", new RegExp(`data-yd-capture-drawer="${portalDrawerId}"[^>]*data-yd-capture-drawer-state="closed"`), "Portal 抽屉合并前必须固定为关闭态");
  assert.doesNotMatch(JSON.stringify(portalSnapshot), /data-yd-drawer-track-(?:id|opener|source|parent)/, "逐页签快照不得泄漏来源页临时跟踪标记");

  await page.addScriptTag({ content: capturedPageBundle });
  const rebuiltPortalHtml = await page.evaluate(({ captured, drawerSnapshots }) => {
    const baseline = `<!doctype html><html><head><title>Portal 抽屉合并</title></head><body>
      <section><div data-yd-capture-guided-tab-key="outer:overview">客户概况</div><div data-yd-capture-guided-tab-key="outer:care">关怀</div>
      <div data-yd-capture-guided-tab-panel-host="outer"><div data-yd-capture-guided-tab-source-panel="outer:overview">客户概况数据</div></div></section>
    </body></html>`;
    return globalThis.CapturedPageTest.buildCapturedPagePreview(baseline, {
      schemaVersion: 2,
      guidedTabs: {
        groups: [{ id: "outer", tabs: [{ key: "outer:overview", label: "客户概况", selected: true, status: "captured" }, { key: "outer:care", label: "关怀", selected: true, status: "captured" }] }],
        snapshots: [
          { key: "outer:overview", panelHtml: "<div>客户概况数据</div>", capturedAt: "2026-07-30T00:00:00.000Z" },
          { key: "outer:care", panelHtml: captured.panelHtml, capturedAt: "2026-07-30T00:00:00.000Z" },
        ],
        drawerSnapshots,
      },
    });
  }, { captured: portalSnapshot.captures[0], drawerSnapshots: portalSnapshot.drawerSnapshots });
  await page.setContent(rebuiltPortalHtml);
  assert.equal(await page.locator(`[data-yd-capture-drawer="${portalDrawerId}"]`).count(), 1, "合并后的 Portal 抽屉只能挂回一次");
  assert.equal(await page.locator(`[data-yd-capture-drawer="${portalDrawerId}"]`).getAttribute("data-yd-capture-drawer-state"), "closed", "Portal 抽屉挂回离线页时必须默认关闭");
  await page.locator('[data-yd-capture-tab="outer:care"]').click();
  await page.locator("#portal-opener").click();
  assert.equal(await page.locator(`[data-yd-capture-drawer="${portalDrawerId}"]`).getAttribute("data-yd-capture-drawer-state"), "open", "切换到后采集页签后必须能打开 Portal 抽屉");
  await page.locator("#portal-close").click();
  assert.equal(await page.locator(`[data-yd-capture-drawer="${portalDrawerId}"]`).getAttribute("data-yd-capture-drawer-state"), "closed", "后采集 Portal 抽屉必须仍可关闭");

  await page.setContent(`<!doctype html><html><head><style>.baseline-care{color:#333}</style></head><body>
    <section class="dpl-tabs"><div role="tablist"><div role="tab" class="dpl-tabs-tab">客户概况</div><div role="tab" class="dpl-tabs-tab dpl-tabs-tab-active">关怀(3)</div></div><div class="dpl-tabs-content"><div class="dpl-tabs-tabpane">关怀延迟挂载数据</div></div></section>
  </body></html>`);
  const baselineStyles = await page.evaluate((functionSource) => {
    const capture = new Function(`${functionSource}; return captureGuidedTabPanelInPage;`)();
    return capture([{ id: "outer", tabs: [{ key: "outer:overview", label: "客户概况" }, { key: "outer:care", label: "关怀(3)" }] }], "signatures", []);
  }, guidedPanelSource);
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = ".lazy-care-table th{background:#f5f6fa;border:1px solid #d9dce4;padding:8px}";
    document.head.append(style);
    document.querySelector(".dpl-tabs-tabpane").innerHTML = '<table class="lazy-care-table"><tbody><tr><th>关怀记录</th></tr></tbody></table>';
  });
  const lazyStyleSnapshot = await page.evaluate(({ functionSource, signatures }) => {
    const capture = new Function(`${functionSource}; return captureGuidedTabPanelInPage;`)();
    return capture(
      [{ id: "outer", tabs: [{ key: "outer:overview", label: "客户概况" }, { key: "outer:care", label: "关怀(3)" }] }],
      "delta",
      signatures
    );
  }, { functionSource: guidedPanelSource, signatures: baselineStyles.styleSignatures });
  assert.match(lazyStyleSnapshot.captures?.[0]?.panelHtml || "", /lazy-care-table/, "延迟挂载的关怀表格 DOM 必须进入页签快照");
  assert.match(lazyStyleSnapshot.styleBlocks?.map((item) => item.cssText).join("\n") || "", /\.lazy-care-table th/, "切换页签后新增的表格样式必须作为增量 CSS 一并采集");
  assert(!lazyStyleSnapshot.styleBlocks?.some((item) => baselineStyles.styleSignatures.includes(item.signature)), "增量样式不得重复采集开始时已存在的样式表");
  const mergedLazyStyleHtml = new Function(`${appendGuidedStylesSource}; return appendGuidedStyleBlocks;`)()(
    "<!doctype html><html><head><title>采集页</title></head><body></body></html>",
    lazyStyleSnapshot.styleBlocks
  );
  assert.match(mergedLazyStyleHtml, /data-yd-captured-guided-css="true"/, "页签增量样式必须进入最终离线 HTML 的 head");
  assert.match(mergedLazyStyleHtml, /\.lazy-care-table th/, "最终离线 HTML 必须实际包含关怀表格样式规则");

  await page.setContent(tabCaptured.html.replace("</head>", `${runtime}</head>`));
  await page.locator("#tab-service").click();
  assert.equal(await page.locator("#tab-service").getAttribute("aria-selected"), "true", "点击 Tab 必须切换激活状态");
  assert.equal(await page.locator("#panel-service").getAttribute("data-yd-capture-tab-panel-state"), "open", "点击 Tab 必须显示对应已采集面板");
  assert.equal(await page.locator("#panel-tax").getAttribute("data-yd-capture-tab-panel-state"), "closed", "切换 Tab 必须隐藏前一个面板");
  await page.locator("#tab-service").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator("#tab-einvoice").getAttribute("aria-selected"), "true", "方向键必须切换到相邻静态 Tab");
  assert.equal(await page.url(), "about:blank", "静态 Tab 切换不得产生真实页面导航");

  await page.setContent(`<!doctype html><html><head><style>
    #tab-viewport{width:240px;overflow:hidden}
    #tab-track{display:flex;width:240px;transform:translate3d(-230px,0,0);transition:transform 480ms cubic-bezier(.2,0,0,1) 40ms}
    #tab-track .am-tabs-default-bar-tab{box-sizing:border-box;flex:0 0 100px;height:40px}
    #panel-track{transition:transform 360ms cubic-bezier(.4,0,.2,1) 25ms}
    [data-yd-capture-tab-panel-state="closed"]{display:none!important}
  </style>${captureRuntimeScriptTag()}</head><body>
    <div id="tab-viewport"><div id="tab-track" class="am-tabs-default-bar-content" role="tablist">
      ${Array.from({ length: 7 }, (_, index) => `<div id="scroll-tab-${index + 1}" class="am-tabs-default-bar-tab${index === 0 ? " am-tabs-default-bar-tab-active" : ""}" data-yd-capture-tab="scroll:${index + 1}" data-yd-capture-tab-group="scroll-group" data-yd-capture-tab-state="${index === 0 ? "open" : "closed"}" aria-selected="${index === 0 ? "true" : "false"}">页签${index + 1}</div>`).join("")}
    </div></div>
    <div id="panel-track" class="am-tabs-content-wrap am-tabs-content-wrap-animated">${Array.from({ length: 7 }, (_, index) => `<section id="scroll-panel-${index + 1}" class="am-tabs-pane-wrap${index === 0 ? " am-tabs-pane-wrap-active" : ""}" data-yd-capture-tab-panel="scroll:${index + 1}" data-yd-capture-tab-group="scroll-group" data-yd-capture-tab-panel-state="${index === 0 ? "open" : "closed"}" aria-hidden="${index === 0 ? "false" : "true"}">内容${index + 1}</section>`).join("")}</div>
  </body></html>`);
  await page.waitForTimeout(30);
  assert.match(await page.locator("#tab-track").getAttribute("style") || "", /translate3d\(0px,\s*0px,\s*0px\)/, "轨道盒宽等于视口但 scrollWidth 更大时，初始化仍必须把首个选中页签复位到可见区域");
  await page.locator("#scroll-tab-7").dispatchEvent("click");
  assert.equal(await page.locator("#scroll-tab-1").evaluate((element) => element.classList.contains("am-tabs-default-bar-tab-active")), false, "切换后必须移除原页签选中样式");
  assert.equal(await page.locator("#scroll-tab-7").evaluate((element) => element.classList.contains("am-tabs-default-bar-tab-active")), true, "切换后必须添加目标页签选中样式");
  assert.equal(await page.locator("#scroll-panel-1").evaluate((element) => element.classList.contains("am-tabs-pane-wrap-active")), false, "切换后必须移除原面板活动样式");
  assert.equal(await page.locator("#scroll-panel-7").evaluate((element) => element.classList.contains("am-tabs-pane-wrap-active")), true, "切换后必须恢复目标面板活动样式");
  assert.match(await page.locator("#tab-track").getAttribute("style") || "", /translate3d\(-\d+px,\s*0px,\s*0px\)/, "选择靠后的页签时旧版 Ant Mobile 轨道必须自动向左滑动");
  const forwardMotion = await page.locator("#scroll-panel-7").evaluate((element) => {
    const animation = typeof element.getAnimations === "function" ? element.getAnimations()[0] : null;
    const timing = animation?.effect?.getTiming?.();
    const keyframes = animation?.effect?.getKeyframes?.() || [];
    return { duration: timing?.duration || 0, delay: timing?.delay || 0, easing: timing?.easing || "", transform: keyframes[0]?.transform || "" };
  });
  assert.deepEqual(forwardMotion, { duration: 360, delay: 25, easing: "cubic-bezier(0.4, 0, 0.2, 1)", transform: "translate3d(12px, 0px, 0px)" }, "向后切换必须复用原轨道时长、延迟、缓动并保持向左进入方向");
  const tabTrackMotion = await page.locator("#tab-track").evaluate((element) => ({ duration: getComputedStyle(element).transitionDuration, delay: getComputedStyle(element).transitionDelay, easing: getComputedStyle(element).transitionTimingFunction }));
  assert.deepEqual(tabTrackMotion, { duration: "0.48s", delay: "0.04s", easing: "cubic-bezier(0.2, 0, 0, 1)" }, "旧版 Ant Mobile 页签轨道必须保留自己的滚动过渡参数");
  await page.locator("#scroll-tab-1").dispatchEvent("click");
  const backwardTransform = await page.locator("#scroll-panel-1").evaluate((element) => element.getAnimations()[0]?.effect?.getKeyframes?.()[0]?.transform || "");
  assert.equal(backwardTransform, "translate3d(-12px, 0px, 0px)", "向前切换必须按原方向从左侧进入");

  await mount();
  await drawerPage.locator("#close-icon").click();
  const clickedDrawerState = await drawerPage.evaluate(() => ({
    url: location.href,
    drawer: document.querySelector("#drawer")?.getAttribute("data-yd-capture-drawer-state") || null,
    mask: document.querySelector("#mask")?.getAttribute("data-yd-capture-drawer-mask-state") || null,
    allClosed: document.documentElement.getAttribute("data-yd-capture-drawer-all-closed"),
  }));
  assert.equal(clickedDrawerState.drawer, "closed", `点击嵌套关闭图标必须关闭抽屉；当前页面 ${clickedDrawerState.url}`);
  assert.equal(clickedDrawerState.mask, "closed", "关闭抽屉必须同步关闭遮罩");
  assert.equal(clickedDrawerState.allClosed, "true", "关闭后必须解除页面滚动锁定状态");
  assert.equal(await drawerPage.url(), "about:blank", "关闭链接式控件不得产生真实页面导航");
  assert.equal(await drawerPage.locator("#opener").getAttribute("aria-expanded"), "false", "关闭抽屉后原入口必须同步折叠状态");
  await drawerPage.locator("#opener-value").click();
  assert.equal(await drawerPage.locator("#drawer").getAttribute("data-yd-capture-drawer-state"), "open", "点击入口内部子节点必须重新打开抽屉");
  assert.equal(await drawerPage.locator("#mask").getAttribute("data-yd-capture-drawer-mask-state"), "open", "重新打开抽屉必须恢复遮罩");
  assert.equal(await drawerPage.url(), "about:blank", "离线重开抽屉不得产生真实导航");
  await drawerPage.locator("#close-icon").click();
  assert.equal(await drawerPage.locator("#drawer").getAttribute("data-yd-capture-drawer-state"), "closed", "抽屉重开后必须能再次关闭");

  await mount();
  await drawerPage.locator("#close").focus();
  await drawerPage.keyboard.press("Enter");
  assert.equal(await drawerPage.locator("#drawer").getAttribute("data-yd-capture-drawer-state"), "closed", "链接式关闭控件按 Enter 必须关闭抽屉");
  await drawerPage.locator("#opener").focus();
  await drawerPage.keyboard.press("Enter");
  assert.equal(await drawerPage.locator("#drawer").getAttribute("data-yd-capture-drawer-state"), "open", "非 button 入口按 Enter 必须重新打开抽屉");

  await mount();
  await drawerPage.locator("#mask").click({ position: { x: 1, y: 1 } });
  assert.equal(await drawerPage.locator("#drawer").getAttribute("data-yd-capture-drawer-state"), "closed", "点击遮罩必须关闭抽屉");

  await mount();
  await drawerPage.keyboard.press("Escape");
  assert.equal(await drawerPage.locator("#drawer").getAttribute("data-yd-capture-drawer-state"), "closed", "Escape 必须关闭最上层抽屉");

  await mountNested();
  await drawerPage.locator("#outer-close").click();
  assert.equal(await drawerPage.locator("#outer").getAttribute("data-yd-capture-drawer-state"), "closed", "关闭父抽屉必须关闭父层");
  assert.equal(await drawerPage.locator("#inner").getAttribute("data-yd-capture-drawer-state"), "closed", "关闭父抽屉必须级联关闭子抽屉");
  await drawerPage.locator("#outer-opener").click();
  assert.equal(await drawerPage.locator("#outer").getAttribute("data-yd-capture-drawer-state"), "open", "父抽屉入口必须可重新打开父层");
  assert.equal(await drawerPage.locator("#inner").getAttribute("data-yd-capture-drawer-state"), "closed", "重开父抽屉不得自动恢复更深层状态");
  await drawerPage.locator("#inner-opener").click();
  assert.equal(await drawerPage.locator("#inner").getAttribute("data-yd-capture-drawer-state"), "open", "子抽屉必须由自己的入口重新打开");

  await page.goto("about:blank");
  await page.addScriptTag({ content: capturedPageBundle });
  const idempotentFrameResult = await page.evaluate(() => {
    const baseline = '<!doctype html><html><head><meta name="youdesign-capture-schema" content="2"></head><body><iframe name="board_page" data-yd-capture-frame-source="https://example.test/board"></iframe></body></html>';
    const meta = {
      schemaVersion: 2,
      frames: [{
        frameId: 7,
        parentFrameId: 0,
        sourceUrl: "https://example.test/board",
        frameName: "board_page",
        url: "https://example.test/board#/loaded",
        status: "captured",
        html: '<!doctype html><html><head><link rel="stylesheet" href="https://unsafe.example.test/live.css"><script>window.__sourceRan=true<\/script></head><body><main>公告看板静态内容</main></body></html>',
      }],
    };
    const once = globalThis.CapturedPageTest.buildCapturedPagePreview(baseline, meta);
    const twice = globalThis.CapturedPageTest.buildCapturedPagePreview(once, meta);
    const parsed = new DOMParser().parseFromString(twice, "text/html");
    const frame = parsed.querySelector('iframe[data-yd-captured-frame="7"]');
    return {
      hasFrame: Boolean(frame),
      hasSrc: Boolean(frame?.hasAttribute("src")),
      srcdoc: frame?.getAttribute("srcdoc") || "",
      placeholder: parsed.body.textContent?.includes("内嵌区域未捕获") || false,
    };
  });
  assert.equal(idempotentFrameResult.hasFrame, true, "抓取页二次离线重建必须保留第一次生成的纯 srcdoc iframe");
  assert.equal(idempotentFrameResult.hasSrc, false, "幂等重建后的 iframe 不得恢复联网 src");
  assert.equal(idempotentFrameResult.placeholder, false, "二次离线重建不得把已捕获 srcdoc 替换成占位");
  assert.match(idempotentFrameResult.srcdoc, /公告看板静态内容/, "二次离线重建必须保留子文档内容");
  assert.doesNotMatch(idempotentFrameResult.srcdoc, /unsafe\.example\.test|__sourceRan/, "保留 srcdoc 前仍必须重新剥离来源脚本和联网样式");
} finally {
  await browser.close();
}

console.log("capture drawer runtime regression: ok");
