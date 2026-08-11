import { z } from "zod";
import { type ModelKey } from "@/lib/config";
import { getProviderForStage } from "@/lib/providers";
import type { StyleProfile } from "@/lib/style/profiles";
import type { Attachments, ModelPreference } from "@/lib/types";
import type { MessageContent } from "@/lib/providers/types";
import { extractJson } from "./textUtils";
import { buildSessionAwareUserMessage, SESSION_CONTEXT_SYSTEM_RULE } from "./sessionBrief";
import { MAX_IMAGES } from "./constants";

export const HtmlUploadIntentSchema = z.object({
  intent: z.enum(["open", "edit", "regenerate", "ask"]),
  confidence: z.number().min(0).max(1).default(0.5),
  reason: z.string().default(""),
  applySelectedStyle: z.boolean().default(false),
  editInstruction: z.string().optional(),
  regenerateRequirement: z.string().optional(),
  userMessage: z.string().optional(),
});

export type HtmlUploadIntent = z.infer<typeof HtmlUploadIntentSchema>;

export const ImageUploadIntentSchema = z.object({
  intent: z.enum(["ask", "generate", "generate-with-changes"]),
  confidence: z.number().min(0).max(1).default(0.5),
  reason: z.string().default(""),
  generationRequirement: z.string().optional(),
  userMessage: z.string().optional(),
});

export type ImageUploadIntent = z.infer<typeof ImageUploadIntentSchema>;

/** 把文字 + 图片组装成多模态用户内容 */
export function userContent(text: string, images?: Attachments["images"]): MessageContent {
  const imgs = (images ?? []).slice(0, MAX_IMAGES);
  if (imgs.length === 0) return text;
  return [
    { type: "text", text },
    ...imgs.map((im) => ({ type: "image" as const, mediaType: im.mediaType, data: im.data })),
  ];
}

function stripHtmlForSummary(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function countHtmlTag(html: string, tag: string): number {
  return (html.match(new RegExp(`<${tag}\\b`, "gi")) ?? []).length;
}

export function summarizeHtmlForIntent(html: string) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  const visibleText = stripHtmlForSummary(html).slice(0, 1500);
  return {
    title,
    visibleText,
    chars: html.length,
    structure: {
      forms: countHtmlTag(html, "form"),
      tables: countHtmlTag(html, "table"),
      buttons: countHtmlTag(html, "button"),
      inputs: countHtmlTag(html, "input"),
      links: countHtmlTag(html, "a"),
      scripts: countHtmlTag(html, "script"),
      styles: countHtmlTag(html, "style"),
    },
  };
}

export function htmlUploadIntentSystemPrompt(): string {
  return `你是 YouDesign 的 HTML/ZIP 上传意图识别器。用户上传了一个已有 HTML 页面或 HTML 资源包，可能同时输入一句话。

任务：判断本次应该如何处理上传页面。只输出 JSON，不要解释。

intent 取值：
- "open": 用户只是想打开、查看、预览、先看看上传页面；或用户没有输入内容。
- "edit": 用户想在上传的原 HTML 页面上做最小修改，包括改文案、颜色、样式、布局、删除/新增元素、增加交互、优化/美化当前页。只要没有明确要求重做新页面，默认归为 edit。
- "regenerate": 用户明确要求参考上传页面重新生成/重做/重构/仿照做一个新页面，或明确表示不保留原 HTML/原代码。
- "ask": 用户是在问问题，不是在打开、修改或重生成页面。

判定原则：
- 保守使用 regenerate：只有明确表达"重新生成/重做一版/重构/参考它做新的/不保留原代码/作为参考生成类似页面"才用 regenerate。
- "优化一下/美化一下/改得更像某风格/调整页面"属于 edit，不是 regenerate。
- 如果用户选了设计风格但只说局部修改，仍然是 edit，且 applySelectedStyle=false；如果用户明确说"按已选风格/套用这个风格/改成所选风格/按某产品风格重绘/风格化整个页面"，则 intent=edit 且 applySelectedStyle=true。
- 只有"用户当前选择的设计风格"不是"未选择"时，applySelectedStyle 才允许为 true；未选择风格时必须为 false。
- 如果用户说参考页面重新生成，则是 regenerate，此时生成链路自然会应用已选设计风格，不需要依赖 applySelectedStyle。
- 非空但模糊的操作诉求默认 edit。

输出 JSON：
{"intent":"open|edit|regenerate|ask","confidence":0到1,"reason":"一句简短中文原因","applySelectedStyle":true|false,"editInstruction":"intent=edit 时归一化后的修改要求","regenerateRequirement":"intent=regenerate 时归一化后的生成需求","userMessage":"intent=ask 时给用户的简短回答或提示"}
JSON 字符串值内不要使用未转义的英文双引号。`;
}

