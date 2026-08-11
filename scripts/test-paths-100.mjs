#!/usr/bin/env node
// 100 条用户路径端到端测试 → JSON 结果（供生成 HTML 报告）
// 断点续跑：已完成的 id 跳过。每条完成即 flush 到 result.json。
// 用法：node scripts/test-paths-100.mjs [--from <id>]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHmac } from "node:crypto";

const BASE = "http://localhost:3001/youdesign";
const __d = dirname(fileURLToPath(import.meta.url));
const OUT = join(__d, "..", "output", "test-report", "100paths");
mkdirSync(OUT, { recursive: true });
const RESULT = join(OUT, "result.json");
const RAW_BASE_PATH = join(__d, "..", "output", "test-report", "对话框迭代自测", "base.html");
const DPL_BASE_PATH = join(OUT, "dpl-base.jsx");

function envLocal(k) {
  try { const t = readFileSync(new URL("../.env.local", import.meta.url), "utf8"); const m = new RegExp(`^${k}=(.*)$`, "m").exec(t); return m ? m[1].trim() : ""; }
  catch { return ""; }
}
const AUTH = envLocal("YOUDESIGN_AUTH_SECRET");
if (!AUTH) { console.error("无 YOUDESIGN_AUTH_SECRET"); process.exit(1); }
// yd_auth cookie 是 HMAC 签名的 `userId.exp.sig`（见 src/lib/auth/session.ts），
// 不能直接用原始 secret。这里用「自测员」userId 签出合法 cookie。
const TEST_USER_ID = process.env.YD_TEST_USER_ID || "u_a5b71674cc67";
function signCookie(secret, userId, ttlSec = 604800) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${userId}.${exp}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `yd_auth=${payload}.${sig}`;
}
const COOKIE = signCookie(AUTH, TEST_USER_ID);
const RAW_BASE = readFileSync(RAW_BASE_PATH, "utf8");

// —— 调 /api/generate，流式收集 ——
async function callApi(body) {
  const res = await fetch(`${BASE}/api/generate`, { method: "POST", headers: { cookie: COOKIE, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) { const t = await res.text(); throw new Error(`HTTP ${res.status}: ${t.slice(0,200)}`); }
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = "", code = "", done = null; const steps = [], assistant = [];
  for (;;) { const { value, done: rd } = await reader.read(); if (rd) break; buf += dec.decode(value, { stream: true });
    let nl; while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "code") code = ev.code;
      else if (ev.type === "done") done = ev.result;
      else if (ev.type === "step") steps.push(`${ev.stage}:${ev.status}:${ev.detail ?? ""}`);
      else if (ev.type === "assistant") assistant.push(ev.message);
    }
  }
  return { code: done?.code ?? code, done, steps, assistant };
}

// —— 通用完整性 ——
function intactRaw(base, out) {
  if (!out) return { ok: false, detail: "无产出" };
  const valid = /<!doctype/i.test(out) && /<html/i.test(out) && /<body/i.test(out) && /<\/html>/i.test(out);
  const titleOk = /<title[^>]*>\s*[^<\s][^<]*<\/title>/i.test(out);
  const ratio = out.length / Math.max(1, base.length);
  const notShrunk = out.length >= base.length * 0.55;
  const notBlew = out.length <= base.length * 2.5;
  return { ok: valid && titleOk && notShrunk && notBlew, detail: `valid=${valid} title=${titleOk} ratio=${ratio.toFixed(2)} shrink=${notShrunk} blew=${notBlew} len=${out.length}` };
}
function intactDpl(base, out) {
  if (!out) return { ok: false, detail: "无产出" };
  const ratio = out.length / Math.max(1, base.length);
  const hasExport = /export\s+default/i.test(out);
  const notShrunk = out.length >= base.length * 0.3;
  const notBlew = out.length <= base.length * 3;
  return { ok: hasExport && notShrunk && notBlew, detail: `export=${hasExport} ratio=${ratio.toFixed(2)} len=${out.length}` };
}

