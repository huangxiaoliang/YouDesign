"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type ReactNode,
  type SVGProps,
} from "react";
import { withBase } from "@/lib/basePath";
import ReactMarkdown from "react-markdown";
import type {
  GenerationResult,
  MobilePreviewShell,
  PreviewDeviceMode,
  RequirementCard,
  RequirementCardLink,
  RequirementCardSet,
} from "@/lib/types";
import { RequirementCardsPanel } from "@/components/RequirementCardsPanel";
import { buildRequirementCardsSectionHtml } from "@/lib/requirementCardUtils";
import { applyMobileNarrowFrame, injectHistoryBridge } from "@/lib/exportInline";
import { buildCapturedPagePreview } from "@/lib/capturedPage";
import { EXAMPLE_PROMPTS } from "@/app/example-prompts";
import { STYLE_PROFILE_OPTIONS } from "@/lib/style/profiles";
import { MoreMenu } from "@/components/MoreMenu";
import { DirectHtmlInspector, type DirectHtmlInspectorSelection } from "@/components/DirectHtmlInspector";
import {
  DIRECT_EDIT_SELECTED_ATTR,
  DIRECT_EDIT_STYLE_ATTR,
  DirectEditBaselineRegistry,
  DirectEditHistory,
  applyDirectEditChange,
  captureDirectStyle,
  captureDirectText,
  composeDirectTextAfter,
  describeDirectEditElement,
  getDirectEditElementPath,
  readDirectTextBinding,
  resolveDirectEditElement,
  stripDirectEditArtifacts,
  validateDirectStyleInput,
  type DirectEditChange,
  type DirectTextKind,
} from "@/lib/directHtmlEditor";
import {
  guardPreviewNavigation,
  isExpectedPreviewDocument,
  PREVIEW_POINT_SELECT_ATTR,
  stripPreviewNavigationGuard,
} from "@/lib/previewNavigation";

/** 内联 SVG 图标（替代 antd-mobile-icons，仅预览外壳 chrome 用，避免引入该依赖）。
 *  path 取自 antd-mobile-icons 原始定义，viewBox 0 0 48 48、fill currentColor、1em。 */
function MobileIcon({ path, ...props }: { path: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
      style={{ verticalAlign: "-0.125em", ...props.style }}
      className={["antd-mobile-icon", props.className].filter(Boolean).join(" ")}
    >
      <path d={path} fill="currentColor" fillRule="nonzero" />
    </svg>
  );
}
const CheckOutline = (props: SVGProps<SVGSVGElement>) => (
  <MobileIcon
    path="M44.309608,12.6841286 L21.2180499,35.5661955 L21.2180499,35.5661955 C20.6343343,36.1446015 19.6879443,36.1446015 19.1042286,35.5661955 C19.0538201,35.5162456 19.0077648,35.4636155 18.9660627,35.4087682 C18.9113105,35.368106 18.8584669,35.3226694 18.808302,35.2729607 L3.6903839,20.2920499 C3.53346476,20.1365529 3.53231192,19.8832895 3.68780898,19.7263704 C3.7629255,19.6505669 3.86521855,19.6079227 3.97193622,19.6079227 L7.06238923,19.6079227 C7.16784214,19.6079227 7.26902895,19.6495648 7.34393561,19.7237896 L20.160443,32.4236157 L20.160443,32.4236157 L40.656066,12.115858 C40.7309719,12.0416387 40.8321549,12 40.9376034,12 L44.0280571,12 C44.248971,12 44.4280571,12.1790861 44.4280571,12.4 C44.4280571,12.5067183 44.3854124,12.609012 44.309608,12.6841286 Z"
    {...props}
  />
);
const LeftOutline = (props: SVGProps<SVGSVGElement>) => (
  <MobileIcon
    path="M31.7053818,5.11219264 L13.5234393,22.6612572 L13.5234393,22.6612572 C12.969699,23.2125856 12.9371261,24.0863155 13.4257204,24.6755735 L13.5234393,24.7825775 L31.7045714,42.8834676 C31.7795345,42.9580998 31.8810078,43 31.9867879,43 L35.1135102,43 C35.3344241,43 35.5135102,42.8209139 35.5135102,42.6 C35.5135102,42.4936115 35.4711279,42.391606 35.3957362,42.316542 L16.7799842,23.7816937 L16.7799842,23.7816937 L35.3764658,5.6866816 C35.5347957,5.53262122 35.5382568,5.27937888 35.3841964,5.121049 C35.3088921,5.04365775 35.205497,5 35.0975148,5 L31.9831711,5 C31.8795372,5 31.7799483,5.04022164 31.7053818,5.11219264 Z"
    {...props}
  />
);
const MoreOutline = (props: SVGProps<SVGSVGElement>) => (
  <MobileIcon
    path="M12,21 C13.6568542,21 15,22.3431458 15,24 C15,25.6568542 13.6568542,27 12,27 C10.3431458,27 9,25.6568542 9,24 C9,22.3431458 10.3431458,21 12,21 Z M24,21 C25.6568542,21 27,22.3431458 27,24 C27,25.6568542 25.6568542,27 24,27 C22.3431458,27 21,25.6568542 21,24 C21,22.3431458 22.3431458,21 24,21 Z M36,21 C37.6568542,21 39,22.3431458 39,24 C39,25.6568542 37.6568542,27 36,27 C34.3431458,27 33,25.6568542 33,24 C33,22.3431458 34.3431458,21 36,21 Z"
    {...props}
  />
);
const MinusOutline = (props: SVGProps<SVGSVGElement>) => (
  <MobileIcon
    path="M41.1,22.5 C41.3209139,22.5 41.5,22.6790861 41.5,22.9 L41.5,25.1 C41.5,25.3209139 41.3209139,25.5 41.1,25.5 L6.9,25.5 C6.6790861,25.5 6.5,25.3209139 6.5,25.1 L6.5,22.9 C6.5,22.6790861 6.6790861,22.5 6.9,22.5 L41.1,22.5 Z"
    {...props}
  />
);

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Selected extends Box {
  label: string;
  outerHTML: string;
  anchorId: string;
}
type DirectEditSelectionState = DirectHtmlInspectorSelection & { element: HTMLElement };
interface RequirementLinkBox extends Box {
  cardId: string;
  linkId: string;
  label: string;
  valid: boolean;
  /** 同一目标元素被多个 link 关联时的堆叠序号(0=首个)：渲染时按此横向错开，
   * 避免 marker 精确重叠致顶层抢光 pointer、底层 marker 无法悬停(一标多卡场景)。 */
  stackIdx: number;
}

const MOBILE_SHELLS: Record<
  MobilePreviewShell,
  {
    label: string;
    width: number;
    height: number;
    status: string;
  }
> = {
  wecom: { label: "企微", width: 390, height: 844, status: "企业微信 H5" },
  ios: { label: "苹果", width: 393, height: 852, status: "iOS WebView" },
  android: { label: "安卓", width: 412, height: 915, status: "Android WebView" },
};

const DIRECT_EDIT_STYLE_PROPERTIES = [
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "color",
  "padding",
  "margin",
  "gap",
  "background-color",
  "border-color",
  "border-width",
  "border-style",
  "border-radius",
  "box-shadow",
  "opacity",
] as const;

