/**
 * 预览中的原型不是一个真实站点：任何 URL 导航都会让 iframe 自己加载宿主应用，
 * 造成「YouDesign 套进 YouDesign」的嵌套页面。这里仅给预览时的 srcDoc 加一层
 * 临时守卫；导出、保存和送模型的 HTML 都必须保持原始内容。
 */
const GUARD_ID = "__yd_preview_navigation_guard";
const TEXT_SELECTION_STYLE_ID = "__yd_preview_text_selection";
export const PREVIEW_POINT_SELECT_ATTR = "data-yd-preview-point-select";

// 业务 H5（尤其 Taro/小程序同构页面）常在 html/body/文本组件上设置
// user-select:none。预览期覆盖为可选择，保证桌面端拖选后能用 Cmd/Ctrl+C；
// 点选修改时由根节点临时属性切回 none，避免拖选与元素定位互相干扰。
const TEXT_SELECTION_STYLE = `<style id="${TEXT_SELECTION_STYLE_ID}">
html,body,body *{-webkit-user-select:text!important;user-select:text!important;}
html[${PREVIEW_POINT_SELECT_ATTR}],html[${PREVIEW_POINT_SELECT_ATTR}] body,html[${PREVIEW_POINT_SELECT_ATTR}] body *{-webkit-user-select:none!important;user-select:none!important;}
/* 单一滚动容器：根元素横纵向均可滚动（PC 看板等超宽内容需横向滚动），body 不再单独产生滚动容器 */
html{overflow:auto!important;}
body{overflow:visible!important;}
/* 只隐藏纵向滚动条（避免与外层预览区形成双纵向滚动条），保留横向滚动条供超宽内容查看；
   仅改滚动条外观，不动 overflow/尺寸，避免破坏页面自带的下拉刷新等定位逻辑。
   Firefox 的 scrollbar-width 不支持按轴隐藏，故不设；Firefox 下纵向滚动条会显示（可接受） */
*::-webkit-scrollbar:vertical{width:0!important;display:none!important;}
</style>`;

