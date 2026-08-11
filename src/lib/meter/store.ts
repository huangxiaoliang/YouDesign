import type { RowDataPacket } from "mysql2";
import { config } from "@/lib/config";
import { computeCost } from "./prices";
import { getMysqlPool } from "./mysql";
import { recordUsageJsonl, readUsageSummaryJsonl } from "./jsonl";
import type { UsageInput, UsageRecord, UsageSummary } from "./types";

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const asNumber = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 写入一条模型用量明细。写入失败只记日志，不影响原型生成结果。
 * store=config.usage.store：jsonl（默认，append 到 data/usage.jsonl）或 mysql。
 */
export async function recordUsage(input: UsageInput): Promise<void> {
  if (config.usage.store === "mysql") return recordUsageMysql(input);
  return recordUsageJsonl(input);
}

/** 读聚合用量（按人/模型/天）。jsonl 内存聚合（带 mtime 缓存）或 MySQL GROUP BY。 */
export async function readUsageSummary(): Promise<UsageSummary> {
  if (config.usage.store === "mysql") return readUsageSummaryMysql();
  return readUsageSummaryJsonl();
}

/**
 * 计量写入等待上限。MySQL 池只配了连接超时、没有读/查询超时，
 * 网络抖动时连接上的 read 会一直挂到 OS 的 TCP ETIMEDOUT（数分钟）才报错。
 * 而 MeteredProvider.stream 在流收尾时同步 await 这笔写入——等这么久会把
 * 整条流式生成结果卡在"已生成 99K"不动（模型其实已 end_turn）。设此上限，
 * 超时即放行（丢这一笔、走 catch 记日志），不再无限阻塞响应流。
 *
 * jsonl 模式走本地 fs append、无网络等待，不适用此超时。
 */
const METER_WRITE_TIMEOUT_MS = 5000;

/** MySQL 模式：写入一条用量明细。 */
async function recordUsageMysql(input: UsageInput): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
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
    const insert = getMysqlPool().execute(
      `INSERT INTO usage_records
        (occurred_at, user_id, generation_request_id, model, stage,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cny)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        new Date(rec.ts),
        rec.userId,
        rec.sessionId,
        rec.model,
        rec.stage,
        rec.inputTokens,
        rec.outputTokens,
        rec.cacheReadTokens,
        rec.cacheWriteTokens,
        rec.cost,
      ]
    );
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`meter write timeout after ${METER_WRITE_TIMEOUT_MS}ms`)),
        METER_WRITE_TIMEOUT_MS
      );
    });
    // 超时后 insert 可能仍在途/稍后才 settle，吞掉它的 rejection 避免 unhandled rejection。
    insert.catch(() => {});
    await Promise.race([insert, timeout]);
  } catch (err) {
    console.error("[meter] recordUsage failed:", err instanceof Error ? err.message : String(err));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** MySQL 模式：用 MySQL 直接聚合用量，避免把全量明细载入 Next 进程内存。 */
async function readUsageSummaryMysql(): Promise<UsageSummary> {
  const pool = getMysqlPool();
  const connection = await pool.getConnection();
  try {
    // 现网账号可能有较小的单用户连接限额；看板复用一条连接串行聚合。
    const [totalsRows] = await connection.query<RowDataPacket[]>(`
      SELECT COUNT(*) AS calls,
             COALESCE(SUM(input_tokens), 0) AS inputTokens,
             COALESCE(SUM(output_tokens), 0) AS outputTokens,
             COALESCE(SUM(cost_cny), 0) AS cost
      FROM usage_records
    `);
    const [userRows] = await connection.query<RowDataPacket[]>(`
      SELECT user_id AS userId,
             COUNT(*) AS calls,
             COALESCE(SUM(input_tokens), 0) AS inputTokens,
             COALESCE(SUM(output_tokens), 0) AS outputTokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
             COALESCE(SUM(cost_cny), 0) AS cost
      FROM usage_records
      GROUP BY user_id
      ORDER BY cost DESC
    `);
    const [modelRows] = await connection.query<RowDataPacket[]>(`
      SELECT model,
             COUNT(*) AS calls,
             COALESCE(SUM(input_tokens), 0) AS inputTokens,
             COALESCE(SUM(output_tokens), 0) AS outputTokens,
             COALESCE(SUM(cost_cny), 0) AS cost
      FROM usage_records
      GROUP BY model
      ORDER BY cost DESC
    `);
    const [dayRows] = await connection.query<RowDataPacket[]>(`
      SELECT DATE_FORMAT(DATE_ADD(occurred_at, INTERVAL 8 HOUR), '%Y-%m-%d') AS day,
             COUNT(*) AS calls,
             COALESCE(SUM(cost_cny), 0) AS cost
      FROM usage_records
      GROUP BY DATE_FORMAT(DATE_ADD(occurred_at, INTERVAL 8 HOUR), '%Y-%m-%d')
      ORDER BY day ASC
    `);
    const totals = totalsRows[0] ?? {};

    return {
      totals: {
        calls: asNumber(totals.calls),
        inputTokens: asNumber(totals.inputTokens),
        outputTokens: asNumber(totals.outputTokens),
        cost: round4(asNumber(totals.cost)),
      },
      byUser: userRows.map((row) => ({
        userId: String(row.userId ?? ""),
        calls: asNumber(row.calls),
        inputTokens: asNumber(row.inputTokens),
        outputTokens: asNumber(row.outputTokens),
        cacheReadTokens: asNumber(row.cacheReadTokens),
        cost: round4(asNumber(row.cost)),
      })),
      byModel: modelRows.map((row) => ({
        model: String(row.model ?? ""),
        calls: asNumber(row.calls),
        inputTokens: asNumber(row.inputTokens),
        outputTokens: asNumber(row.outputTokens),
        cost: round4(asNumber(row.cost)),
      })),
      byDay: dayRows.map((row) => ({
        day: String(row.day ?? ""),
        calls: asNumber(row.calls),
        cost: round4(asNumber(row.cost)),
      })),
    };
  } finally {
    connection.release();
  }
}
