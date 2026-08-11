#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (rel) => readFileSync(join(root, rel), "utf8");
const require = createRequire(import.meta.url);

const { introducedPrototypeNavigation, unsafePrototypeNavigation } = require("../desktop/prototype-navigation-core.cjs");

assert.deepEqual(unsafePrototypeNavigation(`<a href="#detail">详情</a><button onclick="openDrawer()">查看</button>`), []);
assert.deepEqual(unsafePrototypeNavigation(`<a href="javascript:void(0)">查看</a>`), []);
assert.match(unsafePrototypeNavigation(`window.location.href = '/youdesign'`).join("、"), /location 赋值/);
assert.match(unsafePrototypeNavigation(`location.assign('/youdesign')`).join("、"), /location 跳转 API/);
assert.match(unsafePrototypeNavigation(`<a href="/youdesign">首页</a>`).join("、"), /非锚点链接/);
assert.match(unsafePrototypeNavigation(`<Button href={nextUrl}>进入</Button>`).join("、"), /非锚点链接/);
assert.match(unsafePrototypeNavigation(`<form action="/save"></form>`).join("、"), /表单提交地址/);
assert.match(unsafePrototypeNavigation(`<meta http-equiv="refresh" content="0;url=/youdesign">`).join("、"), /meta 刷新/);
assert.deepEqual(introducedPrototypeNavigation(`<a href="/legacy">旧链接</a>`, `<a href="/legacy">旧链接</a><a href="#detail">详情</a>`), []);
assert.match(
  introducedPrototypeNavigation(`<a href="/legacy">旧链接</a>`, `<a href="/legacy">旧链接</a><a href="/new">新链接</a>`).join("、"),
  /非锚点链接/
);
assert.match(
  introducedPrototypeNavigation(`<a href="/legacy">旧链接</a>`, `<a href="/new">旧链接</a>`).join("、"),
  /非锚点链接/,
  "修改既有真实导航地址也必须被拒绝"
);

