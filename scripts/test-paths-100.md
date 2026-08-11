# 100 条用户路径测试用例清单

> 断言策略：所有条目跑「通用完整性」（页面不崩/不白屏、`<!doctype>`+`<html>`+`<body>`+`</html>` 齐全、体量 0.55–2.5x、`<title>` 元素非空、ask 用例不产新 code）。标 🔧 的额外跑「严格断言」（改动生效 + 未误改 + 局部化）。预期路径基于当前代码逻辑预测（Part A/C 已上线）。
> 耗时栏：单条墙钟预估（基于 test-iter-edit.mjs 实测：scope patch ~3s、整页重出 ~40s、生成 ~40–60s）。

## G1. 新生成（5 条，不跑，仅列入覆盖面）

| ID | 指令 | 预期路径 | 断言 | 耗时 |
|----|------|---------|------|------|
| C01 | 生成 PC 原生 HTML 财务仪表盘 | runGenerate(原生) | 🔧 产出完整单页 HTML | 40–60s |
| C02 | 生成 PC DPL 后台 | runGenerate(DPL) → buildPcSandbox | 🔧 产出 JSX+沙箱预览 | 50–70s |
| C03 | 生成移动原生 HTML | runGenerate(原生,mobile) | 🔧 产出 mobile 布局 | 40–60s |
| C04 | 生成移动 DPL | runGenerate(DPL,mobile) → buildMobileSandbox | 🔧 产出移动沙箱 | 50–70s |
| C05 | 生成多页 DPL（3 页 flow） | runGenerate → structure 多页 | 🔧 产出 3 页 flow | 60–90s |

## G2. raw HTML 精确单元素修改（Part A scope patch，15 条）

基底：C01 产出的 28KB 财务仪表盘。预期多数 `locate→scope`。

| ID | 指令 | 预期路径 | 断言 | 耗时 |
|----|------|---------|------|------|
| E01 | 把页面主标题「财务总览仪表盘」改成「财税驾驶舱」 | locate→scope | 🔧 新标题在、旧标题不在 | 3s |
| E02 | 把金额「¥ 486,200」改成「¥999,888」 | locate→scope | 🔧 新数字在、旧串不在 | 3s |
| E03 | 把「智能记账」按钮文字改成「快速记账」 | locate→scope | 🔧 该按钮文案改对 | 3s |
| E04 | 把页面顶部面包屑「首页」改成「工作台」 | locate→scope | 🔧 面包屑改对 | 3s |
| E05 | 把 tab「税务」改成「税务管理」 | locate→scope | ✅ 通用 | 3s |
| E06 | 把搜索框占位符「请输入」改成「搜索关键词」 | locate→scope | 🔧 placeholder 改对 | 3s |
| E07 | 把表头「金额」改成「金额（元）」 | locate→scope(isTableEdit) | 🔧 表头改对 | 3s |
| E08 | 把页脚版权年份 2025 改成 2026 | locate→scope | 🔧 年份改对 | 3s |
| E09 | 把「刷新」按钮改成「同步」 | locate→scope | 🔧 按钮文案改对 | 3s |
| E10 | 把某 KPI 卡标题「本月营收」改成「本月收入」 | locate→scope | 🔧 卡标题改对 | 3s |
| E11 | 把提示语「数据加载中」改成「正在加载」 | locate→scope | ✅ 通用 | 3s |
| E12 | 把「查看详情」链接改成「展开明细」 | locate→scope | 🔧 链接文案改对 | 3s |
| E13 | 把单位「万元」改成「元」 | locate→scope | 🔧 单位改对 | 3s |
| E14 | 把空状态文案「暂无数据」改成「还没有数据」 | locate→scope | ✅ 通用 | 3s |
| E15 | 把日期「2025-07-04」改成「2026-07-04」 | locate→scope | 🔧 日期改对 | 3s |

## G3. raw HTML 新增/插入（10 条）

