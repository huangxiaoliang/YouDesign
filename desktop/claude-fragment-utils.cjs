const crypto = require("node:crypto");
const { byteLength } = require("./desktop-utils.cjs");
const { introducedPrototypeNavigation, unsafePrototypeNavigation } = require("./prototype-navigation-core.cjs");

const MAX_FRAGMENT_COUNT = 8;
const MAX_FRAGMENT_TOTAL_BYTES = 320 * 1024;
const MAX_PRIMARY_HTML_BYTES = 192 * 1024;
const MAX_DEPENDENT_HTML_BYTES = 64 * 1024;
const MAX_CSS_TOTAL_BYTES = 48 * 1024;
const MAX_JS_TOTAL_BYTES = 96 * 1024;
const MAX_DATA_FRAGMENT_BYTES = 32 * 1024;
const MAX_FRAGMENT_GROWTH_RATIO = 3;
const MAX_COMPOSITE_TABLE_REGION_BYTES = 256 * 1024;
const PREVIEW_GUARD_ID = "__yd_preview_navigation_guard";
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const GLOBAL_EDIT_RE = /整体布局|全局布局|响应式|自适应|媒体查询|断点|主题|换肤|主色|整体配色|全局配色|色调|暗色模式|深色模式|浅色模式|整体样式|全局样式|整体视觉|批量/i;
const VISUAL_EDIT_RE = /颜色|色值|背景|字体|字号|字重|间距|边距|内边距|外边距|圆角|边框|阴影|透明度|宽度|高度|对齐|悬停|样式|视觉|hover|padding|margin|color|background|font|border|shadow|radius|opacity|width|height|gap/i;
const INTERACTIVE_EDIT_RE = /点击|交互|打开|关闭|展开|收起|切换|下钻|提交|触发|联动|可操作|新增.{0,8}(?:抽屉|弹窗|弹层|modal|drawer|dialog|popup)|添加.{0,8}(?:点击|交互)/i;
const DATA_EDIT_RE = /数据源|脚本数据|动态|刷新后|持久|选项|列表数据|默认值|字段值|文案数据|data/i;
const OVERLAY_RE = /drawer|modal|dialog|popup|抽屉|弹窗|弹层/i;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseAttributes(openTag) {
  const attrs = {};
  const start = String(openTag || "").replace(/^<\/?[\w:-]+/, "").replace(/\/?>\s*$/, "");
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of start.matchAll(re)) {
    attrs[match[1].toLowerCase()] = String(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function findTagEnd(source, start) {
  let quote = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote && source[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ">") return index + 1;
  }
  return -1;
}

function scanHtmlElements(html) {
  const source = String(html || "");
  const lower = source.toLowerCase();
  const elements = [];
  const stack = [];
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf("<", index);
    if (start < 0) break;
    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (/^<!|^<\?/.test(source.slice(start, start + 3))) {
      const end = findTagEnd(source, start);
      index = end < 0 ? source.length : end;
      continue;
    }
    const end = findTagEnd(source, start);
    if (end < 0) break;
    const raw = source.slice(start, end);
    const closing = /^<\s*\//.test(raw);
    const name = /^<\s*\/?\s*([a-z][\w:-]*)/i.exec(raw)?.[1]?.toLowerCase();
    if (!name) {
      index = end;
      continue;
    }
    if (closing) {
      for (let pos = stack.length - 1; pos >= 0; pos -= 1) {
        if (stack[pos].tag !== name) continue;
        const node = stack[pos];
        node.closeStart = start;
        node.end = end;
        stack.splice(pos);
        break;
      }
      index = end;
      continue;
    }
    const node = {
      tag: name,
      attrs: parseAttributes(raw),
      start,
      openEnd: end,
      closeStart: end,
      end,
      parent: stack.length ? stack[stack.length - 1] : null,
      rawOpen: raw,
    };
    elements.push(node);
    const selfClosing = /\/\s*>$/.test(raw) || VOID_TAGS.has(name);
    if (!selfClosing) stack.push(node);
    if (name === "script" || name === "style") {
      const closeStart = lower.indexOf(`</${name}`, end);
      if (closeStart >= 0) {
        const closeEnd = findTagEnd(source, closeStart);
        node.closeStart = closeStart;
        node.end = closeEnd < 0 ? closeStart + name.length + 3 : closeEnd;
        const stackIndex = stack.lastIndexOf(node);
        if (stackIndex >= 0) stack.splice(stackIndex, 1);
        index = node.end;
        continue;
      }
    }
    index = end;
  }
  return elements.filter((node) => node.end > node.openEnd || VOID_TAGS.has(node.tag));
}

function normalizeFocus(focus, baseHtml) {
  if (!focus || typeof focus !== "object" || typeof focus.scopeHtml !== "string") return null;
  const source = String(baseHtml || "");
  let start = Math.trunc(Number(focus.scopeStart));
  let end = Math.trunc(Number(focus.scopeEnd));
  const content = focus.scopeHtml;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > source.length) return null;
  if (source.slice(start, end) !== content) {
    const exact = source.indexOf(content);
    if (exact < 0 || source.indexOf(content, exact + content.length) >= 0) return null;
    start = exact;
    end = exact + content.length;
  }
  return {
    source: focus.source === "annotation" ? "annotation" : "auto-locate",
    plan: String(focus.plan || ""),
    targetHtml: String(focus.targetHtml || ""),
    targetOffset: Number.isFinite(Number(focus.targetOffset)) ? Math.trunc(Number(focus.targetOffset)) : undefined,
    scopeTag: String(focus.scopeTag || "").toLowerCase(),
    scopeReason: String(focus.scopeReason || ""),
    scopeStart: start,
    scopeEnd: end,
    scopeHtml: content,
  };
}

function planFlagIsYes(plan, name) {
  return new RegExp(`(?:^|[；;\\s])${escapeRegex(name)}\\s*=\\s*yes(?=$|[；;\\s])`, "i").test(String(plan || ""));
}

function rootDescriptor(html) {
  const node = scanHtmlElements(html)[0];
  if (!node) return { tag: "", id: "", classes: [] };
  return {
    tag: node.tag,
    id: node.attrs.id || "",
    classes: String(node.attrs.class || "").split(/\s+/).filter(Boolean),
  };
}

function stableSelectorForNode(node) {
  if (node.attrs.id) return `#${node.attrs.id}`;
  const classes = String(node.attrs.class || "").split(/\s+/).filter(Boolean);
  if (classes.length) return `${node.tag}.${classes[0]}`;
  const dataAttr = Object.keys(node.attrs).find((name) => name.startsWith("data-") && node.attrs[name]);
  if (dataAttr) return `${node.tag}[${dataAttr}="${node.attrs[dataAttr]}"]`;
  return `${node.tag}@${node.start}`;
}

function fragmentId(type, start, content) {
  return `frag-${type}-${start}-${sha256(content).slice(0, 8)}`;
}

