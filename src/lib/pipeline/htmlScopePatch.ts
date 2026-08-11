export const TARGET_ELEMENT_MARKERS = [
  "\n\n目标元素（请在原 HTML 中精确定位，以它为锚点选择合适作用域修改，其余保持不变）：\n",
  "\n\n目标元素（请在原 HTML 中精确定位并只改这个元素，其余保持不变）：\n",
];

type HtmlNode = {
  tag: string;
  start: number;
  end: number;
  openTag: string;
};

export type ScopePatchTarget = {
  instruction: string;
  targetHtml: string;
  anchorId?: string;
};

export type HtmlScope = {
  html: string;
  start: number;
  end: number;
  tag: string;
  reason: string;
};

export type DeterministicScopePatch = {
  html: string;
  kind: "text_replace" | "color_replace" | "attr_replace";
};

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

export function extractScopePatchTarget(instruction: string): ScopePatchTarget | null {
  for (const marker of TARGET_ELEMENT_MARKERS) {
    const idx = instruction.indexOf(marker);
    if (idx >= 0) {
      const targetHtml = instruction.slice(idx + marker.length).trim();
      if (!targetHtml) return null;
      return { instruction: instruction.slice(0, idx).trim(), targetHtml, anchorId: extractAnchorId(targetHtml) };
    }
  }
  return null;
}

function normalizeSpace(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

function textFromHtml(html: string) {
  return normalizeSpace(html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " "));
}

function tagNameOf(html: string) {
  return /^<\s*([a-zA-Z][\w:-]*)\b/.exec(html.trim())?.[1]?.toLowerCase() ?? "";
}

function extractAnchorId(html: string) {
  return /<!--\s*yd-anchor:([a-zA-Z0-9_-]+)\s*-->/.exec(html)?.[1];
}

function findAnchorRange(original: string, targetHtml: string, anchorId?: string): { start: number; end: number; tag: string } | null {
  if (anchorId) {
    const escaped = anchorId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const attr = new RegExp(`\\sdata-yd-anchor=(["'])${escaped}\\1`);
    const m = attr.exec(original);
    if (m) {
      const nodes = enclosingNodes(original, m.index, m.index + m[0].length);
      const node = nodes[0];
      if (node) return { start: node.start, end: node.end, tag: node.tag };
    }
  }

  const exact = original.indexOf(targetHtml);
  if (exact >= 0) return { start: exact, end: exact + targetHtml.length, tag: tagNameOf(targetHtml) };

  const tag = tagNameOf(targetHtml);
  const text = textFromHtml(targetHtml);
  if (!tag || text.length < 2) return null;

  const textIdx = original.indexOf(text);
  if (textIdx < 0) return null;
  const nodes = enclosingNodes(original, textIdx, textIdx + text.length);
  const node = nodes.find((n) => n.tag === tag) ?? nodes[0];
  return node ? { start: node.start, end: node.end, tag: node.tag } : null;
}

function enclosingNodes(html: string, start: number, end: number): HtmlNode[] {
  const tokens = /<\/?([a-zA-Z][\w:-]*)(?:\s[^<>]*?)?>/g;
  const stack: Array<{ tag: string; start: number; openTag: string }> = [];
  const nodes: HtmlNode[] = [];
  let m: RegExpExecArray | null;
  while ((m = tokens.exec(html))) {
    const token = m[0];
    const tag = m[1].toLowerCase();
    if (token.startsWith("</")) {
      let idx = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          idx = i;
          break;
        }
      }
      if (idx >= 0) {
        const open = stack[idx];
        stack.splice(idx);
        nodes.push({ tag, start: open.start, end: m.index + token.length, openTag: open.openTag });
      }
    } else if (!VOID_TAGS.has(tag) && !/\/\s*>$/.test(token)) {
      stack.push({ tag, start: m.index, openTag: token });
    }
  }
  return nodes.filter((node) => node.start <= start && node.end >= end).sort((a, b) => a.end - a.start - (b.end - b.start));
}

function isTableEdit(instruction: string, nodes: HtmlNode[]) {
  if (!nodes.some((node) => node.tag === "table")) return false;
  // 只有指令含表格结构操作词(列/行/表头/单元格/同列/每行/位置词…)才上提到整表;
  // 单纯改单元格文案/数值(如"把李斌02改成张三")不重写整张表,按目标元素自身 scope(B-5)。
  return /表格|表头|表体|单元格|列|行|同列|每行|右边|左边|左侧|右侧|上方|下方/.test(instruction);
}

function isTabEdit(instruction: string) {
  return /页签|标签页|tab/i.test(instruction) && /新增|添加|增加|插入|点击|打开后|切换|选中|展示|显示/.test(instruction);
}

