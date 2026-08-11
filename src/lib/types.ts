/** 跨层共享的领域类型 */
import type { CaptureMeta } from "@/lib/capturedPage";

/** ① 需求结构化产物：一个多页流程 */
export interface FlowSpec {
  /** 原型整体标题 */
  title: string;
  /** 一句话说明这个原型解决什么 */
  summary: string;
  /** 包含的页面（≥1） */
  pages: FlowPage[];
  /** 页面间跳转关系 */
  navigations: NavLink[];
  /** 面向生成与评审的原型验收合同；可选以兼容历史会话 */
  prototypeContract?: PrototypeContract;
}

/** 结构化阶段沉淀的产品意图与验收标准，供生成、结构自检和评审共用 */
export interface PrototypeContract {
  /** 页面类型，如「风险管理列表页」「移动端任务详情页」 */
  pageArchetype: string;
  /** 主要使用者 */
  primaryUser: string;
  /** 使用者在本页要完成的首要任务 */
  primaryJob: string;
  /** 首版原型必须可见的模块、信息或能力，按重要性排序 */
  mustHave: string[];
  /** 需要在原型中可实际操作、可观察结果的交互 */
  interactions: PrototypeInteractionContract[];
  /** 首版需要呈现或可触发的关键状态 */
  requiredStates: string[];
  /** 需求未明说、为快速生成而采用的合理假设 */
  assumptions: string[];
  /** 有截图时记录其参考方式与允许变化范围；无图/历史会话可省略 */
  visualReference?: VisualReferenceContract;
}

/** 截图的轻量参考合同：只约束保留、修改与推断边界，不增加独立视觉规划调用 */
export interface VisualReferenceContract {
  /** faithful=忠实还原；layout=只参考布局；style=只参考视觉；content=只参考内容 */
  referenceMode: "faithful" | "layout" | "style" | "content";
  /** 截图中必须保留的可见事实 */
  preserve: string[];
  /** 用户明确要求相对截图改变的内容 */
  change: string[];
  /** 截图未展示、允许为完成主任务合理补充的内容 */
  infer: string[];
}

/** 一条可演示交互的验收合同 */
export interface PrototypeInteractionContract {
  /** must=用户明确要求、必须实现；should=为完成主任务而合理补充 */
  priority: "must" | "should";
  /** 用户从哪里、通过什么动作触发 */
  trigger: string;
  /** 触发后页面发生什么 */
  result: string;
  /** 评审时能直接观察到的完成证据，不能只是 toast/alert */
  proof: string;
}

/** 单个页面 */
export interface FlowPage {
  /** 页面 id（kebab，如 list / create / detail），作为内部路由 key */
  id: string;
  /** 页面名，如 列表页 */
  name: string;
  /** 一句话描述这个页面要解决什么 */
  summary: string;
  /** 页面分区（从上到下） */
  sections: SectionSpec[];
  /** 需要的 DPL 组件（从组件目录中选取） */
  componentNeeds: ComponentNeed[];
  /** DPL 无合适组件、需用原生 HTML 手工实现的缺口（保持与 DPL 视觉一致） */
  nativeBlocks?: NativeBlock[];
  /** 关键数据字段（用于生成像样的 mock 数据） */
  dataFields: string[];
}

/** 原生兜底块：DPL 目录里没有合适组件，改用原生 HTML 实现的区块 */
export interface NativeBlock {
  name: string;
  description: string;
}

/** 页面跳转：在 from 页触发 trigger 后进入 to 页 */
export interface NavLink {
  from: string;
  /** 触发动作描述，如 "点击新建按钮" / "点击行的查看" */
  trigger: string;
  to: string;
}

/** 上传的图片（base64，不含 data: 前缀） */
export interface UploadedImage {
  mediaType: string;
  data: string;
  name?: string;
  /** 原始文件 Blob（前端独有，用于对话气泡「点击打开」+ 持久化；后端不读、不传） */
  originalBlob?: Blob;
}

