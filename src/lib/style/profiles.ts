/**
 * 产品风格档案（Style Profile）——让生成的原型贴近某个具体产品的设计风格。
 * 三层作用：
 *  - styleSpec：注入到结构化/生成/编辑提示词，约束版式、配色、术语（方案 1）
 *  - themeCss：预览渲染时注入自托管沙箱，定义品牌 CSS 变量（方案 3）
 *  - exemplars：真实页面代码范例，作为"严格模仿的风格样板"（方案 2，后续补）
 * 新增产品时往 STYLE_PROFILES 里加一项即可。
 */
export interface StyleProfile {
  id: string;
  name: string;
  /** 注入提示词的设计规范（精炼、可执行） */
  styleSpec: string;
  /** 注入预览的主题 CSS（品牌变量 + 少量全局覆盖） */
  themeCss: string;
  /** 真实页面代码范例（方案 2，后续补充） */
  exemplars?: string[];
}

/** Ant Design 5 设计规范（企业级 Web 产品） */
const antDesign: StyleProfile = {
  id: "ant-design",
  name: "Ant Design",
  styleSpec: `【产品风格：Ant Design ——必须严格遵循以下设计规范】

# 核心气质
- 面向复杂企业应用的通用、自然、确定设计语言；追求清楚的信息层级和低认知负担，不做营销化大色块或装饰性渐变。
- 适用于 PC 端业务后台、CRM、运营平台、数据/流程管理；优先使用成熟的“顶栏/侧栏 + 面包屑 + 页面标题 + 卡片/表格”任务骨架。
- 以规范化组件、明确状态和 4px 间距体系降低协作成本；信息密度适中，宁可分组、折叠和抽屉下钻，也不要无层次堆叠。

# 色彩与字体
- 品牌主色严格使用 Daybreak Blue #1677FF；hover #4096FF，active #0958D9，弱选中底 #E6F4FF。主色只用于主操作、激活、链接和关键信息，不大面积铺底。
- 中性色：页面底 #F5F5F5，卡片 #FFFFFF，弱填充 #FAFAFA/#F5F5F5，边框 #D9D9D9，分割线 rgba(5,5,5,.06)。
- 文字：主文字 rgba(0,0,0,.88)，次级 rgba(0,0,0,.65)，说明 rgba(0,0,0,.45)，禁用 rgba(0,0,0,.25)。语义色：成功 #52C41A、警告 #FAAD14、错误 #FF4D4F。
- 使用 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif；正文/表格 14px，辅助 12px，页面标题 20px/600，分区标题 16px/600。

# 形状与布局
- 4px 为基础单位；常用间距 8/12/16/24px。默认控件高度 32px，紧凑场景 24px，大控件 40px。
- 输入框、按钮、标签默认 6px 圆角；卡片 8px。阴影仅用于浮层：0 6px 16px rgba(0,0,0,.08)，普通卡片靠浅底/细边框分层，不要重阴影。
- 列表页固定结构：面包屑 → 标题与主操作 → 条件筛选卡 → 工具栏 → 表格 → 分页。表格表头 #FAFAFA，行高 48-54px，操作列用蓝色文字链接；空状态保留表头和清晰的 Empty 引导。

# 组件与交互
- 主按钮为 #1677FF 白字；次按钮白底灰边；危险操作用红色并二次确认。一个操作组最多一个主按钮。
- 复杂详情优先右侧 Drawer；短确认与少量字段使用 Modal；就近补充使用 Tooltip/Popover。筛选、分页、排序、批量操作都必须可见且有 loading/empty/error 状态。
- 侧栏当前项用浅蓝底 + 蓝色文字/左侧标识；Tabs 采用细蓝色下划线；表单标签清晰对齐，必填项使用红色星号。
- 生成可交互原型时，筛选、页签、表格行、抽屉、弹窗和主操作必须真实改变可见状态；不要用 toast 或 alert 冒充交互结果。

# 禁止项
- 不要把链接全部做成实心按钮；不要过度装饰图标、渐变与阴影。`,
  themeCss: `:root{
  --ant-primary:#1677FF;--ant-primary-hover:#4096FF;--ant-primary-active:#0958D9;--ant-primary-bg:#E6F4FF;
  --ant-text:rgba(0,0,0,.88);--ant-text-secondary:rgba(0,0,0,.65);--ant-text-tertiary:rgba(0,0,0,.45);
  --ant-bg:#F5F5F5;--ant-surface:#FFFFFF;--ant-fill:#FAFAFA;--ant-border:#D9D9D9;--ant-split:rgba(5,5,5,.06);
  --ant-success:#52C41A;--ant-warning:#FAAD14;--ant-error:#FF4D4F;--ant-radius:6px;
}
body{background:#F5F5F5;color:rgba(0,0,0,.88);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}
a{color:#1677FF;}`,
};