function createFragment(input) {
  const content = String(input.content ?? "");
  const extension = input.type === "html" ? "html" : input.type;
  const id = fragmentId(input.type, input.start, content);
  const editable = Boolean(input.editable);
  return {
    id,
    type: input.type,
    role: input.role,
    operation: input.operation || "replace",
    start: input.start,
    end: input.end,
    selector: input.selector || "",
    contextPath: input.contextPath || "",
    originalHash: sha256(content),
    editable,
    required: input.required !== false,
    file: `${editable ? "fragments" : "context"}/${id}.${extension}`,
    content,
    maxOutputBytes: input.maxOutputBytes || Math.max(4096, Math.min(192 * 1024, byteLength(content) * MAX_FRAGMENT_GROWTH_RATIO + 4096)),
    wrapper: input.wrapper || "",
    anchorBeforeHash: input.anchorBeforeHash || "",
    anchorAfterHash: input.anchorAfterHash || "",
    expectedRoot: input.expectedRoot,
    root: input.type === "html" && input.operation !== "insert" ? rootDescriptor(content) : undefined,
  };
}

function intervalCovered(start, end, fragments) {
  return fragments.some((fragment) => fragment.operation === "replace" && start >= fragment.start && end <= fragment.end);
}

function intervalsOverlap(a, b) {
  if (a.operation === "insert" || b.operation === "insert") return false;
  return a.start < b.end && b.start < a.end;
}

