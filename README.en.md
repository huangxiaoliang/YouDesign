# YouDesign · High-Fidelity Prototype Design Agent

English | [中文](./README.md)

[![CI](https://github.com/huangxiaoliang/YouDesign/actions/workflows/ci.yml/badge.svg)](https://github.com/huangxiaoliang/YouDesign/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**High-fidelity prototype design agent:**
- Describe a page in natural language (optionally attach screenshots / HTML + asset bundles / Markdown) and generate an interactive, high-fidelity prototype in minutes.
- **Chrome extension** captures a given page for re-design.
- **Mac/Windows desktop** supports re-design of very large HTML.
- Supports **click-to-select** a region on the page for deep local edits (natural language or direct editing).
- Supports a requirement-card mode with built-in design styles such as Ant Design.
- **Web URL**: https://youdesign-gamma.vercel.app/youdesign
- **Demo account**: email coolway.me@gmail.com

---

## Quick Start

```bash
npm install
npm run build && npm run start    # http://localhost:3000/youdesign
```

On first open you land on the **login page** and sign in with a passcode — in multi-user mode each person has their own passcode (admin creates accounts via `scripts/user.mjs`); when no user table is configured it falls back to the shared `YOUDESIGN_ACCESS_PASSWORD` from `.env.local`. After login, the left panel takes your text description while the right panel streams the generation process and preview in real time.

> With no keys at all (`YOUDESIGN_FORCE_MOCK=true`) it runs in mock mode — a fully offline loop useful for demos/development.
> `npm run dev` is for development; functional acceptance still uses `build && start` (`dev` occasionally throws a full-page 500).
> `npm run tunnel` opens a temporary trycloudflare tunnel to share your local service (requires `cloudflared` installed first).

> The `dev`/`start` scripts bake in `env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY`: this prevents the `ANTHROPIC_*` vars that tools like Claude Code inject into child processes from clashing with this tool's own keys. Running `next dev`/`next start` directly will trip this — always go through `npm run dev`/`npm run start`.

---

## Configuration (`.env.local`, create from the `.env.example` placeholder template in the repo root)

| Category | Key variables |
|---|---|
| Run mode | `YOUDESIGN_FORCE_MOCK` (true = mock the whole pipeline; runs offline with no keys) |
| Auth gate | `YOUDESIGN_AUTH_SECRET` (cookie signing key, `openssl rand -hex 24`); `YOUDESIGN_AUTH_MODE=auto/shared/users`; multi-user table `data/users.json` (managed by `scripts/user.mjs`, passcodes stored only as sha256 digests); falls back to shared `YOUDESIGN_ACCESS_PASSWORD` when no user table or forced shared mode |
| Data dir | `YOUDESIGN_DATA_DIR` (persistence directory, default `data/`; in production point it outside the repo so `git pull` won't overwrite it) |
| Usage storage | Optional MySQL: `YOUDESIGN_MYSQL_HOST`/`YOUDESIGN_MYSQL_PORT`(3306)/`YOUDESIGN_MYSQL_DATABASE`(youdesign)/`YOUDESIGN_MYSQL_USER`/`YOUDESIGN_MYSQL_PASSWORD`; falls back to local JSONL (`<data dir>/usage.jsonl`) when MySQL is not configured |
| Model keys | `DEEPSEEK_API_KEY` (primary); `GLM_API_KEY` (Zhipu GLM-5.2, OpenAI-compatible); `ZHIPU_API_KEY` (Zhipu embedding, semantic recall); `ANTHROPIC_API_KEY`+`ANTHROPIC_MODEL_OPUS`/`ANTHROPIC_MODEL_SONNET` (Claude); `KIMI_API_KEY`+`KIMI_BASE_URL` (Kimi K3, Volcengine Ark Agent Plan); `GLM5V_API_KEY` (vision model GLM-5V, defaults to reusing `GLM_API_KEY`/`ZHIPU_API_KEY`) |
| Generation behavior | Frontend "Fast" toggle (default on, applies to first generation only); `SELF_REVIEW` (high-quality self-review, default on, currently temporarily skipped entirely — see AGENTS §6); `ROUTE_*` (model routing, see below) |
| Proxy | `HTTPS_PROXY`/`HTTP_PROXY` (set when public APIs go through a proxy); `NO_PROXY` (domains/CIDRs that must be hit directly; suffix matching is resolved manually) |

> Under "default model", a missing single-model config falls back to mock so you can adopt incrementally; when a user manually selects `DeepSeek`/`GLM-5.2`, a missing key surfaces a config error immediately. Keys live in `.env.local` (gitignored) and never reach the frontend.

### Model Routing (DeepSeek primary; text optionally GLM-5.2 / Kimi K3 / Sonnet / Opus; vision defaults to GLM-5V)

| Variable | Stage | Default |
|---|---|---|
| `ROUTE_CLARIFY` | ⓪ Preflight (clarify + device detection) | `deepseek` (flash) |
| `ROUTE_STRUCTURE` | ① Requirement structuring (simple needs) | `deepseek` (flash) |
| `ROUTE_STRUCTURE_COMPLEX` | ① Auto-upgrade for complex needs | `deepseekPro` |
| `ROUTE_GENERATE` | ③ Full-page code generation (quality-first) | `deepseekPro` |
| `ROUTE_EDIT_SMALL/LARGE` | ⑤ Iterative edits | `deepseek` (flash) |

- `deepseek` = `deepseek-v4-flash` + `thinking: disabled` (fast); `deepseekPro` = `deepseek-v4-pro` + `thinking: enabled` (reasoning, higher quality, ~90s to first byte).
- Frontend "Fast" toggle defaults on: structuring and generation both force flash and skip the generic self-review, prioritizing a prototype in seconds. Turning it off enters high-quality mode: generate is tiered by scenario — simple native pages go flash-first for the first cut; complex / image-bearing / doc-bearing / style-profile / restoration cases go pro/GLM and run self-review (currently temporarily skipped entirely — see AGENTS §6).
- Any step with an uploaded image and a non-vision model → that step switches to the vision model; when not explicitly chosen, GLM-5V is the default.

---

## Core Capabilities

**Native HTML generation**: produces **self-contained HTML** (inline CSS/JS, native JS for multi-page switching), rendered via `srcDoc` — openable offline, directly editable. Single-page by default (secondary views like detail/new/edit are not generated separately; a few standalone pages go multi-page, max 3).

**Device adaptation**: the model decides **PC / mobile** from the requirement (it asks back when unsure, falling back to PC). This decision drives **layout** (mobile gets a 390px phone-frame preview) — the user never picks manually; for mobile, just write "phone/H5/App" in the requirement.

**Session persistence & history**: the current session (chat + prototype + version stack + settings) is auto-saved to browser IndexedDB; refresh returns you to the exact state. The top-bar "History" lets you view/switch/create/delete past sessions (stored per-browser, independent of login identity). **After login a new session starts by default** (the previous one is not restored), while refresh restores normally — this prevents seeing a previous person's draft when switching users/shifts.

**Upload as reference / open as-is**: up to **4 attachments**, **5MB** per file (image / HTML / HTML asset ZIP / Word / Markdown / text), via paste or drag-drop. Uploading HTML or ZIP enters the as-is HTML path, where the backend first runs an **intent classification** to decide how to handle it:
- HTML: serves as the base rendered via `srcDoc`. ZIP: auto-finds `index.html` and converts relative CSS/images/fonts/etc. into self-contained HTML; to prevent bundled-app scripts from blanking the page inside `srcDoc`, ZIP as-is opening prioritizes static visibility and disables scripts.
- **HTML upload intent** (`classifyHtmlUploadIntent`): no text → `open`; "regenerate/redo/reference it for a new one" → `regenerate`; "change/adjust/optimize/delete/add" → `edit` (minimal modification of the original page); pure question → `ask` (open as-is and answer).
- **Image upload intent** (`classifyImageUploadIntent`, vision model): no text → `generate`; "what is this/analyze" → `ask`; "generate from the screenshot but change X to Y" → `generate-with-changes`.

**Preview area — four essentials**
- **Click-to-edit with AI**: click an element + a temporary anchor for precise positioning, scoping edits locally around the target element.
- **Plain editing**: click an element and use the property panel to edit a single element — copy/input value/placeholder/image alt, plus font/font-size/font-weight/line-height/letter-spacing/alignment/text color/padding & margin/background/border/border-radius/shadow/opacity and other visual attributes.
- **Requirement card**: the "Requirement Card" in the preview header opens a draggable review floating panel for manual card creation — BR number, P0/P1/P2 priority, pending-review/confirmed/doubtful/void state transitions, filter by state.
- **Product style profiles**: choose from 8 profiles — Ant Design / TDesign / Vant / Apple / Claude / Notion / Slack / Vercel.
- **Export**: export a self-contained HTML file.

---

## Desktop (Mac + Windows)

An Electron shell that loads `http://localhost:3000/youdesign` by default (override with `YOUDESIGN_DESKTOP_WEB_URL`); setting `YOUDESIGN_DESKTOP_USE_LOCAL_SERVER=true` starts the local Next standalone server. The client exposes a local Claude Code bridge via preload, invoking the user's locally installed and logged-in Claude Code CLI as a fallback when editing large HTML.

```bash
npm run desktop:dev              # dev shell
npm run desktop:dev:online       # cross-platform online web dev shell (for Windows)
npm run desktop:pack:mac         # unsigned .app (universal build, with local server fallback)
npm run desktop:dmg:mac          # unsigned DMG (universal build; official distribution still needs signing/notarization)
npm run desktop:dmg:thin:mac     # thin-client DMG: online web shell + Claude bridge, no .next/standalone bundled
npm run desktop:nsis:thin:win    # Windows 10/11 x64 thin-client NSIS
npm run desktop:dist:mac         # official DMG entry (requires Developer ID cert + notarization env)
```

- The client goes straight to the web login page and reuses web auth.
- Double-clicking the app on macOS may not inherit the terminal `PATH`; the client auto-detects Claude CLI install locations under `~/.claude/local`, Homebrew, npm global, nvm/fnm/volta/asdf; on Windows it prefers `where.exe`/`PATH`/npm global to find `claude.exe`/`claude.cmd`, and also checks Git Bash.
- Claude large-HTML edits are serialized in a queue and cancellable per task ID; only one Claude CLI task is launched at a time.
- Thin builds must keep `mac.identity: "-"` for ad-hoc signing with `hardenedRuntime: false`, otherwise macOS may report "the application is damaged." Ad-hoc internal builds may still be quarantined by Gatekeeper — run `xattr -dr com.apple.quarantine /Applications/YouDesign.app`. Official distribution still needs Developer ID signing + notarization.
- If downloading Electron assets from the public network fails, set a proxy as needed: `HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 npm run desktop:dmg:thin:mac`.

---

## Chrome Capture Extension

`extension/youdesign-capture/` is a Chrome MV3 extension (v0.2.9).

- **Capture current page** (the extension holds `<all_urls>` host permissions and injects `drawer_tracker` at load to track clicks): captures the rendered full-page DOM (scripts disabled, readable CSS inlined, remote CSS/small images converted to data URLs, src/href absolutized, 5MB total cap, only `http(s)://` business pages allowed), and records interaction metadata (open drawers/modals and their toggle buttons/overlays, standard/Ant Design tabs already in the DOM, embedded iframes).
- **Multi-tab collection**: injects a draggable "Tab Collection" floating panel. The extension identifies standard / Ant Design tab groups on the page (2–16 tabs); using the current DOM as the baseline, already-open tabs are collected automatically; on the source page the user opens lazy-loaded tabs one by one, clicks "Capture Current" to grab each panel's content, and finally "Merge & Send" combines all captured tabs into a single offline page.

---

## Self-Hosted Deployment

Next.js production mode + systemd hosting + nginx reverse proxy, mounted at the `/youdesign` sub-path (basePath).

```bash
git clone https://github.com/huangxiaoliang/YouDesign.git /opt/youdesign && cd /opt/youdesign && npm ci
cp .env.example .env.local   # edit: fill in real API keys, YOUDESIGN_AUTH_SECRET=openssl rand -hex 24
npm run build
```

`/etc/systemd/system/youdesign.service`:

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

nginx passes the `/youdesign/` prefix through as-is (do not strip it); set `proxy_buffering off;` and `proxy_read_timeout 300s;` (generation is a streaming long connection). Point `YOUDESIGN_DATA_DIR` outside the repo (e.g. `/var/lib/youdesign`) so `git pull` won't overwrite it; manage users with `node scripts/user.mjs <add|list|disable|enable|reset|set-role>`. To upgrade: `git pull && npm ci && npm run build && sudo systemctl restart youdesign`.

---

## Architecture / Generation Pipeline

```
 Natural language / upload  ──POST /api/generate (NDJSON streaming, requires login cookie)──▶ orchestrator.ts
  HTML/ZIP upload            ZIP converted to self-contained HTML on the frontend; intent classification runs before routing
  Intent classification      edit classifyEditIntent decides edit/ask; HTML upload classifyHtmlUploadIntent decides open/edit/regenerate/ask; image upload classifyImageUploadIntent decides ask/generate/generate-with-changes
  ⓪ Preflight preflight      one flash call decides "is the requirement clear" + "PC/mobile device"; asks back and pauses if vague; fast image mode skips LLM preflight, detects device by rules and outputs a single page directly
  ① Structure structure       default single-page FlowSpec + Prototype Contract (primary task/mustHave/demoable interactions/key states/assumptions); with a screenshot, attaches a Visual Reference Contract (mode/preserve/change/infer)
  ② Retrieve retrieve         (the native HTML path currently does not depend on external component-library retrieval)
  ③ Generate generate         streams self-contained HTML; fast mode uses flash, high-quality mode tiers by scenario (simple pages flash-first; complex/image/doc/style-profile/restoration cases use stronger models); the selected style profile is injected via buildStyleHead
  ③.5 Validate validate       real-navigation static guard (unsafePrototypeNavigation; if unfixable it blocks and keeps the original page / provides a fallback), self-repairing when necessary
  ③.55 Structure self-check   must-interaction acceptance (currently temporarily skipped entirely — see AGENTS §6)
  ③.6 Self-review review      risk-tiered (currently temporarily skipped entirely — see AGENTS §6)
  ③.7 Brand-color normalize   fallback after generation/self-review/edit: snaps drifted near-brand colors to the nearest themeCss token; neutral grays matched exactly
  ④ Preview preview           native HTML → srcDoc (uniformly injects a temporary navigation guard that intercepts real page jumps, wraps overwide tables in a horizontal scroll container, and is stripped before serialization/export)
  ⑤ Iterate edit              HTML output sized uniformly via HtmlSizeInfo
```

- **Auth gate**: `src/middleware.ts` intercepts unauthenticated requests (pages redirect to `/login`, APIs return 401).
- **Preview principle**: native HTML is rendered directly via `srcDoc` (same-origin, so it supports direct editing / element click-selection).

| Directory / File | Responsibility |
|---|---|
| `src/middleware.ts` + `src/lib/auth/` + `src/app/api/{login,me,logout}` | Auth gate (multi-user independent passcodes / shared-passcode fallback + signed cookie) + current user |
| `src/lib/meter/` + `src/app/usage` | Usage metering (provider `onUsage` + `MeteredProvider`, 15 call sites zero-intrusion; MySQL persistence or JSONL fallback) + DB aggregation dashboard (by user/model/China calendar day) |
| `src/lib/config.ts` | Env vars + model routing; auto-falls back to mock on missing config |
| `src/lib/providers/` | LLM abstraction + Anthropic (incl. `stream()`) / DeepSeek (incl. streaming/reasoning params) / GLM official OpenAI-compatible / Kimi (Volcengine Ark) / mock |
| `src/lib/pipeline/orchestrator.ts` | Main orchestration (streaming, cancellable), as-is HTML open/iterative edit, multi-HTML programmatic merge; intent classification/model routing/stage timing extracted into `intent.ts`/`routing.ts`/`timing.ts` |
| `src/lib/pipeline/{intent,routing,timing}.ts` | Upload/edit intent classification, model-routing heuristics, stage timing instrumentation |
| `src/lib/pipeline/{textUtils,judges,htmlScopePatch}.ts` | HTML/JSON cleaning and strict validation, `planHtmlEdit` pre-edit structured routing, anchor-annotated local-scope patching (incl. delete/hide/deterministic-replace fast paths, `matchLocateToAnchor` multi-signal + offset precise location) |
| `src/lib/pipeline/validate.ts` | JSX/HTML validation + self-repair + real-navigation static guard (`blockedNavigation` fallback) + deterministic brand-color correction (`normalizeBrandColors`) |
| `src/lib/prototypeNavigation.ts` · `previewNavigation.ts` | Prototype real-jump defense: server-side static detection + repair instructions; preview iframe temporary guard injection/stripping + auto-recovery after navigation away |
| `src/lib/exportInline.ts` | Export HTML offline inlining + mobile narrow-frame iframe + history bridge |
| `src/lib/capturedPage.ts` · `desktop/captured-page-runtime.cjs` · `desktop/capture-payload-utils.cjs` | Offline reconstruction and import sanitization of capture-extension payloads |
| `src/lib/prompts.ts` | Preflight/structure/generate/edit/self-review prompts (incl. `isTrivialNoOp` false-success detection, placeholder-image ban rule, strict no-real-page-navigation rule) |
| `src/lib/style/profiles.ts` · `patterns.ts` | Product style profiles (8) + style-token injection |
| `src/lib/store/sessions.ts` · `src/components/HistoryDrawer.tsx` | Session persistence (IndexedDB) + history drawer |
| `src/lib/embeddings/` | Zhipu embedding-3 (semantic) + local n-gram (lexical fallback) |
| `src/app/page.tsx` and `src/components/*` | Chat-style frontend, attachment reading/ZIP self-contained conversion, preview (click-select/edit/export/version/phone frame), requirement review card, native HTML single-element property panel |

---

## Self-Check / Tests

```bash
npm run typecheck          # tsc --noEmit
npm run build              # production build
```

Pure-local regressions (no services or model keys needed; run the ones whose paths you touched):

```bash
npm run test:desktop-claude-core       # desktop Claude single path + queue/cancel
npm run test:desktop-claude-fragments  # multi-fragment transaction extraction/atomic backfill
npm run test:desktop-windows-runtime   # Windows CLI/Git Bash/protocol/NSIS
npm run test:prototype-contract        # Prototype Contract + must-interaction acceptance
npm run test:preview-navigation        # prototype real-navigation interception
npm run test:export-history-bridge     # export mobile narrow-frame history bridge
npm run test:preview-device-mode       # preview viewport device mode + phone shell
npm run test:direct-html-editor        # native HTML single-element property editing
npm run test:session-brief             # session-level SessionBrief
npm run test:html-merge                # multi-HTML merge
npm run test:capture-sanitization      # capture-extension sanitization
npm run test:captured-page-safety      # captured-page offline safety
npm run test:captured-page-groups      # captured-page offline tab-group reconstruction
npm run test:capture-drawer            # captured-page drawer interaction runtime (Playwright, real run)
npm run test:capture-overlay           # multi-tab collection floating panel
npm run test:usage-jsonl               # JSONL usage storage
npm run test:mysql-usage               # MySQL connectivity + table schema + transactional write/read rollback
```

---

## Collaboration Conventions

One feature per PR, base `main`, branches named `feat/...`/`fix/...`/`docs/...`/`chore/...`; PRs must pass `typecheck` + `build` before merging; no direct edits on `main`; never mix "reformat the whole file" with functional changes in one PR. Detailed AI collaboration conventions, architecture, gotchas, and todos are in [`AGENTS.md`](./AGENTS.md).

---

## License

[MIT](./LICENSE).