/** 腾讯 TDesign 设计规范（企业级跨端产品） */
const tDesign: StyleProfile = {
  id: "tdesign",
  name: "TDesign",
  styleSpec: `【产品风格：腾讯 TDesign ——必须严格遵循以下设计规范】

# 核心气质
- 腾讯开源企业级设计体系，强调一致、易用、可扩展与跨端协同；整体清爽、理性、有秩序，适合云服务、运营中台、协作与管理产品。
- 使用统一 Design Token 思路组织颜色、尺寸、圆角、阴影、字体；页面有清晰留白与弱层级，不做厚重拟物、过度营销或杂乱的彩色模块。
- PC 后台默认使用顶部产品栏 + 左侧导航 + 内容工作区；移动端改为单栏、底部导航和 44px 以上触控目标。

# 色彩与字体
- 品牌蓝严格使用 #0052D9；hover #366EF4，弱选中/浅底 #F2F3FF，深色 #003CAB。蓝色表达主操作、选中、链接和焦点。
- 中性色：页面底 #F3F3F3，卡片 #FFFFFF，弱填充 #F3F3F3，主文字 #000000E6，次级 #00000099，辅助 #00000066，边框 #E7E7E7。
- 语义色克制使用：成功 #2BA471，警告 #E37318，错误 #D54941；不要让语义色承担普通导航或主操作。
- 字体使用 "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, sans-serif；正文 14px，辅助 12px，页面标题 20px/600，区块标题 16px/600。

# 形状与布局
- 以 4px 为基础间距，常用 8/12/16/20/24px；默认控件高 32px，移动端高 44px。
- 输入框、按钮、标签使用 3-6px 的轻圆角；卡片 6px；常规卡片只用 1px #E7E7E7 边框，浮层可使用柔和 0 4px 12px rgba(0,0,0,.12) 阴影。
- 内容区采用 #F3F3F3 背景上的白色卡片；页面标题区、筛选区、信息区和表格区之间用 16px 留白和细分割线组织。
- 表格表头弱灰填充，行高约 48px；支持密度、列设置、排序和横向滚动。数值右对齐，状态使用小面积浅色 Tag，操作使用文字按钮或低强调按钮。

# 组件与交互
- 主按钮 #0052D9 白字；次操作为描边或 text/ghost；危险动作在确认弹窗中完成。按钮、输入、选择器的 disabled/loading/focus 状态必须可见。
- 左侧菜单选中使用浅蓝背景/蓝色文字；Tabs 用蓝色下划线；筛选表单按栅格对齐，复杂配置用分组卡片、步骤条或右侧抽屉。
- Dialog 用于确认和短表单，Drawer 用于详情和长编辑，Message/Notification 只用于补充反馈，不能代替页面状态变化。
- 原型必须实现页签切换、筛选联动、详情抽屉/弹窗、加载和空态等真实可演示状态；移动端底部操作区应固定且不遮挡内容。

# 禁止项
- 不要混入 Ant 的 #1677FF；不要使用过重阴影、超大圆角、玻璃拟态或大面积渐变。`,
  themeCss: `:root{
  --td-brand:#0052D9;--td-brand-hover:#366EF4;--td-brand-active:#003CAB;--td-brand-light:#F2F3FF;
  --td-text:#000000E6;--td-text-secondary:#00000099;--td-text-placeholder:#00000066;
  --td-bg:#F3F3F3;--td-surface:#FFFFFF;--td-fill:#F3F3F3;--td-border:#E7E7E7;
  --td-success:#2BA471;--td-warning:#E37318;--td-error:#D54941;--td-radius:6px;
}
body{background:#F3F3F3;color:#000000E6;font-family:"PingFang SC","Microsoft YaHei",-apple-system,BlinkMacSystemFont,sans-serif;}
a{color:#0052D9;}`,
};

/** Vant 设计规范（移动 Web / H5） */
const vant: StyleProfile = {
  id: "vant",
  name: "Vant",
  styleSpec: `【产品风格：Vant ——必须严格遵循以下设计规范】

# 核心气质
- 面向手机 Web/H5 的轻量、清爽、实用型界面；以单手操作、列表分组、就近反馈和高频表单为核心，不复刻 PC 后台的侧栏和密集表格。
- 优先适用于 375–430px 宽移动屏：白色 Cell 列表、浅灰页面底、分组标题、底部安全区操作栏、Popup/ActionSheet/Picker 等移动原生感交互。
- 视觉中性、克制，适合移动端客户管理、任务、审批、服务流程和轻运营工具；品牌感主要由主色和内容注入，不靠复杂装饰。

# 色彩与排版
- 主色使用 Vant Blue #1989FA；弱选中 #E8F3FF，link/主操作保持同一蓝色体系。成功 #07C160、警告 #FF976A、危险 #EE0A24。
- 页面底 #F7F8FA，Cell/卡片 #FFFFFF，细分割 #EBEDF0；主文字 #323233，次级 #646566，辅助 #969799。
- 字体使用 -apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif；正文 14px，Cell 标题 14-16px，页面标题 18px/600，说明 12px。

# 移动结构与组件
- 使用顶部 NavBar（返回、标题、右侧轻操作）+ 可滚动内容区 + 固定底部操作栏/Tabbar 的单列结构；首屏不放 PC 风格面包屑、左侧菜单或横向数据表。
- 以 Cell Group、Card、Tag、Badge、Steps、Tabs、Search、SwipeCell 组织信息；列表行最小触控高度 44px，主按钮和底部操作高度不低于 44px，保留 iPhone 安全区。
- 输入、选择、日期、城市等复杂输入通过 Popup、ActionSheet、Picker、Calendar 展开；危险动作必须走 Confirm Dialog。
- 卡片圆角克制（6–8px），弱阴影或无阴影；页面分组主要依靠 #F7F8FA 留白和 Cell 分割线。

# 交互要求
- 原型必须实现真实移动交互：点击列表进入详情或底部弹层，Tab 切换可见内容，主操作打开确认/表单，提交后列表或状态卡真实变化。
- 支持 loading、empty、error、disabled、网络弱提示；列表可下拉刷新或用清晰刷新入口表达，不要把所有反馈只塞进 toast。
- AI 场景使用“AI 建议”轻卡片或底部弹层，给出简短原因、建议动作与确认按钮；长分析收进可展开详情，避免遮挡主任务。

# 禁止项
- 不要使用桌面端多列布局、悬浮大侧栏、32px 以下的触控目标、复杂 hover 才可用的交互或大面积渐变。`,
  themeCss: `:root{
  --van-primary:#1989FA;--van-primary-light:#E8F3FF;--van-success:#07C160;--van-warning:#FF976A;--van-danger:#EE0A24;
  --van-text:#323233;--van-text-secondary:#646566;--van-text-muted:#969799;
  --van-bg:#F7F8FA;--van-surface:#FFFFFF;--van-border:#EBEDF0;--van-radius:8px;
}
body{background:#F7F8FA;color:#323233;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue","PingFang SC","Microsoft YaHei",sans-serif;}
a{color:#1989FA;}`,
};