// —— 路径探测 ——
function detectPath(steps) {
  const noop = steps.some((s) => s.includes("局部修改未生效"));
  const scope = steps.some((s) => s.includes("局部作用域修改"));
  const hit = steps.some((s) => s.includes("已定位目标"));
  const miss = steps.some((s) => s.includes("未定位到明确目标"));
  if (noop) return "locate→noop→full";
  if (scope) return hit ? "locate→scope" : "marker→scope";
  if (miss) return "locate→fallback";
  return "full-rewrite";
}

// —— marker 注入：找首个匹配元素，注入 data-yd-anchor，返回 {code, outerHTML, anchorId} ——
function injectAnchor(html, tagRegex) {
  const m = new RegExp(`<(${tagRegex})(\\s[^<>]*?)?>`, "i").exec(html);
  if (!m) return null;
  const anchorId = `yd-${Date.now().toString(36)}`;
  const insertAt = m.index + m[0].length - 1; // 标签结束 '>' 前
  const openWithTag = m[0].slice(0, -1) + ` data-yd-anchor="${anchorId}"` + ">";
  let code = html.slice(0, m.index) + openWithTag + html.slice(m.index + m[0].length);
  // 取该元素 outerHTML（粗略：从开标签到对应闭标签）
  const tag = m[1].toLowerCase();
  const after = code.slice(m.index);
  const closeRe = new RegExp(`</${tag}\\s*>`, "i");
  const closeM = closeRe.exec(after);
  let outerHTML = closeM ? after.slice(0, closeM.index + closeM[0].length) : after.slice(0, 1500);
  outerHTML = outerHTML.slice(0, 1500);
  return { code, outerHTML, anchorId };
}
const MARKER = "\n\n目标元素（请在原 HTML 中精确定位，以它为锚点选择合适作用域修改，其余保持不变）：\n";

// —— 用例定义 ——
// kind: gen-raw | gen-dpl | edit-raw | edit-raw-marker | edit-dpl | open-html | ask
// 每个: { id, g, kind, instr, base?, build?, verify? }
// base: 'raw' | 'dpl' ; 默认 raw
const U = (base, out) => intactRaw(base, out); // 通用占位

