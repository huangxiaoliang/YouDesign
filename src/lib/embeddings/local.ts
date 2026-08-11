import type { EmbeddingsProvider } from "./types";

/**
 * 本地兜底向量：字符 1~3-gram 哈希到定长向量并归一化。
 * 非真正语义，但对"领域词重叠"（如 级联/上传/开关）召回良好，且离线零依赖。
 * 有智谱 key 时会被真实 embedding-3 取代。
 */
const DIM = 384;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function embedOne(text: string): number[] {
  const v = new Array(DIM).fill(0);
  const s = text.toLowerCase().replace(/\s+/g, "");
  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i + n <= s.length; i++) {
      const g = s.slice(i, i + n);
      v[fnv1a(g) % DIM] += 1;
    }
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

export class LocalEmbeddings implements EmbeddingsProvider {
  readonly id = "local:ngram";
  readonly semantic = false;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(embedOne);
  }
}