/** Apple 营销页设计规范（PC/移动通用） */
const apple: StyleProfile = {
  id: "apple",
  name: "Apple",
  styleSpec: `【产品风格：Apple ——必须严格遵循以下设计规范。摄影优先、博物馆式产品展示，适合营销页/产品页/选购页，不适合密集后台表格】

# 核心气质
- Photography-first：产品图/真实物体是主角，UI chrome 必须近乎隐形，页面像博物馆展厅而不是 SaaS 仪表盘。
- 全页由 edge-to-edge product tile 堆叠构成：白色/羊皮纸浅底与近黑深底交替，每个 tile 约占一屏。
- 信息密度极低：一个分区只表达一个产品/一个主卖点/一组 CTA；标题、tagline、CTA 和产品图垂直居中排布。
- 分区之间 0 间距，靠画布颜色切换建立节奏；严禁装饰性渐变、厚边框、卡片阴影、营销插画感背景。

# 配色
- 唯一结构/交互色 Action Blue #0066cc；focus blue #0071e3；深色底文字链接用 sky link blue #2997ff。
- 所有「可点击」信号（文字链接、蓝色 pill CTA、Buy、focus ring）都用蓝色体系，不能引入第二品牌色。
- 浅色画布：纯白 #ffffff 与 parchment #f5f5f7 交替；pearl 次级按钮/胶囊用 #fafafc。
- 深色画布：#272729 / #2a2a2c / #252527 做近黑 tile 微差；纯黑 #000000 只用于 44px 全局导航和视频/摄影黑场。
- 文字：浅底统一 near-black #1d1d1f；深底 #ffffff；暗底弱文案 #cccccc；次级/禁用 #7a7a7a。
- Hairline：#e0e0e0 用于 store utility card、configurator chip；#f0f0f0 用作次级按钮的软环。
- 禁止：彩色装饰、品牌渐变、第二强调色、用贴纸色/语义色做营销分区。

# 排版
- Display 用 SF Pro Display；正文/UI 用 SF Pro Text；fallback 为 system-ui, -apple-system, BlinkMacSystemFont, Inter。
- Hero headline：56px / 600 / line-height 1.07 / letter-spacing -0.28px。
- Product tile headline：40px / 600 / line-height 1.1；section head 可用 34px / 600 / letter-spacing -0.374px。
- Tagline：21px / 600 / line-height 1.19；lead：28px / 400 / line-height 1.14。
- 正文必须是 17px / 400 / line-height 1.47 / letter-spacing -0.374px，不要降到 16px。
- Caption 14px，fine print 12px，micro legal 10px；全局导航 12px / 400 / -0.12px。
- 字重阶梯是 300 / 400 / 600 / 700，避免 500；标题通常 600，不要用 700 造成粗重。
- 负字距是 Apple tight 的关键：大标题越大越要收紧；正文也保持轻微负字距。

# 形状与间距
- 圆角语法必须区分：product tile 0px；utility image / dark utility button 8px；pearl capsule 11px；store utility card / accessories card 18px；所有主 CTA/search/configurator chip 用 pill 9999px。
- 间距基数 8px；结构节奏 8/12/16/20/24/32/48；产品 tile 上下内边距 80px；footer 64px；card 内边距 24px。
- 标题上方至少 64px 空气，下方 48-64px；产品图周围 40px 内不要放其它信息。
- 最大内容宽：文字型约 980px，产品网格/商店约 1440px，hero/tile 可 full-bleed。

# 层级与阴影
- 全系统只允许一类投影：产品图 resting on surface 时使用 rgba(0,0,0,0.22) 3px 5px 30px。
- 卡片、按钮、导航、文字绝不使用阴影；utility card 用 1px hairline，不用 elevation。
- 层级靠画布模式切换和 frosted sticky bar 的 backdrop-filter blur，而不是 shadow。
- sub-nav / floating sticky bar 可用 parchment 80% + saturate(180%) blur(20px) 的磨砂玻璃效果。

# 导航与组件
- global-nav：44px 高，#000 背景，12px 白色链接，右侧 Search/Bag 图标；移动端在约 834px 以下收成 logo + hamburger + bag。
- sub-nav-frosted：52px 高，#f5f5f7 80% + blur；左侧产品/频道名 21px/600，右侧轻链接 + 常驻蓝色 Buy pill。
- button-primary：#0066cc 背景 + 白字 + 17px/400 + pill + 11px 22px；press 使用 transform: scale(0.95)。
- button-secondary-pill：透明/白底 + 蓝字 + 蓝色 1px 描边 + pill，作为 Learn more / Buy 的成对第二 CTA。
- button-store-hero：更大的 store hero CTA，18px/300，14px 28px，少量使用。
- button-icon-circular：44px 正圆，rgba(210,210,215,0.64) 半透明灰，覆盖在摄影/产品图上。
- product-tile-light/parchment/dark：full-bleed，无圆角，80px 垂直内边距；内容顺序是标题 → tagline → CTA → 产品图。
- store-utility-card：白底、1px #e0e0e0、18px 圆角、24px padding、1:1 产品图、产品名 17px/600、价格 17px/400、蓝色文字链接。
- configurator-option-chip/search-input：pill 形，白底，产品选择/搜索都要呈胶囊感；selected chip 使用 2px #0071e3。
- floating-sticky-bar：底部 64px 磨砂条，左价格，右蓝色 Add to Bag。
- footer：#f5f5f7，dense link 行高 2.41，fine print 12px，整体信息密度可比正文高。

# 响应式
- 1440px 以上内容锁 1440px；1068px 附近进入 small desktop；833/834px 是全局导航折叠关键点；734/640/480px 逐步收紧手机布局。
- product tile 从多列/大图转为单列；小屏垂直 padding 从 80px 降到 48px。
- hero 56px → 40px → 34px → 28px；store/accessories 网格 5/4 → 3 → 2 → 1。
- 触控目标至少 44px；圆形图标按钮固定 44x44。

# Do / Don't
- Do：只用 Action Blue 表达交互；正文 17px；浅/深 tile 交替；pill CTA；产品图专属投影；press scale 0.95；全局导航保持纯黑。
- Don't：不要第二强调色，不要卡片/按钮阴影，不要装饰渐变，不要 500 字重正文，不要给 full-bleed tile 加圆角，不要用 #2997ff 到浅色底上。`,
  themeCss: `:root{
  --apple-primary:#0066cc;--apple-primary-focus:#0071e3;--apple-primary-on-dark:#2997ff;
  --apple-ink:#1d1d1f;--apple-body:#1d1d1f;--apple-on-dark:#ffffff;--apple-muted:#7a7a7a;--apple-muted-dark:#cccccc;
  --apple-canvas:#ffffff;--apple-parchment:#f5f5f7;--apple-pearl:#fafafc;
  --apple-tile-1:#272729;--apple-tile-2:#2a2a2c;--apple-tile-3:#252527;--apple-black:#000000;
  --apple-divider-soft:#f0f0f0;--apple-hairline:#e0e0e0;--apple-chip:rgba(210,210,215,0.64);
  --apple-radius-card:18px;--apple-radius-utility:8px;--apple-radius-pearl:11px;--apple-radius-pill:9999px;
  --apple-product-shadow:3px 5px 30px rgba(0,0,0,0.22);
}
body{background:#ffffff;color:#1d1d1f;font-family:"SF Pro Text",-apple-system,BlinkMacSystemFont,system-ui,"Inter",sans-serif;}
a{color:#0066cc;}
button,a{letter-spacing:-0.12px;}`,
};