export function PreviewPane({
  result,
  liveCode,
  tab,
  onTab,
  previewDeviceMode,
  onPreviewDeviceMode,
  mobilePreviewShell,
  onMobilePreviewShell,
  loading,
  loadingHint,
  onSend,
  onDirectEdit,
  versionIndex,
  versionCount,
  onVersion,
  onLogout,
  userName,
  emptyContent,
  stylePicker,
  requirementCardsOpen,
  onRequirementCardsOpen,
  onUpdateRequirementCards,
  exportTitle,
  onExportTitleChange,
}: {
  result: GenerationResult | null;
  liveCode: string;
  tab: "preview" | "code";
  onTab: (t: "preview" | "code") => void;
  previewDeviceMode: PreviewDeviceMode;
  onPreviewDeviceMode: (mode: PreviewDeviceMode) => void;
  mobilePreviewShell: MobilePreviewShell;
  onMobilePreviewShell: (shell: MobilePreviewShell) => void;
  loading: boolean;
  loadingHint?: string;
  onSend: (text: string, htmlOverride?: string, styleProfileId?: string) => void;
  onDirectEdit: (html: string) => void;
  versionIndex: number;
  versionCount: number;
  onVersion: (idx: number) => void;
  onLogout: () => void;
  userName?: string;
  emptyContent?: ReactNode;
  /** 标注修改对话框的风格选择器(复用首页 StyleProfilePicker,避免循环依赖) */
  stylePicker?: ComponentType<{ value: string; onChange: (v: string) => void; disabled?: boolean; noHoverPreview?: boolean }>;
  requirementCardsOpen: boolean;
  onRequirementCardsOpen: (open: boolean) => void;
  onUpdateRequirementCards: (set: RequirementCardSet) => void;
  /** 导出/分享文件名（null=未手动改，回退 flow.title）；随会话持久化 */
  exportTitle?: string | null;
  onExportTitleChange?: (name: string) => void;
}) {
  const preview = result?.preview;
  const code = result?.code || liveCode;
  // 仅预览时注入，不能污染导出、直接编辑保存或点选修改送回的原始 HTML。
  const guardedPreviewHtml = useMemo(
    () => guardPreviewNavigation(buildCapturedPagePreview(preview?.html ?? "", result?.captureMeta)),
    [preview?.html, result?.captureMeta]
  );
  // 标注编辑后重载预览：恢复到操作前的滚动位置（仅标注修改/删除触发；版本切换/直接编辑/首屏生成不受影响）
  const annoCaptureRef = useRef(false); // 标注编辑已发出，等待下一次预览重载时还原滚动
  const restoreScrollRef = useRef(false); // 本次重载由标注编辑触发，onLoad 时还原
  const pendingScrollRef = useRef<{ x: number; y: number } | null>(null); // 操作前的滚动位置
  const [reloadKey, setReloadKey] = useState(0);
  const [navigationRecovered, setNavigationRecovered] = useState(false);
  useEffect(() => {
    // 标注编辑触发的重载：标记 onLoad 时还原 sendElement 抓取的滚动位置
    if (annoCaptureRef.current) {
      restoreScrollRef.current = true;
      annoCaptureRef.current = false;
    }
    setNavigationRecovered(false);
    resetPreviewNavTracking();
    setReloadKey((k) => k + 1);
  }, [preview?.html]);

  const hasPreview = Boolean(preview?.html);
  // DPL 沙箱已移除：预览统一为可编辑的原生/原样 HTML（srcDoc 渲染）
  const isSandbox = false;
  const isRaw = Boolean(preview?.html) && !isSandbox; // 原样/原生 HTML(同源)可直接编辑
  const automaticDevice = result?.device ?? "pc";
  const effectivePreviewDevice = previewDeviceMode === "auto" ? automaticDevice : previewDeviceMode;
  const mobile = effectivePreviewDevice === "mobile"; // 仅控制预览视口，不回写原型 device
  const mobileShell = MOBILE_SHELLS[mobilePreviewShell];
  const mobileShellStyle = {
    "--preview-device-width": `${mobileShell.width}px`,
    "--preview-device-height": `${mobileShell.height}px`,
  } as CSSProperties;
  const previewModeLabel =
    previewDeviceMode === "auto"
      ? automaticDevice === "mobile"
        ? `自动/${mobileShell.label}`
        : "自动"
      : previewDeviceMode === "mobile"
        ? `手机/${mobileShell.label}`
        : "桌面";
  const shellPageTitle = result?.flow.title?.trim() || "页面预览";
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const deviceMenuRef = useRef<HTMLDivElement>(null);
  const deviceMenuOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deviceMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [markup, setMarkup] = useState(false);
  const [linkingCardId, setLinkingCardId] = useState<string | null>(null);
  const [activeRequirementCardId, setActiveRequirementCardId] = useState<string | null>(null);
  const [requirementLinkBoxes, setRequirementLinkBoxes] = useState<RequirementLinkBox[]>([]);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  // 需求卡↔marker 连线：hover marker 或卡时显示贝塞尔曲线（失效 link 用虚线）
  const [hoveredMarkerKey, setHoveredMarkerKey] = useState<string | null>(null);
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  const [hoverLinkLines, setHoverLinkLines] = useState<{ from: { x: number; y: number }; to: { x: number; y: number }; invalid: boolean; hovered: boolean }[]>([]);
  const [editMode, setEditMode] = useState(false); // 原生 HTML 单元素属性编辑模式
  const [dirty, setDirty] = useState(false);
  const [directEditSelection, setDirectEditSelection] = useState<DirectEditSelectionState | null>(null);
  const [directEditHistoryState, setDirectEditHistoryState] = useState({ canUndo: false, canRedo: false });
  const [note, setNote] = useState("");
  const [annoStyleId, setAnnoStyleId] = useState(""); // 标注修改对话框选的风格档案(""=保持原样)
  const [fs, setFs] = useState(false); // 浏览器全屏态（Esc 退出会同步）
  const [fsHint, setFsHint] = useState(false); // 全屏进入后短暂的"按 Esc 退出"提示
  const [exporting, setExporting] = useState(false); // 导出 HTML（内联运行时）中
  // 桌面端导出成功后的保存路径（非 null 即弹"已保存"提示）；网页端无此桥，恒为 null 不弹
  const [exportSavedPath, setExportSavedPath] = useState<string | null>(null);
  // SSR 和客户端首帧都按网页端渲染，挂载后再探测 Electron bridge。
  const [isDesktop, setIsDesktop] = useState(false);
  // 导出前选择是否附带需求卡（仅当有卡时弹此框）
  const [cardsDialogAction, setCardsDialogAction] = useState<"export" | null>(null);
  const [includeCards, setIncludeCards] = useState(false);
  // 导出/分享弹窗里的文件名输入值（开弹窗时初始化）
  const [exportName, setExportName] = useState("");
  const canMarkup = isRaw && tab === "preview" && !loading;
  const canStartRequirementLink = hasPreview && !loading;
  const canLinkRequirement = canStartRequirementLink && tab === "preview";
  const canEdit = isRaw && tab === "preview" && !loading;

  // 标注：原样 HTML(同源)点选元素；DPL 沙箱不支持标注
  const elementMode = markup && isRaw;
  const requirementLinkMode = Boolean(linkingCardId) && canLinkRequirement;

  // 标注与编辑互斥
  function toggleMarkup() {
    setEditMode(false);
    setLinkingCardId(null);
    setMarkup((v) => !v);
    if (!markup) onRequirementCardsOpen(false); // 互斥：开点选修改时关需求卡
  }
  function toggleEdit() {
    setMarkup(false);
    setLinkingCardId(null);
    setEditMode((v) => !v);
    if (!editMode) onRequirementCardsOpen(false); // 互斥：开编辑时关需求卡
  }
  function toggleFullscreen() {
    // 全屏 .preview-content（含预览舞台 + 需求卡面板 + 连线），让全屏下面板/连线不消失
    const el = previewContentRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void el.requestFullscreen().catch(() => {});
    }
  }

  // —— 点选元素（原样 HTML）——
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const editBaselineHtmlRef = useRef<string | null>(null);
  const editStyleRef = useRef<HTMLStyleElement | null>(null);
  const directEditSessionTokenRef = useRef("");
  const directEditSessionDocRef = useRef<Document | null>(null);
  const directEditSelectionRef = useRef<HTMLElement | null>(null);
  const directEditSelectionPathRef = useRef<HTMLElement[]>([]);
  const directEditSelectionKeyRef = useRef(0);
  const directEditOriginalMarkerRef = useRef<{ element: HTMLElement; value: string | null } | null>(null);
  const directEditHistoryRef = useRef(new DirectEditHistory());
  const directEditBaselinesRef = useRef(new DirectEditBaselineRegistry());
  const [frameTick, setFrameTick] = useState(0);
  const [hover, setHover] = useState<Box | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [canParent, setCanParent] = useState(false);
  const anchorSeqRef = useRef(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const previewBodyRef = useRef<HTMLDivElement>(null);
  const previewContentRef = useRef<HTMLDivElement>(null);
  const [canPreviewGoBack, setCanPreviewGoBack] = useState(false);
  const canPreviewGoBackRef = useRef(false);
  const postMessageHandlerRef = useRef<((e: MessageEvent) => void) | null>(null);
  const navPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [wecomMenuOpen, setWecomMenuOpen] = useState(false);
  const wecomMenuRef = useRef<HTMLDivElement>(null);
  // 外壳状态栏显示真实本地时间（对齐真机截图观感），但不能在 render 期取时间。
  const [shellTime, setShellTime] = useState("--:--");
  useEffect(() => {
    const formatShellTime = () => {
      const d = new Date();
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    setShellTime(formatShellTime());
    const timer = setInterval(() => {
      setShellTime(formatShellTime());
    }, 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setIsDesktop(Boolean((window as Window & { youdesignDesktop?: unknown }).youdesignDesktop));
  }, []);
  // 桌面端：监听导出下载完成，拿到保存路径弹"已保存到 X"提示；网页端无此桥不注册
  useEffect(() => {
    if (!isDesktop) return;
    const desktop = (window as Window & { youdesignDesktop?: { onExportSaved?: (cb: (p: string) => void) => () => void } }).youdesignDesktop;
    if (!desktop?.onExportSaved) return;
    return desktop.onExportSaved((p) => {
      if (typeof p === "string" && p) setExportSavedPath(p);
    });
  }, [isDesktop]);
  // 「已拦截原型跳转」黄条只作短暂提示，不长期占位
  useEffect(() => {
    if (!navigationRecovered) return;
    const timer = setTimeout(() => setNavigationRecovered(false), 3500);
    return () => clearTimeout(timer);
  }, [navigationRecovered]);
  // 点 ⋯ 菜单外部时收起
  useEffect(() => {
    if (!wecomMenuOpen) return;
    const onDocDown = (e: MouseEvent) => {
      if (wecomMenuRef.current && !wecomMenuRef.current.contains(e.target as Node)) setWecomMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [wecomMenuOpen]);

  // 通过 postMessage + 轮询双通道从 iframe 的 guard 脚本获取导航栈状态
  function installPreviewNavListener() {
    if (postMessageHandlerRef.current) {
      window.removeEventListener("message", postMessageHandlerRef.current);
    }
    if (navPollRef.current) {
      clearInterval(navPollRef.current);
      navPollRef.current = null;
    }
    const handler = (e: MessageEvent) => {
      if (e.data?.source !== "youdesign-preview" || e.data?.type !== "yd-nav-change") return;
      setCanPreviewGoBack(e.data.canGoBack === true);
      // 切页后子页 DOM 可能还在 React 异步渲染，rAF+短延迟后再重定位 marker 并检测失配
      window.requestAnimationFrame(() => window.setTimeout(() => revalidateRef.current(), 120));
    };
    postMessageHandlerRef.current = handler;
    window.addEventListener("message", handler);
    // 轮询兜底：每 400ms 直接读 iframe 的 __ydCanGoBack()，防止 postMessage 丢失
    navPollRef.current = setInterval(() => {
      const cw = iframeRef.current?.contentWindow as any;
      if (!cw) return;
      try {
        const can = cw.__ydCanGoBack ? cw.__ydCanGoBack() : undefined;
        if (can !== undefined && can !== canPreviewGoBackRef.current) {
          canPreviewGoBackRef.current = can;
          setCanPreviewGoBack(can);
          window.setTimeout(() => revalidateRef.current(), 120);
        }
      } catch {
        /* iframe 可能正在重载 */
      }
    }, 400);
    setCanPreviewGoBack(false);
  }

  function resetPreviewNavTracking() {
    if (postMessageHandlerRef.current) {
      window.removeEventListener("message", postMessageHandlerRef.current);
      postMessageHandlerRef.current = null;
    }
    if (navPollRef.current) {
      clearInterval(navPollRef.current);
      navPollRef.current = null;
    }
    canPreviewGoBackRef.current = false;
    setCanPreviewGoBack(false);
  }

  function installPreviewHistoryTracking() {
    installPreviewNavListener();
  }

  function handleWecomPreviewBack() {
    if (!canPreviewGoBack) {
      return;
    }
    const cw = iframeRef.current?.contentWindow as any;
    if (!cw) return;
    // 调用 guard 脚本的自定义回退，不依赖 history.back()（srcdoc iframe 中不可靠）
    const result = cw.__ydGoBack?.();
    if (result === false) setCanPreviewGoBack(false);
  }

  function handleWecomGoHome() {
    const cw = iframeRef.current?.contentWindow as any;
    if (!cw) return;
    const result = cw.__ydGoHome?.();
    if (result === false) setCanPreviewGoBack(false);
  }

  // 原型 JS 状态可能因 DOM 层回退与内部 state 失配（React 条件渲染的固有限制）；
  // 刷新预览把 iframe 重置回原型初始态，是失配时的逃生口。
  function handleWecomRefresh() {
    setWecomMenuOpen(false);
    reloadOriginalPreview();
  }

  useEffect(
    () => () => {
      resetPreviewNavTracking();
    },
    []
  );

  function clearDeviceMenuTimers() {
    if (deviceMenuOpenTimerRef.current) clearTimeout(deviceMenuOpenTimerRef.current);
    if (deviceMenuCloseTimerRef.current) clearTimeout(deviceMenuCloseTimerRef.current);
    deviceMenuOpenTimerRef.current = null;
    deviceMenuCloseTimerRef.current = null;
  }

  function scheduleDeviceMenuOpen() {
    if (!hasPreview || loading || deviceMenuOpen) return;
    if (deviceMenuCloseTimerRef.current) clearTimeout(deviceMenuCloseTimerRef.current);
    if (deviceMenuOpenTimerRef.current) clearTimeout(deviceMenuOpenTimerRef.current);
    deviceMenuOpenTimerRef.current = setTimeout(() => {
      deviceMenuOpenTimerRef.current = null;
      setDeviceMenuOpen(true);
    }, 200);
  }

  function scheduleDeviceMenuClose() {
    if (deviceMenuOpenTimerRef.current) clearTimeout(deviceMenuOpenTimerRef.current);
    deviceMenuOpenTimerRef.current = null;
    if (deviceMenuCloseTimerRef.current) clearTimeout(deviceMenuCloseTimerRef.current);
    // 给鼠标跨过页签与下拉之间的视觉间距留出余量。
    deviceMenuCloseTimerRef.current = setTimeout(() => {
      deviceMenuCloseTimerRef.current = null;
      setDeviceMenuOpen(false);
    }, 160);
  }

  function handlePreviewTabClick() {
    onTab("preview");
    if (!hasPreview || loading) return;
    clearDeviceMenuTimers();
    setDeviceMenuOpen(true);
  }

  useEffect(() => {
    if (!deviceMenuOpen) return;
    function handlePointerDown(event: MouseEvent) {
      if (deviceMenuRef.current && !deviceMenuRef.current.contains(event.target as Node)) {
        clearDeviceMenuTimers();
        setDeviceMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setDeviceMenuOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [deviceMenuOpen]);

  useEffect(() => {
    if (!hasPreview || loading) {
      clearDeviceMenuTimers();
      setDeviceMenuOpen(false);
    }
  }, [hasPreview, loading]);

  useEffect(() => () => clearDeviceMenuTimers(), []);

  function reloadOriginalPreview() {
    setReloadKey((k) => k + 1);
  }

  useEffect(() => {
    if (!canMarkup) setMarkup(false);
  }, [canMarkup]);
  useEffect(() => {
    if (!canStartRequirementLink) setLinkingCardId(null);
  }, [canStartRequirementLink]);
  useEffect(() => {
    if (!canEdit) setEditMode(false);
  }, [canEdit]);
  // 跟踪浏览器全屏态（用户按 Esc 退出时同步）
  useEffect(() => {
    const onCh = () => setFs(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onCh);
    return () => document.removeEventListener("fullscreenchange", onCh);
  }, []);
  // 手机外壳适应窗口：预览区装不下设备自然尺寸时整体 transform 缩放。
  // transform 不改变内部 390px 布局宽度，iframe 媒体查询、点选高亮、需求卡 marker
  // 都在缩放容器内部、统一随容器缩放，坐标天然一致；点徽标可在「自动适应/100%」间切换。
  const [shellFitScale, setShellFitScale] = useState(1);
  const [shellFitNeeded, setShellFitNeeded] = useState(false);
  const [shellFitEnabled, setShellFitEnabled] = useState(true);
  useEffect(() => {
    if (!mobile) {
      setShellFitNeeded(false);
      setShellFitScale(1);
      return;
    }
    const body = previewBodyRef.current;
    if (!body) return;
    const compute = () => {
      const availW = body.clientWidth - 40; // .preview-body.mobile padding 20*2
      const availH = body.clientHeight - 40;
      const naturalW = mobileShell.width + 16;
      const naturalH = mobileShell.height + 16;
      const need = availW < naturalW || availH < naturalH;
      const scale = need ? Math.max(0.25, Math.min(1, availW / naturalW, availH / naturalH)) : 1;
      setShellFitNeeded(need);
      setShellFitScale(scale);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(body);
    return () => ro.disconnect();
  }, [mobile, mobileShell.width, mobileShell.height]);
  // 全屏时外壳已有自己的收缩规则（.preview-stage.mobile:fullscreen），不再叠加缩放
  const shellScale = mobile && !fs && shellFitEnabled && shellFitNeeded ? shellFitScale : 1;
  const shellFitActive = shellScale < 1;
  // 进入全屏后浮一个几秒钟的退出提示
  useEffect(() => {
    if (!fs) {
      setFsHint(false);
      return;
    }
    setFsHint(true);
    const t = setTimeout(() => setFsHint(false), 1500);
    return () => clearTimeout(t);
  }, [fs]);
  useEffect(() => {
    // 关掉标注或切换原型时清理
    if (!markup && !requirementLinkMode) clearFrameAnchors();
    setHover(null);
    setSelected(null);
    setNote("");
  }, [markup, requirementLinkMode, preview?.html]);
  useEffect(() => {
    if (requirementCardsOpen) return;
    // 关侧栏时退出"点选关联"：避免预览停在十字光标 + 点击捕获，但卡片上下文已隐藏
    setLinkingCardId(null);
    setSelected(null);
    setHover(null);
    clearHoverLink();
    try {
      iframeRef.current?.contentDocument?.querySelectorAll("[data-yd-anchor]").forEach((node) => node.removeAttribute("data-yd-anchor"));
    } catch {
      /* iframe 可能正在重载 */
    }
  }, [requirementCardsOpen]);
  useEffect(() => {
    // iframe 改变宽度后媒体查询会重排，旧的点选坐标不再可靠。
    clearFrameAnchors();
    setHover(null);
    setSelected(null);
    setNote("");
    // 外层画布可能因前一次长设备预览保留滚动位置；切换设备时始终从外壳顶部开始展示。
    if (!mobile) return;
    const body = previewBodyRef.current;
    body?.scrollTo({ top: 0, left: 0 });
    const resetFrame = window.requestAnimationFrame(() => body?.scrollTo({ top: 0, left: 0 }));
    return () => window.cancelAnimationFrame(resetFrame);
  }, [effectivePreviewDevice, mobile, mobilePreviewShell]);
  // 标注编辑结束（含 no-op/失败未产生新版本）：清掉待还原标记，避免泄漏到下次无关重载
  useEffect(() => {
    if (!loading) annoCaptureRef.current = false;
  }, [loading]);

  function removeDirectEditStyle(style = editStyleRef.current) {
    if (!style) return;
    style.remove();
    if (editStyleRef.current === style) editStyleRef.current = null;
  }

  function cleanupDirectEditArtifacts(doc?: Document | null) {
    removeDirectEditStyle();
    try {
      const original = directEditOriginalMarkerRef.current;
      if (original) {
        if (original.value === null) original.element.removeAttribute(DIRECT_EDIT_SELECTED_ATTR);
        else original.element.setAttribute(DIRECT_EDIT_SELECTED_ATTR, original.value);
      }
      directEditOriginalMarkerRef.current = null;
      const token = directEditSessionTokenRef.current;
      if (token) {
        doc?.querySelectorAll(`[${DIRECT_EDIT_SELECTED_ATTR}="${token}"]`).forEach((node) => node.removeAttribute(DIRECT_EDIT_SELECTED_ATTR));
      }
    } catch {
      /* iframe 可能正在重载 */
    }
  }

  function readDirectEditSelection(element: HTMLElement): DirectEditSelectionState {
    const computed = element.ownerDocument.defaultView?.getComputedStyle(element);
    const styles: Record<string, string> = {};
    for (const property of DIRECT_EDIT_STYLE_PROPERTIES) {
      styles[property] = computed?.getPropertyValue(property).trim() || "";
    }
    const path = getDirectEditElementPath(element);
    directEditSelectionPathRef.current = path;
    return {
      element,
      selectionKey: directEditSelectionKeyRef.current,
      label: describeDirectEditElement(element),
      breadcrumbs: path.map((item) => describeDirectEditElement(item).split(" · ")[0]),
      text: readDirectTextBinding(element),
      styles,
    };
  }

  function refreshDirectEditSelection() {
    const element = directEditSelectionRef.current;
    if (!element?.isConnected) {
      directEditSelectionRef.current = null;
      directEditSelectionPathRef.current = [];
      setDirectEditSelection(null);
      return;
    }
    setDirectEditSelection(readDirectEditSelection(element));
  }

  function syncDirectEditHistoryState() {
    const history = directEditHistoryRef.current;
    setDirectEditHistoryState({ canUndo: history.canUndo, canRedo: history.canRedo });
    setDirty(history.hasChanges);
  }

  function clearDirectEditSelection() {
    const original = directEditOriginalMarkerRef.current;
    if (original) {
      if (original.value === null) original.element.removeAttribute(DIRECT_EDIT_SELECTED_ATTR);
      else original.element.setAttribute(DIRECT_EDIT_SELECTED_ATTR, original.value);
    }
    directEditOriginalMarkerRef.current = null;
    directEditSelectionRef.current = null;
    directEditSelectionPathRef.current = [];
    setDirectEditSelection(null);
  }

  function selectDirectEditElement(element: HTMLElement) {
    clearDirectEditSelection();
    directEditSelectionKeyRef.current += 1;
    directEditSelectionRef.current = element;
    directEditOriginalMarkerRef.current = { element, value: element.getAttribute(DIRECT_EDIT_SELECTED_ATTR) };
    element.setAttribute(DIRECT_EDIT_SELECTED_ATTR, directEditSessionTokenRef.current);
    setDirectEditSelection(readDirectEditSelection(element));
  }

  function selectDirectEditAncestor(index: number) {
    const element = directEditSelectionPathRef.current[index];
    if (element?.isConnected) selectDirectEditElement(element);
  }

  function selectDirectEditParent() {
    const path = directEditSelectionPathRef.current;
    if (path.length > 1) selectDirectEditElement(path[path.length - 2]);
  }

  useEffect(() => {
    if (!editMode) {
      cleanupDirectEditArtifacts(directEditSessionDocRef.current);
      directEditSessionDocRef.current = null;
      directEditSessionTokenRef.current = "";
      directEditSelectionRef.current = null;
      directEditSelectionPathRef.current = [];
      setDirectEditSelection(null);
      directEditHistoryRef.current.clear();
      directEditBaselinesRef.current.clear();
      setDirectEditHistoryState({ canUndo: false, canRedo: false });
      setDirty(false);
      editBaselineHtmlRef.current = null;
      return;
    }
    const doc = iframeRef.current?.contentDocument;
    if (!doc || !doc.body) return;
    if (directEditSessionDocRef.current !== doc) {
      cleanupDirectEditArtifacts(directEditSessionDocRef.current);
      directEditSessionDocRef.current = doc;
      directEditSessionTokenRef.current = `yd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      editBaselineHtmlRef.current = serializePreviewDocument(doc);
      directEditHistoryRef.current.clear();
      directEditBaselinesRef.current.clear();
      directEditSelectionRef.current = null;
      directEditSelectionPathRef.current = [];
      setDirectEditSelection(null);
      setDirectEditHistoryState({ canUndo: false, canRedo: false });
      setDirty(false);
    }
    removeDirectEditStyle();
    const token = directEditSessionTokenRef.current;
    const style = doc.createElement("style");
    style.setAttribute(DIRECT_EDIT_STYLE_ATTR, token);
    style.textContent =
      "body *{cursor:crosshair!important}" +
      "body *:hover{outline:1px dashed rgba(22,119,255,.48)!important;outline-offset:2px!important}" +
      `[${DIRECT_EDIT_SELECTED_ATTR}="${token}"]{outline:2px solid #1677ff!important;outline-offset:2px!important}`;
    doc.head?.appendChild(style);
    editStyleRef.current = style;
    const onClick = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const element = resolveDirectEditElement(e.target);
      if (!element) return;
      selectDirectEditElement(element);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      clearDirectEditSelection();
    };
    doc.addEventListener("click", onClick, true);
    doc.addEventListener("keydown", onKeyDown, true);
    return () => {
      try {
        doc.removeEventListener("click", onClick, true);
        doc.removeEventListener("keydown", onKeyDown, true);
        removeDirectEditStyle(style);
      } catch {
        /* iframe 可能正在重载 */
      }
    };
  }, [editMode, frameTick]);

  function chooseMarkedElement(doc: Document, e: MouseEvent) {
    const view = doc.defaultView;
    const HtmlElement = view?.HTMLElement ?? HTMLElement;
    const stack = doc.elementsFromPoint(e.clientX, e.clientY).filter((el): el is HTMLElement => el instanceof HtmlElement);
    if (!stack.length) return undefined;
    const top = stack[0];
    // 只允许选「顶层可见元素及其祖先」:绝不让被抽屉/弹窗/遮罩盖住的背景元素被选中
    // (旧实现 fall-through 会穿透 elementsFromPoint 栈,点抽屉空白却选中背后菜单/按钮)
    const candidates = stack
      .filter((el) => el === top || el.contains(top))
      .filter((el) => el !== doc.body && el !== doc.documentElement);
    if (!candidates.length) return top;
    const preferred = candidates.find((el) =>
      el.matches('th,td,button,a,input,textarea,select,label,[role="button"],[role="columnheader"],[role="cell"],.dpl-table-cell,.dpl-table-column-title')
    );
    if (preferred) return preferred;
    const area = (view?.innerWidth ?? window.innerWidth) * (view?.innerHeight ?? window.innerHeight);
    const found = candidates.find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.width * r.height < area * 0.45;
    });
    if (found) return found;
    // 全部候选都过大(整个抽屉/弹窗/遮罩):返回最小的可见元素,绝不穿透到被遮住的背景
    let smallest = candidates[0];
    let smallestArea = Infinity;
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > 0 && a < smallestArea) {
        smallestArea = a;
        smallest = el;
      }
    }
    return smallest;
  }

  // 把给定元素标记为锚点并更新选中态(点选与「上扩父级」共用)
  function anchorElement(el: HTMLElement) {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    doc.querySelectorAll("[data-yd-anchor]").forEach((node) => node.removeAttribute("data-yd-anchor"));
    const anchorId = `yd-${Date.now().toString(36)}-${(anchorSeqRef.current++).toString(36)}`;
    el.setAttribute("data-yd-anchor", anchorId);
    const r = el.getBoundingClientRect();
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24);
    setSelected({
      x: r.left,
      y: r.top,
      w: r.width,
      h: r.height,
      label: `<${el.tagName.toLowerCase()}>${text ? ` 「${text}」` : ""}`,
      outerHTML: (el.outerHTML || "").slice(0, 30000),
      anchorId,
    });
    // 是否还能上扩到更外层容器(到 body/documentElement 为止,不允许锚定整页 body)
    let p: HTMLElement | null = el.parentElement;
    while (p && (p === doc.body || p === doc.documentElement)) p = p.parentElement;
    setCanParent(!!p && p !== el);
  }

  // 选中当前锚点元素的上一级容器(连按可继续上扩,用于选中整个抽屉/卡片等大容器)
  function expandToParent() {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const cur = doc.querySelector("[data-yd-anchor]") as HTMLElement | null;
    if (!cur) return;
    let p: HTMLElement | null = cur.parentElement;
    while (p && (p === doc.body || p === doc.documentElement)) p = p.parentElement;
    if (!p || p === cur) return;
    anchorElement(p);
  }

  function cssEscape(value: string) {
    return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
  }

  function selectorForElement(el: HTMLElement) {
    const doc = el.ownerDocument;
    const id = el.getAttribute("id");
    if (id) {
      const selector = `#${cssEscape(id)}`;
      if (doc.querySelectorAll(selector).length === 1) return selector;
    }
    const stableAttrs = ["data-testid", "data-test", "data-key", "data-id", "aria-label", "name", "placeholder", "title"];
    for (const attr of stableAttrs) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const selector = `${el.tagName.toLowerCase()}[${attr}="${cssEscape(value)}"]`;
      if (doc.querySelectorAll(selector).length === 1) return selector;
    }
    return domPathForElement(el);
  }

  function domPathForElement(el: HTMLElement) {
    const parts: string[] = [];
    let current: HTMLElement | null = el;
    // 不能截断深度：真实原型嵌套常 >8 层（如表单内按钮 12 层），截断后路径加了 body> 前缀但首段并非 body 直接子元素，
    // 导致整条 domPath 解析为空 → locateRequirementLink 落到模糊文本回退、定位到错误元素（marker 乱跑）。
    while (current && current !== current.ownerDocument.body && current !== current.ownerDocument.documentElement) {
      const tag = current.tagName.toLowerCase();
      const parent: HTMLElement | null = current.parentElement;
      if (!parent) break;
      const currentTag = current.tagName;
      const sameTagSiblings = Array.from(parent.children).filter((node: Element) => node.tagName === currentTag);
      const index = sameTagSiblings.indexOf(current) + 1;
      parts.unshift(`${tag}:nth-of-type(${Math.max(index, 1)})`);
      current = parent;
    }
    return parts.length ? `body > ${parts.join(" > ")}` : el.tagName.toLowerCase();
  }

  function labelForElement(el: HTMLElement) {
    const text =
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.getAttribute("name") ||
      (el.textContent || "").trim().replace(/\s+/g, " ");
    const tag = el.tagName.toLowerCase();
    return text ? `${tag} · ${text.slice(0, 32)}` : tag;
  }

  function locateRequirementLink(link: RequirementCardLink) {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return null;
    // iframe 元素属于预览 iframe 自己的 realm，跨 realm `instanceof HTMLElement`（父窗口构造器）恒为 false，
    // 会致选择器/text 分支都判不出元素、恒返回 null。取 iframe 自己的 HTMLElement 构造器（与 chooseMarkedElement 对齐）。
    const HtmlElement = doc.defaultView?.HTMLElement ?? HTMLElement;
    const selectors = [link.anchor.selector, link.anchor.domPath].filter(Boolean) as string[];
    for (const selector of selectors) {
      try {
        const found = doc.querySelector(selector);
        if (found instanceof HtmlElement) return found;
      } catch {
        /* selector may be stale */
      }
    }
    const targetText = link.anchor.text?.replace(/\s+/g, " ").trim();
    if (targetText) {
      const targetRole = link.anchor.role;
      const roleOf = (node: Element) => node.getAttribute("role") || node.tagName.toLowerCase();
      const textOf = (node: Element) => (node.textContent || node.getAttribute("aria-label") || node.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim();
      const all = Array.from(doc.body?.querySelectorAll("button,a,input,textarea,select,label,th,td,h1,h2,h3,p,span,div") ?? []) as HTMLElement[];
      const exact: HTMLElement[] = [];
      const partial: HTMLElement[] = [];
      for (const node of all) {
        if (!(node instanceof HtmlElement)) continue;
        const text = textOf(node);
        if (!text) continue;
        if (text === targetText) exact.push(node);
        // 只用正向包含（targetText 是 anchor 存的可能截断的前缀，元素实际文本可能更长）；
        // 去掉 targetText.includes(text) 反向匹配——会把「查」「询」等无关短文本元素误判为目标。
        else if (text.includes(targetText)) partial.push(node);
      }
      // 收紧：anchor 记录了 role（关联时 el.getAttribute("role") || tagName.toLowerCase()）时，只接受 role 匹配的候选。
      // 避免切到子页面后 text 回退命中同名异类元素（父页 <a>「经营看板」vs 子页 <button>/<div>），marker 跑偏还假装有效。
      const byRole = (arr: HTMLElement[]) => targetRole ? arr.filter((n) => roleOf(n) === targetRole) : arr;
      let pick = byRole(exact);
      if (!pick.length) pick = byRole(partial);
      // 精确匹配优先；其次部分包含。排序：textContent 最短=最具体（避免命中只含子文本的大容器），
      // 长度相同再按子元素数升序（叶子优先，命中按钮本身而非其文字外包层）。
      if (pick.length) {
        pick.sort((a, b) => textOf(a).length - textOf(b).length || a.childElementCount - b.childElementCount);
        return pick[0];
      }
    }
    return null;
  }

  function allRequirementLinks() {
    return result?.requirementCardSet?.cards.flatMap((card) =>
      (card.links ?? []).map((link) => ({ card, link }))
    ) ?? [];
  }

  function refreshRequirementLinkBoxes() {
    const boxes: RequirementLinkBox[] = [];
    // 同一目标元素被多个 link 关联时，按命中顺序记堆叠序号，渲染时错开 marker。
    const stackCount = new Map<Element, number>();
    for (const { card, link } of allRequirementLinks()) {
      const el = locateRequirementLink(link);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      // 遮挡判定：元素被同文档内更高层元素（抽屉/弹层/遮罩）盖住时不画 marker，
      // 避免 marker 压在打开的弹层上方。与 chooseMarkedElement 的"顶层及其祖先"防穿透判定对称：
      // elementFromPoint 返回的顶层若不是 el 自身、也不是 el 的子孙，说明被无关元素盖住了。
      // 仅影响渲染（不画 marker/连线），不写 link.anchor.valid、不落库（遮挡是瞬时 UI 状态）。
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const top = el.ownerDocument?.elementFromPoint(cx, cy) ?? null;
      if (top && top !== el && !el.contains(top)) continue;
      const stackIdx = stackCount.get(el) ?? 0;
      stackCount.set(el, stackIdx + 1);
      boxes.push({
        cardId: card.id,
        linkId: link.id,
        label: link.label,
        valid: link.anchor.valid,
        x: rect.left,
        y: rect.top,
        w: rect.width,
        h: rect.height,
        stackIdx,
      });
    }
    setRequirementLinkBoxes(boxes);
  }

  /** 切页（yd-nav-change）后重定位 + 失配检测：
   *  - 总是重算 marker 位置（refreshRequirementLinkBoxes）。
   *  - 非 inherited 状态下重算每个 link.anchor.valid：元素命中且 rect>0 才有效；失配（selector 失败/text 回退无果或元素隐藏 rect=0）置 false，
   *    切回父页元素回来再恢复 true。inherited 状态（原型版本变更全失效待复核）不动 valid，只重算位置，避免与继承横幅冲突。 */
  function revalidateRequirementLinks() {
    const set = result?.requirementCardSet;
    refreshRequirementLinkBoxes();
    if (!set || set.status === "inherited") return;
    let changed = false;
    const cards = set.cards.map((card) => ({
      ...card,
      links: card.links?.map((link) => {
        const el = locateRequirementLink(link);
        let valid = false;
        if (el) { const r = el.getBoundingClientRect(); valid = r.width > 0 && r.height > 0; }
        if (valid !== link.anchor.valid) { changed = true; return { ...link, anchor: { ...link.anchor, valid } }; }
        return link;
      }),
    }));
    if (changed) onUpdateRequirementCards({ ...set, cards, updatedAt: Date.now() });
  }

  /** 计算 hover 连线坐标（相对 .preview-content 左上角）。marker 与卡都在父窗口 realm，可直接 DOM 测量。
   *  hover marker → 1 条线（marker 右中 → 卡左中）；hover 卡 → 该卡所有 marker 的线。 */
  /** 计算所有 marker↔卡 连线（常显细虚线）；hover 的线带 hovered=true（render 时粗实线）。
   *  marker 在 preview-content 内（iframe 上方）；需求卡是被拖走的 fixed 浮窗（可能在 preview-content 外），用 document 查。
   *  坐标用视口坐标（连线 SVG 是 position:fixed 全屏覆盖，超出预览区也不被裁）。 */
  function computeHoverLinkLines(): { from: { x: number; y: number }; to: { x: number; y: number }; invalid: boolean; hovered: boolean }[] {
    const content = previewContentRef.current;
    if (!content) return [];
    const lines: { from: { x: number; y: number }; to: { x: number; y: number }; invalid: boolean; hovered: boolean }[] = [];
    for (const b of requirementLinkBoxes) {
      const marker = content.querySelector(`.req-link-marker[data-link-key="${b.cardId}--${b.linkId}"]`);
      const card = document.querySelector(`[data-req-card-id="${b.cardId}"]`);
      if (!(marker instanceof HTMLElement) || !(card instanceof HTMLElement)) continue;
      const mRect = marker.getBoundingClientRect();
      const dRect = card.getBoundingClientRect();
      if (mRect.width <= 0 || dRect.width <= 0) continue;
      const hovered = hoveredMarkerKey === `${b.cardId}--${b.linkId}` || hoveredCardId === b.cardId;
      lines.push({
        from: { x: mRect.right, y: mRect.top + mRect.height / 2 },
        to: { x: dRect.left, y: dRect.top + dRect.height / 2 },
        invalid: !b.valid,
        hovered,
      });
    }
    return lines;
  }

  function clearHoverLink() {
    setHoveredMarkerKey(null);
    setHoveredCardId(null);
  }

  function updateRequirementCard(cardId: string, updater: (card: RequirementCard) => RequirementCard) {
    const set = result?.requirementCardSet;
    if (!set) return;
    const nextSet: RequirementCardSet = {
      ...set,
      updatedAt: Date.now(),
      cards: set.cards.map((card) => card.id === cardId ? updater(card) : card),
    };
    onUpdateRequirementCards(nextSet);
  }

  function cancelRequirementLink() {
    setLinkingCardId(null);
    setSelected(null);
    setHover(null);
    clearFrameAnchors();
  }

  function confirmRequirementLink() {
    if (!selected || !linkingCardId) return;
    const doc = iframeRef.current?.contentDocument;
    const el = doc?.querySelector(`[data-yd-anchor="${cssEscape(selected.anchorId)}"]`) as HTMLElement | null;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const card = result?.requirementCardSet?.cards.find((item) => item.id === linkingCardId);
    if (!card) return;
    const now = Date.now();
    const link: RequirementCardLink = {
      id: `RL-${now.toString(36)}`,
      label: labelForElement(el),
      artifactVersion: result?.sessionBrief?.artifactVersion ?? versionIndex + 1,
      anchor: {
        kind: "semantic",
        selector: selectorForElement(el),
        domPath: domPathForElement(el),
        text: (el.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().replace(/\s+/g, " ").slice(0, 80),
        role: el.getAttribute("role") || el.tagName.toLowerCase(),
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        valid: true,
      },
      createdAt: now,
    };
    updateRequirementCard(card.id, (current) => ({
      ...current,
      links: [...(current.links ?? []), link],
    }));
    clearFrameAnchors();
    setSelected(null);
    setHover(null);
    setLinkingCardId(null);
    setActiveRequirementCardId(card.id);
    setLinkNotice("已关联区块");
    window.setTimeout(() => setLinkNotice(null), 1600);
  }

  function startRequirementLink(cardId: string) {
    if (!canStartRequirementLink) return;
    if (linkingCardId === cardId) { cancelRequirementLink(); return; }
    setEditMode(false);
    setMarkup(false);
    setLinkNotice(null);
    setActiveRequirementCardId(cardId);
    setSelected(null);
    setHover(null);
    setLinkingCardId(cardId);
    onRequirementCardsOpen(true);
    onTab("preview");
  }

  function focusRequirementLink(cardId: string, linkId: string) {
    const item = allRequirementLinks().find(({ card, link }) => card.id === cardId && link.id === linkId);
    if (!item) return;
    setLinkingCardId(null);
    setMarkup(false);
    setEditMode(false);
    setActiveRequirementCardId(cardId);
    onRequirementCardsOpen(true);
    onTab("preview");
    window.requestAnimationFrame(() => {
      const el = locateRequirementLink(item.link);
      if (!el) {
        setLinkNotice("未找到关联区块，请打开对应页面状态后重新查看或重新关联");
        window.setTimeout(() => setLinkNotice(null), 2600);
        return;
      }
      el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      window.setTimeout(() => {
        refreshRequirementLinkBoxes();
        const rect = el.getBoundingClientRect();
        setSelected({
          x: rect.left,
          y: rect.top,
          w: rect.width,
          h: rect.height,
          label: item.link.label,
          outerHTML: "",
          anchorId: "",
        });
        window.setTimeout(() => setSelected(null), 1800);
      }, 320);
    });
  }

  function serializeFrameHtmlWithAnchor() {
    const doc = iframeRef.current?.contentDocument;
    if (!doc?.documentElement) return undefined;
    return serializePreviewDocument(doc);
  }

  // 响应式表格滚动条仅存在于预览 iframe；序列化给点选修改或直接保存时，
  // 必须还原为原来的 table 结构，避免把宿主补丁写入用户原型。
  function serializePreviewDocument(doc: Document) {
    const root = doc.documentElement.cloneNode(true) as HTMLElement;
    root.removeAttribute(PREVIEW_POINT_SELECT_ATTR);
    stripDirectEditArtifacts(root, directEditSessionTokenRef.current);
    root.querySelector("#__yd_preview_table_guard_style")?.remove();
    root.querySelectorAll("[data-yd-preview-table-scroll-group]").forEach((group) => {
      group.removeAttribute("data-yd-preview-table-scroll-group");
    });
    root.querySelectorAll('[data-yd-preview-table-scroll="wrapper"]').forEach((wrapper) => {
      wrapper.replaceWith(...Array.from(wrapper.childNodes));
    });
    return stripPreviewNavigationGuard(`<!DOCTYPE html>\n${root.outerHTML}`);
  }

  function updateDirectStyle(property: string, rawValue: string) {
    const element = directEditSelectionRef.current;
    if (!element) return;
    const validation = validateDirectStyleInput(property, rawValue, (candidateProperty, candidateValue) => {
      const css = element.ownerDocument.defaultView?.CSS;
      return typeof css?.supports === "function" ? css.supports(candidateProperty, candidateValue) : true;
    });
    if (!validation.valid) return;
    const before = captureDirectStyle(element, property);
    const value = validation.value;
    if (value) element.style.setProperty(property, value, "important");
    else element.style.removeProperty(property);
    const after = captureDirectStyle(element, property);
    const change: DirectEditChange = { kind: "style", element, property, before, after };
    directEditBaselinesRef.current.remember(change);
    directEditHistoryRef.current.record([change], `style:${property}`);
    refreshDirectEditSelection();
    syncDirectEditHistoryState();
  }

  function updateDirectText(value: string) {
    const element = directEditSelectionRef.current;
    const binding = element ? readDirectTextBinding(element) : null;
    if (!element || !binding) return;
    const textKind: DirectTextKind = binding.kind;
    const nodeIndex = binding.nodeIndex;
    const before = captureDirectText(element, textKind, nodeIndex);
    const after = composeDirectTextAfter(before, textKind, value);
    const change: DirectEditChange = { kind: "text", element, textKind, nodeIndex, before, after };
    applyDirectEditChange(change, "after");
    const applied: DirectEditChange = { ...change, after: captureDirectText(element, textKind, nodeIndex) };
    directEditBaselinesRef.current.remember(applied);
    directEditHistoryRef.current.record([applied], `text:${textKind}`);
    refreshDirectEditSelection();
    syncDirectEditHistoryState();
  }

  function undoDirectEdit() {
    if (!directEditHistoryRef.current.undo()) return;
    refreshDirectEditSelection();
    syncDirectEditHistoryState();
  }

  function redoDirectEdit() {
    if (!directEditHistoryRef.current.redo()) return;
    refreshDirectEditSelection();
    syncDirectEditHistoryState();
  }

  function resetDirectEditElement() {
    const element = directEditSelectionRef.current;
    if (!element) return;
    const changes = directEditBaselinesRef.current.buildResetChanges(element);
    if (!changes.length) return;
    for (const change of changes) applyDirectEditChange(change, "after");
    directEditHistoryRef.current.record(changes);
    refreshDirectEditSelection();
    syncDirectEditHistoryState();
  }

  function clearFrameAnchors() {
    try {
      iframeRef.current?.contentDocument?.querySelectorAll("[data-yd-anchor]").forEach((node) => node.removeAttribute("data-yd-anchor"));
    } catch {
      /* iframe 可能正在重载 */
    }
  }

  function saveEdit() {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return setEditMode(false);
    try {
      cleanupDirectEditArtifacts(doc);
      const html = serializePreviewDocument(doc);
      if (html !== editBaselineHtmlRef.current) onDirectEdit(html); // 直接写回，不调用模型
    } catch {
      /* noop */
    }
    editBaselineHtmlRef.current = null;
    setDirty(false);
    setEditMode(false);
  }
  function discardEdit() {
    const doc = iframeRef.current?.contentDocument;
    cleanupDirectEditArtifacts(doc);
    editBaselineHtmlRef.current = null;
    setEditMode(false);
    setDirty(false);
    reloadOriginalPreview(); // 重载丢弃改动
  }

  async function buildExportHtml(opts?: { includeCards?: boolean; filename?: string }) {
    const title = opts?.filename || result?.flow.title || "原型预览";
    if (!preview?.html) return undefined;
    let html = preview.html.startsWith("<!") || preview.html.startsWith("<html")
      ? preview.html
      : `<!DOCTYPE html>\n${preview.html}`;
    // 抓取页的 preview.html 是原始抓取产物（iframe 未解析、外链 stylesheet 未剥、脚本已失活）。
    // 预览时 buildCapturedPagePreview 仅在 srcDoc 边界临时重建；导出必须同样重建一次，
    // 否则导出的 HTML 离线打开时 iframe 为空、外链 CSS 丢失、SPA 脚本不执行 -> 空白。
    // 对非抓取页 buildCapturedPagePreview 原样返回，不影响普通 HTML 导出。
    html = buildCapturedPagePreview(html, result?.captureMeta);
    if (opts?.includeCards) {
      const set = result?.requirementCardSet;
      if (set && set.cards.length > 0) {
        const section = await buildRequirementCardsSectionHtml(set);
        html = /<\/body>\s*<\/html>\s*$/i.test(html)
          ? html.replace(/<\/body>/i, `${section}\n</body>`)
          : `${html}\n${section}`;
      }
    }
    // 预览切移动端但生成结果实为 PC 时，套一层窄框移动样式（CSS 压窄，非真移动端重生成）。
    // 真移动端（automaticDevice==="mobile"）已有自己的 viewport + 390 容器，跳过避免二次收窄。
    if (mobile && automaticDevice !== "mobile") {
      // 给 iframe 内的原型注入预览守卫（回退栈 + 导航拦截 + 表格滚动），与预览一致；
      // 再由外层 history bridge 把浏览器后退接到 iframe 的 __ydGoBack，让导出/分享
      // 链接也能用系统返回回退多级页面（srcdoc 自身 history 不可靠，借外层 history）。
      html = guardPreviewNavigation(html);
      html = applyMobileNarrowFrame(html, mobileShell.width);
      html = injectHistoryBridge(html);
    }
    const safe = title.replace(/[\\/:*?"<>|]/g, "_").trim() || "prototype";
    return { html, filename: /\.html?$/i.test(safe) ? safe : `${safe}.html` };
  }

  // 导出 HTML：原样/原生 HTML 直接下载自包含文件；DPL 沙箱把运行时内联成 data URL，离线可开
  async function exportHtml(includeCards = false, filename?: string) {
    setExporting(true);
    let payload: Awaited<ReturnType<typeof buildExportHtml>>;
    try {
      payload = await buildExportHtml({ includeCards, filename });
    } finally {
      setExporting(false);
    }
    if (!payload) return;
    const { html, filename: fn } = payload;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fn;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  // 默认导出名：用户改过的 exportTitle 优先，否则回退 flow.title
  function defaultExportName() {
    return (exportTitle && exportTitle.trim()) || result?.flow.title || "原型预览";
  }

  // 分享/导出：都先弹窗让用户确认文件名（+ 有卡时勾选附带卡）；改名持久化到 exportTitle
  function onClickExport() {
    setIncludeCards(false);
    setExportName(defaultExportName());
    setCardsDialogAction("export");
  }

  function confirmCardsDialog() {
    const action = cardsDialogAction;
    const include = includeCards;
    const name = exportName.trim();
    setCardsDialogAction(null);
    // 改名持久化（不同步会话标题）
    if (name && onExportTitleChange) onExportTitleChange(name);
    if (action === "export") void exportHtml(include, name || undefined);
  }

  useEffect(() => {
    refreshRequirementLinkBoxes();
  }, [result?.requirementCardSet?.updatedAt, frameTick, preview?.html]);

  // hover 连线随 hover 状态、marker 位置（滚动/resize 由 requirementLinkBoxes 更新驱动）、iframe 重载重算
  useEffect(() => {
    setHoverLinkLines(computeHoverLinkLines());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredMarkerKey, hoveredCardId, requirementLinkBoxes]);

  // marker 层在编辑/标注/关联点选模式或无 marker 时不渲染；元素被 React 卸载时 mouseleave 不保证触发，
  // 这里在 marker 层隐藏时主动清理 hover，避免残留"幽灵线"。
  useEffect(() => {
    if (editMode || markup || requirementLinkMode || requirementLinkBoxes.length === 0) {
      clearHoverLink();
    }
  }, [editMode, markup, requirementLinkMode, requirementLinkBoxes.length]);

  useEffect(() => {
    if (!hasPreview) {
      setRequirementLinkBoxes([]);
      return;
    }
    const cw = iframeRef.current?.contentWindow;
    if (!cw) return;
    let raf = 0;
    const schedule = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(refreshRequirementLinkBoxes);
    };
    // scroll 不冒泡：原型常是「固定侧栏 + 中间区独立滚动」（如仪表盘 content-wrapper），内层滚动容器的
    // scroll 事件到不了 contentWindow，marker 会钉死不跟随。开 capture 在捕获阶段从 contentWindow 往下收，
    // 才能命中 iframe 文档内任意节点的滚动；resize 本就只在 window 触发，保持冒泡即可。
    cw.addEventListener("scroll", schedule, { passive: true, capture: true });
    cw.addEventListener("resize", schedule);
    // 抽屉/弹层常带 transform/opacity/visibility 过渡：class 变化瞬间 MutationObserver 已触发一次刷新，
    // 但遮罩 overlay 的 visibility 走过渡时（visible→hidden 在过渡结束才生效），关闭瞬间遮挡判定会落空
    // （overlay 仍可见→背景 marker 误判遮挡、不恢复）。transitionend 冒泡，capture 收一次过渡结束态再刷。
    cw.addEventListener("transitionend", schedule, { passive: true, capture: true });
    return () => {
      window.cancelAnimationFrame(raf);
      cw.removeEventListener("scroll", schedule, { capture: true });
      cw.removeEventListener("resize", schedule);
      cw.removeEventListener("transitionend", schedule, { capture: true });
    };
    // reloadKey 必须在依赖里：iframe 元素被替换（直接编辑/版本切换等触发 setReloadKey）时，
    // frameTick（onLoad 后才 bump）可能晚于重挂，导致监听仍绑在旧 contentWindow 上、resize 不重定位 marker。
  }, [frameTick, hasPreview, result?.requirementCardSet?.updatedAt, reloadKey]);

  // 顶层 window resize 监听挂载一次、永不随 iframe 重挂拆除：viewport 变化时必触发 marker 重定位。
  // Effect2 在 iframe 重挂的多次 render 间存在 cleanup→重绑的时序窗口，期间 viewport resize 会漏掉；
  // 用 ref 持有最新 refresh，监听只挂一次、独立于 iframe 生命周期。
  const refreshLinkBoxesRef = useRef(refreshRequirementLinkBoxes);
  refreshLinkBoxesRef.current = refreshRequirementLinkBoxes;
  // revalidate（切页重定位+失配检测）同样用 ref 持有，供 yd-nav-change message handler / 轮询兜底调用
  const revalidateRef = useRef(revalidateRequirementLinks);
  revalidateRef.current = revalidateRequirementLinks;
  useEffect(() => {
    let raf = 0;
    const schedule = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => refreshLinkBoxesRef.current());
    };
    window.addEventListener("resize", schedule);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  // 抽屉/弹层开关不触发 scroll/resize/iframe 尺寸变化，预览守卫也只在"亮出新视图"时发 yd-nav-change
  // （单纯关闭弹层不入栈、不发消息）。这里给 iframe 文档挂 MutationObserver：任何 DOM 变化（class/style
  // 显隐切换、节点增删）都节流触发 marker 重算（含上面的遮挡判定），覆盖抽屉/弹层开关场景。
  // 与守卫同口径观察但不碰 nav 栈，职责分离；refresh 走 ref 避免闭包旧函数。
  useEffect(() => {
    if (!hasPreview) return;
    const doc = iframeRef.current?.contentDocument;
    // iframe 刚因 reloadKey 重建时，contentDocument 可能已可读、但 srcDoc 还未解析出 <html>。
    // 此时 documentElement 为 null；等待 onLoad 推进 frameTick 后本 effect 会重跑并绑定到新文档。
    const root = doc?.documentElement;
    if (!root || typeof MutationObserver === "undefined") return;
    let raf = 0;
    const schedule = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => refreshLinkBoxesRef.current());
    };
    const mo = new MutationObserver(schedule);
    mo.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    return () => {
      window.cancelAnimationFrame(raf);
      mo.disconnect();
    };
    // reloadKey/frameTick 同 scroll effect：iframe 重挂后重新 observe 新的 contentDocument。
  }, [frameTick, hasPreview, reloadKey]);

  // ResizeObserver 观察 iframe 元素本身：viewport/面板变化致 iframe 尺寸变时必触发（比 window resize 事件更可靠，
  // 不受 iframe 重挂时序影响）。reloadKey 变（iframe 替换）时重新 observe 新元素。
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => refreshLinkBoxesRef.current());
    });
    ro.observe(iframe);
    return () => {
      window.cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [reloadKey, hasPreview]);

  // 给 iframe 文档挂 hover/点选监听（同源才可）
  useEffect(() => {
    if (!elementMode && !requirementLinkMode) return;
    const doc = iframeRef.current?.contentDocument;
    // 点选模式也可能恰好在 iframe 重建窗口开启；根节点未就绪时交给 onLoad 后的 frameTick 重跑。
    const root = doc?.documentElement;
    if (!doc || !root) return;
    root.setAttribute(PREVIEW_POINT_SELECT_ATTR, "true");
    const onHover = (e: Event) => {
      const el = e.target as HTMLElement;
      if (!el || el === doc.body || el === doc.documentElement) return setHover(null);
      const r = el.getBoundingClientRect();
      setHover({ x: r.left, y: r.top, w: r.width, h: r.height });
    };
    const onClick = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const el = chooseMarkedElement(doc, e as MouseEvent) ?? (e.target as HTMLElement);
      if (!el) return;
      anchorElement(el);
      setNote("");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && requirementLinkMode) cancelRequirementLink();
    };
    doc.addEventListener("mousemove", onHover, true);
    doc.addEventListener("click", onClick, true);
    doc.addEventListener("keydown", onKey, true);
    try {
      doc.body.style.cursor = "crosshair";
    } catch {
      /* noop */
    }
    return () => {
      doc.removeEventListener("mousemove", onHover, true);
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("keydown", onKey, true);
      root.removeAttribute(PREVIEW_POINT_SELECT_ATTR);
      try {
        doc.body.style.cursor = "";
      } catch {
        /* noop */
      }
    };
  }, [elementMode, requirementLinkMode, frameTick]);

  function sendElement() {
    if (!selected) return;
    const isDelete = /删除|删掉|移除|去掉|清除|清空/.test(note);
    // 删除指令不适用风格;纯风格(无指令)时合成"按X风格重绘"
    const styleId = annoStyleId && !isDelete ? annoStyleId : undefined;
    if (!note.trim() && !styleId) return; // 没指令也没风格 -> 不发
    let instructionNote = note.trim();
    if (!instructionNote && styleId) {
      const name = STYLE_PROFILE_OPTIONS.find((p) => p.id === styleId)?.name ?? "所选";
      instructionNote = `按${name}风格重绘这个元素`;
    }
    const html = serializeFrameHtmlWithAnchor();
    const anchorStillThere = html ? html.includes(`data-yd-anchor="${selected.anchorId}"`) : false;
    console.log(
      `[anno-send] anchorId=${selected.anchorId} outerHtmlLen=${selected.outerHTML.length} serializedLen=${
        html?.length ?? 0
      } anchorInSerialized=${anchorStillThere} instr="${instructionNote.slice(0, 60)}"`
    );
    // 抓取操作前的滚动位置，预览重载后还原，让用户停在原处看修改/删除结果
    const cw = iframeRef.current?.contentWindow;
    if (cw) pendingScrollRef.current = { x: cw.scrollX, y: cw.scrollY };
    annoCaptureRef.current = true;
    onSend(
      `针对页面中这个元素附近进行修改：${instructionNote}\n\n目标元素（请在原 HTML 中精确定位，以它为锚点选择合适作用域修改，其余保持不变）：\n<!-- yd-anchor:${selected.anchorId} -->\n${selected.outerHTML}`,
      html,
      styleId
    );
    clearFrameAnchors();
    setMarkup(false);
    setAnnoStyleId(""); // 发送后重置风格选择
  }

  return (
    <div className="preview">
      <div className="preview-header">
        <div className="seg">
          <div
            className={`preview-tab-combo${tab === "preview" ? " active" : ""}`}
            ref={deviceMenuRef}
            onMouseEnter={() => {
              if (deviceMenuCloseTimerRef.current) clearTimeout(deviceMenuCloseTimerRef.current);
              scheduleDeviceMenuOpen();
            }}
            onMouseLeave={scheduleDeviceMenuClose}
          >
            <button
              className="preview-tab-main"
              type="button"
              onClick={handlePreviewTabClick}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" || !hasPreview || loading) return;
                event.preventDefault();
                onTab("preview");
                clearDeviceMenuTimers();
                setDeviceMenuOpen(true);
              }}
              aria-haspopup={hasPreview ? "menu" : undefined}
              aria-expanded={hasPreview ? deviceMenuOpen : undefined}
              title={hasPreview ? "点击或悬停 0.2 秒选择预览视口" : "预览"}
            >
              预览{hasPreview ? ` · ${previewModeLabel}` : ""}
              {hasPreview && <span className="preview-tab-arrow" aria-hidden="true">▾</span>}
            </button>
            {hasPreview && deviceMenuOpen && (
              <div
                className="preview-device-menu"
                role="menu"
                aria-label="预览设备"
                onMouseEnter={() => {
                  if (deviceMenuCloseTimerRef.current) clearTimeout(deviceMenuCloseTimerRef.current);
                }}
              >
                {(
                  [
                    {
                      value: "auto",
                      label: "自动",
                      detail:
                        automaticDevice === "mobile"
                          ? `当前：手机 · ${mobileShell.label}`
                          : "当前：桌面",
                    },
                    {
                      value: "mobile",
                      label: "手机",
                      detail: `当前：${mobileShell.label} · ${mobileShell.width}×${mobileShell.height}`,
                    },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`preview-device-option${previewDeviceMode === option.value ? " selected" : ""}`}
                    role="menuitemradio"
                    aria-checked={previewDeviceMode === option.value}
                    onClick={() => {
                      onPreviewDeviceMode(option.value);
                      onTab("preview");
                      clearDeviceMenuTimers();
                      setDeviceMenuOpen(false);
                    }}
                  >
                    <span className="preview-device-check">
                      {previewDeviceMode === option.value && <CheckOutline aria-hidden="true" />}
                    </span>
                    <span className="preview-device-copy">
                      <strong>{option.label}</strong>
                      <small>{option.detail}</small>
                    </span>
                  </button>
                ))}
                <div className="preview-mobile-shells" role="group" aria-label="手机预览外壳">
                  {(Object.entries(MOBILE_SHELLS) as Array<[MobilePreviewShell, (typeof MOBILE_SHELLS)[MobilePreviewShell]]>).map(
                    ([shell, config]) => {
                      const selected = previewDeviceMode === "mobile" && mobilePreviewShell === shell;
                      return (
                        <button
                          key={shell}
                          type="button"
                          className={`preview-device-option preview-mobile-shell-option${selected ? " selected" : ""}`}
                          role="menuitemradio"
                          aria-checked={selected}
                          onClick={() => {
                            onMobilePreviewShell(shell);
                            onTab("preview");
                            clearDeviceMenuTimers();
                            setDeviceMenuOpen(false);
                          }}
                        >
                          <span className="preview-device-check">
                            {selected && <CheckOutline aria-hidden="true" />}
                          </span>
                          <span className="preview-device-copy">
                            <strong>{config.label}{shell === "wecom" ? "（默认）" : ""}</strong>
                            <small>{config.status} · {config.width}×{config.height}</small>
                          </span>
                        </button>
                      );
                    }
                  )}
                </div>
                <button
                  type="button"
                  className={`preview-device-option${previewDeviceMode === "pc" ? " selected" : ""}`}
                  role="menuitemradio"
                  aria-checked={previewDeviceMode === "pc"}
                  onClick={() => {
                    onPreviewDeviceMode("pc");
                    onTab("preview");
                    clearDeviceMenuTimers();
                    setDeviceMenuOpen(false);
                  }}
                >
                  <span className="preview-device-check">
                    {previewDeviceMode === "pc" && <CheckOutline aria-hidden="true" />}
                  </span>
                  <span className="preview-device-copy">
                    <strong>桌面</strong>
                    <small>铺满预览区域</small>
                  </span>
                </button>
              </div>
            )}
          </div>
          <button className={tab === "code" ? "active" : ""} onClick={() => onTab("code")}>
            代码
          </button>
        </div>
        <div className="ph-center">
          {hasPreview && (
            <>
              {versionCount > 1 && (
                <span className="ver-nav" title="版本回退">
                  <button
                    className="ver-btn"
                    onClick={() => onVersion(versionIndex - 1)}
                    disabled={loading || versionIndex <= 0}
                    title="上一版"
                  >
                    ↩
                  </button>
                  <span className="ver-idx">
                    {versionIndex + 1}/{versionCount}
                  </span>
                  <button
                    className="ver-btn"
                    onClick={() => onVersion(versionIndex + 1)}
                    disabled={loading || versionIndex >= versionCount - 1}
                    title="下一版"
                  >
                    ↪
                  </button>
                </span>
              )}
              {tab === "preview" && (
                <button
                  className="mark-btn"
                  onClick={toggleFullscreen}
                  disabled={loading}
                  title="全屏预览（进入后按 Esc 退出）"
                >
                  ⛶ 全屏
                </button>
              )}
              {tab === "preview" && isRaw && (
                <button
                  className={`mark-btn${editMode ? " on" : ""}`}
                  onClick={toggleEdit}
                  disabled={!canEdit}
                  title="点选元素修改文案、文字、间距与容器外观（不调用 AI，即时生效）"
                >
                  ✎ 普通编辑
                </button>
              )}
              {tab === "preview" && (
                <button
                  className={`mark-btn${markup ? " on" : ""}`}
                  onClick={toggleMarkup}
                  disabled={!canMarkup}
                  title="点选页面元素，描述要怎么改（交给 AI）"
                >
                  ✦ 点选AI修改
                </button>
              )}
              <button
                className={`mark-btn${requirementCardsOpen ? " on" : ""}`}
                onClick={() => {
                  const next = !requirementCardsOpen;
                  onRequirementCardsOpen(next);
                  if (next) { setMarkup(false); setEditMode(false); setLinkingCardId(null); } // 互斥：开需求卡时关点选修改/编辑
                }}
                disabled={!result || loading}
                title={requirementCardsOpen ? "隐藏需求卡" : "打开需求卡"}
              >
                {requirementCardsOpen ? "☑ 需求卡" : `☑ 需求卡${result?.requirementCardSet ? ` · ${result.requirementCardSet.cards.length}` : ""}`}
              </button>
              <button
                className="mark-btn"
                onClick={onClickExport}
                disabled={loading || exporting}
                title={
                  isRaw
                    ? "导出为自包含 HTML 文件"
                    : "导出为 HTML（运行时已内联，离线双击即开）"
                }
              >
                {exporting ? "⬇ 导出中…" : "⬇ 导出"}
              </button>
            </>
          )}
        </div>
        <div className="ph-right">
          {userName && (
            <a
              className="user-name"
              href={withBase("/usage")}
              target="_blank"
              rel="noreferrer"
              title={`${userName} · 查看用量`}
            >
              {userName}
            </a>
          )}
          <MoreMenu onLogout={onLogout} />
        </div>
      </div>

      <div className="preview-content" ref={previewContentRef}>
      <div ref={previewBodyRef} className={`preview-body${mobile && tab === "preview" ? " mobile" : ""}`}>
        {tab === "code" ? (
          code ? (
            <pre>{code}</pre>
          ) : (
            <Empty />
          )
        ) : hasPreview ? (
          // display:contents 切换只改样式不改 DOM 结构，避免缩放开关导致 iframe 重挂载丢回退栈
          <div
            className="preview-stage-fit"
            style={
              shellFitActive
                ? {
                    // transform 不改变布局盒：用显式缩放后尺寸的占位容器保持画布滚动/居中正确
                    width: (mobileShell.width + 16) * shellScale,
                    height: (mobileShell.height + 16) * shellScale,
                    margin: "0 auto",
                  }
                : { display: "contents" }
            }
          >
          <div
            className={`preview-stage${mobile ? " mobile" : ""}`}
            ref={stageRef}
            style={
              mobile
                ? shellFitActive
                  ? {
                      ...mobileShellStyle,
                      width: mobileShell.width + 16,
                      height: mobileShell.height + 16,
                      margin: 0,
                      transform: `scale(${shellScale})`,
                      transformOrigin: "top left",
                    }
                  : mobileShellStyle
                : undefined
            }
          >
            <div className={`preview-device-shell${mobile ? ` mobile-shell ${mobilePreviewShell}` : " desktop"}`}>
              {mobile && (
                <>
                  <div className="mobile-shell-status" aria-hidden="true">
                    <span>{shellTime}</span>
                    <span>{mobilePreviewShell === "android" ? "5G · 100%" : "5G  100%"}</span>
                  </div>
                  {mobilePreviewShell === "wecom" && (
                    <div className="wecom-shell-nav">
                      <button
                        type="button"
                        className="wecom-shell-back"
                        onClick={handleWecomPreviewBack}
                        disabled={!canPreviewGoBack}
                        aria-label={canPreviewGoBack ? "返回上级页面" : "当前已是首页"}
                        title={canPreviewGoBack ? "返回上级页面" : "当前已是首页"}
                      >
                        <LeftOutline aria-hidden="true" />
                      </button>
                      <strong title={shellPageTitle}>{shellPageTitle}</strong>
                      <div className="wecom-shell-more-wrap" ref={wecomMenuRef}>
                        <button
                          type="button"
                          className="wecom-shell-more"
                          onClick={() => setWecomMenuOpen((v) => !v)}
                          aria-haspopup="menu"
                          aria-expanded={wecomMenuOpen}
                          aria-label="预览操作"
                          title="预览操作"
                        >
                          <MoreOutline aria-hidden="true" />
                        </button>
                        {wecomMenuOpen && (
                          <div className="wecom-shell-menu" role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              disabled={!canPreviewGoBack}
                              onClick={() => {
                                setWecomMenuOpen(false);
                                handleWecomGoHome();
                              }}
                            >
                              回到首页
                            </button>
                            <button type="button" role="menuitem" onClick={handleWecomRefresh} title="原型状态异常时重置回初始态">
                              刷新预览
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
              <div className="preview-viewport" ref={viewportRef}>
            <iframe
              key={reloadKey}
              ref={iframeRef}
              srcDoc={guardedPreviewHtml}
              title="preview"
              sandbox="allow-scripts allow-same-origin"
              onLoad={() => {
                // 运行时最终兜底：location.href / form 等绕过脚本守卫后会让 iframe
                // 离开 about:srcdoc 并加载 YouDesign 自身。发现即重建为原始 srcDoc。
                if (!isExpectedPreviewDocument(iframeRef.current)) {
                  setNavigationRecovered(true);
                  reloadOriginalPreview();
                  return;
                }
                installPreviewHistoryTracking();
                setFrameTick((t) => t + 1);
                // 标注编辑触发的重载：还原到操作前的滚动位置
                if (restoreScrollRef.current) {
                  restoreScrollRef.current = false;
                  const p = pendingScrollRef.current;
                  pendingScrollRef.current = null;
                  const cw = iframeRef.current?.contentWindow;
                  if (p && cw) {
                    cw.scrollTo(p.x, p.y);
                    // 资源回流后位置可能被重置，下一帧再校准一次
                    cw.requestAnimationFrame(() => cw.scrollTo(p.x, p.y));
                  }
                }
              }}
            />

            {navigationRecovered && <div className="preview-nav-notice" role="status">已拦截原型页面跳转，预览已恢复。</div>}
            {linkNotice && <div className="preview-nav-notice req-link-notice" role="status">{linkNotice}</div>}

            {requirementCardsOpen && requirementLinkBoxes.length > 0 && !editMode && !markup && !requirementLinkMode && (
              <div className="req-link-layer" aria-label="需求卡关联区块">
                {requirementLinkBoxes.map((box) => (
                  <button
                    key={`${box.cardId}-${box.linkId}`}
                    type="button"
                    data-link-key={`${box.cardId}--${box.linkId}`}
                    className={`req-link-marker${box.valid ? "" : " invalid"}${activeRequirementCardId === box.cardId ? " active" : ""}`}
                    // 按元素实际位置定位（不做钉边 clamp）：元素滚出预览区视窗时，marker 跟随到视窗外、
                    // 由 .preview-content 的 overflow:hidden 自然裁掉（不可见），不钉在视窗边缘误导位置。
                    // 连线 SVG 是 fixed 全屏、不受裁剪，起点用 marker 实际 rect 中心，从视窗外画到卡片。
                    // 一标多卡(多卡关联同一元素)时按 stackIdx 横向错开 24px，避免精确重叠、顶层抢 pointer。
                    style={{ left: box.x + Math.min(Math.max(box.w - 24, 0), 12) + box.stackIdx * 24, top: box.y + 4 }}
                    title={`${box.cardId} · ${box.label}${box.valid ? "" : " · 待复核"}`}
                    onMouseEnter={() => setHoveredMarkerKey(`${box.cardId}--${box.linkId}`)}
                    onMouseLeave={() => setHoveredMarkerKey(null)}
                    onClick={() => focusRequirementLink(box.cardId, box.linkId)}
                  >
                    {box.cardId.replace(/^BR-/, "") || "·"}
                  </button>
                ))}
              </div>
            )}

            {requirementLinkMode && (
              <div className="markup-layer passthrough">
                {!selected && <div className="markup-hint">点击原型区块，关联到当前需求卡</div>}
                {hover && !selected && (
                  <div className="mark-hover req-link-hover" style={{ left: hover.x, top: hover.y, width: hover.w, height: hover.h }} />
                )}
                {selected && (
                  <div className="markup-box req-link-box" style={{ left: selected.x, top: selected.y, width: selected.w, height: selected.h }} />
                )}
              </div>
            )}

            {!markup && !requirementLinkMode && selected && (
              <div className="markup-box req-link-box flash" style={{ left: selected.x, top: selected.y, width: selected.w, height: selected.h }} />
            )}

            {/* 点选元素层（原样 HTML，鼠标穿透给 iframe，只画高亮 + 浮窗） */}
            {elementMode && (
              <div className="markup-layer passthrough">
                {!selected && <div className="markup-hint">移到元素上高亮，点击选中要改的元素</div>}
                {hover && !selected && (
                  <div className="mark-hover" style={{ left: hover.x, top: hover.y, width: hover.w, height: hover.h }} />
                )}
                {selected && (
                  <div className="markup-box" style={{ left: selected.x, top: selected.y, width: selected.w, height: selected.h }} />
                )}
              </div>
            )}

            {requirementLinkMode && selected &&
              (() => {
                const stageW = viewportRef.current?.clientWidth ?? 9999;
                const stageH = viewportRef.current?.clientHeight ?? 9999;
                const popW = Math.min(260, stageW - 16);
                const left = Math.min(Math.max(8, selected.x), Math.max(8, stageW - popW - 8));
                const POP_H = 112;
                const below = selected.y + selected.h + 6;
                const top = below + POP_H <= stageH ? below : Math.max(8, selected.y - POP_H - 6);
                return (
                  <div className="markup-pop req-link-pop" style={{ left, top, width: popW }}>
                    <div className="markup-target">关联区块：{selected.label}</div>
                    <div className="markup-pop-bar">
                      <button className="link" onClick={() => setSelected(null)}>重选</button>
                      <button className="link" onClick={cancelRequirementLink}>取消</button>
                      <button
                        className="link"
                        onClick={expandToParent}
                        disabled={!canParent}
                        title="选中上一级容器"
                      >
                        ↑ 父级
                      </button>
                      <button className="send sm" onClick={confirmRequirementLink}>确认关联</button>
                    </div>
                  </div>
                );
              })()}

            {/* 修改浮窗；位置夹在 iframe 内容视口内，避免被手机外壳裁掉或坐标偏移 */}
            {markup && elementMode && selected &&
              (() => {
                const stageW = viewportRef.current?.clientWidth ?? 9999;
                const stageH = viewportRef.current?.clientHeight ?? 9999;
                const popW = Math.min(280, stageW - 16);
                const left = Math.min(Math.max(8, selected.x), Math.max(8, stageW - popW - 8));
                const POP_H = 212;
                const below = selected.y + selected.h + 6;
                const top = below + POP_H <= stageH ? below : Math.max(8, selected.y - POP_H - 6);
                return (
              <div className="markup-pop" style={{ left, top, width: popW }}>
                <div className="markup-target">已选中：{selected.label}</div>
                <textarea
                  autoFocus
                  value={note}
                  placeholder="这个元素要怎么改？"
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      sendElement();
                    }
                  }}
                />
                <div className="markup-pop-bar">
                  <button className="link" onClick={() => setSelected(null)}>
                    关闭
                  </button>
                  <button
                    className="link"
                    onClick={expandToParent}
                    disabled={!canParent}
                    title="选中上一级容器(连按可继续上扩,用于选中整个抽屉/卡片)"
                  >
                    ↑ 父级
                  </button>
                  {stylePicker && (() => {
                    const Picker = stylePicker;
                    const isDel = /删除|删掉|移除|去掉|清除|清空/.test(note);
                    return (
                      <div
                        className="markup-style-inline"
                        title={isDel ? "删除操作不适用风格" : "选择风格档案，按该风格重绘选中元素"}
                      >
                        <Picker value={annoStyleId} onChange={setAnnoStyleId} disabled={isDel} noHoverPreview />
                      </div>
                    );
                  })()}
                  <button
                    className="send sm"
                    onClick={() => sendElement()}
                    disabled={!note.trim() && !annoStyleId}
                  >
                    发送
                  </button>
                </div>
              </div>
                );
              })()}
              </div>
              {mobile && (
                <button
                  type="button"
                  className="mobile-shell-home"
                  onClick={handleWecomGoHome}
                  disabled={!canPreviewGoBack}
                  aria-label={canPreviewGoBack ? "回到原型首页" : "当前已是首页"}
                  title={canPreviewGoBack ? "回到原型首页" : "当前已是首页"}
                >
                  <MinusOutline aria-hidden="true" />
                </button>
              )}
            </div>

            {/* 全屏进入后短暂提示 */}
            {fs && fsHint && <div className="fs-hint">按 Esc 退出全屏</div>}
          </div>
          </div>
        ) : loading ? (
          <div className={`preview-stage${mobile ? " mobile" : ""}`} style={mobile ? mobileShellStyle : undefined}>
            <div className="preview-skeleton">
              <span className="spinner" />
              <span>{loadingHint || "正在生成原型…"}</span>
            </div>
          </div>
        ) : emptyContent ? (
          <>{emptyContent}</>
        ) : (
          <PreviewEmpty />
        )}
      </div>
      {editMode && (
        <DirectHtmlInspector
          selection={directEditSelection}
          canUndo={directEditHistoryState.canUndo}
          canRedo={directEditHistoryState.canRedo}
          dirty={dirty}
          canReset={Boolean(
            directEditSelection?.element &&
              directEditBaselinesRef.current.buildResetChanges(directEditSelection.element).length
          )}
          onTextChange={updateDirectText}
          onStyleChange={updateDirectStyle}
          onSelectAncestor={selectDirectEditAncestor}
          onSelectParent={selectDirectEditParent}
          onUndo={undoDirectEdit}
          onRedo={redoDirectEdit}
          onReset={resetDirectEditElement}
          onDiscard={discardEdit}
          onSave={saveEdit}
        />
      )}
      {mobile && tab === "preview" && hasPreview && !fs && shellFitNeeded && (
        <button
          type="button"
          className="preview-scale-badge"
          onClick={() => setShellFitEnabled((v) => !v)}
          title={shellFitEnabled ? "外壳已按窗口自动缩放，点击恢复 100%（画布可滚动）" : "已恢复 100%，点击按窗口自动缩放"}
        >
          {shellFitEnabled ? `${Math.round(shellScale * 100)}%` : "100%"}
        </button>
      )}
      <RequirementCardsPanel
        open={requirementCardsOpen}
        set={result?.requirementCardSet}
        title={result?.flow.title || "原型预览"}
        artifactVersion={result?.sessionBrief?.artifactVersion ?? versionIndex + 1}
        loading={loading}
        hasArtifact={Boolean(result)}
        linkingCardId={linkingCardId}
        activeCardId={activeRequirementCardId}
        onClose={() => onRequirementCardsOpen(false)}
        onUpdate={onUpdateRequirementCards}
        onStartLink={startRequirementLink}
        onFocusLink={focusRequirementLink}
        onCardHover={setHoveredCardId}
        onCardLayoutChange={() => setHoverLinkLines(computeHoverLinkLines())}
      />
      {requirementCardsOpen && hoverLinkLines.length > 0 && (
        <svg className="req-link-svg" aria-hidden="true">
          {hoverLinkLines.map((line, i) => {
            const dx = Math.max(24, (line.to.x - line.from.x) / 2);
            const d = `M ${line.from.x} ${line.from.y} C ${line.from.x + dx} ${line.from.y}, ${line.to.x - dx} ${line.to.y}, ${line.to.x} ${line.to.y}`;
            return <path key={i} d={d} className={`req-link-line${line.hovered ? " hover" : ""}${line.invalid ? " invalid" : ""}`} />;
          })}
        </svg>
      )}
      </div>
      {cardsDialogAction && (
        <div className="yd-share-mask" role="dialog" aria-modal="true" onClick={() => setCardsDialogAction(null)}>
          <div className="yd-share-modal" onClick={(e) => e.stopPropagation()}>
            <div className="yd-share-title">导出 HTML</div>
            <label className="share-filename-option">
              <span className="share-filename-label">文件名</span>
              <input
                type="text"
                className="share-filename-input"
                value={exportName}
                onChange={(e) => setExportName(e.target.value)}
                placeholder="输入文件名"
                autoFocus
              />
            </label>
            {(result?.requirementCardSet?.cards.length ?? 0) > 0 && (
              <label className="share-cards-option">
                <input
                  type="checkbox"
                  checked={includeCards}
                  onChange={(e) => setIncludeCards(e.target.checked)}
                />
                <span>附带需求卡（{result?.requirementCardSet?.cards.length ?? 0} 张，作为右侧可折叠评审面板追加到页面）</span>
              </label>
            )}
            <div className="yd-share-actions">
              <button className="mark-btn" onClick={() => setCardsDialogAction(null)}>取消</button>
              <button className="mark-btn send" disabled={exporting} onClick={confirmCardsDialog}>
                {exporting ? "处理中…" : "导出"}
              </button>
            </div>
          </div>
        </div>
      )}
      {exportSavedPath && (
        <div className="yd-share-mask" role="dialog" aria-modal="true" onClick={() => setExportSavedPath(null)}>
          <div className="yd-share-modal" onClick={(e) => e.stopPropagation()}>
            <button className="yd-share-close" onClick={() => setExportSavedPath(null)} aria-label="关闭" title="关闭">
              ✕
            </button>
            <div className="yd-share-title">已保存到下载目录</div>
            <div className="yd-share-url-row">
              <input className="yd-share-url" value={exportSavedPath} readOnly spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
              <button
                className="mark-btn"
                onClick={() => {
                  const desktop = (window as Window & { youdesignDesktop?: { revealExportFile?: (p: string) => Promise<unknown> } }).youdesignDesktop;
                  if (desktop?.revealExportFile) void desktop.revealExportFile(exportSavedPath);
                }}
                title="在文件夹中显示"
              >
                打开
              </button>
            </div>
            <div className="yd-share-tip">点"打开"在文件夹中定位该文件</div>
          </div>
        </div>
      )}
    </div>
  );
}

function Empty() {
  return <div className="empty" />;
}

/** 预览页签空态：示意提示词卡片（仅复制，清淡简约） */
function PreviewEmpty() {
  const [copied, setCopied] = useState<string | null>(null);
  const [deviceFilter, setDeviceFilter] = useState<"all" | "pc" | "mobile">("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const shuffledPrompts = useMemo(() => {
    const prompts = [...EXAMPLE_PROMPTS];
    for (let index = prompts.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [prompts[index], prompts[randomIndex]] = [prompts[randomIndex], prompts[index]];
    }
    return prompts;
  }, []);
  const categories = useMemo(() => {
    const allCategories = [...new Set(EXAMPLE_PROMPTS.map((prompt) => prompt.tag))];
    const primaryCategories = ["AI Native CRM", "AI Native CSM"];
    return [
      ...primaryCategories.filter((category) => allCategories.includes(category)),
      ...allCategories.filter((category) => !primaryCategories.includes(category)),
    ];
  }, []);
  const filteredPrompts = useMemo(
    () =>
      shuffledPrompts.filter(
        (prompt) =>
          (deviceFilter === "all" || (prompt.device ?? "pc") === deviceFilter) &&
          (categoryFilter === "all" || prompt.tag === categoryFilter),
      ),
    [categoryFilter, deviceFilter, shuffledPrompts],
  );

  async function copy(id: string, text: string) {
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else {
        // HTTP 非安全上下文兜底：临时 textarea + execCommand
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      }
    } catch {
      ok = false;
    }
    if (ok) {
      setCopied(id);
      setTimeout(() => setCopied((current) => (current === id ? null : current)), 1500);
    }
  }
  return (
    <div className="preview-empty">
      <div className="preview-empty-hint">试试这些，或直接描述你要的页面</div>
      <div className="prompt-filters" aria-label="筛选示意提示词">
        <div className="prompt-filter-group" role="group" aria-label="设备类型">
          {[
            ["all", "全部设备"],
            ["pc", "PC"],
            ["mobile", "手机"],
          ].map(([value, label]) => (
            <button
              type="button"
              className={deviceFilter === value ? "active" : undefined}
              aria-pressed={deviceFilter === value}
              key={value}
              onClick={() => setDeviceFilter(value as "all" | "pc" | "mobile")}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="prompt-filter-divider" aria-hidden="true" />
        <div className="prompt-filter-group" role="group" aria-label="产品分类">
          <button
            type="button"
            className={categoryFilter === "all" ? "active" : undefined}
            aria-pressed={categoryFilter === "all"}
            onClick={() => setCategoryFilter("all")}
          >
            全部分类
          </button>
          {categories.map((category) => (
            <button
              type="button"
              className={categoryFilter === category ? "active" : undefined}
              aria-pressed={categoryFilter === category}
              key={category}
              onClick={() => setCategoryFilter(category)}
            >
              {category}
            </button>
          ))}
        </div>
        <span className="prompt-filter-count">{filteredPrompts.length} 条</span>
      </div>
      <div className="prompt-grid">
        {filteredPrompts.map((p) => (
          <div className="prompt-card" key={p.title}>
            <div className="prompt-card-top">
              <span className="prompt-tag">{p.tag} · {(p.device ?? "pc") === "pc" ? "PC" : "手机"}</span>
              <div className="prompt-card-meta">
                <span className="prompt-contributor">贡献人：{p.contributor}</span>
                <button type="button" className="prompt-copy" onClick={() => copy(p.title, p.prompt)} title="复制提示词">
                  <span aria-hidden="true">{copied === p.title ? "✓" : "⧉"}</span>
                  <span>{copied === p.title ? "已复制" : "复制"}</span>
                </button>
              </div>
            </div>
            <div className="prompt-title">{p.title}</div>
            <div className="prompt-text">
              <ReactMarkdown>{p.prompt}</ReactMarkdown>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
