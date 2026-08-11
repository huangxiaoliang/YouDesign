import { z } from "zod";
import { config, type ModelKey } from "@/lib/config";
import { complexStructureModelForPreference, getProviderForStage, type LLMProvider } from "@/lib/providers";
import { getStyleProfile, type StyleProfile } from "@/lib/style/profiles";
import { buildStyleHead } from "@/lib/style/patterns";
import { getEmbeddings } from "@/lib/embeddings";
import {
  structureSystemPrompt,
  generatePlainSystemPrompt,
  editHtmlSystemPrompt,
  editHtmlGlobalStylePrompt,
  editHtmlScopeSystemPrompt,
  looksRewritten,
  isTrivialNoOp,
  flowToGenerationBrief,
  reviewSystemPrompt,
  MAX_PAGES,
} from "@/lib/prompts";
import {
  repairIfNeeded,
  ensureReactImport,
  normalizeBrandColors,
} from "./validate";
import { prototypeNavigationRepairInstruction, unsafePrototypeNavigation } from "@/lib/prototypeNavigation";
import { checkGeneratedStructure } from "./structureCheck";
import {
  applyScopeReplacement,
  buildDomSummary,
  extractScopeReplacement,
  extractScopePatchTarget,
  matchLocateToAnchor,
  removeTemporaryAnchors,
  scopeReplacementUnchanged,
  selectDedupScope,
  selectHtmlPatchScope,
  validateScopeReplacement,
  directDeleteElement,
  directDeleteColumn,
  directHideElement,
  tryDeterministicScopePatch,
  guardDeletedIdScriptRefs,
  detectScriptInjectedAnchor,
} from "./htmlScopePatch";
import {
  stripFences,
  extractHtmlDoc,
  looksLikeHtml,
  extractJson,
  truncateText,
  isRetryableModelError,
  isComplexStructure,
  validateEditedHtmlDoc,
  checkInlineScriptsSyntax,
} from "./textUtils";
import { compactDataUris, expandDataUris, validateAssetPlaceholders } from "./dataUriPlaceholder";
import { DEFAULT_FULLPAGE_EDIT_THRESHOLD_BYTES, formatKb } from "./htmlSizeInfo";
import { analyzeRawHtmlEditContext, createRawHtmlState, getRawHtmlEditContext } from "./rawHtmlState";
import { classifyEditIntent, classifyGlobalVisualEditInstruction, classifyInteractiveEditIntent, extractMergeHints, locateScopeTarget, planHtmlEdit, preflight, type EditPlan } from "./judges";
import { classifyHtmlUploadIntent, classifyImageUploadIntent, userContent } from "./intent";
import { MAX_IMAGES } from "./constants";
import {
  inferDeviceByRule,
  isDenseRequirement,
  isRestorationRequirement,
  shouldSkipImagePlanning,
  shouldUseStrongInitialGenerate,
  simpleGenerateOverride,
  strongRetryOverride,
} from "./routing";
import { modelTiming, recordTiming, timed, timingBase, type TimingBase } from "./timing";
import {
  buildSessionAwareUserMessage,
  buildSessionContextPrompt,
  SESSION_CONTEXT_SYSTEM_RULE,
} from "./sessionBrief";
import type {
  Attachments,
  ClaudeEditFocus,
  ComponentNeed,
  Device,
  FlowSpec,
  GenerationResult,
  ModelPreference,
  PipelineEvent,
  RetrievedComponent,
  SessionBriefV1,
  SessionContextTurn,
  UploadedDoc,
  VisualReferenceContract,
} from "@/lib/types";

const MAX_DOC_CHARS = 128000; // 所有文档文本合计上限（注意：是字符预算非 token；中文 MD 128000 字可达 ~128K-256K token，可能顶穿模型上下文窗口，系统无输入 token 守卫，超限会被端点 400 或静默截断）
/** 次要 HTML 上传字节 sanity 上限（本地走文件不受字符预算限，仅兜底防误传） */
const MAX_MERGE_HTML_UPLOAD_BYTES = 10 * 1024 * 1024;
// 多页 DPL 原型常达 400-600 行；又因 v4-pro 是推理模型(max_tokens 含推理消耗)，预算需更大
const STRUCTURE_MAX_TOKENS = 128000; // 结构化 JSON：推理 + 多页 flow，留足避免截断 JSON
const GENERATE_MAX_TOKENS = 128000;
const GENERATE_RETRY_MAX_TOKENS = 128000; // 网关超时重试：要求紧凑，仍需足够避免截断
const EDIT_MAX_TOKENS = 128000;
/** 纯文本自动定位门控：页面短于此长度时多一轮定位不划算，直接整页重出 */
const LOCATE_MIN_HTML = 25_000;
/** 自动定位置信度阈值：低于此值视为不可靠，回退整页重出（防"改对格式但改错位置"） */
const LOCATE_MIN_CONFIDENCE = 0.6;
/**
 * 整页编辑的 HTML 体量上限：超过则 editHtmlSystemPrompt 把整页塞 system prompt 会爆上下文，
 * 且 EDIT_MAX_TOKENS=48000 的输出上限也放不下大页面的逐字副本。
 * 超阈时改走 auto-locate+scope patch（仅送小 scope 给 LLM），或引导用户标注，避免 257–300s 超时。
 */
const MAX_FULLPAGE_EDIT_BYTES = DEFAULT_FULLPAGE_EDIT_THRESHOLD_BYTES;
const MAX_PROMPT_COMPONENTS = 10;
const MAX_RETRY_COMPONENTS = 6;

function isInteractiveHtmlEditInstruction(instruction: string) {
  const text = instruction.replace(/\s+/g, "");
  if (!text) return false;
  return /支持点击|支持打开|支持查看|支持展开|可点击|点击后|点后|点开|点击查看|点击.{0,12}(查看|打开|弹出|显示|展示|进入|跳转|切换|展开|收起|更新|联动)|查看详情|详情(弹窗|抽屉|面板|页|页面|区域|卡片)|弹窗|抽屉|跳转|联动|下钻|展开|收起/.test(
    text
  );
}

async function resolveInteractiveHtmlEditInstruction(
  instruction: string,
  original: string,
  modelPreference: ModelPreference,
  opts?: { judgeModelKey?: ModelKey; sessionContext?: string }
): Promise<boolean> {
  // 指代类指令（"按刚才方式/照此/同样"）：确定性继承当前版本最近对话的交互校验，不新增模型调用。
  // 必须保留：test-session-brief 锁定此分支不得调模型。
  // 但若指令同时含显式交互强信号词（"按刚才方式，但要支持点击弹窗"），指令自身已表达交互诉求，
  // 不应被指代吞掉 -> 落回下方 LLM 判定（test 只锁“纯指代不得调模型”，不禁止显式信号前置检查）。
  const hasExplicitInteractiveSignal = isInteractiveHtmlEditInstruction(instruction);
  const referentialInstruction = /刚才|上面|前面|之前|那个|它|按.{0,8}(方式|说法|逻辑)|照此|同样/.test(
    instruction.replace(/\s+/g, "")
  );
  if (referentialInstruction && opts?.sessionContext && !hasExplicitInteractiveSignal) {
    const recentDialogue =
      opts.sessionContext.match(/- 最近对话[^\n]*：\n([\s\S]*?)(?=\n- (?:最近已成功应用|初始|后续澄清)|$)/)?.[1] ?? "";
    return isInteractiveHtmlEditInstruction(recentDialogue);
  }
  // 非指代指令：无条件走 LLM 交互意图分类（含原强信号正则覆盖的"支持点击/弹窗/跳转"等，LLM 能消歧反例）。
  const domSummary = original ? buildDomSummary(original).slice(0, 8000) : "";
  const intent = await classifyInteractiveEditIntent(instruction, domSummary, modelPreference, {
    override: opts?.judgeModelKey,
    timeoutMs: 5000,
    sessionContext: opts?.sessionContext,
  });
  if (intent?.interactive && intent.confidence >= 0.75) {
    console.log(
      `[interactive-intent] uplift=true type=${intent.interactionType} conf=${intent.confidence.toFixed(2)} reason=${intent.reason ?? "-"}`
    );
    return true;
  }
  // LLM 失败/超时返回 null，或低置信：若指令含无歧义交互强信号词（"支持点击/弹窗/跳转"等），
  // 保守返回 true--强信号短语 LLM 本就该判 true，超时只是没等到答案，不该推翻确定性信号致静默漏需求。
  if (!intent && hasExplicitInteractiveSignal) {
    console.log(`[interactive-intent] uplift=true (fallback: llm-null + strong-signal)`);
    return true;
  }
  if (intent && intent.interactive && intent.confidence >= 0.5) {
    console.log(
      `[interactive-intent] gray-zone conf=${intent.confidence.toFixed(2)} interactive=true reason=${intent.reason ?? "-"}`
    );
  }
  console.log(
    `[interactive-intent] uplift=false conf=${intent?.confidence?.toFixed(2) ?? "-"} interactive=${intent?.interactive ?? "-"}`
  );
  return false;
}

/** 纯删除指令（不含移动/排序）——用于豁免 validateEditedHtmlDoc/looksRewritten 的体量骤降启发式：
 *  合法大删除会让输出体量明显变小，长度比 0.8/0.55 对它是假阳性。移动/排序不会让体量骤降，不豁免。 */
function isDeleteInstruction(instruction: string) {
  return /删除|删掉|删去|移除|去掉|清除|清空/.test(instruction);
}

function pointSelectEditModelOverride(modelPreference: ModelPreference): ModelKey | undefined {
  if (modelPreference === "deepseek") return "deepseekPro";
  if (modelPreference === "glm") return "glm";
  if (modelPreference === "sonnet") return "sonnet";
  if (modelPreference === "opus") return "opus";
  if (modelPreference === "kimiK3") return "kimiK3";
  if (modelPreference === "glm5v") return "glm5v";
  return undefined;
}

const INTERACTION_HANDLER_PATTERNS = [
  /on(?:click|change|input|submit|mouseenter|mouseover)\s*=/gi,
  /addEventListener\s*\(\s*["'`](?:click|change|input|submit|mouseenter|mouseover)["'`]/gi,
  /\.(?:onclick|onchange|oninput|onsubmit)\s*=/gi,
];

function countInteractionHandlers(html: string) {
  return INTERACTION_HANDLER_PATTERNS.reduce((sum, pattern) => {
    pattern.lastIndex = 0;
    return sum + (html.match(pattern) ?? []).length;
  }, 0);
}

function interactionHandlerBlocks(html: string) {
  const blocks: string[] = [];
  for (const match of html.matchAll(/\bon(?:click|change|input|submit|mouseenter|mouseover)\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    blocks.push(match[0].replace(/\s+/g, ""));
  }
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const script = match[1] || "";
    if (countInteractionHandlers(script)) blocks.push(script.replace(/\s+/g, ""));
  }
  return blocks;
}

function hasInteractionDelta(original: string, edited: string) {
  if (!edited || edited === original || isTrivialNoOp(original, edited)) return false;
  if (countInteractionHandlers(edited) > countInteractionHandlers(original)) return true;
  const originalBlocks = new Set(interactionHandlerBlocks(original));
  return interactionHandlerBlocks(edited).some((block) => !originalBlocks.has(block));
}

const KIND_LABEL: Record<string, string> = {
  html: "HTML",
  markdown: "Markdown",
  word: "Word",
  text: "文本",
};

function scriptInjectedAnchorWarning(scriptInjectedId: string) {
  return `提示：该元素位于脚本动态生成的内容内（脚本设置 #${scriptInjectedId} 的内容），重新打开/刷新后可能被还原。如需持久修改，建议直接改脚本里的数据源。`;
}

function scriptInjectedAnchorPersistentMessage(scriptInjectedId: string) {
  return `检测到点选的元素由脚本动态生成（脚本设置 #${scriptInjectedId} 的内容）。本次会改走脚本数据源/渲染逻辑，尽量避免刷新后被还原。`;
}

function scriptInjectedAnchorPersistentInstruction(instruction: string, scriptInjectedId: string) {
  return `${instruction}

持久修改要求：点选的元素位于脚本动态生成的内容内（脚本设置 #${scriptInjectedId} 的内容）。请优先修改生成该内容的脚本数据源、模板或渲染函数，而不是只修改当前已渲染的 DOM 快照；必要时同步更新 HTML 中已有的静态快照，保证重新打开或刷新后改动仍然存在。`;
}

function inferVisualReferenceMode(requirement: string): "faithful" | "layout" | "style" | "content" {
  if (/只(?:参考|沿用|保留)?.{0,8}(?:风格|配色|视觉)|(?:风格|配色|视觉).{0,8}(?:参考|沿用)/.test(requirement)) {
    return "style";
  }
  if (/只(?:参考|沿用|保留)?.{0,8}(?:布局|结构|排版)|(?:布局|结构|排版).{0,8}(?:参考|沿用)/.test(requirement)) {
    return "layout";
  }
  if (/只(?:参考|沿用|保留)?.{0,8}(?:内容|文案|字段)|(?:内容|文案|字段).{0,8}(?:参考|沿用)/.test(requirement)) {
    return "content";
  }
  return "faithful";
}

function visualReferenceContract(requirement: string): VisualReferenceContract {
  const change = requirement
    .split(/[。；;\n]/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) => /改成|换成|替换|增加|新增|补充|删除|去掉|移除|调整|改为/.test(item))
    .slice(0, 3)
    .map((item) => item.slice(0, 160));
  return {
    referenceMode: inferVisualReferenceMode(requirement),
    preserve: ["截图中清晰可见的布局骨架、信息层级和关键区域", "截图中清晰可辨的内容与信息密度"],
    change,
    infer: ["截图未展示但完成主任务所必需的页内交互状态"],
  };
}

function singlePageFlow(requirement: string, title = "原型"): FlowSpec {
  const normalizedRequirement = (requirement || "根据需求生成原型").replace(/\s+/g, " ").trim();
  const explicitInteractions = normalizedRequirement
    .split(/[。；;\n]/)
    .map((item) => item.trim())
    .filter((item) => /点击|点开|切换|筛选|搜索|排序|分页|展开|收起|弹窗|抽屉|联动|生成|提交|保存|删除|新增/.test(item))
    .slice(0, 5)
    .map((item) => ({
      priority: "must" as const,
      trigger: item,
      result: `页面完成「${item}」要求对应的状态变化`,
      proof: `操作后可直接看到「${item}」对应的页面结果，而非只有提示消息`,
    }));
  return {
    title,
    summary: (requirement || "根据需求生成的原型").slice(0, 40),
    prototypeContract: {
      pageArchetype: title === "图片参考原型" ? "图片参考单页原型" : "单页业务原型",
      primaryUser: "需求中描述的目标使用者",
      primaryJob: normalizedRequirement.slice(0, 100),
      mustHave: normalizedRequirement ? [normalizedRequirement.slice(0, 160)] : [],
      interactions: explicitInteractions,
      requiredStates: explicitInteractions.map((item) => item.result).slice(0, 5),
      assumptions: ["结构化不可用时按单页主任务快速生成"],
      ...(title === "图片参考原型" ? { visualReference: visualReferenceContract(normalizedRequirement) } : {}),
    },
    pages: [
      {
        id: "page",
        name: "页面",
        summary: requirement.slice(0, 80),
        sections: [],
        componentNeeds: [],
        dataFields: [],
      },
    ],
    navigations: [],
  };
}

/** 生成参考说明（截图 + 各类文档），追加到需求/brief 文本里 */
function referenceNote(attachments?: Attachments): string {
  if (!attachments) return "";
  const parts: string[] = [];
  const n = Math.min(attachments.images?.length ?? 0, MAX_IMAGES);
  if (n > 0) {
    parts.push(
      `\n\n【已附 ${n} 张截图作为视觉参考】请识别其布局、风格与可见内容，并严格按 Prototype Contract 中的 Visual Reference Contract 处理保留、修改与合理补充边界；无需机械逐像素复刻。`
    );
  }
  const docs = attachments.documents ?? [];
  let budget = MAX_DOC_CHARS;
  for (const d of docs) {
    if (budget <= 0) break;
    const body = d.content.slice(0, budget);
    budget -= body.length;
    if (d.kind === "html") {
      parts.push(
        `\n\n【参考 HTML：${d.name}】请借鉴其页面结构与内容，按当前技术栈实现（不必逐字保留原标签）：\n\`\`\`html\n${body}\n\`\`\``
      );
    } else {
      parts.push(
        `\n\n【参考文档（${KIND_LABEL[d.kind] ?? "文档"}）：${d.name}】以下内容作为原型的内容与需求依据，请据此组织页面与填充数据：\n"""\n${body}\n"""`
      );
    }
  }
  return parts.join("");
}

/** 合并形态解析：用户指令指定形态则从其指定，缺省为抽屉。 */
/** 合并形态解析：用户指令指定形态则从其指定，缺省为抽屉。hint 在场（LLM 预抽取）优先；缺席回退正则。测试不传 hint 走正则。 */
function resolveMergeForm(instruction: string, hint?: "drawer" | "modal" | "page" | "tab" | "unknown" | null): "drawer" | "modal" | "page" | "tab" {
  if (hint && hint !== "unknown") return hint;
  const text = instruction.replace(/\s+/g, "");
  if (/弹窗|弹层|modal|对话框/.test(text)) return "modal";
  if (/新页|跳转新页|独立页|新页面/.test(text)) return "page";
  if (/标签页|tab\b/i.test(text)) return "tab";
  return "drawer";
}

/**
 * 主/次解析：默认按上传顺序第一个为主，其余为次；用户在指令里显式指定时以用户为准。
 * 匹配靠文件名子串（大小写不敏感）；都不命中则退回上传顺序。
 * hints 在场（LLM 预抽取）时优先用 hints.primaryName 匹配文件名；缺席回退原正则抽取。测试不传 hints 走正则。
 */
function resolvePrimarySecondary(
  htmlDocs: UploadedDoc[],
  instruction: string,
  hints?: { primaryName?: string } | null
): { primary: UploadedDoc | undefined; secondaries: UploadedDoc[] } {
  if (htmlDocs.length <= 1) {
    return { primary: htmlDocs[0], secondaries: [] };
  }
  // 文件名匹配：双向子串包含（兼容用户在指令里写完整文件名或仅写文件名的一部分）。
  const matchByName = (hint: string): UploadedDoc | undefined => {
    const h = hint.toLowerCase();
    return htmlDocs.find(
      (d) => d.name && (d.name.toLowerCase().includes(h) || h.includes(d.name.toLowerCase()))
    );
  };

  // LLM 预抽取的主页名优先；缺席回退原正则抽取（"以X为主""把X合并到Y""点击X的"）。
  // 注意 || 与 ?? 不可无括号混用，故 primaryName 单独取出再拼接。
  const primaryHintByName = hints?.primaryName?.trim();
  const primaryHint =
    primaryHintByName ||
    (/以\s*(.+?)\s*(?:为主|作为主页面?|是主页面?)/.exec(instruction)?.[1] ??
      /(?:把|将)\s*.+?\s*合并(?:进|入|到)\s*(.+?)(?:[，。；,;]|$)/.exec(instruction)?.[1] ??
      /点击\s*["“”'']?(.+?)(?:["“”'']?\s*的)/.exec(instruction)?.[1]);
  if (primaryHint) {
    // 剥掉指令里包裹文件名的引号（半角 " '、全角 “ ”‘ ’），否则带引号的 hint 无法与文件名子串匹配。
    const cleanHint = primaryHint.replace(/^["“”'‘’\s]+|["“”'‘’\s]+$/g, "");
    const matched = matchByName(cleanHint);
    if (matched) {
      const secondaries = htmlDocs.filter((d) => d !== matched);
      return { primary: matched, secondaries };
    }
  }
  return { primary: htmlDocs[0], secondaries: htmlDocs.slice(1) };
}

/**
 * 从用户指令里抽取次要 HTML 的"子页面名"（如「续费毛利 - 下属差额明细」）。
 * hints 在场（LLM 预抽取）时优先用 hints.subpageName；缺席回退原逻辑：取次要文件名（去扩展名）
 * 在指令中出现位置之后的最近一个引号短语；命不中退回任意含"明细/下钻/详情/下属/分项"的引号短语；
 * 都没有返回 ""（调用方走澄清）。
 */
function deriveExtractTarget(instruction: string, secondaryFileName: string, hints?: { subpageName?: string } | null): string {
  if (hints?.subpageName?.trim()) return hints.subpageName.trim();
  const instr = String(instruction || "");
  if (!instr) return "";
  const stem = String(secondaryFileName || "").replace(/\.[^.]+$/, "").trim();
  const quoted: string[] = [];
  const re = /["\u201c\u201d]([^"\u201c\u201d]{1,80})["\u201c\u201d]|'([^']{1,80})'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(instr)) !== null) {
    const q = (m[1] || m[2] || "").trim();
    if (q) quoted.push(q);
  }
  const fileIdx = stem ? instr.toLowerCase().indexOf(stem.toLowerCase()) : -1;
  if (stem && fileIdx >= 0) {
    for (const q of quoted) {
      if (q.toLowerCase() === stem.toLowerCase()) continue;
      if (instr.indexOf(q) > fileIdx) return q;
    }
  }
  return quoted.find((q) => /明细|下钻|详情|下属|子页|分项/.test(q)) || "";
}

/**
 * 从 textOffset 向前找语义容器开标签（id="module-*" / module-anchor-wrapper / role="tabpanel" /
 * id 含 module|diff|detail|drill|drawer|panel|sub|tab 等）。
 * 在所有候选里选"区域最小且 ≥ MIN_REGION"的（跳过 drawer-title 这类太小的子部件、也跳过整页外壳），
 * 都太小则退回最大（最外层）。返回开标签起始下标。
 */
function findEnclosingContainer(html: string, textOffset: number): number {
  if (textOffset < 0) return -1;
  const prefix = html.slice(0, Math.min(html.length, textOffset + 1));
  const re = /<(div|section|aside|main|article)\b[^>]*?(?:id="module-[^"]*"|class="[^"]*module-anchor-wrapper[^"]*"|role="tabpanel"|id="(module|diff|detail|drill|drawer|panel|sub|tab)[\w-]*")[^>]*>/gi;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(prefix)) !== null) starts.push(m.index);
  if (!starts.length) return -1;
  const MIN_REGION = 500;
  let bestStart = -1;
  let bestLen = -1;
  let largestStart = -1;
  let largestLen = -1;
  for (const s of starts) {
    const closeEnd = matchClosingTag(html, s);
    if (closeEnd < 0) continue;
    const len = closeEnd - s;
    if (len > largestLen) { largestLen = len; largestStart = s; }
    if (len >= MIN_REGION && (bestLen < 0 || len < bestLen)) { bestLen = len; bestStart = s; }
  }
  return bestStart >= 0 ? bestStart : largestStart;
}

/** 栈式配对：从 openTagStart 处开标签找同标签名配对的闭合标签结束下标。void/自闭合返回 -1。 */
function matchClosingTag(html: string, openTagStart: number): number {
  const head = html.slice(openTagStart, openTagStart + 96);
  const tagMatch = /^<([a-zA-Z][a-zA-Z0-9]*)\b/.exec(head);
  if (!tagMatch) return -1;
  const tag = tagMatch[1].toLowerCase();
  if (/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(tag)) return -1;
  const combined = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, "gi");
  combined.lastIndex = openTagStart;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = combined.exec(html)) !== null) {
    if (/^<\//.test(m[0])) {
      depth -= 1;
      if (depth === 0) return combined.lastIndex;
      if (depth < 0) return -1;
    } else {
      depth += 1;
    }
  }
  return -1;
}