function isCompleteTabGroup(node: HtmlNode, original: string) {
  const classTokens = nodeClass(node).split(/\s+/).filter(Boolean);
  if (!classTokens.some((token) => /(?:^|[-_])tabs?$/i.test(token))) return false;
  const html = original.slice(node.start, node.end);
  return /\brole\s*=\s*["']tab["']/i.test(html) && /\brole\s*=\s*["']tabpanel["']/i.test(html);
}

function isSemanticContainer(node: HtmlNode) {
  if (["section", "article", "main", "form", "ul", "ol", "table"].includes(node.tag)) return true;
  if (node.tag !== "div") return false;
  // 覆盖常见业务/后台类名：card|item|col|cell|row|line|top|info|base|detail|profile|field|group|area|section|module|...
  // 另含抽屉/弹窗类:drawer|modal|dialog|popup|popover|sheet(让"删除整个抽屉"能扩到 .drawer 作用域)
  return /\b(class|id)=["'][^"']*(drawer|modal|dialog|popup|popover|sheet|card|panel|section|module|container|wrap|wrapper|block|item|row|col|cell|line|top|info|base|detail|profile|field|group|area|region|zone|widget|tile|entry|form|table|list|content|sidebar|nav|header|footer|app|layout|grid|menu|toolbar|tabs|page|main)[^"']*["']/i.test(
    node.openTag
  );
}

export function selectHtmlPatchScope(
  original: string,
  targetHtml: string,
  instruction: string,
  anchorId?: string,
  plan?: { operation?: string; scopeHint?: string; batch?: boolean }
): HtmlScope | { error: string } {
  const anchor = findAnchorRange(original, targetHtml, anchorId);
  if (!anchor) return { error: "目标元素定位失败" };

  const nodes = enclosingNodes(original, anchor.start, anchor.end);
  if (!nodes.length) return { error: "目标元素作用域识别失败" };

  // plan 在场（点选/自动定位链路已跑过 planHtmlEdit）→ 用 LLM 计划驱动四类上提决策，
  // 取代原指令正则；plan 缺席（测试/兜底）→ 回退原正则，reason 文本保持一致。
  const fromPlan = !!plan;
  const planHint = plan?.scopeHint?.toLowerCase();
  // startsWith 容忍 LLM 输出 tabs/tab-bar/dpl-tabs 等复数/连字符变体；table 同理（table-row 等）。
  const tabIntent = fromPlan ? /^tab/i.test(planHint ?? "") : isTabEdit(instruction);
  const tableIntent = fromPlan ? /^table/i.test(planHint ?? "") : isTableEdit(instruction, nodes);
  const removeOrMoveIntent = fromPlan
    ? plan?.operation === "delete" || plan?.operation === "move"
    : /删除|删掉|删去|移除|去掉|清除|清空|移动|移到|移至|排序|置顶|置底|挪/.test(instruction);
  const batchIntent = fromPlan
    ? // plan 在场：plan.batch 肯定即批量；OR 正则兜底防 LLM 漏判 batch=false 时静默只改单个（“所有卡片”等批量词命中正则仍上提）。
      plan?.batch === true || /所有|每个|全部|每行|同列|这些|各/.test(instruction)
    : /所有|每个|全部|每行|同列|这些|各/.test(instruction);

  let chosen: HtmlNode | undefined;
  let reason = "";
  if (tabIntent) {
    chosen = nodes.find((node) => isCompleteTabGroup(node, original));
    if (chosen) reason = "页签编辑：已上提到包含 tablist 与 tabpanel 的完整页签组";
  }
  if (!chosen && tableIntent) {
    chosen = nodes.find((node) => node.tag === "table");
    if (chosen) reason = "表格编辑：已上提到 <table> 作用域";
  }

  // 删除/移动/排序等：强制上提到能容纳该操作的父级（在兄弟间增删/重排），不能停在元素自身。
  // 优先「含多个同类兄弟的最近父级」（兄弟间操作的正确 scope）；找不到再退到语义容器。
  const isRemoveOrMove = removeOrMoveIntent;
  if (!chosen && isRemoveOrMove) {
    for (let i = 0; i < nodes.length - 1; i++) {
      const child = nodes[i];
      const parent = nodes[i + 1];
      const seg = original.slice(parent.start, parent.end);
      const re = new RegExp(`<${child.tag}(?:\\s[^<>]*?)?>`, "gi");
      if ((seg.match(re) || []).length >= 2) {
        chosen = parent;
        reason = `删除/移动：已上提到 <${parent.tag}> 作用域（含多个 <${child.tag}> 兄弟）`;
        break;
      }
    }
    if (!chosen) {
      chosen = nodes.find((node) => isSemanticContainer(node));
      if (chosen) reason = `删除/移动：已上提到 <${chosen.tag}> 作用域（语义容器）`;
    }
  }

  // 方位词仍用指令正则（plan 无对应字段，方位词可靠）；新增/删除意图 plan 在场用 operation 驱动（覆盖“补一个”“加个”等口语），缺席回退正则。
  const positionalScopeIntent = /上方|下方|前面|后面|之前|之后|右边|左边|左侧|右侧|旁边|附近|周围|外面/.test(instruction);
  const insertionScopeIntent = fromPlan
    ? plan?.operation === "insert"
    : /(?:新增|添加|增加|插入)(?:一个|一条|一项|一列|一行|一块|一段|按钮|入口|模块|区块|字段|卡片|列表|明细|详情|文案|内容|列|行|项|个)/.test(instruction) ||
      /(?:加上|加个|加一|多一列|多一行|多一个|多一项|补一个|补一条)/.test(instruction);
  const destructiveScopeIntent = fromPlan
    ? plan?.operation === "delete" || plan?.operation === "move"
    : /删除|删掉|删去|移除|去掉|清除|清空|移动|移到|移至|排序|置顶|置底|挪/.test(instruction);
  const needsWiderScope = positionalScopeIntent || insertionScopeIntent || destructiveScopeIntent;
  if (!chosen && needsWiderScope) {
    chosen = nodes.find((node) => (node.start !== anchor.start || node.end !== anchor.end) && isSemanticContainer(node));
    if (chosen) reason = `已扩大到 <${chosen.tag}> 作用域`;
  }

  // 批量同类元素（所有/每个/全部/每行/同列/各/这些）：上提到容纳多个同类兄弟的最近祖先，
  // 让 scope patch 在容器内一次性作用于全部重复元素。
  const isBatch = !chosen && batchIntent;
  if (isBatch) {
    for (let i = 0; i < nodes.length - 1; i++) {
      const child = nodes[i];
      const parent = nodes[i + 1];
      const seg = original.slice(parent.start, parent.end);
      const re = new RegExp(`<${child.tag}(?:\\s[^<>]*?)?>`, "gi");
      if ((seg.match(re) || []).length >= 2) {
        chosen = parent;
        reason = `批量：已上提到 <${parent.tag}> 作用域（含多个 <${child.tag}>）`;
        break;
      }
    }
  }

  if (!chosen) chosen = nodes.find((node) => node.tag === anchor.tag) ?? nodes[0];

  return {
    html: original.slice(chosen.start, chosen.end),
    start: chosen.start,
    end: chosen.end,
    tag: chosen.tag,
    reason: reason || (chosen.tag === anchor.tag ? "目标元素" : `已扩大到 <${chosen.tag}> 作用域`),
  };
}

/**
 * 去重签名：剥 style/script/注释/标签 + 解码常见实体 + 小写 + 压空白。
 * 与 visibleTextForClaudeFocus 同款 HTML 解析手段（非指令关键词正则）。
 * 标签被整体剥离 → data-yd-anchor 等逐卡不同的属性不影响签名，两份内容相同的卡片签名一致。
 */
function dedupSignature(html: string): string {
  return textFromHtml(html)
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;|&#38;/gi, "&")
    .replace(/&lt;|&#60;/gi, "<")
    .replace(/&gt;|&#62;/gi, ">")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;/gi, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 取某节点的直接子节点（depth=1）。token 遍历风格同 enclosingNodes，
 * 但只在 [node 起标签之后, node.end) 内走，栈深度 0 的开/闭配对即为直接子节点。
 */
function directChildNodes(html: string, node: HtmlNode): HtmlNode[] {
  const tokens = /<\/?([a-zA-Z][\w:-]*)(?:\s[^<>]*?)?>/g;
  const stack: Array<{ tag: string; start: number; openTag: string; depth: number }> = [];
  const children: HtmlNode[] = [];
  let m: RegExpExecArray | null;
  tokens.lastIndex = node.start + node.openTag.length;
  while ((m = tokens.exec(html)) && m.index < node.end) {
    const token = m[0];
    const tag = m[1].toLowerCase();
    if (token.startsWith("</")) {
      let idx = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          idx = i;
          break;
        }
      }
      if (idx >= 0) {
        const open = stack[idx];
        if (open.depth === 0) {
          children.push({ tag: open.tag, start: open.start, end: m.index + token.length, openTag: open.openTag });
        }
        stack.splice(idx);
      }
    } else if (!VOID_TAGS.has(tag) && !/\/\s*>$/.test(token)) {
      stack.push({ tag, start: m.index, openTag: token, depth: stack.length });
    }
  }
  return children;
}

/**
 * 点选去重指令的作用域选择：沿锚点祖先链自内向外找"含 ≥2 个同签名直接子节点"的最小容器。
 * 找到 → 返回该容器 scope（让 LLM scope patch 在容器内一次性去重）。
 * 找不到 → { error }，调用方回退 selectHtmlPatchScope（不阻塞）。
 */
export function selectDedupScope(
  original: string,
  targetHtml: string,
  anchorId?: string
): HtmlScope | { error: string } {
  const anchor = findAnchorRange(original, targetHtml, anchorId);
  if (!anchor) return { error: "目标元素定位失败" };
  const ancestors = enclosingNodes(original, anchor.start, anchor.end);
  for (const a of ancestors) {
    const children = directChildNodes(original, a);
    if (children.length < 2) continue;
    const groups = new Map<string, HtmlNode[]>();
    for (const c of children) {
      const sig = dedupSignature(original.slice(c.start, c.end));
      if (!sig) continue;
      const arr = groups.get(sig) ?? [];
      arr.push(c);
      groups.set(sig, arr);
    }
    for (const [, arr] of groups) {
      if (arr.length >= 2) {
        return {
          html: original.slice(a.start, a.end),
          start: a.start,
          end: a.end,
          tag: a.tag,
          reason: `去重：已上扩到含 ${arr.length} 个重复项的 <${a.tag}> 容器`,
        };
      }
    }
  }
  return { error: "未在锚点祖先链发现重复项" };
}

export function validateScopeReplacement(
  scope: HtmlScope,
  replacement: string,
  opts?: { deleteMode?: boolean }
): { ok: boolean; reason: string } {
  const out = replacement.trim();
  if (!out) return { ok: false, reason: "模型未返回替换片段" };
  if (/(<!doctype\b|<html\b|<body\b|<\/html>)/i.test(out)) return { ok: false, reason: "模型返回了整页 HTML，而不是局部作用域" };
  const tag = tagNameOf(out);
  if (tag !== scope.tag) return { ok: false, reason: `替换片段根标签应为 <${scope.tag}>，实际为 <${tag || "未知"}>` };
  if (!new RegExp(`</${scope.tag}>\\s*$`, "i").test(out) && !VOID_TAGS.has(scope.tag)) {
    return { ok: false, reason: `替换片段缺少 </${scope.tag}>` };
  }
  if (opts?.deleteMode) {
    // 删除/移动：替换片段本就比 scope 小（删了一个子元素），35% 下限会误拒合法删除。
    // 放宽到 10% 防截断/空 stub；同时用内容比对拦 no-op 假删除——
    // 旧 0.98 长度比上限对"删一个小元素"（图标/短 span，replacement 占 scope 99%）假阳性，
    // 和 isTrivialNoOp 同类问题。内容归一相等才算没真删，否则哪怕只差几字节也算真删。
    if (out.length < scope.html.length * 0.1) return { ok: false, reason: "替换片段体量过小，疑似被截断" };
    if (scopeReplacementUnchanged(scope.html, out)) return { ok: false, reason: "替换片段与原作用域实质相同，未检测到删除" };
  } else {
    if (out.length < scope.html.length * 0.35) return { ok: false, reason: "替换片段体量明显偏小，疑似被截断或重写" };
  }
  return { ok: true, reason: "" };
}

/**
 * 删除快路径：在原文中定位目标元素并直接剪除，不调 LLM。
 * 找"含多个同类兄弟的最近祖先"（被重复的元素，如一张卡片/一项导航）——它的父级含 ≥2 个同类兄弟，
 * 删它即从兄弟集合里移除一个；都没有则删锚点自身（用户标注的就是要删的）。
 * 返回删除后的完整 HTML；调用方负责校验完整性/防整页重写。
 * 用于"删除某卡片/某项"——LLM 重写大 scope 易截断（B-E16：2.8MB 页面父级 scope 几十万字符，
 * 48K token 放不下忠实副本），直接剪贴确定性且任意大小都可处理。
 */
/** 数 parent 片段里与 child 同 tag 且"同类"的元素个数(重复兄弟)。
 *  "同类"按首个 class token(基类)相等判定:卡片 `summary-card negative`/`summary-card accent`/
 *  `summary-card` 首 token 都是 summary-card -> 算重复(T9:删卡片能整删而非只删内层 s-value)。
 *  不能用"共享任一 token"--`.drawer` 与 `.drawer-overlay` 都带 `open` 状态类会被误判重复(S1 回归)。
 *  用首 token(基类,约定基类在前)避开状态类:drawer vs drawer-overlay 不等。无 class 元素(如 <tr>)
 *  按"都无 class"判同类,行删除仍生效。 */
function countRepeatedSiblings(seg: string, child: HtmlNode): number {
  const cls = nodeClass(child);
  const tokens = cls ? cls.split(/\s+/).filter(Boolean) : [];
  const firstTok = tokens[0] ?? "";
  const re = new RegExp(`<${child.tag}(?:\\s[^<>]*?)?>`, "gi");
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg))) {
    const c = /class\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1]?.trim() ?? "";
    if (!firstTok) {
      if (c === "") count++; // 无 class(如 <tr>):都无 class 算同类
    } else {
      const sibFirst = c ? c.split(/\s+/).filter(Boolean)[0] : "";
      if (sibFirst === firstTok) count++; // 首 token(基类)相同算同类
    }
  }
  return count;
}

