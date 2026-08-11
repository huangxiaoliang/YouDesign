#!/usr/bin/env node
// 用量 jsonl 存储回归：写/读聚合 + 并发写不交错 + mtime 缓存失效。
// 机制：esbuild 把 src/lib/meter/jsonl.ts bundle 成临时 ESM，设临时 data 目录后 import。
import { build } from "esbuild";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const TMP = mkdtempSync(join(tmpdir(), "yd-usage-jsonl-"));
// 必须在 import bundle 之前设好 env（config.ts 在模块加载时读 env）
process.env.YOUDESIGN_DATA_DIR = TMP;
process.env.YOUDESIGN_USAGE_FILE = "test-usage.jsonl";
process.env.YOUDESIGN_USAGE_STORE = "jsonl";

const outfile = join(TMP, "jsonl.bundle.mjs");
await build({
  entryPoints: [join(ROOT, "src/lib/meter/jsonl.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  alias: { "@/lib": join(ROOT, "src/lib") },
  outfile,
  logLevel: "silent",
});

const { recordUsageJsonl, readUsageSummaryJsonl } = await import(pathToFileURL(outfile).href);

const USAGE = (inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

try {
  // 1) 写 3 条（2 用户、2 模型）
  await recordUsageJsonl({ userId: "u1", sessionId: "s1", model: "deepseek-v4-flash", stage: "generate", usage: USAGE(100, 200, 50) });
  await recordUsageJsonl({ userId: "u1", sessionId: "s1", model: "deepseek-v4-pro", stage: "generate", usage: USAGE(300, 400) });
  await recordUsageJsonl({ userId: "u2", sessionId: "s2", model: "deepseek-v4-flash", stage: "editLarge", usage: USAGE(10, 20, 5) });

  let s = await readUsageSummaryJsonl();
  assert(s.totals.calls === 3, `totals.calls 应为 3，实得 ${s.totals.calls}`);
  assert(s.totals.inputTokens === 410, `inputTokens 应为 410，实得 ${s.totals.inputTokens}`);
  assert(s.totals.outputTokens === 620, `outputTokens 应为 620，实得 ${s.totals.outputTokens}`);
  assert(s.byUser.length === 2, `byUser 应 2 条，实得 ${s.byUser.length}`);
  assert(s.byUser[0].userId === "u1", "byUser 首位应 u1（cost 高）");
  assert(s.byUser[0].cacheReadTokens === 50, `u1 cacheRead 应 50，实得 ${s.byUser[0].cacheReadTokens}`);
  assert(s.byModel.length === 2, `byModel 应 2 条，实得 ${s.byModel.length}`);
  assert(s.byDay.length >= 1, "byDay 至少 1 天");

  // 2) 并发写 50 条，验证不交错、全部可解析
  const before = (await readUsageSummaryJsonl()).totals.calls;
  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      recordUsageJsonl({ userId: `uc${i % 5}`, sessionId: `sc${i}`, model: "deepseek-v4-flash", stage: "generate", usage: USAGE(i, i + 1) })
    )
  );
  const file = join(TMP, "test-usage.jsonl");
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert(lines.length === 53, `文件应有 53 行（3+50），实得 ${lines.length}`);
  let malformed = 0;
  for (const ln of lines) {
    try { JSON.parse(ln); } catch { malformed++; }
  }
  assert(malformed === 0, `${malformed} 行损坏（并发写交错）`);

  const after = (await readUsageSummaryJsonl()).totals.calls;
  assert(after === 53, `并发后 calls 应 53，实得 ${after}（before=${before}）`);

  // 3) mtime 缓存：连续读用缓存；写后 mtime 变、再读更新
  const cached1 = await readUsageSummaryJsonl();
  const cached2 = await readUsageSummaryJsonl();
  assert(cached1 === cached2, "mtime 未变应返回同一缓存对象");
  await recordUsageJsonl({ userId: "u1", sessionId: "s3", model: "deepseek-v4-flash", stage: "generate", usage: USAGE(1, 1) });
  const refreshed = await readUsageSummaryJsonl();
  assert(refreshed.totals.calls === 54, `写后应刷新为 54，实得 ${refreshed.totals.calls}`);
  assert(refreshed !== cached1, "写后应重新聚合、不复用缓存");

  console.log("usage jsonl regression: ok (write/read/concurrency/mtime-cache)");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
