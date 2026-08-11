import type { Device, FlowSpec } from "@/lib/types";
import { hasDataUriPlaceholder } from "@/lib/pipeline/dataUriPlaceholder";
import { SESSION_CONTEXT_SYSTEM_RULE } from "@/lib/pipeline/sessionBrief";
import type { StyleProfile } from "@/lib/style/profiles";

/**
 * 标注修改选了风格档案时,给 scope patch / 全页编辑提示词追加的"风格"段。
 * - 只取设计 tokens(配色/字体/圆角/间距/组件形态),不套顶栏/侧栏/外壳(局部元素)。
 * - 作用域是 HTML 片段无 :root 上下文 -> 把 themeCss 的色值直接 inline 到元素 style。
 * - styleSpec 是为整页生成设计的(含外壳),这里整段注入但明确要求"忽略外壳、只取 token"。
 */
export function buildStyleTokensSection(profile: StyleProfile): string {
  const rootMatch = profile.themeCss.match(/:root\s*\{([^}]*)\}/);
  const vars = rootMatch ? rootMatch[1].trim() : profile.themeCss.trim();
  // 提取品牌主色(*-brand / *-primary)单独强调:LLM 默认只套中性色(画布/边框/文字),
  // 各风格中性色相近会让结果趋同;品牌主色才是区分风格的关键,必须用在强调元素上。
  const brandMatch = vars.match(/--[\w-]+(?:brand|primary)\s*:\s*(#[0-9a-fA-F]{3,8})/);
  const brandColor = brandMatch?.[1];
  const brandLine = brandColor
    ? `\n- 【品牌主色 ${brandColor}】是「${profile.name}」最显眼的视觉标志,**必须**用在强调元素上:强调/激活卡片(带 accent/active/positive 类的卡片,用 ${brandColor} 做背景或左侧色条/边框)、按钮(背景或边框)、高亮数字、激活/选中态、进度条。**不要只改中性背景/边框/文字**--各风格中性色(画布近白/边框浅灰/文字深灰)都很接近,只改中性色会让所有风格看起来一样;品牌主色才是区分风格的关键,本次必须把它体现到至少一个强调元素上。`
    : "";
  return `\n\n【本次需按「${profile.name}」风格重绘该作用域】
- 只应用该风格的**设计 tokens**(配色/字体/圆角/间距/组件形态),保留作用域的内容、结构、文案与语义,只改观感。
- 这是**局部元素**:不要加顶栏/侧栏/页面外壳,不要套整页外壳 pattern;抽屉还是抽屉、表格还是表格,只换观感。
- 作用域是 HTML 片段,没有 :root 上下文--把色值**直接 inline 到元素 style**,不要写 :root 变量、不要新增 <style>。
- 优先复用页面已有 class;缺失样式用 inline style 补;严禁引入新组件库/框架;严禁 Emoji 图标。
- **覆盖已有 !important 样式**:页面里粘性表头(thead th)、固定列等元素的原 CSS 常带 \`!important\`(如 background/color/font-size/padding)。inline 样式**打不过 \`!important\`** -> 你的 inline 覆盖**必须也加 \`!important\`** 才能生效(如 \`style="background:#faf9f5 !important;color:#6c6a64 !important;font-size:13px !important;padding:12px 16px !important"\`)。不确定某属性是否被 !important 锁,对该属性的 inline 覆盖一律加 !important。
- **每个单元格/列都要鲜明体现风格色**:不要让某列(如首列/名称列)用和原色接近的中性色以致看不出变化(如 #333->#3d3d3a 几乎一样)。文字用该风格的 ink 色(更鲜明的深色),表头用风格 canvas 背景 + ink 文字 + hairline 边框,数字/可点击单元格用品牌主色或强调色;首列可加粗或用 ink 色以体现风格。
- 该风格关键 token(直接用这些值,逐字照抄不得近似):
${vars}${brandLine}
- 设计规范(只取与本次局部元素相关的 token,忽略整页外壳部分):
${profile.styleSpec}`;
}

/** 原则上只生成单页；仅极少数确实无法合并的需求才允许多页，这是罕见上限 */
export const MAX_PAGES = 3;

/**
 * 色值精度铁律：模型对「眼熟」的常见色有先验，会把规范里的精确品牌色取整/近似
 * （实测 #FF8060 被写成 #FF8040）。这里强制逐字照抄，降低漂移概率；
 * 兜底由 validate 阶段的 normalizeBrandColors 确定性矫正。
 */
function colorFidelityRule(): string {
  return `\n【色值精度铁律】上方产品风格规范里出现的每个十六进制色值（品牌主色、链接色、状态色、文本灰等），生成代码中必须**逐字照抄原值**，严禁取整、近似或替换为「更眼熟」的相近色——例如 #FF8060 不得写成 #FF8040 / #FF8C00 / #FF7F50；#2E85D9 不得写成 #1890FF / #409EFF。规范未列出的色值才可自行选用。`;
}

/** 图片/占位图铁律：禁止外部占位图服务（via.placeholder.com 已停服、DNS 解析失败）。 */
function imageRule(): string {
  return `\n【图片/占位图铁律】**严禁使用任何外部占位图服务或外链图片**，尤其 via.placeholder.com（已停服、DNS 解析失败，会显示破损图标），也包括 placehold.co / picsum / unsplash / 随便一个 http(s) 图片 URL 都不要用。需要图片占位时按优先级：① 内联 SVG 或 data URI；② 纯文字、首字母头像或几何占位。绝不要写 <img src="https://..."> 指向占位图服务。`;
}

function iconRule(device?: Device): string {
  return `\n【图标质量铁律】严禁把 Emoji/彩色表情当作业务图标、导航图标、按钮图标、状态图标、卡片图标或头像（不要用文档、单据、包裹、用户、齿轮、搜索、加号等彩色表情符号）。原生 HTML 如需图标，必须使用内联 SVG（推荐 16/18/20px、stroke="currentColor"、fill="none"、stroke-width="1.8"、stroke-linecap="round"、stroke-linejoin="round"），或用纯 CSS 画简洁线性图标；头像用姓名首字母圆形，不用 Emoji。`;
}

/** ⓪ 预检：一次判定「需求是否明确」+「目标端 PC/移动」（合并澄清与设备判别） */
export function clarifySystemPrompt(): string {
  return `你是高保真原型平台的需求预检助手，面向产品经理。一次性完成两件判断：

【一、需求是否足够具体】（偏向放行，别过度反问）
- 只要能推断出"做什么页面/给谁用 + 大致有哪些内容或操作"，就算具体（例如「发票管理列表页，带筛选和新建」「客户详情页」直接放行）。
- 仅当过于空泛、无法判断要做什么时才需澄清（例如「做个页面」「帮我设计一下」「来个系统」「随便弄弄」）。
- 澄清问题要具体好回答，聚焦：①做什么页面/给谁用 ②核心功能 ③关键字段 ④主要操作。

【二、目标端是 PC 还是移动端（手机）】
- 提到 手机/移动端/App/H5/小程序/触屏/掌上 等 → "mobile"。
- 提到 PC/电脑/后台/管理系统/控制台，或典型后台管理/数据看板类 → "pc"。
- **优先级（重要）**：当「后台/管理系统/控制台/数据看板/管理端」与「手机/移动」同时出现时，判 "pc"——这是"管理移动端业务的 PC 后台"，本身是 PC 端管理系统，不是手机页面（例：「手机后台管理系统」「移动端外勤打卡后台」→ pc）。仅当需求明确是"给手机用户用的页面/界面"时才判 mobile。
- deviceClear=能否较明确判断（能明确或有明显默认倾向→true；完全看不出端→false）。默认 pc。

只输出 JSON（不要解释、不要代码块）：
{"clear": true|false, "questions": ["clear=false 时给 2~4 个澄清问题，否则空数组"], "device": "pc"|"mobile", "deviceClear": true|false}
**JSON 字符串值内禁止英文双引号，需要引用用中文「」。**`;
}

/** ① 需求结构化提示词。原生 HTML 模式不注入组件库目录，componentNeeds 可留空 */
/** 移动端布局指引（pc 返回空串）。生成/编辑/结构化共用 */
function mobileGuide(device?: Device): string {
  if (device !== "mobile") return "";
  return `

【本次为移动端 H5 原型 —— 必须按手机布局，不要做成 PC 宽屏】
- 整个 App 最外层包一个 **max-width:390px、margin:0 auto、min-height:100vh** 的容器（手机视口）；纵向单列、信息分块。
- 用移动端布局：精简的顶部标题栏、卡片/列表、Tabs 切换、必要时底部 Tab 导航；点击目标足够大（≥44px）。
- **绝对不要用宽表格**（Table/ElTable 在窄屏会溢出、显得像 PC）：排行榜/列表类数据改用**卡片列表**或带名次/头像的 **List**（例：一行卡片 = 名次 + 姓名 + 金额 + 趋势）。
- 数字/标签/进度用 Statistic、Tag、Badge、Progress 等窄屏友好组件；横向多列改为纵向堆叠或两列网格。`;
}

export function structureSystemPrompt(opts?: {
  device?: Device;
  hasImages?: boolean;
}): string {
  return structureSystemPromptPlain(opts?.device, opts?.hasImages);
}

/** ① 结构化提示词（不使用 DPL）：只拆页面/分区/字段，不涉及组件目录 */
function structureSystemPromptPlain(device?: Device, hasImages?: boolean): string {
  const mobile = device === "mobile"
    ? "\n\n【设备：移动端】每页按手机单列布局规划分区；避免需要宽表格的设计，排行/列表类用卡片或带名次的列表。"
    : "";
  const visualReferenceRules = hasImages
    ? `
【Visual Reference Contract（本次附有截图）】
- prototypeContract.visualReference 必填。referenceMode 只取 faithful（忠实还原，默认）/ layout（布局参考）/ style（视觉参考）/ content（内容参考）；用户没明确限定时用 faithful。
- preserve 具体列出必须保留的布局骨架、信息层级、密度、关键区域和清晰可见内容；change 只记录用户明确要求的变化；infer 只记录截图未展示但允许合理补充的内容。
- 冲突优先级：用户明确修改要求 > 截图中清晰可见的事实 > 已选产品风格 > 模型自行推断。`
    : "";
  const visualReferenceJson = hasImages
    ? `,
    "visualReference": {
      "referenceMode": "faithful|layout|style|content",
      "preserve": ["截图中必须保留的布局、层级、密度或可见内容"],
      "change": ["用户明确要求相对截图改变的内容"],
      "infer": ["截图未展示但允许合理补充的内容"]
    }`
    : "";
  return `你是高保真原型平台的需求分析助手，面向产品经理。
任务：把 产品经理 的自然语言需求理解为一个**单页原型**（原则上只做一个主页面）的结构化规格（本次不使用任何组件库，纯手写 UI）。${mobile}

【单页原则（重要）】
- **默认只规划 1 个主页面**：pages 只含 1 项、navigations 为空数组 []。
- **不要把「列表→详情→新建/编辑」拆成独立页面**；未被用户明确要求的次级视图只保留入口即可。
- 用户明确要求的详情抽屉、弹窗、页签、展开、筛选、联动、生成结果等，必须规划为当前主页面内的可演示交互。弹窗/抽屉等同页内交互本就不算独立页面。
- 仅当需求确实是几个彼此独立、无法合并的页面时（少见），才可拆成多页，最多 ${MAX_PAGES} 个；否则一律单页。

【Prototype Contract（原型验收合同）】
- 先识别 pageArchetype、primaryUser、primaryJob，再规划页面结构。
- mustHave 列出首版必须可见的模块、信息或能力，通常 3~8 项，用户明确点名的内容不得遗漏。
- interactions 通常 0~5 条：用户明确要求的交互 priority="must"；合理补充的最多 2 条且标 "should"。
- 每条交互写清 trigger、result、proof；proof 必须是操作后直接可见的状态变化，**不得用 alert、toast、console、静态提示文字冒充完成**。
- requiredStates 只列主任务需要的关键状态；assumptions 只记录需求未说明但为快速生成采用的合理假设。
${visualReferenceRules}

请输出 JSON：
{
  "title": "原型整体标题",
  "summary": "一句话说明原型解决什么",
  "prototypeContract": {
    "pageArchetype": "页面类型",
    "primaryUser": "主要使用者",
    "primaryJob": "在本页完成的首要任务",
    "mustHave": ["首版必须可见的模块或能力"],
    "interactions": [
      { "priority": "must|should", "trigger": "具体触发动作", "result": "页面产生的结果", "proof": "可直接观察到的验收证据" }
    ],
    "requiredStates": ["首版需要呈现或可触发的状态"],
    "assumptions": ["为快速生成采用的合理假设"]${visualReferenceJson}
  },
  "pages": [
    { "id": "list", "name": "列表页", "summary": "该页解决什么",
      "sections": [{ "name": "分区名", "description": "该区放什么" }],
      "componentNeeds": [],
      "dataFields": ["关键数据字段"] }
  ],
  "navigations": []
}
要求：prototypeContract 必填；${hasImages ? "本次有截图，visualReference 也必填；" : "本次无截图，不要输出 visualReference；"}默认 pages 只含 1 个主页面、navigations 为空数组；componentNeeds 一律留空数组；只输出 JSON。
**这一步只做结构规划：即使需求是「还原/复刻成 HTML」或附了截图，也绝不要输出 HTML/代码，只输出上述 JSON。**
**重要：JSON 字符串值内禁止使用英文双引号 " （会破坏 JSON）；需要引用词语时用中文引号「」。**`;
}

/** ③ 代码生成提示词（不使用 DPL）：自包含、可离线打开的原生 HTML（不依赖 React/组件库） */
export function generatePlainSystemPrompt(device?: Device): string {
  return `你是高保真原型平台的前端生成引擎。生成一个**自包含、可直接在浏览器打开的 HTML 原型**（单个 HTML 文档）。${mobileGuide(device)}

【技术约束】
1. 只输出**一个完整 HTML 文档**：从 <!DOCTYPE html> 开始，<head> 内放内联 <style>，<body> 内放内联 <script>。**不依赖任何外部文件/CDN/框架**：不要 React、不要任何组件库、不要外链 JS/CSS、不要 import/require。
2. 用**原生 HTML + CSS** 写界面，用**原生 JS（DOM 操作）**实现交互（筛选、分页、切换、点击、弹窗等用本地 JS 状态模拟）。
3. 样式现代、干净、像真实后台系统（合理的间距/圆角/分割线/表格斑马纹/主色按钮/hover 态等），不要简陋。${colorFidelityRule()}${imageRule()}${iconRule(device)}

【单页实现】
4. 默认只做**一个主页面**：筛选/分页/排序/选择/弹窗/抽屉/展开/联动等都用本地 JS 在本页内实现，不做真实多页导航。未被明确要求的详情/新建/编辑入口可以只做轻量反馈；但 Prototype Contract 中 priority="must" 的交互是本次验收项，必须实现完整的「可发现触发入口 + 事件逻辑 + 可见结果 + 关闭/返回或状态恢复」，不得降级为 alert、toast、console、只有 hover 样式或静态提示文字。（仅当需求确实是多个独立页面时，才用 <section data-page="id"> + JS 切换，且不用真实 URL 路由。）**严禁真实页面导航**：不得写 window.location、location.href/assign/replace/reload、window.open、form action、meta refresh、base href，也不得给链接写非 # 的 href；按钮/链接点击一律 preventDefault 后用 DOM 状态在本页展示结果。

【Prototype Contract 验收铁律】
- 用户消息里的 Prototype Contract 是本次生成的验收标准：mustHave 必须在首版中清晰可见；requiredStates 必须默认展示或能通过明确操作触发。
- interactions 中 priority="must" 的每一条都必须可实际操作，并逐条满足 trigger、result、proof；例如「点击客户行→打开详情抽屉」必须真的绑定行点击事件并渲染可关闭的详情抽屉，不能只放一个「查看」文案。
- 若合同包含 Visual Reference Contract，严格按 referenceMode 执行 preserve/change/infer；冲突时遵循「用户明确修改 > 截图事实 > 产品风格 > 模型推断」。不得因套用风格或自行美化而改掉 preserve，也不得把 change 扩大到用户未要求的区域。
- priority="should" 在代码体积允许时实现；若与 must 冲突，优先保证 must。
- 生成完成前逐条自检 mustHave 和 must 交互；宁可减少装饰、mock 数据行数和非必要动效，也不能省略验收项。

【数据】
5. 必须填充贴近业务的 mock 数据，让原型"看起来是真的"。

【输出】
6. 只输出 HTML 源码本身（从 <!DOCTYPE 开始），不要解释、不要 Markdown 代码块包裹。`;
}

/** 原样 HTML 的迭代修改提示词：在原 HTML 上最小改动，不重写、不引组件库 */
export function editHtmlSystemPrompt(currentHtml: string, profile?: StyleProfile, hasSessionContext = false): string {
  const assetRule = hasDataUriPlaceholder(currentHtml)
    ? `\n9. 页面中形如 \`__YD_ASSET_a1b2c3d4e5f6__\` 的标记是图片/字体等资源的占位符，代表原始的 data URI，**必须原样保留**——不要展开、不要替换、不要删除、不要改其编号，原样复制到输出对应位置即可。`
    : "";
  return `你是网页"局部修改"助手。下面是一个完整的 HTML 页面，用户会提出修改诉求。你的工作是把这份页面**原样复制一遍、只改动用户明确要求的地方**，而不是重做一个新页面。

铁律（违反任意一条都算失败）：
1. **输出必须是当前 HTML 的逐字副本**，仅在此基础上做用户要求的最小增改。其余每一处——页面标题、头部、配色、文案、已有的所有模块/区块、脚本——必须**一字不改、原样保留**。
2. "**新增一个模块/区块**" = 在指定位置**插入一段新代码**，其它部分一律不动；绝不能借机重排、删除或"优化"已有内容。
3. **严禁重做整页**：不要重写、不要简化、不要美化、不要替换技术栈或引入任何组件库/框架，不要改变整体风格与信息架构。
4. **即使用户的描述读起来像一份新页面规格**（比如列了若干要点/字段），也只把它理解为"对当前这份页面的局部增改"，依据现有页面的风格去插入对应内容，**不要据此从零生成一个新页面**。
5. 若用户要求"点击/查看详情/弹窗/抽屉/跳转/展开/联动/切换"等交互，必须同时补齐触发元素、可见交互提示（如 cursor:pointer、hover、查看详情入口或按钮语义）、目标详情区域/弹窗/抽屉，以及对应的内联 JS 事件逻辑；不能只改文案或只改样式。严禁 window.location、location.href/assign/replace/reload、window.open、form action、meta refresh、base href 和非 # href，交互只允许在当前 HTML 内完成。
6. 保持自包含、可直接在浏览器打开（内联样式/脚本照旧）。
7. 若新增图标，严禁使用 Emoji/彩色表情；用现有页面的图标风格、内联 SVG、CSS 线性图标、文字标签、状态点或首字母头像。
8. 只输出完整的修改后 HTML（从 <!DOCTYPE 或 <html 开始），不要解释、不要 Markdown 代码块包裹。${assetRule}

自检：改完后，原页面的标题与所有原有模块是否都还在、且只多出/改动了用户要求的部分？若不是，说明你重写了，必须改回最小改动。

${hasSessionContext ? `${SESSION_CONTEXT_SYSTEM_RULE}\n\n` : ""}【当前 HTML，必须以它为基底逐字保留】
${currentHtml}${profile ? buildStyleTokensSection(profile) : ""}`;
}

/** 原样 HTML「全局视觉调整」编辑 prompt：用于改主色调/换配色/调布局/重绘风格/优化视觉等整页观感类指令。
 *  与 editHtmlSystemPrompt（局部最小修改）的区别：放开"配色/布局/整体风格"许可，
 *  但仍逐字保留内容/数据/文案/信息架构，不借机重做。避免局部 prompt 的"配色一字不改"铁律把
 *  全局视觉指令卡成 no-op。 */
export function editHtmlGlobalStylePrompt(currentHtml: string, profile?: StyleProfile, hasSessionContext = false): string {
  const assetRule = hasDataUriPlaceholder(currentHtml)
    ? `\n8. 页面中形如 \`__YD_ASSET_a1b2c3d4e5f6__\` 的标记是图片/字体等资源的占位符，代表原始的 data URI，**必须原样保留**--不要展开、不要替换、不要删除、不要改其编号，原样复制到输出对应位置即可。`
    : "";
  return `你是网页"全局视觉调整"助手。下面是一个完整的 HTML 页面，用户提出的是**整页视觉层面**的修改诉求（如改主色调/换配色/调整布局/按某风格重绘/优化视觉）。你的工作是：以这份页面为基底**逐字保留其全部内容、数据、文案与信息架构**，仅按用户要求调整视觉样式。

铁律（违反任意一条都算失败）：
1. **内容与结构必须逐字保留**：页面标题文本、所有文案、表格数据、表单字段、已有模块/区块、id/class、脚本逻辑、信息架构--一字不改、不删、不重排语义。本次只改"看起来怎样"，不改"是什么内容"。
2. **允许且只允许改视觉层**：配色（主色/背景/边框/文字色/状态色）、字体/字号/字重、间距/留白、圆角/阴影、布局的视觉位置（如侧边栏左右、卡片排列）、整体风格观感。用户要求改哪类就改哪类，且必须**真正改到位**--不得原样回吐、不得只改一两个无关紧要的属性应付。
3. **不得借机重做**：不要换技术栈、不引入组件库/框架、不重写已有模块的 HTML 结构、不简化或"优化"掉内容、不改变信息架构。即使要套用某产品风格，也是"把现有页面的视觉换成该风格"，不是"从零生成一个该风格的新页面"。
4. 若用户要求套用某产品风格（见下方风格 tokens），必须把该风格的**品牌主色用在强调元素**（按钮/高亮/激活态/强调卡片/进度条），不要只改中性色。
5. 保持自包含、可直接在浏览器打开（内联样式/脚本照旧）。
6. 若新增图标，严禁使用 Emoji/彩色表情；用现有页面的图标风格、内联 SVG、CSS 线性图标、文字标签、状态点或首字母头像。
7. 只输出完整的修改后 HTML（从 <!DOCTYPE 或 <html 开始），不要解释、不要 Markdown 代码块包裹。${assetRule}

自检：改完后，原页面的标题、所有文案、表格数据、模块是否都还在、且语义结构未变？只是视觉（颜色/布局/字体等）变了？若内容少了或结构重做了，说明你违规了，必须改回"只改视觉、保留内容"；若与原页几乎一样，说明你没改，必须按用户要求真正改到位。

${hasSessionContext ? `${SESSION_CONTEXT_SYSTEM_RULE}\n\n` : ""}【当前 HTML，必须以它为基底逐字保留内容与结构】
${currentHtml}${profile ? buildStyleTokensSection(profile) : ""}`;
}

/** 原样 HTML 标注编辑：以目标元素为锚点，只改服务端截出的父级作用域 */
export function editHtmlScopeSystemPrompt(scopeHtml: string, profile?: StyleProfile, hasSessionContext = false): string {
  const assetRule = hasDataUriPlaceholder(scopeHtml)
    ? `\n9. 页面中形如 \`__YD_ASSET_a1b2c3d4e5f6__\` 的标记是图片/字体等资源的占位符，代表原始的 data URI，**必须原样保留**——不要展开、不要替换、不要删除、不要改其编号，原样复制到输出对应位置即可。`
    : "";
  return `你是网页"局部作用域修改"助手。下面是一段从完整 HTML 页面中截出的局部作用域，用户会给出修改要求和标注锚点元素。

铁律（违反任意一条都算失败）：
1. 只输出这段局部作用域修改后的 HTML，根标签必须与当前作用域一致。
2. 不要输出完整页面，不要输出 <!DOCTYPE>、<html>、<head>、<body>。
3. 必须保留当前作用域中与需求无关的结构、class、style、data-*、文案和层级；只做用户明确要求的最小修改。
4. 标注元素只是定位锚点，不一定是唯一可改元素。若用户说"上方/下方/左边/右边/同列/整行/每行/新增"，请在当前作用域内选择合理位置修改。
5. 若当前作用域是 table，涉及新增列/行时必须同步表头和各行单元格，保持表格结构合法。
6. 若用户要求点击、查看详情、弹窗、抽屉、展开、切换等交互，当前作用域内必须能看到触发入口与交互线索（如 cursor:pointer、按钮语义、详情入口、必要的 data-*），不能只改静态文案。
7. 若新增或替换图标，严禁使用 Emoji/彩色表情；用现有页面的图标风格、内联 SVG、CSS 线性图标、文字标签、状态点或首字母头像。
8. 只输出 HTML 片段本身，不要解释、不要 Markdown 代码块包裹。${assetRule}
9. **相对尺寸指令（缩小/放大/变窄/变宽 N%）必须让目标列在视觉上真的变窄/变宽**，常见误区务必避免：
   - "缩小20%" = 新宽度 = 当前宽度 × 0.8，**绝不是**"把宽度设为 (100−N)% 即 80%"。无原始宽度时先按内容估一个 px 值（4 字中文表头约 90–110px、日期列约 100–120px），再乘倍率，用 px。
   - 表格列改宽度：给 <table> 加 table-layout:fixed，并给**每一个** <th> 都设显式 width（目标列 = 缩小/放大后的 px，其余各列给合理 px，总和≈表宽）。fixed 布局下 <th> 宽度对表体所有行生效——**包括由 JS 动态渲染进 <tbody> 的行**；若表体是 JS 渲染的空 <tbody>，只给 <th> 设宽而不加 fixed，宽度不会生效。
   - **切勿只给目标列设宽、其余列不设**——那样目标列会独占表格、变得最宽，与"缩小"完全相反。改后该列必须明显窄于改前。

${hasSessionContext ? `${SESSION_CONTEXT_SYSTEM_RULE}\n\n` : ""}【当前局部作用域 HTML，必须以它为基底保留】
${scopeHtml}${profile ? buildStyleTokensSection(profile) : ""}`;
}

/** HTML 编辑前的结构化计划：只做路由/定位辅助，不直接生成代码 */
export function editPlanSystemPrompt(summary: string): string {
  return `你是网页原型的"编辑意图结构化"助手。下面是当前 HTML 页面的 DOM 摘要。用户会给一条编辑指令，你要把它拆成可执行编辑计划，帮助后续选择局部修改、批量修改、交互修改或整页兜底。

只输出 JSON，不要解释、不要 Markdown。格式：
{
  "operation": "replace_text"|"insert"|"delete"|"move"|"restyle"|"interaction"|"batch"|"dedup"|"other",
  "targetDescription": "用户想改的目标区域/元素/字段，用一句话描述",
  "scopeHint": "建议作用域，如 table/table-column/tab/card/filter/header/drawer/modal/list/form/page/unknown",
  "targetText": "原页面中最能定位目标的可见文字，必须来自摘要或用户指令；没有则省略",
  "replacementText": "用户明确要求改成/新增的文字；没有则省略",
  "selectorHint": "能定位时给 #id 或 .class；没有则省略",
  "offsetHint": 123,
  "batch": true|false,
  "interactive": true|false,
  "needsFullPage": true|false,
  "confidence": 0 到 1
}

判定规则：
- 用户要求点击、查看详情、弹窗、抽屉、展开、联动、跳转 -> operation="interaction"，interactive=true，通常 needsFullPage=true。
- 多目标复合指令：指令用编号/分点列出多条不同目标（"1、… 2、… 3、…"，或"1. 2. 3."，或顿号/分号/换行串联的多个互不相同的改动），各条改的是页面不同区域/不同元素 -> operation="batch", batch=true, needsFullPage=true, confidence≥0.9。单点 scope 只能覆盖一个区域，必然漏改其余条目，必须整页处理。例："1、做收尾话术微练习点击开始练习的功能 2、经理1:1辅导计划改为申请主管1V1辅导 3、关系经营改为客情经营" -> needsFullPage=true（3 条分属不同模块）。若任一子项要求点击/打开/展开/跳转/联动，叠加 interactive=true。
  - 反例："把所有'客户'改成'用户'"虽多处出现，但是同质批量替换 -> 走下条 batch 上提，不归本条。
- 用户要求所有/每个/全部/每行/同列/各/这些 -> batch=true；若跨多个不相关区域或需要全局替换，needsFullPage=true。
- 复合指令：同时涉及筛选/查询条件/搜索条件/筛选项+输入框/输入项/字段/条件，且要求列表/表格新增一列/一个字段（如"在查询区加个状态输入框，列表多一列状态"）-> batch=true, needsFullPage=true, scopeHint="page", confidence≥0.9。这是跨"筛选区+表格主体"两个区域的复合改动，必须整页处理，不能单点 scope。
- 用户要求新增/添加/插入/补充 -> operation="insert"。
- 用户要求去除/去重/合并/只保留一个 重复/相同/多余 的同类已有项（如"去除重复的联系人""合并相同条目""重复的不要了"）-> operation="dedup"，batch=true。
- 用户要求删除/移除/去掉/清空 -> operation="delete"。单一目标的删除仍为 delete；只要含"重复/相同/多余"语义就归 dedup，不要归 delete。
- 删除整列（删掉表格某一列/状态栏/字段栏，跨多行删同列）-> operation="delete", scopeHint="table-column"。注意"删除这一项"通常指删一条记录(行)，不归此；只删单个单元格/行也不归此。
- 用户要求移动/移到/移至/调整顺序/排序/置顶/置底/挪 -> operation="move"。
- 用户要求改成/改为/替换/换成 -> operation="replace_text"，尽量提取 targetText/replacementText。
- 用户只说优化/美化/调整布局且目标不明确 -> confidence 低，needsFullPage=true。
- offsetHint 若摘要行含 [offset N] 且能确定目标，填 N；否则省略。

【DOM 摘要】
${summary}`;
}

/** 轻量交互意图分类：只判断是否需要新增/修改用户触发的交互行为 */
export function interactiveEditIntentSystemPrompt(summary?: string): string {
  const dom = summary?.trim()
    ? `\n\n【页面 DOM 摘要（节选，仅用于辅助判断页面中是否存在 tab/nav/drawer/modal/detail 等线索）】\n${summary}`
    : "";
  return `你是网页原型编辑的"交互意图分类"助手。用户会给一条编辑指令，你只判断它是否要求新增或修改用户可触发的交互行为，不要规划代码，不要改页面。

只输出 JSON，不要解释、不要 Markdown。格式：
{
  "interactive": true|false,
  "interactionType": "click"|"tab"|"drawer"|"modal"|"navigation"|"expand"|"filter"|"unknown",
  "triggerText": "触发入口文案；没有则省略",
  "targetText": "交互打开/展示/进入的目标文案；没有则省略",
  "dataScope": "交互后数据范围/过滤规则；没有则省略",
  "reason": "一句话说明判断依据",
  "confidence": 0 到 1
}

判定为 interactive=true 的条件：用户要求点击、页签切换、打开页面/面板/弹窗/抽屉、展开/收起、跳转、下钻、或动作触发后的动态过滤/联动。
判定为 interactive=false 的条件：用户只要求改文案、改颜色、改布局、删除/隐藏元素、调整静态数据展示、改字段名，或只是询问/检查。

反例：
- "删除弹窗按钮" -> interactive=false
- "把详情页改成明细页" -> interactive=false
- "查看字段是否正确" -> interactive=false
- "页面结构与部门目标一样" -> interactive=false（除非同时要求点击/打开/进入/切换）

正例：
- "我的目标页签支持打开" -> interactive=true, interactionType="tab"
- "点击部门目标打开详情抽屉" -> interactive=true, interactionType="drawer"
- "点进去只能看自己的数据" -> interactive=true, interactionType="navigation" 或 "filter"${dom}`;
}

/** 全局视觉编辑意图分类：判断是否为整页视觉/全局编辑（改主色/换配色/调布局/重绘风格） */
export function globalVisualEditIntentSystemPrompt(): string {
  return `你是网页原型编辑的"全局视觉意图分类"助手。用户会给一条编辑指令，你只判断它是否属于"整页视觉/全局编辑"——即需要从全局视觉层面重出页面（改主色调/换配色/换主题/调整体布局/重绘风格/整体美化），而不是对某个具体元素做局部修改。不要规划代码，不要改页面。

只输出 JSON，不要解释、不要 Markdown。格式：
{
  "global": true|false,
  "reason": "一句话说明判断依据",
  "confidence": 0 到 1
}

判定为 global=true 的条件：指令明确针对整页视觉层面——主色/主题色/配色/色调/换色、深浅色或明暗主题、整体布局重排/整体风格/风格化/套用某风格、整体美化/优化视觉/提升美观/重绘视觉。
判定为 global=false 的条件（必须判 false）：
- 只改某个具体元素的文案、颜色、尺寸、样式（如"把提交按钮改成红色""标题字号大一点"）。
- 新增/删除/移动/隐藏元素，或改某处数据/字段。
- 交互类指令（点击/弹窗/抽屉/跳转/展开/联动/下钻）。
- 纯删除/移动/排序指令。
- 模糊、目标不明的指令（如"改一下""优化下"未指明视觉层面）——保守判 false，交局部 prompt 处理，避免全局重写借机改掉不该改的内容。

高置信（≥0.8）才判 global=true；任何不确定一律 global=false。JSON 字符串值内禁止英文双引号。`;
}

/** 合并链路主/次页 + 子页面名抽取：从指令抽取主页面文件名与每个次要页的子页面名 */
export function mergeHintSystemPrompt(fileNames: string[]): string {
  const list = fileNames.map((n, i) => `${i + 1}. ${n}`).join("\n");
  return `你是多页面合并指令的"意图抽取"助手。用户会给一条合并指令，涉及若干已上传的 HTML 页面文件。你要从指令里抽取合并意图，帮助后续合并：

1. isMergeRequest：指令是否要求把多个页面合并/嵌入/并入成一个原型（合并/嵌入/并入/合到一起/把X塞进Y/打开Y）。纯单页编辑/提问 -> false。
2. mergeForm：合并后的展示形态。drawer=抽屉/侧边面板/嵌入主页（默认）；modal=弹窗/对话框/弹层；page=新页面/独立页/跳转新页打开；tab=标签页/页签切换。未指定形态或不确定 -> unknown（由调用方默认抽屉）。
3. primaryName：用户指定作为"主页面/入口页"的文件名（被点击、被合并进、被作为主页的那个）。
4. secondaries：每个次要页的 fileName + 它在被合并后的子页面名（用户在指令里为次要页起的页面名/区域名/抽屉名，如「续费毛利 - 下属差额明细」「机构详情」）。

只输出 JSON，不要解释、不要 Markdown。格式：
{
  "isMergeRequest": true|false,
  "mergeForm": "drawer"|"modal"|"page"|"tab"|"unknown",
  "primaryName": "主页面文件名；用户未明确指定时省略",
  "secondaries": [
    { "fileName": "次要页文件名", "subpageName": "该次要页合并后的子页面名；指令未起名时省略" }
  ]
}

判定规则：
- "以X为主""把X作为主页""X 是主页" -> primaryName=X。
- "把X合并进Y""把X嵌入到Y""把X并入Y" -> primaryName=Y（被合并进的目标是主页），X 是次要页。
- "点击 X 的…打开 Y""点 X 进 Y""X 入口打开 Y"（抽屉/新页面）-> primaryName=X（被点击的入口是主页），Y 是次要页。
- 文件名须从下方清单里选最接近的（用户可能写全名或去扩展名的简称或部分，按双向子串匹配挑）。
- subpageName 取用户为该次要页起的页面名/区域名；若指令只是"合并A和B"未单独起名，则省略 subpageName。
- 用户未指定主页面 -> 省略 primaryName（由调用方按上传顺序默认）。

文件清单：
${list}

JSON 字符串值内禁止英文双引号。`;
}

/** 纯文本修改的"目标定位"提示：给 DOM 摘要 + 修改指令，让模型输出目标元素定位 JSON */
export function locateScopeSystemPrompt(summary: string): string {
  return `你是网页"修改目标定位"助手。下面是一个 HTML 页面的精简 DOM 摘要（每行一个元素，含 offset、标签/class/id/紧邻文案，按层级缩进）。用户会给一条修改指令，你要在摘要中定位**用户想修改的那个目标元素**，输出 JSON。

只输出 JSON，不要解释、不要 Markdown 代码块包裹。格式：
{
  "tag": "目标元素标签名（小写）",
  "classHint": "目标元素上最 distinctive 的单个 class（无点号；优先业务 class，避免 ant-btn 这类通用基类；没有则省略该字段）",
  "textSnippet": "目标元素或其直接子元素的可见文案前 24 字（必须是摘要里实际出现的片段，便于原文精确命中；无文案则省略）",
  "selectorHint": "形如 #id 或 .class 的选择器（能确定时给出；否则省略）",
  "offsetHint": "摘要行里的 offset 数字（能确定时给出；否则省略）",
  "confidence": 0 到 1 的浮点，你对这次定位的确信度,
  "ambiguous": true 或 false,
  "batch": true 或 false
}

判定规则：
- 批量指令（"所有""每个""全部""每行""同列""这些""各"等）→ batch=true，**不要**标 ambiguous。此时定位"被重复的那种元素"的一个代表（如"所有 KPI 卡片"就定位一个 KPI 卡片），由上游上提到容纳它们的容器。confidence 按该元素类型是否清晰判定。
  - 批量文本替换（如"把所有'客户'改成'用户'"）的代表元素**必须是其文案包含被替换文本的可见元素**（如含"客户"的 span/td/div），**禁止**用 title/meta/head 或不含该文本的元素充当代表——否则上游在该 scope 内找不到目标会 no-op。
- 若指令指代不清（"这里""这个""那个"无明确对象）、或同时跨多个不相关元素（非同类批量）→ ambiguous=true，confidence 取低值（≤0.5），batch=false。
- classHint 选最能区分该元素的 class；textSnippet 必须是摘要中真实出现的文案。
- 若摘要里有明确的 [offset N]，请把该数字填入 offsetHint；offsetHint 比泛文本重复匹配更可靠。
- 找不到明确目标也输出 ambiguous=true，confidence 取低值，tag 给最可能的一个或省略。

【DOM 摘要】
${summary}`;
}

/**
 * 整页编辑"假成功"检测：模型原样回吐（逐字相同或仅空白/换行差异）→ 视为未真正改动。
 * 用于拦截 validateEditedHtmlDoc 通过、但模型并未真正改动的情况——避免谎报"已按描述修改"。
 *
 * 判定：内容归一（去所有空白）后相等即 no-op。替代旧的"行级 diff ≤2 + 长度差 <0.5%"——
 * 后者对等长/近等长文本替换（如"确认→取消"、"#FF8040→#FF8060"、同长属性值替换）会假阳性，
 * 把真实改动误判 no-op 丢弃。任何可见字符变化都不算 no-op。
 * 与 scope 路径的 scopeReplacementUnchanged 同一套逻辑，保持一致。
 */
export function isTrivialNoOp(original: string, edited: string): boolean {
  if (!edited || edited === original) return true;
  return original.replace(/\s+/g, "") === edited.replace(/\s+/g, "");
}

/** 检测原样 HTML 编辑是否被"整页重写"（标题/大部分内容丢失） */
export function looksRewritten(
  original: string,
  edited: string,
  opts?: { deleteMode?: boolean }
): boolean {
  if (!edited) return false;
  // 1) 原 <title> 元素丢失（整页重写时常见）。允许用户明确要求改标题→文本变化不算重写，
  //    只要有非空 <title> 仍在即可。删除指令也保留此检查（删内容不该丢 title）。
  const origTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(original)?.[1]?.trim();
  const outTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(edited)?.[1]?.trim();
  if (origTitle && origTitle.length >= 2 && !(outTitle && outTitle.length >= 2)) return true;
  // 2) 体量骤降（编辑后不到原文 55%，通常意味着整页被压缩重做而非增改）。
  //    删除指令豁免——合法大删除（占原文 45%+）会触发 0.55，把真删除误判为重写。
  //    结构完整性由 validateEditedHtmlDoc 的 </html>/<body> 检查兜底。
  if (!opts?.deleteMode && edited.length < original.length * 0.55) return true;
  return false;
}

/** ③.6 生成后自评审：只挑明显问题，避免过度纠错 */
export function reviewSystemPrompt(device?: Device): string {
  const dev = device === "mobile" ? "移动端（手机，应为窄屏单列布局）" : "PC 端（宽屏）";
  const tech = "原生 HTML";
  return `你是高保真原型的质量审查员。给你「原型规格（含 Prototype Contract）」和「生成结果(${tech})」，判断结果是否基本满足需求。

**本次为单页原型**：未被 Prototype Contract 要求的详情/新建/编辑独立页面未生成属于预期；但合同中 priority="must" 的抽屉、弹窗、页签、筛选、展开、联动等必须在主页面内可实际操作，不能因为单页策略而豁免。

只标记**明显且重要**的问题，不要纠结配色/文案/像素级美化：
- Prototype Contract 的 mustHave 缺失或没有清晰可见；
- priority="must" 的交互缺少触发事件、可见结果或 proof，或者只是 alert/toast/console/静态提示；
- requiredStates 既未默认展示，也无法通过明确操作触发；
- 有 Visual Reference Contract 时，结果明显违背 referenceMode、遗漏 preserve、擅自扩大 change，或用产品风格覆盖了要求保留的截图结构；
- 主页面里明确点名的模块/区块/关键字段/操作**缺失**；
- 出现空白占位、明显残缺或重复堆砌的假数据；
- 使用 Emoji/彩色表情充当业务图标、导航图标、按钮图标、卡片图标或头像；
- 设备布局明显不符（本次目标是 ${dev}，若做反了要指出）；
- 结构明显错乱、关键交互完全没有。

没有明显问题就判通过。issues 要**具体、可执行**（指明缺什么/哪里不对），最多 5 条。
只输出 JSON：{"ok": true|false, "issues": ["..."]}
**JSON 字符串值内禁止英文双引号，用中文「」。**`;
}

/** 迭代阶段的意图判别：判断用户这句是"改原型"还是"提问/闲聊" */
export function intentSystemPrompt(facts: string): string {
  return `你是一个原型设计工具里的助手。用户已经有一个原型在预览，他刚发来一句话。请判断这句话的意图：
- "edit"：想修改/调整这个原型（新增、删除、修改、替换、调整布局/文案/颜色/数据/数量等）。
- "ask"：在提问、确认信息或闲聊，并不要求改动原型（例如：用了什么模型、这个怎么用、刚才改了什么、能不能导出、为什么……）。

判断从宽：只要像是要改动页面就判 edit；只有明显是提问/闲聊才判 ask。
但**疑问句式**（"怎么""如何""可以…吗""能不能""是否""为什么""哪/哪些""怎样"）即使含"修改/改/调整"等词，也判 ask——用户在问"怎么改/能不能改/如何修改"，是咨询而非要求立刻改。例如"我可以怎么修改这个原型？""怎么把表格改成卡片？"都判 ask。
若为 ask，用一两句中文简洁作答；涉及本工具的问题可参考以下事实：
${facts}

只输出 JSON，不要解释、不要代码块：{"intent":"edit"|"ask","answer":"intent 为 ask 时填写回答，否则空字符串"}`;
}

/** 把结构化 flow 渲染成给生成步骤的用户消息 */
export function flowToGenerationBrief(flow: FlowSpec, requirement: string): string {
  const pages = flow.pages
    .map((p) => {
      return `• 页面[${p.id}] ${p.name}：${p.summary}\n    分区：${p.sections
        .map((s) => `${s.name}(${s.description})`)
        .join("；")}\n    数据字段：${p.dataFields.join("、")}`;
    })
    .join("\n");
  const navs = flow.navigations.length
    ? flow.navigations.map((n) => `${n.from} --(${n.trigger})--> ${n.to}`).join("；")
    : "（单页，无跳转）";
  const contract = flow.prototypeContract;
  const visualReference = contract?.visualReference;
  const visualReferenceText = visualReference
    ? `
【Visual Reference Contract｜截图参考边界】
- 参考模式：${visualReference.referenceMode}
- 必须保留：${visualReference.preserve.length ? visualReference.preserve.join("；") : "（无额外项）"}
- 明确改变：${visualReference.change.length ? visualReference.change.join("；") : "（无）"}
- 允许推断：${visualReference.infer.length ? visualReference.infer.join("；") : "（无）"}
- 冲突优先级：用户明确修改 > 截图中清晰可见的事实 > 已选产品风格 > 模型自行推断`
    : "";
  const contractText = contract
    ? `【Prototype Contract｜本次验收标准】
- 页面类型：${contract.pageArchetype}
- 主要使用者：${contract.primaryUser}
- 首要任务：${contract.primaryJob}
- 首版必须可见：${contract.mustHave.length ? contract.mustHave.join("；") : "（无额外项）"}
- 可演示交互：${
        contract.interactions.length
          ? contract.interactions
              .map(
                (item, index) =>
                  `${index + 1}. [${item.priority}] ${item.trigger} → ${item.result}；验收证据：${item.proof}`
              )
              .join("\n")
          : "（无明确交互）"
      }
- 关键状态：${contract.requiredStates.length ? contract.requiredStates.join("；") : "（无额外状态）"}
- 合理假设：${contract.assumptions.length ? contract.assumptions.join("；") : "（无）"}${visualReferenceText}`
    : "【Prototype Contract】历史规格未包含合同；严格执行原始需求中明确点名的模块和交互。";

  return `原始需求：${requirement}

原型：${flow.title} —— ${flow.summary}

${contractText}

页面（首页为第一个）：
${pages}

页面跳转：${navs}

请据此生成原型：**默认就是单页**（上方通常只有 1 个主页面）；仅当上方页面多于 1 个时才做多页切换。Prototype Contract 中 priority="must" 的交互必须逐条真实可演示。`;
}
