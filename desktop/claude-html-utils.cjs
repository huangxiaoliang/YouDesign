const crypto = require("node:crypto");
const { byteLength } = require("./desktop-utils.cjs");
const { definitionNames, scanCssRules, scanHtmlElements, scanJsTopLevelStatements } = require("./claude-fragment-utils.cjs");
const { introducedPrototypeNavigation } = require("./prototype-navigation-core.cjs");

const FULLPAGE_EDIT_THRESHOLD_BYTES = 160_000;
const DATA_URI_RE = /data:[^"'\s)]*/g;
const PLACEHOLDER_RE = /__(?:YD_)?ASSET_([a-f0-9]{12,64}|\d+)__/gi;
const STYLE_PLACEHOLDER_RE = /__YD_STYLE_([a-f0-9]{12,64})__/gi;
const IMMUTABLE_PLACEHOLDER_RE =
  /<!--__YD_IMMUTABLE_([a-f0-9]{12,64})__-->|\/\*__YD_IMMUTABLE_([a-f0-9]{12,64})__\*\/|"__YD_IMMUTABLE_([a-f0-9]{12,64})__"\s*:\s*null/gi;
const MIN_ASSET_SAVING_BYTES = 2048;
const LARGE_STYLE_BLOCK_MIN_BYTES = 80_000;
const MIN_IMMUTABLE_REGION_BYTES = 512;
const MIN_IMMUTABLE_DOM_SUBTREE_BYTES = 2_048;
const MIN_IMMUTABLE_OBJECT_BYTES = 4_096;
const MAX_IMMUTABLE_REGIONS = 128;
const MIN_IMMUTABLE_SAVING_RATIO = 0.1;
const SCOPED_JOB_START = "<!--YD_SCOPE_START-->";
const SCOPED_JOB_END = "<!--YD_SCOPE_END-->";
const MAX_SCOPED_JOB_SCOPE_BYTES = 500_000;

function buildRelevantHtmlSnippets(html, instruction, interactiveEdit, focus) {
  const source = String(html || "");
  const baseTerms = extractSnippetTerms(source, instruction);
  const hintTerms = extractInteractionSnippetTerms(source, instruction, interactiveEdit);
  const focusTerms = extractFocusSnippetTerms(source, focus);
  const terms = uniqueTerms([...baseTerms.slice(0, 5), ...focusTerms, ...hintTerms, ...baseTerms.slice(5)]);
  if (!source || terms.length === 0) return "";
  const snippets = [];
  const windows = [];
  let total = 0;
  for (const term of terms) {
    const radius = /^function |^const |^let |^var |^id=|^class=|\./.test(term) ? 1400 : 900;
    let from = 0;
    let count = 0;
    while (count < 2) {
      const idx = source.indexOf(term, from);
      if (idx < 0) break;
      const start = Math.max(0, idx - radius);
      const end = Math.min(source.length, idx + term.length + radius);
      const overlaps = windows.some(([s, e]) => {
        const overlap = Math.max(0, Math.min(e, end) - Math.max(s, start));
        return overlap > Math.min(e - s, end - start) * 0.55;
      });
      from = idx + term.length;
      if (overlaps) continue;
      const body = source.slice(start, end).replace(/```/g, "'''");
      const block = `### Term: ${term} (offset ${idx})\n\n\`\`\`html\n${body}\n\`\`\``;
      if (total + block.length > 24000) return snippets.join("\n\n");
      snippets.push(block);
      windows.push([start, end]);
      total += block.length;
      count += 1;
    }
    if (snippets.length >= 12) break;
  }
  return snippets.join("\n\n");
}

function extractFocusSnippetTerms(html, focus) {
  const source = String(html || "");
  const fragment = String(focus?.targetHtml || focus?.scopeHtml || "");
  if (!source || !fragment) return [];
  const candidates = [];
  const add = (term) => {
    if (term && source.includes(term)) candidates.push(term);
  };
  for (const match of fragment.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)) {
    add(`id="${match[1]}"`);
    add(`id='${match[1]}'`);
    add(`#${match[1]}`);
  }
  for (const match of fragment.matchAll(/\bclass\s*=\s*["']([^"']+)["']/gi)) {
    for (const className of match[1].split(/\s+/).filter(Boolean).slice(0, 5)) add(`.${className}`);
  }
  for (const match of fragment.matchAll(/\b(?:aria-controls|data-(?:bs-)?target|href)\s*=\s*["']\s*#?([^"'\s>]+)["']/gi)) {
    add(`id="${match[1]}"`);
    add(`id='${match[1]}'`);
    add(`#${match[1]}`);
  }
  for (const match of fragment.matchAll(/\bon[a-z]+\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    for (const call of extractCalledFunctionNames(match[2])) {
      add(`function ${call}`);
      add(`const ${call}`);
      add(`let ${call}`);
      add(`var ${call}`);
    }
  }
  return uniqueTerms(candidates).slice(0, 12);
}

function uniqueTerms(terms) {
  const selected = [];
  for (const term of terms) {
    if (!term || selected.includes(term)) continue;
    if (selected.some((existing) => existing.includes(term))) continue;
    selected.push(term);
  }
  return selected;
}

function extractInteractionSnippetTerms(html, instruction, interactiveEdit) {
  const source = String(html || "");
  const text = String(instruction || "");
  if (!interactiveEdit && !/点击|打开|查看|详情|明细|下钻|抽屉|弹窗|弹层|modal|drawer|dialog|popup/i.test(text)) {
    return [];
  }
  const terms = [];
  const add = (term) => {
    if (source.includes(term)) terms.push(term);
  };
  if (/抽屉|drawer|下钻|详情|明细|点击|打开|查看/i.test(text)) {
    [
      "function openDrawer",
      "function closeDrawer",
      "function openDetailDrawer",
      "function closeDetailDrawer",
      "const deptData",
      "let deptData",
      "var deptData",
      "id=\"drawer\"",
      "id=\"drawer2\"",
      "id=\"drawerBody2\"",
      "id=\"drawerFooter2\"",
      "id=\"tableBody\"",
      "id=\"summaryBar\"",
      ".drawer2",
      ".detail-table",
      ".drawer-overlay",
    ].forEach(add);
  }
  if (/弹窗|弹层|modal|dialog|popup/i.test(text)) {
    [
      "function openModal",
      "function closeModal",
      "function openDialog",
      "function closeDialog",
      "id=\"modal\"",
      "id=\"dialog\"",
      ".modal",
      ".dialog",
      ".popup",
    ].forEach(add);
  }
  return terms;
}

function extractSnippetTerms(html, instruction) {
  const source = String(html || "");
  const text = String(instruction || "");
  const terms = new Set();
  const normalized = text.replace(
    /右边|左边|上方|下方|上面|下面|旁边|附近|删除|删掉|删去|移除|去掉|清除|清空|修改|改成|调整|新增|添加|插入|替换|这个|那个|一下|请|把|将|的/g,
    " "
  );
  for (const part of normalized.split(/[^\p{Script=Han}A-Za-z0-9_-]+/gu)) {
    if (part.length >= 2 && part.length <= 24) terms.add(part);
  }
  for (const chunk of text.match(/[\p{Script=Han}A-Za-z0-9_-]{2,}/gu) || []) {
    if (chunk.length <= 12) terms.add(chunk);
    const maxLen = Math.min(6, chunk.length);
    for (let len = maxLen; len >= 2; len--) {
      for (let i = 0; i + len <= chunk.length; i++) {
        terms.add(chunk.slice(i, i + len));
      }
    }
  }
  const sorted = Array.from(terms)
    .filter((term) => source.includes(term))
    .sort((a, b) => b.length - a.length || a.localeCompare(b, "zh-Hans-CN"));
  return uniqueTerms(sorted).slice(0, 10);
}

function isTrivialNoOp(original, edited) {
  if (!edited || edited === original) return true;
  return String(original || "").replace(/\s+/g, "") === String(edited || "").replace(/\s+/g, "");
}

function looksRewritten(original, edited, opts = {}) {
  if (!edited) return false;
  const origTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(original)?.[1]?.trim();
  const outTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(edited)?.[1]?.trim();
  if (origTitle && origTitle.length >= 2 && !(outTitle && outTitle.length >= 2)) return true;
  if (!opts.deleteMode && edited.length < original.length * 0.55) return true;
  return false;
}

const INTERACTION_HANDLER_PATTERNS = [
  /addEventListener\s*\(\s*["'`](?:click|change|input|submit|mouseenter|mouseover)["'`]/gi,
  /\.(?:onclick|onchange|oninput|onsubmit)\s*=/gi,
  /\bon(?:click|change|input|submit|mouseenter|mouseover)\s*=\s*["']/gi,
];

function countInteractionHandlers(html) {
  return INTERACTION_HANDLER_PATTERNS.reduce((sum, pattern) => {
    pattern.lastIndex = 0;
    return sum + (String(html || "").match(pattern) || []).length;
  }, 0);
}

function interactionHandlerBlocks(html) {
  const source = String(html || "");
  const blocks = [];
  for (const match of source.matchAll(/\bon(?:click|change|input|submit|mouseenter|mouseover)\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    blocks.push(match[0].replace(/\s+/g, ""));
  }
  for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const script = match[1] || "";
    if (countInteractionHandlers(script)) blocks.push(script.replace(/\s+/g, ""));
  }
  return blocks;
}

function hasInteractionDelta(original, edited) {
  if (!edited || edited === original || isTrivialNoOp(original, edited)) return false;
  if (countInteractionHandlers(edited) > countInteractionHandlers(original)) return true;
  const originalBlocks = new Set(interactionHandlerBlocks(original));
  return interactionHandlerBlocks(edited).some((block) => !originalBlocks.has(block));
}

function isTabSwitchInstruction(instruction) {
  const text = String(instruction || "");
  return /页签|标签页|tab/i.test(text) && /点击|打开后|切换|选中|展示|显示|新增|添加|增加|插入/.test(text);
}

function hasTabSwitchImplementation(html) {
  const source = String(html || "");
  const hasClickHandler = /addEventListener\s*\(\s*["'`]click["'`]|\bonclick\s*=|\.onclick\s*=/i.test(source);
  const targetsTabs = /dpl-tabs-tab|\[role\s*=\s*["']?tab|role\s*=\s*["']tab["']/i.test(source);
  const targetsPanels = /dpl-tabs-tabpane|\[role\s*=\s*["']?tabpanel|role\s*=\s*["']tabpanel["']/i.test(source);
  const changesVisibleState =
    /classList\.(?:add|remove|toggle)|setAttribute\s*\(\s*["']aria-(?:selected|hidden)["']|\.hidden\s*=|\.style\.(?:display|visibility)\s*=|\.className\s*=/i.test(
      source
    );
  return hasClickHandler && targetsTabs && targetsPanels && changesVisibleState;
}

function guardDeletedIdScriptRefs(original, result) {
  if (result === original) return result;
  const stripScripts = (source) => String(source || "").replace(/<script[\s\S]*?<\/script>/gi, " ");
  const idsOf = (source) =>
    new Set((stripScripts(source).match(/\sid=["']([^"']+)["']/g) || []).map((match) => match.replace(/\sid=["']([^"']+)["']/, "$1")));
  const originalIds = idsOf(original);
  const resultIds = idsOf(result);
  const deletedIds = Array.from(originalIds).filter((id) => !resultIds.has(id));
  if (!deletedIds.length) return result;

  const scriptBlob = (String(result || "").match(/<script[\s\S]*?<\/script>/gi) || []).join("\n");
  const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const referenced = deletedIds.filter((id) => {
    const escaped = escapeRegex(id);
    return new RegExp(
      `getElementById\\s*\\(\\s*["']${escaped}["']|querySelector(?:All)?\\s*\\(\\s*["']#${escaped}["']`
    ).test(scriptBlob);
  });
  if (!referenced.length) return result;

  const shim = "var __ydGuard=new Proxy(function(){},{get:function(){return __ydGuard;}});";
  let output = String(result).replace(/<script\b/i, (match) => `<script>${shim}</script>\n${match}`);
  for (const id of referenced) {
    const escaped = escapeRegex(id);
    output = output.replace(
      new RegExp(`((?:[\\w$]+\\.)*)querySelectorAll\\s*\\(\\s*["']#${escaped}["']\\s*\\)`, "g"),
      `($1querySelectorAll('#${id}')||[])`
    );
    output = output.replace(
      new RegExp(`((?:[\\w$]+\\.)*)querySelector\\s*\\(\\s*["']#${escaped}["']\\s*\\)`, "g"),
      `($1querySelector('#${id}')||__ydGuard)`
    );
    output = output.replace(
      new RegExp(`((?:[\\w$]+\\.)*)getElementById\\s*\\(\\s*["']${escaped}["']\\s*\\)`, "g"),
      `($1getElementById('${id}')||__ydGuard)`
    );
  }
  return output;
}

function diffStats(before, after) {
  const originalLines = String(before || "").split(/\r?\n/);
  const editedLines = String(after || "").split(/\r?\n/);
  const max = Math.max(originalLines.length, editedLines.length);
  let changedLines = 0;
  for (let index = 0; index < max; index += 1) {
    if ((originalLines[index] || "") !== (editedLines[index] || "")) changedLines += 1;
  }
  return {
    changedLines,
    added: Math.max(0, editedLines.length - originalLines.length),
    removed: Math.max(0, originalLines.length - editedLines.length),
  };
}

function validateClaudeHtml(original, html, opts = {}) {
  if (typeof html !== "string" || !html.trim()) return { ok: false, reason: "Claude 未返回 HTML" };
  if (isTrivialNoOp(original, html)) return { ok: false, reason: "Claude Code 未修改 HTML" };
  const output = html.trim();
  if (!/(<!doctype\b|<html\b)/i.test(output) || !/<body\b/i.test(output) || !/<\/html>/i.test(output)) {
    return { ok: false, reason: "Claude 返回的 HTML 不完整" };
  }
  const originalTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(original)?.[1]?.trim() || "";
  const outputTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(output)?.[1]?.trim() || "";
  if (originalTitle.length >= 2 && outputTitle.length < 2) return { ok: false, reason: "原页面标题丢失" };
  if (/\bid=["']root["']/i.test(original) && !/\bid=["']root["']/i.test(output)) {
    return { ok: false, reason: '原页面根节点 id="root" 丢失' };
  }
  if (!opts.deleteMode && output.length < original.length * 0.8) {
    return { ok: false, reason: "修改结果体量明显小于原页面，疑似截断或整页被重写" };
  }
  if (looksRewritten(original, output, opts)) return { ok: false, reason: "修改结果疑似整页被重写" };
  const introducedNavigation = introducedPrototypeNavigation(original, output);
  if (introducedNavigation.length) {
    return { ok: false, reason: `修改引入了不允许的真实页面导航：${[...new Set(introducedNavigation)].join("、")}` };
  }
  if (opts.interactiveEdit && !hasInteractionDelta(original, output)) return { ok: false, reason: "未检测到交互改动" };
  if (opts.interactiveEdit && isTabSwitchInstruction(opts.instruction) && !hasTabSwitchImplementation(output)) {
    return { ok: false, reason: "页签修改缺少可执行的点击切换逻辑" };
  }
  return { ok: true };
}

function extractClaudeClarification(summary, instruction = "") {
  const text = String(summary || "").trim();
  if (!text) return "";
  const marker = "YD_NEEDS_CLARIFICATION:";
  const markerIndex = text.indexOf(marker);
  if (markerIndex >= 0) return text.slice(markerIndex + marker.length).trim().slice(0, 1600);
  const userInvitedQuestions = /有疑问.{0,8}(?:先)?问|不确定.{0,8}(?:先)?问|先(?:向我)?确认/.test(String(instruction || ""));
  const clarificationSignal =
    /需要(?:你|您)?确认|请(?:你|您)?确认|需要补充|请补充|请重新圈定|无法(?:安全|准确)?(?:定位|确定)|定位.{0,20}(?:不匹配|对不上)|scope.{0,20}(?:不匹配|不包含)/i.test(text);
  const questionSignal = /[?？]/.test(text) || /(?:二选一|请选择|你希望|您希望)/.test(text);
  if (!clarificationSignal || (!questionSignal && !userInvitedQuestions)) return "";
  return text.slice(0, 1600);
}

function extractClaudeAlreadySatisfied(summary, instruction = "") {
  const text = String(summary || "").trim();
  if (!text) return "";
  const marker = "YD_ALREADY_SATISFIED:";
  const markerIndex = text.indexOf(marker);
  if (markerIndex >= 0) return text.slice(markerIndex + marker.length).trim().slice(0, 1600);
  // 用户明确否定当前效果时，不能仅凭 Claude 的自述把任务判成“已满足”。
  if (/没(?:有)?改好|未生效|没有生效|不对|有问题|重修|重新修改|重新改/.test(String(instruction || ""))) return "";
  const satisfiedSignal =
    /already (?:fully )?(?:satisf(?:y|ies|ied)|implemented|present|exists)|(?:当前|现有|页面|文件).{0,24}已经.{0,20}(?:满足|实现|存在|包含|完成)|已经(?:完整|完全)?(?:满足|实现)|无需(?:再次|重复)?修改|不需要(?:再次)?修改/i.test(text);
  const unchangedSignal = /left `?index\.html`? unchanged|未修改|保持不变|避免.{0,12}重复|无需.{0,12}插入/i.test(text);
  if (!satisfiedSignal || !unchangedSignal) return "";
  return text.slice(0, 1600);
}

function normalizeClaudeEditFocus(focus, baseHtml) {
  if (!focus || typeof focus !== "object") return null;
  const scopeHtml = typeof focus.scopeHtml === "string" ? focus.scopeHtml : "";
  const source = String(baseHtml || "");
  let scopeStart = Number(focus.scopeStart);
  let scopeEnd = Number(focus.scopeEnd);
  if (!scopeHtml || !Number.isFinite(scopeStart) || !Number.isFinite(scopeEnd)) return null;
  scopeStart = Math.trunc(scopeStart);
  scopeEnd = Math.trunc(scopeEnd);
  if (scopeStart < 0 || scopeEnd <= scopeStart || scopeEnd > source.length) return null;
  if (source.slice(scopeStart, scopeEnd) !== scopeHtml) {
    const first = source.indexOf(scopeHtml);
    if (first < 0 || source.indexOf(scopeHtml, first + scopeHtml.length) >= 0) return null;
    scopeStart = first;
    scopeEnd = first + scopeHtml.length;
  }
  if (byteLength(scopeHtml) > MAX_SCOPED_JOB_SCOPE_BYTES) return null;
  return {
    source: focus.source === "annotation" ? "annotation" : "auto-locate",
    plan: typeof focus.plan === "string" ? focus.plan : "",
    targetOffset: Number.isFinite(Number(focus.targetOffset)) ? Math.trunc(Number(focus.targetOffset)) : undefined,
    targetHtml: typeof focus.targetHtml === "string" ? focus.targetHtml : "",
    scopeStart,
    scopeEnd,
    scopeTag: typeof focus.scopeTag === "string" ? focus.scopeTag.toLowerCase() : "",
    scopeReason: typeof focus.scopeReason === "string" ? focus.scopeReason : "",
    scopeHtml,
  };
}

const INLINE_CALL_IGNORES = new Set([
  "alert",
  "add",
  "blur",
  "back",
  "catch",
  "click",
  "close",
  "closest",
  "confirm",
  "contains",
  "focus",
  "for",
  "function",
  "getAttribute",
  "getElementById",
  "if",
  "log",
  "matches",
  "open",
  "parseFloat",
  "parseInt",
  "preventDefault",
  "querySelector",
  "querySelectorAll",
  "remove",
  "removeAttribute",
  "replace",
  "setAttribute",
  "setInterval",
  "setTimeout",
  "showModal",
  "scrollIntoView",
  "stopImmediatePropagation",
  "stopPropagation",
  "switch",
  "toggle",
  "while",
]);

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractCalledFunctionNames(script) {
  const names = [];
  for (const match of String(script || "").matchAll(/\b(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (!INLINE_CALL_IGNORES.has(name)) names.push(name);
  }
  return [...new Set(names)];
}

function hasLocalFunctionDefinition(scopeHtml, name) {
  const escaped = escapeRegex(name);
  return new RegExp(
    `(?:function\\s+${escaped}\\s*\\(|(?:const|let|var)\\s+${escaped}\\s*=|(?:^|[;{}])\\s*${escaped}\\s*=\\s*(?:async\\s*)?function\\b)`,
    "m"
  ).test(scopeHtml);
}

function extractHtmlAttributeValues(html, attributePattern) {
  const values = [];
  const re = new RegExp(`\\b(${attributePattern})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "gi");
  for (const match of String(html || "").matchAll(re)) {
    values.push({ name: match[1].toLowerCase(), value: String(match[2] ?? match[3] ?? match[4] ?? "").trim() });
  }
  return values;
}

function extractReferencedFragmentSelectors(scopeHtml) {
  const ids = [];
  const classes = [];
  const selectors = [];
  for (const { name, value } of extractHtmlAttributeValues(scopeHtml, "aria-controls|data-(?:bs-)?target|href")) {
    if (!value) continue;
    if (name === "aria-controls") {
      ids.push(...value.split(/\s+/).map((item) => item.replace(/^#/, "")).filter(Boolean));
    } else if (value.startsWith("#")) {
      ids.push(value.slice(1));
    } else if (name.includes("target") && value.startsWith(".")) {
      classes.push(value.slice(1));
    } else if (name.includes("target") && /^[A-Za-z][\w:.-]*$/.test(value)) {
      ids.push(value);
    } else if (name.includes("target")) {
      selectors.push(value);
    }
  }
  for (const match of String(scopeHtml || "").matchAll(/(?:getElementById\s*\(\s*["'`]([^"'`]+)["'`]|querySelector(?:All)?\s*\(\s*["'`]#([^"'`]+)["'`])/gi)) {
    const id = match[1] || match[2];
    if (id) ids.push(id);
  }
  return {
    ids: [...new Set(ids)],
    classes: [...new Set(classes)],
    selectors: [...new Set(selectors)],
  };
}

function htmlContainsClass(html, className) {
  return extractHtmlAttributeValues(html, "class").some(({ value }) => value.split(/\s+/).includes(className));
}

function htmlContainsAttributeSelector(html, selector) {
  const match = /^\[([\w:-]+)(?:\s*=\s*["']?([^"'\]]+)["']?)?\]$/.exec(String(selector || "").trim());
  if (!match) return false;
  return extractHtmlAttributeValues(html, escapeRegex(match[1])).some(
    ({ value }) => match[2] === undefined || value === match[2]
  );
}

function extractTargetSelectors(focus, scopeHtml) {
  const fragment = `${String(focus?.targetHtml || "")}\n${String(scopeHtml || "")}`;
  const primaryTarget = String(focus?.targetHtml || scopeHtml || "");
  const ids = [];
  const classes = [];
  const dataValues = [];
  const dataAttrs = [];
  const tags = [];
  for (const match of fragment.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)) ids.push(match[1]);
  for (const match of fragment.matchAll(/\bclass\s*=\s*["']([^"']+)["']/gi)) {
    classes.push(...match[1].split(/\s+/).filter((value) => value.length >= 3));
  }
  for (const match of fragment.matchAll(/\bdata-[\w-]+\s*=\s*["']([^"']+)["']/gi)) {
    if (match[1].length >= 3) dataValues.push(match[1]);
  }
  for (const match of fragment.matchAll(/\b(data-[\w-]+)(?:\s*=|\s|>)/gi)) dataAttrs.push(match[1].toLowerCase());
  const targetTag = /^\s*<([a-z][\w:-]*)\b/i.exec(primaryTarget)?.[1]?.toLowerCase();
  if (targetTag && !["html", "head", "body", "main"].includes(targetTag)) tags.push(targetTag);
  return {
    ids: [...new Set(ids)],
    classes: [...new Set(classes)].slice(0, 8),
    dataValues: [...new Set(dataValues)].slice(0, 8),
    dataAttrs: [...new Set(dataAttrs)].slice(0, 8),
    tags: [...new Set(tags)],
  };
}

function scriptReferencesTarget(script, selectors, focus, interactiveEdit) {
  const source = String(script || "");
  for (const id of selectors.ids) {
    const escaped = escapeRegex(id);
    if (
      new RegExp(
        `getElementById\\s*\\(\\s*["'\`]${escaped}["'\`]|(?:querySelector(?:All)?|closest|matches|\\$)\\s*\\(\\s*["'\`][^"'\`]*#${escaped}(?![\\w-])[^"'\`]*["'\`]`
      ).test(source)
    ) {
      return `#${id}`;
    }
  }
  for (const className of selectors.classes) {
    const escaped = escapeRegex(className);
    if (
      new RegExp(
        `(?:querySelector(?:All)?|closest|matches|\\$)\\s*\\(\\s*["'\`][^"'\`]*\\.${escaped}(?![\\w-])[^"'\`]*["'\`]|getElementsByClassName\\s*\\(\\s*["'\`]${escaped}["'\`]`
      ).test(source)
    ) {
      return `.${className}`;
    }
  }
  if (/addEventListener\s*\(/.test(source)) {
    for (const value of selectors.dataValues) {
      if (source.includes(value)) return `data-*=${value}`;
    }
  }
  for (const attrName of selectors.dataAttrs) {
    const camel = attrName
      .slice(5)
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const escaped = escapeRegex(attrName);
    if (
      new RegExp(
        `\\[${escaped}(?:[\\s=\\]])|dataset\\.${escapeRegex(camel)}\\b|getAttribute\\s*\\(\\s*["'\`]${escaped}["'\`]`,
        "i"
      ).test(source)
    ) {
      return attrName;
    }
  }
  if (interactiveEdit && /(?:document|window)\s*\.\s*addEventListener\s*\(/.test(source)) {
    const visibleText = String(focus?.targetHtml || "")
      .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&amp;|&lt;|&gt;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (visibleText.length >= 2 && visibleText.length <= 40 && source.includes(visibleText)) return `文本「${visibleText}」`;
  }
  return "";
}

function externalCssReferencesTarget(outsideHtml, selectors, scopeHtml) {
  const css = Array.from(String(outsideHtml || "").matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi), (match) => match[1]).join("\n");
  if (!css) return "";
  for (const id of selectors.ids) {
    const escaped = escapeRegex(id);
    if (new RegExp(`(?:^|[{}])[^{}]*#${escaped}(?![\\w-])[^{}]*\\{`, "m").test(css)) return `#${id}`;
  }
  for (const className of selectors.classes) {
    const escaped = escapeRegex(className);
    if (new RegExp(`(?:^|[{}])[^{}]*\\.${escaped}(?![\\w-])[^{}]*\\{`, "m").test(css)) return `.${className}`;
  }
  for (const attrName of selectors.dataAttrs) {
    const escaped = escapeRegex(attrName);
    if (new RegExp(`(?:^|[{}])[^{}]*\\[${escaped}(?:[\\s=\\]])[^{}]*\\{`, "im").test(css)) return `[${attrName}]`;
  }
  for (const tag of selectors.tags) {
    const escaped = escapeRegex(tag);
    if (new RegExp(`(?:^|[{},])\\s*${escaped}(?=[\\s.#[:>,+~{])[^{}]*\\{`, "im").test(css)) return tag;
  }
  for (const match of String(scopeHtml || "").matchAll(/var\(\s*(--[\w-]+)/g)) {
    if (new RegExp(`${escapeRegex(match[1])}\\s*:`).test(css)) return match[1];
  }
  return "";
}

function analyzeScopedClaudeSafety(baseHtml, focus, instruction, opts = {}) {
  const normalized = normalizeClaudeEditFocus(focus, baseHtml);
  if (!normalized) return { safe: false, reasons: ["目标 scope 无效"] };
  const source = String(baseHtml || "");
  const scopeHtml = normalized.scopeHtml;
  const outsideHtml = source.slice(0, normalized.scopeStart) + source.slice(normalized.scopeEnd);
  const reasons = [];
  const addReason = (reason) => {
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  };
  const instructionText = String(instruction || "").replace(/\s+/g, "");
  const planText = String(normalized.plan || "");
  const planFlagIsYes = (name) =>
    new RegExp(`(?:^|[；;\\s])${escapeRegex(name)}\\s*=\\s*yes(?=$|[；;\\s])`, "i").test(planText);

  if (planFlagIsYes("batch")) addReason("编辑计划要求批量处理");
  if (planFlagIsYes("needsFullPage")) addReason("编辑计划要求整页处理");

  if (
    /布局|响应式|自适应|媒体查询|断点|主题|换肤|主色|配色|色调|暗色|深色模式|浅色模式|整体样式|全局样式|整体视觉|整体宽度|侧边栏.{0,6}(?:移|左|右)/i.test(
      instructionText
    )
  ) {
    addReason("指令涉及布局、主题或响应式");
  }

  const referencedFragments = extractReferencedFragmentSelectors(scopeHtml);
  const localIds = new Set(extractHtmlAttributeValues(scopeHtml, "id").map(({ value }) => value));
  for (const id of referencedFragments.ids) {
    if (!localIds.has(id)) addReason(`目标引用 scope 外元素 #${id}`);
  }
  for (const className of referencedFragments.classes) {
    if (!htmlContainsClass(scopeHtml, className)) addReason(`目标引用 scope 外元素 .${className}`);
  }
  for (const selector of referencedFragments.selectors) {
    if (!htmlContainsAttributeSelector(scopeHtml, selector)) addReason(`目标引用 scope 外元素 ${selector}`);
  }

  for (const handler of extractHtmlAttributeValues(scopeHtml, "on[a-z]+")) {
    for (const name of extractCalledFunctionNames(handler.value)) {
      if (!hasLocalFunctionDefinition(scopeHtml, name)) addReason(`onclick 依赖 scope 外函数 ${name}`);
    }
  }

  const overlayWords = /抽屉|弹窗|弹层|modal|drawer|dialog|popup/i;
  const overlayMarkup = /(?:id|class|role)\s*=\s*["'][^"']*(?:drawer|modal|dialog|popup|抽屉|弹窗|弹层)[^"']*["']/i;
  if (overlayWords.test(instructionText) && !overlayMarkup.test(scopeHtml) && overlayMarkup.test(outsideHtml)) {
    addReason("交互目标 drawer/modal 位于 scope 外");
  }

  const outsideScripts = Array.from(outsideHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi), (match) => match[1]).join("\n");
  const targetSelectors = extractTargetSelectors(normalized, scopeHtml);
  const targetRef = scriptReferencesTarget(outsideScripts, targetSelectors, normalized, Boolean(opts.interactiveEdit));
  if (targetRef) addReason(`scope 外脚本引用目标 ${targetRef}`);
  if (/持久修改要求|脚本数据源|数据源\/模板|渲染逻辑|渲染函数/.test(instructionText) && outsideScripts.trim()) {
    addReason("修改依赖 scope 外脚本数据源或渲染函数");
  }

  if (
    /颜色|色值|背景|字体|字号|字重|间距|边距|内边距|外边距|圆角|边框|阴影|透明度|宽度|高度|对齐|悬停|样式|视觉|hover|padding|margin|color|background|font|border|shadow|radius|opacity|width|height|gap/i.test(
      instructionText
    )
  ) {
    const cssRef = externalCssReferencesTarget(outsideHtml, targetSelectors, scopeHtml);
    if (cssRef) addReason(`目标样式依赖 scope 外 CSS ${cssRef}`);
  }

  return { safe: reasons.length === 0, reasons, focus: normalized };
}

function prepareScopedClaudeJob(baseHtml, focus, opts = {}) {
  const normalized = normalizeClaudeEditFocus(focus, baseHtml);
  if (!normalized) return { scoped: false, html: String(baseHtml || ""), focus: null, scopeSafety: null };
  const scopeSafety = analyzeScopedClaudeSafety(baseHtml, normalized, opts.instruction, opts);
  if (!scopeSafety.safe) {
    return { scoped: false, html: String(baseHtml || ""), focus: null, scopeSafety };
  }
  const title = "YouDesign scoped edit";
  const html = [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<title>${title}</title>`,
    "</head><body>",
    SCOPED_JOB_START,
    normalized.scopeHtml,
    SCOPED_JOB_END,
    "</body></html>",
  ].join("\n");
  return { scoped: true, html, focus: normalized, scopeSafety };
}

function extractScopedReplacement(editedJobHtml) {
  const source = String(editedJobHtml || "");
  const start = source.indexOf(SCOPED_JOB_START);
  const end = source.indexOf(SCOPED_JOB_END);
  if (start >= 0 && end > start) return source.slice(start + SCOPED_JOB_START.length, end).trim();
  const body = source.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (body) return body[1].replace(SCOPED_JOB_START, "").replace(SCOPED_JOB_END, "").trim();
  return source.trim();
}

function ensureTableWidthCoversColgroup(tableHtml) {
  const source = String(tableHtml || "");
  const colgroup = /<colgroup\b[^>]*>([\s\S]*?)<\/colgroup>/i.exec(source)?.[1] || "";
  const colWidthSum = Array.from(colgroup.matchAll(/<col\b([^>]*)>/gi)).reduce((sum, match) => {
    const width = Number(/\bwidth\s*:\s*(\d+(?:\.\d+)?)px/i.exec(match[1] || "")?.[1] || 0);
    return sum + (Number.isFinite(width) ? width : 0);
  }, 0);
  if (colWidthSum <= 0) return source;
  return source.replace(/^\s*<table\b[^>]*>/i, (openingTag) => {
    const styleMatch = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/i.exec(openingTag);
    if (!styleMatch) return openingTag.replace(/>$/, ` style="width:${colWidthSum}px;min-width:${colWidthSum}px;">`);
    let style = styleMatch[2];
    const widthRe = /(^|;)\s*width\s*:\s*(\d+(?:\.\d+)?)px\s*;?/i;
    const minWidthRe = /(^|;)\s*min-width\s*:\s*(\d+(?:\.\d+)?)px\s*;?/i;
    const width = Number(widthRe.exec(style)?.[2] || 0);
    const minWidth = Number(minWidthRe.exec(style)?.[2] || 0);
    if (width >= colWidthSum || minWidth >= colWidthSum) return openingTag;
    style = widthRe.test(style)
      ? style.replace(widthRe, `$1width:${colWidthSum}px;`)
      : `${style.trim()}${style.trim() && !style.trim().endsWith(";") ? ";" : ""}width:${colWidthSum}px;`;
    style = minWidthRe.test(style)
      ? style.replace(minWidthRe, `$1min-width:${colWidthSum}px;`)
      : `${style}min-width:${colWidthSum}px;`;
    return openingTag.replace(styleMatch[0], `style=${styleMatch[1]}${style}${styleMatch[1]}`);
  });
}

function normalizeScrollableTableReplacement(replacement) {
  const outer = /^\s*<div\b([^>]*)>([\s\S]*)<\/div>\s*$/i.exec(String(replacement || ""));
  if (!outer) return "";
  const attrs = outer[1] || "";
  if (/\bon[a-z]+\s*=|\b(?:href|src|action|formaction)\s*=|\b(?:url|expression)\s*\(/i.test(attrs)) return "";
  const style = /\bstyle\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] || "";
  if (!/\boverflow-x\s*:\s*(?:auto|scroll)\b/i.test(style)) return "";
  const table = String(outer[2] || "").trim();
  if (!/^<table\b[\s\S]*<\/table>$/i.test(table)) return "";
  if ((table.match(/<table\b/gi) || []).length !== 1 || (table.match(/<\/table>/gi) || []).length !== 1) return "";
  return `<div${attrs}>${ensureTableWidthCoversColgroup(table)}</div>`;
}

function applyScopedClaudeResult(baseHtml, editedJobHtml, focus, opts = {}) {
  const normalized = normalizeClaudeEditFocus(focus, baseHtml);
  if (!normalized) return { ok: false, reason: "目标容器锚点失效" };
  let replacement = extractScopedReplacement(editedJobHtml);
  if (!replacement) return { ok: false, reason: "Claude 未返回目标容器内容" };
  if (normalized.scopeTag) {
    const tagRe = new RegExp(`^\\s*<${normalized.scopeTag}(?:\\s|>)`, "i");
    if (!tagRe.test(replacement)) {
      const scrollableTable = normalized.scopeTag === "table" ? normalizeScrollableTableReplacement(replacement) : "";
      if (!scrollableTable) return { ok: false, reason: `Claude 返回内容不是原目标容器 <${normalized.scopeTag}>` };
      replacement = scrollableTable;
    }
  }
  if (!opts.deleteMode && replacement.length < normalized.scopeHtml.length * 0.25) {
    return { ok: false, reason: "Claude 返回的目标容器疑似截断" };
  }
  return {
    ok: true,
    html: String(baseHtml || "").slice(0, normalized.scopeStart) + replacement + String(baseHtml || "").slice(normalized.scopeEnd),
    replacement,
  };
}

function decodeBasicHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function normalizeCellText(value) {
  return decodeBasicHtmlEntities(String(value || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractTableCellTexts(html) {
  const texts = [];
  for (const match of String(html || "").matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
    const text = normalizeCellText(match[1]);
    if (text) texts.push(text);
  }
  return texts;
}

function uniqueValues(values) {
  const result = [];
  for (const value of values) {
    if (!value || result.includes(value)) continue;
    result.push(value);
  }
  return result;
}

function isActiveStatusValue(value) {
  const text = String(value || "").trim();
  return /^(活跃|启用|可用|有效|正常|成功|是|active|enabled|yes|success)$/i.test(text) || /^活[-－—]/.test(text);
}

function isInactiveStatusValue(value) {
  const text = String(value || "").trim();
  return /^(不活跃|未活跃|非活跃|停用|禁用|不可用|无效|异常|失败|否|无|inactive|disabled|no|fail|failed)$/i.test(text) || /^[—–-]+$/.test(text);
}

function includesActiveStatusRequest(instruction) {
  const text = String(instruction || "");
  const withoutInactive = text.replace(/不活跃|未活跃|非活跃/g, "");
  return /活跃|启用|可用|有效|正常|成功/.test(withoutInactive);
}

function includesInactiveStatusRequest(instruction) {
  return /不活跃|未活跃|非活跃|停用|禁用|不可用|无效|异常|失败/.test(String(instruction || ""));
}

function hasGreenDotRequest(instruction) {
  return /小?绿点|绿色点|绿圆点|绿色圆点|green\s*dot|green/i.test(String(instruction || ""));
}

function hasGrayDotRequest(instruction) {
  return /小?灰点|灰色点|灰圆点|灰色圆点|gray\s*dot|grey\s*dot|gray|grey/i.test(String(instruction || ""));
}

function splitRequiredHeaderTexts(value) {
  return uniqueValues(
    String(value || "")
      .split(/[、，,]/)
      .map((item) => item.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, ""))
      .filter((item) => item.length >= 2 && item.length <= 80)
  );
}

function extractRequiredHeaderTexts(instruction, plan) {
  const planText = String(plan || "");
  // 编辑计划已将“新增列”的精确字段收敛到 replacement；只对表格插入任务启用，
  // 避免把一般文案修改误当成表头契约。
  if (!/operation=insert/i.test(planText) || !/(?:scope=table|列|字段)/.test(`${instruction || ""}${planText}`)) return [];
  const replacement = /(?:^|[；;\n])\s*replacement=([^；;\n]+)/i.exec(planText)?.[1] || "";
  return splitRequiredHeaderTexts(replacement);
}

function extractRequiredInputPlaceholders(instruction) {
  const result = [];
  const source = String(instruction || "");
  const patterns = [
    /输入框(?:中)?(?:展示|显示|提示|占位)?\s*(?:为|是|：|:)?\s*["'“”‘’]([^"'“”‘’\n]{2,80})["'“”‘’]/g,
    /占位(?:文本|文案)?\s*(?:为|是|=|：|:)?\s*["'“”‘’]([^"'“”‘’\n]{2,80})["'“”‘’]/g,
    /placeholder\s*(?:为|是|=|：|:)?\s*["'“”‘’]([^"'“”‘’\n]{2,80})["'“”‘’]/gi,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = String(match[1] || "").trim();
      if (value && !result.includes(value)) result.push(value);
    }
  }
  return result;
}

function extractRequiredTableCellFormats(instruction) {
  return /姓名\s*[（(]\s*手机号\s*[）)]/.test(String(instruction || "")) ? ["name-phone"] : [];
}

function extractTabEntries(html) {
  const entries = [];
  const source = String(html || "");
  const pattern = /<([a-z][\w:-]*)\b([^>]*\brole\s*=\s*(["'])tab\3[^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const match of source.matchAll(pattern)) {
    const attrs = match[2] || "";
    const text = normalizeCellText(match[4] || "");
    const classValue = /\bclass\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] || "";
    entries.push({
      text,
      active:
        /\baria-selected\s*=\s*["']true["']/i.test(attrs) ||
        classValue.split(/\s+/).some((token) => token === "active" || /(?:^|[-_])tabs?-tab-active$/i.test(token)),
    });
  }
  return entries;
}

function countTabPanels(html) {
  return (String(html || "").match(/<[a-z][\w:-]*\b[^>]*\brole\s*=\s*["']tabpanel["'][^>]*>/gi) || []).length;
}

function extractRequiredTabTexts(instruction, plan) {
  const planText = String(plan || "");
  const replacement = /(?:^|[；;\n])\s*replacement=([^；;\n]+)/i.exec(planText)?.[1] || "";
  const fallback = /(?:叫|名为|名称为)\s*["'“”‘’]?([^"'“”‘’。，,；;\n]{2,30})/i.exec(String(instruction || ""))?.[1] || "";
  return uniqueValues(
    String(replacement || fallback)
      .split(/[、，,]/)
      .map((item) => item.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, ""))
      .filter((item) => item.length >= 2 && item.length <= 30)
  );
}

function extractRequiredTabContentTexts(instruction) {
  const source = String(instruction || "");
  const clause = /(?:展示|显示|包含|包括)([^。；;\n]{2,120}?)(?=等(?:维度|指标|内容)|[。；;\n]|$)/i.exec(source)?.[1] || "";
  return uniqueValues(
    clause
      .replace(/[（(][^）)]*[）)]/g, " ")
      .split(/[、，,]|(?:以及|和|及|与)/)
      .map((item) => item.trim().replace(/^(?:对应的?|相关的?)/, "").replace(/(?:的)?(?:活跃情况|数据|信息)$/, ""))
      .filter((item) => item.length >= 2 && item.length <= 30 && !/^(?:内容|详情|数据|信息|表格|列表|卡片|面板)$/.test(item))
  ).slice(0, 6);
}

function buildTabCompletionContract(instruction, originalScopeHtml, plan) {
  const text = String(instruction || "");
  if (!isTabSwitchInstruction(text) || !/新增|添加|增加|插入|加一个|加个/.test(text)) return null;
  const originalTabs = extractTabEntries(originalScopeHtml);
  const originalPanelCount = countTabPanels(originalScopeHtml);
  if (!originalTabs.length || !originalPanelCount) return null;
  const requiredTabTexts = extractRequiredTabTexts(text, plan);
  const addedTabCount = Math.max(1, requiredTabTexts.length);
  const changesDefaultSelection = /默认(?:打开|选中|激活)|初始(?:打开|选中|激活)|打开页面.{0,20}(?:展示|显示|选中)/.test(text);
  return {
    originalTabTexts: originalTabs.map((entry) => entry.text).filter(Boolean),
    requiredTabTexts,
    requiredContentTexts: extractRequiredTabContentTexts(text),
    expectedTabCount: originalTabs.length + addedTabCount,
    expectedPanelCount: originalPanelCount + addedTabCount,
    preserveActiveTabText: changesDefaultSelection ? "" : originalTabs.find((entry) => entry.active)?.text || "",
  };
}

function buildScopedCompletionChecklist(instruction, originalScopeHtml, plan) {
  const cells = extractTableCellTexts(originalScopeHtml);
  const items = [];
  if (hasGreenDotRequest(instruction) && includesActiveStatusRequest(instruction)) {
    const fromValues = uniqueValues(cells.filter(isActiveStatusValue));
    if (fromValues.length) {
      items.push({
        kind: "active-green-dot",
        label: "活跃状态改为小绿点",
        fromValues,
        targetDescription: "small green dot",
      });
    }
  }
  if (hasGrayDotRequest(instruction) && includesInactiveStatusRequest(instruction)) {
    const fromValues = uniqueValues(cells.filter(isInactiveStatusValue));
    if (fromValues.length) {
      items.push({
        kind: "inactive-gray-dot",
        label: "不活跃状态改为小灰点",
        fromValues,
        targetDescription: "small gray dot",
      });
    }
  }
  const requiredHeaderTexts = extractRequiredHeaderTexts(instruction, plan);
  return {
    items,
    requiredHeaderTexts,
    requiredInputPlaceholders: extractRequiredInputPlaceholders(instruction),
    requiredTableCellFormats: extractRequiredTableCellFormats(instruction),
    requiresWideTableLayout: requiredHeaderTexts.length >= 1,
    tabContract: buildTabCompletionContract(instruction, originalScopeHtml, plan),
  };
}

function hasExactCellText(html, value) {
  return extractTableCellTexts(html).some((text) => text === value);
}

function hasExactHeaderCellText(html, value) {
  for (const match of String(html || "").matchAll(/<thead\b[^>]*>([\s\S]*?)<\/thead>/gi)) {
    if (hasExactCellText(match[1], value)) return true;
  }
  return false;
}

function hasExactInputPlaceholder(html, value) {
  for (const match of String(html || "").matchAll(/<(?:input|textarea)\b[^>]*\bplaceholder\s*=\s*(["'])([\s\S]*?)\1[^>]*>/gi)) {
    if (decodeBasicHtmlEntities(match[2]).trim() === value) return true;
  }
  return false;
}

function logicalTableCells(rowHtml, cellTag = "t[dh]") {
  const cells = [];
  const re = new RegExp(`<(${cellTag})\\b([^>]*)>([\\s\\S]*?)<\\/\\1>`, "gi");
  for (const match of String(rowHtml || "").matchAll(re)) {
    const colspan = Number(/\bcolspan\s*=\s*["']?(\d+)/i.exec(match[2] || "")?.[1] || 1);
    const logicalSpan = Number.isFinite(colspan) && colspan > 0 ? colspan : 1;
    for (let index = 0; index < logicalSpan; index += 1) cells.push({ html: match[3] || "", text: normalizeCellText(match[3] || "") });
  }
  return cells;
}

function tableBodyRows(table) {
  const body = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(String(table || ""))?.[1] || "";
  return Array.from(body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi), (match) => match[1] || "");
}

function validateRequiredTableCellFormat(html, requiredHeaderTexts, format) {
  if (format !== "name-phone") return { ok: true };
  const tables = Array.from(String(html || "").matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi), (match) => match[0]);
  const headerIndex = tables.findIndex((candidate) => requiredHeaderTexts.every((value) => hasExactHeaderCellText(candidate, value)));
  if (headerIndex < 0) return { ok: false, reason: "客户端增强未完成：无法定位新增联系人列" };
  const headerRow = /<thead\b[^>]*>[\s\S]*?<tr\b[^>]*>([\s\S]*?)<\/tr>/i.exec(tables[headerIndex])?.[1] || "";
  const headerCells = logicalTableCells(headerRow, "th");
  const formatHeader = requiredHeaderTexts.find((value) => /联系人|姓名|手机号/.test(value)) || requiredHeaderTexts.at(-1) || "";
  const formatColumnIndex = headerCells.findIndex((cell) => cell.text === formatHeader);
  if (formatColumnIndex < 0) return { ok: false, reason: `客户端增强未完成：无法定位“${formatHeader}”列位置` };
  const bodyTable = /<tbody\b/i.test(tables[headerIndex])
    ? tables[headerIndex]
    : tables.slice(headerIndex + 1, headerIndex + 4).find((candidate) => /<tbody\b/i.test(candidate));
  const rows = tableBodyRows(bodyTable || "");
  if (!rows.length) return { ok: false, reason: "客户端增强未完成：目标列表没有可校验的数据行" };
  const namePhoneRe = /^[\p{Script=Han}A-Za-z·]{2,20}\s*[（(]\s*1\d{10}\s*[）)]$/u;
  const invalidRows = rows
    .map((row, index) => ({ index: index + 1, cell: logicalTableCells(row, "td")[formatColumnIndex] }))
    .filter((item) => !item.cell || !namePhoneRe.test(item.cell.text));
  if (invalidRows.length) {
    return {
      ok: false,
      reason: `客户端增强未完成：第 ${invalidRows.slice(0, 5).map((item) => item.index).join("、")} 行缺少“姓名（11位手机号）”格式数据${invalidRows.length > 5 ? `等共 ${invalidRows.length} 行` : ""}`,
    };
  }
  return { ok: true };
}

function logicalTableCellCount(rowHtml, cellTag = "t[dh]") {
  let count = 0;
  const re = new RegExp(`<${cellTag}\\b([^>]*)>`, "gi");
  for (const match of String(rowHtml || "").matchAll(re)) {
    const colspan = Number(/\bcolspan\s*=\s*["']?(\d+)/i.exec(match[1] || "")?.[1] || 1);
    count += Number.isFinite(colspan) && colspan > 0 ? colspan : 1;
  }
  return count;
}

function validateRequiredTableGeometry(html, requiredHeaderTexts, checklist = {}) {
  const tables = Array.from(String(html || "").matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi), (match) => match[0]);
  const headerIndex = tables.findIndex((candidate) => requiredHeaderTexts.every((value) => hasExactHeaderCellText(candidate, value)));
  if (headerIndex < 0) return { ok: true };
  const table = tables[headerIndex];
  const headerRow = /<thead\b[^>]*>[\s\S]*?<tr\b[^>]*>([\s\S]*?)<\/tr>/i.exec(table)?.[1] || "";
  const headerCount = logicalTableCellCount(headerRow);
  if (checklist.expectedFinalColumnCount && headerCount !== checklist.expectedFinalColumnCount) {
    return { ok: false, reason: `客户端增强未完成：预期 ${checklist.expectedFinalColumnCount} 列，但表头实际为 ${headerCount} 列` };
  }
  if (!headerCount) return { ok: true };
  const colgroup = /<colgroup\b[^>]*>([\s\S]*?)<\/colgroup>/i.exec(table)?.[1] || "";
  const cols = Array.from(colgroup.matchAll(/<col\b([^>]*)>/gi), (match) => match[1] || "");
  if (colgroup && cols.length !== headerCount) {
    return { ok: false, reason: `客户端增强未完成：表头共 ${headerCount} 列，但 colgroup 仍为 ${cols.length} 列，新增列会被挤压变形` };
  }
  const colWidthSum = cols.reduce((sum, attrs) => {
    const width = Number(/\bwidth\s*:\s*(\d+(?:\.\d+)?)px/i.exec(attrs)?.[1] || 0);
    return sum + (Number.isFinite(width) ? width : 0);
  }, 0);
  const tableWidth = Number(/<table\b[^>]*\bstyle\s*=\s*["'][^"']*\bwidth\s*:\s*(\d+(?:\.\d+)?)px/i.exec(table)?.[1] || 0);
  if (colgroup && tableWidth > 0 && colWidthSum > tableWidth + 2) {
    return {
      ok: false,
      reason: `客户端增强未完成：列宽合计 ${Math.ceil(colWidthSum)}px 超过表格宽度 ${Math.ceil(tableWidth)}px，需扩展表宽并开启横向滚动`,
    };
  }
  const bodyTable = /<tbody\b/i.test(table)
    ? table
    : tables.slice(headerIndex + 1, headerIndex + 4).find((candidate) => /<tbody\b/i.test(candidate));
  if (!bodyTable && checklist.expectedBodyRowCount) {
    return { ok: false, reason: `客户端增强未完成：未找到应保留的 ${checklist.expectedBodyRowCount} 行表体数据` };
  }
  if (bodyTable) {
    const bodyRows = tableBodyRows(bodyTable);
    if (checklist.expectedBodyRowCount && bodyRows.length !== checklist.expectedBodyRowCount) {
      return { ok: false, reason: `客户端增强未完成：预期保留 ${checklist.expectedBodyRowCount} 行数据，但表体实际为 ${bodyRows.length} 行` };
    }
    const mismatchedRows = bodyRows
      .map((row, index) => ({ index: index + 1, count: logicalTableCellCount(row, "td") }))
      .filter((item) => item.count !== headerCount);
    if (mismatchedRows.length) {
      return {
        ok: false,
        reason: `客户端增强未完成：表头为 ${headerCount} 列，但第 ${mismatchedRows.slice(0, 5).map((item) => `${item.index} 行为 ${item.count} 列`).join("、")}${mismatchedRows.length > 5 ? `等共 ${mismatchedRows.length} 行不一致` : ""}`,
      };
    }
    const bodyColgroup = /<colgroup\b[^>]*>([\s\S]*?)<\/colgroup>/i.exec(bodyTable)?.[1] || "";
    const bodyColCount = Array.from(bodyColgroup.matchAll(/<col\b[^>]*>/gi)).length;
    if (bodyColCount && bodyColCount !== headerCount) {
      return { ok: false, reason: `客户端增强未完成：分离式表格表头为 ${headerCount} 列，但表体 colgroup 为 ${bodyColCount} 列` };
    }
  }
  return { ok: true };
}

function hasDotSignal(html, kind) {
  const source = String(html || "");
  if (kind === "active-green-dot") {
    return /#52c41a|#22c55e|#16a34a|#10b981|green|rgb\(\s*(82\s*,\s*196\s*,\s*26|34\s*,\s*197\s*,\s*94|22\s*,\s*163\s*,\s*74|16\s*,\s*185\s*,\s*129)/i.test(source);
  }
  if (kind === "inactive-gray-dot") {
    return /#bfbfbf|#d9d9d9|#999(?:\b|;)|#8c8c8c|#9ca3af|#6b7280|gray|grey|inactive|disabled|rgb\(\s*(191|217|153|156|107)\s*,/i.test(source);
  }
  return true;
}

function validateScopedCompletion(checklist, editedScopeHtml) {
  const items = checklist && Array.isArray(checklist.items) ? checklist.items : [];
  for (const item of items) {
    const remaining = item.fromValues.filter((value) => hasExactCellText(editedScopeHtml, value));
    if (remaining.length) {
      return { ok: false, reason: `客户端增强未完成：仍存在未替换的${item.label}原值“${remaining.slice(0, 3).join("、")}”` };
    }
    if (!hasDotSignal(editedScopeHtml, item.kind)) {
      return { ok: false, reason: `客户端增强未完成：未检测到${item.label}` };
    }
  }
  const requiredHeaderTexts = checklist && Array.isArray(checklist.requiredHeaderTexts) ? checklist.requiredHeaderTexts : [];
  const missingHeaders = requiredHeaderTexts.filter((value) => !hasExactHeaderCellText(editedScopeHtml, value));
  if (missingHeaders.length) {
    return { ok: false, reason: `客户端增强未完成：缺少目标表头“${missingHeaders.slice(0, 4).join("、")}”` };
  }
  const requiredInputPlaceholders =
    checklist && Array.isArray(checklist.requiredInputPlaceholders) ? checklist.requiredInputPlaceholders : [];
  const missingPlaceholders = requiredInputPlaceholders.filter((value) => !hasExactInputPlaceholder(editedScopeHtml, value));
  if (missingPlaceholders.length) {
    return { ok: false, reason: `客户端增强未完成：缺少输入框占位文案“${missingPlaceholders.slice(0, 3).join("、")}”` };
  }
  if (checklist?.requiresWideTableLayout && requiredHeaderTexts.length) {
    const geometry = validateRequiredTableGeometry(editedScopeHtml, requiredHeaderTexts, checklist);
    if (!geometry.ok) return geometry;
  }
  const requiredTableCellFormats =
    checklist && Array.isArray(checklist.requiredTableCellFormats) ? checklist.requiredTableCellFormats : [];
  if (requiredTableCellFormats.includes("name-phone")) {
    const formatValidation = validateRequiredTableCellFormat(editedScopeHtml, requiredHeaderTexts, "name-phone");
    if (!formatValidation.ok) return formatValidation;
  }
  const tabContract = checklist?.tabContract;
  if (tabContract) {
    const editedTabs = extractTabEntries(editedScopeHtml);
    const editedPanelCount = countTabPanels(editedScopeHtml);
    if (editedTabs.length !== tabContract.expectedTabCount) {
      return { ok: false, reason: `客户端增强未完成：预期 ${tabContract.expectedTabCount} 个页签，实际为 ${editedTabs.length} 个` };
    }
    if (editedPanelCount !== tabContract.expectedPanelCount) {
      return { ok: false, reason: `客户端增强未完成：预期 ${tabContract.expectedPanelCount} 个页签面板，实际为 ${editedPanelCount} 个` };
    }
    const editedTabTexts = editedTabs.map((entry) => entry.text);
    const missingOriginalTabs = tabContract.originalTabTexts.filter((value) => !editedTabTexts.includes(value));
    if (missingOriginalTabs.length) {
      return { ok: false, reason: `客户端增强未完成：原页签“${missingOriginalTabs.slice(0, 4).join("、")}”丢失` };
    }
    const missingNewTabs = tabContract.requiredTabTexts.filter((value) => !editedTabTexts.includes(value));
    if (missingNewTabs.length) {
      return { ok: false, reason: `客户端增强未完成：缺少新增页签“${missingNewTabs.slice(0, 4).join("、")}”` };
    }
    if (tabContract.preserveActiveTabText) {
      const activeTabText = editedTabs.find((entry) => entry.active)?.text || "";
      if (activeTabText !== tabContract.preserveActiveTabText) {
        return { ok: false, reason: `客户端增强未完成：默认激活页签应继续为“${tabContract.preserveActiveTabText}”` };
      }
    }
    const visibleText = normalizeCellText(String(editedScopeHtml || "").replace(/<style\b[\s\S]*?<\/style>|<script\b[\s\S]*?<\/script>/gi, " "));
    const missingContent = tabContract.requiredContentTexts.filter((value) => !visibleText.includes(value));
    if (missingContent.length) {
      return { ok: false, reason: `客户端增强未完成：新增页签内容缺少“${missingContent.slice(0, 4).join("、")}”` };
    }
    if (!hasTabSwitchImplementation(editedScopeHtml)) {
      return { ok: false, reason: "客户端增强未完成：页签缺少可执行的点击切换逻辑" };
    }
  }
  return { ok: true };
}

function formatScopedCompletionChecklist(checklist) {
  const items = checklist && Array.isArray(checklist.items) ? checklist.items : [];
  const requiredHeaderTexts = checklist && Array.isArray(checklist.requiredHeaderTexts) ? checklist.requiredHeaderTexts : [];
  const requiredInputPlaceholders =
    checklist && Array.isArray(checklist.requiredInputPlaceholders) ? checklist.requiredInputPlaceholders : [];
  const requiredTableCellFormats =
    checklist && Array.isArray(checklist.requiredTableCellFormats) ? checklist.requiredTableCellFormats : [];
  const tabContract = checklist?.tabContract;
  if (!items.length && !requiredHeaderTexts.length && !requiredInputPlaceholders.length && !requiredTableCellFormats.length && !tabContract) return "";
  const lines = ["## Required Transformations", ""];
  for (const item of items) {
    lines.push(`- Replace ${item.label} source cell values \`${item.fromValues.join("`, `")}\` with a ${item.targetDescription}.`);
  }
  if (requiredHeaderTexts.length) {
    lines.push(`- Add every required table header exactly once: \`${requiredHeaderTexts.join("`, `")}\`.`);
  }
  if (requiredInputPlaceholders.length) {
    lines.push(`- Add every required input placeholder exactly once: \`${requiredInputPlaceholders.join("`, `")}\`.`);
  }
  if (requiredTableCellFormats.includes("name-phone")) {
    lines.push("- Populate the new table column in every existing body row with realistic mock data formatted as `姓名（11位手机号）`.");
  }
  if (checklist?.expectedBodyRowCount) {
    lines.push(`- Preserve all ${checklist.expectedBodyRowCount} existing body rows; every row must have the final column count and the new cell data.`);
  }
  if (checklist?.requiresWideTableLayout) {
    lines.push(
      "- Preserve readable existing column widths. If the table has a colgroup, add one matching col for every new header/body cell and keep the col count equal to the logical header count. Expand the table min-width to the sum of column widths, and enable overflow-x:auto on its nearest viewport instead of squeezing every column into the old width."
    );
  }
  if (tabContract) {
    if (tabContract.requiredTabTexts.length) {
      lines.push(`- Add the required tab exactly once: \`${tabContract.requiredTabTexts.join("`, `")}\`.`);
    }
    lines.push(
      `- Preserve every existing tab and finish with exactly ${tabContract.expectedTabCount} tabs and ${tabContract.expectedPanelCount} matching tabpanels.`
    );
    if (tabContract.preserveActiveTabText) {
      lines.push(`- Preserve \`${tabContract.preserveActiveTabText}\` as the initially active tab.`);
    }
    if (tabContract.requiredContentTexts.length) {
      lines.push(`- The new tabpanel must contain every requested content term: \`${tabContract.requiredContentTexts.join("`, `")}\`.`);
    }
    lines.push("- Add executable click switching that updates both tabs and matching tabpanels; static active classes are not sufficient.");
  }
  lines.push("- Complete every required transformation before stopping.");
  return `${lines.join("\n")}\n`;
}

function statusDotHtml(kind) {
  const color = kind === "active-green-dot" ? "#52c41a" : "#d9d9d9";
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};vertical-align:middle;"></span>`;
}

function tryApplyScopedStatusDotPatch(instruction, originalScopeHtml, checklist) {
  const list = checklist || buildScopedCompletionChecklist(instruction, originalScopeHtml);
  const items = list && Array.isArray(list.items) ? list.items : [];
  if (!items.length) return { applied: false, reason: "没有可确定的状态点替换项" };
  let changed = false;
  let replacement = String(originalScopeHtml || "").replace(/(<t[dh]\b[^>]*>)([\s\S]*?)(<\/t[dh]>)/gi, (full, open, inner, close) => {
    const text = normalizeCellText(inner);
    const item = items.find((candidate) => candidate.fromValues.includes(text));
    if (!item) return full;
    changed = true;
    return `${open}${statusDotHtml(item.kind)}${close}`;
  });
  if (!changed || replacement === originalScopeHtml) return { applied: false, reason: "目标状态单元格未命中" };
  const completion = validateScopedCompletion(list, replacement);
  if (!completion.ok) return { applied: false, reason: completion.reason };
  return { applied: true, replacement, checklist: list };
}

function excerptForTask(value, max = 6000) {
  const text = String(value || "").replace(/```/g, "'''");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.floor(max * 0.65))}\n...\n${text.slice(-Math.floor(max * 0.3))}`;
}

function buildClaudeFocusSection(focus, scopedJob, opts = {}) {
  if (!focus || typeof focus !== "object") return "";
  const includeExcerpts = opts.includeExcerpts !== false;
  const lines = [
    "## Edit Plan And Precise Anchor",
    "",
    `- Focus source: ${focus.source || "unknown"}`,
  ];
  if (focus.plan) lines.push(`- Edit plan: ${focus.plan}`);
  if (Number.isFinite(Number(focus.targetOffset))) lines.push(`- Target offset: ${Math.trunc(Number(focus.targetOffset))}`);
  if (Number.isFinite(Number(focus.scopeStart)) && Number.isFinite(Number(focus.scopeEnd))) {
    lines.push(`- Scope range in original edit HTML: [${Math.trunc(Number(focus.scopeStart))}, ${Math.trunc(Number(focus.scopeEnd))})`);
  }
  if (focus.scopeTag) lines.push(`- Scope tag: <${focus.scopeTag}>`);
  if (focus.scopeReason) lines.push(`- Scope reason: ${focus.scopeReason}`);
  if (scopedJob) {
    lines.push(
      "",
      "The `index.html` file for this job contains only the extracted target container wrapped by `<!--YD_SCOPE_START-->` and `<!--YD_SCOPE_END-->`. Edit only the content between those markers. Preserve both markers."
    );
  }
  if (String(focus.plan || "").includes("batch=yes")) {
    lines.push(
      "",
      "This is a batch edit. The target HTML excerpt is only a representative anchor; apply the user's rule across the relevant repeated cells/items inside the extracted scope."
    );
  }
  if (includeExcerpts && focus.targetHtml) {
    lines.push("", "### Target HTML Excerpt", "", "```html", excerptForTask(focus.targetHtml), "```");
  }
  if (includeExcerpts && !scopedJob && focus.scopeHtml) {
    lines.push("", "### Target Scope Excerpt", "", "```html", excerptForTask(focus.scopeHtml, 12000), "```");
  }
  return `${lines.join("\n")}\n`;
}

function stableAssetPlaceholder(uri, used) {
  const digest = crypto.createHash("sha256").update(uri).digest("hex");
  for (let len = 12; len <= digest.length; len += 4) {
    const ph = `__YD_ASSET_${digest.slice(0, len)}__`;
    const existing = used.get(ph);
    if (!existing || existing === uri) return ph;
  }
  return `__YD_ASSET_${digest}__`;
}

function stableStylePlaceholder(content, used) {
  const digest = crypto.createHash("sha256").update(content).digest("hex");
  for (let len = 12; len <= digest.length; len += 4) {
    const ph = `__YD_STYLE_${digest.slice(0, len)}__`;
    const existing = used.get(ph);
    if (!existing || existing === content) return ph;
  }
  return `__YD_STYLE_${digest}__`;
}

function stableImmutablePlaceholder(content, used, salt = "", syntax = "comment") {
  const digest = crypto.createHash("sha256").update(`${salt}\0${content}`).digest("hex");
  for (let len = 12; len <= digest.length; len += 4) {
    const token = `__YD_IMMUTABLE_${digest.slice(0, len)}__`;
    const ph = syntax === "object-property" ? `"${token}":null` : syntax === "html-comment" ? `<!--${token}-->` : `/*${token}*/`;
    const existing = used.get(ph);
    if (!existing || existing.content === content) return ph;
  }
  const token = `__YD_IMMUTABLE_${digest}__`;
  return syntax === "object-property" ? `"${token}":null` : syntax === "html-comment" ? `<!--${token}-->` : `/*${token}*/`;
}

function projectionSignals(instruction, focus) {
  const fragment = [focus?.targetHtml, focus?.scopeHtml].filter(Boolean).join("\n");
  const ids = new Set(Array.from(fragment.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi), (match) => match[1]));
  const classes = new Set();
  for (const match of fragment.matchAll(/\bclass\s*=\s*["']([^"']+)["']/gi)) {
    for (const className of match[1].split(/\s+/).filter(Boolean)) classes.add(className);
  }
  const dataValues = new Set(
    Array.from(fragment.matchAll(/\bdata-[\w-]+\s*=\s*["']([^"']+)["']/gi), (match) => match[1]).filter(Boolean)
  );
  const referencedIds = new Set();
  const referencedClasses = new Set();
  for (const match of fragment.matchAll(/\b(?:aria-controls|href|data-(?:bs-)?target)\s*=\s*["']\s*([^"'\s>]+)["']/gi)) {
    const value = match[1];
    if (value.startsWith("#")) referencedIds.add(value.slice(1));
    else if (value.startsWith(".")) referencedClasses.add(value.slice(1));
    else if (/^[A-Za-z][\w:.-]*$/.test(value)) referencedIds.add(value);
  }
  const tags = new Set(
    Array.from(fragment.matchAll(/<([a-z][\w-]*)\b/gi), (match) => match[1].toLowerCase()).filter(
      (tag) => !["div", "span", "section", "main"].includes(tag)
    )
  );
  const handlerNames = new Set();
  const handlerTerms = [];
  for (const match of fragment.matchAll(/\bon[a-z]+\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    for (const name of extractCalledFunctionNames(match[2])) handlerNames.add(name);
    for (const literal of match[2].matchAll(/(["'])([^"']{1,80})\1/g)) handlerTerms.push(literal[2]);
  }
  const visibleTerms = String(fragment)
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&\w+;/g, " ")
    .split(/[^\p{Script=Han}A-Za-z0-9_-]+/gu)
    .filter((term) => term.length >= 2 && term.length <= 40)
    .slice(0, 20);
  const instructionTerms = String(instruction || "")
    .replace(/删除|删掉|删去|移除|去掉|修改|改成|调整|新增|添加|插入|替换|这个|那个|一下|请|把|将|的/g, " ")
    .split(/[^\p{Script=Han}A-Za-z0-9_#.-]+/gu)
    .filter((term) => term.length >= 2 && term.length <= 40)
    .slice(0, 16);
  return {
    ids,
    classes,
    dataValues,
    referencedIds,
    referencedClasses,
    tags,
    handlerNames,
    terms: uniqueTerms([...handlerTerms, ...visibleTerms, ...instructionTerms]),
    hasFocus: Boolean(fragment && (ids.size || classes.size || dataValues.size || tags.size || visibleTerms.length)),
  };
}

const DOM_PROJECTION_EXCLUDED_TAGS = new Set(["html", "head", "body", "script", "style", "template", "title", "meta", "link", "base"]);

function projectionFocusIntervals(source, focus) {
  const intervals = [];
  const add = (start, end) => {
    if (start < 0 || end <= start || intervals.some((item) => item.start === start && item.end === end)) return;
    intervals.push({ start, end });
  };
  const scopeStart = Math.trunc(Number(focus?.scopeStart));
  const scopeEnd = Math.trunc(Number(focus?.scopeEnd));
  if (Number.isFinite(scopeStart) && Number.isFinite(scopeEnd) && source.slice(scopeStart, scopeEnd) === focus?.scopeHtml) {
    add(scopeStart, scopeEnd);
  }
  for (const fragment of [focus?.scopeHtml, focus?.targetHtml]) {
    const value = String(fragment || "");
    if (!value) continue;
    let from = 0;
    let count = 0;
    while (count < 8) {
      const start = source.indexOf(value, from);
      if (start < 0) break;
      add(start, start + value.length);
      from = start + value.length;
      count += 1;
    }
  }
  return intervals;
}

function projectionProtectedVisibleTerms(focus) {
  const terms = [];
  for (const fragment of [focus?.targetHtml, focus?.scopeHtml]) {
    const visible = String(fragment || "")
      .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&(?:nbsp|#160);/gi, " ")
      .replace(/&(?:amp|#38);/gi, "&")
      .replace(/&(?:lt|#60);/gi, "<")
      .replace(/&(?:gt|#62);/gi, ">")
      .replace(/&(?:quot|#34);/gi, '"')
      .replace(/&(?:apos|#39);/gi, "'");
    for (const term of visible.split(/[\s,，。；;：:、|/\\()[\]{}<>“”‘’!?！？]+/u)) {
      const value = term.trim();
      if (value.length < 4 || value.length > 40 || terms.includes(value)) continue;
      terms.push(value);
      if (terms.length >= 80) return terms;
    }
  }
  return terms;
}

function literalOccurrenceCount(source, value) {
  if (!value) return 0;
  let count = 0;
  let from = 0;
  while (from < source.length) {
    const index = source.indexOf(value, from);
    if (index < 0) break;
    count += 1;
    from = index + value.length;
  }
  return count;
}

function buildDomSubtreeProjectionRanges(source, instruction, focus, signals, opts = {}) {
  if (!signals.hasFocus || opts.globalEdit) return [];
  const nodes = scanHtmlElements(source);
  const focusIntervals = projectionFocusIntervals(source, focus);
  const protectedNodes = new Set();
  const overlapsFocus = (node) => focusIntervals.some((interval) => node.start < interval.end && interval.start < node.end);
  const nodeMatchesSignals = (node) => {
    const id = String(node.attrs.id || "");
    const classes = String(node.attrs.class || "").split(/\s+/).filter(Boolean);
    if (id && (signals.ids.has(id) || signals.referencedIds.has(id))) return true;
    if (classes.some((className) => signals.referencedClasses.has(className))) return true;
    if (!focusIntervals.length && classes.some((className) => signals.classes.has(className))) return true;
    if (!focusIntervals.length) {
      for (const [name, value] of Object.entries(node.attrs)) {
        if (name.startsWith("data-") && signals.dataValues.has(String(value))) return true;
      }
    }
    if (
      opts.interactiveEdit &&
      /抽屉|弹窗|弹层|drawer|modal|dialog|popup/i.test(String(instruction || "")) &&
      /抽屉|弹窗|弹层|drawer|modal|dialog|popup/i.test(`${id} ${classes.join(" ")} ${node.attrs.role || ""}`)
    ) {
      return true;
    }
    return false;
  };
  for (const node of nodes) {
    if (!overlapsFocus(node) && !nodeMatchesSignals(node)) continue;
    for (let current = node; current; current = current.parent) protectedNodes.add(current);
  }
  const eligible = new Set();
  for (const node of nodes) {
    if (protectedNodes.has(node) || DOM_PROJECTION_EXCLUDED_TAGS.has(node.tag)) continue;
    const content = source.slice(node.start, node.end);
    if (byteLength(content) < MIN_IMMUTABLE_DOM_SUBTREE_BYTES) continue;
    if (/<(?:script|style|template)\b/i.test(content)) continue;
    eligible.add(node);
  }
  const ranges = [];
  for (const node of eligible) {
    let hasEligibleAncestor = false;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (eligible.has(parent)) {
        hasEligibleAncestor = true;
        break;
      }
    }
    if (!hasEligibleAncestor) ranges.push({ start: node.start, end: node.end });
  }
  return ranges;
}

function regexToken(source, token, prefix) {
  return new RegExp(`${prefix}${String(token).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(source);
}

function cssRuleMatchesProjection(rule, signals) {
  const selector = String(rule.selector || "");
  for (const id of signals.ids) if (regexToken(selector, id, "#")) return true;
  for (const className of signals.classes) if (regexToken(selector, className, "\\.")) return true;
  for (const value of signals.dataValues) if (selector.includes(value)) return true;
  for (const tag of signals.tags) if (new RegExp(`(?:^|[\\s>+~,(])${tag}(?=[\\s.#[:>,+~)]|$)`, "i").test(selector)) return true;
  return false;
}

function jsStatementMatchesProjection(statement, signals) {
  const source = String(statement || "");
  for (const id of signals.ids) if (source.includes(id)) return true;
  for (const className of signals.classes) if (source.includes(className)) return true;
  for (const value of signals.dataValues) if (source.includes(value)) return true;
  for (const name of signals.handlerNames) if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(source)) return true;
  return signals.terms.some((term) => source.includes(term));
}

function mergeProjectionRanges(source, ranges) {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  const merged = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && /^[\s;]*$/.test(source.slice(previous.end, range.start))) previous.end = range.end;
    else merged.push({ ...range });
  }
  return merged;
}

function isEscapedCharacter(source, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function scanObjectLiteralProperties(statement) {
  const source = String(statement || "");
  const declaration = /^\s*(?:(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*\{/.exec(source);
  if (!declaration || byteLength(source) < MIN_IMMUTABLE_OBJECT_BYTES) return null;
  const open = source.indexOf("{", declaration.index);
  if (open < 0) return null;
  const properties = [];
  let propertyStart = open + 1;
  let braces = 1;
  let brackets = 0;
  let parens = 0;
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  let close = -1;
  for (let index = open + 1; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === quote && !isEscapedCharacter(source, index)) quote = "";
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "/") return null;
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") braces += 1;
    else if (char === "}") {
      braces -= 1;
      if (braces === 0) {
        close = index;
        break;
      }
    } else if (char === "[") brackets += 1;
    else if (char === "]") brackets -= 1;
    else if (char === "(") parens += 1;
    else if (char === ")") parens -= 1;
    else if (char === "," && braces === 1 && brackets === 0 && parens === 0) {
      if (source.slice(propertyStart, index).trim()) {
        properties.push({ start: propertyStart, end: index, content: source.slice(propertyStart, index) });
      }
      propertyStart = index + 1;
    }
    if (braces < 1 || brackets < 0 || parens < 0) return null;
  }
  if (close < 0 || quote || blockComment || !/^\s*;?\s*$/.test(source.slice(close + 1))) return null;
  if (source.slice(propertyStart, close).trim()) {
    properties.push({ start: propertyStart, end: close, content: source.slice(propertyStart, close) });
  }
  return properties.length > 1 ? properties : null;
}

function irrelevantObjectPropertyRanges(statement, signals) {
  const properties = scanObjectLiteralProperties(statement.content);
  if (!properties) return [];
  const relevant = properties.map((property) => jsStatementMatchesProjection(property.content, signals));
  if (!relevant.some(Boolean) || relevant.every(Boolean)) return [];
  const ranges = [];
  for (let index = 0; index < properties.length; index += 1) {
    if (relevant[index]) continue;
    const first = index;
    while (index + 1 < properties.length && !relevant[index + 1]) index += 1;
    ranges.push({
      start: statement.start + properties[first].start,
      end: statement.start + properties[index].end,
    });
  }
  const saving = ranges.reduce((sum, range) => sum + byteLength(statement.content.slice(range.start - statement.start, range.end - statement.start)), 0);
  return saving >= MIN_ASSET_SAVING_BYTES ? ranges : [];
}

function emptyProjectionInfo(source, extra = {}) {
  const originalBytes = byteLength(source);
  return {
    projectionApplied: false,
    projectionOriginalBytes: originalBytes,
    projectionBytes: originalBytes,
    projectionSavingRatio: 0,
    projectionSkipReason: "no_candidates",
    immutableRegionCount: 0,
    immutableSavedBytes: 0,
    immutableCandidateRegionCount: 0,
    immutableDroppedRegionCount: 0,
    immutableObjectPropertyRegionCount: 0,
    immutableDomSubtreeRegionCount: 0,
    projectionLostProtectedTermCount: 0,
    immutableRegionLimit: MAX_IMMUTABLE_REGIONS,
    immutableMinSavingRatio: MIN_IMMUTABLE_SAVING_RATIO,
    ...extra,
  };
}

function buildTaskRelevantProjectionForClaude(html, instruction, focus, opts = {}) {
  const source = String(html || "");
  const signals = projectionSignals(instruction, focus);
  const candidateMap = new Map();
  const replacements = [];
  const interactiveEdit = Boolean(opts.interactiveEdit);
  const globalVisual = /整体布局|全局布局|响应式|自适应|媒体查询|断点|主题|换肤|主色|整体配色|全局配色|色调|暗色模式|深色模式|浅色模式|整体样式|全局样式|整体视觉/i.test(
    String(instruction || "")
  );
  const wideScopePlan = /(?:batch|needsFullPage)\s*=\s*yes/i.test(String(focus?.plan || ""));
  const globalDomEdit =
    globalVisual || wideScopePlan || /整页|整个页面|全页面|全部|所有|批量|页面结构|整体内容/i.test(String(instruction || ""));
  const addReplacement = (start, end, force = false, syntax = "comment") => {
    const content = source.slice(start, end);
    if (!content || (!force && byteLength(content) < MIN_IMMUTABLE_REGION_BYTES)) return;
    const placeholder = stableImmutablePlaceholder(content, candidateMap, String(start), syntax);
    const region = {
      content,
      beforeAnchor: "",
      afterAnchor: "",
    };
    candidateMap.set(placeholder, region);
    replacements.push({
      start,
      end,
      placeholder,
      region,
      syntax,
      savingBytes: Math.max(0, byteLength(content) - byteLength(placeholder)),
    });
  };

  for (const range of buildDomSubtreeProjectionRanges(source, instruction, focus, signals, {
    globalEdit: globalDomEdit,
    interactiveEdit,
  })) {
    addReplacement(range.start, range.end, false, "html-comment");
  }

  const rawBlockRe = /<(style|script)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const match of source.matchAll(rawBlockRe)) {
    const tag = match[1].toLowerCase();
    const attrs = match[2] || "";
    const content = match[3] || "";
    const blockStart = match.index || 0;
    const contentStart = blockStart + match[0].indexOf(">") + 1;
    const contentEnd = contentStart + content.length;
    if (!content) continue;

    if (tag === "style") {
      if (!signals.hasFocus || globalVisual) continue;
      let scanned;
      try {
        scanned = scanCssRules(content);
      } catch {
        continue;
      }
      if (!scanned?.ok || !scanned.rules.length) continue;
      const relevantRules = new Set(scanned.rules.filter((rule) => cssRuleMatchesProjection(rule, signals)));
      const referencedVariables = new Set();
      for (const rule of relevantRules) {
        for (const variable of rule.content.matchAll(/var\(\s*(--[\w-]+)/g)) referencedVariables.add(variable[1]);
      }
      for (const rule of scanned.rules) {
        if ([...referencedVariables].some((name) => new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`).test(rule.content))) {
          relevantRules.add(rule);
        }
      }
      if (!relevantRules.size) {
        addReplacement(contentStart, contentEnd);
        continue;
      }
      const hidden = scanned.rules
        .filter((rule) => !relevantRules.has(rule))
        .map((rule) => ({ start: rule.start, end: rule.end }));
      for (const range of mergeProjectionRanges(content, hidden)) {
        addReplacement(contentStart + range.start, contentStart + range.end);
      }
      continue;
    }

    if (/\bdata-yd-disabled-script(?:\s|=|$)/i.test(attrs)) {
      addReplacement(contentStart, contentEnd, true);
      continue;
    }
    const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.toLowerCase() || "";
    if (type && !/^(?:module|text\/javascript|application\/javascript)$/.test(type)) continue;
    if (!signals.hasFocus || globalVisual) continue;
    let scanned;
    try {
      scanned = scanJsTopLevelStatements(content);
    } catch {
      continue;
    }
    if (!scanned?.ok || !scanned.statements.length) continue;
    const selected = new Set(scanned.statements.filter((statement) => jsStatementMatchesProjection(statement.content, signals)));
    let changed = true;
    while (changed) {
      changed = false;
      const selectedText = [...selected].map((statement) => statement.content).join("\n");
      for (const statement of scanned.statements) {
        if (selected.has(statement)) continue;
        const defined = definitionNames(statement.content)[0] || "";
        if (defined && new RegExp(`\\b${defined.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(selectedText)) {
          selected.add(statement);
          changed = true;
        }
      }
    }
    if (!selected.size && interactiveEdit) continue;
    if (!selected.size) {
      addReplacement(contentStart, contentEnd);
      continue;
    }
    for (const statement of selected) {
      for (const range of irrelevantObjectPropertyRanges(statement, signals)) {
        addReplacement(contentStart + range.start, contentStart + range.end, false, "object-property");
      }
    }
    const hidden = scanned.statements
      .filter((statement) => !selected.has(statement))
      .map((statement) => ({ start: statement.start, end: statement.end }));
    for (const range of mergeProjectionRanges(content, hidden)) {
      addReplacement(contentStart + range.start, contentStart + range.end);
    }
  }

  const selectedReplacements = [];
  for (const replacement of [...replacements].sort(
    (left, right) => right.savingBytes - left.savingBytes || left.start - right.start
  )) {
    if (selectedReplacements.length >= MAX_IMMUTABLE_REGIONS) break;
    if (selectedReplacements.some((selected) => replacement.start < selected.end && selected.start < replacement.end)) continue;
    selectedReplacements.push(replacement);
  }
  selectedReplacements.sort((left, right) => right.start - left.start);
  let compact = source;
  for (const replacement of selectedReplacements) {
    compact = compact.slice(0, replacement.start) + replacement.placeholder + compact.slice(replacement.end);
  }
  const originalBytes = byteLength(source);
  const compactBytes = byteLength(compact);
  const savedBytes = Math.max(0, originalBytes - compactBytes);
  const savingRatio = originalBytes ? savedBytes / originalBytes : 0;
  const baseInfo = {
    immutableCandidateRegionCount: replacements.length,
    immutableDroppedRegionCount: Math.max(0, replacements.length - selectedReplacements.length),
    immutableObjectPropertyRegionCount: selectedReplacements.filter((replacement) => replacement.syntax === "object-property").length,
    immutableDomSubtreeRegionCount: selectedReplacements.filter((replacement) => replacement.syntax === "html-comment").length,
  };
  if (!selectedReplacements.length) {
    return { compact: source, map: new Map(), preserveStyles: globalVisual || signals.hasFocus, info: emptyProjectionInfo(source, baseInfo) };
  }
  if (savedBytes < MIN_ASSET_SAVING_BYTES || savingRatio < MIN_IMMUTABLE_SAVING_RATIO) {
    return {
      compact: source,
      map: new Map(),
      preserveStyles: globalVisual || signals.hasFocus,
      info: emptyProjectionInfo(source, { ...baseInfo, projectionSkipReason: "saving_below_threshold" }),
    };
  }
  const lostProtectedTerms = projectionProtectedVisibleTerms(focus).filter(
    (term) => literalOccurrenceCount(compact, term) < literalOccurrenceCount(source, term)
  );
  if (lostProtectedTerms.length) {
    return {
      compact: source,
      map: new Map(),
      preserveStyles: globalVisual || signals.hasFocus,
      info: emptyProjectionInfo(source, {
        ...baseInfo,
        projectionSkipReason: "protected_terms_lost",
        projectionLostProtectedTermCount: lostProtectedTerms.length,
      }),
    };
  }
  const immutableMap = new Map();
  for (const replacement of selectedReplacements) {
    const index = compact.indexOf(replacement.placeholder);
    replacement.region.beforeAnchor = compact.slice(Math.max(0, index - 12), index);
    replacement.region.afterAnchor = compact.slice(index + replacement.placeholder.length, index + replacement.placeholder.length + 12);
    immutableMap.set(replacement.placeholder, replacement.region);
  }
  const selfValidation = validateImmutablePlaceholdersForClaude(compact, immutableMap);
  if (!selfValidation.ok) {
    return {
      compact: source,
      map: new Map(),
      preserveStyles: globalVisual || signals.hasFocus,
      info: emptyProjectionInfo(source, { ...baseInfo, projectionSkipReason: "self_validation_failed" }),
    };
  }
  return {
    compact,
    map: immutableMap,
    preserveStyles: globalVisual || signals.hasFocus,
    info: {
      projectionApplied: true,
      projectionOriginalBytes: originalBytes,
      projectionBytes: compactBytes,
      projectionSavingRatio: savingRatio,
      projectionSkipReason: "",
      immutableRegionCount: immutableMap.size,
      immutableSavedBytes: savedBytes,
      ...baseInfo,
      immutableRegionLimit: MAX_IMMUTABLE_REGIONS,
      immutableMinSavingRatio: MIN_IMMUTABLE_SAVING_RATIO,
    },
  };
}

function validateImmutablePlaceholdersForClaude(html, map) {
  if (!map?.size) return { ok: true };
  const matches = Array.from(String(html || "").matchAll(IMMUTABLE_PLACEHOLDER_RE), (match) => match[0]);
  const counts = new Map();
  for (const placeholder of matches) counts.set(placeholder, (counts.get(placeholder) || 0) + 1);
  const found = new Set(counts.keys());
  const unknown = [...found].filter((placeholder) => !map.has(placeholder));
  if (unknown.length) return { ok: false, reason: `包含未知不可变占位符：${unknown.slice(0, 3).join(", ")}` };
  const missing = [...map.keys()].filter((placeholder) => !found.has(placeholder));
  if (missing.length) return { ok: false, reason: `不可变区域占位符丢失：${missing.slice(0, 3).join(", ")}` };
  const duplicates = [...found].filter((placeholder) => counts.get(placeholder) !== 1);
  if (duplicates.length) return { ok: false, reason: `不可变区域占位符重复：${duplicates.slice(0, 3).join(", ")}` };
  for (const [placeholder, region] of map) {
    const index = String(html || "").indexOf(placeholder);
    // 仅校验前锚点：占位符被搬走会改变其前 12 字符；后锚点不校验，以允许 Claude
    // 在不可变 <style> 之后紧邻插入覆盖样式（如把抽屉改造成页内全屏面板）。
    const before = String(html || "").slice(Math.max(0, index - region.beforeAnchor.length), index);
    if (before !== region.beforeAnchor) {
      return { ok: false, reason: `不可变区域占位符位置变化：${placeholder}` };
    }
  }
  return { ok: true };
}

function expandImmutableRegionsForClaude(html, map) {
  if (!map?.size) return html;
  return String(html || "").replace(IMMUTABLE_PLACEHOLDER_RE, (placeholder) => map.get(placeholder)?.content || placeholder);
}

function compactLargeStyleBlocksForClaude(html) {
  const source = String(html || "");
  const styleMap = new Map();
  const compact = source.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (full, attrs, content) => {
    if (byteLength(content) < LARGE_STYLE_BLOCK_MIN_BYTES) return full;
    const ph = stableStylePlaceholder(content, styleMap);
    styleMap.set(ph, content);
    return `<style${attrs}>${ph}</style>`;
  });
  if (!styleMap.size || byteLength(source) - byteLength(compact) < MIN_ASSET_SAVING_BYTES) {
    return { compact: source, map: new Map() };
  }
  return { compact, map: styleMap };
}

function expandLargeStyleBlocksForClaude(html, map) {
  if (!map.size) return html;
  return String(html || "").replace(STYLE_PLACEHOLDER_RE, (ph) => map.get(ph) || ph);
}

function validateStylePlaceholdersForClaude(html, map) {
  if (!map.size) return { ok: true };
  const found = new Set(Array.from(String(html || "").matchAll(STYLE_PLACEHOLDER_RE), (m) => m[0]));
  const unknown = Array.from(found).filter((ph) => !map.has(ph));
  if (unknown.length) return { ok: false, reason: `包含未知样式占位符：${unknown.slice(0, 3).join(", ")}` };
  const missing = Array.from(map.keys()).filter((ph) => !found.has(ph));
  if (missing.length) return { ok: false, reason: `样式占位符丢失：${missing.slice(0, 3).join(", ")}` };
  return { ok: true };
}

function compactDataUrisForClaude(html) {
  const dataToPlaceholder = new Map();
  const placeholderToData = new Map();
  let compact = "";
  let last = 0;
  for (const m of String(html || "").matchAll(DATA_URI_RE)) {
    const uri = m[0];
    let ph = dataToPlaceholder.get(uri);
    if (!ph) {
      ph = stableAssetPlaceholder(uri, placeholderToData);
      dataToPlaceholder.set(uri, ph);
      placeholderToData.set(ph, uri);
    }
    const idx = m.index || 0;
    compact += html.slice(last, idx) + ph;
    last = idx + uri.length;
  }
  compact += html.slice(last);
  if (dataToPlaceholder.size === 0 || byteLength(html) - byteLength(compact) < MIN_ASSET_SAVING_BYTES) {
    return { compact: html, map: new Map() };
  }
  const map = new Map();
  for (const [uri, ph] of dataToPlaceholder) map.set(ph, uri);
  return { compact, map };
}

function expandDataUrisForClaude(html, map) {
  if (!map.size) return html;
  return String(html || "").replace(PLACEHOLDER_RE, (ph) => map.get(ph) || ph);
}

function validateAssetPlaceholdersForClaude(html, map, opts = {}) {
  if (!map.size) return { ok: true };
  const found = new Set(Array.from(String(html || "").matchAll(PLACEHOLDER_RE), (m) => m[0]));
  const unknown = Array.from(found).filter((ph) => !map.has(ph));
  if (unknown.length) return { ok: false, reason: `包含未知资源占位符：${unknown.slice(0, 3).join(", ")}` };
  if (!opts.allowMissing) {
    const missing = Array.from(map.keys()).filter((ph) => !found.has(ph));
    if (missing.length) return { ok: false, reason: `资源占位符丢失：${missing.slice(0, 3).join(", ")}` };
  }
  return { ok: true };
}

function rawHtmlAssetsToMapForClaude(assets) {
  const map = new Map();
  for (const asset of Array.isArray(assets) ? assets : []) {
    if (asset && asset.placeholder && asset.dataUri) map.set(String(asset.placeholder), String(asset.dataUri));
  }
  return map;
}

function resolveClaudeHtmlInput(input) {
  const providedHtml = typeof input?.html === "string" ? input.html : "";
  const preparedEditHtml = typeof input?.editHtml === "string" && input.editHtml.trim() ? String(input.editHtml) : "";
  const preparedAssetMap = rawHtmlAssetsToMapForClaude(input?.assets);
  if (preparedEditHtml) {
    const validation = validateAssetPlaceholdersForClaude(preparedEditHtml, preparedAssetMap, { allowMissing: false });
    if (!validation.ok) {
      if (providedHtml) return { html: providedHtml, editHtml: "", assetMap: new Map(), prepared: false, fallbackReason: validation.reason };
      throw new Error(`客户端 HTML 资源状态无效：${validation.reason}`);
    }
    const reconstructed = expandDataUrisForClaude(preparedEditHtml, preparedAssetMap);
    const expectedHash = typeof input?.htmlSha256 === "string" ? input.htmlSha256.trim().toLowerCase() : "";
    const actualHash = crypto.createHash("sha256").update(reconstructed).digest("hex");
    if (expectedHash && expectedHash !== actualHash) throw new Error("客户端 HTML 重建 hash 不一致，已拒绝 Claude 任务");
    if (providedHtml && providedHtml !== reconstructed) throw new Error("客户端完整 HTML 与资源占位状态不一致");
    return { html: reconstructed, editHtml: preparedEditHtml, assetMap: preparedAssetMap, prepared: true, actualHash };
  }
  if (!providedHtml) throw new Error("缺少 HTML");
  const expectedHash = typeof input?.htmlSha256 === "string" ? input.htmlSha256.trim().toLowerCase() : "";
  const actualHash = crypto.createHash("sha256").update(providedHtml).digest("hex");
  if (expectedHash && expectedHash !== actualHash) throw new Error("客户端 HTML hash 不一致，已拒绝 Claude 任务");
  return { html: providedHtml, editHtml: "", assetMap: new Map(), prepared: false, actualHash };
}

function mapToRawHtmlAssetsForClaude(map) {
  return Array.from(map, ([placeholder, dataUri]) => ({ placeholder, dataUri }));
}

function createRawHtmlStateForClaude(previewHtml) {
  const { compact, map } = compactDataUrisForClaude(previewHtml);
  const originalBytes = byteLength(previewHtml);
  const compactBytes = byteLength(compact);
  return {
    editHtml: compact,
    assets: mapToRawHtmlAssetsForClaude(map),
    assetCount: map.size,
    savedBytes: Math.max(0, originalBytes - compactBytes),
  };
}

function analyzeHtmlSizeForClaude(html, maxBytes) {
  const styleCompacted = compactLargeStyleBlocksForClaude(html);
  const { compact, map } = compactDataUrisForClaude(styleCompacted.compact);
  const originalBytes = byteLength(html);
  const compactBytes = byteLength(compact);
  return {
    compact,
    map,
    styleMap: styleCompacted.map,
    info: {
      originalChars: String(html || "").length,
      originalBytes,
      compactChars: String(compact || "").length,
      compactBytes,
      assetCount: map.size,
      styleBlockCount: styleCompacted.map.size,
      styleSavedBytes: Math.max(0, byteLength(html) - byteLength(styleCompacted.compact)),
      savedBytes: Math.max(0, originalBytes - compactBytes),
      fullpageEditThresholdBytes: FULLPAGE_EDIT_THRESHOLD_BYTES,
      claudeMaxBytes: maxBytes,
      canFullpageEdit: compactBytes < FULLPAGE_EDIT_THRESHOLD_BYTES,
      shouldUseClaude: compactBytes >= FULLPAGE_EDIT_THRESHOLD_BYTES,
      tooLargeForClaude: compactBytes > maxBytes,
    },
  };
}

function analyzePreparedHtmlSizeForClaude(previewHtml, editHtml, assetMap, maxBytes, opts = {}) {
  const styleCompacted = opts.compactStyles === false
    ? { compact: String(editHtml || ""), map: new Map() }
    : compactLargeStyleBlocksForClaude(editHtml);
  const originalBytes = byteLength(previewHtml);
  const compactBytes = byteLength(styleCompacted.compact);
  return {
    compact: styleCompacted.compact,
    // editHtml 已经包含资源占位符；这里不能把现有 assetMap 当成本轮新压缩 map
    // 提前展开，否则完整页结果会在最终 baseAssetMap 校验时被误判为占位符丢失。
    map: new Map(),
    styleMap: styleCompacted.map,
    info: {
      originalChars: String(previewHtml || "").length,
      originalBytes,
      compactChars: String(styleCompacted.compact || "").length,
      compactBytes,
      assetCount: assetMap.size,
      styleBlockCount: styleCompacted.map.size,
      styleSavedBytes: Math.max(0, byteLength(editHtml) - byteLength(styleCompacted.compact)),
      savedBytes: Math.max(0, originalBytes - compactBytes),
      fullpageEditThresholdBytes: FULLPAGE_EDIT_THRESHOLD_BYTES,
      claudeMaxBytes: maxBytes,
      canFullpageEdit: compactBytes < FULLPAGE_EDIT_THRESHOLD_BYTES,
      shouldUseClaude: compactBytes >= FULLPAGE_EDIT_THRESHOLD_BYTES,
      tooLargeForClaude: compactBytes > maxBytes,
    },
  };
}

module.exports = {
  analyzeHtmlSizeForClaude,
  analyzePreparedHtmlSizeForClaude,
  analyzeScopedClaudeSafety,
  applyScopedClaudeResult,
  buildTaskRelevantProjectionForClaude,
  buildScopedCompletionChecklist,
  buildClaudeFocusSection,
  buildRelevantHtmlSnippets,
  compactDataUrisForClaude,
  compactLargeStyleBlocksForClaude,
  createRawHtmlStateForClaude,
  diffStats,
  extractClaudeAlreadySatisfied,
  extractClaudeClarification,
  expandDataUrisForClaude,
  expandImmutableRegionsForClaude,
  expandLargeStyleBlocksForClaude,
  extractInteractionSnippetTerms,
  extractSnippetTerms,
  mapToRawHtmlAssetsForClaude,
  prepareScopedClaudeJob,
  rawHtmlAssetsToMapForClaude,
  resolveClaudeHtmlInput,
  formatScopedCompletionChecklist,
  guardDeletedIdScriptRefs,
  hasInteractionDelta,
  isTrivialNoOp,
  looksRewritten,
  tryApplyScopedStatusDotPatch,
  uniqueTerms,
  validateAssetPlaceholdersForClaude,
  validateClaudeHtml,
  validateImmutablePlaceholdersForClaude,
  validateScopedCompletion,
  validateStylePlaceholdersForClaude,
};
