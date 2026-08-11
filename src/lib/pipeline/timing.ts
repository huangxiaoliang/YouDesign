import { type ModelKey } from "@/lib/config";
import { modelRealName } from "@/lib/providers";
import { recordStageTiming } from "@/lib/meter/stageTiming";
import type { StageTimingInput } from "@/lib/meter/types";

export type TimingBase = Pick<
  StageTimingInput,
  "mode" | "artifact" | "rawHtml" | "hasAttachments" | "hasImages" | "hasDocs" | "fastMode" | "device"
>;

export function timingBase(input: TimingBase, patch: Partial<TimingBase> = {}): TimingBase {
  return { ...input, ...patch };
}

export function recordTiming(
  base: TimingBase,
  stage: string,
  startedAt: number,
  extra: Partial<Pick<StageTimingInput, "model" | "modelKey" | "outcome">> = {}
) {
  recordStageTiming({
    ...base,
    stage,
    durationMs: Date.now() - startedAt,
    ...extra,
  });
}

export async function timed<T>(
  base: TimingBase,
  stage: string,
  fn: () => Promise<T>,
  extra: Partial<Pick<StageTimingInput, "model" | "modelKey">> = {}
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    recordTiming(base, stage, startedAt, { ...extra, outcome: "ok" });
    return result;
  } catch (err) {
    recordTiming(base, stage, startedAt, { ...extra, outcome: "error" });
    throw err;
  }
}

export function modelTiming(modelKey?: ModelKey) {
  return modelKey ? { modelKey, model: modelRealName(modelKey) } : {};
}
