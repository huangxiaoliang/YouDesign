#!/usr/bin/env node
// 用 Playwright 真实浏览器上传 1.zip，拦截 /api/generate 请求体，
// 抓取前端在浏览器端内联后的自包含 HTML（忠实于 home-helpers.ts 的 ZIP 内联逻辑）。
// 不实际跑生成（拦截后 abort），只为拿到内联 HTML 供后续 API 测试用。
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire("/Users/hxl/.npm/_npx/31e32ef8478fbf80/node_modules/");
const { chromium } = require("playwright");
import { readFileSync, writeFileSync } from "node:fs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BASE = "http://localhost:3000";
const OUT_DIR = `${__dirname}/../output/test-report/上传编辑标注对话自测`;
const ZIP_PATH = `${__dirname}/../output/1.zip`;
const OUT_HTML = `${OUT_DIR}/fileB-zip-inlined.html`;
const OUT_META = `${OUT_DIR}/fileB-zip-meta.json`;

function envLocal(key) {
  const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(txt);
  return m ? m[1].trim() : "";
}
const PASSWORD = envLocal("YOUDESIGN_ACCESS_PASSWORD");

async function main() {
  // 用系统已装的 Google Chrome（避免 playwright 下载浏览器版本不匹配）
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const consoleLogs = [];
  page.on("console", (m) => consoleLogs.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => consoleLogs.push(`pageerror: ${e.message}`));

  // 1. 登录
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill(".login-input", PASSWORD);
  await page.click(".login-btn");
  await page.waitForURL(BASE + "/", { timeout: 15000 });

  // 2. 拦截 /api/generate：抓请求体后 abort
  let capturedBody = null;
  await page.route("**/api/generate", async (route) => {
    try {
      const req = route.request();
      const postData = req.postData();
      capturedBody = JSON.parse(postData);
    } catch (e) {
      consoleLogs.push(`route-parse-error: ${e.message}`);
    }
    // 不实际生成，直接返回空 200 让前端尽快结束（前端会收到空流）
    await route.fulfill({ status: 200, body: "", contentType: "application/x-ndjson" });
  });

  // 3. 上传 1.zip（隐藏 input 直接 setInputFiles）
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(ZIP_PATH);
  // 等 chip 出现
  await page.locator(".chip", { hasText: "1.zip" }).waitFor({ timeout: 10000 });
  console.error("[cap] zip chip 出现，内联完成");

  // 4. 点发送（不需要文字，有附件即可）
  await page.locator('button:has-text("发送"), button[type="submit"]').first().click().catch(() => {});
  // 或者按回车
  await page.keyboard.press("Enter").catch(() => {});

  // 5. 等拦截
  for (let i = 0; i < 60 && !capturedBody; i++) await page.waitForTimeout(500);
  if (!capturedBody) {
    console.error("[cap] 未捕获到 /api/generate 请求");
    console.error("[cap] console:", consoleLogs.slice(-30).join("\n"));
    await browser.close();
    process.exit(2);
  }

  const doc = capturedBody.attachments?.documents?.find((d) => d.kind === "html");
  if (!doc) {
    console.error("[cap] 请求体无 html document；body keys:", Object.keys(capturedBody));
    console.error("[cap] attachments:", JSON.stringify(capturedBody.attachments)?.slice(0, 500));
    await browser.close();
    process.exit(3);
  }

  writeFileSync(OUT_HTML, doc.content);
  writeFileSync(
    OUT_META,
    JSON.stringify(
      {
        name: doc.name,
        contentLength: doc.content.length,
        rawHtml: capturedBody.rawHtml,
        requirement: capturedBody.requirement,
        hasDoctype: /^<!doctype/i.test(doc.content.trim()),
        hasTitle: /<title[^>]*>([\s\S]*?)<\/title>/i.test(doc.content),
        scriptDisabledCount: (doc.content.match(/data-yd-disabled-script/g) || []).length,
        scriptActiveCount: (doc.content.match(/<script\b(?![^>]*data-yd-disabled)/gi) || []).length,
        dataUrlCount: (doc.content.match(/data:[^"')]+;base64,/g) || []).length,
        consoleErrors: consoleLogs.filter((l) => /error|pageerror/i.test(l)).slice(0, 20),
      },
      null,
      2
    )
  );
  console.error(`[cap] 完成：内联 HTML ${doc.content.length} 字符 → ${OUT_HTML}`);
  console.error(`[cap] meta → ${OUT_META}`);
  await browser.close();
}

main().catch((e) => {
  console.error("[cap] 失败:", e);
  process.exit(1);
});