const preview = read("src/components/PreviewPane.tsx");
const guard = read("src/lib/previewNavigation.ts");
const directEditor = read("src/lib/directHtmlEditor.ts");
assert.match(preview, /srcDoc=\{guardedPreviewHtml\}/, "iframe 必须只接收带临时导航守卫的 srcDoc");
assert.match(preview, /isExpectedPreviewDocument\(iframeRef\.current\)/, "iframe 加载非 srcDoc 文档时必须恢复预览");
assert.match(preview, /stripPreviewNavigationGuard/, "保存或点选序列化时不得把临时守卫写回原型");
assert.match(preview, /serializePreviewDocument/, "保存或点选序列化时必须剥离预览期表格滚动容器");
assert.match(guard, /window\.addEventListener\('click'/, "必须在捕获阶段拦截链接点击");
assert.match(guard, /HTMLFormElement\.prototype\.submit/, "必须拦截程序化表单提交");
assert.match(guard, /data-yd-preview-table-scroll/, "超宽表格必须在预览中有独立横向滚动容器");
assert.match(guard, /overflow-x:auto/, "超宽表格滚动容器必须开启横向滚动");
assert.match(guard, /suggestedTableWidth/, "被 width:100% 挤压的多列表格也必须按表头估算合理最小宽度");
assert.match(guard, /syncSplitTableScrolls/, "分离式表格的表头与表体必须同步横向滚动位置");
assert.match(guard, /event\.currentTarget\.scrollLeft/, "横向滚动同步必须以当前滚动容器的 scrollLeft 为准");
assert.match(preview, /__yd_preview_table_guard_style/, "保存或点选序列化时必须移除预览期表格宽度样式");
assert.match(guard, /__yd_preview_text_selection/, "预览期必须注入独立的文字选择样式");
assert.match(guard, /user-select:text!important/, "预览期必须覆盖业务页面的 user-select:none");
assert.match(guard, /data-yd-preview-point-select/, "点选修改时必须能临时关闭文字选择");
assert.match(preview, /setAttribute\(PREVIEW_POINT_SELECT_ATTR, "true"\)/, "进入点选修改时必须设置临时禁选标记");
assert.match(preview, /removeAttribute\(PREVIEW_POINT_SELECT_ATTR\)/, "退出点选修改时必须移除临时禁选标记");
assert.match(preview, /root\.removeAttribute\(PREVIEW_POINT_SELECT_ATTR\)/, "序列化点选页面时必须剥离临时禁选标记");
assert.match(preview, /const root = doc\?\.documentElement;\s*if \(!root \|\| typeof MutationObserver === "undefined"\) return;/, "iframe 根节点未就绪时不得创建 MutationObserver");
assert.match(preview, /mo\.observe\(root, \{/, "MutationObserver 必须只观察已校验存在的 iframe 根节点");
assert.doesNotMatch(preview, /mo\.observe\(doc\.documentElement,/, "不得把可能为空的 documentElement 直接传给 MutationObserver");
assert.match(preview, /const root = doc\?\.documentElement;\s*if \(!doc \|\| !root\) return;\s*root\.setAttribute\(PREVIEW_POINT_SELECT_ATTR, "true"\)/, "点选模式必须在 iframe 根节点就绪后才访问它");
assert.match(preview, /cleanupDirectEditArtifacts\(doc\)/, "退出直接编辑时必须清理临时选中态和编辑器样式");
assert.doesNotMatch(preview, /doc\.body\.contentEditable\s*=\s*"true"/, "单元素编辑不得把整页 body 改成 contenteditable");
assert.doesNotMatch(preview, /querySelectorAll\("\[contenteditable\]"\).*removeAttribute/, "不得清除业务页面自己的 contenteditable");
assert.match(directEditor, /stripDirectEditArtifacts/, "保存前必须剥离单元素编辑器临时标记");
assert.match(guard, /escapedStyleId/, "保存、编辑、导出前必须支持剥离文字选择样式");

// 企微外壳返回按钮依赖 iframe 内统一回退栈：原型常见跳页方式都必须可追踪、可回退
assert.match(guard, /attributeFilter: \['style', 'class'\]/, "回退栈必须同时追踪 style 与 class 属性变化");
assert.match(guard, /childList: true/, "回退栈必须追踪 DOM 挂载/卸载（React useState 切页、antd-mobile 弹层）");
assert.match(guard, /type: 'dom', reverts: reverts/, "同批 DOM 变化必须合并为一条回退记录整批还原");
assert.match(guard, /kind: 'add'/, "整页挂载必须产生可回退记录");
assert.match(guard, /kind: 'remove'/, "整页卸载必须产生可回退记录（重新插回）");
assert.match(guard, /kind: 'class'/, "class 显隐切换必须产生可回退记录");
assert.match(guard, /kind: 'style', el: el, old: oldDisp/, "内联 display 切换必须记录原始值以便还原");
assert.match(guard, /__ydReady/, "首屏挂载/水合期不得把首页挂载误记为跳页");
assert.match(guard, /__ydNotView/, "非视图元素必须有否定缓存，避免高频 class 变化反复强制重排");
assert.match(guard, /window\.__ydGoBack = function/, "必须向父页面暴露 __ydGoBack 回退入口");
assert.match(guard, /window\.__ydCanGoBack = function/, "必须向父页面暴露 __ydCanGoBack 轮询入口");
assert.match(guard, /window\.__ydGoHome = function/, "必须向父页面暴露 __ydGoHome 回首页入口");
assert.match(guard, /sx: __ydScrollX\(\), sy: __ydScrollY\(\)/, "入栈时必须记录滚动位置");
assert.match(guard, /__ydRestoreScroll\(action\.sx, action\.sy\)/, "回退时必须还原进入子页前的滚动位置");
assert.match(guard, /等它落定后再还原记录的滚动位置/, "hash 回退的滚动还原必须晚于浏览器自身的锚点滚动");
assert.match(preview, /handleWecomPreviewBack/, "企微外壳返回按钮必须走自定义回退栈而非 history.back");
assert.match(preview, /cw\.__ydGoBack\?\.\(\)/, "企微外壳返回按钮必须调用 iframe 内 __ydGoBack");
assert.match(preview, /cw\.__ydGoHome\?\.\(\)/, "外壳 home 条/菜单必须调用 iframe 内 __ydGoHome");
assert.match(preview, /disabled=\{!canPreviewGoBack\}/, "无可回退记录时企微外壳返回按钮必须禁用");
assert.match(preview, /wecom-shell-menu/, "企微外壳 ⋯ 必须提供真实操作菜单（回到首页/刷新预览）");
assert.match(preview, /handleWecomRefresh/, "⋯ 菜单必须提供刷新预览逃生口（原型状态失配时重置）");
assert.match(preview, /className="mobile-shell-home"/, "外壳 home 指示条必须可点回首页");
assert.match(preview, /\{shellTime\}/, "外壳状态栏必须显示真实本地时间");
assert.match(preview, /setNavigationRecovered\(false\), 3500/, "拦截跳转黄条必须自动消失");
assert.match(preview, /ResizeObserver/, "手机外壳必须用 ResizeObserver 跟踪预览区尺寸以适应窗口缩放");
assert.match(preview, /display: "contents"/, "缩放占位容器在非缩放态必须是 display:contents，避免 iframe 重挂载丢回退栈");
assert.match(preview, /transformOrigin: "top left"/, "缩放必须固定左上角原点，配合占位容器保持布局正确");
assert.match(preview, /preview-scale-badge/, "适应窗口缩放必须有可切换 100%/自动的徽标");

console.log("Preview navigation regression passed");