export function directDeleteElement(original: string, targetHtml: string, anchorId?: string): string | null {
  const anchor = findAnchorRange(original, targetHtml, anchorId);
  if (!anchor) return null;
  const nodes = enclosingNodes(original, anchor.start, anchor.end);
  if (!nodes.length) return null;
  // 优先删最内层的"重复元素"（第一张卡片/第一项）；都没有则删锚点自身。
  // "重复"按 tag+class 判定(同类兄弟≥2):按 tag 会把 .drawer 里 drawer-header/drawer-body
  // 等不同 class 的 div 误判为重复,连标题一起删(B-1:删关闭按钮误删整个 .drawer-header)。
  let target = nodes[0];
  for (let i = 0; i < nodes.length - 1; i++) {
    const child = nodes[i];
    const parent = nodes[i + 1];
    const seg = original.slice(parent.start, parent.end);
    if (countRepeatedSiblings(seg, child) >= 2) {
      target = child;
      break;
    }
  }
  let result = `${original.slice(0, target.start)}${original.slice(target.end)}`;
  // B-3: 删语义容器(drawer/modal/dialog)时,关联删其 overlay/mask 兄弟,避免遗留孤立遮罩
  return removeAssociatedOverlay(result, target);
}

function anchorNodeForOpenTag(original: string, anchor: { start: number; end: number; tag: string }): HtmlNode | null {
  const openEnd = original.indexOf(">", anchor.start);
  if (openEnd < 0 || openEnd >= anchor.end) return null;
  const openTag = original.slice(anchor.start, openEnd + 1);
  if (tagNameOf(openTag) !== anchor.tag) return null;
  return { tag: anchor.tag, start: anchor.start, end: anchor.end, openTag };
}

