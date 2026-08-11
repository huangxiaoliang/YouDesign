import type { CompletionOptions, LLMProvider, StreamDelta, Usage } from "@/lib/providers/types";
import { recordUsage } from "./store";

/**
 * 包装真实 provider：每次 complete/stream 调用后，把 provider 解析出的 usage 记一笔。
 * userId/sessionId/model/stage 在构造时固化（来自调用时刻的 meter context）。
 * 流式：内部经 onUsage 捕获 usage、流结束后记一次；不向下游透传 usage（调用点契约不变，仍只收 content/reasoning）。
 */
export class MeteredProvider implements LLMProvider {
  readonly id: string;

  constructor(
    private inner: LLMProvider,
    private meta: { userId: string; sessionId: string; model: string; stage: string }
  ) {
    this.id = `metered:${inner.id}`;
  }

  get ready(): boolean {
    return this.inner.ready;
  }

  async complete(req: CompletionOptions): Promise<string> {
    let captured: Usage | undefined;
    const prev = req.onUsage;
    const wrapped: CompletionOptions = { ...req, onUsage: (u) => { captured = u; prev?.(u); } };
    const text = await this.inner.complete(wrapped);
    if (captured) await this.record(captured);
    return text;
  }

  async *stream(req: CompletionOptions): AsyncGenerator<StreamDelta, void, unknown> {
    let captured: Usage | undefined;
    const prev = req.onUsage;
    const wrapped: CompletionOptions = { ...req, onUsage: (u) => { captured = u; prev?.(u); } };
    if (!this.inner.stream) {
      // 兜底：provider 无 stream 时退回 complete（streamCode 已先判，正常不走到）
      const full = await this.inner.complete(wrapped);
      if (captured) await this.record(captured);
      if (full) yield { content: full };
      return;
    }
    for await (const d of this.inner.stream(wrapped)) {
      yield d; // 只透传 content/reasoning
    }
    if (captured) await this.record(captured);
  }

  private async record(u: Usage): Promise<void> {
    await recordUsage({
      userId: this.meta.userId,
      sessionId: this.meta.sessionId,
      model: this.meta.model,
      stage: this.meta.stage,
      usage: u,
    });
  }
}
