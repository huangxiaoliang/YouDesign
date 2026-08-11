import type { AttachmentFileKind } from "@/lib/types";

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function runningTaskLabelFor(input: { mode: "generate" | "edit"; hasHtmlDoc: boolean; hasImages: boolean }) {
  if (input.mode === "edit") return "修改原型中";
  if (input.hasHtmlDoc) return "处理上传页面中";
  if (input.hasImages) return "分析图片中";
  return "生成原型中";
}

export function formatByteSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function progressHintForStep(
  step: { stage: string; detail?: string } | undefined,
  fallback: string,
  generatedCodeBytes: number
) {
  if (!step) return fallback;
  const codeHint = generatedCodeBytes > 0 ? `已生成 ${formatByteSize(generatedCodeBytes)} 代码，预览将在校验后刷新` : "";
  if ((step.stage === "generate" || step.stage === "edit" || step.stage === "open") && codeHint) return codeHint;
  if (step.stage === "intent") return step.detail || "正在理解本次要做什么…";
  if (step.stage === "clarify") return step.detail || "正在判断需求是否清晰，并识别 PC / 移动端…";
  if (step.stage === "candidates") return step.detail || "正在召回相关组件…";
  if (step.stage === "structure") return step.detail || "正在拆解页面结构与主要模块…";
  if (step.stage === "retrieve") return step.detail || "正在检索可用的 DPL 组件…";
  if (step.stage === "generate") return step.detail || "正在编写页面代码…";
  if (step.stage === "validate") return step.detail || "正在校验语法和组件合法性…";
  if (step.stage === "structure-check") return step.detail || "正在检查页面结构完整性…";
  if (step.stage === "review") return step.detail || "正在评审生成结果…";
  if (step.stage === "refine") return step.detail || "正在按评审意见做最小优化…";
  if (step.stage === "edit") return step.detail || "正在应用你的修改…";
  if (step.stage === "open") return step.detail || "正在处理上传的 HTML…";
  if (step.stage === "desktop-claude") return step.detail || "页面较大，正在增强处理…";
  if (step.stage === "preview") return step.detail || "正在渲染可交互预览…";
  return step.detail || fallback;
}

export function isAbortError(err: unknown) {
  return err instanceof DOMException && err.name === "AbortError";
}

/** 由文件名推断原始文件类型（决定图标 + 是否走下载） */
export function fileKindFromName(name: string): AttachmentFileKind {
  const lower = name.toLowerCase();
  if (/\.zip$/.test(lower)) return "zip";
  if (/\.html?$/.test(lower)) return "html";
  if (/\.docx?$/.test(lower)) return "word";
  if (/\.md$|\.markdown$/.test(lower)) return "markdown";
  return "text";
}
