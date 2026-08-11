import type { HtmlSizeInfo, RawHtmlAsset, RawHtmlState } from "@/lib/types";
import { compactDataUris, expandDataUris, validateAssetPlaceholders } from "./dataUriPlaceholder";
import { DEFAULT_CLAUDE_MAX_BYTES, DEFAULT_FULLPAGE_EDIT_THRESHOLD_BYTES, utf8Bytes } from "./htmlSizeInfo";

export interface RawHtmlEditContext {
  previewHtml: string;
  editHtml: string;
  assetMap: Map<string, string>;
  state: RawHtmlState;
}

export function rawHtmlAssetsToMap(assets: RawHtmlAsset[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const asset of assets ?? []) {
    if (asset?.placeholder && asset?.dataUri) map.set(asset.placeholder, asset.dataUri);
  }
  return map;
}

function mapToRawHtmlAssets(map: Map<string, string>): RawHtmlAsset[] {
  return Array.from(map, ([placeholder, dataUri]) => ({ placeholder, dataUri }));
}

export function createRawHtmlState(previewHtml: string): RawHtmlState {
  const { compact, map } = compactDataUris(previewHtml);
  const originalBytes = utf8Bytes(previewHtml);
  const compactBytes = utf8Bytes(compact);
  return {
    editHtml: compact,
    assets: mapToRawHtmlAssets(map),
    assetCount: map.size,
    savedBytes: Math.max(0, originalBytes - compactBytes),
  };
}

export function getRawHtmlEditContext(html: string, state?: RawHtmlState): RawHtmlEditContext {
  if (state?.editHtml) {
    const assetMap = rawHtmlAssetsToMap(state.assets);
    const validation = validateAssetPlaceholders(state.editHtml, assetMap, { allowMissing: false });
    if (validation.ok) {
      const previewHtml = expandDataUris(state.editHtml, assetMap);
      return { previewHtml, editHtml: state.editHtml, assetMap, state };
    }
  }

  const nextState = createRawHtmlState(html);
  const assetMap = rawHtmlAssetsToMap(nextState.assets);
  return {
    previewHtml: html,
    editHtml: nextState.editHtml,
    assetMap,
    state: nextState,
  };
}

export function analyzeRawHtmlEditContext(
  previewHtml: string,
  editHtml: string,
  assetMap: Map<string, string>,
  opts: {
    fullpageEditThresholdBytes?: number;
    claudeMaxBytes?: number;
  } = {}
): HtmlSizeInfo {
  const fullpageEditThresholdBytes = opts.fullpageEditThresholdBytes ?? DEFAULT_FULLPAGE_EDIT_THRESHOLD_BYTES;
  const claudeMaxBytes = opts.claudeMaxBytes ?? DEFAULT_CLAUDE_MAX_BYTES;
  const originalBytes = utf8Bytes(previewHtml);
  const compactBytes = utf8Bytes(editHtml);
  const shouldUseClaude = compactBytes >= fullpageEditThresholdBytes;

  return {
    originalChars: previewHtml.length,
    originalBytes,
    compactChars: editHtml.length,
    compactBytes,
    assetCount: assetMap.size,
    savedBytes: Math.max(0, originalBytes - compactBytes),
    fullpageEditThresholdBytes,
    claudeMaxBytes,
    canFullpageEdit: compactBytes < fullpageEditThresholdBytes,
    shouldUseClaude,
    tooLargeForClaude: shouldUseClaude && compactBytes > claudeMaxBytes,
  };
}
