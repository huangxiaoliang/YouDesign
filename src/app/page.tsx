"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PreviewPane } from "@/components/PreviewPane";
import { HistoryDrawer } from "@/components/HistoryDrawer";
import {
  MODEL_PREFERENCE_OPTIONS,
  ModelPreferencePicker,
  MsgContent,
  StyleProfilePicker,
  VISION_MODEL_PREFERENCE_OPTIONS,
} from "@/components/PrototypeControls";
import { STYLE_PROFILE_OPTIONS } from "@/lib/style/profiles";
import { withBase } from "@/lib/basePath";
import { useTheme } from "@/lib/theme/ThemeContext";
import {
  deriveTitle,
  getLastActiveId,
  listSummaries,
  loadSession,
  newSessionId,
  removeSession,
  renameSession,
  saveSession,
  saveSessionPreviewSettings,
  setLastActiveId,
  type SessionSummary,
} from "@/lib/store/sessions";
import type {
  ChatMessage,
  FlowSpec,
  GenerationResult,
  MobilePreviewShell,
  ModelPreference,
  PipelineEvent,
  RetrievedComponent,
  RawHtmlAsset,
  RawHtmlState,
  UploadedDoc,
  AttachmentFileKind,
  ChatAttachment,
  ClaudeEditFocus,
  ClaudeProgressEvent,
  PrototypeContract,
  PreviewDeviceMode,
  SessionContextTurn,
  UploadedImage,
  RequirementCardSet,
} from "@/lib/types";
import {
  MAX_UPLOAD_MB,
  MAX_UPLOAD_BYTES,
  MAX_ZIP_UPLOAD_MB,
  MAX_ZIP_UPLOAD_BYTES,
  STAGE_LABELS,
  readDoc,
  downscaleImage,
  assistantSummary,
} from "./home-helpers";
import {
  delay,
  fileKindFromName,
  formatByteSize,
  isAbortError,
  progressHintForStep,
  runningTaskLabelFor,
} from "./page-utils";
import {
  DESKTOP_CLAUDE_PROTOCOL_VERSION,
  desktopClaudeCompatibilityError,
  formatDesktopClaudeFailure,
  hasDesktopClaudeBridge,
  hasDesktopClaudeCancelBridge,
  hasDesktopClaudeLogBridge,
  hasDesktopClaudeStatusBridge,
  openClaudeLog,
  sha256Text,
} from "./desktop-claude";
import {
  advanceSessionBriefV1,
  buildRecentSessionTurns,
  createSessionBriefV1,
  hasMeaningfulSessionArtifactChange,
  mergeRecentSessionTurns,
  messagesForSessionVersion,
  moveSessionBriefToVersion,
  sanitizeSessionBrief,
} from "@/lib/pipeline/sessionBrief";
import { removeTemporaryAnchors } from "@/lib/pipeline/htmlScopePatch";
import { carryOverRequirementCardSet, inheritRequirementCardSet } from "@/lib/requirementCardUtils";
import { buildCapturedPageAttachment, type CaptureMeta } from "@/lib/capturedPage";

declare global {
  interface Window {
    youdesignDesktop?: {
      openConfigFolder(): Promise<{ ok: boolean }>;
      openAttachment?(payload: {
        name: string;
        kind: AttachmentFileKind;
        mime?: string;
        bytes?: ArrayBuffer;
        previewHtml?: string;
        captureMeta?: CaptureMeta;
      }): Promise<{ ok: boolean; action?: "open" | "reveal"; path?: string }>;
      getClaudeStatus?(): Promise<DesktopClaudeStatus>;
      sha256Text?(value: string): string | Promise<string>;
      runClaudeHtmlEdit?(payload: {
        bridgeProtocolVersion: number;
        jobId: string;
        html?: string;
        htmlSha256?: string;
        editHtml?: string;
        assets?: RawHtmlAsset[];
        instruction: string;
        device?: "pc" | "mobile";
        styleProfileId?: string;
        interactiveEdit?: boolean;
        focus?: ClaudeEditFocus;
        prototypeContract?: PrototypeContract;
        sessionContext?: string;
        progressId?: string;
      }): Promise<
        | {
            ok: true;
            html: string;
            rawHtmlState?: RawHtmlState;
            summary?: string;
            diffStats?: { changedLines: number; added: number; removed: number };
            rawLogPath?: string;
          }
        | {
            ok: false;
            needsClarification: true;
            clarification: string;
            summary?: string;
            rawLogPath?: string;
          }
        | {
            ok: false;
            alreadySatisfied: true;
            message: string;
            summary?: string;
            rawLogPath?: string;
          }
      >;
      cancelClaudeHtmlEdit?(jobId: string): Promise<{
        ok: boolean;
        cancelled?: boolean;
        state?: string;
        jobId?: string;
        running?: boolean;
        queueSize?: number;
        activeCommands?: number;
      }>;
      openClaudeLog?(rawLogPath: string): Promise<{ ok: boolean }>;
      onClaudeProgress?(callback: (payload: (ClaudeProgressEvent & { progressId?: string })) => void): () => void;
      onCaptureImport?(callback: (payload: ChromeCapturePayload) => void): () => void;
    };
    __youdesignCaptureReady?: boolean;
  }
}

interface DesktopClaudeStatus {
  protocolVersion?: number;
  capabilities?: string[];
  available: boolean;
  cliPath?: string;
  authOk: boolean;
  gatewayOk?: boolean;
  gatewayPort?: number;
  maxHtmlBytes: number;
  maxTurns: number;
  maxBudgetUsd: number;
  busy: boolean;
  running?: boolean;
  queueSize?: number;
  lastCheckedAt: number;
  reason?: "not_installed" | "not_logged_in" | "gateway_unavailable" | "timeout" | "unknown";
  message: string;
}

interface StepState {
  id: string;
  stage: string;
  status: "start" | "done";
  detail?: string;
}

type StepEvent = Extract<PipelineEvent, { type: "step" }>;
type DesktopClaudeRequest = Extract<PipelineEvent, { type: "desktop-claude-required" }>;

const GENERATE_RETRY_COUNT = 2;
const GENERATE_RETRY_DELAY_MS = 500;
const MAX_ATTACHMENTS = 4;
const CAPTURE_IMPORT_NOTICE_MS = 4_000;
const LAYOUT_MODE_KEY = "yd_layout_mode";
const CLAUDE_PHASE_LABELS: Record<ClaudeProgressEvent["phase"], string> = {
  queued: "排队",
  preparing: "准备",
  "auth-check": "鉴权",
  running: "运行",
  thinking: "分析",
  tool: "定位",
  editing: "编辑",
  validating: "校验",
  done: "完成",
  failed: "失败",
  cancelled: "取消",
};

class PipelineEventError extends Error {}
class HttpResponseError extends Error {}

function formatElapsed(ms?: number) {
  if (ms === undefined || ms < 0) return "";
  return `${Math.floor(ms / 1000)}s`;
}

function isClaudeTerminalPhase(phase: ClaudeProgressEvent["phase"]) {
  return phase === "done" || phase === "failed" || phase === "cancelled";
}

function mergeClaudeToolNames(a?: string, b?: string) {
  const names = [...(a ?? "").split("/"), ...(b ?? "").split("/")]
    .map((name) => name.trim())
    .filter(Boolean);
  return Array.from(new Set(names)).join("/");
}

function mergeClaudeProgressEvent(prev: ClaudeProgressEvent[], progress: ClaudeProgressEvent) {
  const last = prev[prev.length - 1];
  if (!last) return [progress];
  if (last.phase === progress.phase && (progress.phase === "tool" || progress.phase === "editing")) {
    return [
      ...prev.slice(0, -1),
      {
        ...last,
        ...progress,
        toolName: mergeClaudeToolNames(last.toolName, progress.toolName) || progress.toolName || last.toolName,
      },
    ];
  }
  return [...prev, progress].slice(-12);
}

/** 附件图标（按原始文件类型） */
const ATTACH_ICON: Record<AttachmentFileKind, string> = {
  image: "🖼",
  zip: "📦",
  html: "🌐",
  word: "📘",
  markdown: "📝",
  text: "📄",
};

function hasDesktopAttachmentBridge(): boolean {
  return typeof window !== "undefined" && typeof window.youdesignDesktop?.openAttachment === "function";
}

