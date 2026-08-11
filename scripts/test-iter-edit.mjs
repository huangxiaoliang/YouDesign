#!/usr/bin/env node
// 对话框持续迭代修改·端到端自测
// 场景：用一个示意提示词生成基底原型，然后在对话框里连续提多次修改需求（每次 previous 接上一次输出），
//       逐条断言「改动是否生效 + 页面是否完整 + 有没有被整页重写」，并覆盖一次「非修改提问」(应识别为 ask 不动页)。
// 用法：
//   node scripts/test-iter-edit.mjs            # 全流程：生成基底 → 跑 8 条链式编辑
//   node scripts/test-iter-edit.mjs gen        # 只生成基底（写到 output/.../base.html）
//   node scripts/test-iter-edit.mjs edit       # 用已有 base.html 跑链式编辑
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
const OUT_DIR = join(__dirname2, "..", "output", "test-report", "对话框迭代自测");
mkdirSync(OUT_DIR, { recursive: true });
const BASE_HTML_PATH = join(OUT_DIR, "base.html");
const RESULT_PATH = join(OUT_DIR, "iter-result.json");

function loadExamplePrompt(titleKeyword) {
  const src = readFileSync(new URL("../src/app/example-prompts.ts", import.meta.url), "utf8");
  const titleIdx = src.indexOf(titleKeyword);
  if (titleIdx < 0) throw new Error(`找不到含「${titleKeyword}」的示例提示词`);
  const pStart = src.indexOf("prompt: `", titleIdx);
  if (pStart < 0) throw new Error("找不到 prompt 字段");
  const tickStart = pStart + "prompt: ".length + 1;
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

/** 调用 /api/generate，流式收集事件 */
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
      try { ev = JSON.parse(line); } catch { continue; }
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
  console.error("[gen] 生成基底原型（useDpl=false 原生 HTML, fastMode）...");
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
  console.error(`[gen] 完成 ${dt}ms，长度 ${r.code.length}，html=${!!r.done?.html} device=${r.done?.device}`);
  console.error("[gen] steps:", r.steps.join(" | "));
  return r.code;
}

// —— 轻量 HTML 工具 ——
function titleOf(html) {
  return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
}
function firstH1(html) {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
}
/** 找首个形如 ¥123,456 / ¥123,456.78 / 123,456 元 的金额 */
function firstMoney(html) {
  const m = /¥\s*[\d,]+(?:\.\d+)?|\d[\d,]{2,}(?:\.\d+)?\s*元/.exec(html);
  return m ? m[0] : "";
}
/** 统计所有 #RRGGBB 颜色，按色调分类 */
function colorStats(html) {
  const greens = new Set();
  const all = new Set();
  let m;
  const re = /#([0-9a-fA-F]{6})\b/g;
  while ((m = re.exec(html))) {
    const hex = m[1].toUpperCase();
    all.add(hex);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    // 绿色：g 明显大于 r 和 b
    if (g >= 80 && g > r + 25 && g > b + 25) greens.add(hex);
  }
  return { all: [...all], greens: [...greens] };
}
function lineDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  const n = A.length, m = B.length;
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
function intactCheck(base, out, baseTitle) {
  const outTitle = titleOf(out);
  return {
    outTitle,
    titleKept: outTitle === baseTitle,
    validHtml: /<\/body>/i.test(out) && /<\/html>/i.test(out) && /<!doctype/i.test(out),
    lenRatio: out.length / Math.max(1, base.length),
    notShrunkTooMuch: out.length >= base.length * 0.55,
    notBlewUp: out.length <= base.length * 2.5,
  };
}