const GUARD_SCRIPT = `<script id="${GUARD_ID}">(function(){
  var TABLE_SCROLL_ATTR = 'data-yd-preview-table-scroll';
  var TABLE_STYLE_ID = '__yd_preview_table_guard_style';
  function allowHashOnly(href) {
    var value = (href || '').trim().toLowerCase();
    return !value || value.charAt(0) === '#' || value.indexOf('javascript:') === 0;
  }
  function stop(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  // 注册在 window 捕获阶段，早于原型后续注册的 document/元素 click handler。
  window.addEventListener('click', function(event) {
    var node = event.target;
    var link = node && node.closest ? node.closest('a[href]') : null;
    if (link && !allowHashOnly(link.getAttribute('href'))) {
      link.setAttribute('data-yd-navigation-blocked', 'true');
      stop(event);
    }
  }, true);
  // 原型应使用本地 JS 模拟提交结果；不允许 form 提交把 iframe 导航到宿主 URL。
  window.addEventListener('submit', function(event) { stop(event); }, true);
  if (window.HTMLFormElement) {
    window.HTMLFormElement.prototype.submit = function() {};
    window.HTMLFormElement.prototype.requestSubmit = function() {};
  }
  // 弹窗在 sandbox 中本就不可用；显式拦截使原型行为稳定、可预期。
  window.open = function() { return null; };

  // —— 自定义导航栈 ——
  // srcdoc iframe 的 history.back() 会遍历联合会话历史，在 sandbox 缺少
  // allow-top-navigation 时可能被浏览器静默阻止。这里在 iframe 内部维护
  // 统一回退栈，覆盖原型常见的全部"跳页"方式：hash 变化、pushState、内联
  // style.display 显隐、class 显隐切换（<section data-page> 方案），以及整页
  // 元素的挂载/卸载（React useState(page) 条件渲染、antd-mobile 弹层都是 DOM
  // 增删，不改 URL 也不改 style）。父页面通过 __ydGoBack() 驱动回退。
  var __ydBackStack = []; // 统一栈：{ type:'hash', hash } 或 { type:'dom', reverts:[...] }
  var __ydIgnoreHash = false;
  var __ydIgnoreMutation = false;
  var __ydPrevHash = window.location.hash || '';
  var __ydReady = false; // 首屏解析/挂载/水合完成前不入栈，避免把首页挂载误记成"跳页"

  function __ydNotify() {
    parent.postMessage({ source: 'youdesign-preview', type: 'yd-nav-change', canGoBack: __ydBackStack.length > 0 }, '*');
  }

  __ydNotify();

  // —— 1) hash 变化追踪 ——
  window.addEventListener('hashchange', function() {
    if (__ydIgnoreHash) { __ydIgnoreHash = false; return; }
    var newHash = window.location.hash || '';
    if (newHash === __ydPrevHash) return;
    // 压入"回退到上一个 hash"的动作
    __ydBackStack.push({ type: 'hash', hash: __ydPrevHash, sx: __ydScrollX(), sy: __ydScrollY() });
    __ydPrevHash = newHash;
    __ydNotify();
  });

  // 包裹 pushState（SPA 路由）
  var __origPushState = history.pushState;
  history.pushState = function(state, title, url) {
    var before = window.location.hash || '';
    var result = __origPushState.apply(this, arguments);
    var after = window.location.hash || '';
    if (after !== before) {
      __ydBackStack.push({ type: 'hash', hash: before, sx: __ydScrollX(), sy: __ydScrollY() });
      __ydPrevHash = after;
      __ydNotify();
    }
    return result;
  };

  function __ydScrollX() { return window.pageXOffset || document.documentElement.scrollLeft || 0; }
  function __ydScrollY() { return window.pageYOffset || document.documentElement.scrollTop || 0; }
  // 回退时还原进入子页前的滚动位置；内容重排后位置可能被冲掉，下一帧再校准一次
  function __ydRestoreScroll(sx, sy) {
    try {
      window.scrollTo(sx || 0, sy || 0);
      if (window.requestAnimationFrame) {
        window.requestAnimationFrame(function() { window.scrollTo(sx || 0, sy || 0); });
      }
    } catch (e) {}
  }

  // —— 2) DOM 变化追踪（class 显隐切换、内联 display 切换、整页挂载/卸载）——
  var __ydViewLike = new WeakSet(); // 曾被判定为"视图"的元素（含已 detach 的，用于移除时识别）
  var __ydNotView = new WeakSet();  // 已测量且不是视图的元素，避免 hover 等高频 class 变化反复强制重排
  var __ydShown = new WeakSet();    // 当前可见的视图元素；已可见元素的 class 抖动不重复入栈

  function __ydMarkView(el) {
    if (__ydViewLike.has(el)) return true;
    if (__ydNotView.has(el)) return false;
    // 只追踪"像视图"的元素：fixed/absolute 定位且占屏 >8%（弹层/抽屉/动作面板），
    // 或流内元素面积超过视口 40%（整页容器）。过滤回到顶部按钮、Toast 等小浮层。
    try {
      var r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return false; // 隐藏/未布局：不缓存否定结果，下次可见时再测
      var pos = (window.getComputedStyle(el).position || '').toLowerCase();
      var vw = window.innerWidth || document.documentElement.clientWidth;
      var vh = window.innerHeight || document.documentElement.clientHeight;
      var area = r.width * r.height;
      var view = (pos === 'fixed' || pos === 'absolute') ? area > vw * vh * 0.08 : area > vw * vh * 0.4;
      if (view) { __ydViewLike.add(el); return true; }
      __ydNotView.add(el);
    } catch (e) {}
    return false;
  }

  function __ydIsVisible(el) {
    try {
      if (!el.isConnected) return false;
      var cs = window.getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    } catch (e) { return false; }
  }

  function __ydParseDisplay(styleStr) {
    var m = (styleStr || '').match(/display\s*:\s*([^;]+)/i);
    return m ? m[1].trim() : '';
  }

  // 新增节点里找"最外层"的可见视图（同批已被祖先候选覆盖的跳过，避免一次挂载记多条）
  function __ydCollectAdded(node, shows, reverts, accepted) {
    if (!node || node.nodeType !== 1) return;
    var candidates = [node];
    try {
      var desc = node.querySelectorAll('*');
      for (var i = 0; i < desc.length && candidates.length < 30; i++) candidates.push(desc[i]);
    } catch (e) {}
    for (var j = 0; j < candidates.length; j++) {
      var el = candidates[j];
      var covered = false;
      for (var k = 0; k < accepted.length; k++) {
        if (accepted[k] !== el && accepted[k].contains(el)) { covered = true; break; }
      }
      if (covered || __ydShown.has(el)) continue;
      if (__ydMarkView(el) && __ydIsVisible(el)) {
        accepted.push(el);
        __ydShown.add(el);
        shows.push(el);
        reverts.push({ kind: 'add', el: el });
      }
    }
  }

  // MutationObserver 每次回调交付一个批次；一次跳页（如下页显示+上页隐藏、React
  // 卸载首页+挂载详情）通常落在同一批次。整批只压一条栈记录，回退时整批还原。
  if (window.MutationObserver) {
    var __ydObserver = new MutationObserver(function(mutations) {
      if (__ydIgnoreMutation || !__ydReady) return;
      var shows = [];
      var reverts = [];
      var accepted = [];
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === 'childList') {
          for (var a = 0; a < m.addedNodes.length; a++) {
            __ydCollectAdded(m.addedNodes[a], shows, reverts, accepted);
          }
          for (var r = 0; r < m.removedNodes.length; r++) {
            var rem = m.removedNodes[r];
            // 已脱离文档的元素无法测量几何，只能靠此前的视图标记识别
            if (rem && rem.nodeType === 1 && __ydViewLike.has(rem)) {
              __ydShown.delete(rem);
              reverts.push({ kind: 'remove', el: rem, parent: m.target, next: m.nextSibling });
            }
          }
          continue;
        }
        if (m.type !== 'attributes') continue;
        var el = m.target;
        if (!el || el === document.body || el === document.documentElement) continue;
        if (m.attributeName === 'style') {
          var newDisp = '';
          try { newDisp = el.style.display; } catch (e) { continue; }
          var oldDisp = __ydParseDisplay(m.oldValue);
          if ((oldDisp === 'none' || oldDisp === '') && newDisp !== 'none' && newDisp !== '') {
            if (!__ydShown.has(el) && __ydMarkView(el) && __ydIsVisible(el)) {
              __ydShown.add(el);
              shows.push(el);
              reverts.push({ kind: 'style', el: el, old: oldDisp });
            }
          } else if (newDisp === 'none' && oldDisp !== 'none') {
            // 同批有视图被藏起（跳页的另一侧），记下原始内联 display 以便整批还原
            if (__ydViewLike.has(el) && __ydShown.has(el)) {
              __ydShown.delete(el);
              reverts.push({ kind: 'style', el: el, old: oldDisp });
            }
          }
        } else if (m.attributeName === 'class') {
          if (!__ydMarkView(el)) continue;
          if (__ydIsVisible(el)) {
            if (!__ydShown.has(el)) {
              __ydShown.add(el);
              shows.push(el);
              reverts.push({ kind: 'class', el: el, old: m.oldValue });
            }
          } else if (__ydShown.has(el)) {
            __ydShown.delete(el);
            reverts.push({ kind: 'class', el: el, old: m.oldValue });
          }
        }
      }
      // 只有批次里真的"亮出"了新视图才算跳页；单纯关闭弹层/离开页面不入栈
      if (shows.length > 0) {
        __ydBackStack.push({ type: 'dom', reverts: reverts, sx: __ydScrollX(), sy: __ydScrollY() });
        __ydNotify();
      }
    });
    __ydObserver.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['style', 'class'],
      attributeOldValue: true,
    });
  }

  // 首屏豁免期结束：把当前已可见的视图标记为"已在场"，之后的增量变化才入栈。
  // 3s 兜底针对外链图片挂死导致 load 迟迟不触发的原型。
  function __ydSeed() {
    if (__ydReady) return;
    __ydReady = true;
    try {
      var all = document.querySelectorAll('body *');
      var limit = Math.min(all.length, 2000);
      for (var i = 0; i < limit; i++) {
        var el = all[i];
        if (__ydMarkView(el) && __ydIsVisible(el)) __ydShown.add(el);
      }
    } catch (e) {}
  }
  if (document.readyState === 'complete') window.setTimeout(__ydSeed, 300);
  else window.addEventListener('load', function() { window.setTimeout(__ydSeed, 300); }, { once: true });
  window.setTimeout(__ydSeed, 3000);

  function __ydRevertAdd(el) {
    // 回退"挂载"：隐藏而非移除，避免之后原型自身卸载它时 removeChild 抛错
    try { el.style.setProperty('display', 'none', 'important'); }
    catch (e) { try { el.style.display = 'none'; } catch (e2) {} }
  }
  function __ydRevertRemove(rec) {
    try {
      var parent = rec.parent;
      if (!parent) return;
      var next = rec.next;
      if (next && next.parentNode === parent) parent.insertBefore(rec.el, next);
      else parent.appendChild(rec.el);
    } catch (e) {}
  }
  function __ydRevertStyle(el, old) {
    try {
      if (old) el.style.display = old;
      else el.style.removeProperty('display');
    } catch (e) {}
  }
  function __ydRevertClass(el, old) {
    try {
      if (old === null || old === undefined) el.removeAttribute('class');
      else el.setAttribute('class', old);
    } catch (e) {}
  }

  // 应用一条 dom 记录的整批回退，并按回退后的实际可见性刷新 __ydShown
  function __ydApplyDomReverts(action) {
    var list = action.reverts || [];
    for (var i = list.length - 1; i >= 0; i--) {
      var rec = list[i];
      try {
        if (rec.kind === 'add') __ydRevertAdd(rec.el);
        else if (rec.kind === 'remove') __ydRevertRemove(rec);
        else if (rec.kind === 'style') __ydRevertStyle(rec.el, rec.old);
        else if (rec.kind === 'class') __ydRevertClass(rec.el, rec.old);
      } catch (e) {}
      try {
        if (rec.el && rec.el.nodeType === 1) {
          if (__ydIsVisible(rec.el)) __ydShown.add(rec.el);
          else __ydShown.delete(rec.el);
        }
      } catch (e) {}
    }
  }

  /** 父页面调用：回退到上一个导航记录 */
  window.__ydGoBack = function() {
    if (!__ydBackStack.length) return false;
    var action = __ydBackStack.pop();
    if (action.type === 'hash') {
      __ydIgnoreHash = true;
      setTimeout(function() { __ydIgnoreHash = false; }, 100);
      __ydPrevHash = action.hash;
      window.location.hash = action.hash || '';
      // 设 hash 会触发浏览器自身的锚点/回顶滚动，等它落定后再还原记录的滚动位置
      var hsx = action.sx, hsy = action.sy;
      setTimeout(function() { __ydRestoreScroll(hsx, hsy); }, 0);
    } else if (action.type === 'dom') {
      __ydIgnoreMutation = true;
      __ydApplyDomReverts(action);
      setTimeout(function() { __ydIgnoreMutation = false; }, 100);
      __ydRestoreScroll(action.sx, action.sy);
    }
    __ydNotify();
    return true;
  };

  /** 父页面调用（外壳 home 条/菜单）：清空回退栈直接回到原型首页 */
  window.__ydGoHome = function() {
    if (!__ydBackStack.length) return false;
    var targetHash = null;
    __ydIgnoreMutation = true;
    while (__ydBackStack.length) {
      var action = __ydBackStack.pop();
      if (action.type === 'hash') {
        targetHash = action.hash; // 最早的 hash 才是初始值，最后统一设一次
      } else if (action.type === 'dom') {
        __ydApplyDomReverts(action);
      }
    }
    if (targetHash !== null) {
      __ydIgnoreHash = true;
      setTimeout(function() { __ydIgnoreHash = false; }, 100);
      __ydPrevHash = targetHash;
      window.location.hash = targetHash || '';
      // 等 hash 导航自身的滚动落定后再回顶
      setTimeout(function() { __ydRestoreScroll(0, 0); }, 0);
    } else {
      __ydRestoreScroll(0, 0);
    }
    setTimeout(function() { __ydIgnoreMutation = false; }, 100);
    __ydNotify();
    return true;
  };

  /** 父页面轮询：当前是否可回退 */
  window.__ydCanGoBack = function() {
    return __ydBackStack.length > 0;
  };

  // 原型常有内容很长的「修改前 / 修改后」等对比表。外层卡片若带 overflow:hidden，
  // 表格右侧列会被直接裁掉。仅在表格确实超出可用宽度时包一层滚动容器，避免影响
  // 普通表格的布局；这是预览期补丁，保存/导出时会被宿主剥离。
  function suggestedTableWidth(table) {
    var row = table.querySelector('thead tr') || table.querySelector('tr');
    if (!row) return 0;
    var cells = row.children;
    var total = 0;
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      if (!/^(?:TH|TD)$/.test(cell.tagName)) continue;
      var text = (cell.textContent || '').replace(/\\s+/g, ' ').trim();
      var units = Array.from(text).length;
      var width = Math.max(96, Math.min(220, units * 14 + 36));
      if (/金额|成本|日期|时间|操作|状态/.test(text)) width = Math.max(width, 124);
      total += width * Math.max(1, Number(cell.getAttribute('colspan')) || 1);
    }
    return total;
  }
  function ensureTableGuardStyle() {
    if (document.getElementById(TABLE_STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = TABLE_STYLE_ID;
    style.textContent = '[' + TABLE_SCROLL_ATTR + '] > table{min-width:var(--yd-preview-table-min-width)!important;}';
    (document.head || document.documentElement).appendChild(style);
  }
  function tableRole(table) {
    if (table.querySelector('thead') && !table.querySelector('tbody')) return 'header';
    if (table.querySelector('tbody') && !table.querySelector('thead')) return 'body';
    return 'table';
  }
  function findSplitTableGroup(node) {
    var parent = node && node.parentElement;
    while (parent && parent !== document.body) {
      var className = typeof parent.className === 'string' ? parent.className : '';
      if (/better-table(?:-(?:scroll|content|wrapper))?/.test(className) && parent.querySelectorAll('table').length > 1) {
        return parent;
      }
      parent = parent.parentElement;
    }
    return null;
  }
  function syncSplitTableScrolls() {
    var wrappers = document.querySelectorAll('[' + TABLE_SCROLL_ATTR + '="wrapper"]');
    var groups = [];
    for (var i = 0; i < wrappers.length; i++) {
      var group = findSplitTableGroup(wrappers[i]);
      if (group && groups.indexOf(group) < 0) groups.push(group);
    }
    for (var g = 0; g < groups.length; g++) {
      (function(group) {
        if (group.hasAttribute('data-yd-preview-table-scroll-group')) return;
        var candidates = group.querySelectorAll('[' + TABLE_SCROLL_ATTR + '="wrapper"]');
        var targets = [];
        for (var n = 0; n < candidates.length; n++) {
          if (findSplitTableGroup(candidates[n]) === group) targets.push(candidates[n]);
        }
        if (targets.length < 2) return;
        group.setAttribute('data-yd-preview-table-scroll-group', 'true');
        var syncing = false;
        for (var t = 0; t < targets.length; t++) {
          targets[t].addEventListener('scroll', function(event) {
            if (syncing) return;
            syncing = true;
            var left = event.currentTarget.scrollLeft;
            for (var j = 0; j < targets.length; j++) {
              if (targets[j] !== event.currentTarget && Math.abs(targets[j].scrollLeft - left) > 1) targets[j].scrollLeft = left;
            }
            syncing = false;
          }, { passive: true });
        }
      })(groups[g]);
    }
  }
  function ensureTableScroll(table) {
    if (!table || table.closest('[' + TABLE_SCROLL_ATTR + ']')) return;
    var parent = table.parentElement;
    if (!parent || !parent.clientWidth) return;
    var width = Math.max(
      table.scrollWidth || 0,
      Math.ceil(table.getBoundingClientRect().width || 0),
      suggestedTableWidth(table)
    );
    if (width <= parent.clientWidth + 2) return;
    ensureTableGuardStyle();
    var wrapper = document.createElement('div');
    var role = tableRole(table);
    wrapper.setAttribute(TABLE_SCROLL_ATTR, 'wrapper');
    wrapper.setAttribute('data-yd-preview-table-role', role);
    wrapper.style.cssText = 'width:100%;max-width:100%;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch;';
    if (role === 'header') wrapper.style.overflowX = 'hidden';
    wrapper.style.setProperty('--yd-preview-table-min-width', Math.ceil(width) + 'px');
    parent.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  }
  function ensureWideTablesScrollable() {
    // 包滚动容器会改动 DOM（插 wrapper、移动 table），属于守卫自身手术，
    // 不能让导航栈追踪误判成"跳页"；同步手术后下一拍再解除忽略。
    __ydIgnoreMutation = true;
    try {
      var tables = document.querySelectorAll('table');
      for (var i = 0; i < tables.length; i++) ensureTableScroll(tables[i]);
      syncSplitTableScrolls();
    } catch (e) {}
    window.setTimeout(function() { __ydIgnoreMutation = false; }, 0);
  }
  function watchWideTables() {
    ensureWideTablesScrollable();
    if (window.MutationObserver && document.body) {
      new MutationObserver(ensureWideTablesScrollable).observe(document.body, { childList: true, subtree: true });
    }
    window.setTimeout(ensureWideTablesScrollable, 150);
    window.setTimeout(ensureWideTablesScrollable, 800);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchWideTables, { once: true });
  else watchWideTables();
})();<\/script>`;

