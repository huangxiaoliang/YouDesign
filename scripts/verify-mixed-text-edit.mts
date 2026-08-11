// 修复验证：图标+文字混排区块的文字编辑。
// 用 jsdom 构造真实 DOM，直接调源码函数，断言核心保证。
import { JSDOM } from "jsdom";
import {
  readDirectTextBinding,
  captureDirectText,
  applyDirectEditChange,
  composeDirectTextAfter,
} from "../src/lib/directHtmlEditor.ts";

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
const document = dom.window.document;
// 把 jsdom 的全局暴露给模块内部用到的 Node.TEXT_NODE 等
globalThis.Node = dom.window.Node;

function assert(cond, msg) {
  if (!cond) {
    console.error("✗ FAIL: " + msg);
    process.exitCode = 1;
  } else {
    console.log("✓ " + msg);
  }
}

// ---- 场景 1：图标 + 文字混排按钮 <button><i class="icon"></i>查询</button> ----
{
  const button = document.createElement("button");
  const icon = document.createElement("i");
  icon.className = "icon";
  icon.innerHTML = "&#xe001;";
  button.appendChild(icon);
  button.appendChild(document.createTextNode("查询"));

  // 修复前：childElementCount=1 → 返回 null；修复后应返回 text 绑定带 nodeIndex
  const binding = readDirectTextBinding(button);
  assert(binding !== null, "混排按钮能读出文字绑定（修复前为 null）");
  assert(binding?.kind === "text", "kind === text");
  assert(binding?.value === "查询", `value === "查询"，实际：${JSON.stringify(binding?.value)}`);
  assert(typeof binding?.nodeIndex === "number", "带 nodeIndex");
  assert(binding?.nodeIndex === 1, `nodeIndex 指向文本节点(1)，实际：${binding?.nodeIndex}`);

  // 模拟属性面板输入新文案
  const before = captureDirectText(button, binding.kind, binding.nodeIndex);
  assert(before.value === "查询", `capture before === "查询"，实际：${before.value}`);

  const change = {
    kind: "text",
    element: button,
    textKind: binding.kind,
    nodeIndex: binding.nodeIndex,
    before,
    after: { value: "搜索", hadAttribute: true },
  };
  applyDirectEditChange(change, "after");

  // 关键断言：图标还在且未变；文字已改
  const iconAfter = button.querySelector("i.icon");
  assert(iconAfter !== null, "写入后 <i> 图标子元素仍在（未被 textContent 冲掉）");
  assert(iconAfter === icon, "图标是同一个节点引用（未被替换）");
  assert(iconAfter.textContent.charCodeAt(0) === 57345, "图标字形字符(U+E001)未变");
  assert(button.childNodes.length === 2, "子节点数仍为 2（未增删节点）");
  assert(button.lastChild.nodeType === 3 && button.lastChild.nodeValue === "搜索", "文本节点值已改为「搜索」");

  // 重新读取应反映新文案
  const reRead = readDirectTextBinding(button);
  assert(reRead?.value === "搜索", `重读 binding.value === "搜索"，实际：${reRead?.value}`);
  assert(reRead?.nodeIndex === 1, "重读 nodeIndex 稳定仍为 1");

  // undo：回 before
  applyDirectEditChange(change, "before");
  assert(button.querySelector("i.icon") !== null, "undo 后图标仍在");
  assert(button.lastChild.nodeValue === "查询", "undo 后文字回到「查询」");
  assert(button.childNodes.length === 2, "undo 后子节点数仍为 2");
}

