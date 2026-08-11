import { config, modelHasCredentials, type ModelKey, type RouteStage } from "@/lib/config";
import { AnthropicProvider } from "./anthropic";
import { createDeepSeekProvider, createDeepSeekProProvider, createGlm5vProvider, createGlmProvider } from "./openaiCompatible";
import { MockProvider } from "./mock";
import type { LLMProvider } from "./types";
import type { ModelPreference } from "@/lib/types";
import { MeteredProvider } from "@/lib/meter/meteredProvider";
import { getMeterContext } from "@/lib/meter/context";

export type { LLMProvider } from "./types";

const mock = new MockProvider();

/** 惰性构造，避免无关 provider 在缺配置时报错 */
const builders: Record<ModelKey, () => LLMProvider> = {
  opus: () =>
    new AnthropicProvider({
      id: "anthropic:opus",
      baseUrl: config.anthropic.baseUrl,
      apiKey: config.anthropic.apiKey,
      model: config.anthropic.models.opus,
      auth: "x-api-key",
      maxOutputTokens: 128000,
      // Sonnet 5 / Opus 5 省略 thinking 字段时默认开 adaptive thinking（旧模型是关的），
      // 显式关闭以保留 4.6/4.8 时代的快速/便宜行为；Opus 5 在默认 effort(high) 下接受 disabled。
      thinking: { type: "disabled" },
    }),
  sonnet: () =>
    new AnthropicProvider({
      id: "anthropic:sonnet",
      baseUrl: config.anthropic.baseUrl,
      apiKey: config.anthropic.apiKey,
      model: config.anthropic.models.sonnet,
      auth: "x-api-key",
      maxOutputTokens: 128000,
      // 同上：Sonnet 5 默认开 adaptive thinking，显式关闭。
      thinking: { type: "disabled" },
    }),
  // GLM：智谱官方 OpenAI-compatible /chat/completions
  glm: () => createGlmProvider(),
  // GLM-5V：智谱视觉模型，上传图片生成原型时由用户显式选择
  glm5v: () => createGlm5vProvider(),
  // Kimi K3：火山方舟 Agent Plan（Anthropic 兼容端点 /v1/messages + Bearer），显式关闭 thinking
  kimiK3: () =>
    new AnthropicProvider({
      id: "anthropic:kimi-k3",
      baseUrl: config.kimiK3.baseUrl,
      apiKey: config.kimiK3.apiKey,
      model: config.kimiK3.model,
      auth: "bearer",
      maxOutputTokens: config.kimiK3.maxOutputTokens,
      thinking: { type: "disabled" },
    }),
  deepseek: () => createDeepSeekProvider(),
  deepseekPro: () => createDeepSeekProProvider(),
};

const cache = new Map<ModelKey, LLMProvider>();

/** 解析某 model key 对应的 provider；强制 mock 或无密钥时回退 mock */
export function getProvider(key: ModelKey): { provider: LLMProvider; usedMock: boolean } {
  if (config.forceMock || !modelHasCredentials(key)) {
    return { provider: mock, usedMock: true };
  }
  if (!cache.has(key)) cache.set(key, builders[key]());
  return { provider: cache.get(key)!, usedMock: false };
}

/** 视觉能力：Anthropic 系与智谱 GLM-5V 支持图片输入 */
function isVisionModel(key: ModelKey): boolean {
  return key === "opus" || key === "sonnet" || key === "glm5v" || key === "kimiK3";
}

function preferredModelForStage(stage: RouteStage, preference: ModelPreference): ModelKey | undefined {
  if (preference === "auto") return undefined;
  if (preference === "opus") return "opus";
  if (preference === "sonnet") return "sonnet";
  if (preference === "glm5v") return "glm5v";
  if (preference === "kimiK3") return "kimiK3";
  if (preference === "glm") {
    if (stage === "clarify" || stage === "structure") return "deepseek";
    return "glm";
  }
  if (stage === "generate") return "deepseekPro";
  return "deepseek";
}

export function complexStructureModelForPreference(preference: ModelPreference): ModelKey {
  if (preference === "opus") return "opus";
  if (preference === "sonnet") return "sonnet";
  if (preference === "glm5v") return "glm5v";
  if (preference === "kimiK3") return "kimiK3";
  if (preference === "glm") return "glm";
  if (preference === "deepseek") return "deepseekPro";
  return config.structureComplexModel;
}

/** 真实模型名（用于计量记录与看板展示） */
export function modelRealName(key: ModelKey): string {
  switch (key) {
    case "opus":
      return config.anthropic.models.opus;
    case "sonnet":
      return config.anthropic.models.sonnet;
    case "glm":
      return config.glm.model;
    case "glm5v":
      return config.glm5v.model;
    case "kimiK3":
      return config.kimiK3.model;
    case "deepseek":
      return config.deepseek.model;
    case "deepseekPro":
      return config.deepseek.proModel;
  }
}

/**
 * 按管线环节解析 provider（应用 .env 路由）。
 * - preference：用户指定模型策略；auto 时保留 .env 路由
 * - override：显式指定模型，优先于 .env 路由（用于按复杂度分流等场景）
 * - needsVision=true 时尊重用户视觉模型选择；未指定视觉模型时默认 kimiK3
 * 计量：在 meter context 内（生成请求中）且非 mock 时，用 MeteredProvider 包装，调用点无感记账。
 */
export function getProviderForStage(
  stage: RouteStage,
  opts?: { needsVision?: boolean; override?: ModelKey; preference?: ModelPreference }
): {
  provider: LLMProvider;
  modelKey: ModelKey;
  usedMock: boolean;
} {
  const preference = opts?.preference ?? "auto";
  let modelKey = opts?.override ?? preferredModelForStage(stage, preference) ?? config.routes[stage];
  if (opts?.needsVision) {
    if (preference === "opus" || preference === "sonnet" || preference === "glm5v" || preference === "kimiK3") {
      modelKey = preference;
    } else if (!isVisionModel(modelKey)) {
      modelKey = "glm5v";
    }
  }
  const { provider: inner, usedMock } = getProvider(modelKey);
  const ctx = getMeterContext();
  const provider =
    ctx && !usedMock
      ? new MeteredProvider(inner, {
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          model: modelRealName(modelKey),
          stage,
        })
      : inner;
  return { provider, modelKey, usedMock };
}