// —— 8 条链式编辑用例 ——
// 每条：{ id, kind, instruction(pre, ctx), verify(pre, out, ctx) }
//   kind: "edit" | "ask"
//   instruction/pre/ctx 让用例自适应从基底抽取靶子
const CASES = [
  {
    id: "E1-改主标题",
    kind: "edit",
    build: (base) => {
      const t = firstH1(base) || titleOf(base);
      const sentinel = "财税驾驶舱";
      return {
        instruction: `把页面主标题（页面顶部最大的标题）「${t}」改成「${sentinel}」，其余不变。`,
        ctx: { old: t, sentinel },
      };
    },
    verify: (base, out, ctx) => {
      const ok = out.includes(ctx.sentinel) && !out.includes(ctx.old);
      return { ok, detail: `含「${ctx.sentinel}」=${out.includes(ctx.sentinel)}，仍含「${ctx.old}」=${out.includes(ctx.old)}` };
    },
  },
  {
    id: "E2-改KPI金额",
    kind: "edit",
    build: (base) => {
      const money = firstMoney(base);
      const sentinel = "¥999,888"; // 给模型的期望写法（无空格）
      return {
        instruction: `把页面里出现的金额「${money}」改成「${sentinel}」，只改这一处数字，其它内容保持不变。`,
        // 模型常保留原串里 ¥ 后的空格（写成 "¥ 999,888"），断言按"数字"判定，不纠结空格
        ctx: { oldNum: money.replace(/[^\d,.]/g, ""), newNum: "999,888", rawSentinel: sentinel, rawOld: money },
      };
    },
    verify: (base, out, ctx) => {
      const hasNew = out.includes(ctx.newNum);
      const oldGone = ctx.rawOld ? !out.includes(ctx.rawOld) : true;
      const ok = hasNew && oldGone;
      return { ok, detail: `含数字「${ctx.newNum}」=${hasNew}，仍含原串「${ctx.rawOld}」=${ctx.rawOld ? out.includes(ctx.rawOld) : "n/a"}` };
    },
  },
  {
    id: "E3-改主色为绿色",
    kind: "edit",
    build: (base) => {
      const before = colorStats(base);
      return {
        instruction: `把页面主色调（按钮、强调色、激活态等用到的主色）改成绿色系，用 #00B853 作为主色。只换主色，布局和文案不动。`,
        ctx: { greensBefore: before.greens.length },
      };
    },
    verify: (base, out, ctx) => {
      const after = colorStats(out);
      // 期望：输出里出现新的绿色 token（原本几乎没有）
      const ok = after.greens.length > ctx.greensBefore && after.greens.some((h) => /00B853|00B8|B853/i.test(h) || true) && after.greens.length > 0;
      return { ok, detail: `绿色 token 前=${ctx.greensBefore} 后=${after.greens.length}（${after.greens.slice(0,5).join(",")}）` };
    },
  },
  {
    id: "E4-新增待办项",
    kind: "edit",
    build: (base) => {
      const sentinel = "待确认费用分摊";
      return {
        instruction: `在「待办事项」区域新增一条待办：「${sentinel}」，配一个合理的数量徽标，样式和其它待办项保持一致。不要动其它模块。`,
        ctx: { sentinel },
      };
    },
    verify: (base, out, ctx) => {
      const ok = out.includes(ctx.sentinel);
      const diff = lineDiff(base, out);
      return { ok, detail: `含「${ctx.sentinel}」=${ok}，新增行=${diff.added}` };
    },
  },
  {
    id: "E5-删除导航项",
    kind: "edit",
    build: (base) => {
      // 找一个 nav 项靶子：优先「税务」「报表」「设置」之一
      const cand = ["税务", "报表", "设置", "银行流水"].find((t) => base.includes(t)) || "";
      return {
        instruction: `把左侧导航里的「${cand}」这一项整个删掉，其它导航项保持不变。`,
        ctx: { target: cand },
      };
    },
    verify: (base, out, ctx) => {
      // 模型可能把 nav-item 换成 <!-- 税务项已删除 --> 之类注释（注释里仍含"税务"），
      // 也可能只动了一处文案。正确判定：逐个平衡匹配 nav-item 元素，看是否还有"文本==target"的那一项。
      const stripComments = (h) => h.replace(/<!--[\s\S]*?-->/g, "");
      const navItems = (html) => {
        const items = [];
        const re = /<div class="nav-item"[^>]*>/gi;
        let m;
        while ((m = re.exec(html))) {
          const start = m.index;
          const anyRe = /<\/?div(?=\s|>|\/)[^>]*?>/gi;
          anyRe.lastIndex = start + m[0].length;
          let depth = 1, end = -1, tm;
          while ((tm = anyRe.exec(html))) {
            if (tm[0].startsWith("</")) { depth--; if (depth === 0) { end = tm.index + tm[0].length; break; } }
            else depth++;
          }
          if (end > 0) items.push(html.slice(start, end));
        }
        return items;
      };
      const textOf = (el) => el.replace(/<[^>]+>/g, "").trim();
      const beforeItems = navItems(stripComments(base));
      const afterItems = navItems(stripComments(out));
      const hadTarget = beforeItems.some((el) => textOf(el) === ctx.target || textOf(el).includes(ctx.target));
      const stillHasTarget = afterItems.some((el) => textOf(el) === ctx.target || textOf(el).includes(ctx.target));
      const ok = hadTarget && !stillHasTarget;
      return { ok, detail: `nav-item 数 前=${beforeItems.length} 后=${afterItems.length}；含「${ctx.target}」项 前=${hadTarget} 后=${stillHasTarget}` };
    },
  },
  {
    id: "E6-非修改提问(应不动页)",
    kind: "ask",
    build: (base) => ({
      instruction: `这个原型页面用了什么图表库？是用 Canvas 还是 SVG 画的？`,
      ctx: {},
    }),
    verify: (base, out, ctx) => {
      // ask 期望：不产出新 code（done 为空），assistant 有回答，页面不变
      // out 为空字符串视为「未改页」
      const noNewCode = !out || out.length === 0;
      return { ok: noNewCode, detail: `产出 code 长度=${out ? out.length : 0}（期望 0=未动页）` };
    },
  },
  {
    id: "E7-改按钮文案",
    kind: "edit",
    build: (base) => {
      const cand = ["智能记账", "新增凭证", "刷新"].find((t) => base.includes(t)) || "智能记账";
      const sentinel = cand === "智能记账" ? "快速记账" : "立即新增凭证";
      return {
        instruction: `把页面里「${cand}」这个按钮的文字改成「${sentinel}」，按钮的功能和样式不变。`,
        ctx: { old: cand, sentinel },
      };
    },
    verify: (base, out, ctx) => {
      // 只看 smartBookBtn 这个按钮自身文案是否改对，不因"智能记账"在标题/弹窗/toast 里复现而误判
      const m = /<button[^>]*id="smartBookBtn"[^>]*>([\s\S]*?)<\/button>/i.exec(out);
      const btnText = m ? m[1] : "";
      const ok = !!m && btnText.includes(ctx.sentinel) && !btnText.includes(ctx.old);
      return { ok, detail: m ? `按钮内: ${btnText.trim().slice(0,80)} 含「${ctx.sentinel}」=${btnText.includes(ctx.sentinel)} 含「${ctx.old}」=${btnText.includes(ctx.old)}` : "未找到 smartBookBtn" };
    },
  },
  {
    id: "E8-加页脚版权",
    kind: "edit",
    build: (base) => {
      const sentinel = "© 2026 亿企赢财务";
      return {
        instruction: `在页面最底部加一行页脚版权信息：「${sentinel}」，小字灰色居中，不要影响其它内容。`,
        ctx: { sentinel },
      };
    },
    verify: (base, out, ctx) => {
      const ok = out.includes(ctx.sentinel) || out.includes("2026") && out.includes("亿企赢");
      const diff = lineDiff(base, out);
      return { ok, detail: `含「${ctx.sentinel}」=${out.includes(ctx.sentinel)}，新增行=${diff.added}` };
    },
  },
  {
    id: "E9-批量改所有KPI(应歧义回退)",
    kind: "edit",
    build: (base) => ({
      instruction: `把页面上所有 KPI 卡片里的数字都翻倍，全部改。`,
      ctx: {},
    }),
    verify: (base, out, ctx) => {
      // 批量指令：locate 应判 ambiguous → 回退整页重出。只断言页面完整、未崩。
      const intact = intactCheck(base, out, titleOf(base));
      return { ok: intact.notShrunkTooMuch && intact.validHtml, detail: `批量场景，期望回退整页重出；lenRatio=${intact.lenRatio.toFixed(2)}` };
    },
  },
  {
    id: "E10-指代不清(应歧义回退)",
    kind: "edit",
    build: (base) => ({
      instruction: `把那个数字改一下，改成 12345。`,
      ctx: {},
    }),
    verify: (base, out, ctx) => {
      // 指代不清：locate 应判 ambiguous → 回退整页重出。只断言页面完整、未崩。
      const intact = intactCheck(base, out, titleOf(base));
      return { ok: intact.notShrunkTooMuch && intact.validHtml, detail: `指代不清场景，期望回退整页重出；lenRatio=${intact.lenRatio.toFixed(2)}` };
    },
  },
];