function extractReferenceSelectors(html) {
  const ids = [];
  const classes = [];
  const unsupported = [];
  for (const node of scanHtmlElements(html)) {
    const attrs = node.attrs;
    if (attrs.for) ids.push(attrs.for.replace(/^#/, ""));
    if (attrs["aria-controls"]) ids.push(...attrs["aria-controls"].split(/\s+/).map((value) => value.replace(/^#/, "")));
    for (const name of ["href", "data-target", "data-bs-target"]) {
      const value = String(attrs[name] || "").trim();
      if (!value || value === "#" || /^javascript:/i.test(value)) continue;
      if (value.startsWith("#")) ids.push(value.slice(1));
      else if (name.includes("target") && /^\.[\w-]+$/.test(value)) classes.push(value.slice(1));
      else if (name.includes("target") && /^[A-Za-z][\w:.-]*$/.test(value)) ids.push(value);
      else if (name.includes("target")) unsupported.push(value);
    }
  }
  return { ids: [...new Set(ids.filter(Boolean))], classes: [...new Set(classes.filter(Boolean))], unsupported };
}

function collectSignatures(html) {
  const signatures = { ids: new Set(), classes: new Set(), dataAttrs: new Set(), dataValues: new Set(), tags: new Set() };
  for (const node of scanHtmlElements(html)) {
    if (["html", "head", "body", "main", "style", "script"].includes(node.tag)) continue;
    signatures.tags.add(node.tag);
    if (node.attrs.id) signatures.ids.add(node.attrs.id);
    for (const className of String(node.attrs.class || "").split(/\s+/).filter(Boolean)) signatures.classes.add(className);
    for (const [name, value] of Object.entries(node.attrs)) {
      if (!name.startsWith("data-")) continue;
      signatures.dataAttrs.add(name);
      if (String(value).length >= 2) signatures.dataValues.add(String(value));
    }
  }
  return signatures;
}

function mergeSignatures(target, source) {
  for (const key of Object.keys(target)) for (const value of source[key]) target[key].add(value);
  return target;
}

function selectorMatchesSignatures(selector, signatures) {
  const source = String(selector || "");
  for (const id of signatures.ids) if (new RegExp(`#${escapeRegex(id)}(?![\\w-])`).test(source)) return true;
  for (const className of signatures.classes) if (new RegExp(`\\.${escapeRegex(className)}(?![\\w-])`).test(source)) return true;
  for (const attr of signatures.dataAttrs) if (new RegExp(`\\[${escapeRegex(attr)}(?:[\\s=\\]])`, "i").test(source)) return true;
  for (const tag of signatures.tags) if (new RegExp(`(?:^|[\\s>+~,(])${escapeRegex(tag)}(?=[\\s.#[:>,+~)]|$)`, "i").test(source)) return true;
  return false;
}

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  let quote = "";
  let comment = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (comment) {
      if (char === "*" && next === "/") {
        comment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === quote && source[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "/" && next === "*") {
      comment = true;
      index += 1;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

function scanCssRules(css, baseOffset = 0, context = []) {
  const rules = [];
  const scanBlock = (from, to, path) => {
    let statementStart = from;
    let quote = "";
    let comment = false;
    for (let index = from; index < to; index += 1) {
      const char = css[index];
      const next = css[index + 1];
      if (comment) {
        if (char === "*" && next === "/") {
          comment = false;
          index += 1;
        }
        continue;
      }
      if (quote) {
        if (char === quote && css[index - 1] !== "\\") quote = "";
        continue;
      }
      if (char === "/" && next === "*") {
        comment = true;
        index += 1;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === ";") {
        statementStart = index + 1;
        continue;
      }
      if (char !== "{") continue;
      const close = findMatchingBrace(css, index);
      if (close < 0 || close >= to) return false;
      let rawStart = statementStart;
      while (rawStart < index && /\s/.test(css[rawStart])) rawStart += 1;
      const prelude = css.slice(rawStart, index).trim();
      if (/^@(?:media|supports|container|layer)\b/i.test(prelude)) {
        if (!scanBlock(index + 1, close, [...path, prelude])) return false;
      } else if (!/^@(?:keyframes|-\w+-keyframes|font-face|page|property)\b/i.test(prelude) && prelude) {
        rules.push({
          selector: prelude,
          start: baseOffset + rawStart,
          end: baseOffset + close + 1,
          localStart: rawStart,
          localEnd: close + 1,
          contextPath: path.join(" > "),
          content: css.slice(rawStart, close + 1),
        });
      }
      index = close;
      statementStart = close + 1;
    }
    return true;
  };
  return { ok: scanBlock(0, css.length, context), rules };
}

function findRawBlocks(html, tag) {
  const source = String(html || "");
  const lower = source.toLowerCase();
  const blocks = [];
  const re = new RegExp(`<${tag}\\b`, "gi");
  for (const match of source.matchAll(re)) {
    const openStart = match.index || 0;
    const contentStart = findTagEnd(source, openStart);
    if (contentStart < 0) continue;
    const closeStart = lower.indexOf(`</${tag}`, contentStart);
    if (closeStart < 0) continue;
    const end = findTagEnd(source, closeStart);
    blocks.push({
      openStart,
      contentStart,
      closeStart,
      end: end < 0 ? closeStart + tag.length + 3 : end,
      attrs: parseAttributes(source.slice(openStart, contentStart)),
      content: source.slice(contentStart, closeStart),
    });
  }
  return blocks;
}

function balancedSource(source, pairs = { "{": "}", "(": ")", "[": "]" }) {
  const stack = [];
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
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
      if (char === quote && source[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (pairs[char]) stack.push(pairs[char]);
    else if (Object.values(pairs).includes(char) && stack.pop() !== char) return false;
  }
  return !quote && !blockComment && stack.length === 0;
}

function stripLeadingJsTrivia(value) {
  const source = String(value || "");
  let index = 0;
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (source[index] === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      if (close < 0) return source.slice(index);
      index = close + 2;
      continue;
    }
    break;
  }
  return source.slice(index);
}

function scanJsTopLevelStatements(code) {
  const statements = [];
  let start = 0;
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  const push = (end) => {
    let from = start;
    while (from < end && /\s/.test(code[from])) from += 1;
    if (from < end) statements.push({ start: from, end, content: code.slice(from, end) });
    start = end;
  };
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    const next = code[index + 1];
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
      if (char === quote && code[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") braces += 1;
    else if (char === "}") {
      braces -= 1;
      const statementCode = stripLeadingJsTrivia(code.slice(start, index + 1));
      if (braces === 0 && parens === 0 && brackets === 0 && /^(?:(?:async\s+)?function|class)\b/.test(statementCode)) {
        push(index + 1);
      }
    } else if (char === "(") parens += 1;
    else if (char === ")") parens -= 1;
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets -= 1;
    else if (char === ";" && braces === 0 && parens === 0 && brackets === 0) push(index + 1);
    if (braces < 0 || parens < 0 || brackets < 0) return { ok: false, statements: [] };
  }
  if (start < code.length) push(code.length);
  return { ok: balancedSource(code), statements };
}

function definitionNames(statement) {
  const names = [];
  const source = stripLeadingJsTrivia(statement);
  const functionName = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(source)?.[1];
  if (functionName) names.push(functionName);
  const variable = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(source)?.[1];
  if (variable) names.push(variable);
  return names;
}

function inlineHandlerNames(html) {
  const names = [];
  for (const match of String(html || "").matchAll(/\bon[a-z]+\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const value = match[1] || match[2] || match[3] || "";
    for (const call of value.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) names.push(call[1]);
  }
  return [...new Set(names)];
}

function statementReferencesSignatures(statement, signatures, visibleText) {
  for (const id of signatures.ids) if (statement.includes(id)) return true;
  for (const className of signatures.classes) if (statement.includes(`.${className}`) || statement.includes(className)) return true;
  for (const attr of signatures.dataAttrs) if (statement.includes(attr) || statement.includes(attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()))) return true;
  for (const value of signatures.dataValues) if (statement.includes(value)) return true;
  return Boolean(visibleText && visibleText.length <= 40 && statement.includes(visibleText));
}

function visibleTextOf(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&lt;|&gt;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addInsertionFragment(source, fragments, type, position, selector, wrapper) {
  if (!Number.isFinite(position) || position < 0 || position > source.length) return null;
  const before = source.slice(Math.max(0, position - 96), position);
  const after = source.slice(position, Math.min(source.length, position + 96));
  const fragment = createFragment({
    type,
    role: `${type}-insertion`,
    operation: "insert",
    start: position,
    end: position,
    selector,
    content: "",
    editable: true,
    wrapper,
    anchorBeforeHash: sha256(before),
    anchorAfterHash: sha256(after),
    maxOutputBytes: type === "css" ? 24 * 1024 : 32 * 1024,
  });
  fragments.push(fragment);
  return fragment;
}

function duplicateIdsIntroduced(before, after) {
  const counts = (source) => {
    const map = new Map();
    for (const match of String(source || "").matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)) {
      map.set(match[1], (map.get(match[1]) || 0) + 1);
    }
    return map;
  };
  const beforeCounts = counts(before);
  const afterCounts = counts(after);
  return [...afterCounts].filter(([id, count]) => count > 1 && count > (beforeCounts.get(id) || 0)).map(([id]) => id);
}

function danglingDeletedIdReferences(before, after) {
  const ids = (source) => new Set(Array.from(String(source || "").matchAll(/\bid\s*=\s*["']([^"']+)["']/gi), (match) => match[1]));
  const beforeIds = ids(before);
  const afterIds = ids(after);
  const deleted = [...beforeIds].filter((id) => !afterIds.has(id));
  if (!deleted.length) return [];
  const scripts = findRawBlocks(after, "script").map((block) => block.content).join("\n");
  return deleted.filter((id) => {
    const escaped = escapeRegex(id);
    return new RegExp(`getElementById\\s*\\(\\s*["']${escaped}["']|querySelector(?:All)?\\s*\\(\\s*["']#${escaped}["']`).test(scripts);
  });
}

function interactionSurfaceSatisfied(html, interaction) {
  const description = `${interaction.trigger || ""} ${interaction.result || ""} ${interaction.proof || ""}`;
  const hasHandler = /\bon(?:click|change|input|submit)\s*=|addEventListener\s*\(\s*["'`](?:click|change|input|submit)/i.test(html);
  const hasVisibleChange = /classList\.(?:add|remove|toggle)|\.hidden\s*=|\.style\.[\w-]+\s*=|\.(?:innerHTML|textContent)\s*=|\.showModal\s*\(|aria-expanded/i.test(html);
  if (!hasHandler || !hasVisibleChange) return false;
  if (/抽屉|drawer/i.test(description) && !/drawer|抽屉|side[-_ ]?panel/i.test(html)) return false;
  if (/弹窗|对话框|modal|dialog/i.test(description) && !/modal|dialog|弹窗|role\s*=\s*["']dialog/i.test(html)) return false;
  if (/页签|tab|切换/i.test(description) && !/tab[-_ ]|role\s*=\s*["']tab|页签/i.test(html)) return false;
  if (/展开|收起|expand|collapse/i.test(description) && !/expand|collapse|展开|收起|aria-expanded/i.test(html)) return false;
  return !/\b(?:alert|console\.log)\s*\(/i.test(html) || hasVisibleChange;
}

function contractSignals(html, contract) {
  const plain = visibleTextOf(html).toLowerCase();
  const mustHave = (Array.isArray(contract?.mustHave) ? contract.mustHave : []).map((item) => ({
    item: String(item),
    satisfied: plain.includes(String(item).toLowerCase()),
  }));
  const interactions = (Array.isArray(contract?.interactions) ? contract.interactions : [])
    .filter((item) => item?.priority === "must")
    .map((item) => ({ item, satisfied: interactionSurfaceSatisfied(html, item) }));
  return { mustHave, interactions };
}

function instructionMatchesInteraction(instruction, interaction) {
  const source = String(instruction || "").toLowerCase();
  const words = `${interaction.trigger || ""} ${interaction.result || ""} ${interaction.proof || ""}`.match(/[\p{Script=Han}A-Za-z0-9_-]{2,}/gu) || [];
  return words.some((word) => source.includes(word.toLowerCase()) || word.toLowerCase().includes(source));
}

function validatePrototypeContractRegression(before, after, contract, instruction, opts = {}) {
  if (!contract) return { ok: true };
  const baseline = contractSignals(before, contract);
  const candidate = contractSignals(after, contract);
  for (let index = 0; index < baseline.mustHave.length; index += 1) {
    if (baseline.mustHave[index].satisfied && !candidate.mustHave[index]?.satisfied) {
      return { ok: false, reason: `修改破坏了 Prototype Contract 必备项：${baseline.mustHave[index].item}` };
    }
  }
  for (let index = 0; index < baseline.interactions.length; index += 1) {
    const wasSatisfied = baseline.interactions[index].satisfied;
    const nowSatisfied = candidate.interactions[index]?.satisfied;
    const relevant = opts.interactiveEdit && instructionMatchesInteraction(instruction, baseline.interactions[index].item);
    if ((wasSatisfied || relevant) && !nowSatisfied) {
      return { ok: false, reason: `修改未满足 Prototype Contract 必须交互：${baseline.interactions[index].item.trigger}` };
    }
  }
  return { ok: true };
}

function isCompositeFilterTableInstruction(instruction) {
  const source = String(instruction || "").replace(/\s+/g, "");
  const hasFilterTarget = /筛选|查询条件|搜索条件|筛选项/.test(source) && /输入框|输入项|字段|条件/.test(source);
  const hasTableColumnTarget =
    /(?:列表|表格).{0,100}(?:新增|添加|增加|插入|加).{0,50}(?:一?列|字段)/.test(source) ||
    /(?:新增|添加|增加|插入|加).{0,50}(?:一?列|字段).{0,100}(?:列表|表格)/.test(source);
  return hasFilterTarget && hasTableColumnTarget;
}

function nearestAncestor(node, predicate) {
  for (let current = node; current; current = current.parent) if (predicate(current)) return current;
  return null;
}

function nodeClasses(node) {
  return String(node?.attrs?.class || "").split(/\s+/).filter(Boolean);
}

function nodeVisibleText(source, node) {
  if (!node) return "";
  return visibleTextOf(source.slice(node.openEnd, node.closeStart));
}

function nearestTable(node) {
  return nearestAncestor(node, (candidate) => candidate.tag === "table");
}

function nodeContains(parent, child) {
  return Boolean(parent && child && parent.start <= child.start && child.end <= parent.end);
}

function lowestCommonAncestor(left, right) {
  if (!left || !right) return null;
  const rightAncestors = new Set();
  for (let current = right; current; current = current.parent) rightAncestors.add(current);
  for (let current = left; current; current = current.parent) if (rightAncestors.has(current)) return current;
  return null;
}

function logicalCellsInRow(source, row, tagName) {
  if (!row) return 0;
  let count = 0;
  const re = new RegExp(`<${tagName}\\b([^>]*)>`, "gi");
  for (const match of source.slice(row.openEnd, row.closeStart).matchAll(re)) {
    const colspan = Number(/\bcolspan\s*=\s*["']?(\d+)/i.exec(match[1] || "")?.[1] || 1);
    count += Number.isFinite(colspan) && colspan > 0 ? colspan : 1;
  }
  return count;
}

function fragmentPlanAcceptance(source, instruction, opts) {
  const contract = opts.prototypeContract || null;
  const interactiveEdit = Boolean(opts.interactiveEdit) || INTERACTIVE_EDIT_RE.test(String(instruction || ""));
  return {
    navigationBaseline: unsafePrototypeNavigation(source),
    prototypeContractHash: contract ? sha256(JSON.stringify(contract)) : "",
    prototypeContract: contract,
    contractBaseline: contract ? contractSignals(source, contract) : null,
    instruction: String(instruction || ""),
    interactiveEdit,
  };
}

function prepareCompositeFilterTableFragmentJob(baseHtml, focus, instruction, opts = {}) {
  const source = String(baseHtml || "");
  const fail = (reason) => ({ multiFragment: false, reason, reasons: [reason], plan: null });
  if (!isCompositeFilterTableInstruction(instruction)) return fail("不是筛选区与表格列复合任务");
  if (source.includes(PREVIEW_GUARD_ID)) return fail("输入包含预览期导航守卫");
  const elements = scanHtmlElements(source);
  const instructionText = String(instruction || "");

  const labelCandidates = elements
    .filter((node) => node.tag === "label")
    .map((node) => ({ node, text: nodeVisibleText(source, node) }))
    .filter((item) => item.text.length >= 2 && item.text.length <= 40 && instructionText.includes(item.text))
    .sort((left, right) => {
      const leftScore = new RegExp(`${escapeRegex(left.text)}.{0,12}(?:筛选|后面|之后|后方)`).test(instructionText) ? 1 : 0;
      const rightScore = new RegExp(`${escapeRegex(right.text)}.{0,12}(?:筛选|后面|之后|后方)`).test(instructionText) ? 1 : 0;
      return rightScore - leftScore || right.text.length - left.text.length;
    });
  if (!labelCandidates.length) return fail("无法定位筛选项邻接标签");
  const bestLabelText = labelCandidates[0].text;
  const bestLabels = labelCandidates.filter((item) => item.text === bestLabelText);
  if (bestLabels.length !== 1) return fail(`筛选项标签“${bestLabelText}”命中 ${bestLabels.length} 处`);
  const filterLabel = bestLabels[0].node;
  const filterRoot = nearestAncestor(filterLabel, (node) => {
    const classes = nodeClasses(node);
    return classes.includes("ssp-item-wrapper") || classes.some((name) => /(?:^|-)form-item-wrapper$/.test(name));
  }) || nearestAncestor(filterLabel, (node) => node.tag === "div" && nodeClasses(node).some((name) => /form-item/.test(name)));
  if (!filterRoot) return fail("无法提取筛选项容器");
  const filterContent = source.slice(filterRoot.start, filterRoot.end);
  if (byteLength(filterContent) > MAX_DEPENDENT_HTML_BYTES) return fail("筛选项容器超过多片段上限");

  const headerCandidates = elements
    .filter((node) => node.tag === "th")
    .map((node) => ({ node, text: nodeVisibleText(source, node) }))
    .filter((item) => item.text.length >= 2 && item.text.length <= 40 && instructionText.includes(item.text))
    .sort((left, right) => {
      const leftScore = new RegExp(`(?:列表|表格).{0,80}${escapeRegex(left.text)}|${escapeRegex(left.text)}.{0,20}(?:后面|之后|后方|右侧)`).test(instructionText) ? 1 : 0;
      const rightScore = new RegExp(`(?:列表|表格).{0,80}${escapeRegex(right.text)}|${escapeRegex(right.text)}.{0,20}(?:后面|之后|后方|右侧)`).test(instructionText) ? 1 : 0;
      return rightScore - leftScore || right.text.length - left.text.length;
    });
  if (!headerCandidates.length) return fail("无法定位目标表头邻接列");
  const bestHeaderText = headerCandidates[0].text;
  const bestHeaders = headerCandidates.filter((item) => item.text === bestHeaderText);
  if (bestHeaders.length !== 1) return fail(`目标表头“${bestHeaderText}”命中 ${bestHeaders.length} 处`);
  const targetHeader = bestHeaders[0].node;
  const headerTable = nearestTable(targetHeader);
  if (!headerTable) return fail("目标表头不在 table 内");
  const headerRow = nearestAncestor(targetHeader, (node) => node.tag === "tr");
  const headerCells = elements.filter((node) => node.tag === "th" && headerRow && nodeContains(headerRow, node));
  const headerIndex = headerCells.findIndex((node) => node === targetHeader);
  const headerCount = logicalCellsInRow(source, headerRow, "th");
  if (headerIndex < 0 || !headerCount) return fail("无法计算目标表头列位置");

  const tableNodes = elements.filter((node) => node.tag === "table");
  let bodyTable = /<tbody\b/i.test(source.slice(headerTable.openEnd, headerTable.closeStart)) ? headerTable : null;
  if (!bodyTable) {
    const bodyCandidates = tableNodes
      .filter((node) => node.start >= headerTable.end && node.start - headerTable.end <= 160 * 1024)
      .map((node) => {
        const tbody = elements.find((candidate) => candidate.tag === "tbody" && nearestTable(candidate) === node);
        const firstRow = tbody ? elements.find((candidate) => candidate.tag === "tr" && nodeContains(tbody, candidate)) : null;
        return { node, tbody, firstRow, cellCount: logicalCellsInRow(source, firstRow, "td") };
      })
      .filter((item) => item.tbody && item.firstRow && item.cellCount === headerCount)
      .sort((left, right) => left.node.start - right.node.start);
    bodyTable = bodyCandidates[0]?.node || null;
  }
  if (!bodyTable) return fail("无法定位与目标表头对齐的表体 table");
  const tbody = elements.find((node) => node.tag === "tbody" && nearestTable(node) === bodyTable);
  const bodyRows = tbody ? elements.filter((node) => node.tag === "tr" && nodeContains(tbody, node)) : [];
  if (!tbody || !bodyRows.length) return fail("目标表格没有可编辑表体行");
  const bodyCounts = bodyRows.map((row) => logicalCellsInRow(source, row, "td"));
  if (bodyCounts.some((count) => count !== headerCount)) return fail("目标表格各行列数不一致");

  const tableRoot = headerTable === bodyTable ? headerTable : lowestCommonAncestor(headerTable, bodyTable);
  if (!tableRoot || ["html", "head", "body", "main"].includes(tableRoot.tag)) return fail("表头与表体缺少安全的共同容器");
  const tableContent = source.slice(tableRoot.start, tableRoot.end);
  if (byteLength(tableContent) > MAX_COMPOSITE_TABLE_REGION_BYTES) return fail("目标表格事务区域超过多片段上限");
  if (nodeContains(tableRoot, filterRoot) || nodeContains(filterRoot, tableRoot)) return fail("筛选区与表格事务区域发生重叠");

  const filterAnchorFragment = createFragment({
    type: "html",
    role: "filter-anchor-context",
    start: filterRoot.start,
    end: filterRoot.end,
    selector: stableSelectorForNode(filterRoot),
    content: filterContent,
    editable: false,
    required: false,
    maxOutputBytes: Math.min(MAX_DEPENDENT_HTML_BYTES, Math.max(12 * 1024, byteLength(filterContent) * 4)),
  });
  const filterFragment = createFragment({
    type: "html",
    role: "filter-control-insert",
    operation: "insert",
    start: filterRoot.end,
    end: filterRoot.end,
    selector: `${stableSelectorForNode(filterRoot)}::after`,
    content: "",
    editable: true,
    maxOutputBytes: 12 * 1024,
    anchorBeforeHash: sha256(source.slice(Math.max(0, filterRoot.end - 96), filterRoot.end)),
    anchorAfterHash: sha256(source.slice(filterRoot.end, Math.min(source.length, filterRoot.end + 96))),
    expectedRoot: {
      tag: filterRoot.tag,
      classes: nodeClasses(filterRoot),
    },
  });
  const tableFragment = createFragment({
    type: "html",
    role: "table-region",
    start: tableRoot.start,
    end: tableRoot.end,
    selector: stableSelectorForNode(tableRoot),
    content: tableContent,
    editable: true,
    maxOutputBytes: MAX_COMPOSITE_TABLE_REGION_BYTES,
  });
  if (intervalsOverlap(filterAnchorFragment, tableFragment) || intervalsOverlap(filterFragment, tableFragment)) {
    return fail("复合事务 fragment 发生重叠");
  }
  const fragments = [filterFragment, filterAnchorFragment, tableFragment];
  const totalBytes = fragments.reduce((sum, fragment) => sum + byteLength(fragment.content), 0);
  if (totalBytes > MAX_FRAGMENT_TOTAL_BYTES) return fail("复合事务 fragment 总量超过上限");
  const normalized = normalizeFocus(focus, source);
  const plan = {
    protocolVersion: 1,
    kind: "composite-filter-table",
    baseDocumentHash: sha256(source),
    sourceRepresentation: "raw-html-edit-state",
    primaryFragmentId: filterFragment.id,
    focus: normalized || {
      source: focus?.source === "annotation" ? "annotation" : "auto-locate",
      plan: String(focus?.plan || ""),
      targetHtml: String(focus?.targetHtml || ""),
    },
    fragments,
    dependencies: [
      { from: filterAnchorFragment.id, to: filterFragment.id, relation: "sibling-insertion-anchor", evidence: bestLabelText },
      { from: filterFragment.id, to: tableFragment.id, relation: "composite-filter-table", evidence: `${bestLabelText} -> ${bestHeaderText}` },
    ],
    taskHints: {
      filterAnchorText: bestLabelText,
      filterInsertFile: filterFragment.file,
      filterAnchorContextFile: filterAnchorFragment.file,
      filterRootTag: filterRoot.tag,
      filterRootClasses: nodeClasses(filterRoot),
      tableAnchorText: bestHeaderText,
      headerCellIndex: headerIndex,
      headerCellCount: headerCount,
      bodyRowCount: bodyRows.length,
      bodyCellCount: bodyCounts[0],
      splitHeaderBodyTables: headerTable !== bodyTable,
    },
    limits: {
      maxFragmentCount: MAX_FRAGMENT_COUNT,
      maxTotalBytes: MAX_FRAGMENT_TOTAL_BYTES,
    },
    acceptance: fragmentPlanAcceptance(source, instruction, opts),
    totalBytes,
  };
  return { multiFragment: true, reason: "", reasons: [], plan };
}

function prepareMultiFragmentClaudeJob(baseHtml, focus, instruction, opts = {}) {
  const source = String(baseHtml || "");
  if (isCompositeFilterTableInstruction(instruction)) {
    const composite = prepareCompositeFilterTableFragmentJob(source, focus, instruction, opts);
    if (composite.multiFragment) return composite;
    if (planFlagIsYes(focus?.plan, "batch") || planFlagIsYes(focus?.plan, "needsFullPage")) return composite;
  }
  const normalized = normalizeFocus(focus, source);
  const reasons = [];
  const fail = (reason) => ({ multiFragment: false, reason, reasons: [...reasons, reason], plan: null });
  if (!normalized) return fail("目标 scope 无效");
  if (source.includes(PREVIEW_GUARD_ID)) return fail("输入包含预览期导航守卫");
  if (planFlagIsYes(normalized.plan, "batch") || planFlagIsYes(normalized.plan, "needsFullPage")) return fail("编辑计划要求批量或整页处理");
  if (GLOBAL_EDIT_RE.test(String(instruction || ""))) return fail("全局布局、主题、响应式或批量任务不适合多片段");
  if (byteLength(normalized.scopeHtml) > MAX_PRIMARY_HTML_BYTES) return fail("主目标 HTML 超过多片段上限");

  const visualEdit = VISUAL_EDIT_RE.test(String(instruction || ""));
  const interactiveEdit = Boolean(opts.interactiveEdit) || INTERACTIVE_EDIT_RE.test(String(instruction || ""));
  const dataEdit = DATA_EDIT_RE.test(String(instruction || ""));
  const fragments = [
    createFragment({
      type: "html",
      role: "primary",
      start: normalized.scopeStart,
      end: normalized.scopeEnd,
      selector: normalized.scopeTag ? `${normalized.scopeTag}@${normalized.scopeStart}` : `html@${normalized.scopeStart}`,
      content: normalized.scopeHtml,
      editable: true,
      maxOutputBytes: MAX_PRIMARY_HTML_BYTES,
    }),
  ];
  const dependencies = [];
  const elements = scanHtmlElements(source);
  const refs = extractReferenceSelectors(normalized.scopeHtml);
  if (refs.unsupported.length) return fail(`目标包含无法唯一解析的引用：${refs.unsupported.slice(0, 2).join("、")}`);

  const addHtmlNode = (node, relation) => {
    if (!node || intervalCovered(node.start, node.end, fragments)) return null;
    const content = source.slice(node.start, node.end);
    if (byteLength(content) > MAX_DEPENDENT_HTML_BYTES) throw new Error("依赖 HTML 超过多片段上限");
    const fragment = createFragment({
      type: "html",
      role: OVERLAY_RE.test(`${node.attrs.id || ""} ${node.attrs.class || ""} ${node.attrs.role || ""}`) ? "overlay" : "html-dependency",
      start: node.start,
      end: node.end,
      selector: stableSelectorForNode(node),
      content,
      editable: interactiveEdit || /文案|标题|字段|内容|结构|新增|添加|删除|移除/.test(String(instruction || "")),
      maxOutputBytes: MAX_DEPENDENT_HTML_BYTES,
    });
    fragments.push(fragment);
    dependencies.push({ from: fragments[0].id, to: fragment.id, relation, evidence: fragment.selector });
    return fragment;
  };

  try {
    for (const id of refs.ids) {
      const matches = elements.filter((node) => node.attrs.id === id && !intervalCovered(node.start, node.end, fragments));
      if (matches.length > 1) return fail(`引用 #${id} 命中多个元素`);
      if (matches.length === 1) addHtmlNode(matches[0], "html-id-reference");
    }
    for (const className of refs.classes) {
      const matches = elements.filter(
        (node) => String(node.attrs.class || "").split(/\s+/).includes(className) && !intervalCovered(node.start, node.end, fragments)
      );
      if (matches.length > 1) return fail(`引用 .${className} 命中多个元素`);
      if (matches.length === 1) addHtmlNode(matches[0], "html-class-reference");
    }
    if (interactiveEdit && !fragments.some((fragment) => fragment.role === "overlay") && OVERLAY_RE.test(String(instruction || ""))) {
      const overlays = elements.filter(
        (node) =>
          !intervalCovered(node.start, node.end, fragments) &&
          OVERLAY_RE.test(`${node.attrs.id || ""} ${node.attrs.class || ""} ${node.attrs.role || ""}`)
      );
      if (overlays.length === 1) addHtmlNode(overlays[0], "interaction-overlay");
      else if (overlays.length > 1) return fail("drawer/modal 候选不唯一");
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const signatures = collectSignatures(normalized.scopeHtml);
  for (const fragment of fragments.slice(1)) if (fragment.type === "html") mergeSignatures(signatures, collectSignatures(fragment.content));

  let cssBytes = 0;
  let matchedCss = 0;
  const cssVariableNames = new Set();
  for (const block of findRawBlocks(source, "style")) {
    const scanned = scanCssRules(block.content, block.contentStart);
    if (!scanned.ok) return fail("相关 CSS 无法可靠解析");
    for (const rule of scanned.rules) {
      if (!selectorMatchesSignatures(rule.selector, signatures)) continue;
      if (intervalCovered(rule.start, rule.end, fragments)) continue;
      const fragment = createFragment({
        type: "css",
        role: "style",
        start: rule.start,
        end: rule.end,
        selector: rule.selector,
        contextPath: rule.contextPath,
        content: rule.content,
        editable: visualEdit,
        maxOutputBytes: 32 * 1024,
      });
      if (fragments.some((existing) => intervalsOverlap(existing, fragment))) return fail("CSS fragment 与其他片段重叠");
      fragments.push(fragment);
      dependencies.push({ from: fragments[0].id, to: fragment.id, relation: "css-selector", evidence: rule.selector });
      cssBytes += byteLength(rule.content);
      matchedCss += 1;
      for (const match of rule.content.matchAll(/var\(\s*(--[\w-]+)/g)) cssVariableNames.add(match[1]);
    }
  }
  if (cssVariableNames.size) {
    for (const block of findRawBlocks(source, "style")) {
      const scanned = scanCssRules(block.content, block.contentStart);
      for (const rule of scanned.rules) {
        if (![...cssVariableNames].some((name) => new RegExp(`${escapeRegex(name)}\\s*:`).test(rule.content))) continue;
        if (intervalCovered(rule.start, rule.end, fragments)) continue;
        const fragment = createFragment({
          type: "css",
          role: "css-variable-context",
          start: rule.start,
          end: rule.end,
          selector: rule.selector,
          contextPath: rule.contextPath,
          content: rule.content,
          editable: false,
          maxOutputBytes: 24 * 1024,
        });
        if (fragments.some((existing) => intervalsOverlap(existing, fragment))) continue;
        fragments.push(fragment);
        dependencies.push({ from: fragments[0].id, to: fragment.id, relation: "css-variable", evidence: [...cssVariableNames].join(", ") });
        cssBytes += byteLength(rule.content);
      }
    }
  }
  if (visualEdit && matchedCss === 0) {
    const styleBlocks = findRawBlocks(source, "style");
    const block = [...styleBlocks].reverse().find((candidate) => !intervalCovered(candidate.contentStart, candidate.closeStart, fragments));
    if (block) {
      const inserted = addInsertionFragment(source, fragments, "css", block.closeStart, "before </style>", "");
      if (inserted) dependencies.push({ from: fragments[0].id, to: inserted.id, relation: "css-insertion", evidence: "no matching rule" });
    } else {
      const headClose = source.toLowerCase().lastIndexOf("</head>");
      if (headClose >= 0) {
        const inserted = addInsertionFragment(source, fragments, "css", headClose, "before </head>", "style");
        if (inserted) dependencies.push({ from: fragments[0].id, to: inserted.id, relation: "css-insertion", evidence: "no style block" });
      }
    }
  }
  if (cssBytes > MAX_CSS_TOTAL_BYTES) return fail("相关 CSS 总量超过多片段上限");

  const handlerNames = new Set(inlineHandlerNames(normalized.scopeHtml));
  const visibleText = visibleTextOf(normalized.targetHtml || normalized.scopeHtml);
  let jsBytes = 0;
  let matchedJs = 0;
  for (const block of findRawBlocks(source, "script")) {
    if (block.attrs.src) continue;
    if (intervalCovered(block.contentStart, block.closeStart, fragments)) continue;
    const scanned = scanJsTopLevelStatements(block.content);
    if (!scanned.ok) {
      if (interactiveEdit && statementReferencesSignatures(block.content, signatures, visibleText)) return fail("相关 JS 无法可靠解析");
      continue;
    }
    const definitions = new Map();
    for (const statement of scanned.statements) {
      for (const name of definitionNames(statement.content)) definitions.set(name, statement);
    }
    const selected = new Set();
    for (const statement of scanned.statements) {
      const names = definitionNames(statement.content);
      if (names.some((name) => handlerNames.has(name))) selected.add(statement);
      if (
        /addEventListener\s*\(|\.on\s*\(|\.(?:onclick|onchange|oninput|onsubmit)\s*=/.test(statement.content) &&
        statementReferencesSignatures(statement.content, signatures, visibleText)
      ) {
        selected.add(statement);
      }
    }
    const rootText = [...selected].map((statement) => statement.content).join("\n");
    for (const [name, statement] of definitions) {
      if (new RegExp(`\\b${escapeRegex(name)}\\b`).test(rootText)) selected.add(statement);
    }
    const selectedText = [...selected].map((statement) => statement.content).join("\n");
    for (const [name, statement] of definitions) {
      if (selected.has(statement)) continue;
      const referenced = new RegExp(`\\b${escapeRegex(name)}\\b`).test(selectedText);
      const directCall = new RegExp(`\\b${escapeRegex(name)}\\s*\\(`).test(selectedText);
      if (referenced && (/^(?:const|let|var)\b/.test(stripLeadingJsTrivia(statement.content)) || directCall)) {
        selected.add(statement);
      }
    }
    for (const statement of [...selected].sort((a, b) => a.start - b.start)) {
      const role = /^(?:const|let|var)\b/.test(stripLeadingJsTrivia(statement.content))
        ? "data"
        : /addEventListener|\.on\s*\(/.test(statement.content)
          ? "event-listener"
          : "handler";
      if (role === "data" && byteLength(statement.content) > MAX_DATA_FRAGMENT_BYTES) return fail("相关脚本数据源超过多片段上限");
      const fragment = createFragment({
        type: "js",
        role,
        start: block.contentStart + statement.start,
        end: block.contentStart + statement.end,
        selector: definitionNames(statement.content)[0] || `script@${block.openStart}`,
        contextPath: block.attrs.type === "module" ? "script[type=module]" : "script",
        content: statement.content,
        editable: role === "data" ? dataEdit : interactiveEdit,
        maxOutputBytes: role === "data" ? MAX_DATA_FRAGMENT_BYTES : 48 * 1024,
      });
      if (fragments.some((existing) => intervalsOverlap(existing, fragment))) continue;
      fragments.push(fragment);
      dependencies.push({ from: fragments[0].id, to: fragment.id, relation: role, evidence: fragment.selector });
      jsBytes += byteLength(statement.content);
      matchedJs += 1;
    }
  }
  if (jsBytes > MAX_JS_TOTAL_BYTES) return fail("相关 JS 总量超过多片段上限");
  if (interactiveEdit && matchedJs === 0) {
    const bodyClose = source.toLowerCase().lastIndexOf("</body>");
    if (bodyClose >= 0) {
      const inserted = addInsertionFragment(source, fragments, "js", bodyClose, "before </body>", "script");
      if (inserted) dependencies.push({ from: fragments[0].id, to: inserted.id, relation: "js-insertion", evidence: "no matching handler" });
    }
  }

  if (fragments.length <= 1) return fail("没有提取到 scope 外的一跳依赖");
  if (fragments.length > MAX_FRAGMENT_COUNT) return fail(`fragment 数量超过上限 ${MAX_FRAGMENT_COUNT}`);
  for (let left = 0; left < fragments.length; left += 1) {
    for (let right = left + 1; right < fragments.length; right += 1) {
      if (intervalsOverlap(fragments[left], fragments[right])) return fail("fragment 之间存在重叠");
    }
  }
  const totalBytes = fragments.reduce((sum, fragment) => sum + byteLength(fragment.content), 0);
  if (totalBytes > MAX_FRAGMENT_TOTAL_BYTES) return fail("fragment 总量超过多片段上限");

  const plan = {
    protocolVersion: 1,
    baseDocumentHash: sha256(source),
    sourceRepresentation: "raw-html-edit-state",
    primaryFragmentId: fragments[0].id,
    focus: normalized,
    fragments,
    dependencies,
    limits: {
      maxFragmentCount: MAX_FRAGMENT_COUNT,
      maxTotalBytes: MAX_FRAGMENT_TOTAL_BYTES,
    },
    acceptance: fragmentPlanAcceptance(source, instruction, { ...opts, interactiveEdit }),
    totalBytes,
  };
  return { multiFragment: true, reason: "", reasons, plan };
}

function validateCssFragment(content) {
  if (!String(content || "").trim()) return { ok: false, reason: "CSS fragment 为空" };
  if (/<\/?style\b/i.test(content)) return { ok: false, reason: "CSS fragment 不能包含 style 标签" };
  if (/@import\b|url\(\s*["']?https?:/i.test(content)) return { ok: false, reason: "CSS fragment 不能新增外部资源" };
  const scanned = scanCssRules(String(content));
  return scanned.ok && scanned.rules.length ? { ok: true } : { ok: false, reason: "CSS fragment 语法不完整" };
}

function validateJsFragment(content) {
  const source = String(content || "");
  if (!source.trim()) return { ok: false, reason: "JS fragment 为空" };
  if (/<\/?script\b/i.test(source)) return { ok: false, reason: "JS fragment 不能包含 script 标签" };
  if (!balancedSource(source)) return { ok: false, reason: "JS fragment 括号、字符串或注释不完整" };
  if (/^\s*(?:import|export)\b/m.test(source)) return { ok: true };
  try {
    Function(source);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `JS fragment 语法错误：${error instanceof Error ? error.message : String(error)}` };
  }
}

function validateHtmlFragment(fragment, content, opts = {}) {
  const source = String(content || "").trim();
  if (!source) return opts.deleteMode ? { ok: true } : { ok: false, reason: "HTML fragment 为空" };
  if (/<\/?(?:html|head|body)\b/i.test(source)) return { ok: false, reason: "HTML fragment 不能包含完整文档标签" };
  const root = rootDescriptor(source);
  if (!root.tag) return { ok: false, reason: "HTML fragment 没有有效根节点" };
  if (fragment.expectedRoot) {
    const roots = scanHtmlElements(source).filter((node) => !node.parent);
    if (roots.length !== 1) return { ok: false, reason: "HTML 插入 fragment 必须只包含一个根节点" };
    if (fragment.expectedRoot.tag && root.tag !== fragment.expectedRoot.tag) {
      return { ok: false, reason: `HTML 插入 fragment 根节点必须为 <${fragment.expectedRoot.tag}>` };
    }
    const missingClasses = (fragment.expectedRoot.classes || []).filter((className) => !root.classes.includes(className));
    if (missingClasses.length) return { ok: false, reason: `HTML 插入 fragment 根节点缺少布局类：${missingClasses.join("、")}` };
  }
  if (fragment.role === "filter-control-insert") {
    const invalidDplInput = scanHtmlElements(source).find((node) => {
      if (node.tag !== "input" || !nodeClasses(node).includes("dpl-input")) return false;
      return nodeClasses(node.parent).includes("dpl-input");
    });
    if (invalidDplInput) {
      return { ok: false, reason: "DPL 文本框外层不能复用 dpl-input 类，应使用 dpl-input-affix-wrapper 包裹 input.dpl-input" };
    }
  }
  if (fragment.root?.tag && root.tag !== fragment.root.tag) return { ok: false, reason: `HTML fragment 根节点必须保持 <${fragment.root.tag}>` };
  if (fragment.root?.id && root.id !== fragment.root.id && !opts.deleteMode) return { ok: false, reason: `HTML fragment 根 ID #${fragment.root.id} 丢失` };
  return { ok: true };
}

function wrapInsertion(fragment, content) {
  const value = String(content || "").trim();
  if (!value) return "";
  if (fragment.type === "css" && fragment.wrapper === "style") return `<style>\n${value}\n</style>\n`;
  if (fragment.type === "js" && fragment.wrapper === "script") return `<script>\n${value}\n</script>\n`;
  return `${value}\n`;
}

function applyMultiFragmentClaudeResult(baseHtml, plan, editedFiles, opts = {}) {
  const source = String(baseHtml || "");
  if (!plan || sha256(source) !== plan.baseDocumentHash) return { ok: false, reason: "原页面 hash 已变化，fragment 事务失效" };
  const files = editedFiles instanceof Map ? editedFiles : new Map(Object.entries(editedFiles || {}));
  const replacements = [];
  let changed = false;
  for (const fragment of plan.fragments || []) {
    const original = fragment.content;
    if (fragment.operation === "replace") {
      if (source.slice(fragment.start, fragment.end) !== original || sha256(source.slice(fragment.start, fragment.end)) !== fragment.originalHash) {
        return { ok: false, reason: `fragment ${fragment.id} 原始定位或 hash 失效` };
      }
    } else {
      const before = source.slice(Math.max(0, fragment.start - 96), fragment.start);
      const after = source.slice(fragment.start, Math.min(source.length, fragment.start + 96));
      if (sha256(before) !== fragment.anchorBeforeHash || sha256(after) !== fragment.anchorAfterHash) {
        return { ok: false, reason: `插入 fragment ${fragment.id} 锚点失效` };
      }
    }
    if (!files.has(fragment.file)) return { ok: false, reason: `fragment 文件缺失：${fragment.file}` };
    const edited = String(files.get(fragment.file) ?? "");
    if (!fragment.editable && sha256(edited) !== fragment.originalHash) return { ok: false, reason: `只读 fragment 被修改：${fragment.id}` };
    if (byteLength(edited) > fragment.maxOutputBytes) return { ok: false, reason: `fragment ${fragment.id} 超过输出大小上限` };
    if (!fragment.editable) continue;
    if (edited !== original) changed = true;
    const validation =
      fragment.type === "html"
        ? validateHtmlFragment(fragment, edited, opts)
        : fragment.type === "css"
          ? validateCssFragment(edited)
          : validateJsFragment(edited);
    if (!validation.ok && !(fragment.operation === "insert" && !edited.trim())) return { ok: false, reason: `${fragment.id}：${validation.reason}` };
    replacements.push({ ...fragment, edited: fragment.operation === "insert" ? wrapInsertion(fragment, edited) : edited });
  }
  if (!changed) return { ok: false, reason: "Claude Code 未修改任何可写 fragment" };
  if (plan.kind === "composite-filter-table") {
    const unchangedRoles = (plan.fragments || [])
      .filter((fragment) => fragment.editable && fragment.required !== false)
      .filter((fragment) => String(files.get(fragment.file) ?? "") === fragment.content)
      .map((fragment) => fragment.role);
    if (unchangedRoles.length) return { ok: false, reason: `复合事务未完成全部可写片段：${unchangedRoles.join("、")}` };
  }
  let candidate = source;
  replacements.sort((a, b) => b.start - a.start || (a.operation === "insert" ? -1 : 1));
  for (const fragment of replacements) {
    candidate = candidate.slice(0, fragment.start) + fragment.edited + candidate.slice(fragment.end);
  }
  const duplicateIds = duplicateIdsIntroduced(source, candidate);
  if (duplicateIds.length) return { ok: false, reason: `修改引入重复 ID：${duplicateIds.slice(0, 3).join("、")}` };
  const danglingIds = danglingDeletedIdReferences(source, candidate);
  if (danglingIds.length) return { ok: false, reason: `删除的 ID 仍被脚本引用：${danglingIds.slice(0, 3).join("、")}` };
  const introducedNavigation = introducedPrototypeNavigation(source, candidate);
  if (introducedNavigation.length) return { ok: false, reason: `修改引入真实页面导航：${[...new Set(introducedNavigation)].join("、")}` };
  const contractValidation = validatePrototypeContractRegression(
    source,
    candidate,
    plan.acceptance?.prototypeContract,
    plan.acceptance?.instruction,
    { interactiveEdit: plan.acceptance?.interactiveEdit }
  );
  if (!contractValidation.ok) return contractValidation;
  return { ok: true, html: candidate, changedFragments: replacements.filter((fragment) => fragment.edited !== fragment.content).map((fragment) => fragment.id) };
}

function multiFragmentManifestForClaude(plan) {
  return {
    protocolVersion: plan.protocolVersion,
    kind: plan.kind || "dependency-transaction",
    baseDocumentHash: plan.baseDocumentHash,
    primaryFragmentId: plan.primaryFragmentId,
    fragments: plan.fragments.map(({ content, root, ...fragment }) => ({ ...fragment, root })),
    dependencies: plan.dependencies,
    taskHints: plan.taskHints || {},
    limits: plan.limits,
    acceptance: {
      navigationBaseline: plan.acceptance.navigationBaseline,
      prototypeContractHash: plan.acceptance.prototypeContractHash,
      relevantMustHave: Array.isArray(plan.acceptance.prototypeContract?.mustHave) ? plan.acceptance.prototypeContract.mustHave : [],
      relevantInteractions: (Array.isArray(plan.acceptance.prototypeContract?.interactions)
        ? plan.acceptance.prototypeContract.interactions
        : []
      ).filter((item) => item?.priority === "must"),
      relevantRequiredStates: Array.isArray(plan.acceptance.prototypeContract?.requiredStates)
        ? plan.acceptance.prototypeContract.requiredStates
        : [],
    },
  };
}

function formatMultiFragmentTask(plan) {
  const editableCount = plan.fragments.filter((fragment) => fragment.editable).length;
  return [
    "## Multi-Fragment Transaction",
    "",
    "The complete page is intentionally absent. Read manifest.json as the single source of truth for fragment permissions, dependencies, limits, and Prototype Contract checks.",
    `- Transaction kind: ${plan.kind || "dependency-transaction"}`,
    `- Primary fragment: ${plan.primaryFragmentId}`,
    `- Fragments: ${plan.fragments.length} total, ${editableCount} editable, ${plan.fragments.length - editableCount} read-only`,
    "- Edit existing editable fragment files only; do not rename, delete, or create files.",
    ...(plan.kind === "composite-filter-table"
      ? [
          "- This is one atomic filter-and-table transaction. Trust manifest.taskHints, edit both editable HTML fragments, and do not search for the absent full page.",
          "- The filter-control-insert file starts empty. Read the filter-anchor-context file, then write exactly one complete sibling wrapper with the same root tag/layout classes; do not nest the new form item inside the existing filter wrapper.",
          "- For a plain DPL text input, wrap input.dpl-input with span.dpl-input-affix-wrapper. Never apply dpl-input to both the wrapper and the nested input, which renders as two input boxes.",
        ]
      : []),
    "",
  ].join("\n");
}

module.exports = {
  applyMultiFragmentClaudeResult,
  contractSignals,
  definitionNames,
  formatMultiFragmentTask,
  multiFragmentManifestForClaude,
  prepareMultiFragmentClaudeJob,
  scanCssRules,
  scanHtmlElements,
  scanJsTopLevelStatements,
  sha256,
  validateCssFragment,
  validateJsFragment,
  validatePrototypeContractRegression,
};
