#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  analyzePreparedHtmlSizeForClaude,
  analyzeScopedClaudeSafety,
  applyScopedClaudeResult,
  buildClaudeFocusSection,
  buildTaskRelevantProjectionForClaude,
  buildScopedCompletionChecklist,
  buildRelevantHtmlSnippets,
  compactDataUrisForClaude,
  diffStats,
  extractClaudeAlreadySatisfied,
  extractClaudeClarification,
  expandDataUrisForClaude,
  expandImmutableRegionsForClaude,
  formatScopedCompletionChecklist,
  guardDeletedIdScriptRefs,
  prepareScopedClaudeJob,
  resolveClaudeHtmlInput,
  validateAssetPlaceholdersForClaude,
  validateClaudeHtml,
  validateImmutablePlaceholdersForClaude,
  validateScopedCompletion,
} = require("../desktop/claude-html-utils.cjs");
const {
  isChildProcessRunning,
  scheduleChildProcessForceKill,
  sha256Text,
  terminateChildProcess,
  terminateChildProcessTree,
} = require("../desktop/desktop-utils.cjs");
const {
  CLAUDE_JOB_CANCELLED_CODE,
  CLAUDE_JOB_OWNER,
  ClaudeJobQueue,
  cleanupClaudeJobDirs,
  createAsyncFileAppender,
  summarizeClaudeApiFailure,
  writeClaudeJobStatus,
} = require("../desktop/claude-runtime-utils.cjs");

{
  const summary = summarizeClaudeApiFailure({
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: 502,
    terminal_reason: "api_error",
    stop_reason: "stop_sequence",
    result: "API Error: 502 请求转发失败: 上游请求失败",
  });
  assert.match(summary, /模型服务请求失败（HTTP 502）/);
  assert.match(summary, /上游请求失败/);
  assert.match(summary, /稍后重试/);
  assert.doesNotMatch(summary, /stop_sequence/, "API 错误不得被通用 stop_reason 遮蔽");
  assert.equal(summarizeClaudeApiFailure({ stop_reason: "stop_sequence" }), "", "正常停止原因不得误报成 API 失败");
}

const html = (body, head = "<title>Prototype</title>") =>
  `<!doctype html><html><head>${head}</head><body><main id="root">${body}</main></body></html>`;

{
  const typescript = require("typescript");
  const scopeSource = fs.readFileSync(path.join(projectRoot, "src/lib/pipeline/htmlScopePatch.ts"), "utf8");
  const scopeModuleSource = typescript.transpileModule(scopeSource, {
    compilerOptions: { module: typescript.ModuleKind.ES2022, target: typescript.ScriptTarget.ES2022 },
  }).outputText;
  const scopeModule = await import(`data:text/javascript;base64,${Buffer.from(scopeModuleSource).toString("base64")}`);
  const targetTab = '<div role="tab" aria-selected="false" class="dpl-tabs-tab">合规</div>';
  const firstGroup = `<div id="core-tabs" class="dpl-tabs"><div class="dpl-tabs-bar"><div class="dpl-tabs-nav">${targetTab}</div></div><div class="dpl-tabs-content"><div role="tabpanel" aria-hidden="false">合规内容</div></div></div>`;
  const secondGroup = '<div id="other-tabs" class="dpl-tabs"><div role="tab">其它</div><div role="tabpanel">其它内容</div></div>';
  const scoped = scopeModule.selectHtmlPatchScope(
    `${firstGroup}${secondGroup}`,
    targetTab,
    "在合规页签右边新增AI功能页签，点击后展示AI会计、AI开票"
  );
  assert.equal(scoped.tag, "div");
  assert.match(scoped.reason, /完整页签组/);
  assert.match(scoped.html, /id="core-tabs"/);
  assert.match(scoped.html, /role="tabpanel"/);
  assert.doesNotMatch(scoped.html, /id="other-tabs"/, "页签 scope 不得扩到相邻页签组");

  // selectDedupScope：点选去重应上扩到含全部重复项的容器，而非单卡。
  const dupCard = '<div class="card"><h3>张三</h3><p>13800000000</p></div>';
  const otherCard = '<div class="card"><h3>李四</h3><p>13900000000</p></div>';
  const contactsSection = `<section class="contacts"><h2>联系人</h2>${dupCard}${dupCard}${otherCard}</section>`;
  const dedupScoped = scopeModule.selectDedupScope(html(contactsSection), dupCard);
  assert.equal(dedupScoped.tag, "section", "去重 scope 应上扩到 contacts 容器");
  assert.match(dedupScoped.reason, /去重：已上扩到含 2 个重复项的 <section> 容器/);
  assert.match(dedupScoped.html, /张三[\s\S]*张三[\s\S]*李四/, "去重 scope 必须覆盖全部三张卡片");
  const distinctSection = `<section class="contacts"><h2>联系人</h2>${dupCard}<div class="card"><h3>李四</h3><p>13900000000</p></div><div class="card"><h3>王五</h3><p>13700000000</p></div></section>`;
  const dedupMiss = scopeModule.selectDedupScope(html(distinctSection), dupCard);
  assert.ok("error" in dedupMiss && /未在锚点祖先链发现重复项/.test(dedupMiss.error), "无重复项时应返回 error 交回退路径");

  // plan 驱动路径：传入 editPlan 时用 scopeHint/operation/batch 驱动上提，与正则路径产出相同 reason。
  const planScoped = scopeModule.selectHtmlPatchScope(
    `${firstGroup}${secondGroup}`,
    targetTab,
    "随便改改",
    undefined,
    { operation: "insert", scopeHint: "tab", batch: false }
  );
  assert.match(planScoped.reason, /完整页签组/, "plan.scopeHint=tab 必须上提到完整页签组，reason 与正则路径一致");
  assert.match(planScoped.html, /id="core-tabs"/);

  // plan.scopeHint=tabs（复数）也必须命中 tab 上提（startsWith 容忍，非精确 ===）
  const planTabsScoped = scopeModule.selectHtmlPatchScope(
    `${firstGroup}${secondGroup}`,
    targetTab,
    "随便改改",
    undefined,
    { operation: "insert", scopeHint: "tabs", batch: false }
  );
  assert.match(planTabsScoped.reason, /完整页签组/, "plan.scopeHint=tabs 复数形式也应命中页签上提");

  // plan.operation=move 应上提到含多个同类兄弟的父级（与正则 removeOrMove 路径同 reason 形态）
  const moveItem = '<li class="item">第三项</li>';
  const moveList = `<ul class="list"><li class="item">第一项</li><li class="item">第二项</li>${moveItem}</ul>`;
  const moveScoped = scopeModule.selectHtmlPatchScope(html(moveList), moveItem, "挪一下", undefined, {
    operation: "move",
    scopeHint: "list",
    batch: false,
  });
  assert.match(moveScoped.reason, /删除\/移动：已上提到 <ul> 作用域（含多个 <li> 兄弟）/, "plan.operation=move 必须上提到兄弟父级");

  // plan.operation=insert（无方位词、无“新增”关键词口语）应触发 insertionScopeIntent 上提到语义容器
  const insertItem = '<li class="item">第三项</li>';
  const insertList = `<ul class="list"><li class="item">第一项</li><li class="item">第二项</li>${insertItem}</ul>`;
  const insertScoped = scopeModule.selectHtmlPatchScope(html(insertList), insertItem, "补一个", undefined, {
    operation: "insert",
    scopeHint: "list",
    batch: false,
  });
  assert.match(insertScoped.reason, /已扩大到 <ul> 作用域/, "plan.operation=insert 必须触发 insertionScopeIntent 扩大到语义容器");

  // plan.batch=true 应上提到含多个同类兄弟的祖先
  const batchScoped = scopeModule.selectHtmlPatchScope(html(moveList), moveItem, "所有项加边框", undefined, {
    operation: "restyle",
    scopeHint: "list",
    batch: true,
  });
  assert.match(batchScoped.reason, /批量：已上提到 <ul> 作用域（含多个 <li>）/, "plan.batch=true 必须上提到兄弟祖先");

  // plan.batch=false 且指令无批量词 -> 不触发批量上提，落锚点自身（不会被 plan 压制正则之外的副作用）
  const nonBatchScoped = scopeModule.selectHtmlPatchScope(html(moveList), moveItem, "加粗", undefined, {
    operation: "restyle",
    scopeHint: "list",
    batch: false,
  });
  assert.equal(nonBatchScoped.tag, "li", "plan.batch=false 且无批量词时落锚点自身");
}

{
  assert.match(
    extractClaudeClarification(
      "YD_NEEDS_CLARIFICATION: 当前范围不包含“合规”页签，请确认是否改走完整页面？",
      "有疑问先问我"
    ),
    /当前范围不包含“合规”页签/,
    "结构化澄清标记必须被桌面桥识别"
  );
  assert.match(
    extractClaudeClarification("当前 scope 与需求不匹配，请确认是否重新圈定？", "有疑问先问我"),
    /请确认/,
    "无标记但明确请求确认的旧版 Claude 输出应兼容识别"
  );
  assert.equal(extractClaudeClarification("已检查页面，未做修改。", "调整页面"), "", "普通空改不得伪装成澄清");
  assert.match(
    extractClaudeAlreadySatisfied(
      "The current index.html already fully satisfies the requested change, so I left index.html unchanged to avoid a duplicate tab.",
      "在合规右边增加AI功能页签"
    ),
    /already fully satisfies/,
    "需求已经满足的空改必须被识别为正常终态"
  );
  assert.equal(
    extractClaudeAlreadySatisfied("当前页面已经满足需求，保持不变。", "没有改好，重新修改"),
    "",
    "用户明确否定当前效果时不得判成已满足"
  );
}

