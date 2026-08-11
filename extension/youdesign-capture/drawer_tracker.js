(() => {
  const STATE_KEY = "__ydDrawerInteractionTrackerV1";
  if (globalThis[STATE_KEY]) return;

  const TRACK_DRAWER = "data-yd-drawer-track-id";
  const TRACK_OPENER = "data-yd-drawer-track-opener";
  const TRACK_SOURCE = "data-yd-drawer-track-source";
  const TRACK_PARENT = "data-yd-drawer-track-parent";
  const EXTENSION_UI = "[data-yd-capture-extension-ui]";
  const DRAWER_SELECTOR = '[role="dialog"],[aria-modal="true"],[class*="drawer" i],[class*="modal" i],[class*="side-panel" i],[class*="offcanvas" i],[class*="sheet" i]';
  const EXCLUDED_OVERLAY = /(?:tooltip|popover|dropdown|select-dropdown|picker-dropdown|message|notification|toast|menu)/i;
  const MAX_RELATIONS = 20;
  const OBSERVE_MS = 3000;
  const RERENDER_GRACE_MS = 1500;
  const relations = [];
  const observations = [];
  let sequence = 0;
  let ambiguousCount = 0;
  let cleanupTimer = 0;
  let recentPointer = null;
  let scanFrame = 0;

  function classText(element) {
    return typeof element?.className === "string" ? element.className.toLowerCase() : "";
  }

  function normalizedText(element, limit = 160) {
    return String(element?.textContent || "").trim().replace(/\s+/g, " ").slice(0, limit);
  }

  function stableClassTokens(element) {
    return classText(element).split(/\s+/).filter((token) => token && !/(?:^|[-_])(?:active|open|opened|visible|hidden|enter|leave|animating|loading)(?:$|[-_])/.test(token)).slice(0, 10);
  }

  function drawerNameSignal(element) {
    const tokens = classText(element).split(/\s+/).filter(Boolean);
    if (tokens.some((token) => /(?:^|[-_])(?:drawer|offcanvas)$/.test(token) || /(?:^|[-_])side[-_]panel$/.test(token))) return "strong";
    if (tokens.some((token) => /(?:^|[-_])(?:bottom|action|side)[-_]sheet$/.test(token) || token === "sheet")) return "sheet";
    if (tokens.some((token) => /(?:^|[-_])modal(?:$|[-_](?:wrap|container|dialog))$/.test(token))) return "modal";
    return "";
  }

  function isVisible(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    try {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
    } catch {
      return false;
    }
  }

  function isDrawerCandidate(element) {
    if (!isVisible(element) || element.closest(EXTENSION_UI)) return false;
    const klass = classText(element);
    if (EXCLUDED_OVERLAY.test(klass)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 160 || rect.height < 100) return false;
    const style = getComputedStyle(element);
    const semantic = element.getAttribute("role") === "dialog" || element.getAttribute("aria-modal") === "true";
    const named = drawerNameSignal(element);
    const positioned = /^(?:fixed|absolute)$/i.test(style.position || "");
    const edgeTolerance = 32;
    const edgeAttached = rect.left <= edgeTolerance || rect.right >= innerWidth - edgeTolerance || rect.top <= edgeTolerance || rect.bottom >= innerHeight - edgeTolerance;
    return Boolean((named || semantic) && positioned && (edgeAttached || named === "modal"));
  }

  function sameShell(outer, inner) {
    const outerRect = outer.getBoundingClientRect();
    const innerRect = inner.getBoundingClientRect();
    const nearlySame = Math.abs(outerRect.left - innerRect.left) < 4 && Math.abs(outerRect.top - innerRect.top) < 4 &&
      Math.abs(outerRect.width - innerRect.width) < 4 && Math.abs(outerRect.height - innerRect.height) < 4;
    const wrapperClass = /(?:content-wrapper|drawer-content|drawer-body|panel-content)/i.test(classText(inner));
    return nearlySame || wrapperClass;
  }

  function visibleDrawerRoots() {
    const candidates = Array.from(document.querySelectorAll(DRAWER_SELECTOR)).filter(isDrawerCandidate);
    return candidates.filter((candidate) => !candidates.some((ancestor) =>
      ancestor !== candidate && ancestor.contains(candidate) && sameShell(ancestor, candidate)
    ));
  }

  function reasonableTriggerBox(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    if (rect.width > innerWidth * 0.82 || rect.height > innerHeight * 0.7) return false;
    return true;
  }

  function elementFingerprint(element, kind) {
    const rect = element.getBoundingClientRect();
    const title = kind === "drawer"
      ? normalizedText(element.querySelector?.('h1,h2,h3,[class*="title" i],[class*="header" i]') || element, 120)
      : normalizedText(element, 120);
    return {
      kind,
      tag: element.tagName,
      id: element.id || "",
      testId: element.getAttribute("data-testid") || element.getAttribute("data-test-id") || "",
      role: element.getAttribute("role") || "",
      ariaLabel: element.getAttribute("aria-label") || "",
      classes: stableClassTokens(element),
      title,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  }

  function fingerprintScore(fingerprint, element) {
    if (!fingerprint || element.tagName !== fingerprint.tag) return -1;
    let score = 8;
    if (fingerprint.id && element.id === fingerprint.id) score += 120;
    const testId = element.getAttribute("data-testid") || element.getAttribute("data-test-id") || "";
    if (fingerprint.testId && testId === fingerprint.testId) score += 100;
    if (fingerprint.role && element.getAttribute("role") === fingerprint.role) score += 20;
    if (fingerprint.ariaLabel && element.getAttribute("aria-label") === fingerprint.ariaLabel) score += 45;
    const currentClasses = new Set(stableClassTokens(element));
    score += fingerprint.classes.filter((token) => currentClasses.has(token)).length * 8;
    const currentTitle = fingerprint.kind === "drawer"
      ? normalizedText(element.querySelector?.('h1,h2,h3,[class*="title" i],[class*="header" i]') || element, 120)
      : normalizedText(element, 120);
    if (fingerprint.title && currentTitle === fingerprint.title) score += 40;
    const rect = element.getBoundingClientRect();
    const sizeDelta = Math.abs(rect.width - fingerprint.rect.width) + Math.abs(rect.height - fingerprint.rect.height);
    const positionDelta = Math.abs(rect.x - fingerprint.rect.x) + Math.abs(rect.y - fingerprint.rect.y);
    if (sizeDelta < 12) score += 18;
    if (positionDelta < 24) score += 12;
    return score;
  }

  function resolveFingerprint(fingerprint, candidates) {
    const ranked = candidates.map((element) => ({ element, score: fingerprintScore(fingerprint, element) }))
      .filter((item) => item.score >= 60)
      .sort((a, b) => b.score - a.score);
    if (!ranked.length) return null;
    if (ranked[1] && ranked[0].score - ranked[1].score < 15) return null;
    return ranked[0].element;
  }

  function resolveOpener(relation) {
    if (relation.opener?.isConnected && isVisible(relation.opener) && reasonableTriggerBox(relation.opener)) return relation.opener;
    const fingerprint = relation.openerFingerprint;
    if (!fingerprint) return null;
    if (fingerprint.id) {
      const byId = document.getElementById(fingerprint.id);
      if (byId && fingerprintScore(fingerprint, byId) >= 60) return byId;
    }
    return resolveFingerprint(fingerprint, Array.from(document.querySelectorAll(fingerprint.tag || "*")).filter((element) => isVisible(element) && reasonableTriggerBox(element)));
  }

  function drawerDigest(drawer) {
    const heading = normalizedText(drawer.querySelector?.('h1,h2,h3,[class*="title" i],[class*="header" i]') || drawer, 120);
    const text = normalizedText(drawer, 360);
    return `${heading}\u0001${text}`;
  }

  function triggerFromEvent(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const ranked = [];
    for (let index = 0; index < path.length; index += 1) {
      const element = path[index];
      if (!(element instanceof Element) || element === document.body || element === document.documentElement) continue;
      if (element.closest(EXTENSION_UI) || !reasonableTriggerBox(element)) continue;
      let score = 100 - index;
      if (element.matches('button,a,[role="button"],[aria-controls],[data-target],[data-bs-target]')) score += 80;
      try {
        const cursor = getComputedStyle(element).cursor;
        const parentCursor = element.parentElement ? getComputedStyle(element.parentElement).cursor : "";
        if (cursor === "pointer") score += parentCursor === "pointer" ? 15 : 55;
      } catch {
        /* Ignore a detached node. */
      }
      if (element.id || element.hasAttribute("data-testid") || element.hasAttribute("data-test-id")) score += 10;
      const textLength = String(element.textContent || "").trim().length;
      if (textLength > 240) score -= 50;
      ranked.push({ element, score, index });
    }
    ranked.sort((a, b) => b.score - a.score || a.index - b.index);
    const best = ranked[0];
    if (!best || best.score < 100) return null;
    return best.element;
  }

  function parentDrawerFor(opener, drawers) {
    const containers = drawers.filter((drawer) => drawer.contains(opener));
    if (!containers.length) return null;
    containers.sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return aRect.width * aRect.height - bRect.width * bRect.height;
    });
    return containers[0];
  }

  function recordRelation(drawer, opener, source, beforeDrawers) {
    if (!drawer?.isConnected || !opener?.isConnected || drawer.contains(opener)) return;
    const parentDrawer = parentDrawerFor(opener, beforeDrawers);
    for (let index = relations.length - 1; index >= 0; index -= 1) {
      if (relations[index].drawer === drawer) relations.splice(index, 1);
    }
    relations.push({
      drawer,
      opener,
      source,
      parentDrawer,
      drawerFingerprint: elementFingerprint(drawer, "drawer"),
      openerFingerprint: elementFingerprint(opener, "opener"),
      openedAt: Date.now(),
    });
    if (relations.length > MAX_RELATIONS) relations.splice(0, relations.length - MAX_RELATIONS);
  }

  function refreshRelations(current) {
    const now = Date.now();
    for (let index = relations.length - 1; index >= 0; index -= 1) {
      const relation = relations[index];
      if (current.includes(relation.drawer)) {
        relation.missingAt = 0;
        continue;
      }
      if (!relation.missingAt) relation.missingAt = now;
      if (now - relation.missingAt > RERENDER_GRACE_MS) {
        relations.splice(index, 1);
        continue;
      }
      const replacement = resolveFingerprint(relation.drawerFingerprint, current);
      if (replacement) {
        relation.drawer = replacement;
        relation.missingAt = 0;
      }
    }
  }

  function scanObservations() {
    const current = visibleDrawerRoots();
    refreshRelations(current);
    const now = Date.now();
    for (const observation of observations) {
      const opened = current.filter((drawer) => !observation.before.has(drawer));
      const changed = current.filter((drawer) => observation.before.has(drawer) && !drawer.contains(observation.opener) && observation.beforeDigests.get(drawer) !== drawerDigest(drawer));
      for (const drawer of new Set([...opened, ...changed])) observation.seen.add(drawer);
      if (observation.seen.size === 1 && !observation.firstSeenAt) observation.firstSeenAt = now;
      if (observation.seen.size > 1) observation.ambiguous = true;
    }

    const eligible = observations.filter((item) => !item.ambiguous && item.seen.size === 1 && item.firstSeenAt && now - item.startedAt >= 240 && now - item.firstSeenAt >= 80);
    const byDrawer = new Map();
    for (const observation of eligible) {
      const drawer = Array.from(observation.seen)[0];
      const group = byDrawer.get(drawer) || [];
      group.push(observation);
      byDrawer.set(drawer, group);
    }
    const completed = new Set();
    for (const [drawer, group] of byDrawer) {
      if (group.length === 1) {
        const observation = group[0];
        recordRelation(drawer, observation.opener, "observed-click", Array.from(observation.before));
        completed.add(observation);
      } else {
        ambiguousCount += 1;
        for (const observation of group) completed.add(observation);
      }
    }

    for (let index = observations.length - 1; index >= 0; index -= 1) {
      const observation = observations[index];
      if (completed.has(observation) || now - observation.startedAt >= OBSERVE_MS) {
        if (!completed.has(observation) && observation.ambiguous) ambiguousCount += 1;
        observations.splice(index, 1);
      }
    }
  }

  function beginObservation(event) {
    if (!event.isTrusted && !globalThis.__YD_ALLOW_SYNTHETIC_DRAWER_TESTS__) return;
    const opener = triggerFromEvent(event);
    if (!opener) return;
    if (event.type === "click" && recentPointer && recentPointer.opener === opener && Date.now() - recentPointer.startedAt < 1200) return;
    const token = ++sequence;
    const before = new Set(visibleDrawerRoots());
    const observation = {
      token,
      opener,
      before,
      beforeDigests: new Map(Array.from(before, (drawer) => [drawer, drawerDigest(drawer)])),
      seen: new Set(),
      firstSeenAt: 0,
      startedAt: Date.now(),
      ambiguous: false,
    };
    observations.push(observation);
    if (observations.length > 6) observations.splice(0, observations.length - 6);
    if (event.type === "pointerdown") recentPointer = { opener, startedAt: observation.startedAt };
    requestAnimationFrame(scanObservations);
    for (const delay of [80, 250, 800, 1600, OBSERVE_MS]) {
      setTimeout(scanObservations, delay);
    }
  }

  function clearTransientMarks() {
    if (cleanupTimer) {
      clearTimeout(cleanupTimer);
      cleanupTimer = 0;
    }
    for (const element of document.querySelectorAll(`[${TRACK_DRAWER}],[${TRACK_OPENER}]`)) {
      element.removeAttribute(TRACK_DRAWER);
      element.removeAttribute(TRACK_OPENER);
      element.removeAttribute(TRACK_SOURCE);
      element.removeAttribute(TRACK_PARENT);
    }
  }

  function explicitOpener(drawer) {
    const id = drawer.id;
    if (!id) return null;
    const matches = [];
    for (const element of document.querySelectorAll('[aria-controls],[data-target],[data-bs-target],a[href]')) {
      if (!isVisible(element) || drawer.contains(element) || element.closest(EXTENSION_UI)) continue;
      const controls = element.getAttribute("aria-controls");
      const target = element.getAttribute("data-target") || element.getAttribute("data-bs-target");
      const href = element.getAttribute("href");
      if (controls === id || target === `#${id}` || href === `#${id}`) matches.push(element);
    }
    return matches.length === 1 ? matches[0] : null;
  }

  function prepareMappings() {
    clearTransientMarks();
    scanObservations();
    const drawers = visibleDrawerRoots();
    const prepared = [];
    const relationByDrawer = new Map();
    for (const drawer of drawers) {
      const observed = [...relations].reverse().find((relation) => relation.drawer === drawer);
      const resolvedOpener = observed ? resolveOpener(observed) : null;
      if (observed && resolvedOpener) observed.opener = resolvedOpener;
      const opener = resolvedOpener && !drawer.contains(resolvedOpener) ? resolvedOpener : explicitOpener(drawer);
      if (!opener) continue;
      const source = resolvedOpener ? observed?.source || "observed-click" : "semantic";
      const relation = { drawer, opener, source, parentDrawer: resolvedOpener ? observed?.parentDrawer || null : null, id: `yd-drawer-track-${prepared.length + 1}` };
      prepared.push(relation);
      relationByDrawer.set(drawer, relation);
    }
    for (const relation of prepared) {
      relation.drawer.setAttribute(TRACK_DRAWER, relation.id);
      relation.drawer.setAttribute(TRACK_SOURCE, relation.source);
      relation.opener.setAttribute(TRACK_OPENER, relation.id);
      const parent = relation.parentDrawer ? relationByDrawer.get(relation.parentDrawer) : null;
      if (parent) relation.drawer.setAttribute(TRACK_PARENT, parent.id);
    }
    cleanupTimer = setTimeout(clearTransientMarks, 15000);
    return {
      detected: drawers.length,
      mapped: prepared.length,
      unmapped: Math.max(0, drawers.length - prepared.length),
      observed: prepared.filter((item) => item.source === "observed-click").length,
      semantic: prepared.filter((item) => item.source === "semantic").length,
      ambiguous: ambiguousCount,
    };
  }

  function scheduleScan() {
    if (scanFrame) return;
    scanFrame = requestAnimationFrame(() => {
      scanFrame = 0;
      scanObservations();
    });
  }

  const observer = new MutationObserver(() => {
    if (observations.length || relations.length) scheduleScan();
  });
  observer.observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden", "aria-modal"] });
  document.addEventListener("pointerdown", beginObservation, true);
  document.addEventListener("click", beginObservation, true);

  const api = { prepareMappings, clearTransientMarks, visibleDrawerRoots };
  Object.defineProperty(globalThis, STATE_KEY, { value: api, configurable: false, enumerable: false });

  if (globalThis.chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.source !== "youdesign-capture-service-worker") return;
      if (message.action === "drawer-tracker-ping") sendResponse({ ok: true });
      else if (message.action === "prepare-drawer-mappings") sendResponse({ ok: true, diagnostics: prepareMappings() });
      else if (message.action === "cleanup-drawer-mappings") {
        clearTransientMarks();
        sendResponse({ ok: true });
      }
    });
  }
})();
