import { NextRequest } from "next/server";
import { runPipeline, type GenerateInput } from "@/lib/pipeline/orchestrator";
import { config, modelHasCredentials } from "@/lib/config";
import type { ModelPreference } from "@/lib/types";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { runWithMeter } from "@/lib/meter/context";
import { randomUUID } from "node:crypto";
import { sanitizeSessionBrief, sanitizeSessionTurns } from "@/lib/pipeline/sessionBrief";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseTextModelPreference(value: unknown): ModelPreference {
  return value === "kimiK3" || value === "deepseek" || value === "glm" || value === "sonnet" || value === "opus" ? value : "auto";
}

function parseVisionModelPreference(value: unknown): ModelPreference {
  return value === "sonnet" || value === "opus" || value === "glm5v" || value === "kimiK3" ? value : "glm5v";
}

function visionModelKey(preference: ModelPreference) {
  if (preference === "sonnet") return "sonnet";
  if (preference === "opus") return "opus";
  if (preference === "glm5v") return "glm5v";
  return "kimiK3";
}

/** POST /api/generate — 以 NDJSON 流式返回编排过程事件 */
export async function POST(req: NextRequest) {
  let input: GenerateInput;
  try {
    const body = await req.json();
    const hasAttachments =
      (body?.attachments?.images?.length ?? 0) > 0 ||
      (body?.attachments?.documents?.length ?? 0) > 0;
    const hasImages = (body?.attachments?.images?.length ?? 0) > 0;
    const modelPreference = hasImages
      ? parseVisionModelPreference(body?.modelPreference)
      : parseTextModelPreference(body?.modelPreference);
    if ((!body?.requirement || typeof body.requirement !== "string") && !hasAttachments) {
      return new Response(JSON.stringify({ error: "缺少 requirement 或上传内容" }), { status: 400 });
    }
    if (!hasImages && modelPreference !== "auto" && config.forceMock) {
      return new Response(JSON.stringify({ error: "当前处于 mock 模式，不能手动指定模型" }), { status: 400 });
    }
    if (hasImages && !config.forceMock) {
      const key = visionModelKey(modelPreference);
      if (!modelHasCredentials(key)) {
        const label = key === "glm5v" ? "glm-5v-turbo" : key === "kimiK3" ? "Kimi K3" : key === "opus" ? "Opus" : "Sonnet";
        return new Response(JSON.stringify({ error: `${label} 未配置 API Key，无法处理图片` }), { status: 400 });
      }
    }
    if (modelPreference === "glm" && !modelHasCredentials("glm")) {
      return new Response(JSON.stringify({ error: "GLM-5.2 未配置 API Key，无法使用该模型" }), { status: 400 });
    }
    if (modelPreference === "kimiK3" && !modelHasCredentials("kimiK3")) {
      return new Response(JSON.stringify({ error: "Kimi K3 未配置 API Key，无法使用该模型" }), { status: 400 });
    }
    if (modelPreference === "sonnet" && !modelHasCredentials("sonnet")) {
      return new Response(JSON.stringify({ error: "Sonnet 未配置 API Key，无法使用该模型" }), { status: 400 });
    }
    if (modelPreference === "opus" && !modelHasCredentials("opus")) {
      return new Response(JSON.stringify({ error: "Opus 未配置 API Key，无法使用该模型" }), { status: 400 });
    }
    if (modelPreference === "deepseek" && (!modelHasCredentials("deepseek") || !modelHasCredentials("deepseekPro"))) {
      return new Response(JSON.stringify({ error: "DeepSeek 未配置完整 API Key，无法使用该模型" }), { status: 400 });
    }
    const hasHtmlUpload = (body?.attachments?.documents ?? []).some((doc: unknown) => {
      return !!doc && typeof doc === "object" && "kind" in doc && doc.kind === "html";
    });
    const rawHtml = body.rawHtml === true || hasHtmlUpload;
    const previousRaw =
      body.previous && body.previous.rawHtml
        ? { ...body.previous, styleProfileId: body.previous.rawHtmlEditSource === "annotation" ? body.previous.styleProfileId : undefined }
        : body.previous;
    const previous = previousRaw
      ? { ...previousRaw, sessionBrief: sanitizeSessionBrief(previousRaw.sessionBrief) }
      : undefined;
    input = {
      requirement: typeof body.requirement === "string" ? body.requirement : "",
      mode: body.mode === "edit" ? "edit" : "generate",
      allowClarify: body.allowClarify !== false, // 默认允许需求澄清
      rawHtml, // HTML/ZIP 上传由后端意图识别决定原样打开/修改/参考重生成
      styleProfileId: typeof body.styleProfileId === "string" ? body.styleProfileId : undefined,
      attachments: body.attachments,
      modelPreference,
      previous,
      recentTurns: sanitizeSessionTurns(body.recentTurns),
      fastMode: body.fastMode !== false, // 默认快速：generate/结构化走 flash、跳过 review/refine
    };
  } catch {
    return new Response(JSON.stringify({ error: "请求体不是合法 JSON" }), { status: 400 });
  }

  const session = await verifySession(req.cookies.get(SESSION_COOKIE_NAME)?.value, config.auth.secret);
  if (!session) return new Response(JSON.stringify({ error: "未登录" }), { status: 401 });
  const userId = session.userId;
  const sessionId = randomUUID();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        await runWithMeter({ userId, sessionId }, async () => {
          for await (const event of runPipeline(input)) {
            // 客户端取消（关闭/点停止）后停止后续阶段，不再浪费算力
            if (req.signal?.aborted) break;
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          }
        });
      } catch (err) {
        if (!req.signal?.aborted) {
          const message = err instanceof Error ? err.message : String(err);
          try {
            controller.enqueue(encoder.encode(JSON.stringify({ type: "error", message }) + "\n"));
          } catch {
            /* 流已关 */
          }
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* 已关 */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}
