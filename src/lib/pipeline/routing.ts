import { type ModelKey } from "@/lib/config";
import type { Device, ModelPreference } from "@/lib/types";

export function isRestorationRequirement(requirement: string): boolean {
  return /高保真|还原|复刻|仿照|参考|贴近|像|截图|设计稿|视觉稿|产品稿|风格/.test(requirement);
}

export function isDenseRequirement(requirement: string): boolean {
  const blocks = requirement.match(/(?:包含|包括|需要|展示|显示|支持|具备|带|有)[^。；;\n]+/g) ?? [];
  const joined = blocks.join("；") || requirement;
  const itemCount = joined.split(/[、,，；;。\n]/).map((s) => s.trim()).filter((s) => s.length >= 2).length;
  return itemCount >= 5 || requirement.length >= 260;
}

export function inferDeviceByRule(requirement: string): Device {
  const text = requirement.replace(/\s+/g, "");
  const hasPcManagementSignal = /PC|电脑|后台|管理系统|控制台|数据看板|管理端|运营后台|中台|表格|列表页/i.test(text);
  if (hasPcManagementSignal) return "pc";
  if (/手机|移动端|移动版|App|APP|H5|小程序|触屏|掌上|iPhone|Android|安卓|微信/.test(text)) return "mobile";
  return "pc";
}

export function shouldSkipImagePlanning(args: { fastMode: boolean; hasImages: boolean; hasDocs: boolean; useDpl: boolean }) {
  return args.fastMode && args.hasImages && !args.hasDocs;
}

export function shouldUseStrongInitialGenerate(args: {
  requirement: string;
  useDpl: boolean;
  hasImages: boolean;
  hasDocs: boolean;
  complex: boolean;
  pageCount: number;
  hasStyleProfile: boolean;
}) {
  return (
    args.hasImages ||
    args.hasDocs ||
    args.complex ||
    args.pageCount > 1 ||
    args.hasStyleProfile ||
    isRestorationRequirement(args.requirement)
  );
}

export function simpleGenerateOverride(preference: ModelPreference, strongInitial: boolean, fastMode: boolean): ModelKey | undefined {
  if (fastMode) return preference === "sonnet" || preference === "opus" || preference === "kimiK3" ? undefined : "deepseek";
  if (strongInitial) return undefined;
  // 简单原生页默认 flash-first；显式选 Kimi/GLM/Sonnet 时尊重用户的模型选择。
  if (preference === "auto" || preference === "deepseek") return "deepseek";
  return undefined;
}

export function strongRetryOverride(preference: ModelPreference): ModelKey | undefined {
  if (preference === "auto" || preference === "deepseek") return "deepseekPro";
  return undefined;
}
