#!/usr/bin/env node
// 标注功能端到端自测脚本（仅测 /api/generate 的 raw-HTML 标注编辑链路）
// 用法：
//   node scripts/test-annotation.mjs gen   > /tmp/yd-base.html      生成基底原型
//   node scripts/test-annotation.mjs anno                              跑全部标注用例
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHmac } from "node:crypto";

const BASE = "http://localhost:3001/youdesign";
const __dirname2 = dirname(fileURLToPath(import.meta.url));
function envLocal(key) {
  try {
    const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    const m = new RegExp(`^${key}=(.*)$`, "m").exec(txt);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}
const AUTH_SECRET = envLocal("YOUDESIGN_AUTH_SECRET");
if (!AUTH_SECRET) {
  console.error("未在 .env.local 找到 YOUDESIGN_AUTH_SECRET");
  process.exit(1);
}
// yd_auth cookie 是 HMAC 签名的 `userId.exp.sig`，不能直接用原始 secret。
const TEST_USER_ID = process.env.YD_TEST_USER_ID || "u_a5b71674cc67";
function signCookie(secret, userId, ttlSec = 604800) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${userId}.${exp}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `yd_auth=${payload}.${sig}`;
}
const AUTH_COOKIE = signCookie(AUTH_SECRET, TEST_USER_ID);
const OUT_DIR = join(__dirname2, "..", "output", "test-report", "标注功能自测");
const BASE_HTML_PATH = join(OUT_DIR, "base-prototype.html");
const RESULT_PATH = join(OUT_DIR, "anno-result.json");
mkdirSync(OUT_DIR, { recursive: true });

// 取一个示意提示词（来源 src/app/example-prompts.ts，反引号模板字面量）
function loadExamplePrompt(titleKeyword) {
  const src = readFileSync(new URL("../src/app/example-prompts.ts", import.meta.url), "utf8");
  const titleIdx = src.indexOf(titleKeyword);
  if (titleIdx < 0) throw new Error(`找不到含「${titleKeyword}」的示例提示词`);
  // 从该位置向后找 prompt: ` 起始
  const pStart = src.indexOf("prompt: `", titleIdx);
  if (pStart < 0) throw new Error("找不到 prompt 字段");
  const tickStart = pStart + "prompt: ".length + 1; // 跳过 `prompt: ` 与反引号
  // 找到未转义的结束反引号
  let i = tickStart;
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === "`") break;
    i++;
  }
  return src.slice(tickStart, i);
}
const PROMPT = loadExamplePrompt("财务总览仪表盘");

function cookieHeader() {
  return { cookie: AUTH_COOKIE, "content-type": "application/json" };
}

/** 调用 /api/generate，流式收集事件，返回 { code, preview, events, raw } */
async function generate(body) {
  const res = await fetch(`${BASE}/api/generate`, {
    method: "POST",
    headers: cookieHeader(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let code = "";
  let preview = null;
  let done = null;
  const steps = [];
  const assistant = [];
  for (;;) {
    const { value, done: rdone } = await reader.read();
    if (rdone) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "code") code = ev.code;
      else if (ev.type === "preview") preview = ev.preview;
      else if (ev.type === "done") done = ev.result;
      else if (ev.type === "step") steps.push(`${ev.stage}:${ev.status}:${ev.detail ?? ""}`);
      else if (ev.type === "assistant") assistant.push(ev.message);
    }
  }
  return { code: done?.code ?? code, preview, done, steps, assistant };
}

async function genBase() {
  console.error("[gen] 生成基底原型（useDpl=false, fastMode）...");
  const t0 = Date.now();
  const r = await generate({
    requirement: PROMPT,
    mode: "generate",
    useDpl: false,
    fastMode: true,
    allowClarify: false,
    modelPreference: "auto",
  });
  const dt = Date.now() - t0;
  if (!r.code) {
    console.error("[gen] 未拿到 code；steps:", r.steps);
    process.exit(2);
  }
  writeFileSync(BASE_HTML_PATH, r.code);
  console.error(`[gen] 完成 ${dt}ms，长度 ${r.code.length}，写入 ${BASE_HTML_PATH}`);
  console.error("[gen] steps:", r.steps.join(" | "));
}

// —— 轻量 HTML 工具：与 htmlScopePatch.ts 一致的 regex 风格 ——

const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);