export function directHideElement(original: string, targetHtml: string, anchorId?: string): string | null {
  const anchor = findAnchorRange(original, targetHtml, anchorId);
  if (!anchor) return null;
  const nodes = enclosingNodes(original, anchor.start, anchor.end);
  const target = anchorNodeForOpenTag(original, anchor) ?? nodes[0];
  if (!target) return null;
  const open = target.openTag;
  const hiddenOpen = /\sstyle\s*=\s*["'][^"']*["']/i.test(open)
    ? open.replace(/\sstyle\s*=\s*(["'])([^"']*)\1/i, (_m, quote: string, value: string) => {
        if (/display\s*:\s*none/i.test(value)) return ` style=${quote}${value}${quote}`;
        return ` style=${quote}${value.trim().replace(/;?\s*$/, ";")}display:none !important${quote}`;
      })
    : open.replace(/\s*\/?>$/, (end) => ` style="display:none !important"${end}`);
  if (hiddenOpen === open) return null;
  return `${original.slice(0, target.start)}${hiddenOpen}${original.slice(target.start + open.length)}`;
}

/** 从开标签起始位置找该元素的完整范围(到匹配闭合标签),处理同标签嵌套。用于整元素删除。 */
function findElementRange(html: string, openStart: number, tag: string): { start: number; end: number } | null {
  const openRe = new RegExp(`<${tag}(?:\\s[^<>]*?)?>`, "gi");
  const closeRe = new RegExp(`</${tag}\\s*>`, "gi");
  openRe.lastIndex = openStart;
  const openMatch = openRe.exec(html);
  if (!openMatch || openMatch.index !== openStart) return null;
  const openEnd = openMatch.index + openMatch[0].length;
  if (/\/\s*>$/.test(openMatch[0])) return { start: openStart, end: openEnd };
  let depth = 1;
  let pos = openEnd;
  while (depth > 0) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;
    const no = openRe.exec(html);
    const nc = closeRe.exec(html);
    if (!nc) return null;
    if (no && no.index < nc.index) { depth++; pos = no.index + no[0].length; }
    else { depth--; pos = nc.index + nc[0].length; if (depth === 0) return { start: openStart, end: pos }; }
  }
  return null;
}

