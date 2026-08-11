import { config } from "@/lib/config";
import { httpFetch } from "@/lib/http";
import {
  contentToText,
  type CompletionOptions,
  type ImageBlock,
  type LLMProvider,
  type MessageContent,
  type StreamDelta,
  type TextBlock,
  type Usage,
} from "./types";

type ThinkingMode = "enabled" | "disabled";
type ReasoningEffort = "high" | "max";

/** OpenAI 兼容端点的 usage 原始结构（DeepSeek 带 prompt_cache_hit_tokens，智谱无） */
interface OaiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
}

type OaiContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
type OaiMessageContent = string | OaiContentBlock[];

function imageDataUrl(block: ImageBlock): string {
  return `data:${block.mediaType};base64,${block.data}`;
}

function toOpenAIContent(content: MessageContent, supportsVision: boolean): OaiMessageContent {
  if (!supportsVision) return contentToText(content);
  if (typeof content === "string") return content;
  return content.map((block: TextBlock | ImageBlock) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : { type: "image_url", image_url: { url: imageDataUrl(block) } }
  );
}

/** 归一化：prompt_tokens 含缓存命中，扣掉得非缓存输入；cacheRead 单独计 */
function reportOaiUsage(req: CompletionOptions, u: OaiUsage | undefined) {
  if (!u || !req.onUsage) return;
  const cacheRead = u.prompt_cache_hit_tokens ?? 0;
  const prompt = u.prompt_tokens ?? 0;
  const usage: Usage = {
    inputTokens: Math.max(0, prompt - cacheRead),
    outputTokens: u.completion_tokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
  };
  req.onUsage(usage);
}