/** 找到第 n 个 (0-base) 指定标签的完整 outerHTML（平衡匹配） */
function nthOuterHTML(html, tag, n = 0) {
  const openRe = new RegExp(`<${tag}(?=\\s|>|/)[^>]*?>`, "gi");
  let m;
  let count = 0;
  while ((m = openRe.exec(html))) {
    if (count++ !== n) continue;
    const start = m.index;
    const openTag = m[0];
    if (VOID.has(tag) || /\/\s*>$/.test(openTag)) return { start, end: start + openTag.length, outer: openTag, openTag };
    // 平衡匹配到对应 </tag>
    const closeRe = new RegExp(`</${tag}\\s*>`, "gi");
    const anyTagRe = new RegExp(`</?${tag}(?=\\s|>|/)[^>]*?>`, "gi");
    anyTagRe.lastIndex = start + openTag.length;
    let depth = 1;
    let tm;
    let endIdx = -1;
    while ((tm = anyTagRe.exec(html))) {
      if (tm[0].startsWith("</")) {
        depth--;
        if (depth === 0) { endIdx = tm.index + tm[0].length; break; }
      } else if (!/\/\s*>$/.test(tm[0])) {
        depth++;
      }
    }
    if (endIdx < 0) return null;
    return { start, end: endIdx, outer: html.slice(start, endIdx), openTag };
  }
  return null;
}

/** 在 outerHTML 的开标签注入 data-yd-anchor 属性 */
function injectAnchor(outer, anchorId) {
  return outer.replace(/^<([a-zA-Z][\w:-]*)(\s|>|\/)/, `<$1 data-yd-anchor="${anchorId}"$2`);
}

function buildInstruction(note, outerWithAnchor, anchorId) {
  return (
    `针对页面中这个元素附近进行修改：${note}\n\n` +
    `目标元素（请在原 HTML 中精确定位，以它为锚点选择合适作用域修改，其余保持不变）：\n` +
    `<!-- yd-anchor:${anchorId} -->\n${outerWithAnchor}`
  );
}

/** 把 anchor 属性注入到 original HTML 中对应元素的位置（用 nthOuterHTML 的 start/end） */
function injectAnchorIntoDoc(html, tag, n, anchorId) {
  const f = nthOuterHTML(html, tag, n);
  if (!f) return null;
  const newOuter = injectAnchor(f.outer, anchorId);
  return { html: html.slice(0, f.start) + newOuter + html.slice(f.end), outer: newOuter, found: f };
}

// —— 平衡匹配：按开标签正则找首个元素 outerHTML ——
function findOuterByOpen(html, openRegex) {
  const m = openRegex.exec(html);
  if (!m) return null;
  const start = m.index;
  const openTag = m[0];
  const tag = /^<([a-zA-Z][\w:-]*)/.exec(openTag)[1].toLowerCase();
  if (VOID.has(tag) || /\/\s*>$/.test(openTag)) return { start, end: start + openTag.length, outer: openTag, openTag, tag };
  const anyRe = new RegExp(`</?${tag}(?=\\s|>|/)[^>]*?>`, "gi");
  anyRe.lastIndex = start + openTag.length;
  let depth = 1, endIdx = -1, tm;
  while ((tm = anyRe.exec(html))) {
    if (tm[0].startsWith("</")) { depth--; if (depth === 0) { endIdx = tm.index + tm[0].length; break; } }
    else if (!/\/\s*>$/.test(tm[0])) depth++;
  }
  if (endIdx < 0) return null;
  return { start, end: endIdx, outer: html.slice(start, endIdx), openTag, tag };
}

