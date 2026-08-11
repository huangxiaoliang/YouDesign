import { config } from "@/lib/config";
import { httpFetch } from "@/lib/http";
import type { EmbeddingsProvider } from "./types";

/** 智谱 embedding-3 真实语义向量（OpenAI 风格 /embeddings）。 */
export class ZhipuEmbeddings implements EmbeddingsProvider {
  readonly id = "zhipu:embedding-3";
  readonly semantic = true;

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await httpFetch(`${config.zhipu.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.zhipu.apiKey}`,
      },
      body: JSON.stringify({ model: config.zhipu.embedModel, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`智谱 embedding 调用失败: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
    // 按 index 排序，保证与输入顺序一致
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
