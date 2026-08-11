/** LLM provider 统一抽象。所有家族（Anthropic/智谱/DeepSeek/Mock）都实现它。 */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  /** MIME，如 image/png、image/jpeg */
  mediaType: string;
  /** base64（不含 data: 前缀） */
  data: string;
}

/** 消息内容：纯文本，或图文混合块（多模态） */
export type MessageContent = string | Array<TextBlock | ImageBlock>;

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: MessageContent;
}

/** 单次调用的 token 用量（已归一化：inputTokens 为非缓存输入，cacheRead/cacheWrite 单独计价） */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CompletionOptions {
  system?: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 要求模型只输出 JSON（适配各家的 json mode / 提示约束） */
  json?: boolean;
  /** provider 解析到 usage 后回调（计量用；不设则忽略，不影响调用结果） */
  onUsage?: (usage: Usage) => void;
}

export interface LLMProvider {
  /** 该 provider 的标识，用于日志 */
  readonly id: string;
  /** 是否处于可真实调用状态（有密钥）；否则上层会回退 mock */
  readonly ready: boolean;
  complete(opts: CompletionOptions): Promise<string>;
  /** 流式生成：逐段产出正文/推理增量。可选，不支持时上层回退 complete() */
  stream?(opts: CompletionOptions): AsyncGenerator<StreamDelta, void, unknown>;
}

/** 流式增量：正文与推理分两路（如 DeepSeek-Pro thinking enabled 时的 reasoning_content） */
export interface StreamDelta {
  /** 正文增量 */
  content?: string;
  /** 推理增量 */
  reasoning?: string;
}

/** 从消息内容里抽取纯文本（用于不支持多模态的 provider / mock） */
export function contentToText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