function injectAnchorOuter(outer, anchorId) {
  return outer.replace(/^<([a-zA-Z][\w:-]*)(\s|>|\/)/, `<$1 data-yd-anchor="${anchorId}"$2`);
}
function injectAnchorIntoDocByOpen(html, openRegex, anchorId) {
  const f = findOuterByOpen(html, openRegex);
  if (!f) return null;
  const newOuter = injectAnchorOuter(f.outer, anchorId);
  return { html: html.slice(0, f.start) + newOuter + html.slice(f.end), outer: newOuter, found: f };
}

// 第 n 个匹配（1-based order）的开标签
function nthOpenRegex(tag, n) {
  // 用函数式查找第 n 个
  return null; // 占位，实际用 findByOpenN
}
function findOuterByOpenN(html, openRegex, n) {
  let f, i = 0;
  const re = new RegExp(openRegex.source, openRegex.flags.includes("g") ? openRegex.flags : openRegex.flags + "g");
  while ((f = re.exec(html))) {
    i++;
    if (i === n) {
      // 用 findOuterByOpen 逻辑复算（re.exec 的 m 即开标签）
      const start = f.index;
      const openTag = f[0];
      const tag = /^<([a-zA-Z][\w:-]*)/.exec(openTag)[1].toLowerCase();
      if (VOID.has(tag) || /\/\s*>$/.test(openTag)) return { start, end: start + openTag.length, outer: openTag, openTag, tag };
      const anyRe = new RegExp(`</?${tag}(?=\\s|>|/)[^>]*?>`, "gi");
      anyRe.lastIndex = start + openTag.length;
      let depth = 1, endIdx = -1, tm;
      while ((tm = anyRe.exec(html))) {
        if (tm[0].startsWith("</")) { depth--; if (depth === 0) { endIdx = tm.index + tm[0].length; break; } }
        else if (!/\/\s*>$/.test(tm[0])) depth++;
      }
      if (endIdx < 0) return null;
      return { start, end: endIdx, outer: html.slice(start, endIdx), openTag, tag };
    }
  }
  return null;
}

function titleOf(html) {
  return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
}
function normalizeText(s) { return s.replace(/\s+/g, " ").trim(); }

// 行级 diff：返回 { same, added, removed, changedLines }
function lineDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  const n = A.length, m = B.length;
  // LCS DP（base ~600 行，可接受）
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, same = 0, added = 0, removed = 0;
  const changed = [];
  while (i < n && j < m) {
    if (A[i] === B[j]) { i++; j++; same++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { removed++; changed.push(`- ${A[i].trim().slice(0,100)}`); i++; }
    else { added++; changed.push(`+ ${B[j].trim().slice(0,100)}`); j++; }
  }
  while (i < n) { removed++; changed.push(`- ${A[i++].trim().slice(0,100)}`); }
  while (j < m) { added++; changed.push(`+ ${B[j++].trim().slice(0,100)}`); }
  return { same, added, removed, changed };
}