/** 取容器 class 里含 drawer/modal/dialog/popup/popover/sheet 的 token,用于关联找其 overlay/mask 兄弟 */
function containerPrefix(node: HtmlNode): string | null {
  for (const t of nodeClass(node).split(/\s+/)) {
    if (/(drawer|modal|dialog|popup|popover|sheet)/i.test(t)) return t;
  }
  return null;
}

/** 删语义容器时,关联删 class 含 "{prefix}-overlay/mask/backdrop/dim" 的兄弟遮罩(B-3) */
function removeAssociatedOverlay(html: string, container: HtmlNode): string {
  if (!isSemanticContainer(container)) return html;
  const prefix = containerPrefix(container);
  if (!prefix) return html;
  const re = new RegExp(
    `<([a-zA-Z][\\w:-]*)(?:\\s[^<>]*?)?\\sclass=["'][^"']*\\b${escapeRegex(prefix)}-(?:overlay|mask|backdrop|dim)\\b[^"']*["']`,
    "i"
  );
  const m = re.exec(html);
  if (!m) return html;
  const range = findElementRange(html, m.index, m[1].toLowerCase());
  if (!range) return html;
  return `${html.slice(0, range.start)}${html.slice(range.end)}`;
}

/**
 * 列删除快路径:确定性跨行删同列单元格 + 表头--B-6。directDeleteElement 只删一个单元格/行(列语义丢失),
 * LLM 重写整表又常误删整行。这里按锚点 td/th 在其 tr 中的列号,从表格每一行移除该列单元格(含表头 th),
 * 确定性、任意大小可处理。返回删除后的完整 HTML;调用方负责校验完整性。
 */
export function directDeleteColumn(original: string, targetHtml: string, anchorId?: string): string | null {
  const anchor = findAnchorRange(original, targetHtml, anchorId);
  if (!anchor) return null;
  const nodes = enclosingNodes(original, anchor.start, anchor.end);
  const table = nodes.find((n) => n.tag === "table");
  const tr = nodes.find((n) => n.tag === "tr");
  if (!table || !tr) return null;
  // 锚点单元格在其 tr 中的列号(数它之前的 th/td)
  const trHtml = original.slice(tr.start, tr.end);
  const cellRe = /<(?:th|td)\b[^>]*>[\s\S]*?<\/(?:th|td)>/gi;
  let colIndex = -1;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(trHtml))) {
    if (tr.start + m.index >= anchor.start) { colIndex = count; break; }
    count++;
  }
  if (colIndex < 0) return null;
  const tableHtml = original.slice(table.start, table.end);
  let changed = false;
  const newTable = tableHtml.replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi, (trMatch) => {
    let i = -1;
    return trMatch.replace(/<(?:th|td)\b[^>]*>[\s\S]*?<\/(?:th|td)>/gi, (cell) => { i++; if (i === colIndex) { changed = true; return ""; } return cell; });
  });
  if (!changed) return null;
  return `${original.slice(0, table.start)}${newTable}${original.slice(table.end)}`;
}

export function extractScopeReplacement(scope: HtmlScope, raw: string) {
  const text = raw.trim();
  const lower = text.toLowerCase();
  const start = lower.indexOf(`<${scope.tag}`);
  const end = lower.lastIndexOf(`</${scope.tag}>`);
  if (start >= 0 && end >= start) return text.slice(start, end + scope.tag.length + 3).trim();
  return text;
}

export function applyScopeReplacement(original: string, scope: HtmlScope, replacement: string) {
  return `${original.slice(0, scope.start)}${replacement.trim()}${original.slice(scope.end)}`;
}

function isInsideTag(html: string, index: number): boolean {
  return html.lastIndexOf("<", index) > html.lastIndexOf(">", index);
}

function scriptStyleRanges(html: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const re = /<(script|style)\b[\s\S]*?<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) ranges.push({ start: m.index, end: m.index + m[0].length });
  return ranges;
}

