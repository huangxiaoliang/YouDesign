#!/usr/bin/env node
// 上传 HTML/ZIP → 编辑 → 标注 → 对话框连续修改 · 端到端 50 场景自测
// 基底：fileA-src(25KB JS模板渲染) / fileA-rendered(31KB 渲染后DOM,用于标注) / fileB(2.8MB ZIP内联静态)
// 全部打真实 /api/generate，按场景断言 intact/applied/localized。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHmac } from "node:crypto";

// 全局兜底：单个场景的 abort rejection 绝不能杀掉整批
process.on("unhandledRejection", (r) => { console.error("[unhandledRejection]", r?.message ?? r); });
process.on("uncaughtException", (e) => { console.error("[uncaughtException]", e?.message ?? e); });

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = "http://localhost:3001/youdesign";
const OUT_DIR = join(__dirname, "..", "output", "test-report", "上传编辑标注对话自测");
mkdirSync(OUT_DIR, { recursive: true });

function envLocal(key) {
  const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(txt);
  return m ? m[1].trim() : "";
}
const AUTH_SECRET = envLocal("YOUDESIGN_AUTH_SECRET");
// yd_auth cookie 是 HMAC 签名的 `userId.exp.sig`，不能直接用原始 secret。
const TEST_USER_ID = process.env.YD_TEST_USER_ID || "u_a5b71674cc67";
function signCookie(secret, userId, ttlSec = 604800) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${userId}.${exp}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `yd_auth=${payload}.${sig}`;
}
const AUTH_COOKIE = signCookie(AUTH_SECRET, TEST_USER_ID);

const FILE_A_SRC = readFileSync(join(__dirname, "..", "output", "workload-stats_1.html"), "utf8");
const FILE_A_RENDERED = readFileSync(join(OUT_DIR, "fileA-rendered.html"), "utf8");
const FILE_B = readFileSync(join(OUT_DIR, "fileB-zip-inlined.html"), "utf8");
const FLOW_A = { title: "工作量统计 · 数据看板", pages: [{ name: "工作量统计" }] };
const FLOW_B = { title: "丁贤琴", pages: [{ name: "丁贤琴" }] };

const headers = () => ({ cookie: AUTH_COOKIE, "content-type": "application/json" });

