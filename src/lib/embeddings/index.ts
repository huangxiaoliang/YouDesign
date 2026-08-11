import { config } from "@/lib/config";
import { ZhipuEmbeddings } from "./zhipu";
import { LocalEmbeddings } from "./local";
import type { EmbeddingsProvider } from "./types";

export type { EmbeddingsProvider } from "./types";

let cached: EmbeddingsProvider | null = null;

/** 有智谱 key 且非 forceMock → 真实语义向量；否则本地词法兜底 */
export function getEmbeddings(): EmbeddingsProvider {
  if (cached) return cached;
  cached =
    !config.forceMock && config.zhipu.apiKey ? new ZhipuEmbeddings() : new LocalEmbeddings();
  return cached;
}