/** 上传的文档（已抽成文本）：html 按技术栈转换，其余作为内容/需求依据 */
export interface UploadedDoc {
  name: string;
  kind: "html" | "markdown" | "word" | "text";
  content: string;
  /** 原始文件 Blob（前端独有，用于对话气泡「点击打开」+ 持久化；后端不读、不传） */
  originalBlob?: Blob;
  /** Chrome 抓取页的结构化元数据；普通上传文件没有此字段。 */
  captureMeta?: CaptureMeta;
}

/** 生成原型的上传依据：截图（视觉参考）+ 文档（结构/内容/需求参考） */
export interface Attachments {
  images?: UploadedImage[];
  documents?: UploadedDoc[];
}

/** 对话气泡里回显的附件：图标 + 文件名 + 可点击打开（原始文件 Blob） */
export type AttachmentFileKind = "image" | "zip" | "html" | "word" | "markdown" | "text";
export interface ChatAttachment {
  name: string;
  /** 原始文件类型，决定图标；与 UploadedDoc.kind 不同：ZIP 这里是 zip（原始文件），那边是 html（管线消费方式） */
  kind: AttachmentFileKind;
  /** 原始文件 Blob；createObjectURL 后浏览器能渲染就渲染（图/HTML/MD/Txt），不能就下载（Word/ZIP） */
  originalBlob: Blob;
  /** HTML 附件的前端处理后预览内容；桌面端打开 HTML 时优先用它生成安全预览文件。 */
  previewContent?: string;
  /** 让 Web 新标签与桌面附件沿用抓取页的离线 frame/交互策略。 */
  captureMeta?: CaptureMeta;
}

export interface ComponentNeed {
  /** DPL 组件名（必须来自注入的组件目录，防幻觉） */
  componentName: string;
  /** 在本页面的具体用法诉求，作为检索 demo 的描述 */
  description: string;
}

export interface SectionSpec {
  name: string;
  description: string;
}

/** ② 组件检索产物：真实 DPL 组件的 API 文档 + 可选 demo */
export interface RetrievedComponent {
  /** DPL 组件名，如 Button / Table */
  name: string;
  /** 检索时用的自然语言诉求 */
  query: string;
  /** 组件 API 文档（props，以此为准，防幻觉）；可能截断 */
  docs?: string;
  /** demo 代码（命中时才有） */
  demo?: string;
  /** 命中来源：dpl=真实 MCP，catalog=目录兜底，mock=离线 */
  source: "dpl" | "catalog" | "mock";
}

/** ④ 预览产物 */
export interface PreviewResult {
  /** 直接用 srcdoc 渲染的 HTML（mock 兜底 / 原样打开上传的 HTML / DPL 自托管沙箱） */
  html?: string;
  /** mock=本地占位，raw=原样渲染上传的 HTML / 生成产物 */
  source: "mock" | "raw";
}

/** 目标设备：影响生成布局与预览边框宽度 */
export type Device = "pc" | "mobile";

/** 预览视口偏好：auto 跟随原型设备，pc/mobile 仅覆盖本地预览宽度。 */
export type PreviewDeviceMode = "auto" | Device;

/** 手机预览外壳：只影响预览容器，不进入生成管线或导出 HTML。 */
export type MobilePreviewShell = "wecom" | "ios" | "android";

/** 用户选择的文本模型策略 */
export type TextModelPreference = "auto" | "kimiK3" | "deepseek" | "glm" | "sonnet" | "opus";

/** 上传图片时可选的视觉模型策略 */
export type VisionModelPreference = "kimiK3" | "sonnet" | "opus" | "glm5v";

/** 用户选择的模型策略：无图用文本模型，有图用视觉模型 */
export type ModelPreference = TextModelPreference | VisionModelPreference;

/** 会话级连续对话摘要：只随当前原型版本保存，不跨会话复用。 */
export interface SessionBriefAcceptedInstruction {
  /** 已成功应用并产出新版本的用户原始修改指令。 */
  text: string;
  /** 该指令对应的 1-based 原型版本号。 */
  resultVersion: number;
  createdAt: number;
}

