# YouDesign Capture

Chrome MV3 extension (v0.2.9) for importing a logged-in page into YouDesign, with rich capture of drawers / modals / tabs / iframes and guided multi-tab collection.

## Use

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked" and choose this directory.
4. Log in to the target business page in Chrome.
5. Click the YouDesign Capture extension action to open the popup.

The popup offers two entries:

- **抓取当前页 (Capture current page)** — captures the current rendered DOM plus interaction metadata (open drawers and modal dialogs with their close button / mask / opener, standard / Ant Design / DPL tabs already in the DOM, and child iframes). On completion, the popup shows the extension version and the captured iframe count.
- **多页签采集 (Guided multi-tab collection)** — injects a draggable "页签采集" overlay. The extension identifies standard / Ant Design / DPL tab groups (2–16 tabs), baselines on the current DOM, auto-collects the already-open tab, then you open each lazy-loaded tab in the source page and click "采集当前" to snapshot its panel (including drawers portal-mounted inside it). "合并发送" merges every collected tab into one offline page.

The captured payload is then delivered to YouDesign:

- If the YouDesign desktop app is running, the HTML + `captureMeta` is POSTed to its local capture server (`http://127.0.0.1:17631/capture/import`, with the `x-youdesign-capture` header); `youdesign://capture` only launches/focuses the app and never carries data. The desktop server clamps the metadata (groups ≤8, tabs ≤16, snapshots ≤32, panelHtml ≤768KB, frames ≤12) and defensively permits an individual frame up to the 6MB import cap. The extension itself keeps the whole payload within its 5MB capture budget, with no separate 1MB frame cap.
- Otherwise it falls back to `window.postMessage` (`YD_CAPTURE_IMPORT` / `ACK`) addressed to the YouDesign web tab.

YouDesign opens a **new session** with the captured HTML attached, shows a transient "页面已添加到对话框，请开始修改" notice, and does **not** auto-generate — add your requirement and click 发送 to run the raw HTML pipeline (open / edit / regenerate / ask is then decided by the upload intent classifier). The captured page is rebuilt into an **offline interactive** preview: drawers open/close (with parent-child cascade, Esc, and click-mask-to-close), tabs switch by click and keyboard (← →/Home/End), and child iframes are staticized or placeholdered. Interactions are driven only by YouDesign's own controlled runtime; source-page scripts are always disabled. After replacing extension files, click "Reload" for this extension on `chrome://extensions`.

## Notes

- YouDesign must already be logged in. If Chrome opens the YouDesign login page, log in and click the extension again.
- The rich capture inlines stylesheet rules the page allows Chrome to read (including `@media` / `@supports` / `@layer` / `@container` and adopted style sheets), fetches permitted remote CSS (≤4MB total, ≤1.2MB each) and small remote images (≤900KB total, ≤256KB each, ≤32) as data URLs, carries open shadow roots via declarative shadow DOM, and snapshots canvas charts. A canvas tainted by a cross-origin image cannot be read with `toDataURL`; when it is visible at capture time, the extension takes one tab screenshot, crops the canvas by its viewport coordinates, and replaces it with a PNG. Off-screen, out-of-bounds, oversized, or unsupported cases become an explicit placeholder instead of failing the capture. Before serialization it strips browser-extension noise (Plasmo containers, Google Translate `goog-gt-*` / `translated-*`, ad-blocker overlays, `chrome|moz|safari-web-extension://` resources) and removes any `<base>` tags. If a Windows Chrome build does not return the rich capture result, the extension retries with a smaller, script-free DOM serializer (marked `captureMode: "basic-fallback"`).
- `drawer_tracker.js` is injected at `document_start` on every `http(s)://` page via `content_scripts` (`<all_urls>` host permission). It observes pointerdown / click + DOM mutations to map each drawer to its opener (by observed click timing, or semantically via `aria-controls` / `data-target` / `href=#id`), resolves parent drawers, and re-resolves drawers across re-renders by fingerprint. Observed-click mapping is available for drawers opened at any time on any page.
- Only `http(s)://` business pages can be captured; Chrome internal/extension pages are rejected. Captured HTML is limited to 5MB; the desktop capture server accepts up to 6MB. Guided multi-tab collection is bounded by 3MB of tab snapshots + 2MB of deferred styles. Child iframes are captured to depth 3 and at most 12 frames, sharing the 5MB capture budget. Matching uses the iframe's declared source URL, `window.name`, and only a unique parent-child fallback—never frame order—so ambiguous frames are safely placeholdered.
- Guided collection only recognizes standard `role="tablist"` / Ant Design / DPL tab groups with 2–16 tabs. The default open tab must finish loading before you start, or the extension will ask you to wait for the page to stabilize.
