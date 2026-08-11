import { config } from "@/lib/config";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ModelPrice } from "./types";
import type { Usage } from "@/lib/providers/types";

/**
 * 公开刊例价（CNY / 百万 token）。以各家官网为准；可在 data/prices.json 覆盖。
 * - Anthropic 官价为 USD，按 config.billing.fxRate（默认 7.2）折 CNY；缓存读 0.1× 输入、缓存写 1.25× 输入。
 * - DeepSeek 官价为 USD（api-docs.deepseek.com），按 fxRate 折 CNY；缓存命中（prompt_cache_hit_tokens）单列 cacheRead 价。
 * - Kimi K3 / 智谱 GLM 为 CNY 直价；缓存命中单列 cacheRead 价，缓存写无加价（cacheWrite=0）。
 * 来源（2026-08-06 核实）：
 *   - Anthropic：Opus 4.8/5 官价 $5/$25（缓存读 0.1×=$0.5、写 1.25×=$6.25）；Sonnet 5 $3/$15（2026-08-31 前介绍价 $2/$10，此处按标准价）；Sonnet 4.6 $3/$15。
 *     注：此前 claude-opus-4-8 误用 Claude 3 Opus 旧价 $15/$75，已修正为 $5/$25。
 *   - DeepSeek：https://api-docs.deepseek.com/quick_start/pricing
 *   - Kimi K3：https://platform.kimi.com/docs/pricing/chat-k3.md（注：本系统走火山方舟 Agent Plan，实际账单以方舟控制台为准）
 *   - 智谱：bigmodel.cn/pricing（GLM-5.2 ¥8/¥28/缓存命中¥2；GLM-5V-Turbo ¥5/¥22/缓存命中¥1.2，输入长度 [0,32K) 首档）
 * 注：智谱"缓存存储"按百万 token/小时计费且现限时免费，非按 token 写入加价，故 cacheWrite=0（不回退到输入价）。
 *     DeepSeek/Kimi 的缓存写同样无加价，cacheWrite=0。
 */
const FX = config.billing.fxRate;
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // Anthropic（USD × fxRate）
  "claude-opus-5": { input: 5 * FX, output: 25 * FX, cacheRead: 0.5 * FX, cacheWrite: 6.25 * FX },
  "claude-opus-4-8": { input: 5 * FX, output: 25 * FX, cacheRead: 0.5 * FX, cacheWrite: 6.25 * FX },
  "claude-sonnet-5": { input: 3 * FX, output: 15 * FX, cacheRead: 0.3 * FX, cacheWrite: 3.75 * FX },
  "claude-sonnet-4-6": { input: 3 * FX, output: 15 * FX, cacheRead: 0.3 * FX, cacheWrite: 3.75 * FX },
  // DeepSeek（USD × fxRate；api-docs 2026-08 刊例价）
  "deepseek-v4-flash": { input: 0.14 * FX, output: 0.28 * FX, cacheRead: 0.0028 * FX, cacheWrite: 0 },
  "deepseek-v4-pro": { input: 0.435 * FX, output: 0.87 * FX, cacheRead: 0.003625 * FX, cacheWrite: 0 },
  // Kimi K3（CNY；Moonshot 官方 2026-08 刊例价，火山方舟实际以方舟控制台为准）
  "kimi-k3": { input: 20, output: 100, cacheRead: 2, cacheWrite: 0 },
  // 智谱 GLM（CNY；bigmodel.cn/pricing 2026-08 刊例价）
  "glm-5.2": { input: 8, output: 28, cacheRead: 2, cacheWrite: 0 },
  "glm-5v-turbo": { input: 5, output: 22, cacheRead: 1.2, cacheWrite: 0 },
};

let cached: Record<string, ModelPrice> | null = null;

/** 加载价格表：data/prices.json 覆盖默认值（按 model 名为键） */
function loadPrices(): Record<string, ModelPrice> {
  try {
    const file = path.resolve(process.cwd(), config.data.dir, "prices.json");
    if (existsSync(file)) {
      const override = JSON.parse(readFileSync(file, "utf8"));
      if (override && typeof override === "object" && !Array.isArray(override)) {
        return { ...DEFAULT_PRICES, ...override };
      }
    }
  } catch {
    /* 损坏则用默认 */
  }
  return DEFAULT_PRICES;
}

function prices(): Record<string, ModelPrice> {
  if (!cached) cached = loadPrices();
  return cached;
}

/** 重新加载价格表（改了 data/prices.json 后调用；测试用） */
export function reloadPrices(): void {
  cached = null;
}

/** 按 token 用量与价格表算费用（CNY）。token 单位为个、价格为 CNY/百万，故 /1e6 */
export function computeCost(model: string, usage: Usage): number {
  const p = prices()[model];
  if (!p) return 0; // 未知模型不计费
  const inTok = usage.inputTokens || 0;
  const outTok = usage.outputTokens || 0;
  const cacheRead = usage.cacheReadTokens || 0;
  const cacheWrite = usage.cacheWriteTokens || 0;
  const cacheReadPrice = p.cacheRead ?? p.input; // 未配置缓存读价则按输入价
  const cacheWritePrice = p.cacheWrite ?? p.input; // 未配置缓存写价则按输入价
  const cost =
    (inTok * p.input + outTok * p.output + cacheRead * cacheReadPrice + cacheWrite * cacheWritePrice) / 1e6;
  return Math.round(cost * 1e4) / 1e4; // 保留 4 位小数
}