| ID | 指令 | 预期路径 | 断言 | 耗时 |
|----|------|---------|------|------|
| E16 | 在「待办事项」区域新增一条「待确认费用分摊」 | locate→scope(needsWiderScope) | 🔧 sentinel 在 | 4s |
| E17 | 在左侧导航新增一项「审计」 | locate→scope(语义容器) | 🔧 新导航项在 | 4s |
| E18 | 在表格末尾新增一行数据 | locate→scope(isTableEdit) | 🔧 行数+1 | 4s |
| E19 | 在表格加一列「状态」 | locate→scope(isTableEdit) | 🔧 列数+1 | 4s |
| E20 | 新增一个统计卡片显示「活跃用户」 | locate→scope | 🔧 sentinel 在 | 4s |
| E21 | 在页面底部加页脚版权「© 2026 亿企赢」 | locate→scope | 🔧 sentinel 在 | 5s |
| E22 | 给「智能记账」按钮加一个徽标「3」 | locate→scope | 🔧 徽标在 | 4s |
| E23 | 在表单里新增一个「备注」输入框 | locate→scope | 🔧 输入框在 | 4s |
| E24 | 新增一个右侧侧边栏区块「快捷入口」 | locate→scope | ✅ 通用 | 6s |
| E25 | 在 KPI 区上方加一行汇总「合计：¥1,234,567」 | locate→scope | 🔧 sentinel 在 | 4s |

## G4. raw HTML 删除/移动（10 条）

| ID | 指令 | 预期路径 | 断言 | 耗时 |
|----|------|---------|------|------|
| E26 | 把左侧导航里的「税务」这一项整个删掉 | locate→scope(isRemoveOrMove) 或 no-op→full | 🔧 该 nav 项消失 | 4–42s |
| E27 | 删掉第一条待办 | locate→scope | 🔧 待办数-1 | 4s |
| E28 | 删掉表格最后一行 | locate→scope(isTableEdit) | 🔧 行数-1 | 4s |
| E29 | 删掉表格「备注」列 | locate→scope(isTableEdit) | 🔧 列数-1 | 4s |
| E30 | 删掉页脚版权 | locate→scope | 🔧 页脚消失 | 4s |
| E31 | 把「刷新」按钮移到「智能记账」按钮左边 | locate→scope(isRemoveOrMove) | ✅ 通用 | 4–42s |
| E32 | 把待办事项置顶排序 | locate→scope | ✅ 通用 | 4–42s |
| E33 | 把某 KPI 卡移到最前面 | locate→scope | ✅ 通用 | 4–42s |
| E34 | 删掉搜索框 | locate→scope | 🔧 搜索框消失 | 4s |
| E35 | 删掉空状态提示 | locate→scope | ✅ 通用 | 4s |

## G5. raw HTML 批量修改（Part C，10 条）

| ID | 指令 | 预期路径 | 断言 | 耗时 |
|----|------|---------|------|------|
| E36 | 把所有 KPI 卡片里的数字都翻倍 | locate→scope(batch 上提到容器) | 🔧 多卡变化 | 6s |
| E37 | 给所有按钮加圆角 | locate→scope(batch) | ✅ 通用 | 6s |
| E38 | 所有金额前面加「￥」 | locate→scope(batch) | 🔧 多处变化 | 6s |
| E39 | 表格每行加一个「操作」列 | locate→scope(isTableEdit) | 🔧 列数+1 | 4s |
| E40 | 给所有卡片加阴影 | locate→scope(batch) | ✅ 通用 | 6s |
| E41 | 所有链接改成新窗口打开 | locate→scope(batch) | 🔧 target=_blank | 6s |
| E42 | 所有图片加 alt 文字 | locate→scope(batch) | 🔧 alt 在 | 6s |
| E43 | 所有表单项标为必填 | locate→scope(batch) | ✅ 通用 | 6s |
| E44 | 所有标题加图标 | locate→scope(batch) | ✅ 通用 | 6s |
| E45 | 同列数据对齐方式改成右对齐 | locate→scope(isTableEdit) | ✅ 通用 | 4s |

## G6. raw HTML 样式/布局（10 条）

| ID | 指令 | 预期路径 | 断言 | 耗时 |
|----|------|---------|------|------|
| E46 | 把页面主色调改成绿色 #00B853 | locate→scope 或 full | 🔧 出现 #00B853 | 4–40s |
| E47 | 整体字号调大 2px | locate→scope | ✅ 通用 | 4s |
| E48 | 卡片之间间距加大 | locate→scope | ✅ 通用 | 4s |
| E49 | 表格加斑马条纹 | locate→scope(isTableEdit) | ✅ 通用 | 4s |
| E50 | 改成暗色模式 | locate→scope 或 full | ✅ 通用 | 4–40s |
| E51 | 圆角统一加大 | locate→scope | ✅ 通用 | 4s |
| E52 | 把某卡片背景改成浅蓝 | locate→scope | 🔧 该卡背景变 | 4s |
| E53 | 表格表头居中 | locate→scope(isTableEdit) | ✅ 通用 | 4s |
| E54 | 隐藏「待办事项」整个模块 | locate→scope | 🔧 待办模块消失 | 4s |
| E55 | 显示当前隐藏的「高级筛选」 | locate→scope | ✅ 通用 | 4s |

