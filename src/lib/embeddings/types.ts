/** 文本向量化统一抽象（智谱 / 本地兜底）。 */
export interface EmbeddingsProvider {
  readonly id: string;
  /** 是否走真实语义向量（否则为本地词法兜底） */
  readonly semantic: boolean;
  /** 批量向量化；返回与输入等长的向量数组 */
  embed(texts: string[]): Promise<number[][]>;
}