/** 判断 tagStart 处的开标签是否是抽屉/遮罩/明细类容器（id/class 含 drawer/overlay/detail/drill/panel）。 */
function isDrawerLikeContainer(html: string, tagStart: number): boolean {
  const slice = html.slice(tagStart, Math.min(html.length, tagStart + 140));
  return /<(div|section|aside|main|article)\b[^>]*\b(?:id|class)="[^"]*(?:drawer|overlay|detail|drill|panel)[^"]*"/i.test(slice);
}

/** 向前跳过空白与 HTML 注释，返回下一个非空白非注释字符的下标。 */
function skipWsAndCommentsForward(source: string, p: number): number {
  while (p < source.length) {
    while (p < source.length && /\s/.test(source[p])) p += 1;
    if (source.slice(p, p + 4) === "<!--") {
      const end = source.indexOf("-->", p + 4);
      if (end < 0) return p;
      p = end + 3;
      continue;
    }
    break;
  }
  return p;
}

/**
 * 把抽屉切片往前往后扩到同级的所有抽屉容器：次要页常有多级抽屉（drawerOverlay + drawer，
 * 再 drawerOverlay2 + drawer2…），它们是 body 直接子节点互为兄弟。只切 drawer 会丢掉
 * drawer2，导致 openDetailDrawer 找不到 #drawer2 报错、下钻失效。本函数把前后同级的
 * drawer-like 容器都纳入 region（跳过空白与 HTML 注释）。
 */
function extendDrawerRegion(source: string, start: number, end: number): { start: number; end: number } {
  let s = start;
  let e = end;
  // 往后扩：跳过空白/注释，下一个开标签若是抽屉类容器则配对纳入
  while (e < source.length) {
    const p = skipWsAndCommentsForward(source, e);
    if (p >= source.length || source[p] !== "<") break;
    if (/^<\//.test(source.slice(p, p + 2))) break;
    if (!isDrawerLikeContainer(source, p)) break;
    const ce = matchClosingTag(source, p);
    if (ce < 0) break;
    e = ce;
  }
  // 往前扩：在 source.slice(0,s) 里找最后一个 drawer-like 开标签，要求其配对闭合 <= s
  // 且与 s 之间只空白/注释（是紧邻兄弟，非祖先），是则纳入并继续往前
  while (s > 0) {
    const sub = source.slice(0, s);
    const re = /<(div|section|aside|main|article)\b[^>]*\b(?:id|class)="[^"]*(?:drawer|overlay|detail|drill|panel)[^"]*"/gi;
    let lastTag = -1;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(sub)) !== null) lastTag = mm.index;
    if (lastTag < 0) break;
    const ce = matchClosingTag(source, lastTag);
    if (ce < 0 || ce > s) break;
    const gap = source.slice(ce, s);
    if (gap.replace(/\s+/g, "").replace(/<!--[\s\S]*?-->/g, "").length > 0) break;
    if (lastTag === s) break;
    s = lastTag;
  }
  return { start: s, end: e };
}

/**
 * 子页面预提取：从次要 HTML 切出指令点名的子页面区域 + 全量 <style>（策略 A：CSS 全量并入）。
 * - extractSelector 优先（#id / .class）
 * - 否则 grep extractTarget 文本 → findEnclosingContainer（退化按 token）
 * - 栈式配对开闭标签，切出区域
 * 片段 = 全部 <style> + 区域 HTML（自包含）。切不出返回 null。
 */
function prepareSecondaryFragment(
  html: string,
  opts: { extractTarget?: string; extractSelector?: string }
): { fragment: string; region: string } | null {
  const source = String(html || "");
  if (!source) return null;
  const extractTarget = String(opts?.extractTarget || "").trim();
  const extractSelector = String(opts?.extractSelector || "").trim();
  let containerStart = -1;
  if (extractSelector) {
    const idMatch = /^#([\w-]+)$/.exec(extractSelector);
    if (idMatch) {
      const idx = source.indexOf(`id="${idMatch[1]}"`);
      if (idx >= 0) containerStart = source.lastIndexOf("<", idx);
    }
    if (containerStart < 0) {
      const clsMatch = /^\.([\w-]+)$/.exec(extractSelector);
      if (clsMatch) {
        const reCls = new RegExp(`class="[^"]*\\b${clsMatch[1]}\\b[^"]*"`);
        const cm = reCls.exec(source);
        if (cm) containerStart = source.lastIndexOf("<", cm.index);
      }
    }
  }
  if (containerStart < 0 && extractTarget) {
    const t = source.indexOf(extractTarget);
    if (t >= 0) containerStart = findEnclosingContainer(source, t);
    if (containerStart < 0) {
      const tokens = extractTarget
        .split(/[\s\-·\-—:：]+/)
        .filter((x) => x.length >= 2)
        .sort((a, b) => b.length - a.length);
      for (const tok of tokens) {
        const idx = source.indexOf(tok);
        if (idx >= 0) {
          containerStart = findEnclosingContainer(source, idx);
          if (containerStart >= 0) break;
        }
      }
    }
  }
  if (containerStart < 0) {
    // 文本定位失败兜底：直接按结构找抽屉容器（id="drawer" 或 class 含 "drawer" 的容器）。
    // 次要页抽屉系统（drawer + drawer2 + overlay）就是待合并的子页面，不依赖指令文本精确匹配。
    const drawerIdIdx = source.indexOf('id="drawer"');
    if (drawerIdIdx >= 0) {
      containerStart = source.lastIndexOf("<", drawerIdIdx);
    }
    if (containerStart < 0) {
      const cm = /class="[^"]*\bdrawer\b[^"]*"/.exec(source);
      if (cm) containerStart = source.lastIndexOf("<", cm.index);
    }
  }
  if (containerStart < 0) return null;
  const closeEnd = matchClosingTag(source, containerStart);
  if (closeEnd < 0) return null;
  // 扩到同级的所有抽屉容器（drawer + drawer2 + 各 overlay），保留下钻能力。
  const ext = extendDrawerRegion(source, containerStart, closeEnd);
  const region = source.slice(ext.start, ext.end);
  if (!region.trim()) return null;
  const styles = (source.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) || []).join("\n");
  // 内联 <script>（带 src 的外部脚本不带入，iframe srcdoc 无法解析外部资源）：
  // 次要页明细常由 JS 数据对象 + render 函数运行时填表，不带脚本 → 表是空的。
  const inlineScripts = (source.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [])
    .filter((s) => !/<script\b[^>]*\bsrc\s*=/i.test(s))
    .join("\n");
  return { fragment: `${styles}\n${region}\n${inlineScripts}`, region };
}

/**
 * 给次要页 CSS 加命名空间前缀，避免污染主页面：body/html→scope，*→scope *，其余→scope {sel}。
 * @-规则（@media/@keyframes/@import）剔除避免嵌套解析外泄。
 */
function scopeCssForMerge(css: string, scope: string): string {
  const noAt = css.replace(/@[^{};]*\{[^{}]*\}/g, "").replace(/@[^;{}]+;/g, "");
  return noAt.replace(/([^{}]+)\{([^{}]*)\}/g, (_full, sel: string, body: string) => {
    const scoped = String(sel)
      .split(",")
      .map((s) => {
        const t = s.trim();
        if (!t) return t;
        if (t === "body" || t === "html") return scope;
        return `${scope} ${t}`;
      })
      .join(", ");
    return `${scoped}{${body}}`;
  });
}

/**
 * 程序化合并：在主页面注入"触发入口 + 次要页片段（直接嵌入，原生跑）+ 触发连线"。
 * 子页面片段由 prepareSecondaryFragment 切出（含自带 <style> + 内联 <script>）。
 * 不套 iframe/容器壳：次要页抽屉系统（.drawer/.drawer2/overlay + openDrawer/closeDrawer）在主页
 * 原生跑——点触发调 openDrawer(key) 填表+滑出，关抽屉即真关，无壳残留。次要页 CSS 按
 * #yd-merge-scope 命名空间隔离避免污染主页。切不出 → ok:false，回退 LLM。
 * 本函数在 editHtml（占位压缩版）上操作；调用方负责 expandDataUris 还原预览。
 */
