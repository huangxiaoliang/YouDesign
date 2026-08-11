import type { HtmlSizeInfo } from "@/lib/types";
import { compactDataUris, type CompactedHtml } from "./dataUriPlaceholder";

export const DEFAULT_FULLPAGE_EDIT_THRESHOLD_BYTES = 640_000;
/** 服务端只用于展示/协议兼容的默认值；最终大小上限由 Electron 按本机配置校验。 */
export const DEFAULT_CLAUDE_MAX_BYTES = 15_000_000;

export interface HtmlEditSizeAnalysis extends CompactedHtml {
  info: HtmlSizeInfo;
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function analyzeHtmlEditSize(
  html: string,
  opts: {
    fullpageEditThresholdBytes?: number;
    claudeMaxBytes?: number;
  } = {}
): HtmlEditSizeAnalysis {
  const fullpageEditThresholdBytes = opts.fullpageEditThresholdBytes ?? DEFAULT_FULLPAGE_EDIT_THRESHOLD_BYTES;
  const claudeMaxBytes = opts.claudeMaxBytes ?? DEFAULT_CLAUDE_MAX_BYTES;
  const compacted = compactDataUris(html);
  const originalBytes = utf8Bytes(html);
  const compactBytes = utf8Bytes(compacted.compact);
  const shouldUseClaude = compactBytes >= fullpageEditThresholdBytes;

  return {
    ...compacted,
    info: {
      originalChars: html.length,
      originalBytes,
      compactChars: compacted.compact.length,
      compactBytes,
      assetCount: compacted.map.size,
      savedBytes: Math.max(0, originalBytes - compactBytes),
      fullpageEditThresholdBytes,
      claudeMaxBytes,
      canFullpageEdit: compactBytes < fullpageEditThresholdBytes,
      shouldUseClaude,
      tooLargeForClaude: shouldUseClaude && compactBytes > claudeMaxBytes,
    },
  };
}

export function formatKb(bytes: number): string {
  return `${Math.round(bytes / 1024)}KB`;
}
