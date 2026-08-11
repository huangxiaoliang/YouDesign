import { httpFetch } from "@/lib/http";
import type { CompletionOptions, LLMProvider, MessageContent, StreamDelta, Usage } from "./types";

/** 把统一内容映射为 Anthropic content 格式（支持图片） */
function toAnthropicContent(content: MessageContent) {
  if (typeof content === "string") return content;
  return content.map((b) =>
    b.type === "text"
      ? { type: "text", text: b.text }
      : { type: "image", source: { type: "base64", media_type: b.mediaType, data: b.data } }
  );
}

/** Anthropic usage 原始结构 */
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** 归一化 Anthropic usage：input_tokens 已是非缓存输入，缓存读/写单独字段 */
function reportUsage(req: CompletionOptions, u: AnthropicUsage | undefined) {
  if (!u || !req.onUsage) return;
  const usage: Usage = {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
  req.onUsage(usage);
}

export interface AnthropicProviderOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 认证方式：x-api-key（官方 Opus/Sonnet）或 bearer（火山方舟 kimi-k3 等 Anthropic 兼容端点） */
  auth: "x-api-key" | "bearer";
  /** 输出 token 上限，请求超限会被夹紧避免 400（Opus/Sonnet 均设 128000） */
  maxOutputTokens?: number;
  /**
   * extended thinking 配置（透传到 Anthropic Messages body 的 thinking 字段）。
   * 某些 Anthropic 格式端点默认开启 thinking 且无预算上限，会挤占 max_tokens 导致长 HTML 截断；
   * 设 {type:"disabled"} 可显式关闭 thinking，把预算让给正文。
   * 不设则按端点默认（Opus/Sonnet 官方端点默认不 think，无需配置）。
   */
  thinking?: { type: "disabled" } | { type: "enabled"; budget_tokens: number };
}

/**
 * Anthropic Messages API 适配器（HTTP 直连，不引第三方 SDK）。
 * 同时服务官方 Opus/Sonnet（x-api-key）与火山方舟 kimi-k3（Anthropic 兼容格式 + Bearer）。
 */
export class AnthropicProvider implements LLMProvider {
  readonly id: string;

  constructor(private opts: AnthropicProviderOptions) {
    this.id = opts.id;
  }

  get ready(): boolean {
    return Boolean(this.opts.apiKey);
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.opts.auth === "bearer") headers["authorization"] = `Bearer ${this.opts.apiKey}`;
    else headers["x-api-key"] = this.opts.apiKey;
    return headers;
  }

  /** 组装请求体（complete/stream 共用）；注意：部分新模型（如 Opus 4.8）已废弃 temperature，统一不传 */
  private buildBody(req: CompletionOptions, stream: boolean) {
    const system = [req.system, req.json ? "只输出合法 JSON，不要任何额外解释或 Markdown 代码块。" : ""]
      .filter(Boolean)
      .join("\n\n");
    return {
      model: this.opts.model,
      max_tokens: Math.min(req.maxTokens ?? 8192, this.opts.maxOutputTokens ?? Infinity),
      system: system || undefined,
      messages: req.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: toAnthropicContent(m.content) })),
      ...(this.opts.thinking ? { thinking: this.opts.thinking } : {}),
      ...(stream ? { stream: true } : {}),
    };
  }

  async complete(req: CompletionOptions): Promise<string> {
    const res = await httpFetch(`${this.opts.baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(this.buildBody(req, false)),
    });

    if (!res.ok) {
      throw new Error(`${this.id} (${this.opts.model}) 调用失败: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage?: AnthropicUsage;
      stop_reason?: string;
    };
    reportUsage(req, data.usage);
    logStopReason(this.opts.model, data.stop_reason, data.usage?.output_tokens);
    return data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }

  /**
   * 流式：解析 Anthropic SSE。正文走 content_block_delta.text_delta，
   * 推理走 content_block_delta.thinking_delta（extended thinking 模型）。
   * usage：message_start 带 input/cache_read/cache_creation，message_delta 带 output 与 stop_reason；流末尾合并回调一次。
   * 流式让前端 generate 阶段持续收到 code-delta，避免长连接因长时间无数据被中间层切断。
   */
  async *stream(req: CompletionOptions): AsyncGenerator<StreamDelta, void, unknown> {
    const res = await httpFetch(`${this.opts.baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.authHeaders(),
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
    const u: AnthropicUsage = {};
    let hasUsage = false;
    let stopReason: string | undefined;
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
        if (!payload || payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          if (j.type === "message_start" && j.message?.usage) {
            u.input_tokens = j.message.usage.input_tokens;
            u.cache_read_input_tokens = j.message.usage.cache_read_input_tokens;
            u.cache_creation_input_tokens = j.message.usage.cache_creation_input_tokens;
            hasUsage = true;
          } else if (j.type === "message_delta" && j.usage) {
            u.output_tokens = j.usage.output_tokens;
            hasUsage = true;
            if (j.delta?.stop_reason) stopReason = j.delta.stop_reason;
          } else if (j.type === "content_block_delta") {
            const d = j.delta;
            if (d?.type === "text_delta" && d.text) yield { content: d.text };
            else if (d?.type === "thinking_delta" && d.thinking) yield { reasoning: d.thinking };
          }
        } catch {
          /* 不完整的 SSE 行，跳过 */
        }
      }
    }
    if (hasUsage) reportUsage(req, u);
    logStopReason(this.opts.model, stopReason, u.output_tokens);
  }
}

/**
 * 打 stop_reason 日志：默认 info 一行；max_tokens 触顶（输出被截断）升级 warn，
 * 便于发现「输出 token 没顶到 cap 但 stop_reason=max_tokens」这类静默截断。
 */
function logStopReason(model: string, stopReason: string | undefined, outputTokens?: number) {
  if (!stopReason) return;
  const tok = outputTokens ?? "?";
  if (stopReason === "max_tokens") {
    console.warn(`[anthropic] ${model} stop_reason=${stopReason} output_tokens=${tok} 输出触顶，疑似被截断`);
  } else {
    console.log(`[anthropic] ${model} stop_reason=${stopReason} output_tokens=${tok}`);
  }
}