function inRanges(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function unquoteLoose(text: string): string {
  return text.trim().replace(/^[「『“"'`]+/, "").replace(/[」』”"'`。.!！；;，,]+$/, "").trim();
}

function replaceAt(text: string, start: number, oldValue: string, newValue: string): string {
  return `${text.slice(0, start)}${newValue}${text.slice(start + oldValue.length)}`;
}

function tryDeterministicTextReplace(scopeHtml: string, instruction: string): DeterministicScopePatch | null {
  const m = /(?:把|将)\s*([「『“"'`]?[^「」『』“”"'`，,。；;]{1,80}[」』”"'`]?)\s*(?:改成|改为|替换为|换成)\s*([「『“"'`]?[^「」『』“”"'`，,。；;]{1,120}[」』”"'`]?)/.exec(
    instruction
  );
  if (!m) return null;
  const from = unquoteLoose(m[1]);
  const to = unquoteLoose(m[2]);
  if (!from || !to || from === to || /[<>]/.test(from + to)) return null;
  if (from.length < 2 || /^(按钮|文字|文案|标题|颜色|样式|这里|这个|那个)$/.test(from)) return null;

  const ranges = scriptStyleRanges(scopeHtml);
  const hits: number[] = [];
  let idx = -1;
  while ((idx = scopeHtml.indexOf(from, idx + 1)) >= 0) {
    if (!isInsideTag(scopeHtml, idx) && !inRanges(idx, ranges)) hits.push(idx);
    if (hits.length > 1) break;
  }
  if (hits.length !== 1) return null;
  return { html: replaceAt(scopeHtml, hits[0], from, to), kind: "text_replace" };
}

function tryDeterministicColorReplace(scopeHtml: string, instruction: string): DeterministicScopePatch | null {
  const color = "(?:#[0-9a-fA-F]{3,8}\\b|rgba?\\([^)]{3,80}\\))";
  const m = new RegExp(`(${color})\\s*(?:改成|改为|替换为|换成)\\s*(${color})`).exec(instruction);
  if (!m || m[1] === m[2]) return null;
  const first = scopeHtml.indexOf(m[1]);
  if (first < 0 || scopeHtml.indexOf(m[1], first + m[1].length) >= 0) return null;
  return { html: replaceAt(scopeHtml, first, m[1], m[2]), kind: "color_replace" };
}

function tryDeterministicAttrReplace(scopeHtml: string, instruction: string): DeterministicScopePatch | null {
  const attrMatch = /\b(placeholder|title|aria-label)\b|占位文案|提示文案/.exec(instruction);
  if (!attrMatch) return null;
  const attr = attrMatch[1] || (/(占位文案|提示文案)/.test(attrMatch[0]) ? "placeholder" : "");
  if (!attr) return null;
  const valueMatch = /(?:改成|改为|替换为|换成)\s*([「『“"'`]?[^「」『』“”"'`，,。；;]{1,120}[」』”"'`]?)/.exec(instruction);
  const value = valueMatch ? unquoteLoose(valueMatch[1]) : "";
  if (!value || /[<>]/.test(value)) return null;
  const re = new RegExp(`\\s${attr}\\s*=\\s*(["'])([^"']*)\\1`, "gi");
  const matches = [...scopeHtml.matchAll(re)];
  if (matches.length !== 1 || matches[0][2] === value) return null;
  return {
    html: scopeHtml.replace(re, (raw, quote: string) => ` ${attr}=${quote}${value}${quote}`),
    kind: "attr_replace",
  };
}

export function tryDeterministicScopePatch(scopeHtml: string, instruction: string): DeterministicScopePatch | null {
  return (
    tryDeterministicColorReplace(scopeHtml, instruction) ||
    tryDeterministicAttrReplace(scopeHtml, instruction) ||
    tryDeterministicTextReplace(scopeHtml, instruction)
  );
}

/**
 * 模型输出的 scope 替换片段是否与原 scope 实质相同（仅空白差异）→ 视为 no-op。
 * 用于自动定位 scope patch 的"模型原样回吐"检测。与整页 isTrivialNoOp 同一套逻辑
 * （内容归一去空白后相等），保持一致；大小写敏感（类名/文本大小写变化算真实改动）。
 */
export function scopeReplacementUnchanged(originalScope: string, replacement: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, "");
  return norm(originalScope) === norm(replacement);
}

export function removeTemporaryAnchors(html: string) {
  return html.replace(/\sdata-yd-anchor=(["']).*?\1/g, "");
}

/** 自动定位结果（locateScopeTarget 的结构化输出） */
export type LocateResult = {
  tag: string;
  classHint?: string;
  textSnippet?: string;
  selectorHint?: string;
  offsetHint?: number;
  confidence: number;
  ambiguous: boolean;
  batch?: boolean;
};

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 构建精简 DOM 摘要供定位模型看：每行一个元素，含 offset、标签/class/id/业务属性/紧邻文案，按深度缩进。
 * 剥掉 style/script/注释，总长上限 ~30KB（超长截断），避免喂全页 HTML。
 * 30KB 覆盖大页面（如 9MB 打包器解包后 ~100KB body）更深处的目标元素；6KB 时只能看到顶部，
 * 「重新生成」这类中后部按钮定位不到。flash 定位模型 ~7.5K tokens，可接受。
 */
export function buildDomSummary(html: string): string {
  const mask = (s: string) => " ".repeat(s.length);
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, mask)
    .replace(/<!doctype[^>]*>/gi, mask)
    .replace(/<style[\s\S]*?<\/style>/gi, mask)
    .replace(/<script[\s\S]*?<\/script>/gi, mask);
  const tokens = /<(\/?)([a-zA-Z][\w:-]*)((?:\s[^<>]*?)?)>/g;
  const stack: Array<{ tag: string }> = [];
  const lines: string[] = [];
  const MAX = 30000;
  let m: RegExpExecArray | null;
  while ((m = tokens.exec(stripped))) {
    const full = m[0];
    const closing = m[1];
    const tag = m[2].toLowerCase();
    const attrs = m[3] || "";
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          stack.splice(i);
          break;
        }
      }
      continue;
    }
    const depth = Math.min(stack.length, 6);
    const cls = /class\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]?.trim();
    const id = /id\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]?.trim();
    const role = /role\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]?.trim();
    const aria = /aria-label\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]?.trim();
    const title = /title\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]?.trim();
    const name = /name\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]?.trim();
    const dataAttrs = Array.from(attrs.matchAll(/\s(data-(?:id|key|name|type|role|action|target|value))\s*=\s*["']([^"']{1,40})["']/gi))
      .slice(0, 3)
      .map((x) => `${x[1]}="${x[2].trim()}"`);
    const after = stripped.slice(m.index + full.length);
    const nextTag = after.search(/</);
    let snippet = (nextTag >= 0 ? after.slice(0, nextTag) : after).replace(/\s+/g, " ").trim();
    if (snippet) snippet = snippet.slice(0, 24);
    const parts = [`[offset ${m.index}]`, `<${tag}`];
    if (id) parts.push(`id="${id}"`);
    if (cls) parts.push(`class="${cls}"`);
    if (role) parts.push(`role="${role}"`);
    if (aria) parts.push(`aria-label="${aria.slice(0, 24)}"`);
    if (title) parts.push(`title="${title.slice(0, 24)}"`);
    if (name) parts.push(`name="${name.slice(0, 24)}"`);
    parts.push(...dataAttrs);
    let line = "  ".repeat(depth) + parts.join(" ") + ">";
    if (snippet) line += ` ${snippet}`;
    if (lines.join("\n").length + line.length + 1 < MAX) lines.push(line);
    else break;
    if (!VOID_TAGS.has(tag) && !/\/\s*>$/.test(full)) stack.push({ tag });
  }
  return lines.join("\n");
}

