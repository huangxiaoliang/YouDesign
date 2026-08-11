import type { Usage } from "@/lib/providers/types";

/** 用量明细（jsonl 每行一条；MySQL 模式下 usage_records 表，字段名在 store 边界转 snake_case） */
export interface UsageRecord {
  ts: string; // ISO 时间
  userId: string;
  sessionId: string; // 一次生成请求内所有调用共享
  model: string; // 真实模型名
  stage: string; // clarify/structure/generate/editSmall/editLarge
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number; // CNY
}

/** 单模型价格（CNY / 百万 token） */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** 记账入参（费用由 store 按 prices 计算） */
export interface UsageInput {
  userId: string;
  sessionId: string;
  model: string;
  stage: string;
  usage: Usage;
}

export interface UsageUserAggregate {
  userId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number;
}

export interface UsageModelAggregate {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface UsageDayAggregate {
  day: string;
  calls: number;
  cost: number;
}

export interface UsageSummary {
  totals: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  };
  byUser: UsageUserAggregate[];
  byModel: UsageModelAggregate[];
  byDay: UsageDayAggregate[];
}

/** 单个管线阶段耗时记录（stage-timing.jsonl 每行一条） */
export interface StageTimingRecord {
  ts: string;
  userId?: string;
  sessionId?: string;
  stage: string;
  durationMs: number;
  model?: string;
  modelKey?: string;
  mode: "generate" | "edit" | "open";
  artifact: "raw" | "html" | "unknown";
  rawHtml: boolean;
  hasAttachments: boolean;
  hasImages: boolean;
  hasDocs: boolean;
  fastMode: boolean;
  device?: "pc" | "mobile";
  outcome?: string;
}

export interface StageTimingInput extends Omit<StageTimingRecord, "ts" | "userId" | "sessionId"> {}