// —— 10 个标注用例 ——
const CASES = [
  {
    id: "C1-改文案",
    open: /<button[^>]*id="smartBookBtn"[^>]*>/,
    note: "把这个按钮的文字改成「快速记账」",
    verify: (base, out) => {
      const el = findOuterByOpen(out, /<button[^>]*id="smartBookBtn"[^>]*>/);
      const ok = !!el && el.outer.includes("快速记账") && !el.outer.includes("智能记账");
      return { ok, detail: el ? `按钮外层: ${el.outer.slice(0,120)}` : "未找到 smartBookBtn" };
    },
  },
  {
    id: "C2-改数值",
    open: /<div class="kpi-value">/,
    note: "把这个金额数字改成 ¥320,000",
    verify: (base, out) => {
      const el = findOuterByOpen(out, /<div class="kpi-value">/);
      const ok = !!el && el.outer.includes("¥320,000") && !el.outer.includes("¥286,500");
      return { ok, detail: el ? el.outer : "未找到 kpi-value" };
    },
  },
  {
    id: "C3-改颜色",
    open: /<button[^>]*id="smartBookBtn"[^>]*>/,
    note: "把这个按钮的背景色改成绿色，使用颜色 #00C853",
    verify: (base, out) => {
      const el = findOuterByOpen(out, /<button[^>]*id="smartBookBtn"[^>]*>/);
      const has = !!el && /00c853/i.test(el.outer);
      return { ok: has, detail: el ? el.outer.slice(0,200) : "未找到按钮" };
    },
  },
  {
    id: "C4-改图标",
    open: /<i>/,
    note: "把这个图标改成 🏢",
    verify: (base, out) => {
      // 首页 nav 的 i：找首个 <i>（开标签正则，平衡匹配到 </i>）
      const el = findOuterByOpen(out, /<i>/);
      const ok = !!el && el.outer.includes("🏢") && !el.outer.includes("🏠");
      return { ok, detail: el ? el.outer : "未找到 <i>" };
    },
  },
  {
    id: "C5-新增(扩作用域)",
    open: /<div class="nav-item"><i>⚙️<\/i>\s*设置<\/div>/,
    note: "在「设置」的上方新增一个导航项「帮助」，图标用 ❓",
    verify: (base, out) => {
      const hasHelp = /<div class="nav-item"[^>]*><i>❓<\/i>\s*帮助<\/div>/.test(out) || /帮助/.test(out);
      const hasIcon = out.includes("❓");
      const ok = hasHelp && hasIcon;
      return { ok, detail: `含「帮助」=${/帮助/.test(out)}，含❓=${hasIcon}` };
    },
  },
  {
    id: "C6-删除",
    open: /<div class="nav-item"><i>🧮<\/i>\s*税务<\/div>/,
    note: "删除这个导航项",
    verify: (base, out) => {
      const gone = !/<i>🧮<\/i>\s*税务/.test(out);
      const ok = gone;
      return { ok, detail: `税务 nav-item 已移除=${gone}` };
    },
  },
  {
    id: "C7-改占位符",
    open: /<input type="text" placeholder="搜索凭证[^"]*">/,
    note: "把搜索框的占位符改成「输入凭证号或客户名」",
    verify: (base, out) => {
      const el = findOuterByOpen(out, /<input[^>]*placeholder="输入凭证号或客户名"[^>]*>/);
      const oldGone = !/<input[^>]*placeholder="搜索凭证、客户[^"]*">/.test(out);
      const ok = !!el && oldGone;
      return { ok, detail: el ? el.outer : "未找到改后搜索框" };
    },
  },
  {
    id: "C8-新增子元素",
    open: /<div class="kpi-card" data-kpi="income">/,
    note: "在这张卡片的底部加一行小字「(含税)」",
    verify: (base, out) => {
      const el = findOuterByOpen(out, /<div class="kpi-card" data-kpi="income">/);
      const ok = !!el && el.outer.includes("含税");
      return { ok, detail: el ? `卡片含「含税」=${el.outer.includes("含税")}` : "未找到 income 卡片" };
    },
  },
  {
    id: "C9-移动重排",
    open: /<div class="nav-item"><i>⚙️<\/i>\s*设置<\/div>/,
    note: "把「设置」这一项移到导航菜单的最顶部",
    verify: (base, out) => {
      const setIdx = out.indexOf('<i>⚙️</i>');
      const homeIdx = out.indexOf('<i>🏠</i>');
      const ok = setIdx >= 0 && homeIdx >= 0 && setIdx < homeIdx;
      return { ok, detail: `设置@${setIdx} 首页@${homeIdx} → 设置在前=${ok}` };
    },
  },
  {
    id: "C10-改徽标文本",
    open: /<span class="up">/,
    note: "把这个增长率改成 ↑ 15.6%",
    verify: (base, out) => {
      const ok = out.includes("↑ 15.6%") && !out.includes("↑ 8.2%");
      return { ok, detail: `含↑15.6%=${out.includes("↑ 15.6%")}，仍含↑8.2%=${out.includes("↑ 8.2%")}` };
    },
  },
];