## G7. 标注点选编辑（marker → scope patch，10 条）

模拟用户点选某元素后发指令（指令带 marker + anchor + outerHTML）。

| ID | 指令 | 预期路径 | 断言 | 耗时 |
|----|------|---------|------|------|
| E56 | 点选某按钮 → 改文案 | marker→scope | 🔧 该按钮文案改对 | 3s |
| E57 | 点选某卡片 → 改背景色 | marker→scope | 🔧 该卡背景变 | 3s |
| E58 | 点选某 nav 项 → 删除 | marker→scope(isRemoveOrMove) | 🔧 该 nav 项消失 | 3s |
| E59 | 点选某卡片 → 在它后面加一张卡 | marker→scope(needsWiderScope) | 🔧 卡片数+1 | 4s |
| E60 | 点选某 tab → 改名 | marker→scope | 🔧 该 tab 改对 | 3s |
| E61 | 点选表格某单元格 → 改内容 | marker→scope | 🔧 单元格改对 | 3s |
| E62 | 点选某 KPI → 改数字 | marker→scope | 🔧 数字改对 | 3s |
| E63 | 点选某图标 → 换成搜索图标 | marker→scope | ✅ 通用 | 3s |
| E64 | 点选某区块 → 改布局为两列 | marker→scope | ✅ 通用 | 4s |
| E65 | 点选所有同类按钮（点选+批量词）→ 加圆角 | marker→scope(batch) | ✅ 通用 | 4s |

## G8. 直接编辑（contentEditable，不调模型，5 条）

| ID | 指令 | 预期路径 | 断言 | 耗时 |
|----|------|---------|------|------|
| E66 | 直接改标题文字「财税驾驶舱」 | onDirectEdit（无 LLM） | 🔧 文字改对、即时 | <1s |
| E67 | 直接改某段落文案 | onDirectEdit | 🔧 文案改对 | <1s |
| E68 | 直接改按钮文字 | onDirectEdit | 🔧 文案改对 | <1s |
| E69 | 直接改表格某单元格 | onDirectEdit | 🔧 单元格改对 | <1s |
| E70 | 直接改链接文字 | onDirectEdit | 🔧 文案改对 | <1s |

## G9. 提问/非修改（ask，5 条）

| ID | 指令 | 预期路径 | 断言 | 耗时 |
|----|------|---------|------|------|
| E71 | 这个页面用了什么图表库？ | classifyEditIntent→ask | 🔧 不动页+有回答 | 1s |
| E72 | 数据是从哪里来的？ | ask | 🔧 不动页+有回答 | 1s |
| E73 | 我可以怎么修改这个原型？ | ask | 🔧 不动页+有回答 | 1s |
| E74 | 支持导出 PDF 吗？ | ask | 🔧 不动页+有回答 | 1s |
| E75 | 你好，今天天气怎么样？ | ask | 🔧 不动页+有回答 | 1s |

## G10. 歧义/边界（10 条）

| ID | 指令 | 预期路径 | 断言 | 耗时 |
|----|------|---------|------|------|
| E76 | 把那个数字改一下 | locate→fallback(ambiguous) | ✅ 通用（页面不崩） | 40s |
| E77 | 把这里改大一点 | locate→fallback(ambiguous) | ✅ 通用 | 40s |
| E78 | [500字超长指令，含多种修改诉求] | full 或 locate→fallback | ✅ 通用 | 40s |
| E79 | （空指令） | classifyEditIntent 兜底 | ✅ 不崩、不发 done | 1s |
| E80 | change the title to "Dashboard" | locate→scope | 🔧 英文标题生效 | 3s |
| E81 | 把 `<?php echo $title; ?>` 改成首页 | locate→scope 或 fallback | ✅ 通用（含代码不被执行） | 3–40s |
| E82 | 把「不存在的模块」改成 X | locate→fallback 或 no-op→full | ✅ 通用（不崩） | 40s |
| E83 | 把整个页面重做成电商首页 | full（looksRewritten 护栏触发） | ✅ 通用 | 40s |
| E84 | 把技术栈换成 Vue | full（护栏拦截重写） | ✅ 通用 | 40s |
| E85 | 导出当前页面 | ask 或 ask 兜底 | ✅ 不动页 | 1s |