const CASES = [
  // G1 生成
  { id: "C01", g: "G1生成", kind: "gen-raw", instr: "做一个 PC 端财务总览仪表盘，含 KPI 卡片、表格、左侧导航", verify: (b, o) => intactRaw(RAW_BASE.length > 0 ? o : o, o) },
  { id: "C02", g: "G1生成", kind: "gen-dpl", instr: "用 DPL 组件做一个 PC 端财务后台首页" },
  { id: "C03", g: "G1生成", kind: "gen-raw", instr: "做一个移动端 H5 个人中心页面，包含用户头像、功能宫格菜单、订单状态入口，手机端布局" },
  { id: "C04", g: "G1生成", kind: "gen-dpl", instr: "用 DPL 组件做一个移动端 H5 订单列表页，顶部带返回按钮的标题栏，每条订单卡片显示订单号、金额、状态标签" },
  { id: "C06", g: "G1生成", kind: "gen-raw", instr: "做一个 PC 端销售运营仪表盘，顶部 4 个 KPI 卡片，下方柱状图区域展示近 6 个月销售趋势，底部近期订单表格" },
  { id: "C09", g: "G1生成", kind: "gen-raw", allowClarify: true, instr: "做个页面", verify: (b, o) => ({ ok: !o || o.length === 0, detail: "模糊需求应反问、不直接产代码" }) },

  // G2 精确单元素改（15）
  { id: "E01", g: "G2精确改", kind: "edit-raw", instr: '把页面主标题「财务总览仪表盘」改成「财税驾驶舱」', verify: (b, o) => ({ ok: o.includes("财税驾驶舱") && !o.includes("财务总览仪表盘"), detail: "标题替换" }) },
  { id: "E02", g: "G2精确改", kind: "edit-raw", instr: '把金额「¥ 486,200」改成「¥999,888」', verify: (b, o) => ({ ok: o.includes("999,888"), detail: "金额改" }) },
  { id: "E03", g: "G2精确改", kind: "edit-raw", instr: '把「智能记账」按钮文字改成「快速记账」', verify: (b, o) => ({ ok: o.includes("快速记账"), detail: "按钮文案" }) },
  { id: "E04", g: "G2精确改", kind: "edit-raw", instr: '把面包屑「首页」改成「工作台」' },
  { id: "E05", g: "G2精确改", kind: "edit-raw", instr: '把 tab「税务」改成「税务管理」' },
  { id: "E06", g: "G2精确改", kind: "edit-raw", instr: '把搜索框占位符「请输入」改成「搜索关键词」' },
  { id: "E07", g: "G2精确改", kind: "edit-raw", instr: '把表头「金额」改成「金额（元）」' },
  { id: "E08", g: "G2精确改", kind: "edit-raw", instr: '把页脚版权年份 2025 改成 2026', verify: (b, o) => ({ ok: o.includes("2026"), detail: "年份" }) },
  { id: "E09", g: "G2精确改", kind: "edit-raw", instr: '把「刷新」按钮改成「同步」' },
  { id: "E10", g: "G2精确改", kind: "edit-raw", instr: '把 KPI 卡标题「本月营收」改成「本月收入」' },
  { id: "E11", g: "G2精确改", kind: "edit-raw", instr: '把提示语「数据加载中」改成「正在加载」' },
  { id: "E12", g: "G2精确改", kind: "edit-raw", instr: '把「查看详情」链接改成「展开明细」' },
  { id: "E13", g: "G2精确改", kind: "edit-raw", instr: '把单位「万元」改成「元」' },
  { id: "E14", g: "G2精确改", kind: "edit-raw", instr: '把空状态文案「暂无数据」改成「还没有数据」' },
  { id: "E15", g: "G2精确改", kind: "edit-raw", instr: '把日期「2025-07-04」改成「2026-07-04」' },

  // G3 新增/插入（10）
  { id: "E16", g: "G3新增", kind: "edit-raw", instr: '在「待办事项」区域新增一条「待确认费用分摊」', verify: (b, o) => ({ ok: o.includes("待确认费用分摊"), detail: "sentinel" }) },
  { id: "E17", g: "G3新增", kind: "edit-raw", instr: '在左侧导航新增一项「审计」', verify: (b, o) => ({ ok: o.includes("审计"), detail: "新导航" }) },
  { id: "E18", g: "G3新增", kind: "edit-raw", instr: '在表格末尾新增一行数据' },
  { id: "E19", g: "G3新增", kind: "edit-raw", instr: '在表格加一列「状态」', verify: (b, o) => ({ ok: o.includes("状态"), detail: "新列" }) },
  { id: "E20", g: "G3新增", kind: "edit-raw", instr: '新增一个统计卡片显示「活跃用户」', verify: (b, o) => ({ ok: o.includes("活跃用户"), detail: "sentinel" }) },
  { id: "E21", g: "G3新增", kind: "edit-raw", instr: '在页面底部加页脚版权「© 2026 亿企赢」', verify: (b, o) => ({ ok: o.includes("2026"), detail: "页脚" }) },
  { id: "E22", g: "G3新增", kind: "edit-raw", instr: '给「智能记账」按钮加一个徽标「3」' },
  { id: "E23", g: "G3新增", kind: "edit-raw", instr: '在表单里新增一个「备注」输入框', verify: (b, o) => ({ ok: o.includes("备注"), detail: "sentinel" }) },
  { id: "E24", g: "G3新增", kind: "edit-raw", instr: '新增一个右侧侧边栏区块「快捷入口」' },
  { id: "E25", g: "G3新增", kind: "edit-raw", instr: '在 KPI 区上方加一行汇总「合计：¥1,234,567」', verify: (b, o) => ({ ok: o.includes("1,234,567"), detail: "sentinel" }) },

  // G4 删除/移动（10）
  { id: "E26", g: "G4删移", kind: "edit-raw", instr: '把左侧导航里的「税务」这一项整个删掉', verify: (b, o) => { const a = (o.match(/<div class="nav-item"/g) || []).length; const ba = (b.match(/<div class="nav-item"/g) || []).length; return { ok: a < ba, detail: `nav-item ${ba}→${a}` }; } },
  { id: "E27", g: "G4删移", kind: "edit-raw", instr: '删掉第一条待办' },
  { id: "E28", g: "G4删移", kind: "edit-raw", instr: '删掉表格最后一行' },
  { id: "E29", g: "G4删移", kind: "edit-raw", instr: '删掉表格「备注」列' },
  { id: "E30", g: "G4删移", kind: "edit-raw", instr: '删掉页脚版权' },
  { id: "E31", g: "G4删移", kind: "edit-raw", instr: '把「刷新」按钮移到「智能记账」按钮左边' },
  { id: "E32", g: "G4删移", kind: "edit-raw", instr: '把待办事项置顶排序' },
  { id: "E33", g: "G4删移", kind: "edit-raw", instr: '把第一个 KPI 卡移到最前面' },
  { id: "E34", g: "G4删移", kind: "edit-raw", instr: '删掉搜索框' },
  { id: "E35", g: "G4删移", kind: "edit-raw", instr: '删掉空状态提示' },

  // G5 批量（10）
  { id: "E36", g: "G5批量", kind: "edit-raw", instr: '把所有 KPI 卡片里的数字都翻倍' },
  { id: "E37", g: "G5批量", kind: "edit-raw", instr: '给所有按钮加圆角' },
  { id: "E38", g: "G5批量", kind: "edit-raw", instr: '所有金额前面加「￥」' },
  { id: "E39", g: "G5批量", kind: "edit-raw", instr: '表格每行加一个「操作」列', verify: (b, o) => ({ ok: o.includes("操作"), detail: "新列" }) },
  { id: "E40", g: "G5批量", kind: "edit-raw", instr: '给所有卡片加阴影' },
  { id: "E41", g: "G5批量", kind: "edit-raw", instr: '所有链接改成新窗口打开', verify: (b, o) => ({ ok: /target=["']_blank["']/i.test(o), detail: "target=_blank" }) },
  { id: "E42", g: "G5批量", kind: "edit-raw", instr: '所有图片加 alt 文字' },
  { id: "E43", g: "G5批量", kind: "edit-raw", instr: '所有表单项标为必填' },
  { id: "E44", g: "G5批量", kind: "edit-raw", instr: '所有标题加图标' },
  { id: "E45", g: "G5批量", kind: "edit-raw", instr: '同列数据对齐方式改成右对齐' },

  // G6 样式/布局（10）
  { id: "E46", g: "G6样式", kind: "edit-raw", instr: '把页面主色调改成绿色 #00B853', verify: (b, o) => ({ ok: /00B853/i.test(o), detail: "绿色" }) },
  { id: "E47", g: "G6样式", kind: "edit-raw", instr: '整体字号调大 2px' },
  { id: "E48", g: "G6样式", kind: "edit-raw", instr: '卡片之间间距加大' },
  { id: "E49", g: "G6样式", kind: "edit-raw", instr: '表格加斑马条纹' },
  { id: "E50", g: "G6样式", kind: "edit-raw", instr: '改成暗色模式' },
  { id: "E51", g: "G6样式", kind: "edit-raw", instr: '圆角统一加大' },
  { id: "E52", g: "G6样式", kind: "edit-raw", instr: '把第一个卡片背景改成浅蓝' },
  { id: "E53", g: "G6样式", kind: "edit-raw", instr: '表格表头居中' },
  { id: "E54", g: "G6样式", kind: "edit-raw", instr: '隐藏「待办事项」整个模块' },
  { id: "E55", g: "G6样式", kind: "edit-raw", instr: '显示当前隐藏的「高级筛选」模块' },

  // G7 标注点选（10）— build 注入 anchor
  { id: "E56", g: "G7标注", kind: "edit-raw-marker", instr: '改这个按钮的文字为「快速记账」', anchorTag: "button", verify: (b, o) => ({ ok: o.includes("快速记账"), detail: "按钮文案" }) },
  { id: "E57", g: "G7标注", kind: "edit-raw-marker", instr: '把这个卡片背景改成浅蓝', anchorTag: "div" },
  { id: "E58", g: "G7标注", kind: "edit-raw-marker", instr: '删掉这个导航项', anchorTag: "div" },
  { id: "E59", g: "G7标注", kind: "edit-raw-marker", instr: '在它后面加一张同样的卡片', anchorTag: "div" },
  { id: "E60", g: "G7标注", kind: "edit-raw-marker", instr: '改这个 tab 的名字为「税务管理」', anchorTag: "div" },
  { id: "E61", g: "G7标注", kind: "edit-raw-marker", instr: '改这个单元格内容为「已审核」', anchorTag: "td", verify: (b, o) => ({ ok: o.includes("已审核"), detail: "单元格" }) },
  { id: "E62", g: "G7标注", kind: "edit-raw-marker", instr: '把这个 KPI 数字改成 999', anchorTag: "div" },
  { id: "E63", g: "G7标注", kind: "edit-raw-marker", instr: '把这个图标换成搜索图标', anchorTag: "img" },
  { id: "E64", g: "G7标注", kind: "edit-raw-marker", instr: '把这块布局改成两列', anchorTag: "div" },
  { id: "E65", g: "G7标注", kind: "edit-raw-marker", instr: '给所有同类按钮加圆角', anchorTag: "button" },

  // G8 直接编辑（前端行为，API 不可测，标记 skipped）
  { id: "E66", g: "G8直编", kind: "skipped", instr: '直接改标题（前端 contentEditable，不调模型）' },
  { id: "E67", g: "G8直编", kind: "skipped", instr: '直接改段落' },
  { id: "E68", g: "G8直编", kind: "skipped", instr: '直接改按钮文字' },
  { id: "E69", g: "G8直编", kind: "skipped", instr: '直接改表格单元格' },
  { id: "E70", g: "G8直编", kind: "skipped", instr: '直接改链接文字' },

  // G9 提问（5）
  { id: "E71", g: "G9提问", kind: "ask", instr: '这个页面用了什么图表库？', verify: (b, o) => ({ ok: !o || o.length === 0, detail: `不动页 code len=${o?o.length:0}` }) },
  { id: "E72", g: "G9提问", kind: "ask", instr: '数据是从哪里来的？', verify: (b, o) => ({ ok: !o || o.length === 0, detail: "不动页" }) },
  { id: "E73", g: "G9提问", kind: "ask", instr: '我可以怎么修改这个原型？', verify: (b, o) => ({ ok: !o || o.length === 0, detail: "不动页" }) },
  { id: "E74", g: "G9提问", kind: "ask", instr: '支持导出 PDF 吗？', verify: (b, o) => ({ ok: !o || o.length === 0, detail: "不动页" }) },
  { id: "E75", g: "G9提问", kind: "ask", instr: '你好，今天天气怎么样？', verify: (b, o) => ({ ok: !o || o.length === 0, detail: "不动页" }) },

  // G10 歧义/边界（10）
  { id: "E76", g: "G10边界", kind: "edit-raw", instr: '把那个数字改一下' },
  { id: "E77", g: "G10边界", kind: "edit-raw", instr: '把这里改大一点' },
  { id: "E78", g: "G10边界", kind: "edit-raw", instr: '把页面主标题改成「测试」，同时把所有按钮改成圆角，再把表格加一列状态，最后把页脚年份改成 2026，整体配色改成蓝色，字号加大，卡片加阴影，导航项重排，搜索框右移，KPI 数字翻倍' },
  { id: "E79", g: "G10边界", kind: "ask", instr: '', verify: (b, o) => ({ ok: !o || o.length === 0, detail: "空指令不动页" }) },
  { id: "E80", g: "G10边界", kind: "edit-raw", instr: 'change the title to "Dashboard"', verify: (b, o) => ({ ok: o.includes("Dashboard"), detail: "英文标题" }) },
  { id: "E81", g: "G10边界", kind: "edit-raw", instr: '把 <?php echo $title; ?> 改成首页' },
  { id: "E82", g: "G10边界", kind: "edit-raw", instr: '把「不存在的模块XYZ」改成 ABC' },
  { id: "E83", g: "G10边界", kind: "edit-raw", instr: '把整个页面重做成电商首页' },
  { id: "E84", g: "G10边界", kind: "edit-raw", instr: '把技术栈换成 Vue' },
  { id: "E85", g: "G10边界", kind: "ask", instr: '导出当前页面', verify: (b, o) => ({ ok: !o || o.length === 0, detail: "不动页" }) },

  // G11 原样打开 HTML（ZIP 跳过）
  { id: "E86", g: "G11打开", kind: "open-html", instr: '打开', verify: (b, o) => intactRaw(b, o) },
  { id: "E87", g: "G11打开", kind: "open-html", instr: '把标题改成「测试打开」', verify: (b, o) => ({ ok: o.includes("测试打开"), detail: "标题改对" }) },
  { id: "E88", g: "G11打开", kind: "skipped", instr: '打开 ZIP（无样本，跳过）' },
  { id: "E89", g: "G11打开", kind: "skipped", instr: '打开 ZIP 并删除页脚（无样本，跳过）' },
  { id: "E90", g: "G11打开", kind: "open-html", instr: '这页面用什么框架？', verify: (b, o) => ({ ok: !o || o.length === 0 || o === b, detail: "提问不动页" }) },

  // G12 DPL 编辑（5）— base dpl
  { id: "E91", g: "G12DPL", kind: "edit-dpl", base: "dpl", instr: '把首页主标题改成「财务中台」', verify: (b, o) => ({ ok: o.includes("财务中台"), detail: "DPL标题" }) },
  { id: "E92", g: "G12DPL", kind: "edit-dpl", base: "dpl", instr: '把侧边栏导航项「首页」改成「工作台」' },
  { id: "E93", g: "G12DPL", kind: "edit-dpl", base: "dpl", instr: '新增一个「设置」页' },
  { id: "E94", g: "G12DPL", kind: "edit-dpl", base: "dpl", instr: '主色改成蓝色 #1677FF', verify: (b, o) => ({ ok: /1677FF/i.test(o), detail: "DPL主色" }) },
  { id: "E95", g: "G12DPL", kind: "ask", base: "dpl", instr: '这个原型有哪些页面？', verify: (b, o) => ({ ok: !o || o.length === 0, detail: "DPL提问不动页" }) },

  // G13 链式（5）— 用 RAW_BASE 起步，链式推进
  { id: "E96", g: "G13链式", kind: "edit-raw", chainStart: true, instr: '改主标题为「财税驾驶舱V2」', verify: (b, o) => ({ ok: o.includes("财税驾驶舱V2"), detail: "链1" }) },
  { id: "E97", g: "G13链式", kind: "edit-raw", chain: true, instr: '把金额「¥ 486,200」改成「¥888,000」', verify: (b, o) => ({ ok: o.includes("888,000") && o.includes("财税驾驶舱V2"), detail: "链2 保留链1" }) },
  { id: "E98", g: "G13链式", kind: "edit-raw", chain: true, instr: '加一条待办「链式测试项」', verify: (b, o) => ({ ok: o.includes("链式测试项") && o.includes("财税驾驶舱V2"), detail: "链3 保留前" }) },
  { id: "E99", g: "G13链式", kind: "edit-raw", chain: true, instr: '删掉导航项「税务」' },
  { id: "E100", g: "G13链式", kind: "edit-raw", chain: true, instr: '把所有按钮文字后面加「→」' },
];

// —— DPL 基底 ——
async function ensureDplBase() {
  if (existsSync(DPL_BASE_PATH)) return readFileSync(DPL_BASE_PATH, "utf8");
  console.error("[setup] 生成 DPL 基底...");
  const r = await callApi({ requirement: "用 DPL 组件做一个 PC 端财务后台首页，含侧边导航、KPI 卡片、数据表格", mode: "generate", useDpl: true, fastMode: true, allowClarify: false, modelPreference: "auto" });
  if (!r.code) throw new Error("DPL 基底生成失败");
  writeFileSync(DPL_BASE_PATH, r.code);
  console.error(`[setup] DPL 基底 ${r.code.length} 字节`);
  return r.code;
}

// —— 跑一条 ——
async function runOne(c, ctx) {
  if (c.kind === "skipped") return { id: c.id, g: c.g, kind: c.kind, status: "SKIPPED", instr: c.instr, dt: 0, path: "—" };
  const t0 = Date.now();
  let res, err;
  try {
    if (c.kind === "gen-raw" || c.kind === "gen-dpl") {
      res = await callApi({ requirement: c.instr, mode: "generate", useDpl: c.kind === "gen-dpl", fastMode: true, allowClarify: c.allowClarify === true, modelPreference: "auto" });
    } else if (c.kind === "edit-raw" || c.kind === "edit-raw-marker") {
      const base = c.chain ? ctx.chainCurrent : RAW_BASE;
      let code = base, instr = c.instr;
      if (c.kind === "edit-raw-marker") {
        const a = injectAnchor(base, c.anchorTag || "div");
        if (!a) { return { id: c.id, g: c.g, status: "ERROR", instr: c.instr, dt: Date.now()-t0, error: "anchor 注入失败" }; }
        code = a.code; instr = `针对页面中这个元素附近进行修改：${c.instr}${MARKER}<!-- yd-anchor:${a.anchorId} -->\n${a.outerHTML}`;
      }
      res = await callApi({ requirement: instr, mode: "edit", previous: { code, flow: { title: "财务总览仪表盘", pages: [] }, components: [], useDpl: false, rawHtml: false, html: true, device: "pc", modelPreference: "auto" }, useDpl: false, fastMode: true, allowClarify: false, modelPreference: "auto" });
    } else if (c.kind === "edit-dpl") {
      const base = ctx.dplBase;
      res = await callApi({ requirement: c.instr, mode: "edit", previous: { code: base, flow: { title: "财务后台", pages: [] }, components: [], useDpl: true, rawHtml: false, html: false, device: "pc", modelPreference: "auto" }, useDpl: true, fastMode: true, allowClarify: false, modelPreference: "auto" });
    } else if (c.kind === "ask") {
      const base = c.base === "dpl" ? ctx.dplBase : RAW_BASE;
      const isDpl = c.base === "dpl";
      res = await callApi({ requirement: c.instr, mode: "edit", previous: { code: base, flow: { title: "财务", pages: [] }, components: [], useDpl: isDpl, rawHtml: false, html: !isDpl, device: "pc", modelPreference: "auto" }, useDpl: isDpl, fastMode: true, allowClarify: false, modelPreference: "auto" });
    } else if (c.kind === "open-html") {
      res = await callApi({ requirement: c.instr, mode: "generate", useDpl: false, rawHtml: true, attachments: { documents: [{ kind: "html", name: "sample.html", content: RAW_BASE }] }, fastMode: true, allowClarify: false, modelPreference: "auto" });
    }
  } catch (e) { err = String(e); }
  const dt = Date.now() - t0;
  if (err) return { id: c.id, g: c.g, kind: c.kind, status: "ERROR", instr: c.instr, dt, error: err };
  const out = res.code || "";
  const path = detectPath(res.steps);
  const isAsk = c.kind === "ask" || (c.kind === "open-html" && /什么|怎么|是否|吗|哪/.test(c.instr));
  // 验证
  let v;
  const baseForCheck = c.base === "dpl" ? ctx.dplBase : (c.kind === "edit-dpl" ? ctx.dplBase : RAW_BASE);
  if (c.verify) {
    try { v = c.verify(baseForCheck, out); } catch (e) { v = { ok: false, detail: "verify 异常:" + e }; }
  } else {
    v = c.kind === "edit-dpl" || c.kind === "gen-dpl" ? intactDpl(baseForCheck, out) : (isAsk ? { ok: !out || out.length === 0, detail: "ask 不动页" } : intactRaw(baseForCheck, out));
  }
  // 链式推进
  if (c.chain && v.ok && out) ctx.chainCurrent = out;
  if (c.chainStart && v.ok && out) ctx.chainCurrent = out;
  const intact = c.kind === "edit-dpl" || c.kind === "gen-dpl" ? intactDpl(baseForCheck, out).ok : (isAsk ? (!out || out.length === 0) : intactRaw(baseForCheck, out).ok);
  let status;
  if (!intact && !isAsk) status = "BROKEN";
  else if (!v.ok) status = "FAIL";
  else status = "PASS";
  return { id: c.id, g: c.g, kind: c.kind, status, instr: c.instr, dt, path, outLen: out.length, verify: v.detail, steps: res.steps.slice(-6), assistant: res.assistant.slice(0,1).join("").slice(0,200) };
}

// —— 主流程 ——
async function main() {
  const fromArg = process.argv.includes("--from") ? process.argv[process.argv.indexOf("--from")+1] : null;
  const onlyArg = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only")+1] : null;
  const onlySet = onlyArg ? new Set(onlyArg.split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const resultPath = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out")+1] : RESULT;
  const runCases = onlySet ? CASES.filter((c) => onlySet.has(c.id)) : CASES;
  let results = [];
  if (existsSync(resultPath)) { try { results = JSON.parse(readFileSync(resultPath, "utf8")); } catch {} }
  const doneIds = new Set(results.map((r) => r.id));
  const ctx = { dplBase: null, chainCurrent: RAW_BASE };
  // 链式起点：若 E96 已完成，恢复 chainCurrent
  const e96 = results.find((r) => r.id === "E96");
  if (e96 && e96.outLen) { /* 无法恢复 out，链式需重跑 */ }

  console.error(`[main] 选中 ${runCases.length}/${CASES.length} 条，结果文件 ${resultPath}，已完成 ${doneIds.size}`);
  for (const c of runCases) {
    if (fromArg && c.id !== fromArg && !ctx._started) { continue; }
    ctx._started = true;
    if (doneIds.has(c.id) && !c.chain) { continue; }
    // 链式用例若任一未完成则整链重跑
    if (c.chain && doneIds.has("E96") && doneIds.has("E97") && doneIds.has("E98") && doneIds.has("E99") && doneIds.has("E100")) { continue; }
    if (c.kind === "edit-dpl" || c.base === "dpl") { if (!ctx.dplBase) ctx.dplBase = await ensureDplBase(); }
    if (c.chainStart) ctx.chainCurrent = RAW_BASE; // 链式从头
    if (c.chain && !ctx.chainCurrent) ctx.chainCurrent = RAW_BASE;
    const r = await runOne(c, ctx);
    // 覆盖旧结果
    const idx = results.findIndex((x) => x.id === r.id);
    if (idx >= 0) results[idx] = r; else results.push(r);
    writeFileSync(resultPath, JSON.stringify(results, null, 2));
    console.error(`[${r.id}] ${r.status} | ${r.path || ""} | ${r.dt}ms | ${r.verify || ""} | ${r.error || ""}`);
  }
  const sum = {};
  for (const r of results) sum[r.status] = (sum[r.status] || 0) + 1;
  console.error(`\n[done] 汇总:`, sum);
}
main().catch((e) => { console.error(e); process.exit(1); });