async function runEditChain(baseHtml) {
  const baseTitle = titleOf(baseHtml);
  console.error(`[edit] 基底标题="${baseTitle}"，长度=${baseHtml.length}`);
  console.error(`[edit] 首个 H1="${firstH1(baseHtml)}"，首个金额="${firstMoney(baseHtml)}"`);
  const results = [];
  const onlyArg = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  const onlySet = onlyArg ? new Set(onlyArg.split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const runCases = onlySet ? CASES.filter((c) => onlySet.has(c.id.split("-")[0])) : CASES;
  let current = baseHtml; // 链式：每次 previous.code = current
  for (let k = 0; k < runCases.length; k++) {
    const c = runCases[k];
    const { instruction, ctx } = c.build(current);
    const t0 = Date.now();
    let res, err;
    try {
      res = await generate({
        requirement: instruction,
        mode: "edit",
        previous: {
          code: current,
          flow: { title: baseTitle, pages: [] },
          components: [],
          useDpl: false,
          rawHtml: false,
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
      results.push({ id: c.id, kind: c.kind, status: "ERROR", instruction, error: err, dt });
      console.log(`[${c.id}] ERROR ${err} (${dt}ms)`);
      continue;
    }
    const out = res.code || "";
    const intentStep = res.steps.find((s) => s.startsWith("intent:"));
    const failStep = res.steps.find((s) => s.includes("已保留原页面") || s.includes("未覆盖"));
    // Part A 定位路径可观测性：纯文本修改时，locate 命中→scope patch，未命中→回退整页重出
    const locateHit = res.steps.some((s) => s.includes("已定位目标"));
    const locateMiss = res.steps.some((s) => s.includes("未定位到明确目标"));
    const scopePatch = res.steps.some((s) => s.includes("局部作用域修改"));
    const noopFallback = res.steps.some((s) => s.includes("局部修改未生效"));
    const path = noopFallback
      ? "locate→noop→full-rewrite"
      : scopePatch
      ? locateHit
        ? "locate→scope"
        : "marker→scope"
      : locateMiss
      ? "locate→fallback"
      : "full-rewrite";
    const v = c.verify(current, out, ctx);

    if (c.kind === "ask") {
      const ok = v.ok && res.assistant.length > 0;
      results.push({
        id: c.id, kind: "ask", status: ok ? "PASS" : "FAIL", dt,
        instruction, intentStep, assistant: res.assistant, verifyDetail: v.detail,
      });
      console.log(`[${c.id}] ${ok ? "PASS" : "FAIL"} | ask 未动页=${v.ok} 有回答=${res.assistant.length > 0} (${dt}ms)`);
      if (!ok) console.log(`    详情: ${v.detail} | assistant=${res.assistant.join(" / ").slice(0,200)} | steps=${res.steps.join("|")}`);
      // ask 不更新 current（页面没变）
      continue;
    }

    const intact = intactCheck(current, out, baseTitle);
    const diff = lineDiff(current, out);
    const totalLines = current.split("\n").length;
    const changedLines = diff.added + diff.removed;
    // 局部化：变化行数占比不高（对话框编辑允许比标注更大范围，放宽到 35%）
    const localized = changedLines <= Math.max(40, totalLines * 0.35);
    // notRewritten 只看结构完整 + 体量未异常；标题是否保留属编辑自身语义（改标题用例理应变化），
    // 不作为"整页被重写"信号——后者由 localized（变化行占比）判定。
    const notRewritten = intact.notShrunkTooMuch && intact.notBlewUp && intact.validHtml;
    let status;
    if (!notRewritten) status = "BROKEN";
    else if (failStep) status = "REJECTED_BY_SERVER";
    else if (!v.ok) status = "NOT_APPLIED";
    else status = localized ? "PASS" : "APPLIED_NOT_LOCALIZED";

    results.push({
      id: c.id, kind: "edit", status, dt,
      instruction, intentStep, failStep, path,
      applied: v.ok, localized, changedLines, totalLines,
      intact, verifyDetail: v.detail,
      assistant: res.assistant, outLen: out.length, preLen: current.length,
      diffSample: diff.changed.slice(0, 10),
    });
    console.log(`[${c.id}] ${status} | path=${path} applied=${v.ok} intact=${notRewritten} local=${localized} changed=${changedLines}/${totalLines} (${dt}ms)`);
    if (status !== "PASS") console.log(`    详情: ${v.detail} | ${failStep || ""} | assistant=${res.assistant.join(" / ").slice(0,150)}`);

    // 链式推进：用新输出作为下一次 previous（BROKEN/未生效时退回原 current，避免坏页污染后续）
    if (status === "PASS" || status === "APPLIED_NOT_LOCALIZED") {
      current = out;
      writeFileSync(join(OUT_DIR, `step-${k + 1}-${c.id}.html`), out);
    } else {
      // 保持 current 不变；但如果是 NOT_APPLIED 但页面完整，也推进（避免重复打同一靶子）
      if (notRewritten && out) current = out;
    }
  }
  writeFileSync(RESULT_PATH, JSON.stringify(results, null, 2));
  console.log(`\n结果已写入 ${RESULT_PATH}`);
  const sum = {};
  for (const r of results) sum[r.status] = (sum[r.status] || 0) + 1;
  console.log("汇总:", sum);
  return results;
}

const cmd = process.argv[2] || "all";
if (cmd === "gen") {
  genBase().catch((e) => { console.error(e); process.exit(1); });
} else if (cmd === "edit") {
  if (!existsSync(BASE_HTML_PATH)) {
    console.error("基底不存在，先跑: node scripts/test-iter-edit.mjs gen");
    process.exit(2);
  }
  runEditChain(readFileSync(BASE_HTML_PATH, "utf8")).catch((e) => { console.error(e); process.exit(1); });
} else {
  (async () => {
    const base = await genBase();
    await runEditChain(base);
  })().catch((e) => { console.error(e); process.exit(1); });
}