async function generate(body, perCallTimeoutMs = 300000) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { ctrl.abort(); } catch {} }, perCallTimeoutMs);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${BASE}/api/generate`, { method: "POST", headers: headers(), body: JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: `fetch: ${e.name === "AbortError" ? "timeout" : e.message}`, dt: Date.now() - t0, steps: [], assistant: [], aborted: timedOut };
  }
  if (!res.ok) { clearTimeout(timer); const t = await res.text().catch(() => ""); return { ok: false, error: `HTTP ${res.status}: ${t.slice(0, 200)}`, dt: Date.now() - t0, steps: [], assistant: [] }; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", code = "", done = null;
  const steps = [], assistant = [];
  let lastDataAt = Date.now();
  let aborted = false;
  try {
    for (;;) {
      const { value, done: rdone } = await reader.read();
      if (rdone) break;
      lastDataAt = Date.now();
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "code") code = ev.code;
        else if (ev.type === "done") done = ev.result;
        else if (ev.type === "step") steps.push(`${ev.stage}:${ev.status}:${ev.detail ?? ""}`);
        else if (ev.type === "assistant") assistant.push(ev.message);
        else if (ev.type === "error") assistant.push(`⚠️error:${ev.message}`);
      }
      if (Date.now() - lastDataAt > perCallTimeoutMs) { aborted = true; break; }
    }
  } catch (e) {
    if (e.name !== "AbortError") { clearTimeout(timer); return { ok: false, error: `stream: ${e.message}`, dt: Date.now() - t0, steps, assistant }; }
    aborted = true;
  } finally {
    clearTimeout(timer);
    try { await reader.cancel().catch(() => {}); } catch {}
    try { await res.body.cancel().catch(() => {}); } catch {}
  }
  return { ok: true, code: done?.code ?? code, done, steps, assistant, dt: Date.now() - t0, aborted: aborted || timedOut };
}

// —— HTML 工具 ——
const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
function findOuterByOpenN(html, openRegex, n) {
  const re = new RegExp(openRegex.source, openRegex.flags.includes("g") ? openRegex.flags : openRegex.flags + "g");
  let i = 0, f;
  while ((f = re.exec(html))) {
    i++; if (i !== n) continue;
    const start = f.index, openTag = f[0];
    const tag = /^<([a-zA-Z][\w:-]*)/.exec(openTag)[1].toLowerCase();
    if (VOID.has(tag) || /\/\s*>$/.test(openTag)) return { start, end: start + openTag.length, outer: openTag, tag };
    const anyRe = new RegExp(`</?${tag}(?=\\s|>|/)[^>]*?>`, "gi");
    anyRe.lastIndex = start + openTag.length;
    let depth = 1, endIdx = -1, tm;
    while ((tm = anyRe.exec(html))) {
      if (tm[0].startsWith("</")) { depth--; if (depth === 0) { endIdx = tm.index + tm[0].length; break; } }
      else if (!/\/\s*>$/.test(tm[0])) depth++;
    }
    if (endIdx < 0) return null;
    return { start, end: endIdx, outer: html.slice(start, endIdx), tag };
  }
  return null;
}
function injectAnchor(outer, id) { return outer.replace(/^<([a-zA-Z][\w:-]*)(\s|>|\/)/, `<$1 data-yd-anchor="${id}"$2`); }
function injectAnchorIntoDoc(html, openRegex, n, id) {
  const f = findOuterByOpenN(html, openRegex, n);
  if (!f) return null;
  const newOuter = injectAnchor(f.outer, id);
  return { html: html.slice(0, f.start) + newOuter + html.slice(f.end), outer: newOuter };
}
function buildAnno(note, outer, id) {
  return `针对页面中这个元素附近进行修改：${note}\n\n目标元素（请在原 HTML 中精确定位，以它为锚点选择合适作用域修改，其余保持不变）：\n<!-- yd-anchor:${id} -->\n${outer}`;
}
function titleOf(html) { return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? ""; }
function lineDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n"), n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, same = 0, added = 0, removed = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { i++; j++; same++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { removed++; i++; } else { added++; j++; } }
  while (i < n) { removed++; i++; } while (j < m) { added++; j++; }
  return { same, added, removed, changed: added + removed };
}

function prevObj(code, flow, rawHtml = true) {
  return { code, flow, components: [], useDpl: false, rawHtml, html: true, device: "pc", styleProfileId: undefined, modelPreference: "auto" };
}

const scenarios = [];
const docA = (c) => [{ name: "workload-stats_1.html", kind: "html", content: c }];
const docB = (c) => [{ name: "1.zip", kind: "html", content: c }];
const editA = (req, prev = FILE_A_SRC) => ({ requirement: req, mode: "edit", previous: prevObj(prev, FLOW_A), fastMode: true, allowClarify: false });
const editB = (req) => ({ requirement: req, mode: "edit", previous: prevObj(FILE_B, FLOW_B), fastMode: true, allowClarify: false });

// ===== PHASE 1: OPEN =====
scenarios.push({ id: "A-O1", file: "A", phase: "open", tag: "空需求原样打开",
  run: () => ({ requirement: "", mode: "generate", rawHtml: true, attachments: { documents: docA(FILE_A_SRC) }, fastMode: true, allowClarify: false }),
  check: (r, b) => ({ intact: r.ok && !!r.code, applied: r.code === b ? "opened-unchanged" : (r.code ? "MODIFIED" : "no-code"), note: r.assistant[0] ?? "" }) });
scenarios.push({ id: "A-O2", file: "A", phase: "open", tag: "帮我看看(无修改意图)",
  run: () => ({ requirement: "帮我看看这个页面", mode: "generate", rawHtml: true, attachments: { documents: docA(FILE_A_SRC) }, fastMode: true, allowClarify: false }),
  check: (r, b) => ({ intact: r.ok && !!r.code, applied: r.code === b ? "opened-unchanged" : "MODIFIED", note: r.assistant[0] ?? "" }) });
scenarios.push({ id: "A-O3", file: "A", phase: "open", tag: "提问技术栈(无意图)",
  run: () => ({ requirement: "这个页面用的什么技术栈", mode: "generate", rawHtml: true, attachments: { documents: docA(FILE_A_SRC) }, fastMode: true, allowClarify: false }),
  check: (r, b) => ({ intact: r.ok && !!r.code, applied: r.code === b ? "opened-unchanged" : "MODIFIED", note: r.assistant[0] ?? "" }) });
scenarios.push({ id: "A-O4", file: "A", phase: "open", tag: "只说'打开'",
  run: () => ({ requirement: "打开", mode: "generate", rawHtml: true, attachments: { documents: docA(FILE_A_SRC) }, fastMode: true, allowClarify: false }),
  check: (r, b) => ({ intact: r.ok && !!r.code, applied: r.code === b ? "opened-unchanged" : "MODIFIED", note: r.assistant[0] ?? "" }) });
scenarios.push({ id: "A-O5", file: "A", phase: "open", tag: "打开带改标题(整页编辑,无looksRewritten护栏)",
  run: () => ({ requirement: "把标题改成工作量分析看板", mode: "generate", rawHtml: true, attachments: { documents: docA(FILE_A_SRC) }, fastMode: true, allowClarify: false }),
  check: (r) => ({ intact: r.ok && !!r.code && /<\/html>/i.test(r.code), applied: titleOf(r.code || "").includes("工作量分析看板") ? "title-changed" : "NOT", note: `title="${titleOf(r.code || "")}"` }) });
scenarios.push({ id: "A-O6", file: "A", phase: "open", tag: "打开带改主色",
  run: () => ({ requirement: "把页面主色蓝色改成绿色#00C853", mode: "generate", rawHtml: true, attachments: { documents: docA(FILE_A_SRC) }, fastMode: true, allowClarify: false }),
  check: (r) => ({ intact: r.ok && !!r.code, applied: /#00[Cc]853/i.test(r.code || "") ? "color-applied" : "NOT", note: "" }) });
scenarios.push({ id: "A-O7", file: "A", phase: "open", tag: "打开带'优化布局'(宽泛,重写风险)",
  run: () => ({ requirement: "优化一下这个页面的布局", mode: "generate", rawHtml: true, attachments: { documents: docA(FILE_A_SRC) }, fastMode: true, allowClarify: false }),
  check: (r, b) => { const d = r.code ? lineDiff(b, r.code) : null; return { intact: r.ok && !!r.code && /<\/html>/i.test(r.code), applied: d ? `changed=${d.changed}` : "no-code", note: d ? `ratio=${(d.changed / Math.max(1, b.split("\n").length)).toFixed(2)}` : "" }; } });
scenarios.push({ id: "A-O8", file: "A", phase: "open", tag: "能不能加搜索框吗(疑问句,应无意图)",
  run: () => ({ requirement: "这个页面能不能加个搜索框吗", mode: "generate", rawHtml: true, attachments: { documents: docA(FILE_A_SRC) }, fastMode: true, allowClarify: false }),
  check: (r, b) => ({ intact: r.ok && !!r.code, applied: r.code === b ? "opened-unchanged" : "MODIFIED", note: r.assistant[0] ?? "" }) });
scenarios.push({ id: "A-O9", file: "A", phase: "open", tag: "为什么页面这么多数字(疑问)",
  run: () => ({ requirement: "为什么页面里有这么多数字", mode: "generate", rawHtml: true, attachments: { documents: docA(FILE_A_SRC) }, fastMode: true, allowClarify: false }),
  check: (r, b) => ({ intact: r.ok && !!r.code, applied: r.code === b ? "opened-unchanged" : "MODIFIED", note: r.assistant[0] ?? "" }) });
scenarios.push({ id: "B-O9", file: "B", phase: "open", tag: "ZIP空需求原样打开(2.8MB)",
  run: () => ({ requirement: "", mode: "generate", rawHtml: true, attachments: { documents: docB(FILE_B) }, fastMode: true, allowClarify: false }),
  check: (r, b) => ({ intact: r.ok && !!r.code, applied: r.code === b ? "opened-unchanged" : "MODIFIED", note: `codeLen=${r.code?.length ?? 0}` }) });
scenarios.push({ id: "B-O10", file: "B", phase: "open", tag: "ZIP打开带改标题(2.8MB整页编辑,疑爆上下文)",
  run: () => ({ requirement: "把标题改成团队工作量看板", mode: "generate", rawHtml: true, attachments: { documents: docB(FILE_B) }, fastMode: true, allowClarify: false }),
  check: (r, b) => ({ intact: r.ok && !!r.code && /<\/html>/i.test(r.code || ""), applied: titleOf(r.code || "").includes("团队工作量") ? "title-changed" : (r.code === b ? "opened-unchanged(fallback)" : "NOT"), note: `title="${titleOf(r.code || "")}"` }) });

// ===== PHASE 2: EDIT =====
scenarios.push({ id: "A-E1", file: "A", phase: "edit", tag: "改标题(源码含<title>)", run: () => editA("把页面标题'工作量统计 · 数据看板'改成'工作量分析看板'"),
  check: (r) => ({ intact: r.ok && !!r.code && /<\/html>/i.test(r.code), applied: titleOf(r.code || "").includes("工作量分析") ? "applied" : "NOT", note: `title="${titleOf(r.code || "")}"` }) });
scenarios.push({ id: "A-E2", file: "A", phase: "edit", tag: "改数据值(在<script>里,auto-locate看不到)", run: () => editA("把张伟的接通198改成999"),
  check: (r, b) => ({ intact: r.ok && !!r.code && /<\/html>/i.test(r.code), applied: /connected:999/.test(r.code || "") ? "applied(in-script)" : (r.code === b ? "no-op" : "changed-not-target"), note: r.code ? `diff=${lineDiff(b, r.code).changed}` : "" }) });
scenarios.push({ id: "A-E3", file: "A", phase: "edit", tag: "改主色#006BFF→#00C853(CSS)", run: () => editA("把页面里所有蓝色#006BFF改成绿色#00C853"),
  check: (r) => ({ intact: r.ok && !!r.code && /<\/html>/i.test(r.code), applied: /#00[Cc]853/i.test(r.code || "") && !/#006[Bb][Ff][Ff]/.test(r.code || "") ? "applied" : "partial/NOT", note: `new=${/#00[Cc]853/i.test(r.code || "")} old=${/#006[Bb][Ff][Ff]/.test(r.code || "")}` }) });
scenarios.push({ id: "A-E4", file: "A", phase: "edit", tag: "新增筛选选项'上月'", run: () => editA("在时间范围筛选里新增一个'上月'选项"),
  check: (r) => ({ intact: r.ok && !!r.code && /<\/html>/i.test(r.code), applied: /上月/.test(r.code || "") ? "applied" : "NOT", note: "" }) });
scenarios.push({ id: "A-E5", file: "A", phase: "edit", tag: "删除'销售三组'筛选(已知弱:删除)", run: () => editA("删除销售三组这个筛选选项"),
  check: (r, b) => { const bf = (b.match(/销售三组/g) || []).length, af = ((r.code || "").match(/销售三组/g) || []).length; return { intact: r.ok && !!r.code, applied: af < bf ? "applied" : "NOT(no-op)", note: `count ${bf}→${af}` }; } });
scenarios.push({ id: "A-E6", file: "A", phase: "edit", tag: "移动'销售一组'到最前(已知弱:移动)", run: () => editA("把销售一组移到团队筛选最前面"),
  check: (r, b) => ({ intact: r.ok && !!r.code, applied: r.code === b ? "no-op" : "changed", note: "" }) });
scenarios.push({ id: "A-E7", file: "A", phase: "edit", tag: "批量'所有数字翻倍'(应歧义/拒绝)", run: () => editA("把页面里所有数字都翻倍"),
  check: (r, b) => ({ intact: r.ok && !!r.code && /<\/html>/i.test(r.code || ""), applied: r.code === b ? "no-op(safe)" : "modified(risky)", note: r.assistant.join("|") }) });
scenarios.push({ id: "A-E8", file: "A", phase: "edit", tag: "提问'点击卡片跳转哪'(应ask不动页)", run: () => editA("这个页面点击卡片会跳转到哪里"),
  check: (r, b) => ({ intact: r.ok, applied: r.code === b || !r.code ? "no-edit(ask-correct)" : "MODIFIED(should-not)", note: r.assistant.join("|") }) });
scenarios.push({ id: "A-E9", file: "A", phase: "edit", tag: "'换成深色模式'(宽泛重写风险)", run: () => editA("换成深色模式"),
  check: (r, b) => { const d = r.code ? lineDiff(b, r.code) : null; return { intact: r.ok && !!r.code && /<\/html>/i.test(r.code || ""), applied: d ? `changed=${d.changed}` : "no-code", note: d ? `ratio=${(d.changed / Math.max(1, b.split("\n").length)).toFixed(2)}` : "" }; } });
scenarios.push({ id: "A-E10", file: "A", phase: "edit", tag: "加页脚版权", run: () => editA("在页面底部加版权信息'©2026 团队'"),
  check: (r) => ({ intact: r.ok && !!r.code && /<\/html>/i.test(r.code), applied: /©2026|© 2026/.test(r.code || "") ? "applied" : "NOT", note: "" }) });
scenarios.push({ id: "A-E11", file: "A", phase: "edit", tag: "改字体为微软雅黑", run: () => editA("把页面正文字体改成微软雅黑"),
  check: (r) => ({ intact: r.ok && !!r.code, applied: /微软雅黑|Microsoft YaHei/i.test(r.code || "") ? "applied" : "NOT", note: "" }) });
scenarios.push({ id: "A-E12", file: "A", phase: "edit", tag: "批量改'销售'→'业务'", run: () => editA("把页面里所有'销售'文字改成'业务'"),
  check: (r, b) => { const bf = (b.match(/销售/g) || []).length, af = ((r.code || "").match(/销售/g) || []).length; return { intact: r.ok && !!r.code, applied: af < bf ? "applied" : "NOT", note: `销售 ${bf}→${af}` }; } });
scenarios.push({ id: "A-E13", file: "A", phase: "edit", tag: "'帮我看看能改进啥'(非修改,应ask)", run: () => editA("帮我看看这个页面有什么可以改进的地方"),
  check: (r, b) => ({ intact: r.ok, applied: r.code === b || !r.code ? "no-edit(ask-correct)" : "MODIFIED(should-not)", note: r.assistant.join("|") }) });
scenarios.push({ id: "A-E14", file: "A", phase: "edit", tag: "空requirement edit(边界,应拒绝)", run: () => ({ requirement: "", mode: "edit", previous: prevObj(FILE_A_SRC, FLOW_A), fastMode: true, allowClarify: false }),
  check: (r) => ({ intact: !r.ok || r.assistant.some((m) => /不是|未检测|没有改动/.test(m)), applied: r.ok ? "unexpected-ok" : "rejected(correct)", note: r.error ?? r.assistant.join("|") }) });
scenarios.push({ id: "B-E15", file: "B", phase: "edit", tag: "ZIP改标题(auto-locate,2.8MB请求体)", run: () => editB("把标题改成团队工作量看板"),
  check: (r) => ({ intact: r.ok && !!r.code && /<\/html>/i.test(r.code || ""), applied: titleOf(r.code || "").includes("团队工作量") ? "applied" : "NOT", note: `title="${titleOf(r.code || "")}" dt=${r.dt}ms` }) });
scenarios.push({ id: "B-E16", file: "B", phase: "edit", tag: "ZIP删除第一个卡片(2.8MB)", run: () => editB("删除页面里第一个卡片"),
  check: (r, b) => ({ intact: r.ok && !!r.code, applied: r.code && r.code !== b ? "changed" : "no-op", note: `dt=${r.dt}ms` }) });
scenarios.push({ id: "B-E17", file: "B", phase: "edit", tag: "ZIP改背景色(全局,疑回退整页爆上下文)", run: () => editB("把页面背景色改成浅灰色#f5f5f5"),
  check: (r) => ({ intact: r.ok && !!r.code && /<\/html>/i.test(r.code || ""), applied: /#f5f5f5/i.test(r.code || "") ? "applied" : "NOT", note: `dt=${r.dt}ms ${r.assistant.join("|")}` }) });
scenarios.push({ id: "B-E18", file: "B", phase: "edit", tag: "ZIP提问'多少图表'(应ask)", run: () => editB("这个页面一共有多少个图表"),
  check: (r, b) => ({ intact: r.ok, applied: r.code === b || !r.code ? "no-edit(ask-correct)" : "MODIFIED(should-not)", note: r.assistant.join("|") }) });

// ===== PHASE 3: ANNOTATE =====
// 在 fileA-rendered 上注入锚点；previous.code = 注入锚点后的渲染 DOM
function anno(file, flow, baseHtml, openRegex, n, note) {
  const id = `yd-${Math.random().toString(36).slice(2, 10)}`;
  const inj = injectAnchorIntoDoc(baseHtml, openRegex, n, id);
  if (!inj) return null;
  return { body: { requirement: buildAnno(note, inj.outer, id), mode: "edit", previous: prevObj(inj.html, flow), fastMode: true, allowClarify: false } };
}
// File A 标注（用渲染后 DOM，元素含真实文本）
scenarios.push({ id: "A-N1", file: "A", phase: "anno", tag: "标注.name'张伟'→'李明'",
  run: () => anno("A", FLOW_A, FILE_A_RENDERED, /<span class="name">(?=[^<]*张伟)/, 1, "把名字改成李明")?.body,
  check: (r, b) => { const d = r.code ? lineDiff(b, r.code) : null; return { intact: r.ok && !!r.code && /<\/html>/i.test(r.code), applied: /李明/.test(r.code || "") ? "applied" : "NOT", localized: d ? `changed=${d.changed}` : "", note: "" }; } });
scenarios.push({ id: "A-N2", file: "A", phase: "anno", tag: "标注.v'198'→'999'",
  run: () => anno("A", FLOW_A, FILE_A_RENDERED, /<div class="v">[^<]*<\/div>/, 1, "把这个数字改成999")?.body,
  check: (r) => ({ intact: r.ok && !!r.code && /<\/html>/i.test(r.code), applied: /999/.test(r.code || "") ? "applied" : "NOT", localized: r.code ? `diff vs rendered` : "", note: "" }) });
scenarios.push({ id: "A-N3", file: "A", phase: "anno", tag: "标注.chip'外呼总量'→'通话总量'",
  run: () => anno("A", FLOW_A, FILE_A_RENDERED, /<button class="[^"]*chip[^"]*">(?=[^<]*外呼总量)/, 1, "把'外呼总量'改成'通话总量'")?.body,
  check: (r) => ({ intact: r.ok && !!r.code, applied: /通话总量/.test(r.code || "") ? "applied" : "NOT", note: "" }) });
scenarios.push({ id: "A-N4", file: "A", phase: "anno", tag: "标注.card删除(已知弱)",
  run: () => anno("A", FLOW_A, FILE_A_RENDERED, /<div class="card[^"]*"/, 1, "删除这张卡片")?.body,
  check: (r, b) => { const before = (b.match(/class="card/g) || []).length, after = ((r.code || "").match(/class="card/g) || []).length; return { intact: r.ok && !!r.code, applied: after < before ? "applied" : "NOT(no-op)", note: `card ${before}→${after}` }; } });
scenarios.push({ id: "A-N5", file: "A", phase: "anno", tag: "标注.team'销售一组'→'华东组'",
  run: () => anno("A", FLOW_A, FILE_A_RENDERED, /<span class="team">(?=[^<]*销售一组)/, 1, "把'销售一组'改成'华东组'")?.body,
  check: (r) => ({ intact: r.ok && !!r.code, applied: /华东组/.test(r.code || "") ? "applied" : "NOT", note: "" }) });
scenarios.push({ id: "A-N6", file: "A", phase: "anno", tag: "标注.btn-primary'应用筛选'→'确定'",
  run: () => anno("A", FLOW_A, FILE_A_RENDERED, /<button class="btn btn-primary"[^>]*>/, 1, "把'应用筛选'改成'确定'")?.body,
  check: (r) => ({ intact: r.ok && !!r.code, applied: />确定</.test(r.code || "") ? "applied" : "NOT", note: "" }) });
scenarios.push({ id: "A-N7", file: "A", phase: "anno", tag: "标注.trend'↑8.2%'→'65%'",
  run: () => anno("A", FLOW_A, FILE_A_RENDERED, /<span class="trend (?:up|down)">/, 1, "把趋势百分比改成65%")?.body,
  check: (r) => ({ intact: r.ok && !!r.code, applied: /65%/.test(r.code || "") ? "applied" : "NOT", note: "" }) });
scenarios.push({ id: "A-N8", file: "A", phase: "anno", tag: "标注.btn-secondary'重置'→'清空'",
  run: () => anno("A", FLOW_A, FILE_A_RENDERED, /<button class="btn btn-secondary"[^>]*>/, 1, "把'重置'改成'清空'")?.body,
  check: (r) => ({ intact: r.ok && !!r.code, applied: />清空</.test(r.code || "") ? "applied" : "NOT", note: "" }) });
scenarios.push({ id: "A-N9", file: "A", phase: "anno", tag: "标注.v第二张卡片→'888'",
  run: () => anno("A", FLOW_A, FILE_A_RENDERED, /<div class="v">[^<]*<\/div>/, 7, "把这个数字改成888")?.body,
  check: (r) => ({ intact: r.ok && !!r.code, applied: /888/.test(r.code || "") ? "applied" : "NOT", note: "" }) });
scenarios.push({ id: "A-N10", file: "A", phase: "anno", tag: "标注.card加边框(新增样式)",
  run: () => anno("A", FLOW_A, FILE_A_RENDERED, /<div class="card[^"]*"/, 2, "给这张卡片加红色边框")?.body,
  check: (r) => ({ intact: r.ok && !!r.code, applied: /red|#[eE]0+|[Ff]{2}[Ff]{2}|border[^;]*red|2px solid/i.test(r.code || "") ? "applied" : "NOT", note: "" }) });
// File B 标注
scenarios.push({ id: "B-N11", file: "B", phase: "anno", tag: "ZIP标注.user-name'丁贤琴'→'测试用户'",
  run: () => anno("B", FLOW_B, FILE_B, /<h4 class="[^"]*user-name[^"]*">(?=[^<]*丁贤琴)/, 1, "把名字改成测试用户")?.body,
  check: (r) => ({ intact: r.ok && !!r.code && /<\/html>/i.test(r.code || ""), applied: /测试用户/.test(r.code || "") ? "applied" : "NOT", note: `dt=${r.dt}ms` }) });
scenarios.push({ id: "B-N12", file: "B", phase: "anno", tag: "ZIP标注.value'未绑定'→'已绑定'",
  run: () => anno("B", FLOW_B, FILE_B, /<span class="value">(?=[^<]*未绑定)/, 1, "把'未绑定'改成'已绑定'")?.body,
  check: (r) => ({ intact: r.ok && !!r.code, applied: /已绑定/.test(r.code || "") ? "applied" : "NOT", note: `dt=${r.dt}ms` }) });
scenarios.push({ id: "B-N13", file: "B", phase: "anno", tag: "ZIP标注.title'营收信息'→'收入概况'",
  run: () => anno("B", FLOW_B, FILE_B, /<span class="title">(?=[^<]*营收信息)/, 1, "把'营收信息'改成'收入概况'")?.body,
  check: (r) => ({ intact: r.ok && !!r.code, applied: /收入概况/.test(r.code || "") ? "applied" : "NOT", note: `dt=${r.dt}ms` }) });

// ===== PHASE 4: CHAT (多轮链式) =====
// 每轮 previous.code 接上一轮输出；中途有失败/提问也继续
async function chatRun(file, flow, baseCode, turns) {
  const results = [];
  let cur = baseCode;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const body = { requirement: t.req, mode: "edit", previous: prevObj(cur, flow), fastMode: true, allowClarify: false };
    const r = await generate(body, 300000);
    results.push({ req: t.req, ok: r.ok, code: r.code, steps: r.steps, assistant: r.assistant, dt: r.dt, error: r.error });
    if (r.code && r.code !== cur) cur = r.code; // 链式接上
    t.after && t.after(r, cur);
  }
  return { results, finalCode: cur };
}

scenarios.push({ id: "A-C1", file: "A", phase: "chat", tag: "4轮链式:标题→主色→加项→改按钮",
  run: async () => { const chain = await chatRun("A", FLOW_A, FILE_A_SRC, [
    { req: "把标题改成工作量分析看板" },
    { req: "把页面主色#006BFF改成#00C853" },
    { req: "在时间范围筛选里加一个'上月'选项" },
    { req: "把'应用筛选'按钮改成'确定'" },
  ]); return { __chat: true, chain }; },
  check: (r) => {
    if (!r.__chat) return { intact: false, applied: "no-run", note: "" };
    const c = r.chain;
    const final = c.finalCode || "";
    const t1 = c.results[0].code && titleOf(c.results[0].code).includes("工作量分析");
    const t2 = c.results[1].code && /#00[Cc]853/i.test(c.results[1].code);
    const t3 = c.results[2].code && /上月/.test(c.results[2].code);
    const t4 = c.results[3].code && />确定</.test(c.results[3].code);
    return { intact: !!final && /<\/html>/i.test(final), applied: `T1=${t1} T2=${t2} T3=${t3} T4=${t4}`, note: c.results.map((x) => `${x.dt}ms`).join("|") };
  } });
scenarios.push({ id: "A-C2", file: "A", phase: "chat", tag: "3轮含提问:改标题→提问(不动)→改色",
  run: async () => { const chain = await chatRun("A", FLOW_A, FILE_A_SRC, [
    { req: "把标题改成工作量分析看板" },
    { req: "这个页面点击卡片会跳转到哪" },
    { req: "把页面主色改成#00C853" },
  ]); return { __chat: true, chain }; },
  check: (r) => {
    if (!r.__chat) return { intact: false, applied: "no-run", note: "" };
    const c = r.chain;
    const t1 = c.results[0].code && titleOf(c.results[0].code).includes("工作量分析");
    const t2NoOp = !c.results[1].code || c.results[1].code === (c.results[0].code || FILE_A_SRC);
    const t3 = c.results[2].code && /#00[Cc]853/i.test(c.results[2].code);
    return { intact: !!c.finalCode, applied: `T1=${t1} T2-noop=${t2NoOp} T3=${t3}`, note: c.results.map((x) => x.assistant[0]?.slice(0, 30) ?? "").join("|") };
  } });
scenarios.push({ id: "A-C3", file: "A", phase: "chat", tag: "3轮含失败删除:改标题→删除(疑no-op)→改色",
  run: async () => { const chain = await chatRun("A", FLOW_A, FILE_A_SRC, [
    { req: "把标题改成工作量分析看板" },
    { req: "删除销售三组这个筛选选项" },
    { req: "把页面主色改成#00C853" },
  ]); return { __chat: true, chain }; },
  check: (r) => {
    if (!r.__chat) return { intact: false, applied: "no-run", note: "" };
    const c = r.chain;
    const t1 = c.results[0].code && titleOf(c.results[0].code).includes("工作量分析");
    const t3 = c.results[2].code && /#00[Cc]853/i.test(c.results[2].code);
    const intact = !!c.finalCode && /<\/html>/i.test(c.finalCode);
    return { intact, applied: `T1=${t1} T3=${t3}`, note: `T2-dt=${c.results[1].dt}ms` };
  } });
scenarios.push({ id: "A-C4", file: "A", phase: "chat", tag: "5轮长链压力:连续小改",
  run: async () => { const chain = await chatRun("A", FLOW_A, FILE_A_SRC, [
    { req: "把标题改成工作量分析看板" },
    { req: "把'应用筛选'改成'确定'" },
    { req: "把'重置'改成'清空'" },
    { req: "在筛选里加'上月'选项" },
    { req: "把'外呼总量'改成'通话总量'" },
  ]); return { __chat: true, chain }; },
  check: (r) => {
    if (!r.__chat) return { intact: false, applied: "no-run", note: "" };
    const c = r.chain, f = c.finalCode || "";
    return { intact: !!f && /<\/html>/i.test(f), applied: `title=${titleOf(f).includes("工作量分析")} 确定=${/>确定</.test(f)} 清空=${/>清空</.test(f)} 上月=${/上月/.test(f)} 通话总量=${/通话总量/.test(f)}`, note: c.results.map((x) => x.dt).join("|") };
  } });
scenarios.push({ id: "B-C5", file: "B", phase: "chat", tag: "ZIP 3轮链:改标题→改value→加页脚(每轮2.8MB)",
  run: async () => { const chain = await chatRun("B", FLOW_B, FILE_B, [
    { req: "把标题改成团队工作量看板" },
    { req: "把'未绑定'改成'已绑定'" },
    { req: "在页面底部加'©2026'版权" },
  ]); return { __chat: true, chain }; },
  check: (r) => {
    if (!r.__chat) return { intact: false, applied: "no-run", note: "" };
    const c = r.chain, f = c.finalCode || "";
    return { intact: !!f && /<\/html>/i.test(f), applied: `title=${titleOf(f).includes("团队工作量")} 已绑定=${/已绑定/.test(f)} ©2026=${/©2026|© 2026/.test(f)}`, note: c.results.map((x) => `${x.dt}ms`).join("|") };
  } });

// ===== RUNNER =====
// 补充场景到 50
scenarios.push({ id: "B-O11", file: "B", phase: "open", tag: "ZIP只说'查看'(无意图)",
  run: () => ({ requirement: "查看", mode: "generate", rawHtml: true, attachments: { documents: docB(FILE_B) }, fastMode: true, allowClarify: false }),
  check: (r, b) => ({ intact: r.ok && !!r.code, applied: r.code === b ? "opened-unchanged" : "MODIFIED", note: r.assistant[0] ?? "" }) });
scenarios.push({ id: "B-E19", file: "B", phase: "edit", tag: "ZIP批量'统计'→'分析'(2.8MB)",
  run: () => editB("把页面里所有'客户'文字改成'用户'"),
  check: (r, b) => { const bf = (b.match(/客户/g) || []).length, af = ((r.code || "").match(/客户/g) || []).length; return { intact: r.ok && !!r.code, applied: af < bf ? "applied" : "NOT", note: `客户 ${bf}→${af} dt=${r.dt}ms` }; } });
scenarios.push({ id: "A-N11", file: "A", phase: "anno", tag: "标注.iconbtn改图标(空意图'改一下')",
  run: () => anno("A", FLOW_A, FILE_A_RENDERED, /<button class="iconbtn"[^>]*>/, 1, "改一下这个按钮的图标")?.body,
  check: (r) => ({ intact: r.ok && !!r.code, applied: r.code && r.code !== FILE_A_RENDERED ? "changed" : "no-op", note: r.assistant.join("|") }) });

async function main() {
  const onlyIdx = process.argv.indexOf("--only");
  let picks;
  if (onlyIdx >= 0 && process.argv[onlyIdx + 1]) {
    const set = new Set(process.argv[onlyIdx + 1].split(",").map((s) => s.trim()).filter(Boolean));
    picks = scenarios.filter((s) => set.has(s.id));
  } else {
    const filter = process.argv[2]; // 可传场景id子串过滤
    picks = filter ? scenarios.filter((s) => s.id.includes(filter) || s.phase.includes(filter)) : scenarios;
  }
  // resume：读已有结果，跳过已完成的（filter 模式也保留，避免覆盖）
  const resultPath = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : join(OUT_DIR, "scenarios-result.json");
  let out = [];
  if (existsSync(resultPath)) {
    try { out = JSON.parse(readFileSync(resultPath, "utf8")); } catch {}
  }
  const doneIds = new Set(out.map((x) => x.id));
  const todo = picks.filter((s) => !doneIds.has(s.id));
  console.error(`[run] 共 ${scenarios.length} 个场景，筛选 ${picks.length}，已完成 ${out.length}，待跑 ${todo.length}`);
  for (const s of todo) {
    process.stderr.write(`[run] ${s.id} ${s.tag} ... `);
    let runRes;
    try {
      const r = await s.run();
      if (r && r.__chat) runRes = r;
      else runRes = await generate(r, 300000);
    } catch (e) { runRes = { ok: false, error: `run-throw: ${e.message}`, steps: [], assistant: [] }; }
    const base = s.file === "A" ? (s.phase === "anno" ? FILE_A_RENDERED : FILE_A_SRC) : FILE_B;
    let chk;
    try { chk = s.check(runRes, base); } catch (e) { chk = { intact: false, applied: "check-throw", note: e.message }; }
    process.stderr.write(`${chk.applied} ${runRes.dt ?? 0}ms\n`);
    out.push({
      id: s.id, file: s.file, phase: s.phase, tag: s.tag,
      ok: runRes.ok, dt: runRes.dt, aborted: runRes.aborted, error: runRes.error,
      steps: runRes.steps ?? [], assistant: runRes.assistant ?? [],
      codeLen: runRes.code?.length ?? (runRes.chain?.finalCode?.length ?? 0),
      check: chk,
      chain: runRes.chain ? runRes.chain.results.map((x) => ({ req: x.req, ok: x.ok, dt: x.dt, codeLen: x.code?.length ?? 0, assistant: x.assistant, error: x.error })) : undefined,
    });
    // 增量写，防中断丢结果
    writeFileSync(resultPath, JSON.stringify(out, null, 2));
  }
  // 汇总
  const summary = {
    total: out.length,
    intact: out.filter((x) => x.check.intact).length,
    byPhase: {},
    byFile: {},
    failed: out.filter((x) => !x.check.intact).map((x) => x.id),
    slow: out.filter((x) => x.dt > 60000).map((x) => ({ id: x.id, dt: x.dt })),
  };
  for (const ph of ["open", "edit", "anno", "chat"]) {
    const sub = out.filter((x) => x.phase === ph);
    summary.byPhase[ph] = { total: sub.length, intact: sub.filter((x) => x.check.intact).length };
  }
  for (const f of ["A", "B"]) {
    const sub = out.filter((x) => x.file === f);
    summary.byFile[f] = { total: sub.length, intact: sub.filter((x) => x.check.intact).length };
  }
  writeFileSync(join(OUT_DIR, "scenarios-summary.json"), JSON.stringify(summary, null, 2));
  console.error(`[run] 完成：${summary.intact}/${summary.total} intact`);
  console.error(JSON.stringify(summary, null, 2));
}
main().catch((e) => { console.error("[run] 致命错误:", e); process.exit(1); });