/**
 * OpenAI 风格 /chat/completions 适配器。
 * 智谱 GLM 原生端点 (/api/paas/v4) 与 DeepSeek 原生端点均为该形态，
 * 故用同一实现 + 不同 baseUrl/key/model 参数化。
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;

  constructor(
    private opts: {
      label: string;
      baseUrl: string;
      apiKey: string;
      model: string;
      /** 该端点是否支持 response_format json_object */
      supportsJsonMode?: boolean;
      /** 该模型输出 token 上限（如 DeepSeek 8192），请求超限会被夹紧避免 400 */
      maxOutputTokens?: number;
      /** DeepSeek V4 thinking 开关；不设置则按模型/端点默认行为 */
      thinking?: ThinkingMode;
      /** DeepSeek V4 思考强度，仅 thinking enabled 时使用 */
      reasoningEffort?: ReasoningEffort;
      /** 流式是否带 stream_options.include_usage 取末包 usage（默认 true，DeepSeek/智谱均支持） */
      supportsIncludeUsage?: boolean;
      /** 是否保留图片块并按 OpenAI 视觉格式发送 */
      supportsVision?: boolean;
      /** 某些 OpenAI-compatible 模型不接受 temperature 参数，需完全省略 */
      omitTemperature?: boolean;
    }
  ) {
    this.id = `openai-compatible:${opts.label}`;
  }

  get ready(): boolean {
    return Boolean(this.opts.apiKey);
  }

  /** 组装请求体（complete/stream 共用）；非视觉模型会把多模态块压平为文本 */
  private buildBody(req: CompletionOptions, stream: boolean) {
    const messages: Array<{ role: string; content: OaiMessageContent }> = [];
    const sys = [req.system, req.json && !this.opts.supportsJsonMode ? "只输出合法 JSON，不要任何额外解释或 Markdown 代码块。" : ""]
      .filter(Boolean)
      .join("\n\n");
    if (sys) messages.push({ role: "system", content: sys });
    for (const m of req.messages) {
      if (m.role === "system") continue;
      messages.push({ role: m.role, content: toOpenAIContent(m.content, this.opts.supportsVision === true) });
    }
    const cap = this.opts.maxOutputTokens ?? Infinity;
    const includeUsage = this.opts.supportsIncludeUsage !== false; // 默认 true
    const omitTemperature = this.opts.thinking === "enabled" || this.opts.omitTemperature === true;
    return {
      model: this.opts.model,
      ...(omitTemperature ? {} : { temperature: req.temperature ?? 0.4 }),
      max_tokens: Math.min(req.maxTokens ?? 8192, cap),
      messages,
      ...(this.opts.thinking ? { thinking: { type: this.opts.thinking } } : {}),
      ...(this.opts.reasoningEffort ? { reasoning_effort: this.opts.reasoningEffort } : {}),
      ...(stream ? { stream: true, ...(includeUsage ? { stream_options: { include_usage: true } } : {}) } : {}),
      ...(req.json && this.opts.supportsJsonMode ? { response_format: { type: "json_object" } } : {}),
    };
  }

  async complete(req: CompletionOptions): Promise<string> {
    const res = await httpFetch(`${this.opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify(this.buildBody(req, false)),
    });
    if (!res.ok) {
      throw new Error(`${this.id} (${this.opts.model}) 调用失败: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      choices: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: OaiUsage;
    };
    reportOaiUsage(req, data.usage);
    logFinishReason(this.opts.model, data.choices?.[0]?.finish_reason, data.usage);
    return data.choices?.[0]?.message?.content ?? "";
  }

  /** 流式：正文走 delta.content，推理走 delta.reasoning_content；usage 走末包 j.usage（include_usage） */
  async *stream(req: CompletionOptions): AsyncGenerator<StreamDelta, void, unknown> {
    const res = await httpFetch(`${this.opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify(this.buildBody(req, true)),
    });
    if (!res.ok) {
      throw new Error(`${this.id} (${this.opts.model}) 流式调用失败: ${res.status} ${await res.text()}`);
    }
    const reader = res.body?.getReader();
    if (!reader) {
      // 拿不到流时退回一次性
      const full = await this.complete(req);
      if (full) yield { content: full };
      return;
    }
    const decoder = new TextDecoder();
    let buf = "";
    let finishReason: string | undefined;
    let lastUsage: OaiUsage | undefined;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const payload = s.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          if (j.usage) {
            lastUsage = j.usage as OaiUsage;
            reportOaiUsage(req, j.usage as OaiUsage);
          }
          const choice = j.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const delta = choice?.delta;
          const content = delta?.content;
          const reasoning = delta?.reasoning_content;
          if (content || reasoning) {
            yield { ...(content ? { content } : {}), ...(reasoning ? { reasoning } : {}) };
          }
        } catch {
          /* 不完整的 SSE 行，跳过 */
        }
      }
    }
    logFinishReason(this.opts.model, finishReason, lastUsage);
  }
}

/**
 * 打 finish_reason 日志：默认 info 一行；length 触顶（输出被 max_tokens 截断）升级 warn，
 * 便于发现静默截断（OpenAI 兼容端点 stop 信号在 finish_reason，不读则完全不可见）。
 */
function logFinishReason(model: string, finishReason: string | undefined, usage?: OaiUsage) {
  if (!finishReason) return;
  const tok = usage?.completion_tokens ?? "?";
  if (finishReason === "length") {
    console.warn(`[openai] ${model} finish_reason=${finishReason} output_tokens=${tok} 输出触顶，疑似被截断`);
  } else {
    console.log(`[openai] ${model} finish_reason=${finishReason} output_tokens=${tok}`);
  }
}

export function createZhipuProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    label: "glm",
    baseUrl: config.zhipu.baseUrl,
    apiKey: config.zhipu.apiKey,
    model: config.zhipu.model,
    supportsJsonMode: true,
  });
}

export function createGlmProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    label: "glm",
    baseUrl: config.glm.baseUrl,
    apiKey: config.glm.apiKey,
    model: config.glm.model,
    maxOutputTokens: 128000,
    supportsJsonMode: true,
  });
}

export function createGlm5vProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    label: "glm-5v",
    baseUrl: config.glm5v.baseUrl,
    apiKey: config.glm5v.apiKey,
    model: config.glm5v.model,
    maxOutputTokens: config.glm5v.maxOutputTokens,
    supportsVision: true,
    supportsJsonMode: false,
  });
}

/** flash：deepseek-v4-flash，显式关闭 thinking，保持快速非推理语义 */
export function createDeepSeekProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    label: "deepseek",
    baseUrl: config.deepseek.baseUrl,
    apiKey: config.deepseek.apiKey,
    model: config.deepseek.model,
    supportsJsonMode: true,
    maxOutputTokens: config.deepseek.maxOutputTokens,
    thinking: "disabled",
  });
}

/** pro：deepseek-v4-pro，推理、慢但质量高 */
export function createDeepSeekProProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    label: "deepseek-pro",
    baseUrl: config.deepseek.baseUrl,
    apiKey: config.deepseek.apiKey,
    model: config.deepseek.proModel,
    supportsJsonMode: true,
    maxOutputTokens: config.deepseek.maxOutputTokens,
    thinking: "enabled",
    reasoningEffort: "high",
  });
}