assert.equal(
  sha256Text("abc"),
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "preload SHA-256 fallback 必须与标准结果一致"
);

{
  const focus = {
    source: "auto-locate",
    plan: "operation=style；scope=section",
    targetOffset: 120,
    scopeStart: 100,
    scopeEnd: 240,
    scopeTag: "section",
    targetHtml: '<button id="detailBtn">查看详情</button>',
    scopeHtml: '<section><button id="detailBtn">查看详情</button></section>',
  };
  const full = buildClaudeFocusSection(focus, false);
  assert.match(full, /Target HTML Excerpt/);
  assert.match(full, /Target Scope Excerpt/);
  const materialized = buildClaudeFocusSection(focus, false, { includeExcerpts: false });
  assert.match(materialized, /Edit plan: operation=style/);
  assert.match(materialized, /Target offset: 120/);
  assert.doesNotMatch(materialized, /Target HTML Excerpt|Target Scope Excerpt|detailBtn/, "任务文件已有焦点内容时 TASK 不得重复嵌入 HTML");
}

{
  const scope = `<table><thead><tr><th>活动名称</th><th>操作</th></tr></thead><tbody><tr><td>测试活动</td><td>查看</td></tr></tbody></table>`;
  const plan = "operation=insert；scope=table；replacement=关联成本归届、合计金额（元）、剩余金额（元）、可用金额（元）";
  const checklist = buildScopedCompletionChecklist("在活动列表新增列，字段为：关联成本归届、合计金额（元）、剩余金额（元）、可用金额（元）", scope, plan);
  assert.deepEqual(checklist.requiredHeaderTexts, ["关联成本归届", "合计金额（元）", "剩余金额（元）", "可用金额（元）"]);
  assert.equal(checklist.requiresWideTableLayout, true, "一次新增多列表头时必须启用宽表格布局要求");
  assert.match(
    formatScopedCompletionChecklist(checklist),
    /overflow-x:auto.*instead of squeezing/,
    "桌面 Claude 任务必须要求扩展表宽并开启横向滚动"
  );
  assert.equal(validateScopedCompletion(checklist, scope).ok, false, "缺少新增表头时不得报告 Claude 任务成功");
  const completed = scope
    .replace("<th>操作</th>", "<th>关联成本归届</th><th>合计金额（元）</th><th>剩余金额（元）</th><th>可用金额（元）</th><th>操作</th>")
    .replace("<td>查看</td>", "<td>华东成本中心</td><td>10000.00</td><td>3000.00</td><td>7000.00</td><td>查看</td>");
  assert.equal(validateScopedCompletion(checklist, completed).ok, true, "全部新增表头写入后应通过完成校验");

  const originalWithCols = `<table style="width:300px"><colgroup><col style="width:100px"><col style="width:100px"><col style="width:100px"></colgroup><thead><tr><th>活动名称</th><th>状态</th><th>操作</th></tr></thead><tbody><tr><td>测试活动</td><td>已结束</td><td>查看</td></tr></tbody></table>`;
  const brokenGeometry = originalWithCols
    .replace("<th>操作</th>", "<th>关联成本归届</th><th>合计金额（元）</th><th>剩余金额（元）</th><th>可用金额（元）</th><th>操作</th>")
    .replace("<td>查看</td>", "<td>华东成本中心</td><td>10000.00</td><td>3000.00</td><td>7000.00</td><td>查看</td>");
  assert.match(
    validateScopedCompletion(checklist, brokenGeometry).reason || "",
    /表头共 7 列.*colgroup 仍为 3 列/,
    "新增表头后未同步 colgroup 时必须拒绝挤压变形结果"
  );
  const fixedGeometry = brokenGeometry
    .replace('style="width:300px"', 'style="width:860px"')
    .replace(
      "</colgroup>",
      '<col style="width:140px"><col style="width:140px"><col style="width:140px"><col style="width:140px"></colgroup>'
    );
  assert.equal(validateScopedCompletion(checklist, fixedGeometry).ok, true, "同步 colgroup 与表格宽度后应通过完成校验");
}

{
  const instruction =
    '在最近跟进时间的筛选后面，加一个"最近跟进联系人”，输入框展示"请输入手机号/姓名”。在列表的最后跟进时间后面，新增一列”最近跟进联系人”，列表数据展示格式：姓名（手机号），造一些数据。';
  const plan = "operation=insert；scope=page；replacement=最近跟进联系人；batch=yes；needsFullPage=yes";
  const original = `<form><label>最近跟进时间</label></form><table><thead><tr><th>最后跟进时间</th></tr></thead><tbody><tr><td>2026-07-20</td></tr></tbody></table>`;
  const checklist = buildScopedCompletionChecklist(instruction, original, plan);
  assert.deepEqual(checklist.requiredHeaderTexts, ["最近跟进联系人"]);
  assert.deepEqual(checklist.requiredInputPlaceholders, ["请输入手机号/姓名"]);
  assert.deepEqual(checklist.requiredTableCellFormats, ["name-phone"]);
  assert.deepEqual(
    buildScopedCompletionChecklist(
      "添加最近跟进联系人输入框，占位文本为'请输入手机号/姓名'",
      original,
      plan
    ).requiredInputPlaceholders,
    ["请输入手机号/姓名"],
    "占位文本措辞也必须进入完成清单"
  );
  const filterOnly = original.replace(
    "</form>",
    '<label>最近跟进联系人</label><input placeholder="请输入手机号/姓名"></form>'
  );
  assert.match(validateScopedCompletion(checklist, filterOnly).reason || "", /缺少目标表头/);
  const withHeader = filterOnly
    .replace("</tr></thead>", "<th>最近跟进联系人</th></tr></thead>")
    .replace("</tr></tbody>", "<td>张三</td></tr></tbody>");
  assert.match(validateScopedCompletion(checklist, withHeader).reason || "", /第 1 行缺少.*姓名（11位手机号）/);
  const completed = withHeader.replace("<td>张三</td>", "<td>张三（13800138000）</td>");
  assert.equal(validateScopedCompletion(checklist, completed).ok, true, "筛选项、表头和列表模拟数据齐全后应通过复合任务验收");
  const completedAfterUnrelatedTable = `<table><thead><tr><th>无关表头</th></tr></thead><tbody><tr><td>无关数据</td></tr></tbody></table>${completed}`;
  assert.equal(
    validateScopedCompletion(checklist, completedAfterUnrelatedTable).ok,
    true,
    "目标表格不是页面第一个 thead 时也必须遍历全部表头完成验收"
  );
  const splitTableCompleted = `<form><input placeholder="请输入手机号/姓名"></form><div class="better-table-scroll"><table style="width:240px"><colgroup><col style="width:120px"><col style="width:120px"></colgroup><thead><tr><th>最后跟进时间</th><th>最近跟进联系人</th></tr></thead></table><table style="width:240px"><colgroup><col style="width:120px"><col style="width:120px"></colgroup><tbody><tr><td>2026-07-20</td><td>张三（13800138000）</td></tr></tbody></table></div>`;
  assert.equal(validateScopedCompletion(checklist, splitTableCompleted).ok, true, "分离式表头/表体都完成时应通过复合任务验收");
  const splitBodyMissingCell = splitTableCompleted.replace("<td>张三（13800138000）</td>", "");
  assert.match(validateScopedCompletion(checklist, splitBodyMissingCell).reason || "", /表头为 2 列.*第 1 行为 1 列/);
  const strictChecklist = { ...checklist, expectedBodyRowCount: 2, expectedFinalColumnCount: 2 };
  const oneOfTwoRowsMissing = splitTableCompleted.replace(
    "</tbody>",
    "<tr><td>2026-07-21</td></tr></tbody>"
  );
  assert.match(
    validateScopedCompletion(strictChecklist, oneOfTwoRowsMissing).reason || "",
    /第 2 行为 1 列/,
    "任一表体行缺少新增列时都必须拒绝，不能只检查首行"
  );
  const oneOfTwoRowsWrongFormat = splitTableCompleted.replace(
    "</tbody>",
    "<tr><td>2026-07-21</td><td>李四</td></tr></tbody>"
  );
  assert.match(
    validateScopedCompletion(strictChecklist, oneOfTwoRowsWrongFormat).reason || "",
    /第 2 行缺少.*姓名（11位手机号）/,
    "每一行的新联系人单元格都必须满足格式要求"
  );
  const twoRowsCompleted = splitTableCompleted.replace(
    "</tbody>",
    "<tr><td>2026-07-21</td><td>李四（13900139000）</td></tr></tbody>"
  );
  assert.equal(validateScopedCompletion(strictChecklist, twoRowsCompleted).ok, true, "全部表体行完成后才能通过并触发提前结束");
  assert.match(formatScopedCompletionChecklist(checklist), /input placeholder exactly once/);
  assert.match(formatScopedCompletionChecklist(checklist), /every existing body row/);
}

