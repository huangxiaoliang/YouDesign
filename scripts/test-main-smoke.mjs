#!/usr/bin/env node
/**
 * 主功能冒烟测试（mock 模式 + HTTP API 端到端，20 条用例）。
 *
 * 前置：本地已以
 *   YOUDESIGN_FORCE_MOCK=true YOUDESIGN_AUTH_MODE=shared YOUDESIGN_ACCESS_PASSWORD=testpass npm run start
 * 起好服务（默认 http://localhost:3000/youdesign）。
 *
 * 用法： node scripts/test-main-smoke.mjs [baseOrigin]
 * 报告： output/test-main-smoke-report.txt
 */
import { writeFileSync, mkdirSync, existsSync, statSync, readFileSync } from "node:fs";
import path from "node:path";

const BASE = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "") + "/youdesign";
const PASS = "testpass";
const OUT_DIR = path.resolve(process.cwd(), "output");
const REPORT = path.join(OUT_DIR, "test-main-smoke-report.txt");

const results = [];
let pass = 0, fail = 0;

function assert(name, cond, detail = "") {
  const ok = !!cond;
  if (ok) pass++; else fail++;
  results.push({ name, ok, detail: detail || (ok ? "通过" : "失败") });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}

// ---------- HTTP helpers ----------
async function login(password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const cookies = res.headers.getSetCookie?.() ?? [];
  const yd = cookies.find((c) => c.startsWith("yd_auth="));
  const val = yd ? yd.split(";")[0] : "";
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, ok: json?.ok === true, cookie: val };
}

async function rawGet(cookie, apiPath) {
  const res = await fetch(`${BASE}${apiPath}`, {
    headers: cookie ? { cookie } : {},
  });
  let body = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) { try { body = await res.json(); } catch { body = await res.text(); } }
  else body = await res.text();
  return { status: res.status, body };
}

