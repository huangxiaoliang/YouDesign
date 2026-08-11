import { AsyncLocalStorage } from "node:async_hooks";

export interface MeterContext {
  userId: string;
  sessionId: string;
}

const als = new AsyncLocalStorage<MeterContext>();

/** 在计量上下文里执行 fn；fn 内的所有 getProviderForStage 调用都会记到该 userId/sessionId */
export function runWithMeter<T>(ctx: MeterContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** 取当前计量上下文（无则 undefined，表示不在生成请求中或未启用计量） */
export function getMeterContext(): MeterContext | undefined {
  return als.getStore();
}