function programmaticHtmlMerge(opts: {
  primaryEditHtml: string;
  secondaryDocs: UploadedDoc[];
  instruction: string;
  /** LLM 预抽取的次要页子页面名（fileName -> subpageName）；缺席 deriveExtractTarget 走正则。 */
  secondaryHints?: Map<string, string> | null;
}): { ok: true; editHtml: string } | { ok: false; reason: string } {
  const { primaryEditHtml, secondaryDocs, instruction, secondaryHints } = opts;
  if (!secondaryDocs.length) return { ok: false, reason: "no-secondary" };
  const secondaryBytes = secondaryDocs.reduce(
    (sum, doc) => sum + Buffer.byteLength(String(doc.content || ""), "utf8"),
    0
  );
  if (secondaryBytes > MAX_MERGE_HTML_UPLOAD_BYTES) {
    return { ok: false, reason: `merge-too-large:${secondaryBytes}` };
  }

  // 触发入口不再合并时注入：由运行时触发连线按 deptData 卡片名自动在主页找各卡片"差额"元素绑定，
  // 这样单入口/多入口（多个卡片各自打开不同明细）都能自动覆盖。
  const primaryWithTrigger = primaryEditHtml;

  // 3) 每个次要页切子页面片段（含自带 <style> + 内联 <script>），直接嵌入主页（不套 iframe/容器壳）：
  // 次要页抽屉系统（.drawer/.drawer2/overlay + openDrawer/closeDrawer）在主页原生跑，关抽屉即真关，
  // 无壳残留。次要页 CSS 按 #yd-merge-scope 命名空间隔离避免污染主页。切不出 → 回退 LLM。
  const scopedStyles: string[] = [`[data-yd-merge-trigger]{cursor:pointer;}`];
  const scopeBlocks: string[] = [];
  const secondaryScripts: string[] = [];
  for (let i = 0; i < secondaryDocs.length; i += 1) {
    const doc = secondaryDocs[i];
    const id = i + 1;
    const prepared = prepareSecondaryFragment(String(doc.content || ""), {
      extractTarget: deriveExtractTarget(instruction, doc.name || "", {
        subpageName: secondaryHints?.get(doc.name || ""),
      }),
    });
    if (!prepared) return { ok: false, reason: `subpage-not-found:${doc.name || id}` };
    const scope = `#yd-merge-scope-${id}`;
    // prepared.fragment = styles + region + inlineScripts；拆出 style 做命名空间隔离
    const full = prepared.fragment;
    const cssText = (full.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) || [])
      .map((s) => s.replace(/^<style\b[^>]*>/i, "").replace(/<\/style>$/i, ""))
      .join("\n");
    scopedStyles.push(scopeCssForMerge(cssText, scope));
    // 次要页脚本会 getElementById 引用片段里没有的元素（如卡片区的 #diffTrigger），
    // 返回 null → .addEventListener 报错 → 脚本中断 → renderTable(填数据)/close 绑定都不执行。
    // 给这些"脚本引用但 region 里没有"的 id 注入隐藏 stub，让脚本跑完。
    const scriptsRaw = (full.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [])
      .filter((s) => !/<script\b[^>]*\bsrc\s*=/i.test(s))
      .join("\n");
    const referencedIds = new Set<string>();
    for (const m of scriptsRaw.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (m[1]) referencedIds.add(m[1]);
    }
    for (const m of scriptsRaw.matchAll(/querySelector\(\s*['"]#([\w-]+)['"]\s*\)/g)) {
      if (m[1]) referencedIds.add(m[1]);
    }
    const stubs = Array.from(referencedIds)
      .filter((rid) => {
        const idRe = new RegExp(`id=["']${rid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`);
        // 只 stub"脚本 getElementById 引用、但 region 静态 HTML 里没有"的 id（如卡片区的 #diffTrigger），
        // 防止 null 报错。若 id 在脚本字符串里被动态创建（如 buildEntView 拼 '<tbody id="detailTableBody">'），
        // 不能 stub——否则 stub 会挡在前面，getElementById 返回隐藏的 stub 而非脚本动态创建的真实元素，导致数据填到看不见的 stub 上。
        return !idRe.test(prepared.region) && !idRe.test(scriptsRaw);
      })
      .map((rid) => `<div id="${rid}" hidden style="display:none!important;"></div>`)
      .join("");
    scopeBlocks.push(`<div id="yd-merge-scope-${id}" class="yd-merge-scope">${stubs}${prepared.region}</div>`);
    const scripts = scriptsRaw;
    secondaryScripts.push(scripts);
  }

  // 4) 触发连线（运行时多入口，结构通用 + 乱码兼容）：
  // 主页"差额"按类名(.agps-subitem-difference)定位（captured 页文本常双重编码成乱码，按文本匹配会失败）；
  // 卡片名修复乱码后按名字模糊匹配次要页抽屉标题（如 合规 ∈ 税优合规），决定哪张卡开哪个抽屉。
  // 点击时若次要页有 openDrawer(key)（老结构：deptData 填表）就调，否则直接 drawer.classList.add('open')
  // （新结构：表在加载时由 renderTable 填好）。单/多入口都自动覆盖。
  const triggerWiring =
    "<script>(function(){" +
    "function fixMojibake(s){try{return decodeURIComponent(escape(s));}catch(e){return s;}}" +
    "function norm(s){return String(s||'').replace(/\\s+/g,'');}" +
    "function fuzzy(a,b){a=norm(a);b=norm(b);if(!a||!b)return false;return a.indexOf(b)>=0||b.indexOf(a)>=0;}" +
    "var scope=document.getElementById('yd-merge-scope-1')||document.querySelector('[id^=\\'yd-merge-scope\\']');" +
    "function findDiffIn(card){return card.querySelector('.agps-subitem-difference,[class*=\\'agps-difference\\'],.diff,[class*=\\'difference-clickable\\']');}" +
    "function findNameEl(card){return card.querySelector('.agps-subitem-card-name,.card-name,[class*=\\'card-name\\']');}" +
    "function bindAll(){" +
    "if(!scope)return false;" +
    "var drawers=[],overlays={};scope.querySelectorAll('[id]').forEach(function(el){var id=el.id;if(/^drawer\\d*$/.test(id))drawers.push(el);else if(/^drawerOverlay\\d*$/.test(id))overlays[id]=el;});" +
    "if(!drawers.length)return false;" +
    "function suffix(id){var m=id.match(/\\d+$/);return m?m[0]:'';}" +
    "drawers.sort(function(a,b){return suffix(a.id)-suffix(b.id);});" +
    "var drawerInfo=drawers.map(function(d){var t=d.querySelector('.drawer-title,[class*=\\'drawer-title\\']');return{el:d,title:t?t.textContent:'',overlay:overlays['drawerOverlay'+suffix(d.id)]||null,key:null};});" +
    // 老结构：deptData[key].title 匹配抽屉标题，记录 key
    "if(typeof deptData!=='undefined'&&deptData){for(var k in deptData){var dt=deptData[k]&&deptData[k].title;for(var i=0;i<drawerInfo.length;i++){if(fuzzy(drawerInfo[i].title,dt)){drawerInfo[i].key=k;break;}}}}" +
    "var cards=document.querySelectorAll('.agps-subitem-card-item,.subitem-card,[class*=\\'subitem-card-item\\']');" +
    "var bound=0;" +
    "cards.forEach(function(card){var nameEl=findNameEl(card);if(!nameEl)return;var raw=nameEl.textContent;var fixed=fixMojibake(raw);var diff=findDiffIn(card);if(!diff||diff.hasAttribute('data-yd-merge-trigger'))return;" +
    // 老结构（deptData 多 key 共用一个抽屉）：按卡名匹配 deptData 各 key 的标题，绑到对应 key 的 openDrawer(key)
    "if(typeof deptData!=='undefined'&&deptData){" +
    "var key=null;for(var k in deptData){var dt=(deptData[k]&&deptData[k].title)||'';if(fuzzy(dt,raw)||fuzzy(dt,fixed)){key=k;break;}}" +
    "if(key){diff.setAttribute('data-yd-merge-trigger','1');diff.style.cursor='pointer';" +
    "diff.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();try{if(typeof openDrawer==='function')openDrawer(key);}catch(err){}var d=document.getElementById('drawer')||document.querySelector('[id^=drawer]:not([id^=drawerOverlay])');if(d)d.classList.add('open');var ov=document.getElementById('drawerOverlay');if(ov)ov.classList.add('open');});bound++;return;}" +
    "}" +
    // 新结构（多抽屉各一个）：按抽屉标题匹配
    "var matched=null;for(var i=0;i<drawerInfo.length;i++){if(fuzzy(drawerInfo[i].title,raw)||fuzzy(drawerInfo[i].title,fixed)){matched=drawerInfo[i];break;}}" +
    "if(!matched)return;diff.setAttribute('data-yd-merge-trigger','1');diff.style.cursor='pointer';" +
    "diff.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();if(matched.key&&typeof openDrawer==='function'){try{openDrawer(matched.key);}catch(e){}}matched.el.classList.add('open');if(matched.overlay)matched.overlay.classList.add('open');});bound++;});" +
    "return bound>0;}" +
    "var tries=0;function tick(){if(bindAll()||tries++>60)return;setTimeout(tick,100);}" +
    "if(document.readyState!=='loading')tick();else document.addEventListener('DOMContentLoaded',tick);" +
    "})();</" +
    "script>";

  // 5) 在 </body> 前注入：scoped 样式 + scope 容器（含 region）+ 次要页脚本 + 触发连线。
  const bodyCloseIdx = primaryWithTrigger.lastIndexOf("</body>");
  if (bodyCloseIdx < 0) return { ok: false, reason: "no-body-close" };
  const injection = `<style>\n${scopedStyles.join("\n")}\n</style>\n${scopeBlocks.join("\n")}\n${secondaryScripts.join("\n")}\n${triggerWiring}`;
  const merged =
    primaryWithTrigger.slice(0, bodyCloseIdx) + injection + primaryWithTrigger.slice(bodyCloseIdx);
  return { ok: true, editHtml: merged };
}

/**
 * 导航形态合并（"新页面打开"形态）：点主页触发点 → 全屏 iframe 打开整个次要页。
 * 不切子页、不嵌抽屉——次要页整页作为 iframe.srcdoc，沙箱隔离样式 + 脚本原生跑，数据/交互保真。
 * 触发点 = 次要页文件名 stem（去扩展名）在主页定位，服务端打 data-yd-nav-trigger 标签（比运行时文本匹配可靠）。
 * 找不到触发点 → ok:false 回退 LLM。不自带返回键（A2：靠次要页/外壳自带返回）。
 */
function tagNavTrigger(html: string, text: string, attrValue: string): string | null {
  const idx = html.indexOf(text);
  if (idx < 0) return null;
  const tagStart = html.lastIndexOf("<", idx);
  if (tagStart < 0) return null;
  // 找该开标签的闭合 >（跳过引号内字符）
  let inS = false;
  let inD = false;
  let tagEnd = -1;
  for (let i = tagStart + 1; i < html.length; i += 1) {
    const c = html[i];
    if (inS) {
      if (c === "'") inS = false;
      continue;
    }
    if (inD) {
      if (c === '"') inD = false;
      continue;
    }
    if (c === "'") {
      inS = true;
      continue;
    }
    if (c === '"') {
      inD = true;
      continue;
    }
    if (c === ">") {
      tagEnd = i;
      break;
    }
  }
  if (tagEnd < 0) return null;
  const selfClose = html[tagEnd - 1] === "/";
  const insertAt = selfClose ? tagEnd - 1 : tagEnd;
  const attr = ` data-yd-nav-trigger="${attrValue}"`;
  return html.slice(0, insertAt) + attr + html.slice(insertAt);
}

/** iframe 内次要页的触发点 wiring：点击调主页 parent.__ydNavShow(id) 打开下一级。已存在则不重复注入。 */
function ensureNavPageWiring(html: string): string {
  if (html.includes("parent.__ydNavShow")) return html;
  const bc = html.lastIndexOf("</body>");
  if (bc < 0) return html;
  const w =
    "<script>(function(){" +
    "function cb(e){e.preventDefault();e.stopPropagation();var n=this.getAttribute('data-yd-nav-trigger');try{parent&&parent.__ydNavShow&&parent.__ydNavShow(n);}catch(err){}}" +
    "document.querySelectorAll('[data-yd-nav-trigger]').forEach(function(el){el.addEventListener('click',cb);});" +
    "})();</" +
    "script>";
  return html.slice(0, bc) + w + html.slice(bc);
}

/** 替换主页里 yd-nav-data-{id} 这个 script 的 base64 内容（编辑态嵌套：改完内页重新编码替换 blob）。 */
function replaceNavDataBlob(html: string, id: number, newB64: string): string {
  const re = new RegExp(
    `(<script type="text/plain" id="yd-nav-data-${id}">)([\\s\\S]*?)(</script>)`,
    "i"
  );
  return html.replace(re, `$1${newB64}$3`);
}

/** 程序化合并失败 → 给用户的人话原因（不回退 LLM，直接提示让用户修触发点/文件名/页面结构）。 */
function mergeFailureMessage(reason: string): string {
  if (reason.startsWith("trigger-not-found:")) {
    const stem = reason.slice("trigger-not-found:".length);
    return (
      `未能完成合并：在主页及已嵌入页中都没找到与次要页文件名「${stem}」匹配的文本触发点。` +
      `请确认页面里该链接/菜单项的文字与文件名一致（如文件「机构管理.html」，页面里相应链接也应包含「机构管理」），` +
      `或把次要页文件名改成与页面链接文字一致后重试。`
    );
  }
  if (reason.startsWith("subpage-not-found:")) {
    const name = reason.slice("subpage-not-found:".length);
    return (
      `未能完成合并：次要页「${name}」不是抽屉式下钻页面，无法提取抽屉片段。` +
      `抽屉形态合并要求次要页包含抽屉结构（如 .drawer / openDrawer）。` +
      `若想整页打开，请在指令中写「新页面打开」走导航合并。`
    );
  }
  if (reason === "no-secondary") return "未检测到待合并的次要 HTML 页面。";
  if (reason.startsWith("merge-too-large:")) {
    const bytes = Number(reason.slice("merge-too-large:".length));
    const actual = Number.isFinite(bytes) ? `${Math.ceil(bytes / 1024 / 1024)}MB` : "未知体积";
    return `未能完成合并：次要 HTML 总体积为 ${actual}，超过 10MB 上限。请减少文件数量或压缩页面资源后重试。`;
  }
  if (reason.startsWith("no-trigger-name")) return "次要页文件名无法解析出触发点名，请确认文件名非空。";
  if (reason === "no-body-close") return "主页缺少 </body> 闭合标签，无法注入合并内容。";
  return `未能完成合并：${reason}`;
}

function programmaticNavigationMerge(opts: {
  primaryEditHtml: string;
  secondaryDocs: UploadedDoc[];
}): { ok: true; editHtml: string } | { ok: false; reason: string } {
  const { primaryEditHtml, secondaryDocs } = opts;
  if (!secondaryDocs.length) return { ok: false, reason: "no-secondary" };
  const secondaryBytes = secondaryDocs.reduce(
    (sum, doc) => sum + Buffer.byteLength(String(doc.content || ""), "utf8"),
    0
  );
  if (secondaryBytes > MAX_MERGE_HTML_UPLOAD_BYTES) {
    return { ok: false, reason: `merge-too-large:${secondaryBytes}` };
  }

  const K = secondaryDocs.length;
  const stems = secondaryDocs.map((d) => String(d.name || "").replace(/\.[^.]+$/, "").trim());
  for (let i = 0; i < K; i += 1) {
    if (!stems[i]) return { ok: false, reason: `no-trigger-name:${secondaryDocs[i].name || i + 1}` };
  }
  const newContents = secondaryDocs.map((d) => String(d.content || ""));

  // 解析主页已有的 nav 结构（编辑态：primary 可能已是合并产物，含 yd-nav-data-N blob + scope + __ydNavShow）。
  const existingBlobIds: number[] = [];
  const existingBlobDecoded = new Map<number, string>();
  let maxId = 0;
  for (const m of primaryEditHtml.matchAll(
    /<script type="text\/plain" id="yd-nav-data-(\d+)">([\s\S]*?)<\/script>/gi
  )) {
    const id = parseInt(m[1], 10);
    existingBlobIds.push(id);
    if (id > maxId) maxId = id;
    try {
      existingBlobDecoded.set(id, Buffer.from(m[2], "base64").toString("utf8"));
    } catch {
      existingBlobDecoded.set(id, "");
    }
  }
  // 新次要页 id 从 maxId+1 起（避免与已有 scope 冲突）。
  const newIds: number[] = [];
  for (let i = 0; i < K; i += 1) newIds.push(maxId + i + 1);

  // 下钻树自动发现：每个新次要页 T 的 stem 出现在哪个"页"里，那页就是 T 的父级。
  // 候选父级（优先级）：主页明文 > 已有 blob（解码后）> 其它新次要页。
  //   主页优先：主页是入口，其触发点最该埋在主页；否则次要页间互相引用名字（如吉县宏天页含"机构管理"面包屑）
  //   会被误判成"机构管理的父级是吉县宏天"，导致主页没埋触发点、入口断裂、scope 间循环。
  //   链式 page3 的 stem 通常只在 page2 不在主页 → 主页查不到，自然回退到次要页 page2，正确。
  // 父级类型：'new'（新次要页 id）/ 'blob'（已有 blob id）/ 'main'（主页）。
  type Parent = { kind: "new" | "blob" | "main"; id: number };
  const parentOf: Parent[] = [];
  for (let i = 0; i < K; i += 1) {
    const stem = stems[i];
    let parent: Parent | null = null;
    if (primaryEditHtml.includes(stem)) {
      parent = { kind: "main", id: 0 };
    }
    if (!parent) {
      for (const bid of [...existingBlobIds].sort((a, b) => b - a)) {
        const dec = existingBlobDecoded.get(bid) || "";
        if (dec.includes(stem)) {
          parent = { kind: "blob", id: bid };
          break;
        }
      }
    }
    if (!parent) {
      for (let j = K - 1; j >= 0; j -= 1) {
        if (j === i) continue;
        if (newContents[j].includes(stem)) {
          parent = { kind: "new", id: newIds[j] };
          break;
        }
      }
    }
    if (!parent) {
      return { ok: false, reason: `trigger-not-found:${stem}` };
    }
    parentOf.push(parent);
  }
  console.log(
    `[nav-merge] K=${K} stems=${JSON.stringify(stems)} existingBlobs=${JSON.stringify(existingBlobIds)} newIds=${JSON.stringify(newIds)} parentOf=${JSON.stringify(parentOf)}`
  );

  // 按父级分组子级。
  const mainChildren: number[] = []; // 新次要页 index，父=主页
  const blobChildren = new Map<number, number[]>(); // blob id -> [新次要页 index]
  const newChildren = new Map<number, number[]>(); // 新次要页 id -> [新次要页 index]
  for (let i = 0; i < K; i += 1) {
    const p = parentOf[i];
    if (p.kind === "main") mainChildren.push(i);
    else if (p.kind === "blob") {
      const arr = blobChildren.get(p.id) || [];
      arr.push(i);
      blobChildren.set(p.id, arr);
    } else {
      const arr = newChildren.get(p.id) || [];
      arr.push(i);
      newChildren.set(p.id, arr);
    }
  }

  // 1) 父级=已有 blob：解码 → 给子级 stem 打标签 + 确保页内 wiring → 重新编码替换主页里该 blob。
  let html = primaryEditHtml;
  for (const [bid, childIndices] of blobChildren) {
    let dec = existingBlobDecoded.get(bid) || "";
    for (const ci of childIndices) {
      const tagged = tagNavTrigger(dec, stems[ci], String(newIds[ci]));
      if (tagged) dec = tagged;
    }
    dec = ensureNavPageWiring(dec);
    html = replaceNavDataBlob(html, bid, Buffer.from(dec, "utf8").toString("base64"));
  }

  // 2) 新次要页：给其子级 stem 打标签 + 页内 wiring（改完再 base64 嵌入主页）。
  const newModified: string[] = new Array(K);
  for (let i = 0; i < K; i += 1) {
    let h = newContents[i];
    const kids = newChildren.get(newIds[i]) || [];
    for (const ci of kids) {
      const tagged = tagNavTrigger(h, stems[ci], String(newIds[ci]));
      if (tagged) h = tagged;
    }
    if (kids.length) h = ensureNavPageWiring(h);
    newModified[i] = h;
  }

  // 3) 主页：给主页子级 stem 打标签（主页触发点直接调 __ydNavShow，主页已有/将注入的 wiring 会绑定）。
  for (const ci of mainChildren) {
    const tagged = tagNavTrigger(html, stems[ci], String(newIds[ci]));
    if (!tagged) return { ok: false, reason: `trigger-not-found:${stems[ci]}` };
    html = tagged;
  }

  // 4) 所有新次要页作为 srcdoc iframe 嵌入主页文档（scope 都在主页，id 用 newIds）。
  const scopes: string[] = [];
  const dataList: string[] = [];
  for (let i = 0; i < K; i += 1) {
    const id = newIds[i];
    const secB64 = Buffer.from(newModified[i], "utf8").toString("base64");
    dataList.push(`<script type="text/plain" id="yd-nav-data-${id}">${secB64}</script>`);
    scopes.push(
      `<div id="yd-nav-scope-${id}" class="yd-nav-scope" style="display:none">` +
        `<iframe class="yd-nav-frame" style="border:0;margin:0;padding:0;width:100vw;height:100vh;position:fixed;inset:0;background:#fff;z-index:2147483647"></iframe>` +
        `</div>`
    );
  }

  const bodyCloseIdx = html.lastIndexOf("</body>");
  if (bodyCloseIdx < 0) {
    return { ok: false, reason: "no-body-close" };
  }
  // 主页已有 __ydNavShow（编辑态）则不重复注入；否则注入完整 main wiring（生成态或首次合并）。
  const hasMainWiring = html.includes("__ydNavShow");
  const mainWiring = hasMainWiring
    ? ""
    : `<style>[data-yd-nav-trigger]{cursor:pointer;}.yd-nav-scope{position:fixed;inset:0;z-index:2147483647;background:#fff;}</style>\n` +
      "<script>(function(){" +
      "function ydB64Decode(b){var bin=atob(b);var u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return new TextDecoder('utf-8').decode(u);}" +
      "window.__ydNavShow=function(n){" +
      "var scope=document.getElementById('yd-nav-scope-'+n);if(!scope)return false;" +
      "var frame=scope.querySelector('.yd-nav-frame');var data=document.getElementById('yd-nav-data-'+n);" +
      "if(frame&&data&&!frame.hasAttribute('data-yd-loaded')){frame.srcdoc=ydB64Decode(data.textContent);frame.setAttribute('data-yd-loaded','1');}" +
      // 所有 nav-scope 共用同一 z-index，绘制顺序由 DOM 顺序决定。批量合并时深层子页的 scope id
      // 可能小于父页（DOM 更靠前），挪到父节点末尾才能盖在已打开的父页之上，否则点开被遮住看不到。
      "scope.style.display='block';scope.parentNode.appendChild(scope);return true;};" +
      "document.querySelectorAll('[data-yd-nav-trigger]').forEach(function(el){" +
      "var n=el.getAttribute('data-yd-nav-trigger');" +
      "el.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();__ydNavShow(n);});});" +
      "})();</" +
      "script>";
  const injection = `${scopes.join("\n")}\n${dataList.join("\n")}${mainWiring ? "\n" + mainWiring : ""}`;
  const merged = html.slice(0, bodyCloseIdx) + injection + html.slice(bodyCloseIdx);
  return { ok: true, editHtml: merged };
}

const FlowPageSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  summary: z.string().default(""),
  sections: z.array(z.object({ name: z.string(), description: z.string().default("") })).default([]),
  componentNeeds: z
    .array(z.object({ componentName: z.string(), description: z.string().default("") }))
    .default([]),
  nativeBlocks: z
    .array(z.object({ name: z.string(), description: z.string().default("") }))
    .default([]),
  dataFields: z.array(z.string()).default([]),
});

const PrototypeInteractionContractSchema = z.object({
  priority: z.enum(["must", "should"]).default("must"),
  trigger: z.string().min(1),
  result: z.string().min(1),
  proof: z.string().min(1),
});

const VisualReferenceContractSchema = z.object({
  referenceMode: z.enum(["faithful", "layout", "style", "content"]),
  preserve: z.array(z.string()).default([]),
  change: z.array(z.string()).default([]),
  infer: z.array(z.string()).default([]),
});

const PrototypeContractSchema = z.object({
  pageArchetype: z.string().min(1),
  primaryUser: z.string().min(1),
  primaryJob: z.string().min(1),
  mustHave: z.array(z.string()).default([]),
  interactions: z.array(PrototypeInteractionContractSchema).max(5).default([]),
  requiredStates: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  visualReference: VisualReferenceContractSchema.optional(),
});

const FlowSpecSchema = z.object({
  title: z.string(),
  summary: z.string().default(""),
  prototypeContract: PrototypeContractSchema,
  pages: z.array(FlowPageSchema).min(1),
  navigations: z
    .array(z.object({ from: z.string(), trigger: z.string().default(""), to: z.string() }))
    .default([]),
});

export interface GenerateInput {
  requirement: string;
  mode: "generate" | "edit";
  /** 是否使用组件库生成路径（历史 DPL 双轨开关；公开版已剥离，运行时恒 false，待作为单独 PR 清理） */
  useDpl?: boolean;
  /** 是否允许"需求澄清"反问（默认 true；用户已在补充澄清时传 false 直接生成） */
  allowClarify?: boolean;
  /** 原样打开上传的 HTML（不走生成管线，直接渲染；后续在该 HTML 上直接改） */
  rawHtml?: boolean;
  /** 产品风格档案 id（贴近某产品设计风格） */
  styleProfileId?: string;
  /** 上传的截图/HTML 作为生成依据（仅首次生成） */
  attachments?: Attachments;
  /** 用户选择的文本模型策略；有图片时会被强制视为 auto */
  modelPreference?: ModelPreference;
  /** 快速模式（默认开）：generate/结构化恒走 deepseek-v4-flash，跳过 review/refine。仅首次生成生效 */
  fastMode?: boolean;
  /** 最近少量纯文本对话；只用于短距离指代，不持久化为跨会话记忆。 */
  recentTurns?: SessionContextTurn[];
  previous?: {
    code: string;
    flow: FlowSpec;
    components: RetrievedComponent[];
    useDpl?: boolean;
    rawHtml?: boolean;
    html?: boolean;
    rawHtmlState?: GenerationResult["rawHtmlState"];
    rawHtmlEditSource?: "chat" | "annotation";
    device?: Device;
    styleProfileId?: string;
    modelPreference?: ModelPreference;
    sessionBrief?: SessionBriefV1;
    captureMeta?: import("@/lib/capturedPage").CaptureMeta;
  };
}

const ReviewSchema = z.object({
  ok: z.boolean(),
  issues: z.array(z.string()).default([]),
});
const REVIEW_CODE_CAP = 24000; // 送审代码上限，控制 token

function reviewRiskReasons(
  requirement: string,
  code: string,
  ctx: {
    useDpl: boolean;
    structureIssues?: string[];
    validationHadIssue?: boolean;
    hasImages?: boolean;
    hasDocs?: boolean;
    hasStyleProfile?: boolean;
    flow: FlowSpec;
  }
) {
  const reasons: string[] = [];
  if (ctx.structureIssues?.length) reasons.push("structure-issues");
  if (ctx.validationHadIssue) reasons.push("validate-repair");
  if (ctx.hasImages) reasons.push("image");
  if (ctx.hasDocs) reasons.push("document");
  if (ctx.hasStyleProfile) reasons.push("style-profile");
  if (ctx.flow.prototypeContract?.interactions.some((item) => item.priority === "must")) reasons.push("must-interactions");
  if (isRestorationRequirement(requirement)) reasons.push("restoration");
  if (isDenseRequirement(requirement)) reasons.push("dense-requirement");
  if (code.trim().length < (ctx.useDpl ? 2000 : 3500)) reasons.push("small-output");
  return [...new Set(reasons)];
}

/**
 * ③.6 轻量自评审 + 一次定向优化（非流式，避免与已流式正文拼接）。
 * 评审用 flash；有明显问题才修；DPL 修后复用 validateStage 保证不破坏；失败/无效则保留原稿。
 */