## G11. 原样打开 HTML/ZIP（5 条）

| ID | 指令 | 预期路径 | 断言 | 耗时 |
|----|------|---------|------|------|
| E86 | 上传 sample.html 原样打开 | runRawHtml(无编辑词) | 🔧 原样渲染 | 1s |
| E87 | 上传 sample.html 并「把标题改成 X」 | runRawHtml(hasExplicitEditIntent) | 🔧 标题改对 | 40s |
| E88 | 上传 sample.zip 原样打开 | runRawHtml(ZIP 解压内联) | 🔧 静态页渲染 | 1s |
| E89 | 上传 sample.zip 并「删除页脚」 | runRawHtml+edit | 🔧 页脚消失 | 40s |
| E90 | 上传 sample.html 后问「这页面用什么框架」 | runRawHtml+ask | 🔧 不动页 | 1s |

## G12. DPL 编辑（5 条）

| ID | 指令 | 预期路径 | 断言 | 耗时 |
|----|------|---------|------|------|
| E91 | DPL 产物：把首页主标题改成 X | runEdit(DPL JSX 重写) | 🔧 标题改对 | 40s |
| E92 | DPL 产物：把侧边栏导航项改名 | runEdit | 🔧 导航改对 | 40s |
| E93 | DPL 产物：新增一个「设置」页 | runEdit(structure 多页) | 🔧 新页在 | 50s |
| E94 | DPL 产物：主色改成蓝色 | runEdit+normalizeBrandColors | 🔧 品牌色矫正 | 40s |
| E95 | DPL 产物提问：这个原型有哪些页面？ | classifyEditIntent→ask | 🔧 不动页+有回答 | 1s |

## G13. 链式连续修改（5 条，验证迭代不累积崩坏）

在 E01 输出上连续改 5 次，每次接上一次结果。

| ID | 指令 | 预期路径 | 断言 | 耗时 |
|----|------|---------|------|------|
| E96 | 链式1：改主标题 | locate→scope | 🔧 生效 | 3s |
| E97 | 链式2：改某 KPI（接 E96） | locate→scope | 🔧 生效、E96 改动保留 | 3s |
| E98 | 链式3：加一条待办（接 E97） | locate→scope | 🔧 生效、前两次保留 | 4s |
| E99 | 链式4：删一个 nav 项（接 E98） | locate→scope 或 no-op→full | 🔧 生效、前三次保留 | 4–42s |
| E100 | 链式5：批量改所有按钮文案（接 E99） | locate→scope(batch) | 🔧 多按钮变、前四次保留 | 6s |

---

## 汇总

- **分组**：13 组，覆盖 生成(5) / 精确改(15) / 新增(10) / 删移(10) / 批量(10) / 样式(10) / 标注(10) / 直接编辑(5) / 提问(5) / 边界(10) / 原样打开(5) / DPL(5) / 链式(5)
- **断言**：全部「通用完整性」；约 55 条「严格断言」（🔧），其余 45 条「通用完整性」（✅）
- **预估总耗时**（串行）：编辑/标注/直接编辑/提问类 ~3–6s/条，生成/整页重出/DPL ~40–60s/条。**粗估 35–50 分钟**（G1 生成 5 条占 4–6 分钟，G10/G12 整页重出约 6 分钟，其余 ~25 分钟）。
- **关注 bug 点**：① Part A 选错 scope 的 no-op 回退是否真不崩；② Part C 批量上提是否选对容器；③ 标注 marker 路径未回归；④ 直接编辑写回是否破坏结构；⑤ 链式是否累积漂移；⑥ 边界（空指令/代码块/换栈）护栏是否拦住；⑦ DPL 编辑是否污染 JSX（memory 存档的风险点）。

确认后我据此写 `scripts/test-paths-100.mjs` 跑起来。
