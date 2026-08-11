import { createHash } from "node:crypto";

/**
 * data URI 占位压缩：送大模型前把 base64/字体等 `data:` URI 换成短占位符，
 * 模型输出后再回填。仅作用于「送模型的入参」边界，绝不修改 original 字符串本身
 * （匹配/校验/no-op/重写检测都拿 original 当基线，需保持原貌）。
 *
 * 只做 A 类（data URI），不动注释/空白——保持 original 原貌给校验/no-op/重写检测当基线。
 */

const DATA_URI_RE = /data:[^"'\s)]*/g;
const PLACEHOLDER_RE = /__(?:YD_)?ASSET_([a-f0-9]{12,64}|\d+)__/gi;
const PLACEHOLDER_TEST_RE = /__(?:YD_)?ASSET_([a-f0-9]{12,64}|\d+)__/i;
const MIN_SAVING = 2048; // 省 >2KB 才启用占位，避免给小文件加无谓噪音

export interface CompactedHtml {
  compact: string;
  map: Map<string, string>;
}

export interface AssetPlaceholderValidation {
  ok: boolean;
  reason?: string;
}

/**
 * 把 HTML 里所有 `data:` URI 替换为稳定 hash 占位符。
 * 相同 data URI 复用同一占位符（去重）。节省不明显（<2KB）时原样返回空 map。
 */
export function compactDataUris(html: string): CompactedHtml {
  const dataToPlaceholder = new Map<string, string>();
  const placeholderToData = new Map<string, string>();
  let compact = "";
  let last = 0;
  for (const m of html.matchAll(DATA_URI_RE)) {
    const uri = m[0];
    let ph = dataToPlaceholder.get(uri);
    if (!ph) {
      ph = stableAssetPlaceholder(uri, placeholderToData);
      dataToPlaceholder.set(uri, ph);
      placeholderToData.set(ph, uri);
    }
    const idx = m.index ?? 0;
    compact += html.slice(last, idx) + ph;
    last = idx + uri.length;
  }
  compact += html.slice(last);
  if (dataToPlaceholder.size === 0 || html.length - compact.length < MIN_SAVING) {
    return { compact: html, map: new Map() };
  }
  // placeholder → uri，供回填用
  const map = new Map<string, string>();
  for (const [uri, ph] of dataToPlaceholder) map.set(ph, uri);
  return { compact, map };
}

function stableAssetPlaceholder(uri: string, used: Map<string, string>): string {
  const digest = createHash("sha256").update(uri).digest("hex");
  for (let len = 12; len <= digest.length; len += 4) {
    const ph = `__YD_ASSET_${digest.slice(0, len)}__`;
    const existing = used.get(ph);
    if (!existing || existing === uri) return ph;
  }
  return `__YD_ASSET_${digest}__`;
}

/**
 * 把 `__YD_ASSET_<hash>__` 占位符替换回原 data URI。
 * 用函数式 replacer 避免 data URI 中 `$` 被当成反向引用。
 */
export function expandDataUris(html: string, map: Map<string, string>): string {
  if (!map.size) return html;
  return html.replace(PLACEHOLDER_RE, (ph) => map.get(ph) ?? ph);
}

/** 是否含占位符（供提示词决定是否追加保留说明） */
export function hasDataUriPlaceholder(html: string): boolean {
  return PLACEHOLDER_TEST_RE.test(html);
}

/**
 * 校验模型/Claude 返回的占位符是否仍可安全回填。
 * 非删除类编辑要求原有资源引用都保留；删除类编辑允许删掉元素连带删掉资源引用，
 * 但任何未知占位符都视为损坏，避免回填后留下坏 src/url。
 */
export function validateAssetPlaceholders(
  html: string,
  map: Map<string, string>,
  opts: { allowMissing?: boolean } = {}
): AssetPlaceholderValidation {
  if (!map.size) return { ok: true };
  const found = new Set(Array.from(html.matchAll(PLACEHOLDER_RE), (m) => m[0]));
  const unknown = Array.from(found).filter((ph) => !map.has(ph));
  if (unknown.length) {
    return { ok: false, reason: `包含未知资源占位符：${unknown.slice(0, 3).join(", ")}` };
  }
  if (!opts.allowMissing) {
    const missing = Array.from(map.keys()).filter((ph) => !found.has(ph));
    if (missing.length) {
      return { ok: false, reason: `资源占位符丢失：${missing.slice(0, 3).join(", ")}` };
    }
  }
  return { ok: true };
}