/** Anthropic Claude 设计规范（PC/移动通用） */
const claude: StyleProfile = {
  id: "claude",
  name: "Claude",
  styleSpec: `【产品风格：Anthropic Claude ——必须严格遵循以下设计规范。暖奶油画布、珊瑚 CTA、深墨产品面，适合 AI/内容/产品介绍/定价页】

# 核心气质
- Claude 是暖、人文、编辑感最强的 AI 产品界面：像文学杂志/长篇专栏，而不是冷蓝色 SaaS 模板。
- 品牌三角：cream canvas #faf9f5 + coral CTA #cc785c + dark navy product surface #181715。
- 页面节奏来自三种 surface mode 的切换：奶油画布 → 浅奶油 feature card → 深墨产品 mockup / code window → coral callout → dark footer。
- 产品展示优先使用真实产品 chrome：代码编辑器、终端、模型对比卡、agent flow mockup；少用摄影，少用抽象营销插画。

# 配色
- 主色 coral #cc785c：用于所有主 CTA、wordmark accent、全幅 coral callout；active/press #a9583e；disabled/border cream #e6dfd8。
- 禁止冷蓝/饱和青作为品牌主色；Claude 的品牌电压必须来自珊瑚色。
- 小面积辅助：teal #5db8a6（连接/状态点）、amber #e8a55a（徽章/高亮）；success #5db872、warning #d4a017、error #c64545。
- 画布：canvas #faf9f5（暖奶油，不能用纯白）；surface-soft #f5f0e8；surface-card #efe9de；surface-cream-strong #e8e0d2。
- 深色产品面：surface-dark #181715；elevated #252320；soft/code inner #1f1e1b。
- 文字：ink #141413；body #3d3d3a；body-strong #252523；muted #6c6a64；muted-soft #8e8b82；深底文字 #faf9f5，深底次级 #a09d96。
- Hairline #e6dfd8 / #ebe6df，像一层高度变化，不像硬黑线。

# 排版
- Display headline 必须用 Copernicus / Tiempos Headline serif，字重 400，绝不加粗；fallback 用 Cormorant Garamond / EB Garamond。
- Body/UI 用 StyreneB / Inter humanist sans；代码用 JetBrains Mono / ui-monospace。
- Display 层级：64px/400/1.05/-1.5px；48px/400/1.1/-1px；36px/400/1.15/-0.5px；28px/400/1.2/-0.3px。
- Title 层级：22px/500、18px/500、16px/500，均用 sans；body 16px/400/1.55，small body 14px/400/1.55。
- Caption 13px/500；uppercase caption 12px/500/letter-spacing 1.5px；button 14px/500；nav 14px/500。
- 负字距的 serif display 是品牌声音，不能用 Inter/Helvetica 做大标题；也不要把 serif 标题设为 bold。

# 形状与间距
- 圆角层级：4px 小徽章/细节；6px inline button/dropdown；8px button/input/category tab；12px feature/pricing/code/model card；16px hero illustration/marquee；pill 9999px badge。
- 间距基数 4px；8/12/16/24/32/48；section 96px；大 CTA 内部可 64px；最大内容宽约 1200px 居中。
- Feature/pricing/model card 内边距 32px；code window/connector 24px；connector tile 可 20px。
- Hero 常用 6/6 分栏：左 serif h1 + subcopy + button row，右 line-art / product mockup / code card。
- Grid：feature 3→2→1；connector 4/6→3/2→1；pricing 3/4→2→1。

# 层级与阴影
- 色块优先，阴影稀有。多数层级靠 cream card 与 dark surface 的颜色对比。
- 默认 body/top nav/hero 平面无阴影；输入/边界用 1px hairline；feature card 用 surface-card 无阴影。
- 只有 hover/elevated 态可用极淡阴影 0 1px 3px rgba(20,20,19,0.08)，不要做厚重投影。
- 深色 mockup 通过内部 chrome（代码行号、状态栏、syntax highlight、terminal panel）建立细节，而不是外部阴影。

# 组件与标记
- top-nav：64px 高，cream canvas 背景；左 Anthropic spike mark + Claude wordmark，中间产品/方案/价格/研究等，右侧 Sign in 文本 + Try Claude coral CTA。
- Anthropic spike-mark：4-spoke radial asterisk，用作 wordmark 前缀和行内内容标记；不要随意变成装饰图案。
- button-primary：#cc785c 背景、白字、14px/500、8px radius、12px 20px、40px 高；active 用 #a9583e。
- button-secondary：cream 背景 + hairline + ink 文本；dark surface 上的 secondary 用 #252320 + #faf9f5，不反白成浅按钮。
- text-link：coral 文字链接，是小面积品牌识别点。
- feature-card：#efe9de，12px radius，32px padding，标题 18px/500 + body 16px/400。
- product-mockup-card-dark：#181715，cream text，12px radius，32px padding，用来展示 Claude 产品界面。
- code-window-card：#181715 外壳 + #1f1e1b 内部代码块，JetBrains Mono 14px/1.6，line numbers 与 status bar 使用 muted-soft/elevated。
- model-comparison-card：white/cream + hairline，展示 Opus/Sonnet/Haiku，模型名可用 serif display-md。
- pricing-tier-card：canvas + hairline + 12px radius + 32px padding；价格/计划名可混用 serif display-sm；featured tier 反转为 dark surface。
- callout-card-coral / cta-band-coral：大面积 #cc785c + 白字 + 12px radius，用于高电压 CTA；内部按钮应反转为 cream。
- cta-band-dark：#181715 + cream text，适合开发者/code 页面预页脚 CTA。
- connector-tile：white + hairline + 12px radius + 20px padding，logo + 16px/500 名称 + 描述。
- cookie-consent-card：bottom-right dark card，12px radius，24px padding。
- badge-pill：surface-card + ink；badge-coral：coral + white，uppercase 12px/500/1.5px。
- category-tab：inactive 透明 + muted；active surface-card + ink，8px radius。

# 响应式
- <768px：hamburger nav；hero h1 64→32px；hero 6/6 分栏变单列，mockup 在内容下方；feature/pricing/footer 全部单列。
- 768-1024px：feature 2-up、connector 3-up、pricing 2-up；top-nav 收紧。
- 1024-1440px：完整 nav，3-up feature，4/6-up connector，3/4-up pricing。
- Code window 在移动端保留字号和横向滚动，不强制换行破坏代码。

# Do / Don't
- Do：用 cream canvas；所有 display headline 用 Copernicus/Tiempos；coral 只给主 CTA 和大 callout；用 dark mockup 展示真实产品 chrome；cream/dark/coral 交替制造节奏；section 96px。
- Don't：不要纯白/冷灰画布，不要蓝色品牌 accent，不要 bold serif，不要用 Inter 做 display，不要把 coral 到处涂，不要连续两个分区用同一种 surface。`,
  themeCss: `:root{
  --claude-primary:#cc785c;--claude-primary-active:#a9583e;--claude-primary-disabled:#e6dfd8;
  --claude-ink:#141413;--claude-body:#3d3d3a;--claude-body-strong:#252523;--claude-muted:#6c6a64;--claude-muted-soft:#8e8b82;
  --claude-canvas:#faf9f5;--claude-surface-soft:#f5f0e8;--claude-surface-card:#efe9de;--claude-surface-cream-strong:#e8e0d2;
  --claude-surface-dark:#181715;--claude-surface-dark-elevated:#252320;--claude-surface-dark-soft:#1f1e1b;
  --claude-on-dark:#faf9f5;--claude-on-dark-soft:#a09d96;--claude-hairline:#e6dfd8;--claude-hairline-soft:#ebe6df;
  --claude-teal:#5db8a6;--claude-amber:#e8a55a;--claude-success:#5db872;--claude-warning:#d4a017;--claude-error:#c64545;
  --claude-radius-button:8px;--claude-radius-card:12px;--claude-radius-hero:16px;--claude-radius-pill:9999px;
}
body{background:#faf9f5;color:#141413;font-family:"StyreneB","Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
a{color:#cc785c;}
h1,h2,.display{font-family:"Copernicus","Tiempos Headline","Cormorant Garamond",serif;font-weight:400;}`,
};

