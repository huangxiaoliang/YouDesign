#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  applyMultiFragmentClaudeResult,
  definitionNames,
  formatMultiFragmentTask,
  multiFragmentManifestForClaude,
  prepareMultiFragmentClaudeJob,
  scanCssRules,
  scanHtmlElements,
  scanJsTopLevelStatements,
} = require("../desktop/claude-fragment-utils.cjs");

const focusFor = (html, scopeHtml, targetHtml = scopeHtml) => {
  const start = html.indexOf(scopeHtml);
  return {
    source: "auto-locate",
    targetHtml,
    scopeStart: start,
    scopeEnd: start + scopeHtml.length,
    scopeTag: /^<([a-z]+)/i.exec(scopeHtml)?.[1] || "section",
    scopeHtml,
  };
};

const contract = {
  pageArchetype: "客户列表页",
  primaryUser: "客户经理",
  primaryJob: "查看客户详情",
  mustHave: ["客户列表"],
  interactions: [
    {
      priority: "must",
      trigger: "点击查看详情",
      result: "打开客户详情抽屉",
      proof: "右侧出现客户详情抽屉",
    },
  ],
  requiredStates: ["抽屉打开态"],
  assumptions: [],
};

{
  const scope = '<button id="detailBtn" aria-controls="drawer">查看详情</button>';
  const html = `<!doctype html><html><head><title>客户列表</title><style>:root{--drawer-fg:#333}.drawer{width:420px;color:var(--drawer-fg)}</style></head><body><main id="root"><h1>客户列表</h1>${scope}<aside id="drawer" class="drawer" hidden><h2>客户详情</h2></aside></main><script>// customer data\nconst customerData={name:"客户A"}; /* renderer */\nfunction renderDrawer(data){document.getElementById("drawer").textContent=data.name;} // direct handler\nfunction openDrawer(){renderDrawer(customerData);document.getElementById("drawer").hidden=false;} document.getElementById("detailBtn").addEventListener("click",openDrawer);</script></body></html>`;
  const prepared = prepareMultiFragmentClaudeJob(html, focusFor(html, scope), "点击查看详情打开客户抽屉，并把抽屉宽度改为560px", {
    interactiveEdit: true,
    prototypeContract: contract,
  });
  assert.equal(prepared.multiFragment, true, prepared.reason);
  const fragments = prepared.plan.fragments;
  assert(fragments.some((fragment) => fragment.type === "html" && fragment.role === "overlay"), "必须提取 drawer HTML");
  assert(fragments.some((fragment) => fragment.type === "css" && fragment.selector === ".drawer" && fragment.editable), "必须提取可写 drawer CSS");
  assert(fragments.some((fragment) => fragment.type === "css" && fragment.role === "css-variable-context" && !fragment.editable), "CSS 变量定义必须作为只读上下文");
  assert(fragments.some((fragment) => fragment.type === "js" && fragment.selector === "openDrawer"), "必须提取直接 handler");
  assert(
    fragments.some((fragment) => fragment.type === "js" && fragment.selector === "customerData" && !fragment.editable),
    "未要求改数据时，直接数据源必须只读"
  );
  const task = formatMultiFragmentTask(prepared.plan);
  assert.match(task, /manifest\.json as the single source of truth/);
  assert.doesNotMatch(task, /Dependencies:|Prototype Contract checks:|selector=/, "TASK 不得复制 manifest 明细");
  assert(Buffer.byteLength(task) < 600, "多片段 TASK 应保持为短索引");

  const files = new Map(fragments.map((fragment) => [fragment.file, fragment.content]));
  const css = fragments.find((fragment) => fragment.type === "css" && fragment.selector === ".drawer");
  files.set(css.file, css.content.replace("420px", "560px"));
  const applied = applyMultiFragmentClaudeResult(html, prepared.plan, files, { interactiveEdit: true });
  assert.equal(applied.ok, true, applied.reason);
  assert.match(applied.html, /width:560px/);
  assert.match(applied.html, /function openDrawer/);

  const readonly = fragments.find((fragment) => !fragment.editable);
  const tamperedFiles = new Map(files);
  tamperedFiles.set(readonly.file, `${readonly.content}\n:root{--bad:red}`);
  assert.match(applyMultiFragmentClaudeResult(html, prepared.plan, tamperedFiles).reason, /只读 fragment 被修改/);

  const shifted = html.replace("<h1>客户列表</h1>", "<h1>全部客户</h1>");
  assert.match(applyMultiFragmentClaudeResult(shifted, prepared.plan, files).reason, /原页面 hash 已变化/);

  const badCssFiles = new Map(files);
  badCssFiles.set(css.file, ".drawer{width:560px");
  assert.match(applyMultiFragmentClaudeResult(html, prepared.plan, badCssFiles).reason, /CSS fragment 语法不完整/);

  const handler = fragments.find((fragment) => fragment.type === "js" && fragment.selector === "openDrawer");
  const brokenInteraction = new Map(files);
  brokenInteraction.set(handler.file, "function openDrawer(){ console.log('opened'); }");
  const renderer = fragments.find((fragment) => fragment.type === "js" && fragment.selector === "renderDrawer");
  brokenInteraction.set(renderer.file, "function renderDrawer(){ console.log('rendered'); }");
  assert.match(applyMultiFragmentClaudeResult(html, prepared.plan, brokenInteraction).reason, /Prototype Contract/);

  const missingFiles = new Map(files);
  missingFiles.delete(css.file);
  assert.match(applyMultiFragmentClaudeResult(html, prepared.plan, missingFiles).reason, /fragment 文件缺失/);
}