async function* reviewAndRefine(
  requirement: string,
  code: string,
  ctx: {
    useDpl: boolean;
    device: Device;
    components: RetrievedComponent[];
    styleHead: string;
    modelPreference: ModelPreference;
    fastMode?: boolean;
    structureIssues?: string[];
    validationHadIssue?: boolean;
    hasImages?: boolean;
    hasDocs?: boolean;
    hasStyleProfile?: boolean;
    timingBase?: TimingBase;
    flow: FlowSpec;
  }
): AsyncGenerator<PipelineEvent, string> {
  // [临时] 无条件跳过整个 reviewAndRefine 阶段（自评审 review + 按评审意见优化 refine），
  // 快速/高质量模式均不执行；恢复时删掉本行 return 与下方块注释的开闭符即可。
  return code;
  /* 原逻辑整段注释（恢复时移除本行开始的块注释符与函数末尾的闭合符）
  if (!requirement.trim() || !code.trim()) return code;

  const contractIssues = (ctx.structureIssues ?? []).filter((issue) =>
    /Prototype Contract|必须交互/.test(issue)
  );
  // 快速模式仍跳过通用 review/refine；但明确标为 must 的交互若静态验收不通过，
  // 复用现有定向优化调用修正一次，避免“有入口、不可演示”。
  if ((ctx.fastMode || !config.selfReview) && !contractIssues.length) return code;

  let issues = (ctx.fastMode || !config.selfReview ? contractIssues : ctx.structureIssues ?? [])
    .filter(Boolean)
    .slice(0, 5);
  const riskReasons = reviewRiskReasons(requirement, code, ctx);
  const reviewStartedAt = Date.now();
  const { provider: reviewer, modelKey: reviewerModel } = getProviderForStage("clarify", { preference: ctx.modelPreference });
  if (issues.length) {
    yield { type: "step", stage: "review", status: "done", detail: `结构自检发现 ${issues.length} 处可优化` };
    if (ctx.timingBase) recordTiming(ctx.timingBase, "review", reviewStartedAt, { outcome: "structure-issues" });
  } else if (!riskReasons.length) {
    yield { type: "step", stage: "review", status: "done", detail: "低风险，跳过自评审" };
    if (ctx.timingBase) recordTiming(ctx.timingBase, "review", reviewStartedAt, { outcome: "skipped-low-risk" });
    return code;
  } else {
    yield { type: "step", stage: "review", status: "start", detail: `自评审：${riskReasons.slice(0, 3).join("、")} · 模型:${reviewerModel}` };
    try {
      const raw = await reviewer.complete({
        system: reviewSystemPrompt(ctx.useDpl, ctx.device),
        messages: [
          {
            role: "user",
            content: `【原型规格】\n${flowToGenerationBrief(ctx.flow, requirement)}\n\n【生成结果，可能截断】\n${code.slice(
              0,
              REVIEW_CODE_CAP
            )}`,
          },
        ],
        json: true,
        temperature: 0,
        maxTokens: 128000,
      });
      const v = ReviewSchema.parse(extractJson(raw));
      if (!v.ok) issues = v.issues.filter(Boolean).slice(0, 5);
      if (ctx.timingBase) recordTiming(ctx.timingBase, "review", reviewStartedAt, { ...modelTiming(reviewerModel), outcome: v.ok ? "ok" : "issues" });
    } catch {
      // 评审失败不阻断
      if (ctx.timingBase) recordTiming(ctx.timingBase, "review", reviewStartedAt, { ...modelTiming(reviewerModel), outcome: "error" });
    }
  }
  if (!issues.length) {
    yield { type: "step", stage: "review", status: "done", detail: "通过" };
    return code;
  }
  if (!ctx.structureIssues?.length) {
    yield { type: "step", stage: "review", status: "done", detail: `发现 ${issues.length} 处可优化` };
  }

  // 定向优化一次（非流式）
  const { provider: fixer, modelKey: fixerModel } = getProviderForStage("editLarge", {
    preference: ctx.modelPreference,
    override: ctx.modelPreference === "glm" ? "deepseek" : undefined,
  });
  yield { type: "step", stage: "refine", status: "start", detail: `按评审意见优化 · 模型:${fixerModel}` };
  const sys = ctx.useDpl
    ? ctx.styleHead + editSystemPrompt(code, ctx.components, true, ctx.device)
    : editHtmlSystemPrompt(code);
  const instr = `请只针对下列问题做最小修正，其余保持不变：\n${issues.map((i) => `- ${i}`).join("\n")}`;
  let fixedRaw = "";
  const refineStartedAt = Date.now();
  try {
    fixedRaw = await fixer.complete({
      system: sys,
      messages: [{ role: "user", content: instr }],
      temperature: 0.3,
      maxTokens: ctx.useDpl ? GENERATE_MAX_TOKENS : EDIT_MAX_TOKENS,
    });
  } catch {
    if (ctx.timingBase) recordTiming(ctx.timingBase, "refine", refineStartedAt, { ...modelTiming(fixerModel), outcome: "error" });
    yield { type: "step", stage: "refine", status: "done", detail: "优化失败，保留原稿" };
    return code;
  }
  if (ctx.timingBase) recordTiming(ctx.timingBase, "refine", refineStartedAt, { ...modelTiming(fixerModel), outcome: "ok" });

  if (ctx.useDpl) {
    const cleaned = stripFences(fixedRaw);
    if (!cleaned.trim()) {
      yield { type: "step", stage: "refine", status: "done", detail: "优化无效，保留原稿" };
      return code;
    }
    const validated = yield* validateStage(
      fixer,
      ctx.components,
      cleaned,
      true,
      ctx.device,
      ctx.timingBase ? { base: ctx.timingBase, modelKey: fixerModel } : undefined
    );
    yield { type: "step", stage: "refine", status: "done", detail: `已优化 · 模型:${fixerModel}` };
    return validated || code;
  }
  const html = extractHtmlDoc(fixedRaw);
  if (!looksLikeHtml(html)) {
    yield { type: "step", stage: "refine", status: "done", detail: "优化无效，保留原稿" };
    return code;
  }
  yield { type: "step", stage: "refine", status: "done", detail: "已优化" };
  return html;
  */
}

// 普通模型生成链路暂时统一跳过通用结构自检；Electron Claude Code CLI 有独立校验链，不受此开关影响。
const SKIP_NON_CLAUDE_STRUCTURE_CHECK = true;

function* structureCheckStage(
  requirement: string,
  flow: FlowSpec,
  code: string,
  ctx: {
    useDpl: boolean;
    device: Device;
    components: RetrievedComponent[];
    fastMode?: boolean;
  }
): Generator<PipelineEvent, string[]> {
  if (SKIP_NON_CLAUDE_STRUCTURE_CHECK) return [];
  if (!requirement.trim() || !code.trim()) return [];
  const result = checkGeneratedStructure({
    requirement,
    flow,
    code,
    useDpl: ctx.useDpl,
    device: ctx.device,
    components: ctx.components,
  });
  if (ctx.fastMode || !config.selfReview) {
    const contractIssues = result.issues.filter((issue) => /Prototype Contract|必须交互/.test(issue));
    if (!contractIssues.length) return [];
    yield { type: "step", stage: "structure-check", status: "start", detail: "验收必须可演示的交互" };
    yield {
      type: "step",
      stage: "structure-check",
      status: "done",
      detail: `发现 ${contractIssues.length} 条交互合同未满足`,
    };
    return contractIssues;
  }
  yield { type: "step", stage: "structure-check", status: "start", detail: "检查页面结构完整性" };
  yield {
    type: "step",
    stage: "structure-check",
    status: "done",
    detail: result.ok ? "通过" : `发现 ${result.issues.length} 处结构问题`,
  };
  return result.issues;
}

/**
 * 流式生成：能流就边产出 code-delta 边累积，返回完整文本；不支持流式的 provider 回退 complete()。
 * 用 `const full = yield* streamCode(...)` 调用，增量事件会自动透传给前端。
 */
async function* streamCode(
  provider: LLMProvider,
  req: Parameters<LLMProvider["complete"]>[0]
): AsyncGenerator<PipelineEvent, string> {
  if (!provider.stream) return await provider.complete(req);
  let acc = "";
  for await (const d of provider.stream(req)) {
    if (d.reasoning) yield { type: "reasoning-delta", chunk: d.reasoning };
    if (d.content) {
      acc += d.content;
      yield { type: "code-delta", chunk: d.content };
    }
  }
  // 极少数情况下流为空（如网关异常但 200），兜底再取一次
  if (!acc.trim()) return await provider.complete(req);
  return acc;
}

/** 主编排：返回 PipelineEvent 异步流，供 API 路由转成 NDJSON 推给前端 */
export async function* runPipeline(input: GenerateInput): AsyncGenerator<PipelineEvent> {
  try {
    const sessionContext = buildSessionContextPrompt(input.previous?.sessionBrief, input.recentTurns);
    if (input.mode === "edit" && input.previous) {
      const modelPreference = input.modelPreference ?? input.previous.modelPreference ?? "auto";
      // 先判意图：是改原型还是提问。是提问就直接在对话区回答、不动原型
      if (input.requirement.trim()) {
        yield { type: "step", stage: "intent", status: "start", detail: "判断是修改还是提问" };
        const decision = await classifyEditIntent(input.requirement, modelPreference, sessionContext);
        if (decision.intent === "ask") {
          yield { type: "step", stage: "intent", status: "done", detail: "这是提问，已直接回答" };
          yield {
            type: "assistant",
            message: decision.answer || "这看起来是个问题，但我暂时没法回答。",
            contextTurn: "accepted",
          };
          return;
        }
        yield { type: "step", stage: "intent", status: "done", detail: "这是修改诉求" };
      }
      // HTML 产物（原样上传 或 原生模式生成）走 HTML 编辑；React/DPL 产物走 runEdit
      if (input.previous.rawHtml || input.previous.html) {
        // 编辑期合并：当前 demo 为主页面，上传的 html 全部作为次要（secondary）并入
        const secondaryHtmlDocs =
          input.attachments?.documents?.filter((d) => d.kind === "html" && d.content) ?? [];
        // 只在有次要页时才调 LLM 抽取合并意图（best-effort，失败/超时回退正则）。
        const editMergeHints =
          secondaryHtmlDocs.length > 0
            ? await extractMergeHints(input.requirement, secondaryHtmlDocs, modelPreference, { sessionContext })
            : null;
        const isEditMerge =
          secondaryHtmlDocs.length > 0 &&
          (editMergeHints?.isMergeRequest || /合并|嵌入|下钻页|并入|合到一起|并进来|打开/.test(input.requirement));
        if (isEditMerge) {
          // 方案 D：用当前 demo 作主页面，程序化合并（快、不花钱、保留次要页真实数据）。
          const rawContext = getRawHtmlEditContext(
            input.previous.code,
            input.previous.rawHtmlState
          );
          // 按合并形态分流：page=新页面打开(整页 iframe) → 导航合并；其余(抽屉等) → 抽屉合并。
          const mergeForm = resolveMergeForm(input.requirement, editMergeHints?.mergeForm);
          // page 形态用整页 iframe 无需子页名；其余形态用 LLM 抽取的 secondaryHints 驱动 deriveExtractTarget。
          let secondaryHints: Map<string, string> | null = null;
          if (mergeForm !== "page" && editMergeHints?.secondaries?.length) {
            secondaryHints = new Map(editMergeHints.secondaries.map((s) => [s.fileName, s.subpageName!]));
          }
          const merged =
            mergeForm === "page"
              ? programmaticNavigationMerge({
                  primaryEditHtml: rawContext.editHtml,
                  secondaryDocs: secondaryHtmlDocs,
                })
              : programmaticHtmlMerge({
                  primaryEditHtml: rawContext.editHtml,
                  secondaryDocs: secondaryHtmlDocs,
                  instruction: input.requirement,
                  secondaryHints,
                });
          if (merged.ok) {
            yield { type: "step", stage: "edit", status: "start", detail: "程序化合并页面" };
            const mergedPreview = expandDataUris(merged.editHtml, rawContext.assetMap);
            yield { type: "code", code: mergedPreview };
            const preview = { html: mergedPreview, source: "raw" as const };
            yield { type: "preview", preview };
            yield { type: "step", stage: "edit", status: "done", detail: "程序化合并完成" };
            yield {
              type: "done",
              result: {
                flow: input.previous.flow,
                components: input.previous.components ?? [],
                code: mergedPreview,
                preview,
                rawHtml: true,
                html: true,
                rawHtmlState: { ...rawContext.state, editHtml: merged.editHtml },
                styleProfileId: input.previous.styleProfileId,
                modelPreference: input.modelPreference ?? input.previous.modelPreference ?? "auto",
              },
            };
            return;
          }
          // 程序化合并失败：不回退 LLM（LLM 同样做不好合并，易产出错形态/假成功），直接提示原因让用户修。
          yield { type: "step", stage: "edit", status: "done", detail: `程序化合并未完成:${merged.reason}` };
          yield { type: "assistant", message: mergeFailureMessage(merged.reason), contextTurn: "accepted" };
          return;
        } else {
          // 非合并：普通 HTML 编辑（合并请求已在上面程序化合并分支处理）
          yield* runEditRawHtml(input.requirement, input.previous, modelPreference, {
            sessionContext,
            images: input.attachments?.images,
          });
        }
      } else {
        // DPL/React 产物：不支持合并（无法把原生 HTML 片段嵌入 JSX）。用户想合并则澄清。
        const dplSecondaryHtmlDocs =
          input.attachments?.documents?.filter((d) => d.kind === "html" && d.content) ?? [];
        if (
          dplSecondaryHtmlDocs.length > 0 &&
          /合并|嵌入|下钻页|并入|合到一起|并进来|打开/.test(input.requirement)
        ) {
          yield {
            type: "assistant",
            message:
              "当前为 DPL 组件产物，合并仅支持原生 HTML 页面。请先打开一个原生 HTML 页面（如上传的 HTML 或原生模式生成的页面），再进行合并。",
            contextTurn: "accepted",
          };
          return;
        }
        yield {
          type: "assistant",
          message: "当前产物不支持编辑，请重新生成或打开一个原生 HTML 页面。",
          contextTurn: "accepted",
        };
      }
    } else {
      const allHtmlDocs = (input.attachments?.documents ?? []).filter((d) => d.kind === "html" && d.content);
      // LLM 预抽取主/次页 + 子页面名（best-effort，失败/超时回退正则）。
      const mergeHints = await extractMergeHints(input.requirement, allHtmlDocs, input.modelPreference ?? "auto", { sessionContext });
      const { primary: htmlDoc, secondaries: secondaryHtmlDocs } = resolvePrimarySecondary(
        allHtmlDocs,
        input.requirement,
        mergeHints
      );
      const secondaryHintsMap =
        mergeHints?.secondaries?.length
          ? new Map(mergeHints.secondaries.map((s) => [s.fileName, s.subpageName!]))
          : null;
      const isMergeRequest =
        secondaryHtmlDocs.length > 0 ||
        mergeHints?.isMergeRequest === true ||
        /合并|嵌入|下钻页|并入|合到一起/.test(input.requirement);
      // 生成期合并：主页面 = 主 html（按用户指定 > 上传顺序），次要 = 其余 html，合并成一份新原型
      if (isMergeRequest && htmlDoc) {
        yield { type: "step", stage: "intent", status: "start", detail: "识别为多页面合并" };
        const flow = htmlFlow(htmlDoc.name);
        yield { type: "flow", flow };
        // 方案 D：先尝试程序化合并（不交给 LLM 改大 HTML，保留次要页真实数据、不坏主页面样式）。
        // 按合并形态分流：page=新页面打开(整页 iframe) → 导航合并；其余(抽屉等) → 抽屉合并。
        // 程序化合并失败不回退 LLM（LLM 同样做不好合并），直接 mergeFailureMessage 提示让用户修触发点/文件名/页面结构。
        const rawContext = getRawHtmlEditContext(htmlDoc.content, createRawHtmlState(htmlDoc.content));
        const genMergeForm = resolveMergeForm(input.requirement, mergeHints?.mergeForm);
        const merged =
          genMergeForm === "page"
            ? programmaticNavigationMerge({
                primaryEditHtml: rawContext.editHtml,
                secondaryDocs: secondaryHtmlDocs,
              })
            : programmaticHtmlMerge({
                primaryEditHtml: rawContext.editHtml,
                secondaryDocs: secondaryHtmlDocs,
                instruction: input.requirement,
                secondaryHints: secondaryHintsMap,
              });
        if (merged.ok) {
          yield { type: "step", stage: "edit", status: "start", detail: "程序化合并页面" };
          const mergedPreview = expandDataUris(merged.editHtml, rawContext.assetMap);
          yield { type: "code", code: mergedPreview };
          const preview = { html: mergedPreview, source: "raw" as const };
          yield { type: "preview", preview };
          yield { type: "step", stage: "edit", status: "done", detail: "程序化合并完成" };
          yield {
            type: "done",
            result: {
              flow,
              components: [],
              code: mergedPreview,
              preview,
              rawHtml: true,
              html: true,
              rawHtmlState: { ...rawContext.state, editHtml: merged.editHtml },
              styleProfileId: input.styleProfileId,
              modelPreference: input.modelPreference ?? "auto",
            },
          };
          return;
        }
        // 程序化合并失败：不回退 LLM（LLM 同样做不好合并，易产出错形态/假成功），直接提示原因让用户修。
        yield { type: "step", stage: "edit", status: "done", detail: `程序化合并未完成:${merged.reason}` };
        yield { type: "assistant", message: mergeFailureMessage(merged.reason), contextTurn: "accepted" };
        return;
      }
      if (input.rawHtml && htmlDoc) {
        yield { type: "step", stage: "intent", status: "start", detail: input.requirement.trim() ? "识别 HTML 上传处理方式" : "准备打开上传页面" };
        const selectedStyle = getStyleProfile(input.styleProfileId);
        const intentModelKey: ModelKey | undefined = input.requirement.trim() ? "deepseek" : undefined;
        const intentTiming = timingBase({
          mode: "generate",
          artifact: "raw",
          rawHtml: true,
          hasAttachments: true,
          hasImages: (input.attachments?.images?.length ?? 0) > 0,
          hasDocs: true,
          fastMode: input.fastMode ?? true,
          device: "pc",
        });
        const intentStartedAt = Date.now();
        const htmlIntent = await classifyHtmlUploadIntent(
          input.requirement,
          htmlDoc.content,
          htmlDoc.name,
          selectedStyle,
          sessionContext
        );
        recordTiming(intentTiming, "html-intent", intentStartedAt, {
          ...modelTiming(intentModelKey),
          outcome: htmlIntent.intent,
        });
        yield {
          type: "step",
          stage: "intent",
          status: "done",
          detail:
            htmlIntent.intent === "regenerate"
              ? `参考上传页面重新生成${intentModelKey ? ` · 模型:${intentModelKey}` : ""}`
              : htmlIntent.intent === "edit"
              ? `在上传页面上修改${intentModelKey ? ` · 模型:${intentModelKey}` : ""}`
              : htmlIntent.intent === "ask"
              ? `先打开页面并回答问题${intentModelKey ? ` · 模型:${intentModelKey}` : ""}`
              : `原样打开上传页面${intentModelKey ? ` · 模型:${intentModelKey}` : ""}`,
        };
        if (htmlIntent.intent === "regenerate") {
          yield* runGenerate(
            htmlIntent.regenerateRequirement || input.requirement,
            false,
            input.attachments,
            input.allowClarify ?? true,
            selectedStyle,
            input.modelPreference ?? "auto",
            input.fastMode ?? true,
            sessionContext
          );
        } else if (htmlIntent.intent === "edit") {
          const flow = htmlFlow(htmlDoc.name);
          yield { type: "flow", flow };
          yield* runEditRawHtml(
            htmlIntent.editInstruction || input.requirement,
            {
              code: htmlDoc.content,
              flow,
              components: [],
              useDpl: false,
              rawHtml: true,
              html: true,
              rawHtmlState: createRawHtmlState(htmlDoc.content),
              rawHtmlEditSource: "chat",
              styleProfileId: htmlIntent.applySelectedStyle ? input.styleProfileId : undefined,
              modelPreference: input.modelPreference,
              captureMeta: htmlDoc.captureMeta,
            },
            input.modelPreference ?? "auto",
            {
              applySelectedStyle: htmlIntent.applySelectedStyle,
              entry: "first-upload",
              openOriginalOnFailure: true,
              sessionContext,
            }
          );
        } else {
          const askSummary =
            htmlIntent.intent === "ask" && htmlIntent.userMessage
              ? `已原样打开《${htmlFlow(htmlDoc.name).title}》。\n\n${htmlIntent.userMessage}`
              : undefined;
          yield* runRawHtml(htmlDoc.content, htmlDoc.name, "", input.modelPreference ?? "auto", {
            doneSummary: askSummary,
            captureMeta: htmlDoc.captureMeta,
          });
        }
      } else {
        const images = input.attachments?.images ?? [];
        if (images.length > 0) {
          yield { type: "step", stage: "intent", status: "start", detail: input.requirement.trim() ? "识别图片处理方式" : "准备根据图片生成" };
          const intentTiming = timingBase({
            mode: "generate",
            artifact: "raw",
            rawHtml: false,
            hasAttachments: true,
            hasImages: true,
            hasDocs: (input.attachments?.documents?.length ?? 0) > 0,
            fastMode: input.fastMode ?? true,
            device: "pc",
          });
          const intentStartedAt = Date.now();
          const { decision: imageIntent, modelKey: imageIntentModel } = await classifyImageUploadIntent(
            input.requirement,
            images,
            input.modelPreference ?? "auto",
            sessionContext
          );
          recordTiming(intentTiming, "image-intent", intentStartedAt, {
            ...modelTiming(imageIntentModel),
            outcome: imageIntent.intent,
          });
          yield {
            type: "step",
            stage: "intent",
            status: "done",
            detail:
              imageIntent.intent === "ask"
                ? `回答图片问题${imageIntentModel ? ` · 模型:${imageIntentModel}` : ""}`
                : imageIntent.intent === "generate-with-changes"
                ? `根据图片生成并应用修改${imageIntentModel ? ` · 模型:${imageIntentModel}` : ""}`
                : `根据图片生成原型${imageIntentModel ? ` · 模型:${imageIntentModel}` : ""}`,
          };
          if (imageIntent.intent === "ask") {
            yield {
              type: "assistant",
              message: imageIntent.userMessage || "我看到了你上传的图片。请告诉我你想分析哪一部分，或说明要根据它生成什么原型。",
              contextTurn: "accepted",
            };
            return;
          }
          yield* runGenerate(
            imageIntent.generationRequirement || input.requirement,
            input.useDpl ?? false,
            input.attachments,
            input.allowClarify ?? true,
            getStyleProfile(input.styleProfileId),
            input.modelPreference ?? "auto",
            input.fastMode ?? true,
            sessionContext
          );
          return;
        }
        yield* runGenerate(
          input.requirement,
          input.useDpl ?? false,
          input.attachments,
          input.allowClarify ?? true,
          getStyleProfile(input.styleProfileId),
          input.modelPreference ?? "auto",
          input.fastMode ?? true,
          sessionContext
        );
      }
    }
  } catch (err) {
    console.error("[pipeline] 失败:", err);
    const msg = err instanceof Error ? err.message : String(err);
    // 网络层抖动给出更友好的提示（terminated/aborted/reset/UND_ERR_* 同属此类）
    const friendly = /fetch failed|other side closed|ECONN|timeout|socket|terminated|aborted|reset|UND_ERR/i.test(msg)
      ? `网络请求失败（已自动重试仍未成功）：${msg}。请重试，或检查模型/代理连通性。`
      : msg;
    yield { type: "error", message: friendly };
  }
}

