/**
 * 轻量"判别"调用：用 flash 做意图判别 / 预检（澄清+设备）。
 * 失败一律兜底放行，不阻断主管线。
 */
import { z } from "zod";
import { config, type ModelKey } from "@/lib/config";
import { getProviderForStage } from "@/lib/providers";
import {
  clarifySystemPrompt,
  editPlanSystemPrompt,
  globalVisualEditIntentSystemPrompt,
  interactiveEditIntentSystemPrompt,
  intentSystemPrompt,
  locateScopeSystemPrompt,
  mergeHintSystemPrompt,
} from "@/lib/prompts";
import type { Device, ModelPreference, UploadedDoc, UploadedImage } from "@/lib/types";
import type { MessageContent } from "@/lib/providers/types";
import { extractJson } from "./textUtils";
import type { LocateResult } from "./htmlScopePatch";
import {
  buildSessionAwareUserMessage,
  SESSION_CONTEXT_SYSTEM_RULE,
} from "./sessionBrief";
import { MAX_IMAGES } from "./constants";

const CLARIFY_MAX_TOKENS = 8000; // 判别 JSON 小，但要盖住推理

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function userContent(text: string, images?: UploadedImage[]): MessageContent {
  const imgs = (images ?? []).slice(0, MAX_IMAGES);
  if (imgs.length === 0) return text;
  return [
    { type: "text", text },
    ...imgs.map((im) => ({ type: "image" as const, mediaType: im.mediaType, data: im.data })),
  ];
}

const IntentSchema = z.object({
  intent: z.enum(["edit", "ask"]),
  answer: z.string().optional(),
});

const PreflightSchema = z.object({
  clear: z.boolean(),
  questions: z.array(z.string()).default([]),
  device: z.enum(["pc", "mobile"]).default("pc"),
  deviceClear: z.boolean().default(true),
});

const InteractiveEditIntentSchema = z.object({
  interactive: z.boolean().default(false),
  interactionType: z
    .enum(["click", "tab", "drawer", "modal", "navigation", "expand", "filter", "unknown"])
    .default("unknown"),
  triggerText: z.string().optional(),
  targetText: z.string().optional(),
  dataScope: z.string().optional(),
  reason: z.string().optional(),
  confidence: z.number().default(0),
});

export type InteractiveEditIntent = z.infer<typeof InteractiveEditIntentSchema>;

const GlobalVisualEditIntentSchema = z.object({
  global: z.boolean().default(false),
  reason: z.string().optional(),
  confidence: z.number().default(0),
});

export type GlobalVisualEditIntent = z.infer<typeof GlobalVisualEditIntentSchema>;

/** 全局视觉编辑意图分类：判断是否为整页视觉/全局编辑。失败返回 null，调用方按局部编辑处理（保守，不阻断） */
export async function classifyGlobalVisualEditInstruction(
  instruction: string,
  modelPreference: ModelPreference = "auto",
  opts?: { override?: ModelKey; timeoutMs?: number; sessionContext?: string }
): Promise<GlobalVisualEditIntent | null> {
  const { provider } = getProviderForStage("clarify", { preference: modelPreference, override: opts?.override });
  const request = provider.complete({
    system: `${globalVisualEditIntentSystemPrompt()}${opts?.sessionContext ? `\n\n${SESSION_CONTEXT_SYSTEM_RULE}` : ""}`,
    messages: [
      {
        role: "user",
        content: buildSessionAwareUserMessage(instruction, opts?.sessionContext),
      },
    ],
    json: true,
    temperature: 0,
    maxTokens: 300,
  });
  try {
    const raw = await withTimeout(request, opts?.timeoutMs ?? 5000);
    const v = GlobalVisualEditIntentSchema.parse(extractJson(raw));
    return { ...v, reason: v.reason?.trim() || undefined };
  } catch {
    return null;
  }
}

const MergeHintsSchema = z.object({
  primaryName: z.string().optional(),
  secondaries: z
    .array(
      z.object({
        fileName: z.string(),
        subpageName: z.string().optional(),
      })
    )
    .default([]),
  mergeForm: z.enum(["drawer", "modal", "page", "tab", "unknown"]).default("unknown"),
  isMergeRequest: z.boolean().default(false),
});

export type MergeHints = z.infer<typeof MergeHintsSchema>;

/**
 * 合并链路主/次页 + 子页面名抽取：从用户指令抽取「主页面文件名」与每个次要页的「子页面名」。
 * 用于替代 resolvePrimarySecondary / deriveExtractTarget 的正则抽取部分（文件名匹配仍是结构操作，留在调用方）。
 * 失败/超时返回 null，调用方回退原正则抽取。原文链接不写进 prompt，仅给文件名清单 + 用户指令。
 */
