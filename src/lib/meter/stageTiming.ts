import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import { getMeterContext } from "./context";
import type { StageTimingInput, StageTimingRecord } from "./types";

interface Aggregate {
  count: number;
  totalMs: number;
  maxMs: number;
}

const aggregates = new Map<string, Aggregate>();

function timingFile(): string {
  return path.resolve(process.cwd(), config.data.dir, "stage-timing.jsonl");
}

function aggregateKey(input: StageTimingInput): string {
  return [
    input.stage,
    input.model ?? "-",
    input.mode,
    input.artifact,
    input.hasAttachments ? "att" : "no-att",
    input.fastMode ? "fast" : "quality",
  ].join("|");
}

function writeTiming(record: StageTimingRecord) {
  try {
    const file = timingFile();
    const dir = path.dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    console.error("[timing] recordStageTiming failed:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * 记录管线阶段耗时：落一行 jsonl 便于离线聚合，同时维护进程内 group-by 摘要日志。
 * 分组维度覆盖模型、模式、DPL/raw、附件与 fast/quality，方便后续调路由时看真实体感。
 */
export function recordStageTiming(input: StageTimingInput): void {
  const ctx = getMeterContext();
  const record: StageTimingRecord = {
    ts: new Date().toISOString(),
    userId: ctx?.userId,
    sessionId: ctx?.sessionId,
    ...input,
  };
  writeTiming(record);

  const key = aggregateKey(input);
  const prev = aggregates.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
  const next = {
    count: prev.count + 1,
    totalMs: prev.totalMs + input.durationMs,
    maxMs: Math.max(prev.maxMs, input.durationMs),
  };
  aggregates.set(key, next);
  const avgMs = Math.round(next.totalMs / next.count);
  console.info(
    `[timing] stage=${input.stage} duration=${input.durationMs}ms avg=${avgMs}ms max=${next.maxMs}ms n=${next.count} model=${
      input.model ?? "-"
    } mode=${input.mode} artifact=${input.artifact} attachments=${input.hasAttachments ? "yes" : "no"} ${
      input.fastMode ? "fast" : "quality"
    } outcome=${input.outcome ?? "ok"}`
  );
}
