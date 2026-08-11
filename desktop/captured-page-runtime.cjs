// 唯一允许在抓取页面中执行的自有运行时。来源页面脚本永远不应进入此文件。
// 该字符串同时由 Web 预览与桌面附件使用；桌面端会对它计算 CSP hash。
const CAPTURE_RUNTIME_ID = "__yd_capture_interaction_runtime";

const CAPTURE_RUNTIME_SOURCE = `(function(){
  var DRAWER = 'data-yd-capture-drawer';
  var CLOSE = 'data-yd-capture-drawer-close';
  var MASK = 'data-yd-capture-drawer-mask';
  var OPEN = 'data-yd-capture-drawer-open';
  var PARENT = 'data-yd-capture-drawer-parent';
  var TAB = 'data-yd-capture-tab';
  var TAB_PANEL = 'data-yd-capture-tab-panel';
  function markedAncestor(node, attribute) {
    var current = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (current && current !== document.documentElement) {
      if (current.hasAttribute && current.hasAttribute(attribute)) return current;
      current = current.parentElement;
    }
    return null;
  }
  function stateNodes(attribute, id) {
    var all = document.querySelectorAll('[' + attribute + ']');
    var nodes = [];
    for (var i = 0; i < all.length; i++) if (all[i].getAttribute(attribute) === id) nodes.push(all[i]);
    return nodes;
  }
  function syncScrollState() {
    var roots = document.querySelectorAll('[' + DRAWER + '][data-yd-capture-drawer-state="open"]');
    if (roots.length) document.documentElement.removeAttribute('data-yd-capture-drawer-all-closed');
    else document.documentElement.setAttribute('data-yd-capture-drawer-all-closed', 'true');
  }
  function descendantDrawerIds(id) {
    var result = [];
    var queue = [id];
    var roots = document.querySelectorAll('[' + DRAWER + ']');
    while (queue.length) {
      var parentId = queue.shift();
      for (var i = 0; i < roots.length; i++) {
        var childId = roots[i].getAttribute(DRAWER) || '';
        if (!childId || result.indexOf(childId) >= 0) continue;
        if (roots[i].getAttribute(PARENT) === parentId) {
          result.push(childId);
          queue.push(childId);
        }
      }
    }
    return result;
  }
  function setDrawerState(id, open) {
    var drawers = stateNodes(DRAWER, id);
    var masks = stateNodes(MASK, id);
    var openers = stateNodes(OPEN, id);
    for (var i = 0; i < drawers.length; i++) {
      drawers[i].setAttribute('data-yd-capture-drawer-state', open ? 'open' : 'closed');
      drawers[i].setAttribute('aria-hidden', open ? 'false' : 'true');
    }
    for (var j = 0; j < masks.length; j++) masks[j].setAttribute('data-yd-capture-drawer-mask-state', open ? 'open' : 'closed');
    for (var k = 0; k < openers.length; k++) openers[k].setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function closeDrawer(id) {
    if (!id) return;
    var descendants = descendantDrawerIds(id);
    for (var i = descendants.length - 1; i >= 0; i--) setDrawerState(descendants[i], false);
    setDrawerState(id, false);
    var openers = stateNodes(OPEN, id);
    for (var j = 0; j < openers.length; j++) {
      if (typeof openers[j].focus === 'function') {
        try { openers[j].focus({ preventScroll: true }); } catch (_) { openers[j].focus(); }
        break;
      }
    }
    syncScrollState();
  }
  function openDrawer(id) {
    if (!id || !stateNodes(DRAWER, id).length) return;
    setDrawerState(id, true);
    syncScrollState();
  }
  function topOpenDrawerId() {
    var roots = document.querySelectorAll('[' + DRAWER + '][data-yd-capture-drawer-state="open"]');
    if (!roots.length) return '';
    return roots[roots.length - 1].getAttribute(DRAWER) || '';
  }
  function stop(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function tabNodes(group) {
    var all = document.querySelectorAll('[' + TAB + ']');
    var nodes = [];
    for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-yd-capture-tab-group') === group) nodes.push(all[i]);
    return nodes;
  }
  function tabPanelNodes(group) {
    var all = document.querySelectorAll('[' + TAB_PANEL + ']');
    var nodes = [];
    for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-yd-capture-tab-group') === group) nodes.push(all[i]);
    return nodes;
  }
  function toggleClass(node, name, enabled) {
    if (!node || !node.classList || !name) return;
    if (enabled) node.classList.add(name);
    else node.classList.remove(name);
  }
  function syncTabAppearance(tab, selected) {
    if (tab.classList.contains('ant-tabs-tab')) toggleClass(tab, 'ant-tabs-tab-active', selected);
    if (tab.classList.contains('dpl-tabs-tab')) toggleClass(tab, 'dpl-tabs-tab-active', selected);
    if (tab.classList.contains('adm-tabs-tab')) toggleClass(tab, 'adm-tabs-tab-active', selected);
    if (tab.classList.contains('am-tabs-tab')) toggleClass(tab, 'am-tabs-tab-active', selected);
    if (tab.classList.contains('am-tabs-default-bar-tab')) toggleClass(tab, 'am-tabs-default-bar-tab-active', selected);
  }
  function syncPanelAppearance(panel, open) {
    if (panel.classList.contains('ant-tabs-tabpane')) {
      toggleClass(panel, 'ant-tabs-tabpane-active', open);
      toggleClass(panel, 'ant-tabs-tabpane-hidden', !open);
    }
    if (panel.classList.contains('dpl-tabs-tabpane')) {
      toggleClass(panel, 'dpl-tabs-tabpane-active', open);
      toggleClass(panel, 'dpl-tabs-tabpane-inactive', !open);
    }
    if (panel.classList.contains('am-tabs-pane-wrap')) toggleClass(panel, 'am-tabs-pane-wrap-active', open);
    if (panel.classList.contains('adm-tabs-content-item')) toggleClass(panel, 'adm-tabs-content-item-active', open);
  }
  function prefersReducedMotion() {
    try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
  }
  function splitCssList(value) {
    var text = String(value || '');
    var parts = [];
    var start = 0;
    var depth = 0;
    for (var i = 0; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth = Math.max(0, depth - 1);
      else if (text[i] === ',' && depth === 0) {
        parts.push(text.slice(start, i).trim());
        start = i + 1;
      }
    }
    parts.push(text.slice(start).trim());
    return parts.filter(function(part) { return part.length > 0; });
  }
  function cssTimeMs(value) {
    var text = String(value || '').trim();
    var number = parseFloat(text);
    if (!isFinite(number)) return 0;
    return /ms$/i.test(text) ? number : /s$/i.test(text) ? number * 1000 : 0;
  }
  function motionFromStyle(style, kind) {
    var durations = splitCssList(kind === 'transition' ? style.transitionDuration : style.animationDuration);
    var delays = splitCssList(kind === 'transition' ? style.transitionDelay : style.animationDelay);
    var easings = splitCssList(kind === 'transition' ? style.transitionTimingFunction : style.animationTimingFunction);
    var properties = kind === 'transition' ? splitCssList(style.transitionProperty) : [];
    var best = null;
    for (var i = 0; i < durations.length; i++) {
      var duration = cssTimeMs(durations[i]);
      if (duration <= 0) continue;
      var property = properties.length ? properties[i % properties.length] : '';
      if (kind === 'transition' && property === 'none') continue;
      var priority = property === 'transform' ? 3 : property === 'opacity' ? 2 : property === 'all' || !property ? 1 : 0;
      var candidate = {
        duration: duration,
        delay: delays.length ? cssTimeMs(delays[i % delays.length]) : 0,
        easing: easings.length ? easings[i % easings.length] : 'linear',
        priority: priority
      };
      if (!best || candidate.priority > best.priority || candidate.priority === best.priority && candidate.duration > best.duration) best = candidate;
    }
    return best;
  }
  function originalPanelMotion(panel) {
    var candidates = [];
    var current = panel;
    for (var depth = 0; current && depth < 4; depth++, current = current.parentElement) candidates.push(current);
    var transition = null;
    var animation = null;
    for (var i = 0; i < candidates.length; i++) {
      var style;
      try { style = window.getComputedStyle(candidates[i]); } catch (_) { continue; }
      var currentTransition = motionFromStyle(style, 'transition');
      var currentAnimation = motionFromStyle(style, 'animation');
      if (currentTransition && (!transition || currentTransition.priority > transition.priority || currentTransition.priority === transition.priority && currentTransition.duration > transition.duration)) transition = currentTransition;
      if (currentAnimation && (!animation || currentAnimation.duration > animation.duration)) animation = currentAnimation;
    }
    return transition || animation;
  }
  function transitionPanel(panel, direction, motion) {
    if (!panel || !motion || motion.duration <= 0 || prefersReducedMotion() || typeof panel.animate !== 'function') return;
    try {
      panel.animate([
        { opacity: 0, transform: 'translate3d(' + (direction * 12) + 'px,0,0)' },
        { opacity: 1, transform: 'translate3d(0,0,0)' }
      ], { duration: motion.duration, delay: motion.delay, easing: motion.easing });
    } catch (_) { /* Older WebViews may not expose Web Animations. */ }
  }
  function transformX(element) {
    var value = '';
    try { value = window.getComputedStyle(element).transform || ''; } catch (_) { return 0; }
    if (!value || value === 'none') return 0;
    var match3d = value.match(/^matrix3d\(([^)]+)\)$/);
    if (match3d) {
      var parts3d = match3d[1].split(',');
      return Number(parts3d[12]) || 0;
    }
    var match2d = value.match(/^matrix\(([^)]+)\)$/);
    if (match2d) {
      var parts2d = match2d[1].split(',');
      return Number(parts2d[4]) || 0;
    }
    return 0;
  }
  function ensureTabVisible(tab, smooth) {
    if (!tab || typeof tab.getBoundingClientRect !== 'function') return;
    var track = tab.closest && tab.closest('.am-tabs-default-bar-content');
    if (track && track.parentElement) {
      var trackRect = track.getBoundingClientRect();
      var viewportRect = track.parentElement.getBoundingClientRect();
      var tabRect = tab.getBoundingClientRect();
      var currentX = transformX(track);
      var logicalTrackLeft = trackRect.left - currentX;
      var logicalContentLeft = logicalTrackLeft;
      var logicalContentRight = logicalTrackLeft + Math.max(trackRect.width, track.scrollWidth || 0);
      var trackTabs = track.children || [];
      for (var childIndex = 0; childIndex < trackTabs.length; childIndex++) {
        if (typeof trackTabs[childIndex].getBoundingClientRect !== 'function') continue;
        var childRect = trackTabs[childIndex].getBoundingClientRect();
        if (childRect.width <= 0) continue;
        logicalContentLeft = Math.min(logicalContentLeft, childRect.left - currentX);
        logicalContentRight = Math.max(logicalContentRight, childRect.right - currentX);
      }
      var contentWidth = logicalContentRight - logicalContentLeft;
      if (contentWidth > viewportRect.width + 1 && viewportRect.width > 0 && tabRect.width > 0) {
        var logicalTabCenter = tabRect.left + tabRect.width / 2 - currentX;
        var nextX = viewportRect.left + viewportRect.width / 2 - logicalTabCenter;
        var minX = Math.min(0, viewportRect.right - logicalContentRight);
        // 旧版 Ant Mobile 的轨道原点就是视口左边界；不得允许正位移，
        // 否则从负百分比初始态复位首项时会把整条轨道推向右侧。
        var maxX = 0;
        nextX = Math.max(minX, Math.min(maxX, nextX));
        var trackMotion = null;
        try { trackMotion = motionFromStyle(window.getComputedStyle(track), 'transition'); } catch (_) { /* Keep an immediate move. */ }
        var originalInlineTransition = track.style.transition;
        if (smooth && !prefersReducedMotion() && trackMotion) {
          track.style.transition = 'transform ' + trackMotion.duration + 'ms ' + trackMotion.easing + ' ' + trackMotion.delay + 'ms';
        } else {
          track.style.transition = 'none';
        }
        track.style.transform = 'translate3d(' + Math.round(nextX) + 'px,0,0)';
        if (!smooth || prefersReducedMotion()) {
          void track.offsetWidth;
          track.style.transition = originalInlineTransition;
        }
        return;
      }
    }
    var parent = tab.parentElement;
    for (var depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) {
      if (parent.scrollWidth <= parent.clientWidth + 1) continue;
      var parentRect = parent.getBoundingClientRect();
      var childRect = tab.getBoundingClientRect();
      var left = parent.scrollLeft + childRect.left + childRect.width / 2 - parentRect.left - parentRect.width / 2;
      if (typeof parent.scrollTo === 'function') parent.scrollTo({ left: left, behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' });
      else parent.scrollLeft = left;
      return;
    }
    if (typeof tab.scrollIntoView === 'function') {
      try { tab.scrollIntoView({ block: 'nearest', inline: 'center', behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' }); } catch (_) { tab.scrollIntoView(); }
    }
  }
  function activateTab(group, id, focus) {
    if (!group || !id) return;
    var tabs = tabNodes(group);
    var panels = tabPanelNodes(group);
    var found = false;
    var previousIndex = -1;
    var selectedIndex = -1;
    var selectedTab = null;
    var openPanel = null;
    var panelMotion = null;
    for (var p = 0; p < tabs.length; p++) if (tabs[p].getAttribute('aria-selected') === 'true') previousIndex = p;
    for (var r = 0; r < panels.length; r++) {
      if (panels[r].getAttribute(TAB_PANEL) === id) {
        panelMotion = originalPanelMotion(panels[r]);
        break;
      }
    }
    for (var i = 0; i < tabs.length; i++) {
      var selected = tabs[i].getAttribute(TAB) === id;
      if (selected) {
        found = true;
        selectedIndex = i;
        selectedTab = tabs[i];
      }
      tabs[i].setAttribute('aria-selected', selected ? 'true' : 'false');
      tabs[i].setAttribute('tabindex', selected ? '0' : '-1');
      tabs[i].setAttribute('data-yd-capture-tab-state', selected ? 'open' : 'closed');
      syncTabAppearance(tabs[i], selected);
      if (selected && focus) {
        try { tabs[i].focus({ preventScroll: true }); } catch (_) { tabs[i].focus(); }
      }
    }
    if (!found) return;
    for (var j = 0; j < panels.length; j++) {
      var open = panels[j].getAttribute(TAB_PANEL) === id;
      panels[j].setAttribute('data-yd-capture-tab-panel-state', open ? 'open' : 'closed');
      panels[j].setAttribute('aria-hidden', open ? 'false' : 'true');
      syncPanelAppearance(panels[j], open);
      if (open) openPanel = panels[j];
    }
    ensureTabVisible(selectedTab, true);
    if (previousIndex !== selectedIndex) transitionPanel(openPanel, previousIndex >= 0 && selectedIndex < previousIndex ? -1 : 1, panelMotion);
  }
  document.addEventListener('click', function(event) {
    var close = markedAncestor(event.target, CLOSE);
    if (close) {
      stop(event);
      closeDrawer(close.getAttribute(CLOSE));
      return;
    }
    var mask = markedAncestor(event.target, MASK);
    if (mask) {
      stop(event);
      closeDrawer(mask.getAttribute(MASK));
      return;
    }
    var opener = markedAncestor(event.target, OPEN);
    if (opener) {
      stop(event);
      openDrawer(opener.getAttribute(OPEN));
      return;
    }
    var tab = markedAncestor(event.target, TAB);
    if (tab) {
      stop(event);
      activateTab(tab.getAttribute('data-yd-capture-tab-group'), tab.getAttribute(TAB), false);
    }
  }, true);
  document.addEventListener('keydown', function(event) {
    var close = markedAncestor(event.target, CLOSE);
    if (close && (event.key === 'Enter' || event.key === ' ')) {
      stop(event);
      closeDrawer(close.getAttribute(CLOSE));
      return;
    }
    var opener = markedAncestor(event.target, OPEN);
    if (opener && (event.key === 'Enter' || event.key === ' ')) {
      stop(event);
      openDrawer(opener.getAttribute(OPEN));
      return;
    }
    var tab = markedAncestor(event.target, TAB);
    if (tab && (event.key === 'Enter' || event.key === ' ')) {
      stop(event);
      activateTab(tab.getAttribute('data-yd-capture-tab-group'), tab.getAttribute(TAB), false);
      return;
    }
    if (tab && (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End')) {
      var tabs = tabNodes(tab.getAttribute('data-yd-capture-tab-group'));
      var index = tabs.indexOf(tab);
      if (index < 0 || !tabs.length) return;
      if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
      if (event.key === 'Home') index = 0;
      if (event.key === 'End') index = tabs.length - 1;
      stop(event);
      activateTab(tab.getAttribute('data-yd-capture-tab-group'), tabs[index].getAttribute(TAB), true);
      return;
    }
    if (event.key !== 'Escape') return;
    var id = topOpenDrawerId();
    if (!id) return;
    stop(event);
    closeDrawer(id);
  }, true);
  function init() {
    var roots = document.querySelectorAll('[' + DRAWER + ']');
    for (var i = 0; i < roots.length; i++) {
      if (!roots[i].getAttribute('data-yd-capture-drawer-state')) roots[i].setAttribute('data-yd-capture-drawer-state', 'open');
    }
    var closes = document.querySelectorAll('[' + CLOSE + ']');
    for (var j = 0; j < closes.length; j++) {
      if (!closes[j].getAttribute('aria-label')) closes[j].setAttribute('aria-label', '关闭抽屉');
      if (!closes[j].getAttribute('role') && closes[j].tagName !== 'BUTTON') closes[j].setAttribute('role', 'button');
      if (closes[j].tagName !== 'BUTTON' && !closes[j].hasAttribute('tabindex')) closes[j].setAttribute('tabindex', '0');
    }
    var openers = document.querySelectorAll('[' + OPEN + ']');
    for (var k = 0; k < openers.length; k++) {
      if (!openers[k].getAttribute('role') && openers[k].tagName !== 'BUTTON') openers[k].setAttribute('role', 'button');
      if (openers[k].tagName !== 'BUTTON' && !openers[k].hasAttribute('tabindex')) openers[k].setAttribute('tabindex', '0');
      var linked = stateNodes(DRAWER, openers[k].getAttribute(OPEN));
      var expanded = false;
      for (var m = 0; m < linked.length; m++) {
        if (linked[m].getAttribute('data-yd-capture-drawer-state') !== 'closed') expanded = true;
      }
      openers[k].setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }
    var tabs = document.querySelectorAll('[' + TAB + ']');
    for (var n = 0; n < tabs.length; n++) {
      if (!tabs[n].getAttribute('role')) tabs[n].setAttribute('role', 'tab');
      if (!tabs[n].hasAttribute('tabindex')) tabs[n].setAttribute('tabindex', tabs[n].getAttribute('aria-selected') === 'true' ? '0' : '-1');
      var selected = tabs[n].getAttribute('aria-selected') === 'true' || tabs[n].getAttribute('data-yd-capture-tab-state') === 'open';
      syncTabAppearance(tabs[n], selected);
      if (selected) {
        if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame((function(tab) { return function() { ensureTabVisible(tab, false); }; })(tabs[n]));
        else ensureTabVisible(tabs[n], false);
      }
    }
    var panels = document.querySelectorAll('[' + TAB_PANEL + ']');
    for (var q = 0; q < panels.length; q++) syncPanelAppearance(panels[q], panels[q].getAttribute('data-yd-capture-tab-panel-state') !== 'closed');
    syncScrollState();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();`;

function captureRuntimeScriptTag() {
  return `<script id="${CAPTURE_RUNTIME_ID}">${CAPTURE_RUNTIME_SOURCE}</script>`;
}

module.exports = {
  CAPTURE_RUNTIME_ID,
  CAPTURE_RUNTIME_SOURCE,
  captureRuntimeScriptTag,
};