{
  const scope = '<button id="openBtn" aria-controls="drawer">打开详情</button>';
  const html = `<!doctype html><html><head><title>静态页面</title></head><body><main id="root">${scope}<aside id="drawer" class="drawer" hidden>详情内容</aside></main></body></html>`;
  const prepared = prepareMultiFragmentClaudeJob(html, focusFor(html, scope), "点击打开详情时展示抽屉，并增加阴影样式", {
    interactiveEdit: true,
  });
  assert.equal(prepared.multiFragment, true, prepared.reason);
  const cssInsertion = prepared.plan.fragments.find((fragment) => fragment.role === "css-insertion");
  const jsInsertion = prepared.plan.fragments.find((fragment) => fragment.role === "js-insertion");
  assert(cssInsertion && jsInsertion, "静态页面必须生成受控 CSS/JS 插入 fragment");
  const files = new Map(prepared.plan.fragments.map((fragment) => [fragment.file, fragment.content]));
  files.set(cssInsertion.file, ".drawer{box-shadow:0 8px 24px rgba(0,0,0,.16)}");
  files.set(
    jsInsertion.file,
    'document.getElementById("openBtn").addEventListener("click",function(){document.getElementById("drawer").hidden=false;});'
  );
  const applied = applyMultiFragmentClaudeResult(html, prepared.plan, files, { interactiveEdit: true });
  assert.equal(applied.ok, true, applied.reason);
  assert.match(applied.html, /<style>[\s\S]*box-shadow/);
  assert.match(applied.html, /<script>[\s\S]*addEventListener/);

  const navigationFiles = new Map(files);
  navigationFiles.set(jsInsertion.file, 'document.getElementById("openBtn").onclick=function(){window.location.href="/detail";}');
  assert.match(applyMultiFragmentClaudeResult(html, prepared.plan, navigationFiles).reason, /真实页面导航/);
}