async function runAnno() {
  if (!existsSync(BASE_HTML_PATH)) {
    console.error("基底原型不存在，先跑: node scripts/test-annotation.mjs gen");
    process.exit(2);
  }
  const base = readFileSync(BASE_HTML_PATH, "utf8");
  const baseTitle = titleOf(base);
  const results = [];
  const onlyArg = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  const onlySet = onlyArg ? new Set(onlyArg.split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const runCases = onlySet ? CASES.filter((c) => onlySet.has(c.id.split("-")[0])) : CASES;
  for (let k = 0; k < runCases.length; k++) {
    const c = runCases[k];
    const anchorId = `yd-test${k + 1}`;
    const inj = injectAnchorIntoDocByOpen(base, c.open, anchorId);
    if (!inj) {
      results.push({ id: c.id, status: "TARGET_NOT_FOUND", note: c.note });
      console.log(`[${c.id}] 目标元素未找到，跳过`);
      continue;
    }
    const instruction = buildInstruction(c.note, inj.outer, anchorId);
    const t0 = Date.now();
    let res, err;
    try {
      res = await generate({
        requirement: instruction,
        mode: "edit",
        previous: {
          code: inj.html,
          flow: { title: "财务总览", pages: [] },
          components: [],
          useDpl: false,
          rawHtml: true,
          html: true,
          device: "pc",
          modelPreference: "auto",
        },
        useDpl: false,
        fastMode: true,
        allowClarify: false,
        modelPreference: "auto",
      });
    } catch (e) { err = String(e); }
    const dt = Date.now() - t0;
    if (err) {
      results.push({ id: c.id, status: "ERROR", note: c.note, error: err, dt });
      console.log(`[${c.id}] ERROR ${err} (${dt}ms)`);
      continue;
    }
    const out = res.code || "";
    const outTitle = titleOf(out);
    const intact = outTitle === baseTitle && out.length >= base.length * 0.55 && out.length <= base.length * 2.2 &&
      /<\/body>/i.test(out) && /<\/html>/i.test(out);
    const scopeStep = res.steps.find((s) => s.startsWith("edit:start:局部作用域"));
    const failStep = res.steps.find((s) => s.includes("已保留原页面"));
    const v = c.verify(base, out);
    const diff = lineDiff(base, out);
    // 局部化：未变行占比高 + 变化行数少
    const totalLines = base.split("\n").length;
    const changedLines = diff.added + diff.removed;
    const localized = changedLines <= Math.max(20, totalLines * 0.15);
    const status = (!intact) ? "BROKEN" : (failStep ? "REJECTED_BY_SERVER" : v.ok ? (localized ? "PASS" : "APPLIED_NOT_LOCALIZED") : "NOT_APPLIED");
    const r = {
      id: c.id, note: c.note, status, dt,
      intact, applied: v.ok, localized, changedLines, totalLines,
      scopeStep, failStep, verifyDetail: v.detail,
      assistant: res.assistant, outLen: out.length, baseLen: base.length,
      diffSample: diff.changed.slice(0, 12),
    };
    results.push(r);
    console.log(`[${c.id}] ${status} | applied=${v.ok} intact=${intact} local=${localized} changed=${changedLines}/${totalLines} (${dt}ms)`);
    if (failStep || !v.ok) console.log(`    详情: ${v.detail} | ${failStep || ""} | assistant=${res.assistant.join(" / ")}`);
  }
  writeFileSync(RESULT_PATH, JSON.stringify(results, null, 2));
  console.log(`\n结果已写入 ${RESULT_PATH}`);
  // 汇总
  const sum = {};
  for (const r of results) sum[r.status] = (sum[r.status] || 0) + 1;
  console.log("汇总:", sum);
}

const cmd = process.argv[2] || "anno";
if (cmd === "gen") {
  genBase().catch((e) => { console.error(e); process.exit(1); });
} else {
  runAnno().catch((e) => { console.error(e); process.exit(1); });
}
