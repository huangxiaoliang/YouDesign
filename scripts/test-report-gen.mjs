#!/usr/bin/env node
// 读 result.json → 生成 HTML 报告
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __d = dirname(fileURLToPath(import.meta.url));
const OUT = join(__d, "..", "output", "test-report", "100paths");
const results = JSON.parse(readFileSync(join(OUT, "result.json"), "utf8"));

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (ms) => (ms == null ? "—" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const statusColor = { PASS: "#16a34a", FAIL: "#ea580c", BROKEN: "#dc2626", ERROR: "#b91c1c", SKIPPED: "#9ca3af" };

// 统计
const byStatus = {}, byPath = {}, byGroup = {};
const times = [];
let bugs = [];
for (const r of results) {
  byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  if (r.path) byPath[r.path] = (byPath[r.path] || 0) + 1;
  byGroup[r.g] = byGroup[r.g] || { total: 0, pass: 0, fail: 0 };
  byGroup[r.g].total++;
  if (r.status === "PASS") byGroup[r.g].pass++;
  else if (r.status !== "SKIPPED") byGroup[r.g].fail++;
  if (r.dt && r.status !== "SKIPPED") times.push({ id: r.id, g: r.g, dt: r.dt, status: r.status });
  if (["FAIL", "BROKEN", "ERROR"].includes(r.status)) bugs.push(r);
}
times.sort((a, b) => a.dt - b.dt);
const p = (arr, q) => arr.length ? arr[Math.floor(arr.length * q)] : null;
const avg = times.length ? Math.round(times.reduce((s, t) => s + t.dt, 0) / times.length) : 0;
const slow = [...times].sort((a, b) => b.dt - a.dt).slice(0, 8);

const rows = results.map((r) => `<tr style="background:${r.status === "PASS" ? "#f0fdf4" : r.status === "SKIPPED" ? "#f9fafb" : "#fef2f2"}">
<td>${r.id}</td><td>${esc(r.g)}</td><td>${esc(r.instr).slice(0, 60)}</td>
<td style="color:${statusColor[r.status] || "#000"};font-weight:600">${r.status}</td>
<td>${esc(r.path || "—")}</td><td style="text-align:right">${fmt(r.dt)}</td>
<td>${esc(r.verify || r.error || "")}</td></tr>`).join("\n");

const groupRows = Object.entries(byGroup).map(([g, v]) => `<tr>
<td>${esc(g)}</td><td>${v.total}</td><td style="color:#16a34a">${v.pass}</td>
<td style="color:#dc2626">${v.fail}</td><td>${v.total ? Math.round(v.pass / v.total * 100) : 0}%</td></tr>`).join("\n");

const pathRows = Object.entries(byPath).sort((a, b) => b[1] - a[1]).map(([p, n]) => `<tr><td>${esc(p)}</td><td>${n}</td></tr>`).join("\n");

const slowRows = slow.map((t) => `<tr><td>${t.id}</td><td>${esc(t.g)}</td><td style="color:${statusColor[t.status]}">${t.status}</td><td style="text-align:right">${fmt(t.dt)}</td></tr>`).join("\n");

const bugRows = bugs.map((r) => `<tr><td>${r.id}</td><td>${esc(r.g)}</td><td>${esc(r.instr).slice(0, 50)}</td><td style="color:${statusColor[r.status]}">${r.status}</td><td>${esc(r.path || "")}</td><td>${esc((r.verify || r.error || "")).slice(0, 120)}</td><td>${esc((r.steps || []).slice(-2).join(" | "))}</td></tr>`).join("\n");

const total = results.length;
const passRate = total ? Math.round((byStatus.PASS || 0) / total * 100) : 0;

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<title>100 条用户路径测试报告</title>
<style>
body{font-family:-apple-system,"PingFang SC",sans-serif;margin:0;padding:24px;background:#f8fafc;color:#1e293b;line-height:1.6}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 10px;border-left:4px solid #2563eb;padding-left:10px}
.kpis{display:flex;gap:16px;flex-wrap:wrap;margin:16px 0}
.kpi{background:#fff;border-radius:10px;padding:14px 20px;box-shadow:0 1px 3px rgba(0,0,0,.08);min-width:120px}
.kpi .n{font-size:26px;font-weight:700;color:#1e293b}.kpi .l{font-size:12px;color:#64748b}
table{border-collapse:collapse;width:100%;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);font-size:13px}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #e2e8f0;vertical-align:top}
th{background:#f1f5f9;font-weight:600;font-size:12px;color:#475569}
td{font-family:inherit}
code{background:#f1f5f9;padding:1px 5px;border-radius:3px;font-size:12px}
.sug{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px 18px;margin:8px 0}
.sug h3{margin:0 0 6px;font-size:14px;color:#92400e}
.note{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px 16px;font-size:13px;color:#1e40af}
</style></head><body>
<h1>100 条用户路径测试报告</h1>
<div style="color:#64748b;font-size:13px">YouDesign · 原型生成与迭代修改端到端 · 生成时间 ${new Date().toISOString().slice(0,19).replace("T"," ")}</div>

<div class="kpis">
<div class="kpi"><div class="n">${total}</div><div class="l">用例总数</div></div>
<div class="kpi"><div class="n" style="color:#16a34a">${byStatus.PASS || 0}</div><div class="l">PASS</div></div>
<div class="kpi"><div class="n" style="color:#dc2626">${(byStatus.FAIL||0)+(byStatus.BROKEN||0)+(byStatus.ERROR||0)}</div><div class="l">问题(BROKEN/FAIL/ERROR)</div></div>
<div class="kpi"><div class="n" style="color:#9ca3af">${byStatus.SKIPPED || 0}</div><div class="l">SKIPPED</div></div>
<div class="kpi"><div class="n">${passRate}%</div><div class="l">通过率(含 skipped 不计)</div></div>
<div class="kpi"><div class="n">${fmt(avg)}</div><div class="l">平均响应</div></div>
<div class="kpi"><div class="n">${times.length ? fmt(p(times, 0.5).dt) : "—"}</div><div class="l">P50</div></div>
<div class="kpi"><div class="n">${times.length ? fmt(p(times, 0.9).dt) : "—"}</div><div class="l">P90</div></div>
</div>

<div class="note">说明：G1 仅跑 C01/C02 两条生成（C03-C05 跳过省时）；G8 直接编辑为前端 contentEditable 行为、不经 /api/generate，标记 SKIPPED；G11 ZIP 无样本跳过。响应时间含 LLM 端到端往返。</div>

<h2>分组通过率</h2>
<table><tr><th>分组</th><th>总数</th><th>PASS</th><th>问题</th><th>通过率</th></tr>
${groupRows}</table>

<h2>路径分布（修改链路）</h2>
<table><tr><th>路径</th><th>次数</th></tr>${pathRows}</table>

<h2>响应时间最慢 8 条</h2>
<table><tr><th>ID</th><th>分组</th><th>状态</th><th style="text-align:right">耗时</th></tr>${slowRows}</table>

<h2>问题用例（BUG / 失败）</h2>
${bugs.length ? `<table><tr><th>ID</th><th>分组</th><th>指令</th><th>状态</th><th>路径</th><th>详情</th><th>末尾 steps</th></tr>${bugRows}</table>` : '<div class="note">无问题用例 🎉</div>'}

<h2>全量明细</h2>
<table><tr><th>ID</th><th>分组</th><th>指令</th><th>状态</th><th>路径</th><th style="text-align:right">耗时</th><th>验证详情</th></tr>
${rows}</table>

<h2>体验改进建议</h2>

<div class="sug"><h3>① 删除/移动类指令几乎没享受到提速（高优先）</h3>
G4 删除/移动 10 条<strong>全部走慢路径</strong>（noop→full 或 fallback，40–53s）。locate 对"删 X/移动 X"倾向定位到元素本身而非容纳它的容器，导致 scope 选错→no-op→回退整页。<br>
<b>建议</b>：locate prompt 对删除/移动指令明确要求定位"目标元素的<strong>容纳容器</strong>"；或 selectHtmlPatchScope 在 locate 路径下对 isRemoveOrMove 更激进上提。预计能把该组 40s+ 降到 3–5s。</div>

<div class="sug"><h3>② 泛化 UI 文本与卡片/表格级元素 locate 命中率低</h3>
"请输入/查看详情/暂无数据/数据加载中"等泛化文案、KPI 卡标题、表格行/列等多条 fallback/noop。locate 对这类目标置信不足或定位到叶子。<br>
<b>建议</b>：locate prompt 对唯一文案给更高置信；对"加列/加行/删行"直接定位 <code>&lt;table&gt;</code>；textSnippet 匹配放宽（允许部分命中）。</div>

<div class="sug"><h3>③ classifyEditIntent 误判含"修改"的提问（中优先）</h3>
E73"我可以怎么修改这个原型？"因含"修改"被判 edit，走完整 locate+full-rewrite 才不动页（13.5s），而正常 ask 仅 1s。<br>
<b>建议</b>：classifyEditIntent prompt 加强疑问句式（"怎么/可以...吗/如何"）的 ask 判定，覆盖"修改"关键词误触发。</div>

<div class="sug"><h3>④ 标题文本多处出现时 scope patch 只改一处（中优先）</h3>
E01"改主标题"FAIL：标题文本"财务总览仪表盘"在 <code>&lt;title&gt;</code> 和可见 H1 都有，scope patch 只改了 <code>&lt;title&gt;</code>，严格断言要求全消故 FAIL。<br>
<b>建议</b>：locate 对"改标题"识别所有含该文本的位置；或 selectHtmlPatchScope 对标题类上提到含两处的更大 scope。</div>

<div class="sug"><h3>⑤ 护栏拦截后前端提示不够明确（低优先）</h3>
E83"把整个页面重做成电商首页"护栏正确拦截、不产出新版本（保护原型，是好行为），但前端表现为"无产出/已保留原页面"，用户可能困惑。<br>
<b>建议</b>：护栏触发时给更明确提示："检测到整页重做诉求，已保留原页面；如确需重做请明确说明。" E84"换 Vue"类似。</div>

<div class="sug"><h3>⑥ 响应速度总览</h3>
scope patch 路径 2.8–15s（体验良好）；fallback / noop→full 路径 40–53s（体验差）。ask 1–1.4s（除 E73 误判）。生成 25–44s。<br>
<b>建议</b>：优先把①②的 locate 命中率提上去，能把大量 40s 降到 3–5s，是 ROI 最高的提速方向。</div>

<div class="note"><b>非产品 bug 的"问题"用例</b>（测试设计/基底限制，报告里仍列出但已确认）：E61/E63 anchor 注入失败（基底无真实 <code>&lt;td&gt;</code>/<code>&lt;img&gt;</code>）；E79 空指令 HTTP 400（API 正确拒绝空输入）；E83 BROKEN（护栏正确拦截整页重做，测试应预期"不动页"为 PASS）。真实产品 bug 仅 E01、E41 两条 FAIL。</div>

</body></html>`;

writeFileSync(join(OUT, "report.html"), html);
console.log(`报告已生成: ${join(OUT, "report.html")} | PASS ${byStatus.PASS||0}/${total} | 问题 ${bugs.length}`);
