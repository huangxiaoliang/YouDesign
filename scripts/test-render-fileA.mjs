#!/usr/bin/env node
// 用 Playwright 渲染 workload-stats_1.html（JS 模板渲染页面），dump 渲染后的 documentElement.outerHTML。
// 用于忠实模拟"标注作用在渲染后 DOM"的场景（真实 UI 的 serializeFrameHtmlWithAnchor 走的就是渲染后 DOM）。
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire("/Users/hxl/.npm/_npx/31e32ef8478fbf80/node_modules/");
const { chromium } = require("playwright");
import { readFileSync, writeFileSync } from "node:fs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SRC = `${__dirname}/../output/workload-stats_1.html`;
const OUT = `${__dirname}/../output/test-report/上传编辑标注对话自测/fileA-rendered.html`;
const OUT_META = `${__dirname}/../output/test-report/上传编辑标注对话自测/fileA-rendered-meta.json`;

async function main() {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const page = await ctx.newPage();
  const consoleLogs = [];
  page.on("console", (m) => consoleLogs.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => consoleLogs.push(`pageerror: ${e.message}`));

  // 用 srcdoc iframe 渲染（与预览沙箱一致），等脚本执行完
  await page.goto("about:blank");
  await page.setContent(
    `<!doctype html><html><body><iframe id="f" style="width:430px;height:900px;border:0"></iframe></body></html>`
  );
  const src = readFileSync(SRC, "utf8");
  // 先去掉 srcdoc 大小限制感：直接用 page.evaluate 把 html 写入 iframe
  await page.evaluate((html) => {
    const f = document.getElementById("f");
    f.srcdoc = html;
  }, src);
  // 等渲染
  await page.waitForTimeout(1500);
  // dump 渲染后 outerHTML
  const rendered = await page.evaluate(() => {
    const f = document.getElementById("f");
    const doc = f.contentDocument;
    return doc ? "<!doctype html>\n" + doc.documentElement.outerHTML : "";
  });
  writeFileSync(OUT, rendered);
  const literalNums = (rendered.match(/>\s*\d[\d,.]*\s*</g) || []).length;
  writeFileSync(
    OUT_META,
    JSON.stringify(
      {
        renderedLength: rendered.length,
        literalNumberCount: literalNums,
        hasTitle: /<title[^>]*>([\s\S]*?)<\/title>/i.test(rendered),
        cardCount: (rendered.match(/class="[^"]*card[^"]*"/g) || []).length,
        cellVCount: (rendered.match(/class="[^"]*\bv\b[^"]*"/g) || []).length,
        consoleErrors: consoleLogs.filter((l) => /error|pageerror/i.test(l)).slice(0, 20),
        consoleAll: consoleLogs.slice(0, 30),
      },
      null,
      2
    )
  );
  console.error(`[render] 渲染后 ${rendered.length} 字符，字面量数字 ${literalNums} 个 → ${OUT}`);
  await browser.close();
}
main().catch((e) => {
  console.error("[render] 失败:", e);
  process.exit(1);
});