/** 从开标签字符串里取 class 属性值 */
function nodeClass(node: HtmlNode): string {
  return /class\s*=\s*["']([^"']*)["']/i.exec(node.openTag)?.[1]?.trim() ?? "";
}
/** 从开标签字符串里取 id 属性值 */
function nodeId(node: HtmlNode): string {
  return /id\s*=\s*["']([^"']*)["']/i.exec(node.openTag)?.[1]?.trim() ?? "";
}

/**
 * 把定位结果在原文中命中一个元素区间。收集所有候选（textSnippet 每个出现位置的包围元素 +
 * selectorHint/classHint 正则命中的元素），按多信号打分取最高，同分取最早。
 *
 * 旧实现用 textSnippet 的 indexOf 取第一个出现位置且命中即返回，忽略 classHint/selectorHint——
 * 重复文案（如 11 处"产品活跃"、50 处"详情"）下会选到第一个出现的元素，而非 LLM 指定的那个，
 * 导致静默改错地方。现在让 classHint 真正参与筛选：同一段文案在多个元素里时，优先选 class 匹配的。
 */
export function matchLocateToAnchor(original: string, loc: LocateResult): { start: number; end: number; tag: string } | null {
  const tag = loc.tag?.trim().toLowerCase();
  if (!tag) return null;

  const textSnippet = loc.textSnippet && loc.textSnippet.length >= 2 ? loc.textSnippet : "";
  const classHint = loc.classHint?.trim() || "";
  const selectorHint = loc.selectorHint?.trim() || "";
  const selId = /^#([\w-]+)$/.exec(selectorHint)?.[1] ?? "";
  const selClass = /^\.([\w-]+)$/.exec(selectorHint)?.[1] ?? "";

  if (typeof loc.offsetHint === "number" && Number.isFinite(loc.offsetHint) && loc.offsetHint >= 0) {
    const window = original.slice(loc.offsetHint, loc.offsetHint + 800);
    const m = new RegExp(`<${tag}(?:\\s[^<>]*?)?>`, "i").exec(window);
    if (m) {
      const openStart = loc.offsetHint + m.index;
      const range = findElementRange(original, openStart, tag);
      if (range) return { start: range.start, end: range.end, tag };
    }
    const nodes = enclosingNodes(original, loc.offsetHint, loc.offsetHint + 1);
    const node = nodes.find((n) => n.tag === tag) ?? nodes[0];
    if (node) return { start: node.start, end: node.end, tag: node.tag };
  }

  // 打分：selectorHint(id) 5 > selectorHint(class)/classHint 4 > textSnippet 2 > tag 1。
  // 重复文案下 classHint 能拉开分差，把 LLM 指定的元素从多个同名候选里挑出来。
  const scoreNode = (node: HtmlNode): number => {
    let score = 0;
    if (node.tag === tag) score += 1;
    if (classHint || selClass) {
      const tokens = nodeClass(node).split(/\s+/).filter(Boolean);
      if (classHint && tokens.includes(classHint)) score += 4;
      if (selClass && tokens.includes(selClass)) score += 4;
    }
    if (selId && nodeId(node) === selId) score += 5;
    if (textSnippet && original.slice(node.start, node.end).includes(textSnippet)) score += 2;
    return score;
  };

  const candidates: HtmlNode[] = [];
  const pushEnclosing = (start: number, end: number) => {
    for (const node of enclosingNodes(original, start, end)) candidates.push(node);
  };

  // 1. textSnippet 所有出现位置（封顶 30 避免极端页面爆炸；enclosingNodes 每次全量 tokenize）
  if (textSnippet) {
    let from = 0;
    let idx: number;
    let count = 0;
    while (count < 30 && (idx = original.indexOf(textSnippet, from)) >= 0) {
      pushEnclosing(idx, idx + textSnippet.length);
      from = idx + textSnippet.length;
      count++;
    }
  }

  // 2. selectorHint / classHint 正则兜底（覆盖 textSnippet 未命中的元素，如无文案的图标按钮）
  if (selId) {
    const m = new RegExp(`<${tag}[^>]*\\sid=["']${selId}["']`, "i").exec(original);
    if (m) pushEnclosing(m.index, m.index + m[0].length);
  }
  if (selClass) {
    const m = new RegExp(`<${tag}[^>]*\\sclass=["'][^"']*\\b${selClass}\\b[^"']*["']`, "i").exec(original);
    if (m) pushEnclosing(m.index, m.index + m[0].length);
  }
  if (classHint) {
    const m = new RegExp(`<${tag}[^>]*\\sclass=["'][^"']*\\b${escapeRegex(classHint)}\\b[^"']*["']`, "i").exec(original);
    if (m) pushEnclosing(m.index, m.index + m[0].length);
  }

  if (!candidates.length) return null;

  // 去重（同一节点可能被多来源加入）+ 打分排序：分高优先；同分取最内层（最小元素，最具体）；
  // 仍同则取最早 start（确定）。同分场景 = 重复文案无 classHint 或 tag 不匹配，最内层比最外层合理。
  const seen = new Set<number>();
  const best = candidates
    .filter((n) => { const k = n.start; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((n) => ({ node: n, score: scoreNode(n) }))
    .sort((a, b) => b.score - a.score || (a.node.end - a.node.start) - (b.node.end - b.node.start) || a.node.start - b.node.start)[0].node;
  return { start: best.start, end: best.end, tag: best.tag };
}

/**
 * 删除元素后,若被删元素的 id 仍被页面 <script> 引用(getElementById/querySelector('#id')),
 * 重渲染时 `getElementById('id').addEventListener` 会命中 null 抛 TypeError,中断后续脚本初始化
 * (如 1.html 删 #drawerClose 后,overlay/ESC 关闭、二级抽屉等全失效;再 openDrawer 又因
 * #drawerTitle 被连带删而抛错,抽屉永久损坏)。
 *
 * 这里对被删 id 的脚本引用注入 null-safe 代理守卫:把 `document.getElementById('X')` 包成
 * `(document.getElementById('X')||__ydGuard)`。__ydGuard 是个对任意属性访问返回自身、调用返回
 * undefined、赋值 no-op 的 Proxy,让该行不抛错、脚本继续执行后续绑定。
 * 仅在确有被删 id 被脚本引用时才注入 shim + 改写引用,不动其他代码。
 */
export function guardDeletedIdScriptRefs(original: string, result: string): string {
  if (result === original) return result;
  const stripScripts = (s: string) => s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  const idsOf = (s: string) =>
    new Set((stripScripts(s).match(/\sid=["']([^"']+)["']/g) || []).map((m) => m.replace(/\sid=["']([^"']+)["']/, "$1")));
  const origIds = idsOf(original);
  const resIds = idsOf(result);
  const deletedIds = [...origIds].filter((id) => !resIds.has(id));
  if (!deletedIds.length) return result;

  const scriptBlob = (result.match(/<script[\s\S]*?<\/script>/gi) || []).join("\n");
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const referenced = deletedIds.filter((id) =>
    new RegExp(`getElementById\\s*\\(\\s*["']${esc(id)}["']|querySelector(?:All)?\\s*\\(\\s*["']#${esc(id)}["']`).test(scriptBlob)
  );
  if (!referenced.length) return result;

  // null-safe 代理:任意属性访问返回自身、调用返回 undefined、赋值 no-op。放在第一个 <script> 前,
  // 保证在任意被守卫引用执行前 __ydGuard 已定义(含 head/body 内脚本)。
  const shim = "var __ydGuard=new Proxy(function(){},{get:function(){return __ydGuard;}});";
  let out = result.replace(/<script\b/i, (m) => `<script>${shim}</script>\n${m}`);

  for (const id of referenced) {
    const e = esc(id);
    // querySelectorAll 先替换(返回 [] 才能正常迭代),再 querySelector,再 getElementById;
    // 保留原接收者链(document./window.document./裸调用),避免 `document.(...)` 语法错误。
    out = out.replace(new RegExp(`((?:[\\w$]+\\.)*)querySelectorAll\\s*\\(\\s*["']#${e}["']\\s*\\)`, "g"), "($1querySelectorAll('#" + id + "')||[])");
    out = out.replace(new RegExp(`((?:[\\w$]+\\.)*)querySelector\\s*\\(\\s*["']#${e}["']\\s*\\)`, "g"), "($1querySelector('#" + id + "')||__ydGuard)");
    out = out.replace(new RegExp(`((?:[\\w$]+\\.)*)getElementById\\s*\\(\\s*["']${e}["']\\s*\\)`, "g"), "($1getElementById('" + id + "')||__ydGuard)");
  }
  return out;
}

/**
 * 检测标注锚点(或其祖先)的内容是否被页面脚本动态设置(getElementById/querySelector('#id') 后接
 * innerHTML/textContent/insertAdjacentHTML/appendChild 等)。若是,对该元素的增删改在重渲染(脚本重跑)
 * 后会被还原--B-4:JS 注入内容不持久。返回被脚本设置内容的祖先 id(供上层发提示),无则 null。
 * 只检内容类 mutation;style/classList 重置(如改宽度)属另一类,这里不覆盖,避免对"改按钮位置"这类
 * 持久改动假阳性提示。
 */
export function detectScriptInjectedAnchor(original: string, targetHtml: string, anchorId?: string): string | null {
  const anchor = findAnchorRange(original, targetHtml, anchorId);
  if (!anchor) return null;
  const nodes = enclosingNodes(original, anchor.start, anchor.end);
  const ids = nodes.map(nodeId).filter((id): id is string => !!id);
  if (!ids.length) return null;
  const scriptBlob = (original.match(/<script[\s\S]*?<\/script>/gi) || []).join("\n");
  if (!scriptBlob) return null;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mutProps = "(?:innerHTML|textContent|insertAdjacentHTML|appendChild|append|prepend|replaceChildren)";
  for (const id of ids) {
    const e = esc(id);
    const idCall = `(?:getElementById\\s*\\(\\s*["']${e}["']\\s*\\)|querySelector(?:All)?\\s*\\(\\s*["']#${e}["']\\s*\\))`;
    // (a) 直接: getElementById('X').innerHTML= 等
    if (new RegExp(`${idCall}\\s*\\.\\s*${mutProps}\\b`, "i").test(scriptBlob)) return id;
    // (b) 间接: var V = ...getElementById('X'); V.innerHTML= (1.html 的 tableBody/tableHead 即此模式)
    const am = new RegExp(`(?:var|let|const)\\s+(\\w+)\\s*=\\s*(?:[\\w$]+\\.)*${idCall}`, "i").exec(scriptBlob);
    if (am) {
      const v = esc(am[1]);
      if (new RegExp(`\\b${v}\\s*\\.\\s*${mutProps}\\b`, "i").test(scriptBlob)) return id;
    }
  }
  return null;
}