// ---- 场景 2：svg 图标 + 文字 ----
{
  const link = document.createElement("a");
  const svg = document.createElement("svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  link.appendChild(svg);
  link.appendChild(document.createTextNode(" 下载"));

  const binding = readDirectTextBinding(link);
  assert(binding !== null, "svg+文字混排能读出绑定");
  assert(binding?.value === "下载", `显示值 trim 为「下载」（原 " 下载"），实际：${JSON.stringify(binding?.value)}`);
  assert(binding?.nodeIndex === 1, `nodeIndex=1，实际：${binding?.nodeIndex}`);

  const before = captureDirectText(link, binding.kind, binding.nodeIndex);
  applyDirectEditChange(
    { kind: "text", element: link, textKind: binding.kind, nodeIndex: binding.nodeIndex, before, after: { value: " 导出", hadAttribute: true } },
    "after"
  );
  assert(link.querySelector("svg") !== null, "写入后 <svg> 仍在");
  assert(link.lastChild.nodeValue === " 导出", "svg+文字 文案已改为「 导出」");
}

// ---- 场景 3：纯文字叶子（回归：原有能力不受影响） ----
{
  const span = document.createElement("span");
  span.textContent = "标题";
  const binding = readDirectTextBinding(span);
  assert(binding !== null, "纯文字叶子仍可绑定（回归）");
  assert(binding?.nodeIndex === undefined, "纯文字叶子 nodeIndex 为 undefined（走 textContent 路径）");
  const before = captureDirectText(span, binding.kind, binding.nodeIndex);
  applyDirectEditChange(
    { kind: "text", element: span, textKind: binding.kind, before, after: { value: "新标题", hadAttribute: true } },
    "after"
  );
  assert(span.textContent === "新标题", "纯文字叶子写入走 textContent 成功");
  assert(span.childElementCount === 0, "纯文字叶子无子元素");
}

// ---- 场景 4：混排但无可编辑文本（只有图标/空白）应返回 null ----
{
  const btn = document.createElement("button");
  const i = document.createElement("i");
  btn.appendChild(i);
  btn.appendChild(document.createTextNode("   ")); // 仅空白
  const binding = readDirectTextBinding(btn);
  assert(binding === null, "混排但仅空白文本 → null（不绑定空白）");
}

// ---- 场景 5：混排多文本片段，只绑定第一个非空（已知限制，记录行为） ----
{
  const btn = document.createElement("button");
  btn.appendChild(document.createTextNode("保存"));
  const i = document.createElement("i");
  btn.appendChild(i);
  btn.appendChild(document.createTextNode("查询"));
  const binding = readDirectTextBinding(btn);
  assert(binding?.value === "保存", "多文本片段绑定第一个非空「保存」");
  applyDirectEditChange(
    { kind: "text", element: btn, textKind: "text", nodeIndex: binding.nodeIndex, before: captureDirectText(btn, "text", binding.nodeIndex), after: { value: "暂存", hadAttribute: true } },
    "after"
  );
  assert(btn.firstChild.nodeValue === "暂存", "只改第一个文本节点");
  assert(btn.lastChild.nodeValue === "查询", "第二个文本节点「查询」未被波及");
  assert(btn.querySelector("i") !== null, "中间图标未丢");
}

// ---- 场景 6：UX 修复——显示 trim 干净文本，写入保留前后空白（图标间距不丢） ----
{
  // 模拟生成 HTML 的真实形态：<div class="nav-item"><svg/>[换行+缩进]工作台[换行+缩进]</div>
  const nav = document.createElement("div");
  nav.className = "nav-item";
  const svg = document.createElement("svg");
  nav.appendChild(svg);
  // 注意：文本节点带源码缩进（前后空白），且是唯一非空文本节点
  nav.appendChild(document.createTextNode("\n        工作台\n      "));

  const binding = readDirectTextBinding(nav);
  // 显示值 trim：用户在 textarea 里看到的是干净的「工作台」而非缩进原文
  assert(binding?.value === "工作台", `显示值 trim 为「工作台」，实际：${JSON.stringify(binding?.value)}`);

  // 模拟用户把「工作台」改成「工作台测」
  const before = captureDirectText(nav, "text", binding.nodeIndex);
  assert(before.value === "\n        工作台\n      ", `before 存原始含空白值（DOM 真值，用于 history）`);
  const after = composeDirectTextAfter(before, "text", "工作台测");
  assert(after.value === "\n        工作台测\n      ", `after 保留前后空白、核心替换为「工作台测」，实际：${JSON.stringify(after.value)}`);

  applyDirectEditChange({ kind: "text", element: nav, textKind: "text", nodeIndex: binding.nodeIndex, before, after }, "after");

  // 图标仍在
  assert(nav.querySelector("svg") !== null, "UX 修复：写入后 svg 图标仍在");
  // 「测」紧接「工作台」之后（不是落在结尾空白之后）
  const txt = nav.lastChild.nodeValue;
  assert(/工作台测/.test(txt) && !/工作台\n.*测/.test(txt), `「测」紧接「工作台」之后，实际：${JSON.stringify(txt)}`);
  // 前后空白保留（图标与文字间距来源）
  assert(/^\n\s+工作台测\n\s+$/.test(txt), `前后空白保留，实际：${JSON.stringify(txt)}`);

  // undo 回 before：原始空白完整恢复
  applyDirectEditChange({ kind: "text", element: nav, textKind: "text", nodeIndex: binding.nodeIndex, before, after }, "before");
  assert(nav.lastChild.nodeValue === "\n        工作台\n      ", "undo 后原始含空白值完整恢复");
  assert(nav.querySelector("svg") !== null, "undo 后图标仍在");

  // 重新读取显示值仍干净
  assert(readDirectTextBinding(nav)?.value === "工作台", "undo 后重读显示值仍为干净「工作台」");
}

console.log("\n完成。");