/** Notion 设计规范（PC/移动通用） */
const notion: StyleProfile = {
  id: "notion",
  name: "Notion",
  styleSpec: `【产品风格：Notion ——必须严格遵循以下设计规范。暖纸白、近黑 Inter、单一蓝色结构色、多彩贴纸只做装饰】

# 核心气质
- Notion 像日光下整理得很好的书桌：暖纸白画布、近黑文字、安静 chrome，内容像文档一样铺开。
- 结构色只有一个：Notion Blue #0075de，用于 primary CTA、链接、active/focus；其它颜色只能是贴纸/插画/分类点。
- 品牌个性由多彩 sticker palette 承担，UI 本身保持黑白灰 + 蓝，不做彩色 chrome。
- 允许一个深靛蓝 #213183 的暗色 hero「night band」，这是全页唯一暗岛；其余分区回到 daylight paper canvas。

# 配色
- Primary #0075de：唯一结构/动作色。pressed #005bab。所有主按钮、内联链接、active tab、focus signal 都用它。
- Secondary deep indigo #213183：只用于 full-bleed dark hero/night band，不要在普通卡片/按钮里复用。
- Canvas-soft #f6f5f4：主页面/页脚暖纸白；canvas/surface #ffffff：卡片、nav、表单字段。
- Hairline #e6e6e6：1px 边框/分割线，配合几乎不可见阴影。
- Text：ink #000000（可用 95% opacity 软化）；ink-secondary #31302e；ink-muted #615d59；ink-faint #a39e98。
- Sticker palette：sky #62aef0、purple #d6b6f6、deep purple #391c57、pink #ff64c8、orange #dd5b00、deep orange #793400、teal #2a9d99、green #1aae39、brown #523410。
- 贴纸色只用于插画块、app icon sticker、category dot、装饰星座，严禁用于 CTA、导航 active、表格状态主结构或大面积 section 背景。

# 排版
- 全系统只用 NotionInter（fallback Inter, -apple-system, system-ui, Segoe UI, Helvetica, Arial），没有 serif、没有 display mono。
- Display-1：64px / 700 / line-height 1.0 / letter-spacing -2.125px；Display-2：54px / 700 / 1.04 / -1.875px。
- Heading：40px / 700 / 1.1 / -1px；26px / 700 / 1.23 / -0.625px；22px / 700 / 1.27 / -0.25px。
- Title：20px / 600 / 1.4 / -0.125px。
- Body：16px / 400 / 1.5；dense body/nav/table 15px / 400 / 1.33；button 16px / 500 / 1.5；caption 14px；eyebrow 12px / 600 / +0.125px。
- 标题靠 700 字重 + 强负字距表达自信，正文保持 400 和 1.5 行高，不能用装饰字体或花哨字重。

# 形状与间距
- 圆角：4px 表单字段/小 tag；5px menu/list row/status pill；8px utility/nav button/小卡；12px feature card/illustration frame；16px large container/image well；9999px marketing CTA/badge/circular icon。
- 间距基数 8px；token 4/8/12/16/24/28/32；card 内边距 24px；footer/大型空态可 32px。
- 最大内容宽约 1080-1300px 居中；外边距慷慨。分区靠大纵向留白，而不是粗线或重卡片。
- 暗色 hero full-bleed；主体 section 回到 centered container。

# 层级与阴影
- 默认卡片使用 hairline + no shadow；抬起态才用多层近透明微影，不允许硬投影。
- Level 1 可用 0 0.175px 1.041px rgba(0,0,0,0.01), 0 0.8px 2.925px rgba(0,0,0,0.02), 0 2.025px 7.847px rgba(0,0,0,0.027), 0 4px 18px rgba(0,0,0,0.04)。
- Modals/popovers 可用更深 5 层堆叠，最终约 rgba(0,0,0,0.05) 0 23px 52px。
- 真正的深度来自贴纸插画、星空、色块标题带，而不是阴影。

# 组件与节奏
- nav-bar：白色 #fff 表面，ink 链接，15px body-sm，padding 16px；左 wordmark，中间产品/方案，右 Log in + utility/Get Notion free；平板以下 hamburger。
- button-primary：#0075de + 白字 + 16px/500 + pill；pressed 用 #005bab，可有短促 scale(0.9)。
- button-secondary：白底 + ink + pill + soft Level-1 shadow，常与 primary 成对出现。
- button-utility：白底 + ink + 8px radius + 4px 14px + hairline，用于 nav CTA / pricing select，不要做成大 pill。
- button-icon-circular：圆形 9999px，rgba(0,0,0,0.05) 半透明填充，可用于播放/轮播控制。
- feature-card：白底、ink、12px radius、24px padding，顶部可有贴纸色 illustration band；默认 hairline 无阴影。
- feature-card-elevated：同 feature-card，但加 soft Level-1 shadow。
- pricing-plan-card：白底、8px radius、24px padding、15px body；featured plan 用 #f6f5f4 暖纸白填充，而不是蓝色边框。
- text-input：白底、ink、15px body、4px radius、6px padding、1px #ddd；focus 加 soft Level-1 shadow，不变成蓝色大边框。
- hero-band：full-bleed #213183，白字 64px display，贴纸星座场，primary + secondary CTA；这是唯一暗色大分区。
- badge-pill：白底 + blue 文本 + 12px/600 eyebrow + pill + 4px 8px。
- footer：#f6f5f4，#31302e 链接，14px caption，32px padding，多列信息目录。
- ex surfaces 可复用：pricing tier、product selector、cart drawer、app shell row、data table cell、auth form、modal、empty state、toast，都应由白底/暖纸白/hairline/蓝色 active 重新 skin。

# 响应式
- 1440px+ 展示完整多列；1080-1300px 标准 centered container；768-840px grid 变 2-up 且 nav 开始收缩；≤600px 单列、hamburger、full-width CTA。
- Pricing 从 4 列变堆叠 plan card；feature grid 3/2-up 到单列。
- 产品截图和 illustration tile 在 12/16px 圆角 frame 内流式缩放；sticker 固定小尺寸重排，不裁切主体。
- 移动端仍保留 44x44 触控目标，pill CTA 不要压扁。

# Do / Don't
- Do：primary blue 只做动作；页面大底用 warm paper；贴纸色只进插画；display 字号显著负字距；pill CTA vs 8px utility button；深靛 hero 只出现一次。
- Don't：不要用贴纸色做 CTA 或结构填充；不要第二结构色；不要给 input 用 pill；不要重阴影；不要正文加粗；不要全页纯白临床感。`,
  themeCss: `:root{
  --notion-primary:#0075de;--notion-primary-active:#005bab;--notion-secondary:#213183;--notion-on-primary:#ffffff;
  --notion-canvas:#ffffff;--notion-canvas-soft:#f6f5f4;--notion-surface:#ffffff;--notion-hairline:#e6e6e6;
  --notion-ink:#000000;--notion-ink-secondary:#31302e;--notion-muted:#615d59;--notion-faint:#a39e98;
  --notion-sky:#62aef0;--notion-purple:#d6b6f6;--notion-purple-deep:#391c57;--notion-pink:#ff64c8;
  --notion-orange:#dd5b00;--notion-orange-deep:#793400;--notion-teal:#2a9d99;--notion-green:#1aae39;--notion-brown:#523410;
  --notion-radius-xs:4px;--notion-radius-sm:5px;--notion-radius-md:8px;--notion-radius-lg:12px;--notion-radius-xl:16px;--notion-radius-full:9999px;
  --notion-shadow-soft:0 0.175px 1.041px rgba(0,0,0,0.01),0 0.8px 2.925px rgba(0,0,0,0.02),0 2.025px 7.847px rgba(0,0,0,0.027),0 4px 18px rgba(0,0,0,0.04);
}
body{background:#f6f5f4;color:#000000;font-family:"NotionInter","Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;}
a{color:#0075de;}`,
};