async function* runGenerate(
  requirement: string,
  useDpl: boolean,
  attachments?: Attachments,
  allowClarify = true,
  profile?: StyleProfile,
  modelPreference: ModelPreference = "auto",
  fastMode = true,
  sessionContext = ""
): AsyncGenerator<PipelineEvent> {
  const images = attachments?.images;
  const hasImages = (images?.length ?? 0) > 0;
  const effectiveModelPreference: ModelPreference = hasImages
    ? modelPreference === "sonnet" || modelPreference === "opus" || modelPreference === "glm5v" || modelPreference === "kimiK3"
      ? modelPreference
      : "glm5v"
    : modelPreference;
  const hasDocs = (attachments?.documents?.length ?? 0) > 0;
  const refNote = referenceNote(attachments);
  const skipImagePlanning = shouldSkipImagePlanning({ fastMode, hasImages, hasDocs, useDpl });
  const planningModelPreference: ModelPreference = fastMode ? "deepseek" : effectiveModelPreference;
  const planningImages = fastMode ? undefined : images;
  const planningNeedsVision = !fastMode && hasImages;
  let runTiming = timingBase({
    mode: "generate",
    artifact: "raw",
    rawHtml: false,
    hasAttachments: hasImages || hasDocs,
    hasImages,
    hasDocs,
    fastMode,
    device: "pc",
  });
  // 上传了内容但没写文字时给个默认需求
  if (!requirement.trim() && (hasImages || hasDocs)) {
    requirement = "请根据上传的参考内容（截图/文档）生成一个高保真可交互原型";
  }

  // ⓪ 预检：一次 flash 调用同时判「需求是否明确」+「PC / 移动端」（合并原澄清与设备两步）
  let device: Device = "pc";
  if (requirement.trim()) {
    if (skipImagePlanning) {
      const clarifyStartedAt = Date.now();
      yield { type: "step", stage: "clarify", status: "start", detail: "快速图片模式:规则判定目标端" };
      device = inferDeviceByRule(requirement);
      runTiming = timingBase(runTiming, { device });
      recordTiming(runTiming, "clarify", clarifyStartedAt, { outcome: "rule-skip" });
      yield {
        type: "step",
        stage: "clarify",
        status: "done",
        detail: `已跳过模型预检 · ${device === "mobile" ? "移动端" : "PC 端"}`,
      };
    } else {
      const { modelKey: clarifyModel } = getProviderForStage("clarify", {
        preference: planningModelPreference,
        needsVision: planningNeedsVision,
      });
      yield { type: "step", stage: "clarify", status: "start", detail: `判断需求与目标端 · 模型:${clarifyModel}` };
      const pf = await timed(runTiming, "clarify", () =>
        preflight(requirement, planningModelPreference, planningImages, sessionContext)
      );
      device = pf.device;
      runTiming = timingBase(runTiming, { device });
      // 可反问的前提：允许澄清、且无上传内容（有图片/文档则不打断，直接生成）
      const canAsk = allowClarify && !hasImages && !hasDocs;
      const questions = [...(pf.clear ? [] : pf.questions)];
      // device 不清时只在需求也不清时一并反问；需求已具体则兜底 pc 直接生成（AGENTS.md §2「兜底 pc」）
      if (!pf.clear && !pf.deviceClear) questions.push("这个原型主要给 PC 端还是移动端（手机）用？");
      if (canAsk && questions.length) {
        yield { type: "step", stage: "clarify", status: "done", detail: "需补充确认" };
        yield { type: "clarify", questions: questions.slice(0, 4) };
        return; // 暂停，等用户补充后再续跑
      }
      yield {
        type: "step",
        stage: "clarify",
        status: "done",
        detail: `需求清晰 · ${device === "mobile" ? "移动端" : "PC 端"} · 模型:${clarifyModel}`,
      };
    }
  }

  const styleHead = buildStyleHead(profile, { requirement, device });

  // ① 需求结构化（多页流程）。按复杂度分流：复杂需求升 pro，简单走 flash
  const complex = isComplexStructure(requirement, hasDocs);
  let flow: FlowSpec | null = null;
  let smodel: ModelKey | "rule" = "rule";
  const structureStartedAt = Date.now();
  let structureOutcome = "ok";
  if (skipImagePlanning) {
    yield { type: "step", stage: "structure", status: "start", detail: "理解需求、拆解页面与跳转" };
    flow = singlePageFlow(requirement, "图片参考原型");
    structureOutcome = "rule-skip";
  } else {
    const structureProvider = getProviderForStage("structure", {
      needsVision: planningNeedsVision,
      override: fastMode
        ? "deepseek"
        : complex
        ? complexStructureModelForPreference(effectiveModelPreference)
        : undefined,
      preference: planningModelPreference,
    });
    const structureLLM = structureProvider.provider;
    smodel = structureProvider.modelKey;
    yield { type: "step", stage: "structure", status: "start", detail: `理解需求、拆解页面与跳转 · 模型:${smodel}` };
    // LLM 偶发吐坏 JSON（多页结构更长、概率更高），失败重试多次
    let lastErr: unknown;
    try {
      for (let attempt = 0; attempt < 3 && !flow; attempt++) {
        const raw = await structureLLM.complete({
          system:
            styleHead +
            structureSystemPrompt({
              device,
              hasImages,
            }) +
            (sessionContext ? `\n\n${SESSION_CONTEXT_SYSTEM_RULE}` : ""),
          messages: [
            {
              role: "user",
              content: userContent(
                buildSessionAwareUserMessage(requirement + refNote, sessionContext),
                planningImages
              ),
            },
          ],
          json: true,
          temperature: 0.3,
          maxTokens: STRUCTURE_MAX_TOKENS,
        });
        try {
          flow = parseFlow(raw, { requireVisualReference: hasImages });
        } catch (err) {
          lastErr = err;
        }
      }
    } catch (err) {
      recordTiming(runTiming, "structure", structureStartedAt, { ...modelTiming(smodel), outcome: "error" });
      throw err;
    }
    if (!flow) {
      // 结构化反复吐非 JSON（常见于"还原截图为 HTML"时视觉模型直接产出 HTML）→ 退化单页继续生成，
      // 不整次报错；生成步会据需求+附件直接出页面。
      console.warn("[structure] 解析失败，退化单页:", lastErr instanceof Error ? lastErr.message : lastErr);
      flow = singlePageFlow(requirement, hasImages ? "图片参考原型" : "原型");
      structureOutcome = "fallback";
    }
  }

  yield {
    type: "step",
    stage: "structure",
    status: "done",
    detail: skipImagePlanning
      ? `已跳过结构化 · 单页`
      : `模型:${smodel} · ${flow.pages.length} 页`,
  };
  recordTiming(runTiming, "structure", structureStartedAt, {
    ...(smodel === "rule" ? {} : modelTiming(smodel)),
    outcome: structureOutcome,
  });
  yield { type: "flow", flow };

  // ② 组件检索（原生模式无组件库）
  let components: RetrievedComponent[] = [];

  // ③ 代码生成（多页 app）
  const pageWord = flow.pages.length > 1 ? `${flow.pages.length} 页原型` : "页面";
  const how = "用原生 HTML";
  const strongInitialGenerate = !fastMode && shouldUseStrongInitialGenerate({
    requirement,
    useDpl,
    hasImages,
    hasDocs,
    complex,
    pageCount: flow.pages.length,
    hasStyleProfile: Boolean(profile),
  });
  const generateOverride = simpleGenerateOverride(effectiveModelPreference, strongInitialGenerate, fastMode);
  const flashFirstGenerate = !fastMode && generateOverride === "deepseek" && !strongInitialGenerate;
  const { provider: genLLM, modelKey: gmodel } = getProviderForStage("generate", {
    needsVision: hasImages,
    override: generateOverride,
    preference: effectiveModelPreference,
  });
  yield { type: "step", stage: "generate", status: "start", detail: `${how}生成${pageWord} · 模型:${gmodel}` };
  const brief = flowToGenerationBrief(flow, requirement) + refNote;
  const promptComponents = components;
  let codeRaw: string;
  const generateStartedAt = Date.now();
  try {
    codeRaw = yield* streamCode(genLLM, {
      system:
        styleHead +
        generatePlainSystemPrompt(device) +
        (sessionContext ? `\n\n${SESSION_CONTEXT_SYSTEM_RULE}` : ""),
      messages: [
        {
          role: "user",
          content: userContent(buildSessionAwareUserMessage(brief, sessionContext), images),
        },
      ],
      temperature: 0.4,
      maxTokens: GENERATE_MAX_TOKENS,
    });
    recordTiming(runTiming, "generate", generateStartedAt, {
      ...modelTiming(gmodel),
      outcome: flashFirstGenerate ? "flash-first" : "ok",
    });
  } catch (err) {
    if (!isRetryableModelError(err)) {
      // 不可重试：补记 error timing（修 stage-timing 凭空缺行），再抛
      recordTiming(runTiming, "generate", generateStartedAt, { ...modelTiming(gmodel), outcome: "error" });
      throw err;
    }
    // 可重试（429/502/503/504/网关超时/ServerOverloaded 等）：httpFetch 层已退避重试过一遍，
    // 这里是最后一搏——压缩上下文 + 非流式 complete 重发一次。
    recordTiming(runTiming, "generate", generateStartedAt, { ...modelTiming(gmodel), outcome: "gateway-timeout" });
    yield {
      type: "step",
      stage: "generate",
      status: "start",
      detail: "模型过载/网关错误，压缩上下文后重试",
    };
    const retryComponents = components;
    const retryStartedAt = Date.now();
    codeRaw = await genLLM.complete({
      system:
        styleHead +
        generatePlainSystemPrompt(device) +
        (sessionContext ? `\n\n${SESSION_CONTEXT_SYSTEM_RULE}` : ""),
      messages: [
        {
          role: "user",
          content: userContent(
            buildSessionAwareUserMessage(
              `${brief}\n\n请优先生成紧凑但完整的可交互原型，控制代码体积，避免冗长样式和重复数据。`,
              sessionContext
            ),
            images
          ),
        },
      ],
      temperature: 0.4,
      maxTokens: GENERATE_RETRY_MAX_TOKENS,
    });
    recordTiming(runTiming, "generate", retryStartedAt, { ...modelTiming(gmodel), outcome: "timeout-retry" });
  }
  yield {
    type: "step",
    stage: "generate",
    status: "done",
    detail: `模型:${gmodel}${flashFirstGenerate ? " · 简单需求 flash-first" : strongInitialGenerate && !fastMode ? " · 强模型优先" : ""}`,
  };

  if (!useDpl) {
    // 原生模式：产物是自包含 HTML，直接 srcDoc 渲染（不经沙箱、不跑 JSX 校验），可离线打开 + 直接编辑
    const extracted = extractHtmlDoc(codeRaw);
    let finalHtml = looksLikeHtml(extracted) ? extracted : stripFences(codeRaw);
    let checkStartedAt = Date.now();
    let structureIssues = yield* structureCheckStage(requirement, flow, finalHtml, {
      useDpl: false,
      device,
      components: [],
      fastMode,
    });
    recordTiming(runTiming, "structure-check", checkStartedAt, { outcome: structureIssues.length ? "issues" : "ok" });
    if (flashFirstGenerate && structureIssues.length) {
      const retryOverride = strongRetryOverride(effectiveModelPreference);
      const { provider: retryLLM, modelKey: retryModel } = getProviderForStage("generate", {
        needsVision: hasImages,
        override: retryOverride,
        preference: effectiveModelPreference,
      });
      yield {
        type: "step",
        stage: "generate",
        status: "start",
        detail: `结构自检未通过，升级模型重试:${structureIssues.slice(0, 2).join("；")}`,
      };
      const retryStartedAt = Date.now();
      const retryRaw = await retryLLM.complete({
        system:
          styleHead +
          generatePlainSystemPrompt(device) +
          (sessionContext ? `\n\n${SESSION_CONTEXT_SYSTEM_RULE}` : ""),
        messages: [
          {
            role: "user",
            content: userContent(
              buildSessionAwareUserMessage(
                `${brief}\n\n上一次快速生成存在这些结构问题，请本次补齐并保持单页原型完整：\n${structureIssues
                  .map((i) => `- ${i}`)
                  .join("\n")}`,
                sessionContext
              ),
              images
            ),
          },
        ],
        temperature: 0.4,
        maxTokens: GENERATE_MAX_TOKENS,
      });
      recordTiming(runTiming, "generate", retryStartedAt, { ...modelTiming(retryModel), outcome: "quality-retry" });
      yield { type: "step", stage: "generate", status: "done", detail: `升级模型:${retryModel}` };
      const retryExtracted = extractHtmlDoc(retryRaw);
      finalHtml = looksLikeHtml(retryExtracted) ? retryExtracted : stripFences(retryRaw);
      checkStartedAt = Date.now();
      structureIssues = yield* structureCheckStage(requirement, flow, finalHtml, {
        useDpl: false,
        device,
        components: [],
        fastMode,
      });
      recordTiming(runTiming, "structure-check", checkStartedAt, {
        ...modelTiming(retryModel),
        outcome: structureIssues.length ? "retry-issues" : "retry-ok",
      });
    }
    // ③.6 自评审 + 定向优化
    finalHtml = yield* reviewAndRefine(requirement, finalHtml, {
      flow,
      useDpl: false,
      device,
      components: [],
      styleHead,
      modelPreference: effectiveModelPreference,
      fastMode,
      structureIssues,
      hasImages,
      hasDocs,
      hasStyleProfile: Boolean(profile),
      timingBase: runTiming,
    });
    // 确定性矫正品牌色漂移（如 #FF8060 被写成 #FF8040）；原生 HTML 不注入 themeCss，更依赖此步
    const colorFix = normalizeBrandColors(finalHtml, profile?.themeCss);
    if (colorFix.fixed.length) {
      finalHtml = colorFix.code;
      console.log(`[validate] 品牌色矫正: ${colorFix.fixed.join(", ")}`);
    }
    // 【临时停用】nav-repair：repairUnsafeHtmlNavigation 把整页塞 system prompt、非流式、maxTokens=128000
    // 重出整页来修跳转，请求在火山方舟 /api/plan 上易挂且 httpFetch 无超时会卡到 undici ~300s，
    // 前端停在"已生成 N KB"不动。预览期跳转守卫仍兜底，故先注释停用。恢复时移除本块注释符即可。
    /*
    const navRepairStartedAt = Date.now();
    const navigationRepair = await repairUnsafeHtmlNavigation(genLLM, finalHtml, profile);
    recordTiming(runTiming, "nav-repair", navRepairStartedAt, {
      ...modelTiming(gmodel),
      outcome: navigationRepair.issues.length
        ? navigationRepair.repaired
          ? "repaired"
          : "blocked"
        : "skipped",
    });
    if (navigationRepair.issues.length) {
      finalHtml = navigationRepair.html;
      yield {
        type: "step",
        stage: "validate",
        status: "done",
        detail: navigationRepair.repaired
          ? `已修复页面跳转：${navigationRepair.issues.join("、")}`
          : `检测到页面跳转风险，预览将拦截：${navigationRepair.issues.join("、")}`,
      };
    }
    */
    // 内联脚本语法守卫：模型偶发吐错标点会让整段 <script> 解析失败、页面交互全失效
    // （列表/抽屉/页签空白）。结构校验只查 HTML 标签、查不到 JS 语法，故在此单独兜一次。
    const jsSyntaxErrors = checkInlineScriptsSyntax(finalHtml);
    if (jsSyntaxErrors.length) {
      yield {
        type: "step",
        stage: "validate",
        status: "start",
        detail: `内联脚本语法错误，定向修复（${jsSyntaxErrors.length} 处）`,
      };
      const jsRepairStartedAt = Date.now();
      const jsRepair = await repairInlineScriptSyntax(genLLM, finalHtml, jsSyntaxErrors, profile);
      recordTiming(runTiming, "js-repair", jsRepairStartedAt, {
        ...modelTiming(gmodel),
        outcome: jsRepair.repaired ? "repaired" : "skipped",
      });
      if (jsRepair.repaired) {
        finalHtml = jsRepair.html;
        yield { type: "step", stage: "validate", status: "done", detail: "已修复内联脚本语法错误" };
      } else {
        console.warn("[validate] 内联脚本语法错误未修复，保留原稿:", jsSyntaxErrors.slice(0, 3).join(" | "));
        yield {
          type: "step",
          stage: "validate",
          status: "done",
          detail: "内联脚本语法错误修复未生效，保留原稿",
        };
      }
    }
    yield { type: "step", stage: "preview", status: "start", detail: "渲染本地 HTML 预览" };
    const previewStartedAt = Date.now();
    yield { type: "code", code: finalHtml };
    const preview = { html: finalHtml, source: "raw" as const };
    yield { type: "preview", preview };
    yield { type: "step", stage: "preview", status: "done", detail: "本地 HTML 预览" };
    recordTiming(runTiming, "preview", previewStartedAt, { outcome: "raw" });
    yield {
      type: "done",
      result: {
        flow,
        components: [],
        code: finalHtml,
        preview,
        html: true,
        device,
        styleProfileId: profile?.id,
        modelPreference: effectiveModelPreference,
      },
    };
    return;
  }
}

/** 构造一个最小 flow（原样 HTML 没有结构化产物，仅用于结果展示） */
function htmlFlow(name: string): FlowSpec {
  const title = name.replace(/\.[a-z0-9]+$/i, "");
  return {
    title,
    summary: "原样打开的 HTML 页面",
    pages: [{ id: "page", name: "页面", summary: "", sections: [], componentNeeds: [], dataFields: [] }],
    navigations: [],
  };
}

