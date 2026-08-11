import type { Device, FlowSpec, RetrievedComponent } from "@/lib/types";

export interface StructureCheckResult {
  ok: boolean;
  issues: string[];
  refineInstruction?: string;
}

export interface StructureCheckInput {
  requirement: string;
  flow: FlowSpec;
  code: string;
  useDpl: boolean;
  device: Device;
  components?: RetrievedComponent[];
}

const MAX_ISSUES = 5;
const PLACEHOLDER_RE =
  /\bTODO\b|lorem ipsum|待补充|这里是内容|示例内容|内容区域|占位内容|待完善|敬请期待/i;
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

function compactText(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

function plainText(text: string): string {
  return text.replace(/\s+/g, " ").toLowerCase();
}

function pushIssue(issues: string[], issue: string) {
  if (issues.length >= MAX_ISSUES) return;
  if (!issues.includes(issue)) issues.push(issue);
}

function isAdminLike(requirement: string, flow: FlowSpec): boolean {
  const text = `${requirement}\n${flow.title}\n${flow.summary}\n${flow.pages
    .map((p) => `${p.name} ${p.summary}`)
    .join("\n")}`;
  return /后台|管理|台账|列表|查询|报表|看板|审批|工单|客户|订单|发票|库存|资产|用户|权限/.test(text);
}

function isListLike(requirement: string, flow: FlowSpec): boolean {
  const text = `${requirement}\n${flow.pages
    .map((p) => `${p.name} ${p.summary} ${p.sections.map((s) => `${s.name} ${s.description}`).join(" ")}`)
    .join("\n")}`;
  return /列表|台账|查询|管理|明细|记录|报表|审批|工单/.test(text);
}

function extractExplicitTerms(requirement: string): string[] {
  const terms = new Set<string>();
  const suffix =
    "(?:筛选区|查询区|统计卡片|趋势图|图表|明细表|明细|记录|列表|表格|表单|卡片|操作区|操作按钮|按钮|抽屉|弹窗|详情|日志|结果|排行|上传|校验|审批流|流程|导航)";
  const explicitRe = new RegExp(`[\\u4e00-\\u9fa5A-Za-z0-9]{0,8}${suffix}`, "g");
  const blocks = requirement.match(/(?:包含|包括|需要|展示|显示|支持|具备|带|有)([^。；;\n]+)/g) ?? [];
  const haystacks = blocks.length ? blocks : [requirement];

  for (const block of haystacks) {
    const matches = block.match(explicitRe) ?? [];
    for (const raw of matches) {
      const term = raw
        .replace(/^(包含|包括|需要|展示|显示|支持|具备|带|有)/, "")
        .replace(/^(一个|多个|主要|核心|关键)/, "")
        .replace(/等$/, "")
        .trim();
      if (term.length >= 2 && term.length <= 12) terms.add(term);
    }
  }

  return [...terms].slice(0, 12);
}

function codeContainsTerm(codeText: string, term: string): boolean {
  const compact = compactText(codeText);
  const normalizedTerm = compactText(term);
  if (compact.includes(normalizedTerm)) return true;
  const aliases: Record<string, string[]> = {
    表格: ["table", "datatable", "数据表"],
    列表: ["list", "清单"],
    筛选区: ["筛选", "查询", "filter", "search"],
    查询区: ["筛选", "查询", "filter", "search"],
    统计卡片: ["统计", "metric", "statistic", "概览"],
    趋势图: ["趋势", "chart", "折线"],
    图表: ["chart", "趋势", "统计"],
    操作区: ["操作", "action", "toolbar"],
    操作按钮: ["操作", "action", "button"],
    上传: ["upload", "上传"],
    校验: ["validate", "校验", "检查"],
  };
  return (aliases[term] ?? []).some((alias) => compact.includes(compactText(alias)));
}

function hasWideDesktopSignal(code: string): boolean {
  return /\b(?:min-)?width\s*:\s*['"]?(?:9\d{2}|1\d{3})px/i.test(code) || /span=\{(?:6|8|12)\}/.test(code);
}

function hasPhoneShellSignal(code: string): boolean {
  return /max-?width\s*:\s*['"]?(?:3[2-9]\d|4[0-3]\d)px/i.test(code) || /手机|phone-shell|mobile-shell/i.test(code);
}

function hasTableSignal(code: string): boolean {
  return /<Table\b|<table\b|\bTable\s*,/.test(code);
}

function adminSkeletonIssues(requirement: string, flow: FlowSpec, code: string, device: Device): string[] {
  if (device !== "pc" || !isAdminLike(requirement, flow) || !isListLike(requirement, flow)) return [];

  const text = plainText(code);
  const hasFilter = /筛选|查询|搜索|filter|search|<Form\b|<Input\b|<Select\b|DatePicker|Search/.test(code);
  const hasDataBody = hasTableSignal(code) || /列表|明细|记录|List\b|dataSource|\.map\(/.test(code);
  const hasAction = /新增|新建|导出|删除|批量|提交|保存|审批|处理|操作|<Button\b|button/i.test(code);

  const missing: string[] = [];
  if (!hasFilter) missing.push("筛选/查询区");
  if (!hasDataBody) missing.push("表格/列表主体");
  if (!hasAction) missing.push("关键操作按钮");
  if (missing.length >= 2 || (!hasDataBody && text.length < 5000)) {
    return [`PC 管理/列表类页面缺少${missing.join("、")}，不像可用的业务主页面。`];
  }
  return [];
}

function emojiIconIssues(input: StructureCheckInput): string[] {
  if (/emoji|表情|彩色表情/.test(input.requirement)) return [];
  EMOJI_RE.lastIndex = 0;
  const found = [...input.code.matchAll(EMOJI_RE)].map((m) => m[0]);
  if (!found.length) return [];
  const unique = [...new Set(found)].slice(0, 6).join(" ");
  const replacement = "请改用内联 SVG、CSS 线性图标、文字标签、状态点或首字母头像。";
  return [`页面中出现 Emoji/彩色表情作为图标（${unique}），视觉廉价且不符合高保真原型要求。${replacement}`];
}

function prototypeContractIssues(input: StructureCheckInput): string[] {
  const contract = input.flow.prototypeContract;
  if (!contract) return [];

  const issues: string[] = [];
  const conciseMustHave = contract.mustHave.filter((item) => item.trim().length >= 2 && item.trim().length <= 16);
  const missingMustHave = conciseMustHave.filter((item) => !codeContainsTerm(input.code, item));
  if (missingMustHave.length >= 2) {
    issues.push(`Prototype Contract 的首版必备项未清晰体现在页面中：${missingMustHave.slice(0, 4).join("、")}。`);
  }

  const mustInteractions = contract.interactions.filter((item) => item.priority === "must");
  if (!mustInteractions.length) return issues;

  const hasEventHandler =
    /\bon(?:Click|Change|Input|Submit|MouseEnter)\s*=|\bon(?:click|change|input|submit)\s*=|addEventListener\s*\(\s*["'`](?:click|change|input|submit)/.test(
      input.code
    );
  const hasVisibleStateChange =
    /useState\s*\(|\bset[A-Z][A-Za-z0-9_]*\s*\(|classList\.(?:add|remove|toggle)|\.hidden\s*=|\.style\.[\w-]+\s*=|\.(?:innerHTML|textContent)\s*=|<Modal\b|<Drawer\b|\.showModal\s*\(/.test(
      input.code
    );
  if (!hasEventHandler || !hasVisibleStateChange) {
    issues.push(
      `Prototype Contract 含 ${mustInteractions.length} 条必须可演示交互，但代码缺少完整的事件处理与可见状态变化，不能只保留静态入口或提示消息。`
    );
    return issues;
  }

  const surfaceChecks: Array<{ pattern: RegExp; expected: RegExp; label: string }> = [
    { pattern: /抽屉|drawer/i, expected: /<Drawer\b|drawer|抽屉|side[-_ ]?panel/i, label: "抽屉" },
    { pattern: /弹窗|对话框|modal|dialog/i, expected: /<Modal\b|modal|dialog|弹窗|role\s*=\s*["']dialog/i, label: "弹窗" },
    { pattern: /页签|tab|切换/i, expected: /<Tabs\b|tab[-_ ]|role\s*=\s*["']tab|页签/i, label: "页签切换" },
    { pattern: /展开|收起|expand|collapse/i, expected: /expand|collapse|展开|收起|aria-expanded/i, label: "展开/收起" },
    { pattern: /筛选|过滤|查询|搜索|filter|search/i, expected: /filter|search|筛选|查询|onSubmit|onChange/i, label: "筛选/查询" },
  ];

  for (const interaction of mustInteractions) {
    const description = `${interaction.trigger} ${interaction.result} ${interaction.proof}`;
    const missingSurfaces = surfaceChecks
      .filter((check) => check.pattern.test(description) && !check.expected.test(input.code))
      .map((check) => check.label);
    if (missingSurfaces.length) {
      issues.push(
        `必须交互「${interaction.trigger} → ${interaction.result}」缺少可见的${[...new Set(missingSurfaces)].join("、")}实现。`
      );
    }
    if (issues.length >= 3) break;
  }

  return issues;
}

export function checkGeneratedStructure(input: StructureCheckInput): StructureCheckResult {
  const issues: string[] = [];
  const code = input.code;
  const text = plainText(code);

  if (code.trim().length < 1200) {
    pushIssue(issues, "生成结果体量过小，疑似只有骨架或输出被截断。");
  }

  if (/原型代码需要重新生成|Playground 不支持的语法|生成结果仍包含/.test(code)) {
    pushIssue(issues, "生成结果是错误占位页，没有产出可用原型。");
  }

  if (PLACEHOLDER_RE.test(code)) {
    pushIssue(issues, "页面中存在 TODO、待补充或占位内容，交付感不足。");
  }

  if (input.device === "mobile") {
    if (hasTableSignal(code) && hasWideDesktopSignal(code)) {
      pushIssue(issues, "移动端结果出现宽表格或桌面栅格，容易在手机视口溢出。");
    }
    if (!/max-?width\s*:\s*['"]?(?:3[2-9]\d|4[0-3]\d)px/i.test(code) && !/NavBar|List|Tabs|Card|SafeArea|TabBar/.test(code)) {
      pushIssue(issues, "移动端结果缺少窄屏容器或移动端列表/卡片/导航结构。");
    }
  } else if (isAdminLike(input.requirement, input.flow) && hasPhoneShellSignal(code) && !hasTableSignal(code)) {
    pushIssue(issues, "PC 端业务页面被做成手机壳布局，目标端不匹配。");
  }

  for (const issue of adminSkeletonIssues(input.requirement, input.flow, code, input.device)) {
    pushIssue(issues, issue);
  }

  for (const issue of emojiIconIssues(input)) {
    pushIssue(issues, issue);
  }

  for (const issue of prototypeContractIssues(input)) {
    pushIssue(issues, issue);
  }

  const explicitTerms = extractExplicitTerms(input.requirement);
  const missingTerms = explicitTerms.filter((term) => !codeContainsTerm(text, term));
  if (missingTerms.length >= 2) {
    pushIssue(issues, `需求明确点名的模块未体现在页面中：${missingTerms.slice(0, 4).join("、")}。`);
  }

  return {
    ok: issues.length === 0,
    issues,
    refineInstruction: issues.length
      ? `结构自检发现以下问题，请只做最小修正：\n${issues.map((i) => `- ${i}`).join("\n")}`
      : undefined,
  };
}
