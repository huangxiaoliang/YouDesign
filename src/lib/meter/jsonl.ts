import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import { computeCost } from "./prices";
import type { UsageInput, UsageRecord, UsageSummary } from "./types";

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const asNumber = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function filePath(): string {
  return path.join(config.data.dir, config.usage.file);
}

/**
 * 进程内写队列：串行 append，保证多请求并发时行不交错。
 * 链上单次失败只记日志、不中断后续写入。
 */
let writeChain: Promise<void> = Promise.resolve();
function appendLine(line: string): Promise<void> {
  const run = writeChain.then(async () => {
    try {
      await fs.appendFile(filePath(), line + "\n", "utf8");
    } catch (err) {
      console.error("[meter/jsonl] append failed:", err instanceof Error ? err.message : String(err));
    }
  });
  // 不让链因 reject 断掉（上面已 try/catch，理论上不会 reject，双保险）
  writeChain = run.catch(() => {});
  return run;
}

/** 写一条用量明细到 jsonl（费用由 prices 计算）。本地 fs append，失败只记日志不阻断生成。 */
export async function recordUsageJsonl(input: UsageInput): Promise<void> {
  const rec: UsageRecord = {
    ts: new Date().toISOString(),
    userId: input.userId,
    sessionId: input.sessionId,
    model: input.model,
    stage: input.stage,
    inputTokens: input.usage.inputTokens || 0,
    outputTokens: input.usage.outputTokens || 0,
    cacheReadTokens: input.usage.cacheReadTokens || 0,
    cacheWriteTokens: input.usage.cacheWriteTokens || 0,
    cost: computeCost(input.model, input.usage),
  };
  await appendLine(JSON.stringify(rec));
}

/** UTC ISO 时间按中国自然日（+8h）取 YYYY-MM-DD，对齐原 MySQL 看板的 DATE_ADD(INTERVAL 8 HOUR) 口径。 */
function chinaDay(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "unknown";
  d.setUTCHours(d.getUTCHours() + 8);
  return d.toISOString().slice(0, 10);
}

/** mtime 缓存：文件未变则复用上次聚合结果，避免每次 /api/usage 重读全文件。 */
let cachedMtimeMs = -1;
let cachedSummary: UsageSummary | null = null;

/** 读全量 jsonl 内存聚合（按人/模型/天）。文件不存在或为空返回零值。 */
export async function readUsageSummaryJsonl(): Promise<UsageSummary> {
  const file = filePath();
  let mtimeMs = -1;
  try {
    const stat = await fs.stat(file);
    mtimeMs = stat.mtimeMs;
  } catch {
    mtimeMs = -1; // 文件不存在
  }
  if (cachedSummary && mtimeMs === cachedMtimeMs) return cachedSummary;

  const text = existsSync(file) ? await fs.readFile(file, "utf8") : "";
  const summary = aggregate(text);
  cachedMtimeMs = mtimeMs;
  cachedSummary = summary;
  return summary;
}

function aggregate(text: string): UsageSummary {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  const byUser = new Map<string, { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cost: number }>();
  const byModel = new Map<string, { calls: number; inputTokens: number; outputTokens: number; cost: number }>();
  const byDay = new Map<string, { calls: number; cost: number }>();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: UsageRecord;
    try {
      rec = JSON.parse(trimmed) as UsageRecord;
    } catch {
      continue; // 跳过损坏行
    }
    calls += 1;
    const inT = asNumber(rec.inputTokens);
    const outT = asNumber(rec.outputTokens);
    const cacheR = asNumber(rec.cacheReadTokens);
    const c = asNumber(rec.cost);
    inputTokens += inT;
    outputTokens += outT;
    cost += c;

    const u = byUser.get(rec.userId) ?? { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0 };
    u.calls += 1;
    u.inputTokens += inT;
    u.outputTokens += outT;
    u.cacheReadTokens += cacheR;
    u.cost += c;
    byUser.set(rec.userId, u);

    const m = byModel.get(rec.model) ?? { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    m.calls += 1;
    m.inputTokens += inT;
    m.outputTokens += outT;
    m.cost += c;
    byModel.set(rec.model, m);

    const day = chinaDay(rec.ts);
    const d = byDay.get(day) ?? { calls: 0, cost: 0 };
    d.calls += 1;
    d.cost += c;
    byDay.set(day, d);
  }

  return {
    totals: { calls, inputTokens, outputTokens, cost: round4(cost) },
    byUser: [...byUser.entries()]
      .map(([userId, v]) => ({ userId, calls: v.calls, inputTokens: v.inputTokens, outputTokens: v.outputTokens, cacheReadTokens: v.cacheReadTokens, cost: round4(v.cost) }))
      .sort((a, b) => b.cost - a.cost),
    byModel: [...byModel.entries()]
      .map(([model, v]) => ({ model, calls: v.calls, inputTokens: v.inputTokens, outputTokens: v.outputTokens, cost: round4(v.cost) }))
      .sort((a, b) => b.cost - a.cost),
    byDay: [...byDay.entries()]
      .map(([day, v]) => ({ day, calls: v.calls, cost: round4(v.cost) }))
      .sort((a, b) => (a.day < b.day ? -1 : 1)),
  };
}