/**
 * 原生 HTML 没有 JSX 校验阶段，因此在生成/整页编辑完成后单独做一次导航静态门禁。
 * 上传原样打开不擅自改文件，只提示并交给预览期守卫；这里仅处理模型新生成或模型编辑的产物。
 */
async function repairUnsafeHtmlNavigation(
  provider: LLMProvider,
  html: string,
  profile?: StyleProfile
): Promise<{ html: string; issues: string[]; repaired: boolean }> {
  const issues = unsafePrototypeNavigation(html);
  if (!issues.length) return { html, issues, repaired: false };
  try {
    const raw = await provider.complete({
      system: editHtmlSystemPrompt(html, profile),
      messages: [{ role: "user", content: prototypeNavigationRepairInstruction(issues) }],
      temperature: 0,
      maxTokens: EDIT_MAX_TOKENS,
    });
    const candidate = extractHtmlDoc(raw);
    if (
      looksLikeHtml(candidate) &&
      unsafePrototypeNavigation(candidate).length === 0 &&
      validateEditedHtmlDoc(html, candidate).ok &&
      !looksRewritten(html, candidate)
    ) {
      return { html: candidate, issues, repaired: true };
    }
  } catch {
    // 预览期还有强制导航恢复兜底；修复调用失败不让整条生成链路失败。
  }
  return { html, issues, repaired: false };
}

/**
 * 内联脚本语法错误定向修复：与 repairUnsafeHtmlNavigation 同思路——用一次 LLM 调用只修语法
 * （标点/括号/引号/三元表达式等），候选须过 looksLikeHtml + 结构完整性 + 非整页重写 + 语法复检
 * 才采纳，失败不阻塞（保留原稿交预览期守卫兜底）。
 */
async function repairInlineScriptSyntax(
  provider: LLMProvider,
  html: string,
  errors: string[],
  profile?: StyleProfile
): Promise<{ html: string; repaired: boolean }> {
  try {
    const raw = await provider.complete({
      system: editHtmlSystemPrompt(html, profile),
      messages: [
        {
          role: "user",
          content:
            "页面内联 <script> 存在 JS 语法错误，浏览器会拒绝执行整段脚本、导致交互全部失效。\n" +
            "请只修正语法错误（多余标点/括号/引号/三元表达式等），不要重写页面、不要改功能逻辑、不要动 <style> 与 HTML 结构，输出完整的修正后 HTML 文档。\n" +
            "语法错误信息：\n" +
            errors.slice(0, 5).map((e) => "- " + e).join("\n"),
        },
      ],
      temperature: 0,
      maxTokens: EDIT_MAX_TOKENS,
    });
    const candidate = extractHtmlDoc(raw);
    if (
      looksLikeHtml(candidate) &&
      validateEditedHtmlDoc(html, candidate).ok &&
      !looksRewritten(html, candidate) &&
      checkInlineScriptsSyntax(candidate).length === 0
    ) {
      return { html: candidate, repaired: true };
    }
  } catch {
    // 修复失败不阻塞，保留原稿
  }
  return { html, repaired: false };
}
async function* runRawHtml(
  html: string,
  name: string,
  _requirement = "",
  modelPreference: ModelPreference = "auto",
  opts?: { doneSummary?: string | null; captureMeta?: import("@/lib/capturedPage").CaptureMeta }
): AsyncGenerator<PipelineEvent> {
  const flow = htmlFlow(name);
  yield { type: "flow", flow };
  yield { type: "step", stage: "open", status: "start", detail: "打开上传的 HTML" };
  yield { type: "step", stage: "open", status: "done", detail: name };

  const navigationIssues = unsafePrototypeNavigation(html);
  if (navigationIssues.length) {
    yield {
      type: "assistant",
      message: `检测到上传页面含真实跳转代码（${navigationIssues.join("、")}）。预览会拦截页面跳转，仅保留页内交互。`,
    };
  }

  const rawHtmlState = createRawHtmlState(html);
  yield { type: "code", code: html };
  const preview = { html, source: "raw" as const };
  yield { type: "preview", preview };
  yield {
    type: "done",
    summary: opts?.doneSummary,
    result: {
      flow,
      components: [],
      code: html,
      preview,
      rawHtml: true,
      html: true,
      rawHtmlState,
      modelPreference,
      captureMeta: opts?.captureMeta,
    },
  };
}

/**
 * 局部 scope patch：有标注锚点（extractScopePatchTarget）直接用；否则 auto-locate 定位目标。
 * 成功返回改后 HTML（含 annotated no-op 视为"该处无需改"返回原文）；未生效返回 null。
 * 未生效情形：批量指令（loc.batch）/ 无目标 / scope 选不出 / scope 片段两次校验失败 /
 *   自动定位 no-op（fromLocate 且输出与原文相同）/ 整页校验失败（looksRewritten 等）。
 * 调用方据 null 决定：小文件回退整页重出，大文件引导标注（避免整页爆上下文）。
 */
async function* tryScopePatch(
  original: string,
  instruction: string,
  provider: LLMProvider,
  modelPreference: ModelPreference,
  styleProfile?: StyleProfile,
  opts?: {
    reportFailureAssistant?: boolean;
    timingBase?: TimingBase;
    modelKey?: ModelKey;
    judgeModelKey?: ModelKey;
    interactiveEdit?: boolean;
    sessionContext?: string;
    editPlan?: EditPlan | null;
  }
): AsyncGenerator<PipelineEvent, string | null> {
  const reportFailureAssistant = opts?.reportFailureAssistant ?? true;
  const startedAt = Date.now();
  let timingRecorded = false;
  const finish = (outcome: string) => {
    if (timingRecorded) return;
    timingRecorded = true;
    if (opts?.timingBase) {
      recordTiming(opts.timingBase, "try-scope-patch", startedAt, {
        ...modelTiming(opts.modelKey),
        outcome,
      });
    }
  };
  try {
  let scopeTarget = extractScopePatchTarget(instruction);
  const interactiveEdit = opts?.interactiveEdit ?? isInteractiveHtmlEditInstruction(instruction);
  let editPlan = opts?.editPlan ?? null;
  console.log(
    `[anno] tryScopePatch start: origLen=${original.length} anchorId=${scopeTarget?.anchorId ?? "-"} targetHtmlLen=${
      scopeTarget?.targetHtml?.length ?? 0
    } interactive=${interactiveEdit} instr="${instruction.replace(/\s+/g, " ").slice(0, 80)}"`
  );
  let fromLocate = false;
  if (!scopeTarget && interactiveEdit) {
    yield { type: "step", stage: "edit", status: "done", detail: "交互修改需要整页上下文" };
    console.log(`[anno] outcome=skip (interactive needs fullpage)`);
    finish("skip_interactive");
    return null;
  }
  if (!scopeTarget && original.length >= LOCATE_MIN_HTML) {
    yield { type: "step", stage: "edit", status: "start", detail: "自动定位修改目标" };
    const summary = buildDomSummary(original);
    editPlan = await planHtmlEdit(instruction, summary, modelPreference, {
      override: opts?.judgeModelKey,
      sessionContext: opts?.sessionContext,
    });
    if (editPlan) {
      console.log(
        `[edit-plan] op=${editPlan.operation} scope=${editPlan.scopeHint ?? "-"} batch=${editPlan.batch} interactive=${editPlan.interactive} full=${editPlan.needsFullPage} conf=${editPlan.confidence}`
      );
      if (editPlan.needsFullPage || editPlan.interactive || editPlan.batch) {
        yield {
          type: "step",
          stage: "edit",
          status: "done",
          detail: editPlan.interactive ? "交互修改需要整页上下文" : editPlan.batch ? "批量指令，不走单点定位" : "编辑计划建议整页处理",
        };
        console.log(`[anno] outcome=skip by edit-plan`);
        finish(editPlan.interactive ? "plan_skip_interactive" : editPlan.batch ? "plan_skip_batch" : "plan_skip_fullpage");
        return null;
      }
    }
    const locateInstruction = editPlan
      ? `${instruction}\n\n编辑计划：目标=${editPlan.targetDescription ?? "-"}；作用域=${editPlan.scopeHint ?? "-"}；目标文字=${
          editPlan.targetText ?? "-"
        }；替换/新增=${editPlan.replacementText ?? "-"}；selector=${editPlan.selectorHint ?? "-"}；offset=${editPlan.offsetHint ?? "-"}`
      : instruction;
    const loc = await locateScopeTarget(locateInstruction, summary, modelPreference, {
      override: opts?.judgeModelKey,
      sessionContext: opts?.sessionContext,
    });
    // 批量指令（"所有/全部/每个"）不该单点 scope patch——易选错代表元素且 scope 上提常漏改。
    // 小文件由调用方回退整页 find/replace；大文件由调用方引导标注。
    if (loc && !loc.ambiguous && loc.confidence >= LOCATE_MIN_CONFIDENCE && !loc.batch) {
      const range = matchLocateToAnchor(original, loc);
      if (range) {
        scopeTarget = { instruction, targetHtml: original.slice(range.start, range.end) };
        fromLocate = true;
        console.log(`[anno] locate hit: tag=<${range.tag}> conf=${loc.confidence.toFixed(2)}`);
        yield { type: "step", stage: "edit", status: "start", detail: `已定位目标:<${range.tag}> 置信度${loc.confidence.toFixed(2)}` };
      } else {
        console.log(`[anno] locate miss: range not matched conf=${loc.confidence.toFixed(2)}`);
      }
    } else {
      console.log(`[anno] locate miss: ambiguous=${loc?.ambiguous} conf=${loc?.confidence?.toFixed(2) ?? "-"} batch=${loc?.batch}`);
    }
    if (!scopeTarget) {
      yield { type: "step", stage: "edit", status: "done", detail: loc?.batch ? "批量指令，不走单点定位" : "未定位到明确目标" };
    }
    if (!scopeTarget && loc) {
      finish(loc.batch ? "locate_batch" : loc.ambiguous ? "locate_ambiguous" : loc.confidence < LOCATE_MIN_CONFIDENCE ? "locate_low_confidence" : "locate_miss");
    }
  }
  if (!scopeTarget) {
    console.log(`[anno] outcome=no-scope-target (fallback to fullpage)`);
    finish("no_scope_target");
    return null;
  }

  // 删除快路径：直接从原文剪掉目标元素，不调 LLM。
  // LLM 重写父级 scope 在大页面上易截断（B-E16：2.8MB 页面父级 scope 几十万字符，48K token 放不下忠实副本）；
  // 删除是确定性操作（定位元素 → 剪除），无需 LLM，任意大小都能处理。校验失败则落到下方 LLM scope patch。
  const isDelete = isDeleteInstruction(scopeTarget.instruction);
  // B-4: 检测锚点(或祖先)是否被脚本动态注入内容 -> 编辑后提示"重开可能被还原"
  const scriptInjectedId = detectScriptInjectedAnchor(original, scopeTarget.targetHtml, scopeTarget.anchorId);
  // B-6: 列删除(td/th 锚点)需判定是"整列删"还是"单单元格删"。仅对表格单元格锚点的删除补算 editPlan
  // （LLM 判 scopeHint=table-column），非表格删除仍走零 LLM 快路径。planHtmlEdit 5s withTimeout，失败正则兜底。
  const isTableCellAnchor = /^\s*(?:<!--[\s\S]*?-->\s*)?<(?:th|td)\b/i.test(scopeTarget.targetHtml);
  if (!editPlan && isDelete && isTableCellAnchor && scopeTarget.instruction) {
    const summary = buildDomSummary(original);
    editPlan = await planHtmlEdit(scopeTarget.instruction, summary, modelPreference, {
      override: opts?.judgeModelKey,
      sessionContext: opts?.sessionContext,
    });
    if (editPlan) {
      console.log(
        `[edit-plan] op=${editPlan.operation} scope=${editPlan.scopeHint ?? "-"} batch=${editPlan.batch} conf=${editPlan.confidence} (col-delete check)`
      );
    }
  }
  // 列删除：表格单元格锚点 + LLM 判定 scopeHint 含 "column"（漏判时 /列|栏/ 正则兜底）。
  // 注意：不放"项"--"删除这一项"通常指删一条记录(行)而非整列，误判会致 directDeleteColumn 删整列丢数据。
  const isColumnDelete =
    isDelete &&
    isTableCellAnchor &&
    ((editPlan?.scopeHint ?? "").toLowerCase().includes("column") || /列|栏/.test(scopeTarget.instruction));
  if (isDelete && !isColumnDelete) {
    const deleted = directDeleteElement(original, scopeTarget.targetHtml, scopeTarget.anchorId);
    if (deleted && validateEditedHtmlDoc(original, deleted, { deleteMode: true }).ok && !looksRewritten(original, deleted, { deleteMode: true })) {
      yield { type: "step", stage: "edit", status: "start", detail: "删除：直接移除目标元素" };
      if (scriptInjectedId) yield { type: "assistant", message: scriptInjectedAnchorWarning(scriptInjectedId) };
      console.log(`[anno] outcome=delete-fastpath applied`);
      finish("direct_delete_applied");
      return deleted;
    }
    // 删除快路径失败（定位不到/校验不过）→ 落到 LLM scope patch 兜底
  } else if (isColumnDelete) {
    // B-6: 列删除优先走确定性跨行删同列(directDeleteColumn),失败再落 LLM 表格 scope patch(带列删除提示)
    const colDeleted = directDeleteColumn(original, scopeTarget.targetHtml, scopeTarget.anchorId);
    if (colDeleted && validateEditedHtmlDoc(original, colDeleted, { deleteMode: true }).ok && !looksRewritten(original, colDeleted, { deleteMode: true })) {
      yield { type: "step", stage: "edit", status: "start", detail: "删除：跨行移除整列" };
      if (scriptInjectedId) yield { type: "assistant", message: scriptInjectedAnchorWarning(scriptInjectedId) };
      console.log(`[anno] outcome=coldelete-fastpath applied`);
      finish("direct_column_delete_applied");
      return colDeleted;
    }
  }

  if (!isDelete && /隐藏|不显示|不可见/.test(scopeTarget.instruction)) {
    const hidden = directHideElement(original, scopeTarget.targetHtml, scopeTarget.anchorId);
    if (hidden && validateEditedHtmlDoc(original, hidden).ok && !looksRewritten(original, hidden)) {
      yield { type: "step", stage: "edit", status: "start", detail: "隐藏：直接隐藏目标元素" };
      if (scriptInjectedId) yield { type: "assistant", message: scriptInjectedAnchorWarning(scriptInjectedId) };
      console.log(`[anno] outcome=hide-fastpath applied`);
      finish("direct_hide_applied");
      return hidden;
    }
  }

  // 标注路径补算 editPlan，驱动 scope 上提与 deleteMode。非表格删除/非删除指令在此补算（快路径后，不阻塞零 LLM 快路径）；
  // 表格单元格删除已在上方快路径前补算（用于 isColumnDelete 判定），此处 !editPlan 守卫跳过。
  // best-effort：失败/超时返回 null，下方 selectHtmlPatchScope 回退原正则。
  if (!editPlan && scopeTarget.instruction) {
    const summary = buildDomSummary(original);
    editPlan = await planHtmlEdit(scopeTarget.instruction, summary, modelPreference, {
      override: opts?.judgeModelKey,
      sessionContext: opts?.sessionContext,
    });
    if (editPlan) {
      console.log(
        `[edit-plan] op=${editPlan.operation} scope=${editPlan.scopeHint ?? "-"} batch=${editPlan.batch} interactive=${editPlan.interactive} full=${editPlan.needsFullPage} conf=${editPlan.confidence}`
      );
    }
  }

  const isDedupOp = editPlan?.operation === "dedup";
  let scope = isDedupOp
    ? selectDedupScope(original, scopeTarget.targetHtml, scopeTarget.anchorId)
    : selectHtmlPatchScope(original, scopeTarget.targetHtml, scopeTarget.instruction, scopeTarget.anchorId, editPlan ?? undefined);
  // dedup 在静态 HTML 没找到重复项 → 重复可能来自脚本双重渲染或跨远端区域，
  // scope patch（改静态片段）原理上修不了 → return null 升级整页，让模型看到 <script> 在源头去重。
  if (isDedupOp && "error" in scope) {
    console.log(`[anno] dedup scope miss: ${scope.error} -> escalate fullpage`);
    yield { type: "step", stage: "edit", status: "start", detail: "未发现静态重复项，转整页检查（含脚本双重渲染）" };
    finish("dedup_no_static_dup_escalate_fullpage");
    return null;
  }
  if ("error" in scope) {
    yield { type: "step", stage: "edit", status: "done", detail: scope.error };
    if (reportFailureAssistant) {
      yield { type: "assistant", message: `${scope.error}，已保留原页面。请重新点选更明确的元素。` };
    }
    console.log(`[anno] outcome=scope-error reason=${scope.error}`);
    finish("scope_select_error");
    return null;
  }
  console.log(`[anno] scope selected: tag=<${scope.tag}> size=${scope.html.length} reason=${scope.reason}`);

  if (styleProfile) console.log(`[style-debug] scope tag=<${scope.tag}> size=${scope.html.length} reason=${scope.reason} profile=${styleProfile.id} instr="${scopeTarget.instruction.slice(0, 50)}"`);
  yield { type: "step", stage: "edit", status: "start", detail: `局部作用域修改:${scope.reason}` };
  const deterministic = tryDeterministicScopePatch(scope.html, scopeTarget.instruction);
  if (deterministic && !scopeReplacementUnchanged(scope.html, deterministic.html)) {
    const html = removeTemporaryAnchors(applyScopeReplacement(original, scope, deterministic.html));
    const validation = validateEditedHtmlDoc(original, html);
    if (validation.ok && !looksRewritten(original, html)) {
      yield { type: "step", stage: "edit", status: "done", detail: `确定性局部修改:${deterministic.kind}` };
      if (scriptInjectedId) yield { type: "assistant", message: scriptInjectedAnchorWarning(scriptInjectedId) };
      console.log(`[anno] outcome=deterministic-${deterministic.kind} applied`);
      finish(`deterministic_${deterministic.kind}`);
      return html;
    }
  }
  const colDeleteHint = isColumnDelete ? "\n\n注意：这是「删除整列」操作--请删除标注单元格所在的整列：表头(thead)里对应的 <th>，以及每一行 <tr> 里该列对应的 <td>，其余列原样保留。不要删整行、不要改其他列。" : "";
  const { compact: compactScopeHtml, map: scopeAssetMap } = compactDataUris(scope.html);
  const { compact: compactTargetHtml } = compactDataUris(scopeTarget.targetHtml);
  const compactScope = { ...scope, html: compactScopeHtml };
  const patchUserMsg = buildSessionAwareUserMessage(
    `修改要求：${scopeTarget.instruction}${colDeleteHint}\n\n标注锚点元素：\n${compactTargetHtml}\n\n请输出替换后的 <${scope.tag}> 作用域 HTML。`,
    opts?.sessionContext
  );
  const rawPatch = await provider.complete({
    system: editHtmlScopeSystemPrompt(compactScope.html, styleProfile, Boolean(opts?.sessionContext)),
    messages: [{ role: "user", content: patchUserMsg }],
    maxTokens: EDIT_MAX_TOKENS,
  });
  if (styleProfile) console.log(`[style-debug] rawPatch len=${rawPatch.length} head=${JSON.stringify(rawPatch.slice(0, 300))}`);
  // 删除/移动操作的替换片段本就比 scope 小，用 deleteMode 放宽下限 + 加 no-op 上限
  // dedup 删多份时 replacement 可能跌破 35% 长度下限 → 用 LLM 判定的 operation 触发放宽，不新增指令正则。
  // editPlan 在场用 operation（delete/move）；缺席回退原 inline 正则（含移动/排序/置顶等，比 isDeleteInstruction 宽），
  // 与 selectHtmlPatchScope 的 removeOrMoveIntent 同源对齐。
  const deleteMode =
    isDedupOp ||
    (editPlan ? editPlan.operation === "delete" || editPlan.operation === "move" : /删除|删掉|删去|移除|去掉|清除|清空|移动|移到|移至|排序|置顶|置底|挪/.test(scopeTarget.instruction));
  let compactReplacement = extractScopeReplacement(compactScope, stripFences(rawPatch));
  let scopeValidation = validateScopeReplacement(compactScope, compactReplacement, { deleteMode });
  if (styleProfile) console.log(`[style-debug] replacement len=${compactReplacement.length} scopeLen=${compactScope.html.length} unchanged=${scopeReplacementUnchanged(compactScope.html, compactReplacement)} head=${JSON.stringify(compactReplacement.slice(0, 200))} validation=${JSON.stringify(scopeValidation)}`);
  if (!scopeValidation.ok) {
    yield { type: "step", stage: "edit", status: "start", detail: `局部片段不完整，纠正重试:${scopeValidation.reason}` };
    const retryPatch = await provider.complete({
      system: editHtmlScopeSystemPrompt(compactScope.html, styleProfile, Boolean(opts?.sessionContext)),
      messages: [
        { role: "user", content: patchUserMsg },
        { role: "assistant", content: `${compactReplacement.slice(0, 1200)}\n...(上一次输出不完整，原因：${scopeValidation.reason})` },
        { role: "user", content: `你上一次输出的局部片段不完整。请重新输出完整的 <${scope.tag}> 作用域 HTML：必须从 <${scope.tag} 开始，并以 </${scope.tag}> 结束；不要输出整页 HTML，不要解释。` },
      ],
      maxTokens: EDIT_MAX_TOKENS,
    });
    compactReplacement = extractScopeReplacement(compactScope, stripFences(retryPatch));
    scopeValidation = validateScopeReplacement(compactScope, compactReplacement, { deleteMode });
  }
  if (scopeValidation.ok) {
    const assetValidation = validateAssetPlaceholders(compactReplacement, scopeAssetMap, { allowMissing: deleteMode });
    if (!assetValidation.ok) scopeValidation = { ok: false, reason: assetValidation.reason || "资源占位符损坏" };
  }
  if (!scopeValidation.ok) {
    yield { type: "step", stage: "edit", status: "done", detail: `已保留原页面:${scopeValidation.reason}` };
    if (reportFailureAssistant) {
      yield { type: "assistant", message: `本次局部修改结果不完整，已保留原页面，没有生成新版本。原因：${scopeValidation.reason}。请缩小修改范围或重试。` };
    }
    finish(scopeValidation.reason.includes("资源占位符") ? "asset_placeholder_failed" : "scope_validation_failed");
    return null;
  }

  const replacement = expandDataUris(compactReplacement, scopeAssetMap);
  const html = removeTemporaryAnchors(applyScopeReplacement(original, scope, replacement));
  if (styleProfile) console.log(`[style-debug] html len=${html.length} origLen=${original.length} html==orig=${html === original}`);
  // 自动定位选错 scope 时，模型在该 scope 内找不到目标 → 输出与原文相同（no-op）。
  // 返回 null 由调用方回退整页（小文件）或引导标注（大文件）。用户点选标注的 no-op 视为"该处无需改"，返回原文。
  // 用 scope 片段比对替代整页 isTrivialNoOp：后者对等长文本替换（如"产品活跃"→"活跃情况"）会假阳性
  // （长度差 0%、1 行变化被判 no-op），把真实改动误丢。
  if (fromLocate && (html === original || scopeReplacementUnchanged(scope.html, replacement))) {
    console.log(`[anno] outcome=no-op (locate scope unchanged)`);
    finish("no_op");
    return null;
  }
  // 【临时屏蔽】点选 scope-patch 路径的交互 no-op 闸门，与 fullpage 路径保持一致。
  // 原因：hasInteractionDelta 仅认 6 种事件模式，复用已有 handler / <details> / CSS / 非 listed 事件
  // 会被误判为"无交互改动"而丢弃模型已完成的局部修改。待拓宽判定后再恢复。
  // if (interactiveEdit && !hasInteractionDelta(original, html)) {
  //   console.log(`[anno] outcome=no-op (interactive no delta)`);
  //   finish("interaction_no_delta");
  //   return null;
  // }

  const validation = validateEditedHtmlDoc(original, html, { deleteMode });
  if (styleProfile) console.log(`[style-debug] validateEditedHtmlDoc=${JSON.stringify(validation)} looksRewritten=${looksRewritten(original, html, { deleteMode })}`);
  if (!validation.ok || looksRewritten(original, html, { deleteMode })) {
    yield { type: "step", stage: "edit", status: "done", detail: `已保留原页面:${validation.reason || "修改结果疑似整页被重写"}` };
    if (reportFailureAssistant) {
      yield { type: "assistant", message: `本次局部修改后页面校验失败，已保留原页面，没有生成新版本。原因：${validation.reason || "修改结果疑似整页被重写"}。` };
    }
    console.log(`[anno] outcome=validation-fail reason=${validation.reason || "rewritten"}`);
    finish("edited_doc_validation_failed");
    return null;
  }
  if (scriptInjectedId) yield { type: "assistant", message: scriptInjectedAnchorWarning(scriptInjectedId) };
  console.log(`[anno] outcome=applied htmlLen=${html.length} origLen=${original.length}`);
  finish("applied");
  return html;
  } catch (err) {
    finish("exception");
    throw err;
  }
}