export async function extractMergeHints(
  instruction: string,
  htmlDocs: UploadedDoc[],
  modelPreference: ModelPreference = "auto",
  opts?: { override?: ModelKey; timeoutMs?: number; sessionContext?: string }
): Promise<MergeHints | null> {
  if (!htmlDocs.length) return null;
  const fileNames = htmlDocs.map((d) => d.name).filter(Boolean);
  if (!fileNames.length) return null;
  const { provider } = getProviderForStage("clarify", { preference: modelPreference, override: opts?.override });
  const request = provider.complete({
    system: `${mergeHintSystemPrompt(fileNames)}${opts?.sessionContext ? `\n\n${SESSION_CONTEXT_SYSTEM_RULE}` : ""}`,
    messages: [{ role: "user", content: buildSessionAwareUserMessage(instruction, opts?.sessionContext) }],
    json: true,
    temperature: 0,
    maxTokens: 600,
  });
  try {
    const raw = await withTimeout(request, opts?.timeoutMs ?? 5000);
    const v = MergeHintsSchema.parse(extractJson(raw));
    return {
      ...v,
      primaryName: v.primaryName?.trim() || undefined,
      secondaries: (v.secondaries ?? [])
        .filter((s) => s.fileName && s.subpageName)
        .map((s) => ({ fileName: s.fileName.trim(), subpageName: s.subpageName!.trim() })),
    };
  } catch {
    return null;
  }
}