/** Slack 设计规范（PC/移动通用，来源：/Users/hxl/Downloads/slack.md） */
const slack: StyleProfile = {
  id: "slack",
  name: "Slack",
  styleSpec: `【产品风格：Slack ——必须严格遵循以下设计规范。深茄紫主色、奶油/薰衣草画布、过度舒展的 pill CTA、柔和彩色 mesh 背景 + 产品 UI mockup】

# 核心气质
- Slack 风格围绕 deep aubergine #4a154b 展开：主 CTA、featured pricing tier、页脚、wordmark、收尾 CTA band 都应回到茄紫。
- 画面不是冷白 SaaS，而是 cream/lavender 的温暖工作协作品牌：#f4ede4 奶油、#f9f0ff 淡薰衣草，配合 peach/lavender/dusty green 的 pastel-mesh gradient。
- Hero 的标志性结构是柔和 pastel mesh 背景 + 浮在上面的产品 UI 截图/mockup。UI mockup 像悬浮在光雾上，不要塞进重卡片。
- 蓝色 #1264a3 只用于正文内联链接，是系统里唯一脱离 aubergine/cream 的文字色。

# 配色
- Primary aubergine #4a154b；deep #481a54；press #611f69；tint/border #592466。
- On primary #ffffff；aubergine surface 上的次级文字用 mauve #d9bdde。
- 文本：ink #1d1d1d；secondary/caption #696969。
- Link blue #1264a3，hover #3860be；不要把蓝色用于按钮或大面积结构。
- Canvas：white #ffffff；cream #f4ede4；lavender #f9f0ff；surface-elev #ffffff。
- Hairline #e6e6e6；强线/特殊强调可用 #000000，但要克制。
- Semantic：error #cc4117；success #007a5a。
- 禁止引入第三强调色。品牌色组合就是 aubergine + blue link + cream/lavender mesh。

# 排版
- Display 用 Salesforce Avant Garde，fallback system-ui / -apple-system / Inter；Body/UI 用 Salesforce Sans，fallback Inter。
- Display-xxl：64px / 700 / line-height 1.12 / letter-spacing -0.768px，用于 hero。
- Display-xl：58px / 600 / 1.25 / -0.464px；Display-lg：50px / 700 / 1.12 / -0.6px，用于巨型数据/统计。
- Display-md：32px / 700 / 1.25 / -0.256px；heading-lg 24px/700；heading-md 22px/600；heading-sm 18px/600。
- Body-lg：18px / 400 / 1.55；body-md：16px / 400 / 1.55；body-strong：16px / 700 / letter-spacing 0.16px。
- Button：18px/700 或 16px/700，label 很有分量；micro-cap 12px/700/0.96px uppercase。
- Display 必须有负字距，body 保持 1.55 舒适行高；不要用默认 tracking 生成松散标题。

# 形状与间距
- 所有按钮统一使用 90px pill 圆角；不要换成普通圆角矩形。
- Radius scale：2px tiny tag；4px input；8px compact chrome/video；12px medium card；16px pricing/feature card；48px stat badge backdrop；90px button pill。
- 间距基数 8px，细分 4/8/12/16/20/24/28；marketing section 64-96px，transaction page 可收紧到 48px。
- Pricing/feature card padding 32px；aubergine band padding 48px。
- Container 约 1240px，pastel mesh 可越过 container 边缘形成柔和外溢。

# 层级与阴影
- 品牌深度主要来自 pastel-mesh gradient，而不是传统 shadow。
- Hero/product mockup 可用 rgba(0,0,0,0.1) 0 0 32px 或 0 5px 20px 的轻阴影，但不要让阴影抢过 gradient。
- Toast/notification 可用 rgba(0,0,0,0.2) 0 1px 10px。
- Aubergine 特殊 focus/边界可用 rgb(97,31,105) 0 0 0 1px inset。

# 组件
- nav-bar-light：白底，ink 文本，16px 24px padding；左 logo，中间 nav，右侧 Sign In 次级 pill + Try For Free 主 pill。
- button-primary-pill：#4a154b + 白字，16px/700，14px 28px，90px radius；pressed #611f69。
- button-secondary-pill：#f9f0ff + ink，10px 30px，90px radius；作为主按钮旁的柔和第二动作。
- button-outline-aubergine：白底 + aubergine 文本 + 2px aubergine border + pill。
- button-outline-on-aubergine：aubergine 面上使用白字白边 pill。
- text-input：白底，#1d1d1d，16px body，10px 12px padding，4px radius，1px hairline。
- pill-cap-shade：#f4ede4 背景，12px uppercase，4px 12px，pill，用作 eyebrow。
- card-pricing：白底，16px radius，32px padding，1px hairline；标题 24px/700，价格可用 display-md。
- card-pricing-featured：#4a154b 背景 + 白字，是推荐/featured tier 的核心信号。
- card-feature-cream：#f4ede4，16px radius，32px padding。
- card-aubergine-band：#4a154b，白字，16px radius，48px padding，用作 closing CTA。
- card-stat：白底，巨型 50px aubergine 数字 + 小 caption。
- pastel-mesh-gradient backdrop：用多个 radial-gradient 混合 peach/lavender/dusty-green，放在 hero 背景，不要做成单张图片。
- floating product UI mockup：产品截图用 4:3 或 3:2 比例，12px radius，悬浮于 mesh 上；不要放进厚 chrome 卡片。
- footer-aubergine：全宽 #4a154b，白字，链接组用 #d9bdde，4-5 列，底部 legal 行。

# 响应式
- ≥1440px：full-bleed pastel mesh hero，pricing 4-up。
- 1024-1440px：默认桌面，pricing 4-up。
- 768-1023px：pricing 2-up，product UI mockup 裁切到重点面板。
- <768px：hamburger nav，pricing 1-up，display-xxl 64px 降到 40px。
- Pill button 触控高度至少 48px；form field 至少 44px。
- Mobile 上 pastel mesh 需要重新铺排，避免背景色完全消失；mockup 以重点内面板裁切，不要整图等比缩到看不清。

# Do / Don't
- Do：aubergine 只给 filled CTA、featured tier、closing band、footer；所有按钮都是 90px pill；hero 使用 pastel mesh + floating UI mockup；inline link 用 #1264a3。
- Don't：不要第三强调色；不要缩小按钮 padding 到普通 SaaS 尺寸；不要默认 tracking 的大标题；不要把 UI 截图塞进厚卡片；不要用 aubergine 做正文色；不要出现方形按钮。`,
  themeCss: `:root{
  --slack-primary:#4a154b;--slack-primary-deep:#481a54;--slack-primary-press:#611f69;--slack-primary-tint:#592466;
  --slack-on-primary:#ffffff;--slack-ink:#1d1d1d;--slack-muted:#696969;--slack-on-aubergine-muted:#d9bdde;
  --slack-link:#1264a3;--slack-link-hover:#3860be;
  --slack-canvas:#ffffff;--slack-cream:#f4ede4;--slack-lavender:#f9f0ff;--slack-surface:#ffffff;
  --slack-hairline:#e6e6e6;--slack-error:#cc4117;--slack-success:#007a5a;
  --slack-radius-input:4px;--slack-radius-card:16px;--slack-radius-band:16px;--slack-radius-pill:90px;
  --slack-shadow-mockup:0 0 32px rgba(0,0,0,0.1);
}
body{background:#ffffff;color:#1d1d1d;font-family:"Salesforce-Sans","Inter",system-ui,-apple-system,BlinkMacSystemFont,sans-serif;}
a{color:#1264a3;}
h1,h2,.display{font-family:"Salesforce-Avant-Garde","Inter",system-ui,-apple-system,BlinkMacSystemFont,sans-serif;}`,
};