export interface SessionBriefV1 {
  version: 1;
  /** 当前版本号；与 history 中的 GenerationResult 快照同步。 */
  artifactVersion: number;
  /** 旧会话兼容游标；仅在缺少 recentTurns 快照时用于保守恢复上下文。 */
  messageCursor?: number;
  /** 该原型版本自己的短对话快照；用于表达无法由全局消息前缀表示的问答/分支上下文。 */
  recentTurns?: SessionContextTurn[];
  /** 首次生成/打开该原型时的原始诉求；允许为空（如无文字直接打开 HTML）。 */
  initialRequirement: string;
  /** 发生过需求澄清时保存补充内容；旧会话可能仍是“初始需求 + 补充说明”的合并格式。 */
  clarifiedRequirement?: string;
  /** 首次结构化得到的合同；它是初始目标，不冒充后续编辑后的当前合同。 */
  initialPrototypeContract?: PrototypeContract;
  /** 最近成功应用的修改指令；失败、取消、no-op 不进入。 */
  recentAcceptedInstructions: SessionBriefAcceptedInstruction[];
}

/** 当前请求携带的少量纯文本对话，只用于理解“刚才/它/第二个”等短距离指代。 */
export interface SessionContextTurn {
  role: "user" | "assistant";
  content: string;
}

/** Raw HTML 资源占位映射：editHtml 中的 placeholder 对应 preview HTML 里的 data URI。 */
export interface RawHtmlAsset {
  placeholder: string;
  dataUri: string;
}

/** Raw HTML 双表示：preview HTML 仍由 code/preview.html 保存；这里保存模型编辑用轻量版本。 */
export interface RawHtmlState {
  /** 给 LLM / Claude Code / scope patch 使用的 HTML，data URI 已替换为 __YD_ASSET_<hash>__。 */
  editHtml: string;
  /** placeholder -> data URI，输出后回填到 preview HTML。 */
  assets: RawHtmlAsset[];
  assetCount?: number;
  savedBytes?: number;
}

export type RequirementCardPriority = "P0" | "P1" | "P2";
export type RequirementCardReviewStatus = "pending" | "confirmed" | "question" | "obsolete";

export interface RequirementCardLinkAnchor {
  kind: "semantic";
  selector?: string;
  domPath?: string;
  text?: string;
  role?: string;
  rect?: { x: number; y: number; width: number; height: number };
  valid: boolean;
}

export interface RequirementCardLink {
  id: string;
  label: string;
  artifactVersion: number;
  anchor: RequirementCardLinkAnchor;
  createdAt: number;
}

export interface RequirementCard {
  id: string;
  title: string;
  priority: RequirementCardPriority;
  description: string;
  reviewStatus: RequirementCardReviewStatus;
  links?: RequirementCardLink[];
}

/** 一个原型版本自己的评审说明层；历史版本回退时随 GenerationResult 一起回退。 */
export interface RequirementCardSet {
  version: 1;
  artifactVersion: number;
  basedOnArtifactVersion?: number;
  status: "ready" | "inherited";
  generatedAt: number;
  updatedAt: number;
  /** 手工建卡单调计数，避免删除后复用旧编号；旧会话缺省时从现有 BR-xx 推断。 */
  nextManualSeq?: number;
  cards: RequirementCard[];
}

/** 一次生成的完整结果 */
export interface GenerationResult {
  flow: FlowSpec;
  components: RetrievedComponent[];
  /** 生成的多页 React app 代码（单 default export，内部状态路由） */
  code: string;
  preview: PreviewResult;
  /** true=原样打开的上传 HTML（code 即该 HTML，迭代时直接改它，不重做） */
  rawHtml?: boolean;
  /** true=产物是自包含 HTML（原生模式或原样 HTML）：srcDoc 渲染、按 HTML 迭代、可直接编辑 */
  html?: boolean;
  /** Raw HTML 双表示状态：code/preview.html 是可渲染 HTML，此字段是编辑用占位版本。 */
  rawHtmlState?: RawHtmlState;
  /** 目标设备（pc=满宽桌面预览；mobile=手机宽度边框预览 + 移动布局） */
  device?: Device;
  /** 应用的产品风格档案 id（贴近某产品设计风格） */
  styleProfileId?: string;
  /** 本次生成/后续编辑使用的模型偏好 */
  modelPreference?: ModelPreference;
  /** 当前版本的会话上下文快照；旧会话可缺省。 */
  sessionBrief?: SessionBriefV1;
  /** 当前原型版本的需求评审卡；旧会话可缺省。 */
  requirementCardSet?: RequirementCardSet;
  /** Chrome 抓取页的 frame 与受控交互描述；旧版本可缺省。 */
  captureMeta?: CaptureMeta;
}