/** 为 iframe srcDoc 注入临时导航守卫，不修改持久化的原型 HTML。 */
export function guardPreviewNavigation(html: string): string {
  if (!html || html.includes(`id="${GUARD_ID}"`) || html.includes(`id='${GUARD_ID}'`)) return html;
  const previewGuards = `${TEXT_SELECTION_STYLE}${GUARD_SCRIPT}`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (head) => `${head}${previewGuards}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (tag) => `${tag}<head>${previewGuards}</head>`);
  return `${previewGuards}${html}`;
}

/** 从 iframe 序列化结果中移除仅预览期使用的守卫，避免保存/标注污染原始 HTML。 */
export function stripPreviewNavigationGuard(html: string): string {
  const escapedId = GUARD_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedStyleId = TEXT_SELECTION_STYLE_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedPointSelectAttr = PREVIEW_POINT_SELECT_ATTR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html
    .replace(new RegExp(`<script\\b[^>]*\\bid=["']${escapedId}["'][^>]*>[\\s\\S]*?<\\/script\\s*>`, "gi"), "")
    .replace(new RegExp(`<style\\b[^>]*\\bid=["']${escapedStyleId}["'][^>]*>[\\s\\S]*?<\\/style\\s*>`, "gi"), "")
    .replace(new RegExp(`\\s${escapedPointSelectAttr}(?:=["'][^"']*["'])?`, "gi"), "");
}

/** iframe 仍停在 srcDoc 文档时 location 为 about:srcdoc（含 hash 也允许）。 */
export function isExpectedPreviewDocument(frame: HTMLIFrameElement | null): boolean {
  try {
    return frame?.contentWindow?.location.href.startsWith("about:srcdoc") ?? false;
  } catch {
    // 已跳到跨域页面时不可读 location，也必须恢复原预览。
    return false;
  }
}