{
  const instruction = "请在合规页签右边新增一个叫“AI功能”的页签，点击后展示AI会计、AI开票等维度";
  const plan = "operation=insert；scope=tabs；targetText=合规；replacement=AI功能";
  const original = `<div id="core-tabs" class="dpl-tabs"><div class="dpl-tabs-bar"><div role="tab" aria-selected="true" class="dpl-tabs-tab-active dpl-tabs-tab">票账税</div><div role="tab" aria-selected="false" class="dpl-tabs-tab">合规</div></div><div class="dpl-tabs-content"><div role="tabpanel" aria-hidden="false" class="dpl-tabs-tabpane-active">票账税内容</div><div role="tabpanel" aria-hidden="true" class="dpl-tabs-tabpane-inactive">合规内容</div></div></div>`;
  const checklist = buildScopedCompletionChecklist(instruction, original, plan);
  assert.deepEqual(checklist.tabContract.requiredTabTexts, ["AI功能"]);
  assert.deepEqual(checklist.tabContract.requiredContentTexts, ["AI会计", "AI开票"]);
  assert.equal(checklist.tabContract.expectedTabCount, 3);
  assert.equal(checklist.tabContract.expectedPanelCount, 3);
  assert.equal(checklist.tabContract.preserveActiveTabText, "票账税");
  assert.match(formatScopedCompletionChecklist(checklist), /exactly 3 tabs and 3 matching tabpanels/);

  const tabOnly = original.replace(
    '<div role="tab" aria-selected="false" class="dpl-tabs-tab">合规</div></div><div class="dpl-tabs-content">',
    '<div role="tab" aria-selected="false" class="dpl-tabs-tab">合规</div><div role="tab" aria-selected="false" class="dpl-tabs-tab">AI功能</div></div><div class="dpl-tabs-content">'
  );
  assert.match(validateScopedCompletion(checklist, tabOnly).reason || "", /预期 3 个页签面板/);

  const withPanel = tabOnly.replace(
    '<div role="tabpanel" aria-hidden="true" class="dpl-tabs-tabpane-inactive">合规内容</div></div></div>',
    '<div role="tabpanel" aria-hidden="true" class="dpl-tabs-tabpane-inactive">合规内容</div><div role="tabpanel" aria-hidden="true" class="dpl-tabs-tabpane-inactive">AI会计、AI开票</div></div></div>'
  );
  assert.match(validateScopedCompletion(checklist, withPanel).reason || "", /缺少可执行的点击切换逻辑/);

  const completed = `${withPanel.slice(0, -6)}<script>(function(){var tabs=document.querySelectorAll('[role="tab"]');var panels=document.querySelectorAll('[role="tabpanel"]');tabs.forEach(function(tab,index){tab.addEventListener('click',function(){tabs.forEach(function(item){item.classList.remove('dpl-tabs-tab-active');item.setAttribute('aria-selected','false');});panels.forEach(function(panel){panel.classList.remove('dpl-tabs-tabpane-active');panel.setAttribute('aria-hidden','true');});tab.classList.add('dpl-tabs-tab-active');tab.setAttribute('aria-selected','true');panels[index].classList.add('dpl-tabs-tabpane-active');panels[index].setAttribute('aria-hidden','false');});});})();</script></div>`;
  assert.equal(validateScopedCompletion(checklist, completed).ok, true, "页签、面板、内容和点击切换齐全后才能提前结束");
  const wrongDefault = completed
    .replace('aria-selected="true" class="dpl-tabs-tab-active dpl-tabs-tab">票账税', 'aria-selected="false" class="dpl-tabs-tab">票账税')
    .replace('aria-selected="false" class="dpl-tabs-tab">AI功能', 'aria-selected="true" class="dpl-tabs-tab-active dpl-tabs-tab">AI功能');
  assert.match(validateScopedCompletion(checklist, wrongDefault).reason || "", /默认激活页签应继续为“票账税”/);
}

{
  const original = html("<section><h1>客户列表</h1><p>原始内容</p></section>");
  assert.equal(validateClaudeHtml(original, original).ok, false, "no-op 必须被拒绝");
  assert.equal(validateClaudeHtml(original, original.replace("原始内容", "修改内容")).ok, true, "真实文本修改应通过");
  assert.equal(
    validateClaudeHtml(original, original.replace("原始内容", '<a href="/detail">查看详情</a>')).ok,
    false,
    "桌面 Claude 不得引入真实页面导航"
  );
  assert.equal(
    validateClaudeHtml(original, original.replace("原始内容", '<a href="#detail">查看详情</a>')).ok,
    true,
    "页内锚点不得被真实导航门禁误伤"
  );
}

{
  const original = html(`<section id="large">${"<p>待删除内容</p>".repeat(200)}</section><footer>保留</footer>`);
  const edited = html("<footer>保留</footer>");
  assert.equal(validateClaudeHtml(original, edited).ok, false, "非删除场景不得接受体量骤降");
  assert.equal(validateClaudeHtml(original, edited, { deleteMode: true }).ok, true, "删除场景应允许合法体量骤降");
}

{
  const original = html('<button id="detail">查看</button><div id="drawer"></div>');
  const staticEdit = original.replace("查看", "查看详情");
  const interactiveEdit = original.replace(
    '<button id="detail">查看</button>',
    '<button id="detail" onclick="document.getElementById(\'drawer\').hidden=false">查看</button>'
  );
  assert.equal(validateClaudeHtml(original, staticEdit, { interactiveEdit: true }).ok, false, "纯文案变化不算交互完成");
  assert.equal(validateClaudeHtml(original, interactiveEdit, { interactiveEdit: true }).ok, true, "新增点击逻辑应通过交互校验");
}

{
  const instruction = "在合规右边新增AI功能页签，点击打开后展示AI活跃情况";
  const original = html(
    '<section class="core-block"><div role="tablist" tabindex="0"><div role="tab" aria-selected="true" class="dpl-tabs-tab-active dpl-tabs-tab">合规</div></div><div role="tabpanel" aria-hidden="false" class="dpl-tabs-tabpane-active">合规内容</div></section><button data-action="unrelated">其它按钮</button>'
  );
  const staticOnly = original
    .replace('aria-selected="true" class="dpl-tabs-tab-active dpl-tabs-tab">合规', 'aria-selected="false" class="dpl-tabs-tab">合规</div><div role="tab" aria-selected="true" class="dpl-tabs-tab-active dpl-tabs-tab">AI功能')
    .replace('aria-hidden="false" class="dpl-tabs-tabpane-active">合规内容', 'aria-hidden="true" class="dpl-tabs-tabpane-inactive">合规内容</div><div role="tabpanel" aria-hidden="false" class="dpl-tabs-tabpane-active">AI内容');
  const staticValidation = validateClaudeHtml(original, staticOnly, { interactiveEdit: true, instruction });
  assert.equal(staticValidation.ok, false, "单行压缩 HTML 只切 active class 不得误判成交互完成");
  const interactive = staticOnly.replace(
    "</body>",
    `<script>document.querySelectorAll('.core-block [role="tab"]').forEach(function(tab,index){tab.addEventListener('click',function(){var root=tab.closest('.core-block');var tabs=root.querySelectorAll('[role="tab"]');var panes=root.querySelectorAll('[role="tabpanel"]');tabs.forEach(function(item,i){item.classList.toggle('dpl-tabs-tab-active',i===index);item.setAttribute('aria-selected',i===index?'true':'false');});panes.forEach(function(item,i){item.classList.toggle('dpl-tabs-tabpane-active',i===index);item.classList.toggle('dpl-tabs-tabpane-inactive',i!==index);item.setAttribute('aria-hidden',i===index?'false':'true');});});});</script></body>`
  );
  assert.equal(
    validateClaudeHtml(original, interactive, { interactiveEdit: true, instruction }).ok,
    true,
    "页签任务补齐点击处理与面板状态切换后应通过"
  );
}

{
  const original = html(
    '<button id="removeMe">删除</button><script>document.getElementById(\'removeMe\').addEventListener(\'click\',function(){});</script>'
  );
  const edited = original.replace('<button id="removeMe">删除</button>', "");
  const guarded = guardDeletedIdScriptRefs(original, edited);
  assert.match(guarded, /__ydGuard/, "删除仍被脚本引用的 id 时应注入安全守卫");
  assert.match(guarded, /getElementById\('removeMe'\)\|\|__ydGuard/, "脚本引用应改为 null-safe 形式");
}

{
  const dataUri = `data:image/png;base64,${"A".repeat(4096)}`;
  const original = html(`<img src="${dataUri}">`);
  const { compact, map } = compactDataUrisForClaude(original);
  assert.equal(map.size, 1, "大 data URI 应被压缩成占位符");
  assert.equal(validateAssetPlaceholdersForClaude(compact, map).ok, true);
  assert.equal(expandDataUrisForClaude(compact, map), original, "资源占位符应无损回填");

  const hash = createHash("sha256").update(original).digest("hex");
  const resolved = resolveClaudeHtmlInput({
    editHtml: compact,
    assets: Array.from(map, ([placeholder, dataUri]) => ({ placeholder, dataUri })),
    htmlSha256: hash,
  });
  assert.equal(resolved.html, original, "Electron 必须从单份 prepared HTML 原样重建完整页");
  assert.equal(resolved.prepared, true);
  assert.throws(
    () => resolveClaudeHtmlInput({ editHtml: compact, assets: Array.from(map, ([placeholder, dataUri]) => ({ placeholder, dataUri })), htmlSha256: "0".repeat(64) }),
    /hash 不一致/,
    "完整页 hash 不一致时必须拒绝 IPC 任务"
  );
  const preparedSize = analyzePreparedHtmlSizeForClaude(original, compact, map, 15_000_000);
  assert.equal(preparedSize.map.size, 0, "prepared 资源占位不得在完整页结果校验前被提前展开");
}

