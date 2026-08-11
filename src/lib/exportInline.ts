/**
 * 原生 HTML 导出辅助：移动端窄框 + 历史回退 bridge。
 *
 * 导出/分享的原型是自包含 HTML（srcDoc 渲染），不再有沙箱运行时外链需内联，
 * 故原 inlineSandboxRuntime（DPL 沙箱运行时内联）已随 DPL 移除一并删除。
 */

/**
 * 导出/分享时把整页装进一个手机宽度的 iframe，让分享链接以手机宽度展示。
 * 仅用于“预览切移动端但生成结果实为 PC / 抓取页”的场景。
 *
 * 为什么用 iframe 而不是 body{max-width}：抓取的真实移动端页面大量使用
 * vw / position:fixed / @media(min-width) 等视口相关 CSS，它们按浏览器真实视口
 * （桌面 1280px）计算，body{max-width:390px} 管不到——fixed/100vw 的底部 tab 栏仍会
 * 铺满桌面屏宽。iframe 内部是独立的 390px 视口，vw/fixed/media 全部按手机宽渲染，
 * 才能真正呈现移动端形态（实测：iframe 内 html font-size 从桌面 80px 回到 39px、
 * 100vw 的 tab 栏从 1280px 回到 390px）。
 *
 * 注意：对生成型 PC 内容，这是“PC 内容塞进 390px 框”的窄框效果，不是真移动端原型。
 * 真移动端（device==="mobile"）已有自己的 viewport + 390 容器，不应调用本函数。
 *
 * @param html 导出用的完整 HTML 文档
 * @param width 手机外壳宽度（390/393/412），取自 MOBILE_SHELLS
 */
export function applyMobileNarrowFrame(html: string, width: number): string {
  // srcdoc 是属性值，转义 & 和 " 即可；< > 无需转义。浏览器解析属性后再按 HTML 解析内容。
  const escaped = html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:0;background:#f0f2f5;min-height:100vh}body{display:flex;justify-content:center}.yd-phone-frame{width:${width}px;height:100vh;border:0;background:#fff;box-shadow:0 0 24px rgba(0,0,0,.08);display:block}@media(max-width:${width}px){.yd-phone-frame{width:100%;box-shadow:none}}</style></head><body><iframe class="yd-phone-frame" srcdoc="${escaped}" title="移动端预览"></iframe></body></html>`;
}

/**
 * 导出移动端窄框时，把浏览器后退接到 iframe 内 guard 的 __ydGoBack。
 *
 * srcdoc iframe 自己的 history.back() 不可靠（可能重载到初始 srcdoc、丢失 DOM
 * 状态），但同源 iframe 可以往 parent 压历史条目、外层 popstate 可靠触发。
 * bridge 监听 iframe guard 发来的 yd-nav-change 消息 → 外层 history.pushState；
 * 外层 popstate（浏览器后退/移动端手势/企微 webview 返回）→ iframe.__ydGoBack。
 *
 * suppress 窗口：__ydGoBack 回退后 guard 会再发一次 yd-nav-change，此时不应再
 * 压栈，否则形成"回退→notify→pushState→又得回退"的死循环。回退后短暂抑制接收。
 */
const HISTORY_BRIDGE_ID = "__yd_export_history_bridge";
const HISTORY_BRIDGE_SCRIPT = `<script id="${HISTORY_BRIDGE_ID}">(function(){
  var iframe=document.querySelector('.yd-phone-frame');
  if(!iframe)return;
  var suppressed=false;
  function target(){try{return iframe.contentWindow;}catch(e){return null;}}
  window.addEventListener('message',function(e){
    var d=e.data;
    if(!d||d.source!=='youdesign-preview'||d.type!=='yd-nav-change')return;
    if(d.canGoBack&&!suppressed){try{history.pushState({yd:1},'');}catch(err){}}
  });
  window.addEventListener('popstate',function(){
    var w=target();if(!w)return;
    suppressed=true;
    try{w.__ydGoBack&&w.__ydGoBack();}catch(e){}
    setTimeout(function(){suppressed=false;},350);
  });
  try{history.replaceState({yd:0},'');}catch(e){}
})();<\/script>`;

export function injectHistoryBridge(html: string): string {
  if (html.includes(`id="${HISTORY_BRIDGE_ID}"`)) return html;
  // 注入到最后一个 </body> 前。applyMobileNarrowFrame 的外层文档里，srcdoc 属性
  // 内嵌的原型自己也带 </body>，且排在前面；若匹配第一个会把 bridge 注进 srcdoc
  // （iframe 内），bridge 找不到 .yd-phone-frame 就直接 return、监听挂不上。
  // 外层 </body> 是最后一个。
  const bodyCloses = [...html.matchAll(/<\/body\s*>/gi)];
  if (bodyCloses.length) {
    const idx = bodyCloses[bodyCloses.length - 1].index!;
    return html.slice(0, idx) + `${HISTORY_BRIDGE_SCRIPT}\n` + html.slice(idx);
  }
  const htmlCloses = [...html.matchAll(/<\/html\s*>/gi)];
  if (htmlCloses.length) {
    const idx = htmlCloses[htmlCloses.length - 1].index!;
    return html.slice(0, idx) + `${HISTORY_BRIDGE_SCRIPT}\n` + html.slice(idx);
  }
  return `${html}${HISTORY_BRIDGE_SCRIPT}`;
}