async function generate(cookie, body) {
  const res = await fetch(`${BASE}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const ct = res.headers.get("content-type") || "";
  if (!res.ok || !ct.includes("ndjson")) {
    let errBody = null;
    try { errBody = await res.json(); } catch { errBody = await res.text().catch(() => ""); }
    return { status: res.status, events: [], errBody };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try { events.push(JSON.parse(t)); } catch { /* skip */ }
    }
  }
  if (buf.trim()) { try { events.push(JSON.parse(buf.trim())); } catch { /* skip */ } }
  return { status: res.status, events, errBody: null };
}

// ---------- helpers ----------
const has = (evs, type) => evs.some((e) => e.type === type);
const findType = (evs, type) => evs.find((e) => e.type === type);
const stepDetail = (evs, stage, status) =>
  evs.find((e) => e.type === "step" && e.stage === stage && (!status || e.status === status))?.detail || "";
const anyStepMatches = (evs, re) =>
  evs.some((e) => e.type === "step" && re.test(e.detail || ""));
const terminalOf = (evs) => {
  const done = findType(evs, "done");
  if (done) return { kind: "done", result: done.result, summary: done.summary };
  const cl = findType(evs, "clarify");
  if (cl) return { kind: "clarify", questions: cl.questions };
  const as = evs.filter((e) => e.type === "assistant");
  if (as.length) return { kind: "assistant", messages: as.map((a) => a.message) };
  const er = findType(evs, "error");
  if (er) return { kind: "error", message: er.message };
  return { kind: "none" };
};

// ---------- sample fixtures ----------
const SAMPLE_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>首页</title><style>body{font-family:sans-serif;margin:0}.hd{background:#1677ff;color:#fff;padding:16px}.btn{background:#1677ff;color:#fff;border:0;padding:8px 16px}</style></head><body><header class="hd"><h1>首页</h1></header><main><button class="btn">新建</button><p>欢迎使用</p></main></body></html>`;

const NAV_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>跳转页</title></head><body><h1>跳转测试</h1><script>document.querySelector('button').addEventListener('click',()=>{window.location.href='https://example.com/away';});</script><button>跳走</button></body></html>`;

const HTML_A = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>主页</title></head><body><h1>主页</h1><button id="open-detail">查看详情</button><div id="detail-panel"></div></body></html>`;
const HTML_B = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>详情</title></head><body><h2>详情内容</h2><p>这是次级页面</p></body></html>`;
const HTML_C = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>无匹配</title></head><body><h1>无匹配页</h1><div>nothing here</div></body></html>`;

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pWrAAAAAElFTkSuQmCC";

function usageJsonlPath() {
  const dataDir = process.env.YOUDESIGN_DATA_DIR || "data";
  return path.resolve(process.cwd(), dataDir, "usage.jsonl");
}
function countLines(p) {
  if (!existsSync(p)) return 0;
  const txt = readFileSync(p, "utf8");
  return txt.split("\n").filter((l) => l.trim()).length;
}

// ---------- run ----------
async function main() {
  console.log(`# 主功能冒烟测试\n  BASE=${BASE}\n`);

  // ===== A. 登录与门禁 =====
  // 1. 未登录直打 generate → 401
  try {
    const { status, errBody } = await generate("", { requirement: "测试" });
    assert("1 未登录 generate 返回 401", status === 401 && errBody?.error === "未登录", `status=${status} err=${errBody?.error}`);
  } catch (e) { assert("1 未登录 generate 返回 401", false, String(e)); }

  // 2. 登录双向：错误口令 401；正确口令 200 + cookie
  let cookie = "";
  try {
    const wrong = await login("wrong-pass");
    const right = await login(PASS);
    cookie = right.cookie;
    assert("2 登录双向（错口令401 / 对口令200+Set-Cookie）",
      wrong.status === 401 && right.status === 200 && right.ok && !!cookie,
      `wrong=${wrong.status} right=${right.status} cookie=${cookie ? "有" : "无"}`);
  } catch (e) { assert("2 登录双向", false, String(e)); }

  // 3. /api/me 身份
  try {
    const { status, body } = await rawGet(cookie, "/api/me");
    assert("3 /api/me 返回 default 身份",
      status === 200 && body?.userId === "default",
      `status=${status} userId=${body?.userId} name=${body?.name}`);
  } catch (e) { assert("3 /api/me 身份", false, String(e)); }

  // ===== B. 请求体校验 =====
  // 4. 缺 requirement 且无附件 → 400
  try {
    const { status, errBody } = await generate(cookie, {});
    assert("4 缺 requirement 无附件 → 400", status === 400 && /缺少 requirement/.test(errBody?.error || ""), `status=${status}`);
  } catch (e) { assert("4 缺 requirement", false, String(e)); }

  // 5. mock 下指定模型 → 400
  try {
    const { status, errBody } = await generate(cookie, { requirement: "测试", modelPreference: "deepseek" });
    assert("5 mock 下手动指定模型 → 400", status === 400 && /mock 模式/.test(errBody?.error || ""), `status=${status} err=${errBody?.error}`);
  } catch (e) { assert("5 mock 指定模型", false, String(e)); }

  // ===== C. 生成主链路 =====
  // 6. 纯文字 PC 生成，事件序列 + 产物
  let GEN_RESULT = null;
  try {
    const { status, events, errBody } = await generate(cookie, { requirement: "后台管理系统首页：左侧导航菜单、顶部搜索栏、数据表格" });
    const done = findType(events, "done");
    const code = done?.result?.code || "";
    const ok = status === 200 && !!done && done.result.html === true && /<html|<!doctype/i.test(code);
    GEN_RESULT = ok ? { code, flow: done.result.flow, html: done.result.html, rawHtml: done.result.rawHtml } : null;
    assert("6 纯文字生成：事件序列到 done + html 产物",
      ok && has(events, "step") && has(events, "flow") && (has(events, "code") || has(events, "code-delta")) && has(events, "preview"),
      `status=${status} done=${!!done} html=${done?.result?.html} codeLen=${code.length}`);
  } catch (e) { assert("6 纯文字生成", false, String(e)); }

  // 7. 产物自包含可离线（无外链资源、无真实导航）
  try {
    const code = GEN_RESULT?.code || "";
    const noExtScript = !/<script[^>]*src=["']https?:/i.test(code);
    const noExtLink = !/<link[^>]*href=["']https?:/i.test(code);
    const noExtImg = !/<img[^>]*src=["']https?:/i.test(code);
    const noNav = !/window\.open|window\.location|location\.href\s*=|location\.assign|location\.replace/i.test(code);
    assert("7 产物自包含可离线 + 无真实导航",
      code.length > 0 && noExtScript && noExtLink && noExtImg && noNav,
      `extScript=${!noExtScript} extLink=${!noExtLink} extImg=${!noExtImg} nav=${!noNav} len=${code.length}`);
  } catch (e) { assert("7 自包含可离线", false, String(e)); }

  // 8. 快速图片 + 手机关键词 → device=mobile（规则判端）
  try {
    const { status, events } = await generate(cookie, {
      requirement: "手机端 H5 商品详情页：商品主图、价格、立即购买按钮",
      fastMode: true,
      attachments: { images: [{ mediaType: "image/png", data: PNG_B64 }] },
    });
    const done = findType(events, "done");
    assert("8 快速图片+手机关键词 → device=mobile",
      status === 200 && !!done && done.result.device === "mobile",
      `status=${status} device=${done?.result?.device}`);
  } catch (e) { assert("8 device=mobile", false, String(e)); }

  // 9. 快速图片 + 后台关键词 → device=pc
  try {
    const { status, events } = await generate(cookie, {
      requirement: "后台管理系统的数据看板：KPI 卡片 + 趋势图 + 明细表格",
      fastMode: true,
      attachments: { images: [{ mediaType: "image/png", data: PNG_B64 }] },
    });
    const done = findType(events, "done");
    assert("9 快速图片+后台关键词 → device=pc",
      status === 200 && !!done && done.result.device === "pc",
      `status=${status} device=${done?.result?.device}`);
  } catch (e) { assert("9 device=pc", false, String(e)); }

  // ===== D. 上传 HTML 意图 =====
  // 10. HTML 上传 + 空文字 → open（原样打开）
  let OPEN_RESULT = null;
  try {
    const { status, events } = await generate(cookie, {
      requirement: "",
      attachments: { documents: [{ name: "page.html", kind: "html", content: SAMPLE_HTML }] },
    });
    const done = findType(events, "done");
    const intentDetail = stepDetail(events, "intent", "done");
    OPEN_RESULT = done?.result || null;
    assert("10 HTML 上传空文字 → open 原样打开",
      status === 200 && /原样打开/.test(intentDetail) && !!done && done.result.rawHtml === true && !!done.result.rawHtmlState && /首页/.test(done.result.code || ""),
      `intentDetail=${intentDetail} rawHtml=${done?.result?.rawHtml} rawHtmlState=${!!done?.result?.rawHtmlState}`);
  } catch (e) { assert("10 HTML open", false, String(e)); }

  // 11. HTML 上传 + 非空文字 → edit（兜底），mock 编辑保留原页
  try {
    const { status, events } = await generate(cookie, {
      requirement: "把标题改成测试",
      attachments: { documents: [{ name: "page.html", kind: "html", content: SAMPLE_HTML }] },
    });
    const term = terminalOf(events);
    const intentDetail = stepDetail(events, "intent", "done");
    // mock 编辑会产出合法 mockCode（过结构校验即采用），故只校验：edit 路径触发 + 走到 done 无 error
    assert("11 HTML 上传非空 → edit 路径 + 走到 done",
      status === 200 && /修改|在上传页面上/.test(intentDetail) && term.kind === "done",
      `intentDetail=${intentDetail} terminal=${term.kind}`);
  } catch (e) { assert("11 HTML edit", false, String(e)); }

  // 12. 上传含 window.location 跳转的 HTML → open + assistant 警告
  try {
    const { status, events } = await generate(cookie, {
      requirement: "",
      attachments: { documents: [{ name: "nav.html", kind: "html", content: NAV_HTML }] },
    });
    const asst = events.filter((e) => e.type === "assistant").map((a) => a.message).join(" | ");
    const done = findType(events, "done");
    assert("12 含导航 HTML 原样打开 → assistant 警告 + done",
      status === 200 && /跳转|导航|拦截/.test(asst) && !!done,
      `assistant=${asst.slice(0, 120)} done=${!!done}`);
  } catch (e) { assert("12 导航门禁", false, String(e)); }

  // ===== E. 图片上传意图 =====
  // 13. 图片 + 空文字 → generate
  try {
    const { status, events } = await generate(cookie, {
      requirement: "",
      attachments: { images: [{ mediaType: "image/png", data: PNG_B64 }] },
    });
    const done = findType(events, "done");
    assert("13 图片空文字 → generate 走到 done",
      status === 200 && !!done && done.result.html === true,
      `status=${status} done=${!!done} html=${done?.result?.html}`);
  } catch (e) { assert("13 图片 generate", false, String(e)); }

  // 14. 图片 + 非空 → generate-with-changes（兜底）
  try {
    const { status, events } = await generate(cookie, {
      requirement: "把列表改成卡片样式",
      attachments: { images: [{ mediaType: "image/png", data: PNG_B64 }] },
    });
    const term = terminalOf(events);
    assert("14 图片非空 → generate-with-changes 走到 done",
      status === 200 && term.kind === "done",
      `status=${status} terminal=${term.kind}`);
  } catch (e) { assert("14 图片 generate-with-changes", false, String(e)); }

  // ===== F. 编辑链路 =====
  // 15. mode=edit + 生成产物 previous（原生 HTML）→ 编辑链路不崩
  try {
    const previous = GEN_RESULT ? {
      code: GEN_RESULT.code, flow: GEN_RESULT.flow, rawHtml: false, html: true, rawHtmlEditSource: "chat",
    } : null;
    const { status, events } = await generate(cookie, {
      mode: "edit", previous, requirement: "把主标题改成测试",
    });
    const term = terminalOf(events);
    assert("15 编辑原生 HTML 链路不崩（done/assistant、无 error）",
      status === 200 && term.kind !== "error" && term.kind !== "none",
      `status=${status} terminal=${term.kind}`);
  } catch (e) { assert("15 编辑原生 HTML", false, String(e)); }

  // 16. mode=edit + rawHtml previous（上传产物）→ rawHtml 编辑路径不崩
  try {
    const previous = OPEN_RESULT ? {
      code: OPEN_RESULT.code, flow: OPEN_RESULT.flow, rawHtml: true, html: true,
      rawHtmlState: OPEN_RESULT.rawHtmlState, rawHtmlEditSource: "chat",
    } : null;
    const { status, events } = await generate(cookie, {
      mode: "edit", previous, requirement: "把按钮文字改成提交",
    });
    const term = terminalOf(events);
    assert("16 编辑 rawHtml 链路不崩（done/assistant、无 error）",
      status === 200 && term.kind !== "error" && term.kind !== "none",
      `status=${status} terminal=${term.kind}`);
  } catch (e) { assert("16 编辑 rawHtml", false, String(e)); }

  // ===== G. 多 HTML 合并 =====
  // 17. 上传 2 个 HTML + 合并指令 → 进入合并路径
  try {
    const { status, events } = await generate(cookie, {
      requirement: "把 detail.html 嵌入主页的抽屉里",
      attachments: { documents: [
        { name: "index.html", kind: "html", content: HTML_A },
        { name: "detail.html", kind: "html", content: HTML_B },
      ] },
    });
    const term = terminalOf(events);
    const mergeEntered = anyStepMatches(events, /合并/);
    assert("17 多 HTML 合并路径被触发（step + 终态无 error）",
      status === 200 && term.kind !== "error" && term.kind !== "none" && mergeEntered,
      `status=${status} terminal=${term.kind} mergeStepFound=${mergeEntered}`);
  } catch (e) { assert("17 合并路径", false, String(e)); }

  // 18. 合并触发点找不到 → assistant 人话原因，不回退 LLM
  try {
    const { status, events } = await generate(cookie, {
      requirement: "把 nomatch.html 嵌入主页抽屉",
      attachments: { documents: [
        { name: "index.html", kind: "html", content: HTML_C },
        { name: "nomatch.html", kind: "html", content: HTML_B },
      ] },
    });
    const term = terminalOf(events);
    const asst = term.kind === "assistant" ? (term.messages || []).join(" ") : "";
    assert("18 合并失败 → assistant 人话原因（不回退 LLM）",
      status === 200 && term.kind === "assistant" && /触发点|文件名|页面结构|找不到|无法/.test(asst),
      `terminal=${term.kind} msg=${asst.slice(0, 100)}`);
  } catch (e) { assert("18 合并失败提示", false, String(e)); }

  // ===== H. 用量与计量 =====
  // 19. mock 不误记账（usage.jsonl 不增长）+ /api/usage 已登录 200
  const usagePath = usageJsonlPath();
  const before = countLines(usagePath);
  // 已跑过多轮 generate，再跑一轮确保有调用
  try {
    const { status, events } = await generate(cookie, { requirement: "再生成一个简单页面" });
    const after = countLines(usagePath);
    const u = await rawGet(cookie, "/api/usage");
    const usageOk = u.status === 200 && u.body?.totals && Array.isArray(u.body?.byUser) && Array.isArray(u.body?.byModel) && Array.isArray(u.body?.byDay);
    assert("19 mock 不写 usage.jsonl + /api/usage 结构正确",
      status === 200 && after === before && usageOk,
      `before=${before} after=${after} usage=${u.status} totals=${!!u.body?.totals}`);
  } catch (e) { assert("19 mock 不记账", false, String(e)); }

  // 20. /api/usage 未登录 → 401
  try {
    const { status, body } = await rawGet("", "/api/usage");
    assert("20 /api/usage 未登录 → 401",
      status === 401 && body?.error === "未登录",
      `status=${status} err=${body?.error}`);
  } catch (e) { assert("20 usage 门禁", false, String(e)); }

  // ---------- 报告 ----------
  const lines = [];
  lines.push("# 主功能冒烟测试报告（mock 模式 / HTTP API 端到端）");
  lines.push(`BASE: ${BASE}`);
  lines.push(`时间: ${new Date().toISOString()}`);
  lines.push(`通过 ${pass} / 失败 ${fail} / 共 ${results.length}`);
  lines.push("");
  for (const r of results) {
    lines.push(`${r.ok ? "✅" : "❌"} ${r.name} — ${r.detail}`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(REPORT, lines.join("\n") + "\n", "utf8");
  console.log(`\n# 汇总：通过 ${pass} / 失败 ${fail} / 共 ${results.length}`);
  console.log(`# 报告：${REPORT}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("测试脚本异常:", e);
  process.exit(2);
});