{
  const unrelatedCss = Array.from({ length: 80 }, (_, index) => `.unused-${index}{color:#${String(index).padStart(6, "0")};padding:${index}px}`).join("");
  const unrelatedJs = Array.from({ length: 80 }, (_, index) => `const unused${index}=${JSON.stringify("x".repeat(24))};`).join("");
  const inertJs = `window.__disabledPayload=${JSON.stringify("z".repeat(4096))};`;
  const original = html(
      `<section class="customer-card"><button id="detailBtn" onclick="openDetail()">查看详情</button></section>` +
      `<script>${unrelatedJs}function openDetail(){document.querySelector('.customer-card').classList.add('open')}</script>` +
      `<script type="text/plain" data-yd-disabled-script="inline">${inertJs}</script>` +
      `<script type="text/plain" data-yd-disabled-script="duplicate">${inertJs}</script>`,
    `<title>Projection</title><style>${unrelatedCss}.customer-card{color:#333}.customer-card.open{display:block}</style>`
  );
  const focus = {
    targetHtml: '<button id="detailBtn" onclick="openDetail()">查看详情</button>',
    scopeHtml: '<section class="customer-card"><button id="detailBtn" onclick="openDetail()">查看详情</button></section>',
  };
  const projection = buildTaskRelevantProjectionForClaude(original, "重新设计客户详情交互", focus, { interactiveEdit: true });
  assert.ok(projection.map.size >= 4, "任务无关 CSS、JS 与重复禁用脚本应生成各自的不可变占位");
  assert.ok(Buffer.byteLength(projection.compact) < Buffer.byteLength(original) * 0.45, "任务投影应显著减小 Claude 输入");
  assert.match(projection.compact, /\.customer-card\{color:#333\}/, "目标相关 CSS 必须保留给 Claude");
  assert.match(projection.compact, /function openDetail/, "目标相关 handler 必须保留给 Claude");
  assert.equal(validateImmutablePlaceholdersForClaude(projection.compact, projection.map).ok, true);
  assert.equal(expandImmutableRegionsForClaude(projection.compact, projection.map), original, "不可变区域必须原字节回填");
  const firstPlaceholder = projection.map.keys().next().value;
  assert.equal(
    validateImmutablePlaceholdersForClaude(projection.compact.replace(firstPlaceholder, ""), projection.map).ok,
    false,
    "Claude 丢失不可变占位时必须拒绝结果"
  );
  assert.equal(
    validateImmutablePlaceholdersForClaude(`${projection.compact}${firstPlaceholder}`, projection.map).ok,
    false,
    "Claude 重复不可变占位时必须拒绝结果"
  );
  assert.equal(projection.info.projectionApplied, true);
  assert.ok(projection.info.projectionSavingRatio >= 0.1, "投影埋点应记录实际收益率");
  assert.equal(projection.info.projectionBytes, Buffer.byteLength(projection.compact));
}

{
  const rows = (label) => Array.from({ length: 80 }, (_, index) => ({ id: `${label}-${index}`, text: "x".repeat(48) }));
  const data = {
    renewal: { title: "续费毛利", rows: rows("renewal") },
    newCustomer: { title: "新客毛利", rows: rows("new") },
    refund: { title: "退款明细", rows: rows("refund") },
    transfer: { title: "转介绍明细", rows: rows("transfer") },
  };
  const script = `const deptData=${JSON.stringify(data)};function openDrawer(type){window.currentDrawer=deptData[type];}`;
  const original = html(`<button id="renewalBtn" onclick="openDrawer('renewal')">续费毛利</button><script>${script}</script>`);
  const focus = {
    targetHtml: `<button id="renewalBtn" onclick="openDrawer('renewal')">续费毛利</button>`,
    scopeHtml: `<button id="renewalBtn" onclick="openDrawer('renewal')">续费毛利</button>`,
  };
  const projection = buildTaskRelevantProjectionForClaude(original, "修改续费毛利抽屉", focus, { interactiveEdit: true });
  assert.equal(projection.info.projectionApplied, true, "大型对象属性投影应在收益足够时启用");
  assert.ok(projection.info.immutableObjectPropertyRegionCount >= 1, "大型 JS 对象应按无关属性区间分片");
  assert.match(projection.compact, /renewal/, "任务相关对象属性必须保留");
  assert.doesNotMatch(projection.compact, /transfer-79/, "任务无关的大对象属性不应继续发送给 Claude");
  assert.ok([...projection.map.keys()].some((placeholder) => /^"__YD_IMMUTABLE_[a-f0-9]+__":null$/i.test(placeholder)));
  const projectedScript = /<script>([\s\S]*?)<\/script>/.exec(projection.compact)?.[1] || "";
  assert.doesNotThrow(() => Function(projectedScript), "对象属性占位后的 JavaScript 必须保持可解析");
  assert.equal(validateImmutablePlaceholdersForClaude(projection.compact, projection.map).ok, true);
  assert.equal(expandImmutableRegionsForClaude(projection.compact, projection.map), original, "对象属性必须原字节回填");
}

{
  const unrelatedRows = Array.from(
    { length: 120 },
    (_, index) => `<tr><td>历史报表 ${index}</td><td>${"无关数据".repeat(12)}</td></tr>`
  ).join("");
  const drawerRows = Array.from({ length: 20 }, (_, index) => `<li>客户详情 ${index}</li>`).join("");
  const target = '<button id="detailBtn" aria-controls="customerDrawer">查看客户详情</button>';
  const original = html(
    `<main><section id="customer-card">${target}</section>` +
      `<section id="history-report"><h2>历史报表</h2><table>${unrelatedRows}</table></section>` +
      `<aside id="customerDrawer" class="drawer" role="dialog"><ul>${drawerRows}</ul></aside></main>`
  );
  const focus = { targetHtml: target, scopeHtml: `<section id="customer-card">${target}</section>` };
  const projection = buildTaskRelevantProjectionForClaude(original, "重新设计查看客户详情的抽屉交互", focus, {
    interactiveEdit: true,
  });
  assert.equal(projection.info.projectionApplied, true, "局部任务应启用 DOM 子树投影");
  assert.equal(projection.info.immutableDomSubtreeRegionCount, 1, "无关的父级 DOM 子树应合并为一个占位区域");
  assert.match(projection.compact, /<!--__YD_IMMUTABLE_[a-f0-9]+__-->/i, "DOM 子树必须使用合法 HTML 注释占位");
  assert.doesNotMatch(projection.compact, /历史报表 119/, "无关 DOM 子树不得继续发送给 Claude");
  assert.match(projection.compact, /id="detailBtn"/, "目标 DOM 必须保留");
  assert.match(projection.compact, /id="customerDrawer"/, "aria-controls 引用的交互目标必须保留");
  assert.equal(validateImmutablePlaceholdersForClaude(projection.compact, projection.map).ok, true);
  assert.equal(expandImmutableRegionsForClaude(projection.compact, projection.map), original, "DOM 子树必须原字节回填");

  const globalProjection = buildTaskRelevantProjectionForClaude(original, "调整整个页面整体布局", focus, {
    interactiveEdit: true,
  });
  assert.equal(globalProjection.info.immutableDomSubtreeRegionCount, 0, "整页或全局视觉任务不得隐藏 DOM 子树");

  const batchProjection = buildTaskRelevantProjectionForClaude(original, "新增最近跟进联系人列", {
    ...focus,
    plan: "operation=insert；scope=page；batch=yes；needsFullPage=yes",
  });
  assert.equal(batchProjection.info.immutableDomSubtreeRegionCount, 0, "批量或整页计划不得隐藏 DOM 子树");
  assert.match(batchProjection.compact, /历史报表 119/, "批量或整页计划必须保留跨区域 DOM 内容");
}

{
  const protectedTarget = '<span data-source-id="follow-time">最近跟进时间</span>';
  const rows = Array.from({ length: 120 }, (_, index) => `<p>客户跟进记录 ${index} ${"详情".repeat(20)}</p>`).join("");
  const original = html(`<main><section id="other">保留内容</section><section id="follow-list">${protectedTarget}${rows}</section></main>`);
  const staleFocus = {
    targetHtml: '<span data-preview-id="preview-follow-time">最近跟进时间</span>',
    scopeHtml: '<section data-preview-scope="preview-follow-list"><span data-preview-id="preview-follow-time">最近跟进时间</span></section>',
  };
  const projection = buildTaskRelevantProjectionForClaude(original, "在最近跟进时间后新增最近跟进联系人", staleFocus);
  assert.equal(projection.info.projectionApplied, false, "投影丢失焦点可见文字时必须回退完整页面");
  assert.equal(projection.info.projectionSkipReason, "protected_terms_lost");
  assert.ok(projection.info.projectionLostProtectedTermCount >= 1, "投影应记录丢失的焦点文字数量");
  assert.equal(projection.compact, original, "焦点文字保护失败时不得把不完整投影发送给 Claude");
}

{
  const inertBlocks = Array.from(
    { length: 150 },
    (_, index) => `<script type="text/plain" data-yd-disabled-script="${index}">const payload${index}=${JSON.stringify("x".repeat(1024))};</script>`
  ).join("");
  const original = html(inertBlocks);
  const projection = buildTaskRelevantProjectionForClaude(original, "修改标题", null);
  assert.equal(projection.info.immutableCandidateRegionCount, 150, "埋点应记录上限裁剪前的候选数");
  assert.equal(projection.info.immutableRegionCount, 128, "不可变区域数量必须受硬上限约束");
  assert.equal(projection.info.immutableDroppedRegionCount, 22, "埋点应记录因上限丢弃的候选数");
  assert.equal(validateImmutablePlaceholdersForClaude(projection.compact, projection.map).ok, true);
  assert.equal(expandImmutableRegionsForClaude(projection.compact, projection.map), original);
}

{
  const original = html(`<p>${"正文".repeat(30_000)}</p><script type="text/plain" data-yd-disabled-script>const tiny=${JSON.stringify("x".repeat(1024))};</script>`);
  const projection = buildTaskRelevantProjectionForClaude(original, "修改标题", null);
  assert.equal(projection.map.size, 0, "低于最低净收益的投影不应启用");
  assert.equal(projection.info.projectionApplied, false);
  assert.equal(projection.info.projectionSkipReason, "saving_below_threshold");
  assert.equal(projection.compact, original);
}

{
  const scopeHtml = '<section id="card"><span>旧值</span></section>';
  const original = html(`<aside>保留</aside>${scopeHtml}<footer>保留</footer>`);
  const start = original.indexOf(scopeHtml);
  const focus = {
    source: "auto-locate",
    scopeStart: start,
    scopeEnd: start + scopeHtml.length,
    scopeTag: "section",
    scopeHtml,
  };
  const scoped = prepareScopedClaudeJob(original, focus);
  assert.equal(scoped.scoped, true);
  const editedJob = scoped.html.replace("旧值", "新值");
  const applied = applyScopedClaudeResult(original, editedJob, focus);
  assert.equal(applied.ok, true);
  assert.match(applied.html, /<aside>保留<\/aside>/);
  assert.match(applied.html, /<span>新值<\/span>/);
}

{
  const scopeHtml =
    '<table style="width:200px;"><colgroup><col style="width:100px;"><col style="width:100px;"></colgroup><thead><tr><th>名称</th><th>操作</th></tr></thead><tbody><tr><td>A</td><td>查看</td></tr></tbody></table>';
  const original = html(`<main>${scopeHtml}</main>`);
  const start = original.indexOf(scopeHtml);
  const focus = {
    source: "auto-locate",
    scopeStart: start,
    scopeEnd: start + scopeHtml.length,
    scopeTag: "table",
    scopeHtml,
  };
  const editedTable =
    '<table style="width:260px;"><colgroup><col style="width:100px;"><col style="width:120px;"><col style="width:100px;"></colgroup><thead><tr><th>名称</th><th>新增金额</th><th>操作</th></tr></thead><tbody><tr><td>A</td><td>10.00</td><td>查看</td></tr></tbody></table>';
  const editedJob = `<!doctype html><html><body><!--YD_SCOPE_START--><div style="max-width:100%;overflow-x:auto;">${editedTable}</div><!--YD_SCOPE_END--></body></html>`;
  const applied = applyScopedClaudeResult(original, editedJob, focus);
  assert.equal(applied.ok, true, "表格 scope 应允许单一横向滚动容器包装");
  assert.match(applied.replacement, /^<div[^>]*overflow-x:auto[^>]*><table/i);
  assert.match(applied.replacement, /width:320px/, "滚动表格宽度必须确定性扩展到 colgroup 列宽合计");
  assert.match(applied.replacement, /min-width:320px/);

  const extraSibling = editedJob.replace("</table></div>", "</table><p>额外内容</p></div>");
  assert.equal(applyScopedClaudeResult(original, extraSibling, focus).ok, false, "滚动容器内不得夹带表格外兄弟节点");
  const unsafeWrapper = editedJob.replace('style="max-width:100%;overflow-x:auto;"', 'style="overflow-x:auto;" onclick="evil()"');
  assert.equal(applyScopedClaudeResult(original, unsafeWrapper, focus).ok, false, "滚动容器不得携带事件处理器");
}

{
  const scopeHtml = '<section id="card"><span style="color:#333">旧文案</span></section>';
  const original = html(`<aside>保留</aside>${scopeHtml}<footer>保留</footer>`);
  const start = original.indexOf(scopeHtml);
  const focus = {
    source: "auto-locate",
    targetHtml: '<span style="color:#333">旧文案</span>',
    scopeStart: start,
    scopeEnd: start + scopeHtml.length,
    scopeTag: "section",
    scopeHtml,
  };
  const safety = analyzeScopedClaudeSafety(original, focus, "把旧文案改成新文案");
  assert.equal(safety.safe, true, "纯文案和目标内部样式必须继续走精确 scope");
  assert.equal(prepareScopedClaudeJob(original, focus, { instruction: "把旧文案改成新文案" }).scoped, true);
}

{
  const scopeHtml = '<button id="detailBtn" onclick="openCustomerDrawer(42)" aria-controls="customerDrawer">查看详情</button>';
  const drawer = '<aside id="customerDrawer" class="customer-drawer" hidden>客户详情</aside>';
  const script = '<script>function openCustomerDrawer(id){document.getElementById("customerDrawer").hidden=false;}</script>';
  const original = html(`${scopeHtml}${drawer}${script}`);
  const start = original.indexOf(scopeHtml);
  const focus = {
    source: "annotation",
    targetHtml: scopeHtml,
    scopeStart: start,
    scopeEnd: start + scopeHtml.length,
    scopeTag: "button",
    scopeHtml,
  };
  const scoped = prepareScopedClaudeJob(original, focus, {
    instruction: "点击查看详情时打开客户抽屉",
    interactiveEdit: true,
  });
  assert.equal(scoped.scoped, false, "外部函数和 scope 外 drawer 必须回退完整页面");
  assert.match(scoped.scopeSafety.reasons.join("；"), /scope 外函数|scope 外元素|drawer\/modal/);
  assert.equal(scoped.html, original, "scope 不自包含时必须把完整页面交给 Claude");
  const snippets = buildRelevantHtmlSnippets(original, "点击查看详情时打开客户抽屉", true, focus);
  assert.match(snippets, /openCustomerDrawer/, "完整页面任务必须保留外部 handler 相关片段");
  assert.match(snippets, /customerDrawer/, "完整页面任务必须保留 drawer 相关片段");
}

{
  const scopeHtml = '<section id="customerCard"><button class="detail-action">查看</button></section>';
  const original = html(
    `${scopeHtml}<script>document.getElementById("customerCard").addEventListener("click",function(){ renderCustomer(customerData); });</script>`
  );
  const start = original.indexOf(scopeHtml);
  const focus = {
    source: "auto-locate",
    targetHtml: '<button class="detail-action">查看</button>',
    scopeStart: start,
    scopeEnd: start + scopeHtml.length,
    scopeTag: "section",
    scopeHtml,
  };
  const scoped = prepareScopedClaudeJob(original, focus, { instruction: "修改查看按钮点击效果", interactiveEdit: true });
  assert.equal(scoped.scoped, false, "scope 外 addEventListener 或脚本数据源依赖必须回退完整页面");
  assert.match(scoped.scopeSafety.reasons.join("；"), /scope 外脚本引用目标/);
}

{
  const scopeHtml = '<section class="action-list"><button>批量处理</button></section>';
  const original = html(`${scopeHtml}<section class="other-list"><button>批量处理</button></section>`);
  const start = original.indexOf(scopeHtml);
  const baseFocus = {
    source: "auto-locate",
    targetHtml: "<button>批量处理</button>",
    scopeStart: start,
    scopeEnd: start + scopeHtml.length,
    scopeTag: "section",
    scopeHtml,
  };
  const batch = prepareScopedClaudeJob(original, { ...baseFocus, plan: "operation=style；batch=yes；needsFullPage=no" }, {
    instruction: "把所有批量处理按钮改成蓝色",
  });
  assert.equal(batch.scoped, false, "batch=yes 的编辑计划不得收窄成单容器 scope");
  assert.match(batch.scopeSafety.reasons.join("；"), /批量处理/);

  const fullPage = prepareScopedClaudeJob(
    original,
    { ...baseFocus, plan: "operation=interaction；batch=no；needsFullPage=yes" },
    { instruction: "调整批量处理流程" }
  );
  assert.equal(fullPage.scoped, false, "needsFullPage=yes 的编辑计划必须保留完整页面");
  assert.match(fullPage.scopeSafety.reasons.join("；"), /整页处理/);
}

{
  const scopeHtml = '<button class="drawer-trigger" data-target=".customerDrawer">打开客户详情</button>';
  const original = html(`${scopeHtml}<aside class="customerDrawer" hidden>客户详情</aside>`);
  const start = original.indexOf(scopeHtml);
  const scoped = prepareScopedClaudeJob(
    original,
    {
      source: "annotation",
      targetHtml: scopeHtml,
      scopeStart: start,
      scopeEnd: start + scopeHtml.length,
      scopeTag: "button",
      scopeHtml,
    },
    { instruction: "修改打开客户详情的入口文案" }
  );
  assert.equal(scoped.scoped, false, "data-target=.class 指向 scope 外元素时必须回退完整页面");
  assert.match(scoped.scopeSafety.reasons.join("；"), /scope 外元素 \.customerDrawer/);
}

{
  const scopeHtml = '<button id="detailBtn" data-action="open-details">查看详情</button>';
  const script = '<script>$(\`#detailBtn\`).on("click", openDetails);</script>';
  const original = html(`${scopeHtml}${script}`);
  const start = original.indexOf(scopeHtml);
  const scoped = prepareScopedClaudeJob(
    original,
    {
      source: "auto-locate",
      targetHtml: scopeHtml,
      scopeStart: start,
      scopeEnd: start + scopeHtml.length,
      scopeTag: "button",
      scopeHtml,
    },
    { instruction: "修改查看详情的点击效果", interactiveEdit: true }
  );
  assert.equal(scoped.scoped, false, "jQuery 和反引号 selector 注册在 scope 外时必须回退完整页面");
  assert.match(scoped.scopeSafety.reasons.join("；"), /scope 外脚本引用目标 #detailBtn/);
}

{
  const scopeHtml = '<button data-action="open-details">查看详情</button>';
  const script =
    '<script>document.addEventListener("click",event=>{if(event.target.closest(\`[data-action="open-details"]\`)?.textContent==="查看详情") openDetails();});</script>';
  const original = html(`${scopeHtml}${script}`);
  const start = original.indexOf(scopeHtml);
  const scoped = prepareScopedClaudeJob(
    original,
    {
      source: "auto-locate",
      targetHtml: scopeHtml,
      scopeStart: start,
      scopeEnd: start + scopeHtml.length,
      scopeTag: "button",
      scopeHtml,
    },
    { instruction: "点击查看详情时展示详情面板", interactiveEdit: true }
  );
  assert.equal(scoped.scoped, false, "document 事件委托通过 data-* 或目标文案命中时必须回退完整页面");
  assert.match(scoped.scopeSafety.reasons.join("；"), /scope 外脚本引用目标/);
}

{
  for (const referenceAttribute of ['data-target="#externalPanel"', 'href="#externalPanel"']) {
    const scopeHtml = `<section><a ${referenceAttribute}>打开</a></section>`;
    const original = html(`${scopeHtml}<aside id="externalPanel">外部面板</aside>`);
    const start = original.indexOf(scopeHtml);
    const focus = {
      source: "auto-locate",
      targetHtml: scopeHtml,
      scopeStart: start,
      scopeEnd: start + scopeHtml.length,
      scopeTag: "section",
      scopeHtml,
    };
    assert.equal(
      prepareScopedClaudeJob(original, focus, { instruction: "修改打开面板的入口" }).scoped,
      false,
      `${referenceAttribute} 指向 scope 外元素时必须回退完整页面`
    );
  }

  const localScope = '<section><a href="#localPanel">打开</a><aside id="localPanel">内部面板</aside></section>';
  const localOriginal = html(localScope);
  const localStart = localOriginal.indexOf(localScope);
  assert.equal(
    prepareScopedClaudeJob(
      localOriginal,
      {
        source: "auto-locate",
        targetHtml: localScope,
        scopeStart: localStart,
        scopeEnd: localStart + localScope.length,
        scopeTag: "section",
        scopeHtml: localScope,
      },
      { instruction: "修改内部面板入口文案" }
    ).scoped,
    true,
    "引用目标位于 scope 内时必须继续使用精确 scope"
  );
}

{
  const scopeHtml = '<section><span>动态客户名称</span></section>';
  const original = html(`${scopeHtml}<script>const customerData={name:"客户A"}; function renderCustomer(){ return customerData.name; }</script>`);
  const start = original.indexOf(scopeHtml);
  const focus = {
    source: "annotation",
    targetHtml: '<span>动态客户名称</span>',
    scopeStart: start,
    scopeEnd: start + scopeHtml.length,
    scopeTag: "section",
    scopeHtml,
  };
  const scoped = prepareScopedClaudeJob(original, focus, {
    instruction: "持久修改要求：请修改脚本数据源或渲染函数中的客户名称",
  });
  assert.equal(scoped.scoped, false, "明确要求修改脚本数据源时必须回退完整页面");
  assert.match(scoped.scopeSafety.reasons.join("；"), /脚本数据源或渲染函数/);
}

{
  const scopeHtml = '<section id="card"><span>内容</span></section>';
  const original = html(`${scopeHtml}<script>document.getElementById("unrelated").addEventListener("click",function(){});</script>`);
  const start = original.indexOf(scopeHtml);
  const focus = {
    source: "auto-locate",
    targetHtml: scopeHtml,
    scopeStart: start,
    scopeEnd: start + scopeHtml.length,
    scopeTag: "section",
    scopeHtml,
  };
  assert.equal(
    prepareScopedClaudeJob(original, focus, { instruction: "修改卡片文案" }).scoped,
    true,
    "无关的全局事件监听不得误伤简单 scope"
  );
  const globalLayout = prepareScopedClaudeJob(original, focus, { instruction: "调整整体布局并适配响应式" });
  assert.equal(globalLayout.scoped, false, "布局、主题和响应式任务必须回退完整页面");
  assert.match(globalLayout.scopeSafety.reasons.join("；"), /布局、主题或响应式/);
}

{
  const scopeHtml = '<section class="customer-card"><span class="status-label">正常</span></section>';
  const original = html(scopeHtml, "<title>Prototype</title><style>.status-label{color:#d00}.customer-card:hover{box-shadow:0 2px 8px #ddd}</style>");
  const start = original.indexOf(scopeHtml);
  const focus = {
    source: "auto-locate",
    targetHtml: '<span class="status-label">正常</span>',
    scopeStart: start,
    scopeEnd: start + scopeHtml.length,
    scopeTag: "section",
    scopeHtml,
  };
  const visualEdit = prepareScopedClaudeJob(original, focus, { instruction: "把状态文字颜色改成绿色" });
  assert.equal(visualEdit.scoped, false, "局部视觉任务依赖 scope 外 CSS 时必须回退完整页面");
  assert.match(visualEdit.scopeSafety.reasons.join("；"), /scope 外 CSS \.status-label/);

  const unrelatedCssOriginal = html(scopeHtml, "<title>Prototype</title><style>.unrelated{color:#d00}</style>");
  const unrelatedStart = unrelatedCssOriginal.indexOf(scopeHtml);
  const unrelatedCss = prepareScopedClaudeJob(
    unrelatedCssOriginal,
    { ...focus, scopeStart: unrelatedStart, scopeEnd: unrelatedStart + scopeHtml.length },
    { instruction: "给状态文字增加内联颜色" }
  );
  assert.equal(unrelatedCss.scoped, true, "无关的 scope 外 CSS 不得误伤局部视觉 scope");
}

assert.deepEqual(diffStats("a\nb", "a\nc\nd"), { changedLines: 2, added: 1, removed: 0 });

{
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{}); process.stdout.write('ready\\n'); setInterval(()=>{},1000);"],
    { stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32" }
  );
  try {
    await once(child.stdout, "data");
    assert.equal(isChildProcessRunning(child), true, "测试子进程应处于运行状态");
    const closed = once(child, "close");
    terminateChildProcessTree(child, "SIGTERM");
    if (process.platform === "win32") {
      await closed;
      assert.equal(isChildProcessRunning(child), false, "Windows 必须立即清理完整进程树");
    } else {
      await delay(100);
      assert.equal(isChildProcessRunning(child), true, "仅发送 SIGTERM 不代表子进程已经退出");
      scheduleChildProcessForceKill(child, 50, { tree: true });
      const [, signal] = await closed;
      assert.equal(signal, "SIGKILL", "忽略 SIGTERM 的子进程必须由 SIGKILL 兜底结束");
    }
    assert.equal(isChildProcessRunning(child), false, "close 后运行状态应为 false");
  } finally {
    terminateChildProcess(child, "SIGKILL");
  }
}

{
  const queue = new ClaudeJobQueue();
  const gates = [];
  const first = queue.enqueue("job-first", async (job) => {
    await new Promise((resolve) => gates.push(resolve));
    job.throwIfCancelled();
    return "first";
  });
  const second = queue.enqueue("job-second", async () => "second");
  await delay(0);
  const cancelQueued = queue.cancel("job-second");
  assert.equal(cancelQueued.cancelled, true, "排队任务应能按 jobId 立即取消");
  await assert.rejects(second, (error) => error.code === CLAUDE_JOB_CANCELLED_CODE);
  gates.shift()?.();
  assert.equal(await first, "first");
  assert.equal(await queue.waitForIdle(200), true);
  assert.equal(queue.cancel("missing-job").cancelled, false, "取消不存在的任务不得污染下一任务");
  assert.equal(await queue.enqueue("job-after-idle-cancel", async () => "ok"), "ok");
}

{
  const queue = new ClaudeJobQueue();
  let cancelObserved = false;
  const running = queue.enqueue("job-running", async (job) => {
    await new Promise((resolve) => {
      job.onCancel(() => {
        cancelObserved = true;
        resolve();
      });
    });
    job.throwIfCancelled();
  });
  await delay(0);
  const cancelled = queue.cancel("job-running");
  assert.deepEqual({ cancelled: cancelled.cancelled, state: cancelled.state }, { cancelled: true, state: "running" });
  await assert.rejects(running, (error) => error.code === CLAUDE_JOB_CANCELLED_CODE);
  assert.equal(cancelObserved, true, "运行中任务应收到自己的取消通知");
  assert.equal(await queue.waitForIdle(200), true);
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "youdesign-claude-jobs-"));
  const now = Date.now();
  try {
    let jobSequence = 0;
    const makeJob = (status, finishedAt) => {
      const name = `2026-07-20T00-00-${String(jobSequence).padStart(2, "0")}-000Z-${jobSequence
        .toString(16)
        .padStart(8, "0")}`;
      jobSequence += 1;
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      writeClaudeJobStatus(dir, status);
      const statusPath = path.join(dir, "job-status.json");
      const metadata = JSON.parse(fs.readFileSync(statusPath, "utf8"));
      metadata.finishedAt = finishedAt;
      fs.writeFileSync(statusPath, JSON.stringify(metadata), "utf8");
      return dir;
    };
    const oldSuccess = makeJob("success", now - 8 * 24 * 60 * 60 * 1_000);
    const recentSuccess = makeJob("success", now - 6 * 24 * 60 * 60 * 1_000);
    const failedJobs = [];
    for (let index = 0; index < 22; index += 1) failedJobs.push(makeJob("failed", now - index * 1_000));

    const unrelatedDirs = [];
    for (let index = 0; index < 21; index += 1) {
      const dir = path.join(root, `unrelated-${String(index).padStart(2, "0")}`);
      fs.mkdirSync(dir);
      unrelatedDirs.push(dir);
    }
    const forgedDir = path.join(root, "2026-07-19T00-00-00-000Z-deadbeef");
    fs.mkdirSync(forgedDir);
    fs.writeFileSync(
      path.join(forgedDir, "job-status.json"),
      JSON.stringify({ owner: `${CLAUDE_JOB_OWNER}-other`, version: 1, status: "failed", finishedAt: 0 }),
      "utf8"
    );
    const invalidStatusDir = path.join(root, "2026-07-18T00-00-00-000Z-cafebabe");
    fs.mkdirSync(invalidStatusDir);
    fs.writeFileSync(
      path.join(invalidStatusDir, "job-status.json"),
      JSON.stringify({ owner: CLAUDE_JOB_OWNER, version: 1, status: "unknown", finishedAt: 0 }),
      "utf8"
    );

    const result = cleanupClaudeJobDirs(root, {
      now,
      successTtlMs: 7 * 24 * 60 * 60 * 1_000,
      otherTtlMs: 7 * 24 * 60 * 60 * 1_000,
      maxOtherJobs: 20,
    });
    assert.equal(fs.existsSync(oldSuccess), false, "成功任务超过 7 天必须清理");
    assert.equal(fs.existsSync(recentSuccess), true, "成功任务 7 天内必须保留");
    assert.equal(fs.existsSync(failedJobs[20]), false, "失败任务只保留最近 20 个");
    assert.equal(fs.existsSync(failedJobs[21]), false, "最旧失败任务必须清理");
    assert.equal(unrelatedDirs.every((dir) => fs.existsSync(dir)), true, "普通目录绝不能被 Claude 任务清理器删除");
    assert.equal(fs.existsSync(forgedDir), true, "缺少正确所有权标记的伪任务目录必须保留");
    assert.equal(fs.existsSync(invalidStatusDir), true, "状态不属于 Claude 生命周期的目录必须保留");
    assert.equal(result.removed.length, 3);

    const unsafeRootResult = cleanupClaudeJobDirs(root, {
      now,
      protectedRoots: [unrelatedDirs[0]],
    });
    assert.equal(unsafeRootResult.skippedUnsafeRoot, true, "包含受保护路径的宽泛清理根目录必须被拒绝");
    assert.equal(fs.existsSync(recentSuccess), true, "拒绝危险根目录后不得删除任何任务");

    const asyncLog = path.join(root, "async-log.jsonl");
    const appender = createAsyncFileAppender(asyncLog);
    appender.append('{"type":"one"}\n');
    appender.append('{"type":"two"}\n');
    assert.equal(await appender.close(), null);
    assert.match(fs.readFileSync(asyncLog, "utf8"), /one[\s\S]*two/, "异步日志关闭前必须完整刷盘");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const serverAgentPath = path.join(projectRoot, "src/lib/desktop/claudeHtmlAgent.ts");
  const serverCancelPath = path.join(projectRoot, "src/app/api/desktop/claude/cancel/route.ts");
  const orchestrator = fs.readFileSync(path.join(projectRoot, "src/lib/pipeline/orchestrator.ts"), "utf8");
  const judges = fs.readFileSync(path.join(projectRoot, "src/lib/pipeline/judges.ts"), "utf8");
  const prompts = fs.readFileSync(path.join(projectRoot, "src/lib/prompts.ts"), "utf8");
  const page = fs.readFileSync(path.join(projectRoot, "src/app/page.tsx"), "utf8");
  const desktopClaudeFrontend = fs.readFileSync(path.join(projectRoot, "src/app/desktop-claude.ts"), "utf8");
  const electronMain = fs.readFileSync(path.join(projectRoot, "desktop/main.cjs"), "utf8");
  const electronPreload = fs.readFileSync(path.join(projectRoot, "desktop/preload.cjs"), "utf8");

  assert.equal(fs.existsSync(serverAgentPath), false, "不得恢复 Next server Claude Agent");
  assert.equal(fs.existsSync(serverCancelPath), false, "不得恢复 Next server Claude 取消 API");
  assert.doesNotMatch(orchestrator, /runClaudeHtmlAgent|claudeHtmlAgentEnabled/, "orchestrator 只能发 Electron handoff");
  assert.match(prompts, /复合指令.*筛选.*列表.*表格.*新增.*batch=true, needsFullPage=true, scopeHint="page"/s, "复合筛选+表格列指令必须由 editPlanSystemPrompt 规则驱动 LLM 输出整页批量");
  assert.doesNotMatch(judges, /isCompositeFilterTableColumnInstruction/, "复合意图改由 LLM editPlanSystemPrompt 驱动，judges 不再用正则覆盖纠偏");
  assert.match(prompts, /多目标复合指令.*1、.*2、.*needsFullPage=true/s, "编号/分点多目标指令（1、2、…）必须由 editPlanSystemPrompt 规则驱动 LLM 输出 needsFullPage=true 整页处理，避免单点 scope 漏改其余条目");
  assert.doesNotMatch(page, /api\/desktop\/claude\/cancel/, "前端取消只能走 Electron bridge");
  assert.match(electronMain, /electron-only-executor/, "Electron 状态协议必须声明唯一执行器能力");
  assert.match(electronMain, /job-scoped-cancel/, "Electron 状态协议必须声明按任务取消能力");
  assert.match(electronMain, /multi-fragment-transaction/, "Electron 状态协议必须声明多片段事务能力");
  assert.match(electronMain, /navigation-static-gate/, "Electron 状态协议必须声明桌面导航静态门禁能力");
  assert.match(electronMain, /prototype-contract-guard/, "Electron 状态协议必须声明 Prototype Contract 守卫能力");
  assert.match(electronMain, /reconstructed-html-input/, "Electron 状态协议必须声明单份 HTML 重建能力");
  assert.match(electronMain, /sha256-bridge/, "Electron 状态协议必须声明非安全 Web 上下文 SHA-256 能力");
  assert.match(electronMain, /immutable-region-projection/, "Electron 状态协议必须声明不可变区域投影能力");
  assert.match(electronMain, /CLAUDE_BRIDGE_PROTOCOL_VERSION = 5/, "Electron Claude bridge 协议必须升级到 v5");
  assert.match(electronMain, /## Authoritative Table Structure/, "复合筛选和表格任务必须预先提供确定性的表格结构摘要");
  assert.match(electronMain, /DEFAULT_CLAUDE_AGENT_MAX_TURNS = "20"/, "普通 Claude Code 任务默认必须有 20 轮预算");
  assert.match(electronMain, /\["4", "8", "10", "16"\]/, "旧版 16 轮桌面配置必须自动迁移到当前默认值");
  assert.match(electronMain, /Math\.max\(configuredMaxTurns, 28\)/, "复合筛选和表格任务必须至少获得 28 轮预算");
  assert.equal(
    (electronMain.match(/const compositeFilterTableTask =/g) || []).length,
    1,
    "复合任务标记只能在桌面编辑执行函数内声明一次"
  );
  assert.match(
    electronMain,
    /async function runClaudeHtmlEdit[\s\S]*?const instruction = String\(input\?\.instruction \|\| ""\);\s*const compositeFilterTableTask = isCompositeFilterTableInput\(\{ instruction \}\);[\s\S]*?const multiFragmentJob/,
    "复合任务标记必须在 runClaudeHtmlEdit 内、首次路由使用前声明"
  );
  assert.match(
    electronMain,
    /!scopedJob\.scoped && \(compositeFilterTableTask \|\| scopedJob\.scopeSafety\?\.safe === false\)/,
    "复合筛选和表格任务即使没有有效单点 scope 也必须尝试多片段事务"
  );
  assert.match(electronMain, /createCompositeFragmentEarlyStopDetector/, "复合事务两个片段均完成并通过验收后必须提前转系统校验");
  assert.match(
    electronMain,
    /scopedCompletionChecklist\?\.items\?\.length \|\| scopedCompletionChecklist\?\.tabContract/,
    "完整页签组合同必须启用 scoped 写入提前结束"
  );
  assert.match(electronMain, /function isClaudeBudgetLimitResult/, "预算触顶必须可被识别并进入安全结果抢救");
  assert.match(
    electronMain,
    /if \(!reachedMaxTurns && !reachedBudgetLimit\)/,
    "预算触顶不得在校验已写入结果前直接判失败"
  );
  assert.match(
    electronMain,
    /\(reachedMaxTurns \|\| reachedBudgetLimit \|\| interruptedForValidation\) && compactEdited === size\.compact/,
    "预算触顶且未写入时必须继续如实失败"
  );
  assert.match(
    electronMain,
    /createCompositeFragmentEarlyStopDetector[\s\S]*?applyMultiFragmentClaudeResult[\s\S]*?validateScopedCompletion\(completionChecklist, applied\.html\)/,
    "复合事务提前结束必须复用全量完成清单校验"
  );
  assert.match(electronMain, /completionChecklist\.expectedBodyRowCount/, "复合事务完成清单必须携带原表体行数");
  assert.match(electronMain, /completionChecklist\.expectedFinalColumnCount/, "复合事务完成清单必须携带最终列数");
  assert.match(electronMain, /transactionKind: multiFragmentPlan\?\.kind/, "Claude CLI 任务必须收到复合事务类型以约束探索范围");
  assert.match(electronMain, /DEFAULT_CLAUDE_API_RETRY_STALL_MS = "180000"/, "模型接口重试后无响应必须有独立的短熔断时间");
  assert.match(electronMain, /event\?\.type === "system" && event\?\.subtype === "api_retry"/, "桌面执行器必须识别 Claude CLI 的 API 重试事件");
  assert.match(electronMain, /const armApiRetryStallTimer = \(\) => \{\s*if \(apiRetryStallTimer\) return;/, "连续 API 重试不得反复延长无进展熔断时间");
  assert.match(electronMain, /apiRetryStalled && !hasTaskArtifactChanges/, "API 重试熔断且零写入时必须报告模型服务无响应");
  assert.match(electronMain, /interruptedForValidation && hasTaskArtifactChanges/, "超时前已有写入时必须转入系统校验而不是直接丢弃结果");
  assert.match(electronMain, /compactEdited === size\.compact/, "达到最大轮次且完全未写入时必须报告真实原因");
  assert.match(electronMain, /one \\`node -e\\` command may read and overwrite only/, "单行重复表格应允许一次受限的本地定位变换");
  assert.match(
    electronMain,
    /const snippets = input\.multiFragmentPlan\s*\? ""\s*:\s*buildRelevantHtmlSnippets/,
    "不可变投影任务仍应从压缩 HTML 提取 Relevant HTML Snippets"
  );
  assert.match(electronMain, /includeExcerpts: !taskContextMaterialized/, "任务文件已包含焦点上下文时不得在 TASK 重复嵌入 target/scope HTML");
  assert.doesNotMatch(electronMain, /## Execution Discipline/, "TASK 不得重复 constraints 与 CLI 已提供的执行规则");
  assert.doesNotMatch(electronMain, /## Immutable Regions/, "不可变占位说明应压缩进 TASK Context 而非重复生成整节说明");
  assert.match(electronMain, /type: "immutable_projection"/, "不可变投影统计必须写入 Claude 任务结构化日志");
  assert.match(desktopClaudeFrontend, /DESKTOP_CLAUDE_PROTOCOL_VERSION = 5/, "前端必须要求 Claude bridge v5");
  assert.match(desktopClaudeFrontend, /globalThis\.crypto\?\.subtle/, "前端必须安全检测 Web Crypto 是否可用");
  assert.match(desktopClaudeFrontend, /window\.youdesignDesktop\.sha256Text\(value\)/, "非安全 HTTP 上下文必须回退 preload SHA-256");
  assert.match(electronPreload, /sha256Text\(value\)/, "preload 必须暴露窄授权 SHA-256 bridge");
  assert.match(page, /bridgeProtocolVersion: DESKTOP_CLAUDE_PROTOCOL_VERSION/, "前端调用必须携带协议版本");
  assert.match(page, /html: sourceEditHtml \? undefined : sourceHtml/, "有 prepared HTML 时不得通过 IPC 重复发送完整 HTML");
  assert.match(page, /htmlSha256: sourceHtmlSha256/, "IPC 单份 HTML 必须携带完整页 hash");
  assert.match(page, /cancelClaudeHtmlEdit!\(jobId\)/, "前端取消必须携带 jobId");
  assert.doesNotMatch(electronMain, /child\.killed/, "不得用 child.killed 判断 Claude CLI 是否仍在运行");
  assert.doesNotMatch(electronMain, /claudeCancelRequested/, "不得恢复会污染后续任务的全局取消标记");
  assert.doesNotMatch(electronMain, /appendFileSync\(logPath/, "Claude stream 日志不得同步逐块写盘");
}

{
  // 真在模拟沙箱上下文里加载 preload,堵住 require 本地文件/Node 模块的回归。
  // 沙箱只放行 electron/events/timers/url;其它 require 一律抛错,复刻
  // Electron sandbox:true preload 的限制。谁再往 preload 塞 require("./...")
  // 或 node:crypto,加载即抛、测试红。
  const preloadSource = fs.readFileSync(path.join(projectRoot, "desktop/preload.cjs"), "utf8");
  const SANDBOX_ALLOWED = new Set(["electron", "events", "timers", "url"]);

  let exposed = null;
  const ipcListeners = {};
  const ipcInvokes = [];
  const stubContextBridge = {
    exposeInMainWorld(name, obj) {
      exposed = { name, obj };
    },
  };
  const stubIpcRenderer = {
    on(channel, fn) {
      (ipcListeners[channel] ||= []).push(fn);
    },
    send(channel, ...args) {
      void channel;
      void args;
    },
    invoke(channel, ...args) {
      ipcInvokes.push({ channel, args });
      return Promise.resolve(`stub:${channel}`);
    },
    removeListener(channel, fn) {
      const list = ipcListeners[channel];
      if (list) ipcListeners[channel] = list.filter((f) => f !== fn);
    },
  };

  const sandboxRequire = (mod) => {
    if (mod === "electron") return { contextBridge: stubContextBridge, ipcRenderer: stubIpcRenderer };
    if (SANDBOX_ALLOWED.has(mod)) return {};
    throw new Error(
      `sandboxed preload 不允许 require "${mod}"(沙箱只放行 electron/events/timers/url;需 Node 能力请挪到主进程 ipcMain.handle)`
    );
  };

  const sandbox = { require: sandboxRequire, console, process: { platform: process.platform } };
  vm.createContext(sandbox);

  // 若 preload 含沙箱不允许的 require,这一步即抛(d392819 require("./desktop-utils.cjs") 的回归点)
  assert.doesNotThrow(
    () => vm.runInContext(preloadSource, sandbox, { filename: "preload.cjs" }),
    "preload 必须能在沙箱(只放行 electron 白名单)里加载,不得 require 本地文件或 Node 内置模块"
  );
  assert.ok(exposed && exposed.name === "youdesignDesktop", "沙箱加载后必须暴露 youdesignDesktop 桥");

  const bridge = exposed.obj;
  const expectedMethods = [
    "openConfigFolder",
    "openAttachment",
    "getClaudeStatus",
    "sha256Text",
    "runClaudeHtmlEdit",
    "cancelClaudeHtmlEdit",
    "openClaudeLog",
    "onClaudeProgress",
    "onCaptureImport",
  ];
  for (const name of expectedMethods) {
    assert.equal(typeof bridge[name], "function", `沙箱加载后 youdesignDesktop.${name} 必须是函数`);
  }

  // sha256Text 必须走 IPC invoke 到主进程(沙箱无 node:crypto)
  const shaPromise = bridge.sha256Text("abc");
  assert.ok(shaPromise instanceof Promise, "sha256Text 必须返回 Promise(IPC invoke 到主进程)");
  assert.equal((await shaPromise), "stub:desktop:sha256-text", "sha256Text 必须经 ipcRenderer.invoke 调主进程 desktop:sha256-text");
  assert.equal(ipcInvokes.at(-1).channel, "desktop:sha256-text", "sha256Text 必须打到 desktop:sha256-text 通道");
  assert.throws(() => bridge.sha256Text(123), /SHA-256 输入必须是字符串/, "sha256Text 必须校验入参为字符串");

  // onCaptureImport 必须返回退订函数,且 desktop-capture:import IPC 转发到回调
  let received = null;
  const off = bridge.onCaptureImport((payload) => {
    received = payload;
  });
  assert.equal(typeof off, "function", "onCaptureImport 必须返回退订函数");
  for (const fn of ipcListeners["desktop-capture:import"] || []) {
    fn({}, { html: "<x>", url: "u" });
  }
  assert.ok(received, "desktop-capture:import IPC 必须转发给 onCaptureImport 回调");
  off();
}

console.log("desktop Claude core tests passed");