export async function classifyHtmlUploadIntent(
  requirement: string,
  html: string,
  name: string,
  selectedStyle?: StyleProfile,
  sessionContext = ""
): Promise<HtmlUploadIntent> {
  const text = requirement.trim();
  if (!text) {
    return { intent: "open", confidence: 1, reason: "用户未输入文字，直接打开上传页面", applySelectedStyle: false };
  }
  const summary = summarizeHtmlForIntent(html);
  const { provider } = getProviderForStage("clarify", { override: "deepseek", preference: "deepseek" });
  try {
    const raw = await provider.complete({
      system: `${htmlUploadIntentSystemPrompt()}${sessionContext ? `\n\n${SESSION_CONTEXT_SYSTEM_RULE}` : ""}`,
      messages: [
        {
          role: "user",
          content: buildSessionAwareUserMessage(`文件名：${name}
HTML 字符数：${summary.chars}
页面标题：${summary.title || "（无）"}
用户当前选择的设计风格：${selectedStyle ? `${selectedStyle.name}（${selectedStyle.id}）` : "未选择"}
结构信号：form=${summary.structure.forms}, table=${summary.structure.tables}, button=${summary.structure.buttons}, input=${summary.structure.inputs}, link=${summary.structure.links}, script=${summary.structure.scripts}, style=${summary.structure.styles}
可见文本摘要：
${summary.visibleText || "（无可见文本）"}

用户输入：
${text}`, sessionContext),
        },
      ],
      json: true,
      temperature: 0.1,
      maxTokens: 1400,
    });
    const parsed = HtmlUploadIntentSchema.parse(extractJson(raw));
    const normalized: HtmlUploadIntent = {
      ...parsed,
      applySelectedStyle: parsed.intent === "edit" && Boolean(selectedStyle) && parsed.applySelectedStyle === true,
    };
    if (normalized.confidence < 0.55) {
      return {
        ...normalized,
        intent: "edit",
        editInstruction: normalized.editInstruction || text,
        reason: normalized.reason || "置信度较低，默认在原页面上修改",
      };
    }
    if (normalized.intent === "edit" && !normalized.editInstruction?.trim()) return { ...normalized, editInstruction: text };
    if (normalized.intent === "regenerate" && !normalized.regenerateRequirement?.trim()) {
      return { ...normalized, regenerateRequirement: text };
    }
    return normalized;
  } catch (err) {
    console.warn("[html-intent] 解析失败，默认 edit:", err instanceof Error ? err.message : err);
    return { intent: "edit", confidence: 0.5, reason: "意图识别失败，默认在原页面上修改", applySelectedStyle: false, editInstruction: text };
  }
}

export function imageUploadIntentSystemPrompt(): string {
  return `你是 YouDesign 的截图/图片上传意图识别器。用户上传了一张或多张图片，可能同时输入一句话。

任务：判断本次应该如何处理图片。只输出 JSON，不要解释。

intent 取值：
- "ask": 用户是在问图片相关问题、让你分析/评价/解释图片，不是在要求生成原型。
- "generate": 用户想根据图片生成原型，且没有提出额外修改。
- "generate-with-changes": 用户想根据图片生成原型，同时提出了修改、增加、删除、调整风格/布局/内容等差异要求。

判定原则：
- 空输入不需要模型判断，系统会直接当作 generate。
- "这是什么页面/这个图有什么问题/帮我分析这个界面/这张图哪里不好"属于 ask。
- "根据截图生成/还原/复刻/做成原型"属于 generate。
- "根据截图生成，但是把 X 改成 Y/增加 X/删除 X/改成某风格/换成移动端/补一个筛选区"属于 generate-with-changes。
- 模糊但带"生成/做/还原/复刻/页面/原型"倾向 generate；模糊但带"分析/评价/说明/什么意思"倾向 ask。

输出 JSON：
{"intent":"ask|generate|generate-with-changes","confidence":0到1,"reason":"一句简短中文原因","generationRequirement":"intent 为 generate 或 generate-with-changes 时，归一化后的生成需求","userMessage":"intent=ask 时，基于图片给用户的简短回答"}
JSON 字符串值内不要使用未转义的英文双引号。`;
}

export async function classifyImageUploadIntent(
  requirement: string,
  images: NonNullable<Attachments["images"]>,
  modelPreference: ModelPreference,
  sessionContext = ""
): Promise<{ decision: ImageUploadIntent; modelKey?: ModelKey }> {
  const text = requirement.trim();
  if (!text) {
    return {
      decision: {
        intent: "generate",
        confidence: 1,
        reason: "用户未输入文字，默认根据上传图片生成原型",
        generationRequirement: "请根据上传的截图/图片生成一个高保真可交互原型",
      },
    };
  }
  const { provider, modelKey } = getProviderForStage("clarify", {
    needsVision: true,
    preference: modelPreference,
  });
  try {
    const raw = await provider.complete({
      system: `${imageUploadIntentSystemPrompt()}${sessionContext ? `\n\n${SESSION_CONTEXT_SYSTEM_RULE}` : ""}`,
      messages: [
        {
          role: "user",
          content: userContent(
            buildSessionAwareUserMessage(`用户输入：\n${text}`, sessionContext),
            images
          ),
        },
      ],
      json: true,
      maxTokens: 1800,
    });
    const parsed = ImageUploadIntentSchema.parse(extractJson(raw));
    const normalized: ImageUploadIntent =
      parsed.confidence < 0.55
        ? {
            ...parsed,
            intent: "generate-with-changes",
            generationRequirement: parsed.generationRequirement || text,
            reason: parsed.reason || "置信度较低，默认按图片生成并吸收用户文字要求",
          }
        : parsed;
    if (normalized.intent !== "ask" && !normalized.generationRequirement?.trim()) {
      return { decision: { ...normalized, generationRequirement: text }, modelKey };
    }
    return { decision: normalized, modelKey };
  } catch (err) {
    console.warn("[image-intent] 解析失败，默认 generate-with-changes:", err instanceof Error ? err.message : err);
    return {
      decision: {
        intent: "generate-with-changes",
        confidence: 0.5,
        reason: "意图识别失败，默认根据图片生成并吸收用户文字要求",
        generationRequirement: text,
      },
      modelKey,
    };
  }
}