/** ModelKey → 实际模型展示名（用于回答"用了什么模型"这类问题） */
function modelDisplay(key: ModelKey): string {
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

/** 迭代意图判别：用 flash 极速判断"改原型"还是"提问"。判别失败默认按修改处理，不阻断 */
export async function classifyEditIntent(
  message: string,
  modelPreference: ModelPreference = "auto",
  sessionContext = ""
): Promise<{ intent: "edit" | "ask"; answer: string }> {
  const r = config.routes;
  const facts = `本工具的模型路由：修改/编辑用「${modelDisplay(r.editLarge)}」；需求结构化与页面生成用「${modelDisplay(
    r.generate
  )}」；上传图片等多模态场景可选「${modelDisplay("sonnet")}」或「${modelDisplay("glm5v")}」。`;
  const { provider } = getProviderForStage("clarify", { preference: modelPreference });
  try {
    const raw = await provider.complete({
      system: `${intentSystemPrompt(facts)}${sessionContext ? `\n\n${SESSION_CONTEXT_SYSTEM_RULE}` : ""}`,
      messages: [
        {
          role: "user",
          content: buildSessionAwareUserMessage(message, sessionContext),
        },
      ],
      json: true,
      temperature: 0,
      maxTokens: 1500,
    });
    const v = IntentSchema.parse(extractJson(raw));
    return { intent: v.intent, answer: v.answer ?? "" };
  } catch {
    return { intent: "edit", answer: "" };
  }
}

/** 预检：一次 flash 调用同时判定「需求是否明确」+「PC/移动端」。失败兜底放行 + pc */
export async function preflight(
  requirement: string,
  modelPreference: ModelPreference = "auto",
  images?: UploadedImage[],
  sessionContext = ""
): Promise<{ clear: boolean; questions: string[]; device: Device; deviceClear: boolean }> {
  const hasImages = (images?.length ?? 0) > 0;
  const { provider } = getProviderForStage("clarify", { preference: modelPreference, needsVision: hasImages });
  try {
    const raw = await provider.complete({
      system: `${clarifySystemPrompt()}${sessionContext ? `\n\n${SESSION_CONTEXT_SYSTEM_RULE}` : ""}`,
      messages: [
        {
          role: "user",
          content: userContent(buildSessionAwareUserMessage(requirement, sessionContext), images),
        },
      ],
      json: true,
      temperature: 0.2,
      maxTokens: CLARIFY_MAX_TOKENS,
    });
    const v = PreflightSchema.parse(extractJson(raw));
    return { clear: v.clear, questions: v.questions, device: v.device, deviceClear: v.deviceClear };
  } catch {
    return { clear: true, questions: [], device: "pc", deviceClear: true };
  }
}

/** 灰区交互意图兜底分类：失败返回 null，调用方保持原规则结果 */
export async function classifyInteractiveEditIntent(
  instruction: string,
  domSummary = "",
  modelPreference: ModelPreference = "auto",
  opts?: { override?: ModelKey; timeoutMs?: number; sessionContext?: string }
): Promise<InteractiveEditIntent | null> {
  const { provider } = getProviderForStage("clarify", { preference: modelPreference, override: opts?.override });
  const request = provider.complete({
    system: `${interactiveEditIntentSystemPrompt(domSummary)}\n\n${SESSION_CONTEXT_SYSTEM_RULE}`,
    messages: [
      {
        role: "user",
        content: buildSessionAwareUserMessage(instruction, opts?.sessionContext),
      },
    ],
    json: true,
    temperature: 0,
    maxTokens: 500,
  });
  try {
    const raw = await withTimeout(request, opts?.timeoutMs ?? 5000);
    const v = InteractiveEditIntentSchema.parse(extractJson(raw));
    return {
      ...v,
      triggerText: v.triggerText?.trim() || undefined,
      targetText: v.targetText?.trim() || undefined,
      dataScope: v.dataScope?.trim() || undefined,
      reason: v.reason?.trim() || undefined,
    };
  } catch {
    return null;
  }
}

const LocateSchema = z.object({
  tag: z.string().optional(),
  classHint: z.string().optional(),
  textSnippet: z.string().optional(),
  selectorHint: z.string().optional(),
  offsetHint: z.number().optional(),
  confidence: z.number().default(0),
  ambiguous: z.boolean().default(true),
  batch: z.boolean().default(false),
});

const EditPlanSchema = z.object({
  operation: z
    .enum(["replace_text", "insert", "delete", "move", "restyle", "interaction", "batch", "dedup", "other"])
    .default("other"),
  targetDescription: z.string().optional(),
  scopeHint: z.string().optional(),
  targetText: z.string().optional(),
  replacementText: z.string().optional(),
  selectorHint: z.string().optional(),
  offsetHint: z.number().optional(),
  batch: z.boolean().default(false),
  interactive: z.boolean().default(false),
  needsFullPage: z.boolean().default(false),
  confidence: z.number().default(0),
});

export type EditPlan = z.infer<typeof EditPlanSchema>;

/** 编辑前结构化计划：失败/超时返回 null，调用方继续走旧链路 */
export async function planHtmlEdit(
  instruction: string,
  summary: string,
  modelPreference: ModelPreference = "auto",
  opts?: { override?: ModelKey; sessionContext?: string; timeoutMs?: number }
): Promise<EditPlan | null> {
  const { provider } = getProviderForStage("clarify", { preference: modelPreference, override: opts?.override });
  const request = provider.complete({
    system: `${editPlanSystemPrompt(summary)}${opts?.sessionContext ? `\n\n${SESSION_CONTEXT_SYSTEM_RULE}` : ""}`,
    messages: [{ role: "user", content: buildSessionAwareUserMessage(instruction, opts?.sessionContext) }],
    json: true,
    temperature: 0,
    maxTokens: 900,
  });
  try {
    const raw = await withTimeout(request, opts?.timeoutMs ?? 5000);
    const v = EditPlanSchema.parse(extractJson(raw));
    return {
      ...v,
      targetDescription: v.targetDescription?.trim() || undefined,
      scopeHint: v.scopeHint?.trim() || undefined,
      targetText: v.targetText?.trim() || undefined,
      replacementText: v.replacementText?.trim() || undefined,
      selectorHint: v.selectorHint?.trim() || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 纯文本修改的目标定位：用 flash 看 DOM 摘要 + 指令，输出目标元素定位 JSON。
 * 失败/parse 异常一律返回 null（兜底放行，让上游回退整页重出）。
 */
export async function locateScopeTarget(
  instruction: string,
  summary: string,
  modelPreference: ModelPreference = "auto",
  opts?: { override?: ModelKey; sessionContext?: string }
): Promise<LocateResult | null> {
  const { provider } = getProviderForStage("clarify", { preference: modelPreference, override: opts?.override });
  try {
    const raw = await provider.complete({
      system: `${locateScopeSystemPrompt(summary)}${opts?.sessionContext ? `\n\n${SESSION_CONTEXT_SYSTEM_RULE}` : ""}`,
      messages: [{ role: "user", content: buildSessionAwareUserMessage(instruction, opts?.sessionContext) }],
      json: true,
      temperature: 0,
      maxTokens: 400,
    });
    const v = LocateSchema.parse(extractJson(raw));
    if (!v.tag) return null;
    return {
      tag: v.tag.toLowerCase(),
      classHint: v.classHint?.trim() || undefined,
      textSnippet: v.textSnippet?.trim() || undefined,
      selectorHint: v.selectorHint?.trim() || undefined,
      offsetHint: v.offsetHint,
      confidence: v.confidence,
      ambiguous: v.ambiguous,
      batch: v.batch,
    };
  } catch {
    return null;
  }
}
