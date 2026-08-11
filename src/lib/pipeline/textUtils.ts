/**
 * 纯文本处理工具：清洗/判断模型输出。无外部依赖，便于复用与单测。
 */
import { parse } from "@babel/parser";

/** 跳过非 JS 的 <script type>：text/template、application/json、text/plain、打包器模板等 */
const JS_SCRIPT_TYPES = new Set([
  "",
  "text/javascript",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript",
  "module",
]);

/**
 * 抽取 HTML 内所有内联 <script>（跳过外链 src= 与非 JS type），逐段做 JS 语法检查。
 * 返回语法错误摘要列表（每段取首行错误信息），空数组表示全部通过。
 *
 * 用于拦「整段 <script> 解析失败致页面交互全失效」这类静默坏输出——模型偶发吐错标点
 * （如三元表达式后多冒号 `)+:''`）会让浏览器拒绝执行整段脚本，列表/抽屉/页签空白，
 * 而结构校验只查 HTML 标签闭合、查不到 JS 语法。@babel/parser 用 sourceType:"unambiguous"
 * 自动判 classic/module，避免误判 import 与 top-level 语法。
 */
export function checkInlineScriptsSyntax(html: string): string[] {
  const errors: string[] = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html)) !== null) {
    const attrs = m[1] || "";
    const body = m[2] || "";
    if (!body.trim()) continue;
    if (/\bsrc\s*=/i.test(attrs)) continue; // 外链脚本，内容不在此校验
    const typeMatch = attrs.match(/\btype\s*=\s*['"]([^'"]+)['"]/i);
    if (typeMatch && !JS_SCRIPT_TYPES.has(typeMatch[1].trim().toLowerCase())) continue;
    try {
      parse(body, { sourceType: "unambiguous", errorRecovery: false });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(msg.split("\n")[0]);
    }
  }
  return errors;
}

/** 去代码围栏：容忍模型在 ``` 前后写说明文字，优先取首个围栏内内容 */
export function stripFences(text: string): string {
  const t = text.trim();
  const fenced = t.match(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return t
    .replace(/^\s*```[a-zA-Z]*\s*/, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

/** 从模型输出里提取干净的完整 HTML 文档：剥围栏 + 去掉 <!DOCTYPE/<html 之前的客套话、</html> 之后的尾巴 */
export function extractHtmlDoc(raw: string): string {
  let s = stripFences(raw);
  const lower = s.toLowerCase();
  const starts = ["<!doctype", "<html"].map((k) => lower.indexOf(k)).filter((i) => i >= 0);
  if (starts.length) s = s.slice(Math.min(...starts));
  const end = s.toLowerCase().lastIndexOf("</html>");
  if (end >= 0) s = s.slice(0, end + "</html>".length);
  return s.trim();
}

/** 粗判是否像 HTML（用于避免把模型的纯文字回复当成页面覆盖掉原稿） */
export function looksLikeHtml(s: string): boolean {
  return /<\s*(!doctype|html|head|body|div|section|main|span|p|h[1-6]|table|ul|img|button)\b/i.test(s);
}

function extractTitleText(html: string): string {
  return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
}

function hasId(html: string, id: string): boolean {
  return new RegExp(`\\bid=["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "i").test(html);
}

/** 原样 HTML 编辑结果的强校验：不完整/截断/丢关键锚点时禁止覆盖上一版 */
export function validateEditedHtmlDoc(
  original: string,
  edited: string,
  opts?: { deleteMode?: boolean }
): { ok: boolean; reason: string } {
  const out = edited.trim();
  if (!out) return { ok: false, reason: "模型未返回 HTML" };
  if (!/(<!doctype\b|<html\b)/i.test(out)) return { ok: false, reason: "缺少 <!doctype> 或 <html>" };
  if (!/<body\b/i.test(out)) return { ok: false, reason: "缺少 <body>" };
  if (!/<\/html>/i.test(out)) return { ok: false, reason: "缺少 </html>，疑似输出被截断" };

  // 标题"丢失"指 <title> 元素被整页重写时丢掉，而非用户明确要求改名。
  // 因此只要求输出里仍存在非空 <title>（允许文本被改成新标题），不再强求原标题字面仍在。
  const origTitle = extractTitleText(original);
  const outTitle = extractTitleText(out);
  if (origTitle.length >= 2 && outTitle.length < 2) return { ok: false, reason: "原页面标题丢失" };
  if (hasId(original, "root") && !hasId(out, "root")) return { ok: false, reason: "原页面根节点 id=\"root\" 丢失" };
  // 体量骤降启发式：非删除场景下，输出不到原文 80% 疑似截断/整页重写。
  // 删除指令豁免——合法大删除（如"删掉整个底部信息区"占 30%）会让体量明显变小，结构完整性已由上方
  // </html>/<body> 检查保证，0.8 长度比对删除是假阳性。与 validateScopeReplacement 的 deleteMode 同思路。
  if (!opts?.deleteMode && out.length < original.length * 0.8) {
    return { ok: false, reason: "修改结果体量明显小于原页面，疑似截断或整页被重写" };
  }

  return { ok: true, reason: "" };
}

/** 从模型输出里提取 JSON（剥围栏 + 截取首尾花括号） */
export function extractJson(text: string): unknown {
  const cleaned = stripFences(text);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const slice = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  return JSON.parse(slice);
}

/** 截断文本到 max 字符 */
export function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...`;
}

/** 是否网关超时类错误（用于压缩上下文重试） */
export function isGatewayTimeout(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /504|gateway time-out|gateway timeout|timeout/i.test(msg);
}

/**
 * 是否可重试的模型调用错误（过载/网关类）：429/502/503/504、ServerOverloaded、
 * TooManyRequests、service unavailable 等。这类错误退避后重试通常能恢复。
 * 用于 generate 阶段 in-stage 重试判定（httpFetch 层已先退避重试过一遍）。
 */
export function isRetryableModelError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b|\b50[234]\b|serveroverloaded|toomanyrequests|service unavailable|overload|gateway timeout|504|timeout/i.test(
    msg
  );
}

/**
 * 结构化复杂度判断（结构化之前、只看需求文本+附件）：复杂则升 pro，否则 flash。
 * 复杂信号：仅认「多页/流程」类确定信号（上传文档规格、出现多页/流程/跳转/列表→详情|新建|编辑|表单 等关键词）。
 * 「需求很长」「要点很多」只代表详细、不代表多页，已移除，避免长单页被误升 pro。
 */
export function isComplexStructure(requirement: string, hasDocs: boolean): boolean {
  const t = (requirement || "").trim();
  if (hasDocs) return true; // 带文档规格通常含多页流程
  if (/多页|多个页面|流程|步骤|审批|工作流|向导|wizard|跳转|端到端|列表页?.{0,8}(详情|新建|编辑|表单)/.test(t)) {
    return true;
  }
  return false;
}