/** Vercel 设计规范（PC/移动通用，来源：/Users/hxl/Downloads/vercel.md） */
const vercel: StyleProfile = {
  id: "vercel",
  name: "Vercel",
  styleSpec: `【产品风格：Vercel ——必须严格遵循以下设计规范。Geist 字体、近黑/近白、hairline card、hero mesh gradient，适合开发者平台/技术产品/文档营销页】

# 核心气质
- Vercel 是极致减法：#fafafa 近白画布 + #171717 near-black ink，几乎没有彩色 chrome。
- 唯一装饰系统是 hero 里的 multi-stop mesh gradient（cyan/blue/violet/magenta/amber）；其它区域回到 ink-on-white。
- 页面像工程文档在销售产品：精确、克制、网格化、hairline 卡片、代码/节点图/技术标签。
- 色彩只存在于 hero gradient、极少量 illustration accent、链接/focus；不要用彩色块做普通 section。

# 配色
- Primary / ink #171717：标题、主 CTA 背景、logo、最高强调文本。
- On primary #ffffff；body #4d4d4d；mute #8f8f8f；faint #a1a1a1。
- Canvas #fafafa；elevated #ffffff；hairline #ebebeb；hairline-soft #f2f2f2。
- Link / active #0070f3；link-deep #0761d1；link-soft #d3e5ff。
- Semantic：error #ee0000 / #c50000；warning #f5a623 / #ffefcf / #ab570a；success 可沿用 link blue。
- Accent stops：violet #7928ca、cyan #50e3c2、pink #ff0080、magenta #eb367f。
- Legacy gradients：Develop #007cf0→#00dfd8；Preview #7928ca→#ff0080；Ship #ff4d4d→#f9cb28。它们只服务 hero/illustration，不做按钮/卡片填充。

# 排版
- 全系统使用 Geist Sans；代码、inline technical token、section eyebrow 使用 Geist Mono。fallback：Inter + JetBrains Mono/IBM Plex Mono。
- Display-xl：48px / 600 / line-height 48px / letter-spacing -2.4px。
- Heading-lg：32px / 600 / line-height 40px / -1.28px；heading-md：20px / 600 / 28px / -0.4px。
- Label-sm：14px / 500 / 20px / -0.28px。
- Mono-eyebrow：12px / 500 / 16px / 0，用 uppercase 技术标签表达规格感。
- Body-lg：16px / 400 / 24px；body-md：14px / 400 / 20px；body-sm：12px / 400 / 16px。
- Button-lg 16px/500；button-md 14px/500；code 14px/400/20px。
- 字重二元化：heading 600，button/label 500，正文 400；不要 light/black/italic。
- 大标题必须负字距，越大越紧；正文保持 0。

# 形状与间距
- Base unit 4px；scale 4/8/12/16/24/32/40/64/96/128。
- Section vertical rhythm 96-128px；card padding 24-32px；footer 64px。
- Radius：0px full-bleed/divider；6px nav/app button/input；12px feature card/code block；16px pricing card/large panel；64px category pill；100px marketing CTA pill；9999px circular/icon/avatar。
- 形状语法是 bimodal：marketing CTA 用黑色 full pill；nav/app controls 用 6px square button；不要混用。
- Container 约 1200px 居中，hero/CTA 可居中大留白。

# 层级与阴影
- 默认 depth = 1px hairline + near-white-on-white surface step，几乎无阴影。
- Level 0：#ebebeb hairline，无 shadow，用于 card/input/divider。
- Level 1：border + 0 1px 1px rgba(0,0,0,0.04)。
- Level 2：layered soft shadow（0 2px 2px + 0 8px 16px -4px 低透明黑）+ inset hairline，用于 menus/modals/tooltips。
- 不要用重投影；不要用 glow；hero mesh 是唯一 atmospheric depth。

# 组件
- nav-bar：#fafafa，底部 1px #ebebeb，body grey 文本，12px 24px padding；左黑色 wordmark，右 Sign Up / Log In。
- nav-link：#4d4d4d，14px body，9999px hit area，8px 12px padding。
- button-primary：#171717 + 白字，16px/500，100px pill，水平 padding 14px，营销 CTA。
- button-secondary：白底 + #171717，100px pill，和 primary 同尺寸。
- button-primary-sm：黑底白字，14px/500，6px radius，水平 padding 6px，用于 Sign Up 等 nav/app CTA。
- button-ghost-sm：白底、黑字、1px hairline、6px radius，用于 Log In / Ask AI 等 app chrome。
- button-category-pill：白底黑字，64px radius，水平 padding 16px，用于 AI Apps / Web Apps 类别标签。
- button-icon-circular：白底、黑图标、1px hairline、9999px 圆形。
- text-input：白底、#171717、1px hairline、14px body、6px radius、8px 12px padding。
- feature-card：白底、1px hairline、12px radius、24px padding；内容常为 node graph / code illustration。
- feature-card-elevated：同 feature-card，但可用 Level-2 shadow。
- pricing-card：白底、1px hairline、16px radius、32px padding。
- code-block：白底、1px hairline、Geist Mono 14px/20px、12px radius、16px padding。
- logo-strip：#fafafa，灰色 logo/text，32px 24px padding。
- hero-band：#fafafa + multi-stop mesh gradient，48px display headline，128px 24px padding。
- cta-band：近白底，大标题 + black pill CTA，96px 24px padding。
- footer：#fafafa，顶部 hairline，#4d4d4d 文本，64px 24px padding，多列链接。

# 响应式
- ≤640px：单列堆叠，nav 变 menu trigger，hero type 下调，pill CTA 可 full-width。
- 768px：card grid 变 2-up，nav 收紧。
- 1024px：3-4 列 grid，完整 nav。
- 1200px+：centered max-width，多列完整布局。
- Code editor / node graph 在窄屏上缩放或横向滚动，不要缩到不可读。
- Marketing pill 和圆形 icon button 要保持 44px 触控目标。

# Do / Don't
- Do：保持 #fafafa canvas + #171717 ink；彩色只放 hero mesh 和小插画；按钮按场景区分 pill vs 6px square；card/input 先用 1px hairline；display 用 Geist 600 负字距；eyebrow 用 Geist Mono uppercase。
- Don't：不要大面积彩色 surface；不要在同一上下文混用 pill 和 square；不要堆重阴影；不要正文纯黑 #000；不要第二套装饰系统；不要放松 display tracking。`,
  themeCss: `:root{
  --vercel-primary:#171717;--vercel-on-primary:#ffffff;--vercel-ink:#171717;--vercel-body:#4d4d4d;--vercel-mute:#8f8f8f;--vercel-faint:#a1a1a1;
  --vercel-canvas:#fafafa;--vercel-elevated:#ffffff;--vercel-hairline:#ebebeb;--vercel-hairline-soft:#f2f2f2;
  --vercel-link:#0070f3;--vercel-link-deep:#0761d1;--vercel-link-soft:#d3e5ff;
  --vercel-error:#ee0000;--vercel-warning:#f5a623;--vercel-violet:#7928ca;--vercel-cyan:#50e3c2;--vercel-pink:#ff0080;--vercel-magenta:#eb367f;
  --vercel-develop-start:#007cf0;--vercel-develop-end:#00dfd8;--vercel-preview-start:#7928ca;--vercel-preview-end:#ff0080;--vercel-ship-start:#ff4d4d;--vercel-ship-end:#f9cb28;
  --vercel-radius-sm:6px;--vercel-radius-md:12px;--vercel-radius-lg:16px;--vercel-radius-pill:100px;--vercel-radius-category:64px;--vercel-radius-full:9999px;
  --vercel-shadow-whisper:0 1px 1px rgba(0,0,0,0.04);
}
body{background:#fafafa;color:#171717;font-family:"Geist","Inter",Arial,sans-serif;}
a{color:#0070f3;}
code,kbd,pre,.mono{font-family:"Geist Mono","JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;}`,
};

export const STYLE_PROFILES: StyleProfile[] = [
  antDesign,
  tDesign,
  vant,
  apple,
  claude,
  notion,
  slack,
  vercel,
];

export function getStyleProfile(id?: string | null): StyleProfile | undefined {
  if (!id) return undefined;
  return STYLE_PROFILES.find((p) => p.id === id);
}

/** 给前端下拉用的轻量列表 */
export const STYLE_PROFILE_OPTIONS = STYLE_PROFILES.map((p) => ({ id: p.id, name: p.name }));
