import navigationCore from "../../desktop/prototype-navigation-core.cjs";

/**
 * 原型必须用页内状态模拟交互。真实 URL 导航在 srcDoc iframe 中会加载宿主应用，
 * 形成完整聊天页嵌套在预览区的错误布局。规则与 Electron Claude bridge 共用同一实现。
 */
export function unsafePrototypeNavigation(code: string): string[] {
  return navigationCore.unsafePrototypeNavigation(code);
}

export function prototypeNavigationRepairInstruction(issues: string[]): string {
  return `检测到会让预览 iframe 发生真实页面跳转的代码：${issues.join("、")}。这是错误，必须最小修改修复：删除/替换所有 window.location、location.href/assign/replace/reload、window.open、form action/formAction、meta refresh、base href，以及所有非 #/javascript: 的 href（包括 JSX 的 href={...}）。点击、提交、查看详情、切换等只允许用 preventDefault + DOM 状态/React useState 在当前页面内实现；不要使用任何 URL、路由或新窗口。保留原有页面结构、文案和业务交互，输出完整代码。`;
}