/** 点击附件：Web 端走 blob:；桌面端交给 Electron 保存到受控临时目录后打开/定位。 */
async function openAttachment(att: ChatAttachment) {
  const previewHtml = att.kind === "html" ? buildCapturedPageAttachment(att.previewContent || (await att.originalBlob.text()), att.captureMeta) : undefined;
  if (hasDesktopAttachmentBridge()) {
    try {
      const bytes = previewHtml === undefined ? await att.originalBlob.arrayBuffer() : undefined;
      await window.youdesignDesktop!.openAttachment!({
        name: att.name,
        kind: att.kind,
        mime: att.originalBlob.type || undefined,
        bytes,
        previewHtml,
        captureMeta: att.captureMeta,
      });
      return;
    } catch (err) {
      alert(`打开附件失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }

  const blob = previewHtml === undefined ? att.originalBlob : new Blob([previewHtml], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  if (att.kind === "word" || att.kind === "zip") {
    a.download = att.name;
  } else {
    a.target = "_blank";
  }
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 给新标签加载留时间，60s 后回收避免泄漏
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

type LayoutMode = "two" | "three";

interface ChromeCapturePayload {
  html: string;
  title?: string;
  url?: string;
  capturedAt?: string;
  captureMeta?: CaptureMeta;
}

interface ChromeCaptureMessage {
  source?: string;
  type?: string;
  requestId?: string;
  payload?: ChromeCapturePayload;
}

interface SendOverrides {
  images?: UploadedImage[];
  docs?: UploadedDoc[];
  forceGenerate?: boolean;
}

function readStoredLayoutMode(): LayoutMode {
  try {
    return window.localStorage.getItem(LAYOUT_MODE_KEY) === "three" ? "three" : "two";
  } catch {
    return "two";
  }
}

export default function Home() {
  const { theme } = useTheme();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [reasoningChars, setReasoningChars] = useState(0); // 思考中累计字数（reasoning-delta）
  const [reasoningActive, setReasoningActive] = useState(false); // 正在流推理（content 一开始就关闭）
  const [generatedCodeBytes, setGeneratedCodeBytes] = useState(0);
  const [runningTaskLabel, setRunningTaskLabel] = useState("生成原型中");
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [liveCode, setLiveCode] = useState("");
  const [input, setInput] = useState("");
  const [captureImportNotice, setCaptureImportNotice] = useState<{ text: string } | null>(null);
  // 编辑态上传了 HTML 但指令非合并：提示用户 HTML 仅合并场景生效，且不转发该 HTML。
  const [editUploadNotice, setEditUploadNotice] = useState<string | null>(null);
  // 输入框历史导航：inputHistory 随会话持久化（上下箭头回溯）；histNavIdx=null 表示未在浏览
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [histNavIdx, setHistNavIdx] = useState<number | null>(null);
  // 当前会话的手动标题（null=未手动改，用 deriveTitle 自动推导）；随会话持久化
  const [customTitle, setCustomTitle] = useState<string | null>(null);
  // 导出/分享时的文件名（null=未手动改，用 flow.title 默认）；随会话持久化，不影响会话标题
  const [exportTitle, setExportTitle] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingHint, setLoadingHint] = useState(""); // 首次生成时预览骨架文案：模式+预估时长；原样打开显示"正在打开页面…"
  const [styleProfileId, setStyleProfileId] = useState("");
  const [modelPreference, setModelPreference] = useState<ModelPreference>("auto");
  const [fastMode, setFastMode] = useState(true); // 快速模式（默认开）：generate/结构化走 flash、跳过 review/refine；仅首轮生效
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [docs, setDocs] = useState<UploadedDoc[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(true);
  const [claudeProgress, setClaudeProgress] = useState<ClaudeProgressEvent[]>([]);
  const [claudeNow, setClaudeNow] = useState(0);
  const [pendingRequirement, setPendingRequirement] = useState<string | null>(null);
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [previewDeviceMode, setPreviewDeviceMode] = useState<PreviewDeviceMode>("auto");
  const previewDeviceModeRef = useRef<PreviewDeviceMode>("auto");
  const [mobilePreviewShell, setMobilePreviewShell] = useState<MobilePreviewShell>("wecom");
  const mobilePreviewShellRef = useRef<MobilePreviewShell>("wecom");
  const [requirementCardsOpen, setRequirementCardsOpen] = useState(false);
  // 版本历史（每次成功 done 入栈，可撤销/重做回退到任一版本）
  const [history, setHistory] = useState<GenerationResult[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [userName, setUserName] = useState(""); // 当前登录用户名（顶栏显示，从 /api/me 取）
  const messagesRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null); // 取消生成
  const stepSeqRef = useRef(0);
  const draftInputRef = useRef(""); // 开始历史浏览时保存的输入草稿
  const inputRef = useRef<HTMLTextAreaElement>(null); // 输入框 DOM，用于导航后定位光标
  const cursorAnchorRef = useRef<"start" | "end" | null>(null); // 历史导航后的光标意图
  const desktopClaudeActiveRef = useRef(false); // 取消桌面 Claude Code 增强
  const desktopClaudeJobIdRef = useRef<string | null>(null);
  const desktopClaudeCancelLocalRef = useRef<(() => void) | null>(null);
  const claudeStartedAtRef = useRef<number | null>(null);
  const dragDepthRef = useRef(0);

  function nextStepId(stage: string) {
    stepSeqRef.current += 1;
    return `${stage}-${stepSeqRef.current}`;
  }

  function pushStep(stage: string, status: StepState["status"], detail?: string) {
    setSteps((prev) => {
      if (status === "start") {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i -= 1) {
          if (next[i].status === "start") {
            next[i] = { ...next[i], status: "done" };
            break;
          }
        }
        return [...next, { id: nextStepId(stage), stage, status, detail }];
      }
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i -= 1) {
        if (next[i].stage === stage && next[i].status === "start") {
          next[i] = { ...next[i], status, detail };
          return next;
        }
      }
      return [...next, { id: nextStepId(stage), stage, status, detail }];
    });
  }

  function setDesktopClaudeStep(status: StepState["status"], detail?: string) {
    setSteps((prev) => {
      const existingIndex = prev.findIndex((step) => step.stage === "desktop-claude");
      if (existingIndex >= 0) {
        const next = [...prev];
        next[existingIndex] = { ...next[existingIndex], status, detail };
        return next;
      }
      const next = [...prev];
      if (status === "start") {
        for (let i = next.length - 1; i >= 0; i -= 1) {
          if (next[i].status === "start") {
            next[i] = { ...next[i], status: "done" };
            break;
          }
        }
      }
      return [...next, { id: nextStepId("desktop-claude"), stage: "desktop-claude", status, detail }];
    });
  }

  function pushPipelineStep(ev: StepEvent) {
    pushStep(ev.stage, ev.status, ev.detail);
  }

  function pushClaudeProgress(progress: ClaudeProgressEvent) {
    if (claudeStartedAtRef.current === null) {
      claudeStartedAtRef.current = Date.now() - (progress.elapsedMs ?? 0);
    }
    setRunningTaskLabel("增强处理大页面中");
    setClaudeNow(Date.now());
    setDesktopClaudeStep(isClaudeTerminalPhase(progress.phase) ? "done" : "start", progress.message);
    setClaudeProgress((prev) => mergeClaudeProgressEvent(prev, progress));
  }

  // 持久化：当前会话 id、历史摘要、抽屉开关
  const [sessionId, setSessionId] = useState<string>("");
  const [summaries, setSummaries] = useState<SessionSummary[]>([]);
  const [histOpen, setHistOpen] = useState(false);
  // 首屏始终使用固定值；浏览器偏好和实际视口在 hydration 后恢复。
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("two");
  const [viewportWidth, setViewportWidth] = useState(1440);
  const [hydrated, setHydrated] = useState(false);
  const [pendingChromeCapture, setPendingChromeCapture] = useState<ChromeCaptureMessage | null>(null);
  const hydratedRef = useRef(false); // 初次恢复完成前不触发自动保存
  const createdAtRef = useRef<number>(0); // 当前会话创建时间
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 登录页跳转过来前会写入 yd_fresh_login 标记，表示"刚登录、开新会话"。
  // 必须在 render 期一次性读出并清除（用 ref 缓存），否则 React StrictMode（Next dev 默认开启）
  // 会双调挂载 effect：第一次读走标记开了新会话，cleanup 把 alive 置 false 后第二次看不到标记，
  // 转去恢复上次会话并覆盖——最终登录后开新会话失效（dev 下表现为登录后恢复了上次会话）。
  const freshLoginRef = useRef<boolean | null>(null);
  if (freshLoginRef.current === null) {
    const v = typeof sessionStorage !== "undefined" ? sessionStorage.getItem("yd_fresh_login") : null;
    if (v) sessionStorage.removeItem("yd_fresh_login");
    freshLoginRef.current = !!v;
  }
  const canUseThreeColumn = viewportWidth >= 1280;
  const effectiveLayoutMode: LayoutMode = layoutMode === "three" && canUseThreeColumn ? "three" : "two";

  useEffect(() => {
    setLayoutMode(readStoredLayoutMode());
  }, []);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const latest = claudeProgress[claudeProgress.length - 1];
    if (!latest || isClaudeTerminalPhase(latest.phase)) return;
    const timer = window.setInterval(() => setClaudeNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [claudeProgress]);

  useEffect(() => {
    if (loading || result) resetFileDrag();
  }, [loading, result]);

  // 生成流与桌面 Claude 增强都处在 loading 生命周期内；离开页面会中断任务。
  useEffect(() => {
    if (!loading) return;
    const confirmLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", confirmLeave);
    return () => window.removeEventListener("beforeunload", confirmLeave);
  }, [loading]);

  // 取当前登录用户名（顶栏显示）。未登录则忽略（middleware 会跳登录页）
  useEffect(() => {
    fetch(withBase("/api/me"))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d.name === "string") setUserName(d.name);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_MODE_KEY, layoutMode);
    } catch {
      /* localStorage 不可用时只保留本次状态 */
    }
  }, [layoutMode]);

  const refreshSummaries = useCallback(async () => {
    try {
      setSummaries(await listSummaries());
    } catch {
      /* 存储不可用时忽略 */
    }
  }, []);

  // 把一条会话记录的内容灌回界面状态
  const applySession = useCallback(
    (rec: Awaited<ReturnType<typeof loadSession>>) => {
      if (!rec) return;
      setSessionId(rec.id);
      createdAtRef.current = rec.createdAt;
      loadedAtRef.current = rec.updatedAt; // 记住原始 updatedAt，切换后首次保存不改排序
      setMessages(rec.messages);
      setResult(rec.result);
      setHistory(rec.history);
      setHistIdx(rec.histIdx);
      setStyleProfileId(rec.styleProfileId);
      setModelPreference(rec.modelPreference ?? "auto");
      setFastMode(rec.fastMode ?? true);
      const restoredPreviewDeviceMode = rec.previewDeviceMode ?? "auto";
      previewDeviceModeRef.current = restoredPreviewDeviceMode;
      setPreviewDeviceMode(restoredPreviewDeviceMode);
      const restoredMobilePreviewShell = rec.mobilePreviewShell ?? "wecom";
      mobilePreviewShellRef.current = restoredMobilePreviewShell;
      setMobilePreviewShell(restoredMobilePreviewShell);
      setRequirementCardsOpen(rec.requirementCardsOpen ?? false);
      setLiveCode(rec.result?.code ?? "");
      setPendingRequirement(null);
      setCaptureImportNotice(null);
      setInput("");
      setInputHistory(rec.inputHistory ?? []);
      setHistNavIdx(null);
      draftInputRef.current = "";
      setCustomTitle(rec.customTitle ?? null);
      setExportTitle(rec.exportTitle ?? null);
      setImages([]);
      setDocs([]);
      setTab("preview");
    },
    []
  );

  // 挂载时恢复上次会话；没有则起一个新会话。
  // 例外：刚登录跳转过来时（freshLoginRef 已消费 yd_fresh_login 标记）不恢复，直接开新会话；刷新则正常恢复。
  useEffect(() => {
    let alive = true;
    // 标记已在 render 期由 freshLoginRef 一次性读出并清除，这里取缓存值，
    // 保证 StrictMode 双调 effect 时两次取到一致结果（详见 freshLoginRef 注释）。
    const freshLogin = freshLoginRef.current;
    (async () => {
      try {
        if (!freshLogin) {
          const lastId = await getLastActiveId();
          const rec = lastId ? await loadSession(lastId) : undefined;
          if (alive && rec) {
            applySession(rec);
          } else if (alive) {
            setSessionId(newSessionId());
            createdAtRef.current = Date.now();
          }
        } else if (alive) {
          setSessionId(newSessionId());
          createdAtRef.current = Date.now();
        }
        if (alive) await refreshSummaries();
      } catch {
        if (alive) {
          setSessionId(newSessionId());
          createdAtRef.current = Date.now();
        }
      } finally {
        if (alive) {
          hydratedRef.current = true;
          setHydrated(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [applySession, refreshSummaries]);

  const buildChromeCaptureDoc = useCallback(
    (payload: ChromeCapturePayload): UploadedDoc | null => {
      if (loading) {
        setMessages((m) => [...m, { role: "assistant", content: "当前正在生成/修改，请稍后再导入 Chrome 页面。" }]);
        return null;
      }
      const html = typeof payload.html === "string" ? payload.html : "";
      if (!html.trim()) {
        setMessages((m) => [...m, { role: "assistant", content: "Chrome 扩展没有采集到可用 HTML。" }]);
        return null;
      }
      const bytes = new TextEncoder().encode(html).length;
      if (bytes > MAX_UPLOAD_BYTES) {
        setMessages((m) => [
          ...m,
          { role: "assistant", content: `采集页面超过 ${MAX_UPLOAD_MB}MB 上限（${(bytes / 1024 / 1024).toFixed(1)}MB），请缩小页面范围或后续使用增强采集。` },
        ]);
        return null;
      }
      let host = "";
      try {
        host = payload.url ? new URL(payload.url).hostname : "";
      } catch {
        host = "";
      }
      const title = (payload.title || host || "captured-page")
        .replace(/[\\/:*?"<>|]+/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      const name = `${title || "captured-page"}.html`;
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      return { name, kind: "html", content: html, originalBlob: blob, captureMeta: payload.captureMeta };
    },
    [loading]
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent<ChromeCaptureMessage>) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (data?.source !== "youdesign-capture-extension" || data.type !== "YD_CAPTURE_IMPORT") return;
      setPendingChromeCapture(data);
    };
    window.__youdesignCaptureReady = true;
    window.addEventListener("message", onMessage);
    return () => {
      window.__youdesignCaptureReady = false;
      window.removeEventListener("message", onMessage);
    };
  }, []);

  useEffect(() => {
    if (typeof window.youdesignDesktop?.onCaptureImport !== "function") return;
    return window.youdesignDesktop.onCaptureImport((payload) => {
      setPendingChromeCapture({
        source: "youdesign-desktop",
        type: "YD_CAPTURE_IMPORT",
        requestId: `desktop-${Date.now()}`,
        payload,
      });
    });
  }, []);

  useEffect(() => {
    if (!hydrated || !pendingChromeCapture) return;
    const doc = pendingChromeCapture.payload ? buildChromeCaptureDoc(pendingChromeCapture.payload) : null;
    const ok = Boolean(doc);
    window.postMessage(
      {
        source: "youdesign-app",
        type: "YD_CAPTURE_IMPORT_ACK",
        requestId: pendingChromeCapture.requestId,
        ok,
      },
      window.location.origin
    );
    setPendingChromeCapture(null);
    if (!doc) return;
    newSession();
    setDocs([doc]);
    setImages([]);
    setInput("");
    setTab("preview");
    setCaptureImportNotice({ text: "页面已添加到对话框，请开始修改" });
    // 抓取结果只作为附件留在新会话中；由用户补充需求后主动发送，避免扩展导入即触发生成。
  }, [buildChromeCaptureDoc, hydrated, pendingChromeCapture]);

  useEffect(() => {
    if (!captureImportNotice) return;
    const timer = window.setTimeout(() => setCaptureImportNotice(null), CAPTURE_IMPORT_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [captureImportNotice]);

  // editUploadNotice（非合并阻断提示）不自动消失：用户需据此改指令或删 HTML，
  // 改指令/删 chip 后重新发送时在 send() 里 setEditUploadNotice(null) 清掉。

  // 自动保存（防抖）：内容变化即落盘，刷新可恢复
  // 切换会话时保留原始 updatedAt（不置顶），仅在内容真正变化后才更新 updatedAt
  const lastSavedDigestRef = useRef<string>("");
  const loadedAtRef = useRef<number>(0); // 加载会话时的原始 updatedAt
  const hasContentChangeRef = useRef(false); // 加载后用户是否真正修改了内容
  useEffect(() => {
    if (!hydratedRef.current || !sessionId) return;
    if (messages.length === 0 && !result) return; // 空会话不存
    // 用摘要判断内容是否真正变化
    const digest = `${sessionId}:${messages.length}:${result ? "1" : "0"}:${result?.requirementCardSet?.updatedAt ?? ""}:${history.length}:${histIdx}:${styleProfileId}:${modelPreference}:${fastMode}:${customTitle ?? ""}:${exportTitle ?? ""}:${requirementCardsOpen}`;
    if (digest === lastSavedDigestRef.current) return;
    // 首次变化：如果是刚切换过来（digest 不同但还没有用户编辑），只保存原始时间不置顶
    const isFirstChange = lastSavedDigestRef.current === "" || !lastSavedDigestRef.current.startsWith(sessionId);
    lastSavedDigestRef.current = digest;
    if (isFirstChange) {
      // 切换过来的首次保存：用原始 updatedAt，不更新排序
      hasContentChangeRef.current = false;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        const rec = {
          id: sessionId,
          title: customTitle ?? deriveTitle(messages, result),
          createdAt: createdAtRef.current || loadedAtRef.current,
          updatedAt: loadedAtRef.current || Date.now(),
          messages,
          result,
          history,
          histIdx,
          styleProfileId,
          modelPreference,
          fastMode,
          previewDeviceMode: previewDeviceModeRef.current,
          mobilePreviewShell: mobilePreviewShellRef.current,
          requirementCardsOpen,
          inputHistory,
          customTitle: customTitle ?? undefined,
          exportTitle: exportTitle ?? undefined,
        };
        saveSession(rec)
          .then(() => setLastActiveId(sessionId))
          .then(refreshSummaries)
          .catch(() => {});
      }, 500);
      return;
    }
    // 后续变化：用户真正编辑了内容，用当前时间更新 updatedAt
    hasContentChangeRef.current = true;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const now = Date.now();
      const rec = {
        id: sessionId,
        title: customTitle ?? deriveTitle(messages, result),
        createdAt: createdAtRef.current || now,
        updatedAt: now,
        messages,
        result,
        history,
        histIdx,
        styleProfileId,
        modelPreference,
        fastMode,
        previewDeviceMode: previewDeviceModeRef.current,
        mobilePreviewShell: mobilePreviewShellRef.current,
        requirementCardsOpen,
        inputHistory,
        customTitle: customTitle ?? undefined,
        exportTitle: exportTitle ?? undefined,
      };
      saveSession(rec)
        .then(() => setLastActiveId(sessionId))
        .then(refreshSummaries)
        .catch(() => {
          /* 存储失败降级为纯内存，不打断使用 */
        });
    }, 500);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [messages, result, history, histIdx, styleProfileId, modelPreference, fastMode, inputHistory, customTitle, exportTitle, sessionId, refreshSummaries, requirementCardsOpen]);

  // 新建会话：清空当前界面，换一个新 id
  function newSession() {
    if (loading) return;
    const nextSessionId = newSessionId();
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setHistOpen(false);
    setSessionId(nextSessionId);
    createdAtRef.current = Date.now();
    setMessages([]);
    setResult(null);
    setHistory([]);
    setHistIdx(-1);
    setLiveCode("");
    setInput("");
    setCaptureImportNotice(null);
    setInputHistory([]);
    setHistNavIdx(null);
    draftInputRef.current = "";
    setCustomTitle(null);
    setExportTitle(null);
    setImages([]);
    setDocs([]);
    setStyleProfileId("");
    setModelPreference("auto");
    setFastMode(true); // 新会话默认快速模式
    previewDeviceModeRef.current = "auto";
    setPreviewDeviceMode("auto");
    mobilePreviewShellRef.current = "wecom";
    setMobilePreviewShell("wecom");
    setRequirementCardsOpen(false);
    setPendingRequirement(null);
    setSteps([]);
    setReasoningChars(0);
    setReasoningActive(false);
    setGeneratedCodeBytes(0);
    setRunningTaskLabel("生成原型中");
    setStepsOpen(true);
    setTab("preview");
    void setLastActiveId(nextSessionId).catch(() => {
      /* 存储失败降级为纯内存，不打断使用 */
    });
  }

  function changePreviewDeviceMode(mode: PreviewDeviceMode) {
    previewDeviceModeRef.current = mode;
    setPreviewDeviceMode(mode);
    if (!hydratedRef.current || !sessionId) return;
    void saveSessionPreviewSettings(sessionId, { previewDeviceMode: mode }).catch(() => {
      /* 视图偏好持久化失败时只保留本次内存状态，不打断预览。 */
    });
  }

  function changeMobilePreviewShell(shell: MobilePreviewShell) {
    previewDeviceModeRef.current = "mobile";
    setPreviewDeviceMode("mobile");
    mobilePreviewShellRef.current = shell;
    setMobilePreviewShell(shell);
    if (!hydratedRef.current || !sessionId) return;
    void saveSessionPreviewSettings(sessionId, {
      previewDeviceMode: "mobile",
      mobilePreviewShell: shell,
    }).catch(() => {
      /* 视图偏好持久化失败时只保留本次内存状态，不打断预览。 */
    });
  }

  function changeRequirementCardsOpen(open: boolean) {
    setRequirementCardsOpen(open);
    if (!hydratedRef.current || !sessionId) return;
    void saveSessionPreviewSettings(sessionId, { requirementCardsOpen: open }).catch(() => {
      /* 视图偏好持久化失败时只保留本次内存。 */
    });
  }

  // 切换到某条历史会话
  async function switchSession(id: string) {
    if (loading || id === sessionId) {
      setHistOpen(false);
      return;
    }
    try {
      const rec = await loadSession(id);
      if (rec) {
        applySession(rec);
        await setLastActiveId(id);
      }
    } catch {
      /* 忽略 */
    }
    setHistOpen(false);
  }

  // 删除一条历史会话；删的若是当前会话则开新会话
  async function deleteSession(id: string) {
    try {
      await removeSession(id);
    } catch {
      /* 忽略 */
    }
    await refreshSummaries();
    if (id === sessionId) newSession();
  }

  // 重命名一条历史会话；当前会话走内存 customTitle 触发自动保存，非当前会话直接改库
  // title 为空串时表示"恢复默认名称"
  async function renameCurrent(id: string, title: string) {
    if (id === sessionId) {
      setCustomTitle(title || null); // 空串→null，触发 deriveTitle 回退
      return;
    }
    try {
      await renameSession(id, title);
    } catch {
      /* 忽略 */
    }
    await refreshSummaries();
  }

  const scrollDown = useCallback(() => {
    requestAnimationFrame(() => {
      messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
    });
  }, []);

  // 统一处理一批文件（＋ 选择 / 粘贴 共用）
  // 最多 4 个附件（图片 + 文档合计），追加到已有附件后面，超出则只取剩余名额。
  async function addFiles(files: File[]) {
    if (!files.length) return;
    const currentCount = images.length + docs.length;
    const remaining = MAX_ATTACHMENTS - currentCount;
    if (remaining <= 0) {
      alert(`最多只能上传 ${MAX_ATTACHMENTS} 个附件，请先删除一个再上传。`);
      return;
    }
    const picked = files.slice(0, remaining);
    if (files.length > remaining) alert(`最多只能上传 ${MAX_ATTACHMENTS} 个附件，已取前 ${remaining} 个。`);
    const nextImages: UploadedImage[] = [];
    const nextDocs: UploadedDoc[] = [];
    try {
      for (const f of picked) {
        const isZip = /\.zip$/i.test(f.name) || f.type === "application/zip" || f.type === "application/x-zip-compressed";
        const maxBytes = isZip ? MAX_ZIP_UPLOAD_BYTES : MAX_UPLOAD_BYTES;
        const maxMb = isZip ? MAX_ZIP_UPLOAD_MB : MAX_UPLOAD_MB;
        if (f.size > maxBytes) {
          alert(
            `文件「${f.name || "粘贴的图片"}」超过 ${maxMb}MB 上限（${(f.size / 1024 / 1024).toFixed(1)}MB），请压缩后再上传。`
          );
          continue;
        }
        if (f.type.startsWith("image/")) {
          nextImages.push(await downscaleImage(f));
        } else {
          const doc = await readDoc(f);
          if (doc) nextDocs.push(doc);
        }
      }
      if (nextImages.length) setImages((prev) => [...prev, ...nextImages].slice(0, MAX_ATTACHMENTS));
      if (nextDocs.length) setDocs((prev) => [...prev, ...nextDocs].slice(0, MAX_ATTACHMENTS));
    } catch {
      alert("无法读取部分文件，请检查文件格式后重试。");
    }
  }

  async function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // 允许重复选同一文件
    await addFiles(files);
  }

  // 编辑态（原生 HTML）粘贴/拖入文件类型过滤：仅收 image/HTML/ZIP（与 "+" accept 一致）；生成态不过滤（addFiles 全收）。
  function editUploadFilter(files: File[], editMode: boolean): File[] {
    if (!editMode) return files;
    return files.filter((f) => {
      const lower = f.name.toLowerCase();
      return f.type.startsWith("image/") || lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".zip");
    });
  }

  // 输入框粘贴：剪贴板里有图片/文件就当附件收下（纯文本粘贴照常）。
  // 生成态全收；原生 HTML 编辑态仅收 image/HTML/ZIP；DPL 编辑态不收。
  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const dt = e.clipboardData;
    const files: File[] = [];
    for (const it of Array.from(dt.items ?? [])) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    const seen = new Set(files.map((f) => `${f.name}:${f.type}:${f.size}`));
    for (const f of Array.from(dt.files ?? [])) {
      const key = `${f.name}:${f.type}:${f.size}`;
      if (!seen.has(key)) {
        seen.add(key);
        files.push(f);
      }
    }
    if (!files.length) return;
    if (result && !resultIsRawHtml) return; // DPL 编辑态不收附件
    const allowed = editUploadFilter(files, !!result);
    if (!allowed.length) {
      alert("编辑态仅支持粘贴图片 / HTML / ZIP，其他类型请在生成态上传。");
      return;
    }
    e.preventDefault(); // 有附件则不把它再作为文本/图片粘进输入框
    await addFiles(allowed);
  }

  function isFileDrag(e: React.DragEvent) {
    return Array.from(e.dataTransfer.types ?? []).includes("Files");
  }

  function resetFileDrag() {
    dragDepthRef.current = 0;
    setDraggingFiles(false);
  }

  function onComposerDragEnter(e: React.DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    if (!loading && (!result || resultIsRawHtml)) setDraggingFiles(true);
  }

  function onComposerDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = !loading && (!result || resultIsRawHtml) ? "copy" : "none";
  }

  function onComposerDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDraggingFiles(false);
  }

  async function onComposerDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files ?? []);
    resetFileDrag();
    if (loading || !files.length) return;
    if (result && !resultIsRawHtml) return; // DPL 编辑态不收附件
    const allowed = editUploadFilter(files, !!result);
    if (!allowed.length) {
      alert("编辑态仅支持拖入图片 / HTML / ZIP，其他类型请在生成态上传。");
      return;
    }
    await addFiles(allowed);
  }

  const canSend = (result ? input.trim() : (input.trim() || images.length > 0 || docs.length > 0)) && !loading;
  const isVisionPreference = (value: ModelPreference) => value === "kimiK3" || value === "glm5v" || value === "sonnet" || value === "opus";
  // 原生 HTML 产物（原样上传或原生模式生成）。仅这类产物编辑态开放图片上传作为需求附加说明；
  // DPL 产物编辑态不开放（"+"按钮已由 composer-upload-row 门槛隐藏，此处用于转发/模型选择/粘贴拒图）。
  const resultIsRawHtml = !!result && (result.rawHtml || result.html);
  const modelPickerUsesVision = images.length > 0 && (!result || resultIsRawHtml);
  const modelSelectValue: ModelPreference =
    modelPickerUsesVision
      ? isVisionPreference(modelPreference)
        ? modelPreference
        : "glm5v"
      : modelPreference === "glm5v"
      ? "auto"
      : modelPreference;
  // 发出消息后锁定生成态选项（快速/风格）；模型允许在编辑态为本次修改重新选择。
  const optionsLocked = messages.length > 0;
  const styleLocked = optionsLocked;
  const modelLocked = loading;

  async function send(overrideText?: string, previousHtmlOverride?: string, annoStyleId?: string, overrides?: SendOverrides) {
    const text = (overrideText ?? input).trim();
    const sendImages = overrides?.images ?? images;
    const sendDocs = overrides?.docs ?? docs;
    const activeResult = overrides?.forceGenerate ? null : result;
    // 编辑态上传了 HTML 但指令非合并：不转发该 HTML（合并仅在程序化合并路由处理），并提示。
    const EDIT_MERGE_KEYWORD = /合并|嵌入|下钻页|并入|合到一起|并进来|打开/;
    const editHasHtmlDoc = activeResult ? sendDocs.some((d) => d.kind === "html") : false;
    const editMergeIntent = activeResult ? EDIT_MERGE_KEYWORD.test(text) : false;
    const strippedEditHtml = editHasHtmlDoc && !editMergeIntent;
    const effectiveSendDocs = strippedEditHtml ? sendDocs.filter((d) => d.kind !== "html") : sendDocs;
    // 编辑态也转发文档（合并用）；原生 HTML 编辑态转发图片作为需求附加说明（送视觉编辑模型），DPL 编辑态不转发。
    const editIsRawHtml = !!activeResult && (activeResult.rawHtml || activeResult.html);
    const forwardImages = sendImages.length > 0 && (!activeResult || editIsRawHtml);
    const forwardDocs = effectiveSendDocs.length > 0;
    const hasAttach = forwardImages || forwardDocs;
    const requestUsesVisionModel = forwardImages;
    const requestModelPreference: ModelPreference =
      requestUsesVisionModel
        ? isVisionPreference(modelPreference)
          ? modelPreference
          : "glm5v"
        : modelPreference === "glm5v"
        ? "auto"
        : modelPreference;
    if (loading) return;
    // 编辑态必须有指令文本；生成态允许仅靠附件（原样打开上传页）。
    if (!text && (activeResult || !hasAttach)) return;
    setCaptureImportNotice(null);
    // 编辑态上传了 HTML 但指令非合并：HTML 无任何用途（不支持参考），阻断请求。
    // 保留 chip 与输入文本，让用户改合并指令或删掉 HTML 后重发。不自动消失，幂等。
    if (strippedEditHtml) {
      setEditUploadNotice("当前为编辑模式，新上传的 HTML 仅支持合并操作，暂不支持其他能力。");
      return;
    }
    setEditUploadNotice(null);
    // 若在补充澄清，把补充并入原需求；并跳过再次澄清
    const pendingBaseRequirement = pendingRequirement;
    const answering = !!pendingBaseRequirement;
    const baseRequirement = answering ? `${pendingBaseRequirement}\n\n补充说明：${text}` : text;
    setPendingRequirement(null);
    if (overrideText === undefined) {
      setInput("");
      if (text) {
        setInputHistory((h) => [...h, text]);
        setHistNavIdx(null);
      }
    }
    setLoading(true);
    stepSeqRef.current = 0;
    setSteps([]);
    setReasoningChars(0);
    setReasoningActive(false);
    setGeneratedCodeBytes(0);
    setClaudeProgress([]);
    claudeStartedAtRef.current = null;
    setClaudeNow(Date.now());
    setStepsOpen(true); // 生成时默认展开各阶段
    setTab("preview"); // 生成全程停留在预览（DPL 期间显示"生成中"占位，完成后出预览）
    // 构造对话气泡回显的附件（图标 + 文件名 + 原始 Blob，可点击打开）
    const chatAttachments: ChatAttachment[] = [];
    sendImages.forEach((im, i) => {
      if (!im.originalBlob) return;
      chatAttachments.push({ name: im.name || `图片${i + 1}`, kind: "image", originalBlob: im.originalBlob });
    });
    for (const d of sendDocs) {
      if (!d.originalBlob) continue;
      const kind = fileKindFromName(d.name);
      chatAttachments.push({
        name: d.name,
        kind,
        originalBlob: d.originalBlob,
        previewContent: kind === "html" ? d.content : undefined,
        captureMeta: d.captureMeta,
      });
    }
    const userContent = text || (chatAttachments.length ? "(根据上传内容生成)" : "");
    const currentUserMessage: ChatMessage = chatAttachments.length
      ? { role: "user", content: userContent, attachments: chatAttachments }
      : { role: "user", content: userContent };
    const previousCode =
      previousHtmlOverride ??
      (activeResult?.html && activeResult.rawHtmlState?.editHtml ? activeResult.rawHtmlState.editHtml : activeResult?.code);
    const artifactComparisonBase = previousHtmlOverride
      ? removeTemporaryAnchors(previousHtmlOverride)
      : activeResult?.code;
    const nextArtifactVersion = histIdx + 2;
    const firstUserRequirement =
      messages.find((message) => message.role === "user")?.content?.trim() ?? "";
    const restoredSessionBrief = sanitizeSessionBrief(activeResult?.sessionBrief);
    const activeSessionBrief = activeResult
      ? restoredSessionBrief ??
        createSessionBriefV1({
          initialRequirement: firstUserRequirement,
          initialPrototypeContract: activeResult.flow.prototypeContract,
          artifactVersion: Math.max(1, histIdx + 1),
        })
      : undefined;
    const branchingFromHistory = Boolean(activeResult && histIdx >= 0 && histIdx < history.length - 1);
    const legacyContextMessages = branchingFromHistory
      ? messagesForSessionVersion(messages, activeSessionBrief)
      : messages;
    const baseRecentTurns = activeSessionBrief?.recentTurns ?? buildRecentSessionTurns(legacyContextMessages);
    const commitSuccessfulResult = (
      nextResult: GenerationResult,
      messageCursor: number,
      recentTurns: SessionContextTurn[]
    ): GenerationResult => {
      const sessionBrief = activeSessionBrief
        ? advanceSessionBriefV1(
            activeSessionBrief,
            baseRequirement,
            nextArtifactVersion,
            Date.now(),
            messageCursor,
            recentTurns
          )
        : createSessionBriefV1({
            initialRequirement: pendingBaseRequirement ?? baseRequirement,
            clarifiedRequirement: answering ? text : undefined,
            initialPrototypeContract: nextResult.flow.prototypeContract,
            artifactVersion: nextArtifactVersion,
            messageCursor,
            recentTurns,
          });
      return {
        ...nextResult,
        sessionBrief,
        requirementCardSet: inheritRequirementCardSet(activeResult?.requirementCardSet, nextArtifactVersion),
      };
    };
    const commitArtifactOnlyResult = (
      nextResult: GenerationResult,
      messageCursor: number
    ): GenerationResult => {
      const sessionBrief = activeSessionBrief
        ? moveSessionBriefToVersion(
            activeSessionBrief,
            nextArtifactVersion,
            messageCursor,
            baseRecentTurns
          )
        : createSessionBriefV1({
            initialRequirement: "",
            initialPrototypeContract: nextResult.flow.prototypeContract,
            artifactVersion: nextArtifactVersion,
            messageCursor,
            recentTurns: baseRecentTurns,
          });
      return {
        ...nextResult,
        sessionBrief,
        // artifact-only：内容未变（回吐原页/空改兜底），仅携带卡集推进版本号，不重置 reviewStatus、不失效 link、不弹待复核 banner
        requirementCardSet: carryOverRequirementCardSet(activeResult?.requirementCardSet, nextArtifactVersion),
      };
    };
    const commitSuccessfulMessages = (assistantContent: string | null, claudeLogPath?: string) => {
      if (!assistantContent) return;
      setMessages((current) => {
        const assistantMessage: ChatMessage = claudeLogPath
          ? { role: "assistant", content: assistantContent, claudeLogPath }
          : { role: "assistant", content: assistantContent };
        return [...current, assistantMessage];
      });
    };
    setMessages((m) => [...m, currentUserMessage]);
    scrollDown();

    const mode = activeResult ? "edit" : "generate";
    const hasHtmlDoc = effectiveSendDocs.some((d) => d.kind === "html");
    const rawHtml = !activeResult && hasHtmlDoc;
    const rawHtmlSource = hasHtmlDoc ? effectiveSendDocs.find((d) => d.kind === "html")?.content : undefined;
    setRunningTaskLabel(runningTaskLabelFor({ mode, hasHtmlDoc, hasImages: sendImages.length > 0 }));
    // 预览骨架文案：原样打开秒开不估时；快速模式秒级；高质量按场景分档
    // （还原关键词镜像后端 isRestorationRequirement；强场景信号取 shouldUseStrongInitialGenerate 的可前端判定子集）
    const isRestoration = /高保真|还原|复刻|仿照|参考|贴近|像|截图|设计稿|视觉稿|产品稿|风格/.test(baseRequirement);
    const strongScene = sendImages.length > 0 || sendDocs.length > 0 || !!styleProfileId || isRestoration;
    setLoadingHint(
      hasHtmlDoc
        ? "正在识别上传页面处理方式…"
        : fastMode
        ? "快速模式生成原型中，大约需要 20-40 秒…"
        : strongScene
        ? "高质量模式生成原型中，大约需要 2-4 分钟…"
        : "高质量模式生成原型中，大约需要 1-2 分钟…"
    );
    const previous = activeResult
      ? {
          code: previousCode ?? activeResult.code,
          flow: activeResult.flow,
          components: activeResult.components,
          rawHtml: activeResult.rawHtml,
          html: activeResult.html,
          rawHtmlState: previousHtmlOverride ? undefined : activeResult.rawHtmlState,
          rawHtmlEditSource: previousHtmlOverride ? "annotation" : "chat",
          device: activeResult.device,
          styleProfileId: activeResult.rawHtml ? (previousHtmlOverride ? annoStyleId : undefined) : annoStyleId ?? activeResult.styleProfileId,
          modelPreference: requestModelPreference,
          captureMeta: activeResult.captureMeta,
          sessionBrief: activeSessionBrief,
        }
      : undefined;
    const attachments = hasAttach
      ? { images: forwardImages ? sendImages.map((i) => ({ mediaType: i.mediaType, data: i.data })) : [], documents: effectiveSendDocs }
      : undefined;

    // 流式过程里累积的中间态
    let flow: FlowSpec | null = null;
    let components: RetrievedComponent[] = [];
    let code = "";
    let preview: GenerationResult["preview"] | null = null;
    const requestAssistantMessages: ChatMessage[] = [];
    // 流式生成的 UI 节流与状态
    let streamStarted = false;
    let lastUiAt = 0;
    let doneReceived = false;
    let desktopClaudeRequest: DesktopClaudeRequest | null = null;

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      for (let attempt = 0; attempt <= GENERATE_RETRY_COUNT; attempt += 1) {
        // clarify / done / accepted assistant 都是本次请求已经交付给用户的终态回答。
        // 若服务端恰好在终态事件后断流，不能再自动重放整次请求，否则会重复气泡，
        // 甚至把同一轮问答重复写入 DesignContext。
        let terminalResponseReceived = false;
        flow = null;
        components = [];
        code = "";
        preview = null;
        streamStarted = false;
        lastUiAt = 0;
        doneReceived = false;
        desktopClaudeRequest = null;
        try {
      const res = await fetch(withBase("/api/generate"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({
          requirement: baseRequirement,
          mode,
          previous,
          recentTurns: baseRecentTurns,
          styleProfileId: styleProfileId || undefined,
          attachments,
          modelPreference: requestModelPreference,
          allowClarify: !answering,
          rawHtml,
          fastMode,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        let message = `请求失败（${res.status}）`;
        try {
          message = JSON.parse(body)?.error || message;
        } catch {
          if (body.trim()) message = body.trim();
        }
        throw new HttpResponseError(message);
      }
      if (!res.body) throw new Error("无响应流");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as PipelineEvent;
          switch (ev.type) {
            case "step":
              pushPipelineStep(ev);
              break;
            case "clarify": {
              terminalResponseReceived = true;
              const q = ev.questions.map((x, idx) => `${idx + 1}. ${x}`).join("\n");
              const clarifyMessage: ChatMessage = {
                role: "assistant",
                content: `这个需求还有点模糊，先确认几点帮你做得更准：\n${q}\n\n（直接回复补充即可，我再开始生成）`,
              };
              requestAssistantMessages.push(clarifyMessage);
              setMessages((m) => [...m, clarifyMessage]);
              setPendingRequirement(baseRequirement);
              break;
            }
            case "flow":
              flow = ev.flow;
              break;
            case "components":
              components = ev.components;
              break;
            case "reasoning-delta":
              setReasoningActive(true);
              setReasoningChars((n) => n + ev.chunk.length);
              break;
            case "code-delta": {
              if (!streamStarted) {
                streamStarted = true;
                code = "";
              }
              // 正文一开始就关掉思考 ticker（reasoning 通常先于 content 流完）
              setReasoningActive(false);
              code += ev.chunk;
              const now = Date.now();
              if (now - lastUiAt > 120) {
                lastUiAt = now;
                setLiveCode(code);
                setGeneratedCodeBytes(new Blob([code]).size);
                // 生成过程中只更新代码区；预览等最终 code/preview/done 事件到达后再一次性渲染，避免 iframe 高频重载。
                // 想看代码进度可手动切到「代码」页签（liveCode 实时更新）
              }
              break;
            }
            case "code":
              code = ev.code;
              setLiveCode(ev.code);
              setGeneratedCodeBytes(new Blob([ev.code]).size);
              break;
            case "preview":
              preview = ev.preview;
              // 实时把已有结果塞进右侧，先睹为快
              if (flow) {
                setResult({
                  flow,
                  components,
                  code,
                  preview,
                  modelPreference: requestModelPreference,
                  sessionBrief: activeSessionBrief,
                });
              }
              setTab("preview");
              break;
            case "done": {
              terminalResponseReceived = true;
              doneReceived = true;
              if (
                activeResult &&
                artifactComparisonBase &&
                !hasMeaningfulSessionArtifactChange(artifactComparisonBase, ev.result.code)
              ) {
                setResult(activeResult);
                setLiveCode(activeResult.code);
                setGeneratedCodeBytes(new Blob([activeResult.code]).size);
                setTab("preview");
                setMessages((m) => [
                  ...m,
                  {
                    role: "assistant",
                    content: "未检测到明确改动，已保留原页面，没有生成新版本。请换一种说法或重新点选目标元素。",
                  },
                ]);
                break;
              }
              const assistantContent =
                ev.summary === null ? null : ev.summary ?? assistantSummary(ev.result, mode === "edit");
              const summaryMessage: ChatMessage | null = assistantContent
                ? { role: "assistant", content: assistantContent }
                : null;
              const resultMessageCursor =
                messages.length + 1 + requestAssistantMessages.length + (assistantContent ? 1 : 0);
              const artifactOnly = ev.contextCommit === "artifact-only";
              const committedResult = artifactOnly
                ? commitArtifactOnlyResult(ev.result, resultMessageCursor)
                : commitSuccessfulResult(
                    ev.result,
                    resultMessageCursor,
                    mergeRecentSessionTurns(baseRecentTurns, [
                      currentUserMessage,
                      ...requestAssistantMessages,
                      ...(summaryMessage ? [summaryMessage] : []),
                    ])
                  );
              setResult(committedResult);
              // 入版本历史：若之前回退过，截断当前之后的版本再追加
              setHistory((h) => {
                const base = h.slice(0, histIdx + 1);
                const next = [...base, committedResult];
                setHistIdx(next.length - 1);
                return next;
              });
              commitSuccessfulMessages(assistantContent);
              break;
            }
            case "assistant": {
              if (ev.contextTurn === "accepted") terminalResponseReceived = true;
              const assistantMessage: ChatMessage = { role: "assistant", content: ev.message };
              requestAssistantMessages.push(assistantMessage);
              setMessages((m) => [...m, assistantMessage]);
              if (ev.contextTurn === "accepted" && activeResult && activeSessionBrief) {
                const acceptedRecentTurns = mergeRecentSessionTurns(baseRecentTurns, [
                  currentUserMessage,
                  ...requestAssistantMessages,
                ]);
                const updatedResult: GenerationResult = {
                  ...activeResult,
                  sessionBrief: moveSessionBriefToVersion(
                    activeSessionBrief,
                    activeSessionBrief.artifactVersion,
                    messages.length + 1 + requestAssistantMessages.length,
                    acceptedRecentTurns
                  ),
                };
                setResult(updatedResult);
                setHistory((current) =>
                  histIdx >= 0
                    ? current.map((item, index) => (index === histIdx ? updatedResult : item))
                    : current
                );
              }
              break;
            }
            case "desktop-claude-required":
              desktopClaudeRequest = ev;
              setRunningTaskLabel("增强处理大页面中");
              setDesktopClaudeStep("start", ev.message);
              break;
            case "desktop-claude-progress":
              pushClaudeProgress(ev.progress);
              break;
            case "error":
              throw new PipelineEventError(ev.message);
          }
          scrollDown();
        }
      }

      if (!doneReceived && !ac.signal.aborted && desktopClaudeRequest) {
        const desktopRequest = desktopClaudeRequest;
        const sourceHtml = activeResult?.code ?? rawHtmlSource ?? "";
        const sourceEditHtml = previous?.rawHtmlState?.editHtml ?? desktopRequest.editHtml;
        const sourceAssets = previous?.rawHtmlState?.assets ?? desktopRequest.assets;
        const fallbackFlow: FlowSpec =
          previous?.flow ??
          flow ?? {
            title: "HTML 页面",
            summary: "原样打开的 HTML 页面",
            pages: [{ id: "page", name: "页面", summary: "", sections: [], componentNeeds: [], dataFields: [] }],
            navigations: [],
          };
        const openOriginalRawHtml = (message?: string, claudeLogPath?: string) => {
          if (previous || !rawHtml || !sourceHtml) return;
          const preview = { html: sourceHtml, source: "raw" as const };
          const originalResult = commitArtifactOnlyResult({
            flow: fallbackFlow,
            components: [],
            code: sourceHtml,
            preview,
            rawHtml: true,
            html: true,
            rawHtmlState: sourceEditHtml
              ? {
                  editHtml: sourceEditHtml,
                  assets: sourceAssets ?? [],
                  assetCount: sourceAssets?.length ?? 0,
                }
              : undefined,
            device: desktopRequest.device,
            modelPreference: requestModelPreference,
          }, messages.length + 1 + requestAssistantMessages.length + (message ? 1 : 0));
          doneReceived = true;
          setResult(originalResult);
          setLiveCode(sourceHtml);
          setGeneratedCodeBytes(new Blob([sourceHtml]).size);
          setTab("preview");
          setHistory((h) => {
            const base = h.slice(0, histIdx + 1);
            const nh = [...base, originalResult];
            setHistIdx(nh.length - 1);
            return nh;
          });
          if (message) {
            setMessages((m) => [
              ...m,
              claudeLogPath ? { role: "assistant", content: message, claudeLogPath } : { role: "assistant", content: message },
            ]);
          }
        };

        if (!hasDesktopClaudeBridge() || !hasDesktopClaudeStatusBridge() || !sourceHtml) {
          setDesktopClaudeStep("done", "客户端增强不可用，已保留原页面");
          const message = `客户端增强不可用：当前环境未检测到CLI。${
            previous ? "已保留原页面。" : "已原样打开。"
          }请用点选修改选择要改的元素，或缩小修改范围。`;
          if (previous) setMessages((m) => [...m, { role: "assistant", content: message }]);
          else openOriginalRawHtml(message);
        } else {
          setDesktopClaudeStep("start", desktopRequest.message);
          desktopClaudeActiveRef.current = true;
          const claudeJobId = `claude-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const claudeProgressId = claudeJobId;
          desktopClaudeJobIdRef.current = claudeJobId;
          let rejectLocalCancellation: ((reason?: unknown) => void) | null = null;
          const localCancellation = new Promise<never>((_resolve, reject) => {
            rejectLocalCancellation = reject;
          });
          const cancelLocally = () => rejectLocalCancellation?.(new Error("客户端增强已取消"));
          desktopClaudeCancelLocalRef.current = cancelLocally;
          const unsubscribeClaudeProgress = window.youdesignDesktop?.onClaudeProgress?.((payload) => {
            if (payload.progressId !== claudeProgressId) return;
            pushClaudeProgress(payload);
          });
          try {
            pushClaudeProgress({ phase: "auth-check", message: "正在检查 Claude Code CLI 状态" });
            const status = await Promise.race([window.youdesignDesktop!.getClaudeStatus!(), localCancellation]);
            const compatibilityError = desktopClaudeCompatibilityError(status);
            if (compatibilityError) throw new Error(compatibilityError);
            if (!status.available) throw new Error(status.message || "客户端增强不可用");
            if (desktopClaudeJobIdRef.current !== claudeJobId) throw new Error("客户端增强已取消");
            const sourceHtmlSha256 = await sha256Text(sourceHtml);
            const bridge = await Promise.race([
              window.youdesignDesktop!.runClaudeHtmlEdit!({
                bridgeProtocolVersion: DESKTOP_CLAUDE_PROTOCOL_VERSION,
                jobId: claudeJobId,
                html: sourceEditHtml ? undefined : sourceHtml,
                htmlSha256: sourceHtmlSha256,
                editHtml: sourceEditHtml,
                assets: sourceAssets,
                instruction: desktopRequest.instruction ?? baseRequirement,
                device: desktopRequest.device ?? previous?.device,
                styleProfileId: rawHtml || previous?.rawHtml ? undefined : desktopRequest.styleProfileId ?? previous?.styleProfileId,
                interactiveEdit: desktopRequest.interactiveEdit,
                focus: desktopRequest.focus,
                prototypeContract: previous?.flow.prototypeContract,
                sessionContext: desktopRequest.sessionContext,
                progressId: claudeProgressId,
              }),
              localCancellation,
            ]);
            if (!bridge.ok) {
              const needsClarification = "needsClarification" in bridge;
              const assistantContent = "needsClarification" in bridge ? bridge.clarification : bridge.message;
              const assistantMessage: ChatMessage = bridge.rawLogPath
                ? { role: "assistant", content: assistantContent, claudeLogPath: bridge.rawLogPath }
                : { role: "assistant", content: assistantContent };
              doneReceived = true;
              const terminalLabel = needsClarification ? "需要补充说明后继续修改" : "当前页面已满足本次需求";
              setDesktopClaudeStep("done", terminalLabel);
              pushClaudeProgress({
                phase: "done",
                message: terminalLabel,
                detail: assistantContent,
                logPath: bridge.rawLogPath,
              });
              setMessages((current) => [...current, assistantMessage]);
              if (activeResult && activeSessionBrief) {
                const clarifiedRecentTurns = mergeRecentSessionTurns(baseRecentTurns, [
                  currentUserMessage,
                  ...requestAssistantMessages,
                  assistantMessage,
                ]);
                const updatedResult: GenerationResult = {
                  ...activeResult,
                  sessionBrief: moveSessionBriefToVersion(
                    activeSessionBrief,
                    activeSessionBrief.artifactVersion,
                    messages.length + 1 + requestAssistantMessages.length + 1,
                    clarifiedRecentTurns
                  ),
                };
                setResult(updatedResult);
                setHistory((current) =>
                  histIdx >= 0
                    ? current.map((item, index) => (index === histIdx ? updatedResult : item))
                    : current
                );
              }
              return;
            }
            const html = bridge.html;
            if (
              activeResult &&
              artifactComparisonBase &&
              !hasMeaningfulSessionArtifactChange(artifactComparisonBase, html)
            ) {
              doneReceived = true;
              setDesktopClaudeStep("done", "未检测到明确改动，已保留原页面");
              setResult(activeResult);
              setLiveCode(activeResult.code);
              setGeneratedCodeBytes(new Blob([activeResult.code]).size);
              setMessages((m) => [
                ...m,
                {
                  role: "assistant",
                  content: "客户端增强未检测到明确改动，已保留原页面，没有生成新版本。",
                },
              ]);
              return;
            }
            const desktopAssistantContent = "已完成修改，页面已更新。";
            const desktopSummaryMessage: ChatMessage = {
              role: "assistant",
              content: desktopAssistantContent,
            };
            const committedRecentTurns = mergeRecentSessionTurns(baseRecentTurns, [
              currentUserMessage,
              ...requestAssistantMessages,
              desktopSummaryMessage,
            ]);
            const resultMessageCursor = messages.length + 1 + requestAssistantMessages.length + 1;
            const next = commitSuccessfulResult(
              {
                flow: fallbackFlow,
                components: previous?.components ?? components,
                code: html,
                preview: { html, source: "raw" },
                rawHtml: previous?.rawHtml ?? rawHtml,
                html: true,
                rawHtmlState: bridge.rawHtmlState,
                device: desktopRequest.device ?? previous?.device,
                styleProfileId:
                  rawHtml || previous?.rawHtml
                    ? undefined
                    : desktopRequest.styleProfileId ?? previous?.styleProfileId,
                modelPreference: requestModelPreference,
              },
              resultMessageCursor,
              committedRecentTurns
            );
            doneReceived = true;
            setDesktopClaudeStep("done", "客户端增强修改完成");
            setResult(next);
            setLiveCode(html);
            setGeneratedCodeBytes(new Blob([html]).size);
            setTab("preview");
            setHistory((h) => {
              const base = h.slice(0, histIdx + 1);
              const nh = [...base, next];
              setHistIdx(nh.length - 1);
              return nh;
            });
            commitSuccessfulMessages(desktopAssistantContent);
          } catch (bridgeErr) {
            const failure = formatDesktopClaudeFailure(bridgeErr);
            const cancelled = failure.prefix.includes("已取消");
            pushClaudeProgress({
              phase: cancelled ? "cancelled" : "failed",
              message: cancelled ? "Claude Code 增强已取消" : "Claude Code 增强失败",
              detail: failure.detail || failure.prefix,
            });
            setDesktopClaudeStep("done", `${failure.prefix}，已保留原页面`);
            const message = `${failure.prefix}：${failure.detail ? `${failure.detail}。` : ""}${previous ? "已保留原页面。" : "已原样打开。"}`;
            const assistantMessage: ChatMessage = failure.rawLogPath
              ? { role: "assistant", content: message, claudeLogPath: failure.rawLogPath }
              : { role: "assistant", content: message };
            if (previous) setMessages((m) => [...m, assistantMessage]);
            else openOriginalRawHtml(message, failure.rawLogPath);
          } finally {
            unsubscribeClaudeProgress?.();
            if (desktopClaudeJobIdRef.current === claudeJobId) desktopClaudeJobIdRef.current = null;
            if (desktopClaudeCancelLocalRef.current === cancelLocally) desktopClaudeCancelLocalRef.current = null;
            desktopClaudeActiveRef.current = false;
          }
        }
      }
          break;
        } catch (err) {
          if (terminalResponseReceived) break;
          if (isAbortError(err) || err instanceof HttpResponseError || attempt >= GENERATE_RETRY_COUNT) throw err;
          setReasoningActive(false);
          pushStep("generate", "start", `请求失败，${GENERATE_RETRY_DELAY_MS / 1000}秒后自动重试（${attempt + 1}/${GENERATE_RETRY_COUNT}）`);
          await delay(GENERATE_RETRY_DELAY_MS);
        }
      }
    } catch (err) {
      // 用户主动取消，不当作错误
      if (isAbortError(err)) {
        setMessages((m) => [...m, { role: "assistant", content: "已取消本次生成。" }]);
      } else {
        const prefix = err instanceof PipelineEventError ? "出错了" : "请求失败";
        setMessages((m) => [
          ...m,
          { role: "assistant", content: `⚠️ ${prefix}：${err instanceof Error ? err.message : String(err)}` },
        ]);
      }
    } finally {
      abortRef.current = null;
      setLoading(false);
      setLoadingHint("");
      setSteps([]);
      setGeneratedCodeBytes(0);
      // 成功交付（done）后清空已上传附件：生成态打开 demo / 编辑态合并完成后，
      // 上传的 HTML 已被消费，清掉避免残留 chip 被下一次编辑态操作误转发。
      // 澄清（未 done）不清，便于用户补充后重发仍带原文档。
      if (doneReceived) {
        setDocs([]);
        setImages([]);
      }
      scrollDown();
    }
  }

  async function cancelDesktopClaudeWork(jobId: string) {
    if (!hasDesktopClaudeCancelBridge()) return;
    await window.youdesignDesktop!.cancelClaudeHtmlEdit!(jobId).catch(() => undefined);
  }

  // 取消正在进行的生成
  function cancelGenerate() {
    abortRef.current?.abort();
    const claudeJobId = desktopClaudeJobIdRef.current;
    if (desktopClaudeActiveRef.current && claudeJobId) {
      desktopClaudeJobIdRef.current = null;
      desktopClaudeCancelLocalRef.current?.();
      desktopClaudeCancelLocalRef.current = null;
      setRunningTaskLabel("正在取消增强处理");
      setDesktopClaudeStep("start", "正在取消客户端增强修改");
      void cancelDesktopClaudeWork(claudeJobId);
    }
  }

  // 版本回退：撤销 / 重做到历史中的某一版
  function gotoVersion(idx: number) {
    if (idx < 0 || idx >= history.length || loading) return;
    setHistIdx(idx);
    setResult(history[idx]);
    setLiveCode(history[idx].code);
    setTab("preview");
  }

  // 退出登录：清 cookie 后回登录页（用整页跳转确保 middleware 生效）
  async function logout() {
    try {
      await fetch(withBase("/api/logout"), { method: "POST" });
    } catch {
      /* 忽略 */
    }
    window.location.href = withBase("/login");
  }

  function updateRequirementCards(nextSet: RequirementCardSet) {
    if (!result) return;
    const next = { ...result, requirementCardSet: nextSet };
    setResult(next);
    setHistory((current) => histIdx >= 0 ? current.map((item, index) => index === histIdx ? next : item) : current);
  }

  // 预览里直接编辑文案后写回（不调用模型）；入版本历史，支持撤销回改前
  function handleDirectEdit(html: string) {
    if (!result) return;
    if (!hasMeaningfulSessionArtifactChange(result.code, html)) return;
    const restoredBrief = sanitizeSessionBrief(result.sessionBrief);
    const safeBrief =
      restoredBrief ??
      createSessionBriefV1({
        initialRequirement: messages.find((message) => message.role === "user")?.content?.trim() ?? "",
        initialPrototypeContract: result.flow.prototypeContract,
        artifactVersion: Math.max(1, histIdx + 1),
      });
    const branchingFromHistory = histIdx >= 0 && histIdx < history.length - 1;
    const directEditRecentTurns =
      safeBrief.recentTurns ??
      buildRecentSessionTurns(
        branchingFromHistory ? messagesForSessionVersion(messages, safeBrief) : messages
      );
    const next = {
      ...result,
      code: html,
      preview: { html, source: "raw" as const },
      html: true,
      // 直接编辑改变的是完整预览 HTML；旧 editHtml 已失效，下次 AI 编辑按新 code 重新压缩资源。
      rawHtmlState: undefined,
      sessionBrief: moveSessionBriefToVersion(
        safeBrief,
        histIdx + 2,
        messages.length,
        directEditRecentTurns
      ),
      requirementCardSet: inheritRequirementCardSet(result.requirementCardSet, histIdx + 2, { preserveReviewStatus: true }),
    };
    setResult(next);
    // 与 done 事件同模式：截断当前 histIdx 之后的版本再追加，histIdx 推进到新末尾
    setHistory((h) => {
      const base = h.slice(0, histIdx + 1);
      const nh = [...base, next];
      setHistIdx(nh.length - 1);
      return nh;
    });
    setLiveCode(html);
  }

  // 回车发送；Shift+Enter 换行；输入法组词中的回车不触发
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "ArrowUp") {
      const ta = e.currentTarget;
      // 仅当光标在文本最前面时才触发历史导航，否则放行默认光标移动（不破坏多行/自动折行编辑）
      if (ta.selectionStart !== 0 || ta.selectionEnd !== 0) return;
      if (inputHistory.length === 0) return;
      e.preventDefault();
      cursorAnchorRef.current = "start"; // ↑ 切到更早，光标落最前（便于继续按↑）
      setHistNavIdx((cur) => {
        if (cur === null) {
          draftInputRef.current = ta.value; // 进入浏览前保存当前草稿
          return inputHistory.length - 1;
        }
        return cur > 0 ? cur - 1 : cur; // 已到最早一条则不动
      });
      return;
    }
    if (e.key === "ArrowDown") {
      const ta = e.currentTarget;
      // 仅当光标在文本最末尾时才触发历史导航
      if (ta.selectionStart !== ta.value.length || ta.selectionEnd !== ta.value.length) return;
      if (histNavIdx === null) return;
      e.preventDefault();
      cursorAnchorRef.current = "end"; // ↓ 切到更近，光标落最后（便于继续按↓）
      setHistNavIdx((cur) => {
        if (cur === null) return null;
        if (cur >= inputHistory.length - 1) {
          setInput(draftInputRef.current); // 越过最新一条，恢复草稿
          return null;
        }
        return cur + 1;
      });
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  // 历史浏览游标变化时，把对应历史文本同步进输入框
  useEffect(() => {
    if (histNavIdx !== null && inputHistory[histNavIdx] !== undefined) {
      setInput(inputHistory[histNavIdx]);
    }
  }, [histNavIdx, inputHistory]);

  // 历史导航填充后按方向定位光标：↑ 落最前、↓ 落最后；用一次即清空意图，不干扰手动输入
  useLayoutEffect(() => {
    const ta = inputRef.current;
    if (!ta || !cursorAnchorRef.current) return;
    const pos = cursorAnchorRef.current === "start" ? 0 : ta.value.length;
    ta.setSelectionRange(pos, pos);
    ta.focus();
    cursorAnchorRef.current = null;
  }, [input]);

  const activeStep = [...steps].reverse().find((s) => s.status === "start") ?? steps[steps.length - 1];
  const currentStageLabel = activeStep ? STAGE_LABELS[activeStep.stage] ?? activeStep.stage : "准备中";
  const latestClaudeProgress = claudeProgress[claudeProgress.length - 1];
  const latestClaudeTerminal = latestClaudeProgress ? isClaudeTerminalPhase(latestClaudeProgress.phase) : false;
  const claudeElapsedMs = latestClaudeProgress
    ? Math.max(latestClaudeProgress.elapsedMs ?? 0, claudeStartedAtRef.current === null ? 0 : claudeNow - claudeStartedAtRef.current)
    : undefined;
  const claudeStepDetail = latestClaudeProgress
    ? [
        CLAUDE_PHASE_LABELS[latestClaudeProgress.phase] ?? latestClaudeProgress.phase,
        latestClaudeProgress.toolName || latestClaudeProgress.detail?.split("\n")[0],
        formatElapsed(claudeElapsedMs) ? `已用 ${formatElapsed(claudeElapsedMs)}` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const progressCodeLine =
    generatedCodeBytes > 0 && activeStep && ["generate", "edit", "open"].includes(activeStep.stage)
      ? `正在编写页面代码…已生成 ${formatByteSize(generatedCodeBytes)}`
      : "";
  const previewLoadingHint = progressHintForStep(activeStep, loadingHint, generatedCodeBytes);

  return (
    <div className={`app layout-${effectiveLayoutMode}`}>
      <HistoryDrawer
        open={effectiveLayoutMode === "two" && histOpen}
        summaries={summaries}
        currentId={sessionId}
        onClose={() => setHistOpen(false)}
        onSwitch={switchSession}
        onNew={newSession}
        onDelete={deleteSession}
        onRename={renameCurrent}
      />
      <div className="layout-history">
        <HistoryDrawer
          open={effectiveLayoutMode === "three"}
          variant="panel"
          summaries={summaries}
          currentId={sessionId}
          onClose={() => setHistOpen(false)}
          onSwitch={switchSession}
          onNew={newSession}
          onDelete={deleteSession}
          onRename={renameCurrent}
        />
      </div>
      <div className="chat">
        <div className="chat-header">
          <img
            className="chat-logo"
            src={withBase(theme.id === "yemu" ? "/logo/logo-h-dark.svg" : "/logo/logo-h-light.svg")}
            alt="YouDesign"
          />
          <div className="header-actions">
            <button
              type="button"
              className="layout-seg"
              onClick={() => setLayoutMode(effectiveLayoutMode === "three" ? "two" : "three")}
              disabled={effectiveLayoutMode !== "three" && !canUseThreeColumn}
              title={
                effectiveLayoutMode === "three"
                  ? "切换为两列式：对话 + 预览"
                  : canUseThreeColumn
                    ? "切换为三列式：历史会话 + 对话 + 预览/详情"
                    : "当前窗口较窄，放大到 1280px 以上可用三列式"
              }
              aria-label={effectiveLayoutMode === "three" ? "切换为两列式" : "切换为三列式"}
            >
              {effectiveLayoutMode === "three" ? (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <rect x="1" y="2" width="4.5" height="10" rx="1" fill="currentColor" />
                  <rect x="8.5" y="2" width="4.5" height="10" rx="1" fill="currentColor" opacity="0.4" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <rect x="0.5" y="2" width="3" height="10" rx="1" fill="currentColor" opacity="0.35" />
                  <rect x="5.5" y="2" width="4" height="10" rx="1" fill="currentColor" />
                  <rect x="10.5" y="2" width="3" height="10" rx="1" fill="currentColor" opacity="0.35" />
                </svg>
              )}
            </button>
            {effectiveLayoutMode === "two" && (
              <>
                <button className="hist-btn" onClick={newSession} disabled={loading} title="开启一个新的空会话">
                  新会话
                </button>
                <button className="hist-btn" onClick={() => setHistOpen(true)} title="历史会话">
                  历史
                </button>
              </>
            )}
          </div>
        </div>

        <div className="messages" ref={messagesRef}>
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}${m.content.startsWith("⚠️") ? " error" : ""}`}>
              <MsgContent content={m.content} />
              {m.attachments && m.attachments.length > 0 && (
                <div className="chips-row msg-attachments">
                  {m.attachments.map((att, j) => (
                    <button
                      key={j}
                      type="button"
                      className="chip chip-open"
                      title={`打开 ${att.name}`}
                      onClick={() => {
                        void openAttachment(att);
                      }}
                    >
                      {ATTACH_ICON[att.kind]} {att.name}
                    </button>
                  ))}
                </div>
              )}
              {m.claudeLogPath && hasDesktopClaudeLogBridge() && (
                <div className="chips-row msg-attachments">
                  <button
                    type="button"
                    className="chip chip-open"
                    title="用系统默认应用打开本次增强日志"
                    onClick={() => {
                      void openClaudeLog(m.claudeLogPath!);
                    }}
                  >
                    📋 查看日志
                  </button>
                </div>
              )}
            </div>
          ))}
          {loading && steps.length > 0 && (
            <div className="proc">
              <button className="proc-head" onClick={() => setStepsOpen((o) => !o)}>
                <span className="spinner" />
                <span className="proc-title">{runningTaskLabel} · {currentStageLabel}</span>
                <span className={`chev${stepsOpen ? " open" : ""}`}>⌄</span>
              </button>
              {reasoningActive && reasoningChars > 0 && (
                <div className="proc-reasoning">思考中… 已思考 {reasoningChars} tokens</div>
              )}
              {progressCodeLine && <div className="proc-reasoning">{progressCodeLine}</div>}
              {stepsOpen && (
                <div className="proc-body">
                  {steps.map((s) => (
                    <div key={s.id} className={`step-row ${s.status}`}>
                      <span className="dot" />
                      <span className="step-content">
                        {STAGE_LABELS[s.stage] ?? s.stage}
                        {s.stage === "desktop-claude" && claudeStepDetail && (s.status === "start" || latestClaudeTerminal)
                          ? ` · ${claudeStepDetail}`
                          : s.detail
                          ? ` · ${s.detail}`
                          : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="composer">
          {captureImportNotice && (
            <div className="capture-import-notice" role="status" aria-live="polite">
              <span>{captureImportNotice.text}</span>
              <button type="button" onClick={() => setCaptureImportNotice(null)} aria-label="关闭提示">
                ×
              </button>
            </div>
          )}
          {editUploadNotice && (
            <div className="capture-import-notice" role="status" aria-live="polite">
              <span>{editUploadNotice}</span>
              <button type="button" onClick={() => setEditUploadNotice(null)} aria-label="关闭提示">
                ×
              </button>
            </div>
          )}
            <div className="composer-upload-row">
              <div className="upload-left">
                {/* 编辑态仅在原生 HTML 产物（rawHtml/html）下放开上传入口；DPL 产物不显示入口（不支持合并） */}
                {(!result || result.rawHtml || result.html) && (<>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={loading}
                  title="最多上传 4 个附件（可点击、粘贴或拖入截图 / HTML / HTML资源包ZIP / Word / Markdown…，普通文件≤5MB，ZIP≤10MB）"
                >
                  ＋
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={result ? "image/*,.html,.htm,.zip" : "image/*,.html,.htm,.zip,.md,.markdown,.txt,.csv,.json,.doc,.docx"}
                  multiple
                  style={{ display: "none" }}
                  onChange={onPickFiles}
                />
                {(images.length > 0 || docs.length > 0) && (
                  <div className="chips-row">
                    {images.map((im, i) => (
                      <span key={`img${i}`} className="chip">
                        <button
                          type="button"
                          className="chip-open"
                          title={im.originalBlob ? `打开 ${im.name ?? "图片"}` : "图片"}
                          disabled={!im.originalBlob}
                          onClick={() =>
                            im.originalBlob &&
                            void openAttachment({
                              name: im.name ?? `图${i + 1}`,
                              kind: "image",
                              originalBlob: im.originalBlob,
                            })
                          }
                        >
                          🖼 {im.name ?? `图${i + 1}`}
                        </button>
                        <button className="chip-del" onClick={() => setImages((p) => p.filter((_, j) => j !== i))}>
                          ×
                        </button>
                      </span>
                    ))}
                    {docs.map((d, i) => (
                      <span key={`doc${i}`} className="chip">
                        <button
                          type="button"
                          className="chip-open"
                          title={d.originalBlob ? `打开 ${d.name}` : d.name}
                          disabled={!d.originalBlob}
                          onClick={() =>
                            d.originalBlob &&
                            void openAttachment({
                              name: d.name,
                              kind: fileKindFromName(d.name),
                              originalBlob: d.originalBlob,
                              previewContent: fileKindFromName(d.name) === "html" ? d.content : undefined,
                              captureMeta: d.captureMeta,
                            })
                          }
                        >
                          {ATTACH_ICON[fileKindFromName(d.name)]} {d.name}
                        </button>
                        <button className="chip-del" onClick={() => setDocs((p) => p.filter((_, j) => j !== i))}>
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                </>)}
              </div>
              <button
                type="button"
                className={`modeswitch fast${fastMode ? " active" : ""}`}
                onClick={() => setFastMode((v) => !v)}
                disabled={optionsLocked}
                title={
                  fastMode
                    ? "快速模式（默认）：generate 与结构化恒走 deepseek-v4-flash、跳过自评审/refine，秒出原型。点击关闭"
                    : "高质量模式：结构化复杂时升 deepseek-v4-pro、generate 走 pro、开启自评审与定向优化，更慢更精细。点击切回快速"
                }
              >
                快速
              </button>
              <ModelPreferencePicker
                value={modelSelectValue}
                onChange={setModelPreference}
                disabled={modelLocked}
                title={modelPickerUsesVision ? "选择本次生成使用的图片模型" : "选择本次使用的文本模型"}
                options={modelPickerUsesVision ? VISION_MODEL_PREFERENCE_OPTIONS : MODEL_PREFERENCE_OPTIONS}
              />
            </div>
          <div
            className={`composer-input-wrap${draggingFiles ? " dragging" : ""}`}
            onDragEnter={onComposerDragEnter}
            onDragOver={onComposerDragOver}
            onDragLeave={onComposerDragLeave}
            onDrop={onComposerDrop}
          >
            <textarea
              ref={inputRef}
              value={input}
              placeholder={
                pendingRequirement ? "补充说明后我就开始生成…" : result ? "继续描述要怎么改…" : "描述你要的页面…（可粘贴/拖入截图、HTML 或 ZIP 包）"
              }
              onChange={(e) => {
                if (histNavIdx !== null) setHistNavIdx(null); // 手动编辑即退出浏览
                setInput(e.target.value);
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              disabled={loading}
            />
            {draggingFiles && <div className="composer-drop-hint">松开以上传附件</div>}
          </div>
          <div className="composer-bar">
            <div className="bar-left">
              {STYLE_PROFILE_OPTIONS.length > 0 && (
                <StyleProfilePicker
                  value={styleProfileId}
                  onChange={setStyleProfileId}
                  disabled={styleLocked}
                />
              )}
            </div>
            {loading ? (
              <button className="send stop" onClick={cancelGenerate} title="停止本次生成">
                停止
              </button>
            ) : (
              <button className="send" onClick={() => send()} disabled={!canSend}>
                发送
              </button>
            )}
          </div>
        </div>
      </div>

      <PreviewPane
        result={result}
        liveCode={liveCode}
        tab={tab}
        onTab={setTab}
        previewDeviceMode={previewDeviceMode}
        onPreviewDeviceMode={changePreviewDeviceMode}
        mobilePreviewShell={mobilePreviewShell}
        onMobilePreviewShell={changeMobilePreviewShell}
        loading={loading}
        loadingHint={previewLoadingHint}
        onSend={(t, html, sid) => send(t, html, sid)}
        onDirectEdit={handleDirectEdit}
        versionIndex={histIdx}
        versionCount={history.length}
        onVersion={gotoVersion}
        onLogout={logout}
        userName={userName}
        stylePicker={StyleProfilePicker}
        requirementCardsOpen={requirementCardsOpen}
        onRequirementCardsOpen={changeRequirementCardsOpen}
        onUpdateRequirementCards={updateRequirementCards}
        exportTitle={exportTitle}
        onExportTitleChange={(name: string) => setExportTitle(name || null)}
      />
    </div>
  );
}
