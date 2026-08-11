# YouDesign · 高保真原型设计 Agent

中文 | [English](./README.en.md)

[![CI](https://github.com/huangxiaoliang/YouDesign/actions/workflows/ci.yml/badge.svg)](https://github.com/huangxiaoliang/YouDesign/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**高保真原型设计Agent：**
- 用自然语言（可附截图 / HTML及资源包 / Markdown）描述页面，分钟级生成可交互的高保真原型；
- **Chrome插件**抓取指定页面，进行二次设计；
- **Mac/Windows桌面端**支持超大html的二次设计；
- 支持 点选页面指定区域 进行 局部深度修改（自然语言 or 直接编辑修改）；
- 支持需求卡模式，内置Ant Design等多种设计风格。
- **Web地址**：https://youdesign-gamma.vercel.app/youdesign 
- **体验账号**：邮件联系 coolway.me@gmail.com

---

## 快速开始


```bash
npm install
npm run build && npm run start    # http://localhost:3000/youdesign
```

首次打开进入**登录页**，输入口令登录——多人模式下每人一个独立口令（管理员用 `scripts/user.mjs` 开户）；未配置用户表时回退 `.env.local` 的 `YOUDESIGN_ACCESS_PASSWORD` 共享口令。登录后左侧用文字描述页面、右侧实时流式出现生成过程与预览。

> 无任何密钥时（`YOUDESIGN_FORCE_MOCK=true`）走 mock，可离线跑通闭环用于演示/开发。
> `npm run dev` 用于开发；功能验收仍以 `build && start` 为准（`dev` 偶发整页 500）。
> `npm run tunnel` 可用 trycloudflare 快速隧道临时把本地服务分享出去（需先装 cloudflared）。

> `dev`/`start` 脚本内置 `env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY`：避免 Claude Code 等向子进程注入的 `ANTHROPIC_*` 变量与本工具自有的 key 冲突。直接 `next dev`/`next start` 会踩，务必走 `npm run dev`/`npm run start`。

---

## 配置（`.env.local`，参考根目录 `.env.example` 占位符模板新建）

| 类别 | 关键变量 |
|---|---|
| 运行模式 | `YOUDESIGN_FORCE_MOCK`（true=全程 mock，无密钥可离线跑通） |
| 登录门禁 | `YOUDESIGN_AUTH_SECRET`（cookie 签名密钥，`openssl rand -hex 24`）；`YOUDESIGN_AUTH_MODE=auto/shared/users`；多人模式用户表 `data/users.json`（`scripts/user.mjs` 管户，口令只存 sha256 摘要），无用户表或强制 shared 时回退 `YOUDESIGN_ACCESS_PASSWORD` 共享口令 |
| 数据目录 | `YOUDESIGN_DATA_DIR`（持久化目录，默认 `data/`；生产部署指向仓库外路径，`git pull` 不覆盖） |
| 用量存储 | 可选 MySQL：`YOUDESIGN_MYSQL_HOST`/`YOUDESIGN_MYSQL_PORT`(3306)/`YOUDESIGN_MYSQL_DATABASE`(youdesign)/`YOUDESIGN_MYSQL_USER`/`YOUDESIGN_MYSQL_PASSWORD`；未配 MySQL 时回退本地 JSONL（`<data dir>/usage.jsonl`） |
| 模型密钥 | `DEEPSEEK_API_KEY`（主力）；`GLM_API_KEY`（智谱 GLM-5.2，OpenAI 兼容）；`ZHIPU_API_KEY`（智谱 embedding，语义召回）；`ANTHROPIC_API_KEY`+`ANTHROPIC_MODEL_OPUS`/`ANTHROPIC_MODEL_SONNET`（Claude）；`KIMI_API_KEY`+`KIMI_BASE_URL`（Kimi K3，火山方舟 Agent Plan）；`GLM5V_API_KEY`（视觉模型 GLM-5V，缺省复用 `GLM_API_KEY`/`ZHIPU_API_KEY`） |
| 生成行为 | 前端「快速」开关（默认开，仅首次生成生效）；`SELF_REVIEW`（高质量模式自评审，默认开，当前临时整体跳过，见 AGENTS §6）；`ROUTE_*`（模型路由，见下） |
| 代理 | `HTTPS_PROXY`/`HTTP_PROXY`（公网 API 走代理时设）；`NO_PROXY`（须直连的域名/网段，自行解析子域后缀匹配） |

> 「默认模型」下单项模型配置缺失会回退 mock，可逐步接入；用户手动选择 `DeepSeek`/`GLM-5.2` 时，缺少对应密钥会直接提示配置错误。密钥存 `.env.local`（已 gitignore），不出现在前端。

### 模型路由（DeepSeek 为主；文本可选 GLM-5.2 / Kimi K3 / Sonnet / Opus；视觉默认 GLM-5V）

| 变量 | 环节 | 默认 |
|---|---|---|
| `ROUTE_CLARIFY` | ⓪ 预检（澄清+设备判别） | `deepseek`（flash） |
| `ROUTE_STRUCTURE` | ① 需求结构化（简单需求） | `deepseek`（flash） |
| `ROUTE_STRUCTURE_COMPLEX` | ① 复杂需求自动升 | `deepseekPro` |
| `ROUTE_GENERATE` | ③ 整页代码生成（质量优先） | `deepseekPro` |
| `ROUTE_EDIT_SMALL/LARGE` | ⑤ 迭代修改 | `deepseek`（flash） |

- `deepseek` = `deepseek-v4-flash` + `thinking: disabled`（快）；`deepseekPro` = `deepseek-v4-pro` + `thinking: enabled`（推理，质量高，首字节慢 ~90s）。
- 前端「快速」开关默认开：结构化与生成都强制走 flash、跳过通用自评审，优先秒出原型。关掉进高质量模式：generate 按场景分级，简单原生页 flash-first 出首版，复杂/带图/带文档/风格档案/还原类走 pro/GLM 并跑自评审（当前临时整体跳过，见 AGENTS §6）。
- 任一步带上传图片且模型无视觉能力 → 该步改用视觉模型，未显式选时默认 GLM-5V。

---

## 核心能力

**原生 HTML 生成**：产出**自包含 HTML**（内联 CSS/JS、原生 JS 做多页切换），`srcDoc` 渲染——可离线打开、可直接编辑。默认单页（详情/新建/编辑等次级视图不单独生成；少数独立页面才多页，上限 3）。

**设备自适应**：由模型从需求判断 **PC / 移动端**（判不准会反问，兜底 PC）。该判断决定**布局**（移动端 390px 手机边框预览）——使用者无需手选；想要移动端就在需求里写明"手机/H5/App"。

**会话持久化与历史**：当前会话（对话 + 原型 + 版本栈 + 设置）自动存进浏览器 IndexedDB，刷新自动回到现场；顶栏「历史」可查看/切换/新建/删除过往会话（按浏览器存，与登录身份独立）。**登录后默认开新会话**（不恢复上次），刷新则正常恢复——避免换人/换班误看上一位草稿。

**上传作参考 / 原样打开**：最多上传 **4 个附件**、单文件 **5MB** 上限（图片 / HTML / HTML 资源包 ZIP / Word / Markdown / 文本），支持粘贴或拖拽。上传 HTML 或 ZIP 时自动进入原样 HTML 路径，后端先做一次**意图识别**判定处理方式：
- HTML：作为 `srcDoc` 渲染的基础。ZIP：自动找 `index.html`，把相对 CSS/图片/字体等资源转成自包含 HTML；为避免打包应用脚本在 `srcDoc` 中清空页面，ZIP 原样打开以静态可见为优先、禁用脚本。
- **HTML 上传意图**（`classifyHtmlUploadIntent`）：没输入文字直接 `open`；含"重新生成/重做/参考它做新的"等 `regenerate`（参考上传页重新生成）；含"改/调整/优化/删/加"等 `edit`（原页最小修改）；纯提问 `ask`（原样打开并回答）。
- **图片上传意图**（`classifyImageUploadIntent`，视觉模型）：没输入文字直接 `generate`；"这是什么/分析一下" `ask`；"根据截图生成但把 X 改成 Y" `generate-with-changes`。

**预览区四件套**
- **点选AI修改**：点选元素 + 临时 anchor 精确定位，以目标元素为锚点做局部作用域修改。
- **普通编辑**：点选元素后用属性面板改单元素——文案/输入值/占位文案/图片 alt，以及字体/字号/字重/行高/字间距/对齐/文字颜色/内外边距/背景/边框/圆角/阴影/透明度等视觉属性
- **需求卡**：预览头「需求卡」打开评审浮窗（可拖动），手动建卡——BR 编号、P0/P1/P2 优先级、待复核/已确认/存疑/作废状态流转、按状态筛选。
- **产品风格档案**：可选 Ant Design / TDesign / Vant / Apple / Claude / Notion / Slack / Vercel 共 8 个档案。
- **导出**：导出自包含 HTML 文件；
---

## 桌面版（Mac + Windows）

Electron 壳，默认加载 `http://localhost:3000/youdesign`（可用 `YOUDESIGN_DESKTOP_WEB_URL` 覆盖）；设 `YOUDESIGN_DESKTOP_USE_LOCAL_SERVER=true` 时启动本机 Next standalone。客户端通过 preload 暴露本机 Claude Code bridge，在大 HTML 编辑兜底时调用用户本机已安装并登录的 Claude Code CLI。

```bash
npm run desktop:dev              # 开发壳
npm run desktop:dev:online       # 跨平台线上 Web 开发壳（Windows 使用）
npm run desktop:pack:mac         # 无签名 .app（胖包，带本机 server fallback）
npm run desktop:dmg:mac          # 无签名 DMG（胖包；正式分发仍需签名/公证）
npm run desktop:dmg:thin:mac     # 薄客户端 DMG：线上 Web 壳 + Claude bridge，不带 .next/standalone
npm run desktop:nsis:thin:win    # Windows 10/11 x64 薄客户端 NSIS
npm run desktop:dist:mac         # 正式 DMG 入口（需 Developer ID 证书与公证环境）
```

- 客户端直接进入 Web 登录页，复用 Web 登录鉴权。
- macOS 双击 App 不一定继承终端 `PATH`，客户端自动探测 `~/.claude/local`、Homebrew、npm global、nvm/fnm/volta/asdf 等 Claude CLI 安装位置；Windows 优先 `where.exe`/`PATH`/npm 全局查找 `claude.exe`/`claude.cmd`，并检查 Git Bash。
- Claude 大 HTML 编辑串行排队、按任务 ID 精准取消，同一时间只拉起一个 Claude CLI 任务；
- 薄包必须保留 `mac.identity: "-"` 做 ad-hoc 签名且 `hardenedRuntime: false`，否则 macOS 可能提示"应用已损坏"。ad-hoc 内测包仍可能被 Gatekeeper quarantine 拦截，可执行 `xattr -dr com.apple.quarantine /Applications/YouDesign.app`。正式分发仍需 Developer ID 签名 + 公证。
- 公网下载 Electron 资源失败时按需加代理：`HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 npm run desktop:dmg:thin:mac`。

---

## Chrome浏览器抓取扩展

`extension/youdesign-capture/` 是 Chrome MV3 扩展（v0.2.9）。

- **抓取当前页**（扩展持有 `<all_urls>` host 权限，加载期即注入 `drawer_tracker` 跟踪点击）：捕获渲染后整页 DOM（禁用脚本、内联可读 CSS、远程 CSS/小图转 data URL、src/href 绝对化、5MB 总上限，仅允许 `http(s)://` 业务页），并记录交互元信息（已打开的抽屉/模态框及其开关按钮/遮罩、已在 DOM 的标准/Ant Design 页签、内嵌 iframe）。
- **多页签采集**：注入可拖动「页签采集」浮窗。扩展识别页面里的标准 / Ant Design 页签组（2-16 个），以当前 DOM 为基线，默认已打开页签自动采集；用户在来源页逐个点开懒加载页签、点「采集当前」逐一抓取面板内容，最后「合并发送」把所有已采集页签合并成一个离线页。

---

## 自托管部署

Next.js 生产模式 + systemd 托管 + nginx 反代，挂在 `/youdesign` 子路径（basePath）。

```bash
git clone https://github.com/huangxiaoliang/YouDesign.git /opt/youdesign && cd /opt/youdesign && npm ci
cp .env.example .env.local   # 编辑：填真实 API key、YOUDESIGN_AUTH_SECRET=openssl rand -hex 24
npm run build
```

`/etc/systemd/system/youdesign.service`：

```ini
[Unit]
Description=YouDesign
After=network.target
[Service]
Type=simple
WorkingDirectory=/opt/youdesign
EnvironmentFile=/opt/youdesign/.env.local
ExecStart=/usr/bin/npm start -- -p 3001
Restart=on-failure
UnsetEnvironment=ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN
[Install]
WantedBy=multi-user.target
```

nginx 原样透传 `/youdesign/` 前缀（不要 strip），`proxy_buffering off;`、`proxy_read_timeout 300s;`（生成是流式长连接）。数据目录 `YOUDESIGN_DATA_DIR` 指向仓库外（如 `/var/lib/youdesign`），`git pull` 不覆盖；用户管理 `node scripts/user.mjs <add|list|disable|enable|reset|set-role>`。升级：`git pull && npm ci && npm run build && sudo systemctl restart youdesign`。

---

## 架构 / 生成管线

```
 自然语言 / 上传  ──POST /api/generate（NDJSON 流式，需登录 cookie）──▶ orchestrator.ts
  HTML/ZIP 上传      ZIP 前端转自包含 HTML；先过 intent 意图识别再分流
  intent 意图识别    编辑 classifyEditIntent 判改/问；HTML 上传 classifyHtmlUploadIntent 判 open/edit/regenerate/ask；图片上传 classifyImageUploadIntent 判 ask/generate/generate-with-changes
  ⓪ 预检 preflight     一次 flash 判「需求是否明确」+「PC/移动端 device」，模糊则反问暂停；快速图片模式跳过 LLM 预检、规则判端+单页直出
  ① 结构化 structure    默认单页 FlowSpec + Prototype Contract（首要任务/mustHave/可演示交互/关键状态/假设）；有截图时附 Visual Reference Contract（mode/preserve/change/infer）
  ② 检索 retrieve       （当前原生 HTML 路径不依赖外部组件库检索）
  ③ 生成 generate       流式产出自包含 HTML；快速模式走 flash，高质量模式按场景分级（简单页 flash-first，复杂/带图/带文档/风格档案/还原类走强模型）；选中风格档案经 buildStyleHead 注入
  ③.5 校验 validate     真实导航静态门禁（unsafePrototypeNavigation，修不掉则拦截保留原页/给兜底页），必要时自修复
  ③.55 结构自检          must 交互验收（当前临时整体跳过，见 AGENTS §6）
  ③.6 自评审 review      按风险分级（当前临时整体跳过，见 AGENTS §6）
  ③.7 品牌色矫正 normalize 生成/自评审/编辑后兜底：按 themeCss token 就近吸附漂移的近似品牌色，中性灰精确匹配
  ④ 预览 preview        原生 HTML → srcDoc（统一注入临时导航守卫拦截真实页面跳转、超宽表格包横向滚动容器，序列化/导出前剥除）
  ⑤ 迭代 edit           HTML 产物用 HtmlSizeInfo 统一判断体量
```

- **登录门禁**：`src/middleware.ts` 拦截未登录请求（页面跳 `/login`、接口返 401）。
- **预览原理**：原生 HTML 直接 `srcDoc`（同源因而支持直接编辑/元素点选）。

| 目录 / 文件 | 职责 |
|---|---|
| `src/middleware.ts` + `src/lib/auth/` + `src/app/api/{login,me,logout}` | 登录门禁（多人独立口令 / 共享口令回退 + 签名 cookie）+ 当前用户 |
| `src/lib/meter/` + `src/app/usage` | 用量计量（provider `onUsage` + `MeteredProvider`，15 调用点零侵入；MySQL 持久化或 JSONL 回退）+ 数据库聚合看板（按人/模型/中国自然日） |
| `src/lib/config.ts` | 环境变量 + 模型路由，缺配置自动回退 mock |
| `src/lib/providers/` | LLM 抽象 + Anthropic(含 `stream()`) / DeepSeek(含流式/推理参数) / GLM 官方 OpenAI 兼容 / Kimi(火山方舟) / mock |
| `src/lib/pipeline/orchestrator.ts` | 主编排（流式、可取消）、HTML 原样打开/迭代修改、多 HTML 程序化合并；意图识别/模型路由/阶段耗时已抽到 `intent.ts`/`routing.ts`/`timing.ts` |
| `src/lib/pipeline/{intent,routing,timing}.ts` | 上传/编辑意图识别、模型路由启发式、阶段耗时埋点 |
| `src/lib/pipeline/{textUtils,judges,htmlScopePatch}.ts` | HTML/JSON 清洗与强校验、`planHtmlEdit` 编辑前结构化路由、标注 anchor 局部作用域 patch（含删除/隐藏/确定性替换快路径、`matchLocateToAnchor` 多信号+offset 精确定位） |
| `src/lib/pipeline/validate.ts` | JSX/HTML 校验 + 自修复 + 真实导航静态门禁（`blockedNavigation` 兜底）+ 品牌色确定性矫正（`normalizeBrandColors`） |
| `src/lib/prototypeNavigation.ts` · `previewNavigation.ts` | 原型真实跳转防线：服务端静态检测 + 修复指令；预览 iframe 临时守卫注入/剥除 + 跳走自动恢复 |
| `src/lib/exportInline.ts` | 导出 HTML 离线内联 + 移动端窄框 iframe + history bridge |
| `src/lib/capturedPage.ts` · `desktop/captured-page-runtime.cjs` · `desktop/capture-payload-utils.cjs` | 抓取扩展产物的离线重建与导入净化 |
| `src/lib/prompts.ts` | 预检/结构化/生成/编辑/自评审 提示词（含 `isTrivialNoOp` 假成功检测、占位图禁用铁律、严禁真实页面导航规则） |
| `src/lib/style/profiles.ts` · `patterns.ts` | 产品风格档案（8 个）+ 风格 token 注入 |
| `src/lib/store/sessions.ts` · `src/components/HistoryDrawer.tsx` | 会话持久化（IndexedDB）+ 历史抽屉 |
| `src/lib/embeddings/` | 智谱 embedding-3（语义）+ 本地 n-gram（词法兜底） |
| `src/app/page.tsx` 及 `src/components/*` | 聊天式前端、附件读取/ZIP 自包含转换、预览（点选/编辑/导出/版本/手机边框）、需求评审卡、原生 HTML 单元素属性面板 |

---

## 自检 / 测试

```bash
npm run typecheck          # tsc --noEmit
npm run build              # 生产构建
```

纯本地回归（无需服务/模型 key，改了对应链路必跑）：

```bash
npm run test:desktop-claude-core       # 桌面 Claude 单条路径 + 队列/取消
npm run test:desktop-claude-fragments  # 多片段事务提取/原子回填
npm run test:desktop-windows-runtime   # Windows CLI/Git Bash/协议/NSIS
npm run test:prototype-contract        # Prototype Contract + must 交互验收
npm run test:preview-navigation        # 原型真实导航拦截
npm run test:export-history-bridge     # 导出移动窄框 history bridge
npm run test:preview-device-mode       # 预览视口设备模式 + 手机外壳
npm run test:direct-html-editor        # 原生 HTML 单元素属性编辑
npm run test:session-brief             # 会话级 SessionBrief
npm run test:html-merge                # 多 HTML 合并
npm run test:capture-sanitization      # 抓取扩展净化
npm run test:captured-page-safety      # 抓取页离线安全
npm run test:captured-page-groups      # 抓取页离线重建页签组
npm run test:capture-drawer            # 抓取页抽屉交互 runtime（Playwright 实跑）
npm run test:capture-overlay           # 多页签采集浮窗
npm run test:usage-jsonl               # JSONL 用量存储
npm run test:mysql-usage               # MySQL 连通+表结构+事务写读回滚
```

---

## 协作约定

一功能一 PR，base `main`，分支 `feat/...`/`fix/...`/`docs/...`/`chore/...`；PR 前必须 `typecheck` + `build` 通过；不在 `main` 直接改；不把"格式化整文件"和"功能改动"混在一个 PR。详细的 AI 协作约定、架构、踩坑铁律、待办见 [`AGENTS.md`](./AGENTS.md)。

---

## 许可

[MIT](./LICENSE)。