{
  const scope = '<button data-target=".detail-drawer">详情</button>';
  const html = `<!doctype html><html><head><title>详情</title><style>@media (max-width:800px){.detail-drawer{width:90vw}}</style></head><body><main id="root">${scope}<aside class="detail-drawer" hidden>详情抽屉</aside></main></body></html>`;
  const prepared = prepareMultiFragmentClaudeJob(html, focusFor(html, scope), "把详情抽屉宽度调整为80vw", {});
  assert.equal(prepared.multiFragment, true, prepared.reason);
  assert(
    prepared.plan.fragments.some(
      (fragment) => fragment.role === "overlay" && fragment.selector === "aside.detail-drawer"
    ),
    "data-target=.class 必须提取唯一 drawer"
  );
  assert(
    prepared.plan.fragments.some(
      (fragment) => fragment.type === "css" && fragment.contextPath.includes("@media (max-width:800px)")
    ),
    "相关 CSS 必须保留 media query 上下文"
  );
  assert.equal(
    prepared.plan.fragments.some((fragment) => fragment.role === "js-insertion"),
    false,
    "只改 drawer 宽度不得误判成交互任务并插入脚本"
  );

  const compositeInstruction =
    '在最近跟进时间的筛选后面，加一个"最近跟进联系人”，输入框展示"请输入手机号/姓名”。在列表的最后跟进时间后面，新增一列”最近跟进联系人”，列表数据展示格式：姓名（手机号），造一些数据。';
  const filterAnchor = '<div class="ssp-item-wrapper"><label for="lastFollowTime" title="最近跟进时间">最近跟进时间</label><input placeholder="开始日期"></div>';
  const targetHtml = `<!doctype html><html><head><title>复合列表</title></head><body><form>${filterAnchor}<div class="ssp-item-wrapper"><label for="businessAction">经营动作</label></div></form><div class="better-table-wrapper"><div class="header-scroll"><table style="width:240px"><colgroup><col style="width:120px"><col style="width:120px"></colgroup><thead><tr><th>客户经理</th><th>最后跟进时间</th></tr></thead></table></div><div class="body-scroll"><table style="width:240px"><colgroup><col style="width:120px"><col style="width:120px"></colgroup><tbody><tr data-row-key="1"><td>张经理</td><td>2026-07-20</td></tr><tr data-row-key="2"><td>李经理</td><td>2026-07-21</td></tr></tbody></table></div></div></body></html>`;
  const composite = prepareMultiFragmentClaudeJob(
    targetHtml,
    { source: "auto-locate", plan: "operation=insert；scope=page；batch=yes；needsFullPage=yes" },
    compositeInstruction,
    {}
  );
  assert.equal(composite.multiFragment, true, composite.reason);
  assert.equal(composite.plan.kind, "composite-filter-table");
  assert.equal(composite.plan.fragments.length, 3, "复合任务应提取筛选兄弟插入片段、只读锚点和完整表格区");
  assert.deepEqual(
    composite.plan.fragments.map((fragment) => fragment.role),
    ["filter-control-insert", "filter-anchor-context", "table-region"]
  );
  assert.equal(composite.plan.fragments.filter((fragment) => fragment.editable).length, 2);
  assert.equal(composite.plan.taskHints.headerCellIndex, 1);
  assert.equal(composite.plan.taskHints.headerCellCount, 2);
  assert.equal(composite.plan.taskHints.bodyRowCount, 2);
  assert.equal(composite.plan.taskHints.splitHeaderBodyTables, true);
  const compositeManifest = multiFragmentManifestForClaude(composite.plan);
  assert.equal(compositeManifest.kind, "composite-filter-table");
  assert.equal(compositeManifest.taskHints.tableAnchorText, "最后跟进时间");
  assert.match(formatMultiFragmentTask(composite.plan), /atomic filter-and-table transaction/);
  assert.match(formatMultiFragmentTask(composite.plan), /complete sibling wrapper/);
  assert.match(formatMultiFragmentTask(composite.plan), /dpl-input-affix-wrapper/);

  const compositeFiles = new Map(composite.plan.fragments.map((fragment) => [fragment.file, fragment.content]));
  const filterFragment = composite.plan.fragments.find((fragment) => fragment.role === "filter-control-insert");
  const filterAnchorContext = composite.plan.fragments.find((fragment) => fragment.role === "filter-anchor-context");
  const tableFragment = composite.plan.fragments.find((fragment) => fragment.role === "table-region");
  assert.equal(filterFragment.operation, "insert");
  assert.equal(filterFragment.content, "");
  assert.equal(filterAnchorContext.editable, false);
  compositeFiles.set(
    filterFragment.file,
    '<div class="ssp-item-wrapper"><label for="lastFollowContact">最近跟进联系人</label><span class="dpl-input-affix-wrapper" style="width:220px"><input class="dpl-input" placeholder="请输入手机号/姓名"></span></div>'
  );
  assert.match(
    applyMultiFragmentClaudeResult(targetHtml, composite.plan, compositeFiles).reason || "",
    /复合事务未完成全部可写片段：table-region/,
    "只改筛选区时必须整笔拒绝，不能产生半成品"
  );
  let editedTable = tableFragment.content
    .replace("<th>最后跟进时间</th>", "<th>最后跟进时间</th><th>最近跟进联系人</th>")
    .replaceAll("</colgroup>", '<col style="width:160px"></colgroup>')
    .replaceAll('style="width:240px"', 'style="width:400px"')
    .replace("<td>2026-07-20</td>", "<td>2026-07-20</td><td>张三（13800138000）</td>")
    .replace("<td>2026-07-21</td>", "<td>2026-07-21</td><td>李四（13900139000）</td>");
  compositeFiles.set(tableFragment.file, editedTable);
  const compositeApplied = applyMultiFragmentClaudeResult(targetHtml, composite.plan, compositeFiles);
  assert.equal(compositeApplied.ok, true, compositeApplied.reason);
  assert.match(compositeApplied.html, /请输入手机号\/姓名/);
  assert.match(
    compositeApplied.html,
    /placeholder="开始日期"><\/div><div class="ssp-item-wrapper"><label for="lastFollowContact"/,
    "新增筛选项必须作为原 wrapper 的兄弟节点插入"
  );
  assert.match(compositeApplied.html, /最近跟进联系人<\/th>/);
  assert.equal((compositeApplied.html.match(/（1\d{10}）/g) || []).length, 2);

  const invalidFilterFiles = new Map(compositeFiles);
  invalidFilterFiles.set(
    filterFragment.file,
    '<div class="dpl-fast-form-item"><label for="lastFollowContact">最近跟进联系人</label><input placeholder="请输入手机号/姓名"></div>'
  );
  assert.match(
    applyMultiFragmentClaudeResult(targetHtml, composite.plan, invalidFilterFiles).reason || "",
    /缺少布局类.*ssp-item-wrapper/,
    "缺少筛选网格 wrapper 的插入结果必须拒绝"
  );

  const doubleInputStyleFiles = new Map(compositeFiles);
  doubleInputStyleFiles.set(
    filterFragment.file,
    '<div class="ssp-item-wrapper"><label for="lastFollowContact">最近跟进联系人</label><span class="dpl-input" style="width:200px"><input class="dpl-input" placeholder="请输入手机号/姓名"></span></div>'
  );
  assert.match(
    applyMultiFragmentClaudeResult(targetHtml, composite.plan, doubleInputStyleFiles).reason || "",
    /外层不能复用 dpl-input.*dpl-input-affix-wrapper/,
    "外层和 input 同时使用 dpl-input 导致视觉双输入框时必须拒绝"
  );

  const duplicateFilterTarget = targetHtml.replace("<form>", `<form>${filterAnchor}`);
  const duplicateFilterComposite = prepareMultiFragmentClaudeJob(
    duplicateFilterTarget,
    { source: "auto-locate", plan: "operation=insert；scope=page；batch=yes；needsFullPage=yes" },
    compositeInstruction,
    {}
  );
  assert.equal(duplicateFilterComposite.multiFragment, false, "筛选锚点不唯一时必须退回完整页面");
  assert.match(duplicateFilterComposite.reason, /筛选项标签.*命中 2 处/);

  const mismatchedRowsTarget = targetHtml.replace("<td>李经理</td><td>2026-07-21</td>", "<td>李经理</td>");
  const mismatchedRowsComposite = prepareMultiFragmentClaudeJob(
    mismatchedRowsTarget,
    { source: "auto-locate", plan: "operation=insert；scope=page；batch=yes；needsFullPage=yes" },
    compositeInstruction,
    {}
  );
  assert.equal(mismatchedRowsComposite.multiFragment, false, "表体行列数不一致时必须退回完整页面");
  assert.match(mismatchedRowsComposite.reason, /各行列数不一致|无法定位与目标表头对齐/);

  const batch = prepareMultiFragmentClaudeJob(
    html,
    { ...focusFor(html, scope), plan: "operation=style；batch=yes；needsFullPage=no" },
    "批量调整详情抽屉",
    {}
  );
  assert.equal(batch.multiFragment, false, "batch=yes 必须继续走完整页面");
}

{
  assert.equal(scanHtmlElements('<section><button id="x">按钮</button></section>').some((node) => node.attrs.id === "x"), true);
  assert.equal(scanCssRules('@media (max-width:600px){.x{color:red}}').ok, true);
  assert.equal(scanJsTopLevelStatements('const data={x:1}; function open(){return data.x;}').ok, true);
  const commented = scanJsTopLevelStatements(
    '// first handler\nfunction first(){return 1}\n/* second handler */\nfunction second(){return 2}\n// data source\nconst data={x:1};'
  );
  assert.equal(commented.ok, true);
  assert.equal(commented.statements.length, 3, "函数前置注释不得把多个顶层函数粘成一个超大语句");
  assert.deepEqual(commented.statements.map((statement) => definitionNames(statement.content)[0]), ["first", "second", "data"]);
  assert.match(commented.statements[0].content, /^\/\/ first handler/, "前置注释必须留在原函数片段中以便原字节回填");
}

console.log("desktop Claude fragment tests passed");