const CLAUDE_FOCUS_SCOPE_MAX_CHARS = 260_000;

function visibleTextForClaudeFocus(html: string): string {
  return String(html || "")
    .replace(/<style\b[\s\S]*?<\/style>|<script\b[\s\S]*?<\/script>|<!--[\s\S]*?-->/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;|&#38;/gi, "&")
    .replace(/&lt;|&#60;/gi, "<")
    .replace(/&gt;|&#62;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function claudeFocusScopeMismatchReason(scopeHtml: string, instruction: string, plan: EditPlan | null): string {
  const targetText = plan?.targetText?.trim() || "";
  if (targetText.length >= 2 && !visibleTextForClaudeFocus(scopeHtml).includes(targetText)) {
    return `targetText_not_in_scope:${targetText}`;
  }
  const planAndInstruction = `${plan?.targetDescription || ""} ${plan?.scopeHint || ""} ${instruction}`;
  const isTabTask = /页签|标签页|tab/i.test(planAndInstruction);
  // plan 在场用 interactive+interaction 判定（覆盖“联动/下钻”等正则未列的交互触发），OR 正则兜底；plan=null 纯走正则。
  const changesTabPanel =
    (plan?.interactive && plan.operation === "interaction") ||
    /(?:打开|点击|切换|选中)(?:后|时)?.{0,60}(?:展示|显示|呈现|打开)/.test(instruction) ||
    /(?:展示|显示|呈现).{0,40}(?:表格|列表|内容|详情|面板)/.test(instruction);
  const hasCompleteTabGroup =
    /\brole\s*=\s*["']tab["']/i.test(scopeHtml) && /\brole\s*=\s*["']tabpanel["']/i.test(scopeHtml);
  if (isTabTask && changesTabPanel && !hasCompleteTabGroup) return "tab_trigger_and_panel_cross_region";
  return "";
}

function formatClaudeEditPlan(plan: EditPlan | null, loc?: { tag?: string; offsetHint?: number; confidence?: number } | null) {
  const parts: string[] = [];
  if (plan) {
    parts.push(`operation=${plan.operation}`);
    if (plan.targetDescription) parts.push(`target=${plan.targetDescription}`);
    if (plan.scopeHint) parts.push(`scope=${plan.scopeHint}`);
    if (plan.targetText) parts.push(`targetText=${plan.targetText}`);
    if (plan.replacementText) parts.push(`replacement=${plan.replacementText}`);
    if (plan.selectorHint) parts.push(`selector=${plan.selectorHint}`);
    if (typeof plan.offsetHint === "number") parts.push(`planOffset=${plan.offsetHint}`);
    parts.push(`batch=${plan.batch ? "yes" : "no"}`);
    parts.push(`interactive=${plan.interactive ? "yes" : "no"}`);
    parts.push(`needsFullPage=${plan.needsFullPage ? "yes" : "no"}`);
    parts.push(`confidence=${plan.confidence.toFixed(2)}`);
  }
  if (loc) {
    if (loc.tag) parts.push(`locatedTag=<${loc.tag}>`);
    if (typeof loc.offsetHint === "number") parts.push(`locatedOffset=${loc.offsetHint}`);
    if (typeof loc.confidence === "number") parts.push(`locatedConfidence=${loc.confidence.toFixed(2)}`);
  }
  return parts.join("；");
}

async function buildClaudeEditFocus(
  original: string,
  instruction: string,
  modelPreference: ModelPreference,
  opts?: { judgeModelKey?: ModelKey; sessionContext?: string }
): Promise<ClaudeEditFocus | undefined> {
  const explicitTarget = extractScopePatchTarget(instruction);
  if (explicitTarget) {
    const scope = selectHtmlPatchScope(original, explicitTarget.targetHtml, explicitTarget.instruction, explicitTarget.anchorId);
    if ("error" in scope) {
      return {
        source: "annotation",
        plan: `annotation target; scopeError=${scope.error}`,
        targetHtml: truncateText(explicitTarget.targetHtml, 12000),
      };
    }
    return {
      source: "annotation",
      plan: `annotation target; scopeTag=<${scope.tag}>; scopeReason=${scope.reason}`,
      targetHtml: truncateText(explicitTarget.targetHtml, 12000),
      scopeStart: scope.start,
      scopeEnd: scope.end,
      scopeTag: scope.tag,
      scopeReason: scope.reason,
      scopeHtml: scope.html.length <= CLAUDE_FOCUS_SCOPE_MAX_CHARS ? scope.html : undefined,
    };
  }

  if (original.length < LOCATE_MIN_HTML) return undefined;
  const summary = buildDomSummary(original);
  const editPlan = await planHtmlEdit(instruction, summary, modelPreference, {
    override: opts?.judgeModelKey,
    sessionContext: opts?.sessionContext,
  });
  const locateInstruction = editPlan
    ? `${instruction}\n\n编辑计划：目标=${editPlan.targetDescription ?? "-"}；作用域=${editPlan.scopeHint ?? "-"}；目标文字=${
        editPlan.targetText ?? "-"
      }；替换/新增=${editPlan.replacementText ?? "-"}；selector=${editPlan.selectorHint ?? "-"}；offset=${editPlan.offsetHint ?? "-"}`
    : instruction;
  const loc = await locateScopeTarget(locateInstruction, summary, modelPreference, {
    override: opts?.judgeModelKey,
    sessionContext: opts?.sessionContext,
  });
  const baseFocus: ClaudeEditFocus | undefined = editPlan
    ? { source: "auto-locate", plan: formatClaudeEditPlan(editPlan, loc) }
    : undefined;
  if (!loc || loc.ambiguous || loc.confidence < LOCATE_MIN_CONFIDENCE) return baseFocus;
  const range = matchLocateToAnchor(original, loc);
  if (!range) return baseFocus;
  const targetHtml = original.slice(range.start, range.end);
  const scope = selectHtmlPatchScope(original, targetHtml, instruction);
  if ("error" in scope) {
    return {
      source: "auto-locate",
      plan: `${formatClaudeEditPlan(editPlan, loc)}；scopeError=${scope.error}`,
      targetOffset: range.start,
      targetHtml: truncateText(targetHtml, 12000),
    };
  }
  const scopeMismatchReason = claudeFocusScopeMismatchReason(scope.html, instruction, editPlan);
  if (scopeMismatchReason) {
    return {
      source: "auto-locate",
      plan: `${formatClaudeEditPlan(editPlan, loc)}；scopeRejected=${scopeMismatchReason}`,
    };
  }
  const scopedToLocatedTarget = scope.start === range.start && scope.end === range.end;
  if (editPlan?.needsFullPage && scopedToLocatedTarget) {
    return {
      source: "auto-locate",
      plan: `${formatClaudeEditPlan(editPlan, loc)}；scopeSkipped=needsFullPage_targetOnly`,
      targetOffset: range.start,
      targetHtml: truncateText(targetHtml, 12000),
    };
  }
  return {
    source: "auto-locate",
    plan: formatClaudeEditPlan(editPlan, loc),
    targetOffset: range.start,
    targetHtml: truncateText(targetHtml, 12000),
    scopeStart: scope.start,
    scopeEnd: scope.end,
    scopeTag: scope.tag,
    scopeReason: scope.reason,
    scopeHtml: scope.html.length <= CLAUDE_FOCUS_SCOPE_MAX_CHARS ? scope.html : undefined,
  };
}

type RawHtmlEditEntry = "first-upload" | "chat-edit" | "annotation";

interface RawHtmlEditOptions {
  applySelectedStyle?: boolean;
  entry?: RawHtmlEditEntry;
  openOriginalOnFailure?: boolean;
  sessionContext?: string;
  /** 编辑态上传的图片（≤4），作为需求附加说明随整页编辑送视觉编辑模型；仅原生 HTML 编辑态传入。 */
  images?: Attachments["images"];
}

/** 原样 HTML 的迭代修改：在原 HTML 上最小改动，不重做 */
async function* runEditRawHtml(
  instruction: string,
  previous: NonNullable<GenerateInput["previous"]>,
  modelPreference: ModelPreference = "auto",
  opts?: RawHtmlEditOptions
): AsyncGenerator<PipelineEvent> {
  yield { type: "step", stage: "edit", status: "start", detail: "在原 HTML 上修改" };
  const rawContext = getRawHtmlEditContext(previous.code, previous.rawHtmlState);
  const original = rawContext.editHtml;
  const originalPreview = rawContext.previewHtml;
  const originalAssetMap = rawContext.assetMap;
  const sizeInfo = analyzeRawHtmlEditContext(originalPreview, original, originalAssetMap, {
    fullpageEditThresholdBytes: MAX_FULLPAGE_EDIT_BYTES,
  });
  const annotatedEdit =
    previous.rawHtmlEditSource === "annotation" ||
    instruction.includes("<!-- yd-anchor:") ||
    /\bdata-yd-anchor=/.test(previous.code);
  const selectedPointEditModel = annotatedEdit ? pointSelectEditModelOverride(modelPreference) : undefined;
  const editImages = opts?.images;
  const editHasImages = (editImages?.length ?? 0) > 0;
  const { provider, modelKey } = getProviderForStage("editLarge", {
    preference: modelPreference,
    override: selectedPointEditModel,
  });
  const forceClaudeForLargeDialogEdit = !annotatedEdit && sizeInfo.originalBytes >= MAX_FULLPAGE_EDIT_BYTES;
  // 上传 HTML/ZIP 原样模式的普通对话编辑固定按原页面最小修改；
  // 标注局部重绘允许用户在弹窗里显式选择风格档案。
  const carriedStyleProfileId =
    previous.rawHtml && previous.rawHtmlEditSource !== "annotation" && !opts?.applySelectedStyle
      ? undefined
      : previous.styleProfileId;
  const styleProfile = getStyleProfile(carriedStyleProfileId);
  const sessionContext = opts?.sessionContext ?? "";
  // 点选/标注路径会把"选中元素的 HTML"追加在指令末尾（TARGET_ELEMENT_MARKERS 之后）。
  // 交互意图判定必须只看用户的原话，否则选中元素自身内容里的"查看/详情/操作/展开"等词
  // 会让一条纯样式指令（如"把列宽度缩小20%"）被误判为点击/详情交互，进而被 hasInteractionDelta 卡掉。
  const annotatedTarget = extractScopePatchTarget(instruction);
  const instructionForClassify = annotatedTarget?.instruction ?? instruction;
  const interactiveEdit = await resolveInteractiveHtmlEditInstruction(instructionForClassify, original, modelPreference, {
    judgeModelKey: selectedPointEditModel,
    sessionContext,
  });
  const annotatedScriptInjectedId = annotatedTarget
    ? detectScriptInjectedAnchor(original, annotatedTarget.targetHtml, annotatedTarget.anchorId)
    : null;
  let effectiveInstruction = annotatedScriptInjectedId
    ? scriptInjectedAnchorPersistentInstruction(instruction, annotatedScriptInjectedId)
    : instruction;
  // 点选路径跑一次 flash 路由器，识别 dedup 等意图（路由器说“改什么”，锚点只 narrowing“改哪里”）。
  // 闸口 LOCATE_MIN_HTML 与 auto-locate 一致——小页不付 flash 代价；结果传给 tryScopePatch 用，整页路径也据此加双重渲染提示。
  let editPlan: EditPlan | null = null;
  if (annotatedTarget && original.length >= LOCATE_MIN_HTML) {
    const summary = buildDomSummary(original);
    editPlan = await planHtmlEdit(instructionForClassify, summary, modelPreference, {
      override: selectedPointEditModel,
      sessionContext,
    });
    if (editPlan) {
      console.log(
        `[edit-plan] (point-select) op=${editPlan.operation} scope=${editPlan.scopeHint ?? "-"} batch=${editPlan.batch} interactive=${editPlan.interactive} full=${editPlan.needsFullPage} conf=${editPlan.confidence}`
      );
    }
  }
  const desktopStage: "open" | "edit" = opts?.entry === "first-upload" ? "open" : "edit";
  const scopeTimingBase = timingBase({
    mode: "edit",
    artifact: previous.rawHtml ? "raw" : "html",
    rawHtml: previous.rawHtml ?? false,
    hasAttachments: opts?.entry === "first-upload" || editHasImages,
    hasImages: editHasImages,
    hasDocs: opts?.entry === "first-upload" || Boolean(previous.rawHtml),
    fastMode: true,
    device: previous.device,
  });
  function* openOriginalAfterFailure(): Generator<PipelineEvent> {
    if (!opts?.openOriginalOnFailure) return;
    const rawHtmlState = rawContext.state;
    yield { type: "step", stage: "open", status: "start", detail: "打开上传的 HTML" };
    yield { type: "step", stage: "open", status: "done", detail: "修改未完成，已先原样打开上传页面" };
    yield { type: "code", code: originalPreview };
    const preview = { html: originalPreview, source: "raw" as const };
    yield { type: "preview", preview };
    yield {
      type: "done",
      summary: null,
      contextCommit: "artifact-only",
      result: {
        flow: previous.flow,
        components: [],
        code: originalPreview,
        preview,
        rawHtml: previous.rawHtml ?? false,
        html: true,
        rawHtmlState,
        device: previous.device,
        modelPreference,
        captureMeta: previous.captureMeta,
      },
    };
  }
  try {
  // 对话式（无点选标注）修改：进 scope patch / 客户端增强前，先试一次整页确定性替换快路径。
  // 改文案 / 改颜色 / 改 placeholder 这类可由程序确定性完成的修改，0 次 LLM 即可解决，且与页面大小
  // 无关——避免"替换一个文案"在小页面(<25KB)退化成整页重写、在大页面(≥160KB)退化成交客户端增强。
  // 仅对无标注的对话式编辑生效；点选标注路径仍在 tryScopePatch 内走 scope 级确定性替换，行为不变。
  // 确定性 matcher 极窄（裸"把X改成Y"且 X 在整页恰好出现 1 次 / 单一颜色 / 单一属性），未命中即落原路径。
  if (!annotatedEdit && !annotatedScriptInjectedId) {
    const detStartedAt = Date.now();
    const det = tryDeterministicScopePatch(original, instructionForClassify);
    if (det && !scopeReplacementUnchanged(original, det.html)) {
      const detHtml = removeTemporaryAnchors(det.html);
      if (validateEditedHtmlDoc(original, detHtml).ok && !looksRewritten(original, detHtml)) {
        const html = guardDeletedIdScriptRefs(originalPreview, expandDataUris(detHtml, originalAssetMap));
        if (!isTrivialNoOp(originalPreview, html)) {
          recordTiming(scopeTimingBase, "edit-deterministic-fastpath", detStartedAt, {
            outcome: `deterministic_${det.kind}`,
          });
          console.log(`[anno-edit] deterministic-fastpath applied: kind=${det.kind}`);
          yield { type: "step", stage: "edit", status: "done", detail: `确定性局部修改:${det.kind}` };
          const rawHtmlState = createRawHtmlState(html);
          yield { type: "code", code: html };
          const preview = { html, source: "raw" as const };
          yield { type: "preview", preview };
          yield {
            type: "done",
            result: {
              flow: previous.flow,
              components: [],
              code: html,
              preview,
              rawHtml: previous.rawHtml ?? false,
              html: true,
              rawHtmlState,
              device: previous.device,
              styleProfileId: carriedStyleProfileId,
              modelPreference,
              captureMeta: previous.captureMeta,
            },
          };
          return;
        }
      }
    }
  }
  let scopeHtmlRaw: string | null = null;
  if (forceClaudeForLargeDialogEdit) {
    console.log(
      `[anno-edit] original-size-gate: originalBytes=${sizeInfo.originalBytes} >= ${MAX_FULLPAGE_EDIT_BYTES} -> claude-direct`
    );
  } else if (annotatedScriptInjectedId) {
    yield { type: "step", stage: "edit", status: "done", detail: "点选元素由脚本动态生成，改走脚本数据源" };
    yield { type: "assistant", message: scriptInjectedAnchorPersistentMessage(annotatedScriptInjectedId) };
    console.log(`[anno-edit] skip scope patch: script-injected anchor #${annotatedScriptInjectedId} -> persistent fullpage edit`);
  } else {
    scopeHtmlRaw = yield* tryScopePatch(original, instruction, provider, modelPreference, styleProfile, {
      reportFailureAssistant: false,
      timingBase: scopeTimingBase,
      modelKey,
      judgeModelKey: selectedPointEditModel,
      interactiveEdit,
      sessionContext,
      editPlan,
    });
    console.log(`[anno-edit] tryScopePatch returned: ${scopeHtmlRaw ? `html(len=${scopeHtmlRaw.length})` : "null"} -> ${scopeHtmlRaw ? "apply" : "fullpage-fallback"}`);
    // dedup 在静态 HTML 无重复项 → 已 return null 升级整页；若页面含生成 DOM 的 <script>，补双重渲染提示让模型在源头去重
    if (scopeHtmlRaw === null && editPlan?.operation === "dedup") {
      if (/<script\b/i.test(original)) {
        effectiveInstruction = `${effectiveInstruction}\n\n（注意：页面含 <script> 动态生成内容，重复项可能来自静态 HTML 与脚本的双重渲染。请检查 <script>，删除静态重复部分或脚本的重复生成，使页面渲染后无重复；不要只改静态片段，否则刷新后脚本会重新注入重复。）`;
        console.log(`[anno-edit] dedup escalated to fullpage (script dual-render suspected)`);
      } else {
        console.log(`[anno-edit] dedup escalated to fullpage (no static dup, no script)`);
      }
    }
  }
  // 删除被脚本按 id 引用的元素会让重渲染脚本崩(B-2):对结果补 null-safe 脚本守卫。
  const scopeEditHtml = scopeHtmlRaw !== null ? guardDeletedIdScriptRefs(original, scopeHtmlRaw) : null;
  if (scopeEditHtml !== null) {
    const deleteMode = isDeleteInstruction(instruction);
    const assetValidation = validateAssetPlaceholders(scopeEditHtml, originalAssetMap, { allowMissing: deleteMode });
    if (!assetValidation.ok) {
      yield { type: "step", stage: "edit", status: "done", detail: `已保留原页面:${assetValidation.reason}` };
      yield { type: "assistant", message: `本次局部修改破坏了资源占位符，已保留原页面，没有生成新版本。原因：${assetValidation.reason}。` };
      yield* openOriginalAfterFailure();
      return;
    }
    const scopeHtml = guardDeletedIdScriptRefs(originalPreview, expandDataUris(scopeEditHtml, originalAssetMap));
    // 板斧 B（同整页）：作用域片段与原文逐字相同（空白差异/原样回吐）→ 模型未真正改动，
    // 不报成功、不发新版本。tryScopePatch 仅对"自动定位"路径拦 no-op（line 1763 的 fromLocate 闸口），
    // 用户点选标注的 no-op 会原样返回到这里，故在此再兜一道，避免"已更新"但页面没变的假成功。
    if (isTrivialNoOp(originalPreview, scopeHtml)) {
      yield { type: "step", stage: "edit", status: "done", detail: "未识别到明确改动，已保留原页面" };
      yield {
        type: "assistant",
        message: `未检测到明确改动，已保留原页面，没有生成新版本。请换一种说法或重新点选目标元素（如「把这一列宽度改成 120px」「把这一列变窄一些」）。`,
      };
      yield* openOriginalAfterFailure();
      return;
    }
    const rawHtmlState = createRawHtmlState(scopeHtml);
    yield { type: "step", stage: "edit", status: "done", detail: `模型:${modelKey}` };
    yield { type: "code", code: scopeHtml };
    const preview = { html: scopeHtml, source: "raw" as const };
    yield { type: "preview", preview };
    yield {
      type: "done",
      result: {
        flow: previous.flow,
        components: [],
        code: scopeHtml,
        preview,
        rawHtml: previous.rawHtml ?? false,
        html: true,
        rawHtmlState,
        device: previous.device,
        styleProfileId: carriedStyleProfileId,
        modelPreference,
        captureMeta: previous.captureMeta,
      },
    };
    return;
  }
  // scope patch 未生效（无目标/批量/校验失败/自动定位 no-op）：
  // 大文件不回退整页（editHtmlSystemPrompt 整页塞 system prompt 会爆上下文、300s 超时），引导标注或缩小范围
  // 闸口按占位后体积判断：base64/字体 data URI 先占位压缩，让「结构不大、资源撑大」的页面也能走整页编辑
  if (forceClaudeForLargeDialogEdit || sizeInfo.shouldUseClaude) {
    console.log(
      `[anno-edit] size-gate: force=${forceClaudeForLargeDialogEdit} compactBytes=${sizeInfo.compactBytes} originalBytes=${sizeInfo.originalBytes}`
    );
    yield { type: "step", stage: "edit", status: "start", detail: "正在生成客户端增强精确锚点" };
    const claudeFocus = await buildClaudeEditFocus(original, effectiveInstruction, modelPreference, {
      judgeModelKey: selectedPointEditModel,
      sessionContext,
    });
    if (claudeFocus?.scopeHtml) {
      yield {
        type: "step",
        stage: "edit",
        status: "start",
        detail: `已抽取目标容器:<${claudeFocus.scopeTag ?? "section"}> ${formatKb(claudeFocus.scopeHtml.length)}`,
      };
    } else if (claudeFocus?.plan) {
      yield { type: "step", stage: "edit", status: "start", detail: "已生成编辑计划锚点" };
    }
    yield {
      type: "desktop-claude-required",
      stage: desktopStage,
      reason: "large_html_scope_patch_failed",
      sizeInfo,
      interactiveEdit,
      device: previous.device,
      styleProfileId: carriedStyleProfileId,
      editHtml: original,
      assets: rawContext.state.assets,
      instruction: effectiveInstruction,
      focus: claudeFocus,
      sessionContext,
      message:
        sizeInfo.assetCount > 0
          ? `页面较大（原始 ${formatKb(sizeInfo.originalBytes)}，资源占位后 ${formatKb(sizeInfo.compactBytes)}），建议交给客户端增强处理`
          : `页面较大（${formatKb(sizeInfo.originalBytes)}），已交给客户端增强处理`,
    };
    return;
  }

  // 全局视觉类指令（改主色调/换配色/调布局/重绘风格/优化视觉）用 editHtmlGlobalStylePrompt，
  // 避免局部修改 prompt 的"配色一字不改"铁律把全局视觉指令卡成 no-op（A03/A05/A06/A12）。
  // 由 LLM 判定（原 isGlobalHtmlEditInstruction 正则已取代）：null/低置信（<0.8）一律 false，保守走局部 prompt，
  // 避免全局重写 prompt 借机改掉不该改的内容（confidence 闸在代码层强制，与 prompt 要求一致）。
  const globalIntent = await classifyGlobalVisualEditInstruction(effectiveInstruction, modelPreference, {
    override: selectedPointEditModel,
    sessionContext,
  });
  const globalStyleEdit = globalIntent?.global === true && (globalIntent.confidence ?? 0) >= 0.8;
  console.log(
    `[global-visual-intent] global=${globalStyleEdit} conf=${globalIntent?.confidence?.toFixed(2) ?? "-"} instr="${effectiveInstruction.slice(0, 50)}"`
  );
  const effectiveUserMessage = buildSessionAwareUserMessage(effectiveInstruction, sessionContext);
  const editPrompt = globalStyleEdit
    ? editHtmlGlobalStylePrompt(original, styleProfile, Boolean(sessionContext))
    : editHtmlSystemPrompt(original, styleProfile, Boolean(sessionContext));
  // 编辑态上传图片：仅整页编辑这一路送视觉模型 + 多模态消息（scope patch / nav-repair / claude-focus 仍用文本编辑模型，图片不送——见已知限制）。
  const visionEdit = editHasImages
    ? getProviderForStage("editLarge", { preference: modelPreference, override: selectedPointEditModel, needsVision: true })
    : null;
  const editProvider = visionEdit?.provider ?? provider;
  const editModelKey = visionEdit?.modelKey ?? modelKey;
  const editUserContent = editHasImages ? userContent(effectiveUserMessage, editImages) : effectiveUserMessage;
  const raw = yield* streamCode(editProvider, {
    system: editPrompt,
    messages: [{ role: "user", content: editUserContent }],
    maxTokens: EDIT_MAX_TOKENS,
  });
  const deleteMode = isDeleteInstruction(instruction);
  const editHtml = extractHtmlDoc(raw);
  const assetValidation = validateAssetPlaceholders(editHtml, originalAssetMap, { allowMissing: deleteMode });
  // 回填占位符后再校验/判定，与 originalPreview（含真实 data URI）apples-to-apples
  let html = assetValidation.ok ? expandDataUris(editHtml, originalAssetMap) : editHtml;

  // 模型没返回 HTML（多半是把这句当成提问而闲聊了）：不覆盖原页，给一句澄清，不发 done（result 维持原状）
  if (!assetValidation.ok || !looksLikeHtml(html)) {
    yield { type: "step", stage: "edit", status: "done", detail: "未检测到修改" };
    yield {
      type: "assistant",
      message: assetValidation.ok
        ? "这条看起来不是修改指令，我没有改动页面。如果想改，请说明要改哪里、改成什么。"
        : `本次修改破坏了资源占位符，已保留原页面，没有生成新版本。原因：${assetValidation.reason}。`,
    };
    yield* openOriginalAfterFailure();
    return;
  }

  // 【临时停用】nav-repair：见上方生成路径同名注释。编辑路径整页重出修跳转易挂（/api/plan 不返回 +
  // httpFetch 无超时），预览期跳转守卫仍兜底，先注释停用。恢复时移除本块注释符即可。
  /*
  const navRepairStartedAt = Date.now();
  const navigationRepair = await repairUnsafeHtmlNavigation(provider, html, styleProfile);
  recordTiming(scopeTimingBase, "nav-repair", navRepairStartedAt, {
    ...modelTiming(modelKey),
    outcome: navigationRepair.issues.length ? (navigationRepair.repaired ? "repaired" : "blocked") : "skipped",
  });
  if (navigationRepair.issues.length) {
    html = navigationRepair.html;
    yield {
      type: "step",
      stage: "validate",
      status: "done",
      detail: navigationRepair.repaired
        ? `已修复页面跳转：${navigationRepair.issues.join("、")}`
        : `检测到页面跳转风险，预览将拦截：${navigationRepair.issues.join("、")}`,
    };
  }
  */

  let validation = validateEditedHtmlDoc(originalPreview, html, { deleteMode });

  // 偏离护栏：若模型把整页重写/截断了，用更强的纠正指令重试一次
  if (!validation.ok || looksRewritten(originalPreview, html, { deleteMode })) {
    yield {
      type: "step",
      stage: "edit",
      status: "start",
      detail: validation.ok ? "检测到整页被重写，纠正重试" : `修改结果不完整，纠正重试:${validation.reason}`,
    };
    const retry = await editProvider.complete({
      system: editPrompt,
      messages: [
        { role: "user", content: editUserContent },
        { role: "assistant", content: html.slice(0, 400) + " …(此为你上一次的错误输出，整页被重做了)" },
        {
          role: "user",
          content:
            "你上一次把整页重写/简化了，这是错误的。请重新来：以【当前 HTML】为基底逐字保留，仅在合适位置插入/改动我这次要求的部分，标题与所有原有模块原样不动。只输出完整 HTML。",
        },
      ],
      maxTokens: EDIT_MAX_TOKENS,
    });
    const retriedEditHtml = extractHtmlDoc(retry);
    const retryAssetValidation = validateAssetPlaceholders(retriedEditHtml, originalAssetMap, { allowMissing: deleteMode });
    const retried = retryAssetValidation.ok ? expandDataUris(retriedEditHtml, originalAssetMap) : retriedEditHtml;
    const retryValidation = retryAssetValidation.ok
      ? validateEditedHtmlDoc(originalPreview, retried, { deleteMode })
      : retryAssetValidation;
    if (retryAssetValidation.ok && looksLikeHtml(retried) && retryValidation.ok && !looksRewritten(originalPreview, retried, { deleteMode })) {
      html = retried;
      validation = { ok: true, reason: retryValidation.reason || "" };
    } else {
      validation = retryValidation.ok
        ? { ok: false, reason: "修改结果疑似整页被重写" }
        : { ok: false, reason: retryValidation.reason || "修改结果不完整" };
    }
  }

  // 最终闸门：不完整的 HTML 绝不覆盖上一版，避免产生白屏历史版本。
  if (!validation.ok) {
    yield { type: "step", stage: "edit", status: "done", detail: `已保留原页面:${validation.reason}` };
    yield {
      type: "assistant",
      message: `本次修改结果不完整，已保留原页面，没有生成新版本。原因：${validation.reason}。请缩小修改范围或重试。`,
    };
    yield* openOriginalAfterFailure();
    return;
  }

  // 【临时屏蔽】no-op 闸门（isTrivialNoOp + hasInteractionDelta）。
  // 原因：hasInteractionDelta 仅认 6 种事件模式，复用已有 handler / <details> / CSS / 非 listed 事件
  // 会被误判为"无交互改动"而丢弃模型已完成的整页修改。临时放开，待拓宽判定后再恢复。
  // if (isTrivialNoOp(originalPreview, html)) {
  //   yield { type: "step", stage: "edit", status: "done", detail: "未识别到明确改动，已保留原页面" };
  //   yield {
  //     type: "assistant",
  //     message: `未检测到明确改动，已保留原页面，没有生成新版本。请用点选修改选择要改的元素，或在对话框描述更具体的目标（如"把标题改成X"、"把左上角数字改成Y"）。`,
  //   };
  //   yield* openOriginalAfterFailure();
  //   return;
  // }
  //
  // if (interactiveEdit && !hasInteractionDelta(originalPreview, html)) {
  //   yield { type: "step", stage: "edit", status: "done", detail: "未检测到交互改动，已保留原页面" };
  //   yield {
  //     type: "assistant",
  //     message: `未检测到可用的点击/详情交互改动，已保留原页面，没有生成新版本。请说明点击后展示哪些详情，或用点选修改选择要增加交互的区域。`,
  //   };
  //   yield* openOriginalAfterFailure();
  //   return;
  // }

  // 删除被脚本按 id 引用的元素会让重渲染脚本崩(B-2):对结果补 null-safe 脚本守卫。
  html = guardDeletedIdScriptRefs(originalPreview, html);
  const rawHtmlState = createRawHtmlState(html);
  yield { type: "step", stage: "edit", status: "done", detail: `模型:${editModelKey}${editHasImages ? "(视觉)" : ""}` };
  yield { type: "code", code: html };
  const preview = { html, source: "raw" as const };
  yield { type: "preview", preview };
  yield {
    type: "done",
    result: {
      flow: previous.flow,
      components: [],
      code: html,
      preview,
      rawHtml: previous.rawHtml ?? false, // 上传原样打开的保留 rawHtml；原生生成的不是
      html: true,
      rawHtmlState,
      device: previous.device,
      styleProfileId: carriedStyleProfileId,
      modelPreference,
      captureMeta: previous.captureMeta,
    },
  };
  } catch (err) {
    // undici 在 body 流被对端中途掐断时抛 TypeError("terminated")，真正细节在 cause。
    const causeMsg = (err as { cause?: { message?: string } })?.cause?.message;
    const message = err instanceof Error ? err.message : String(err);
    const detail = causeMsg && causeMsg !== message ? `${message}（${causeMsg}）` : message;
    console.warn("[raw-html-edit] unhandled error:", detail, err);
    // terminated/aborted/reset/UND_ERR_* 均为网络层或上游提前断流，属可重试故障，而非"修改范围过大"。
    const isNetworkFailure = /fetch failed|other side closed|ECONN|timeout|socket|terminated|aborted|reset|UND_ERR/i.test(message);
    yield { type: "step", stage: "edit", status: "done", detail: "修改异常，已保留原页面" };
    yield {
      type: "assistant",
      message: isNetworkFailure
        ? `本次 HTML 修改连接模型服务失败（已自动重试仍未成功），已保留原页面。原因：${detail}。请直接重试；若持续出现，请检查模型服务或代理连接。`
        : `本次 HTML 修改过程中出现异常，已保留原页面。原因：${detail}。请缩小修改范围，或用点选修改选择要改的元素后重试。`,
    };
    yield* openOriginalAfterFailure();
    return;
  }
}

/** ③.5 语法校验 + 自修复阶段；返回最终代码 */
async function* validateStageDetailed(
  provider: Parameters<typeof repairIfNeeded>[0],
  components: RetrievedComponent[],
  code: string,
  useDpl: boolean,
  device: Device = "pc",
  timing?: { base: TimingBase; modelKey?: ModelKey }
): AsyncGenerator<PipelineEvent, { code: string; hadIssue: boolean; fixed: boolean; detail: string; blockedNavigation?: string[] }> {
  yield { type: "step", stage: "validate", status: "start", detail: "校验语法与组件合法性" };
  const startedAt = Date.now();
  const r = await repairIfNeeded(provider, components, code, useDpl, device);
  // 确定性兜底：保证有 React 默认导入（沙箱经典 JSX 转换需要）
  const finalCode = ensureReactImport(r.code);
  yield { type: "step", stage: "validate", status: "done", detail: r.detail };
  if (timing) {
    recordTiming(timing.base, "validate", startedAt, {
      ...modelTiming(timing.modelKey),
      outcome: r.hadIssue ? (r.fixed ? "fixed" : "fallback") : "clean",
    });
  }
  return { ...r, code: finalCode };
}

async function* validateStage(
  provider: Parameters<typeof repairIfNeeded>[0],
  components: RetrievedComponent[],
  code: string,
  useDpl: boolean,
  device: Device = "pc",
  timing?: { base: TimingBase; modelKey?: ModelKey }
): AsyncGenerator<PipelineEvent, string> {
  const r = yield* validateStageDetailed(provider, components, code, useDpl, device, timing);
  return r.code;
}

// ---------- 工具 ----------

/** 汇总所有页面的组件需求（retrieveComponents 内部再按组件名去重） */
function aggregateNeeds(flow: FlowSpec): ComponentNeed[] {
  return flow.pages.flatMap((p) => p.componentNeeds);
}

function compactComponents(
  components: RetrievedComponent[],
  limit: number,
  // 需容纳 LeftMenu(1325)/Menu(1308) 等长文档完整保留「官方示例」段--示例是 prop 用法的数据源
  // （data= 还是 items=、{key,name} 还是 {key,label}），截掉会让模型回退到 antd 通用 API 幻觉。
  // 旧值 700 把 LeftMenu 示例整段切掉，实测导致 LeftMenu 用 items 崩 props.data.map。
  docsLimit = 1500
): RetrievedComponent[] {
  return components.slice(0, limit).map((c) => ({
    ...c,
    docs: c.docs ? truncateText(c.docs, docsLimit) : undefined,
    demo: c.demo ? truncateText(c.demo, 900) : undefined,
  }));
}

function parseFlow(raw: string, opts: { requireVisualReference?: boolean } = {}): FlowSpec {
  try {
    const flow = FlowSpecSchema.parse(extractJson(raw));
    if (opts.requireVisualReference && !flow.prototypeContract.visualReference) {
      throw new Error("有截图时必须生成 Visual Reference Contract");
    }
    return { ...flow, pages: flow.pages.slice(0, MAX_PAGES) };
  } catch (err) {
    throw new Error(
      `结构化结果解析失败: ${err instanceof Error ? err.message : err}\n原始输出片段:\n${raw.slice(0, 600)}`
    );
  }
}
