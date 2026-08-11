import type { StyleProfile } from "./profiles";

/**
 * 把风格档案的 styleSpec 拼成注入到结构化/生成/编辑提示词的 styleHead。
 * 原默认产品壳 pattern 已移除（公开版只透传档案 styleSpec）。
 */
export function buildStyleHead(
  profile: StyleProfile | undefined,
  _opts: { requirement: string; device?: "pc" | "mobile" }
): string {
  if (!profile) return "";
  return profile.styleSpec + "\n\n";
}