/** 聊天消息（前后端共用） */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** 用户消息回显的附件（仅前端用，含原始 Blob，随会话持久化到 IndexedDB） */
  attachments?: ChatAttachment[];
  /** 桌面端 Claude Code 任务日志路径（仅 Electron bridge 暴露，用于内测排障） */
  claudeLogPath?: string;
}

/** HTML 编辑大小分析：用户展示看 original，模型/Claude 闸口看 compact。 */
export interface HtmlSizeInfo {
  originalChars: number;
  originalBytes: number;
  compactChars: number;
  compactBytes: number;
  assetCount: number;
  savedBytes: number;
  fullpageEditThresholdBytes: number;
  claudeMaxBytes: number;
  canFullpageEdit: boolean;
  shouldUseClaude: boolean;
  tooLargeForClaude: boolean;
}

export interface ClaudeProgressEvent {
  phase:
    | "queued"
    | "preparing"
    | "auth-check"
    | "running"
    | "thinking"
    | "tool"
    | "editing"
    | "validating"
    | "done"
    | "failed"
    | "cancelled";
  message: string;
  detail?: string;
  toolName?: string;
  elapsedMs?: number;
  queueSize?: number;
  logPath?: string;
}

/** 给桌面 Claude Code 的精确编辑锚点：由后端编辑计划/DOM 定位生成。 */
export interface ClaudeEditFocus {
  source: "annotation" | "auto-locate";
  plan?: string;
  targetOffset?: number;
  targetHtml?: string;
  scopeStart?: number;
  scopeEnd?: number;
  scopeTag?: string;
  scopeReason?: string;
  scopeHtml?: string;
}

/** 流式编排过程中向前端推送的事件 */
export type PipelineEvent =
  | { type: "step"; stage: string; status: "start" | "done"; detail?: string }
  | { type: "clarify"; questions: string[] }
  | { type: "flow"; flow: FlowSpec }
  | { type: "components"; components: RetrievedComponent[] }
  | { type: "code"; code: string }
  | { type: "code-delta"; chunk: string }
  | { type: "reasoning-delta"; chunk: string }
  | { type: "preview"; preview: PreviewResult }
  | { type: "error"; message: string }
  | { type: "assistant"; message: string; contextTurn?: "accepted" }
  | { type: "desktop-claude-progress"; progress: ClaudeProgressEvent }
  | {
      type: "desktop-claude-required";
      stage: "open" | "edit";
      reason: "large_html_scope_patch_failed";
      sizeInfo: HtmlSizeInfo;
      interactiveEdit: boolean;
      device?: Device;
      styleProfileId?: string;
      /** 首轮 HTML/ZIP 编辑时后端构造的轻量编辑 HTML，供桌面 bridge 直接复用。 */
      editHtml?: string;
      /** editHtml 内资源占位符对应的原始 data URI。 */
      assets?: RawHtmlAsset[];
      /** 后端补强后的编辑指令；用于大 HTML 交给桌面增强时保留路由判断上下文。 */
      instruction?: string;
      /** 后端提前做的编辑计划与精确锚点，桌面增强优先按此抽取目标容器。 */
      focus?: ClaudeEditFocus;
      /** 会话级连续对话摘要；桌面端只写入任务上下文，不参与本地启发式判定。 */
      sessionContext?: string;
      message: string;
    }
  | {
      type: "done";
      result: GenerationResult;
      summary?: string | null;
      /** artifact-only 表示仅成功打开/保留产物，本轮修改失败，不能写入已接受的会话上下文。 */
      contextCommit?: "artifact-only";
    };
