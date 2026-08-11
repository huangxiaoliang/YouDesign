/**
 * 主界面用到的纯工具/常量（无 React 状态）：上传读取、阶段文案、结果摘要等。
 * 供 page.tsx（client）导入。含浏览器 API（FileReader/Image/canvas/mammoth），仅在客户端调用。
 */
import type { GenerationResult, UploadedDoc, UploadedImage } from "@/lib/types";

export const MAX_UPLOAD_MB = 5;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
export const MAX_ZIP_UPLOAD_MB = 10;
export const MAX_ZIP_UPLOAD_BYTES = MAX_ZIP_UPLOAD_MB * 1024 * 1024;

/** 累积文本是否已像一份 HTML（用于流式时决定能否边渲染） */
export function looksLikeHtmlText(s: string): boolean {
  return /^\s*<(?:!doctype|html|head|body|div|main|section)/i.test(s);
}

export const STAGE_LABELS: Record<string, string> = {
  open: "打开 HTML",
  intent: "理解意图",
  clarify: "理解需求",
  candidates: "向量召回相关组件",
  structure: "理解需求 · 拆解结构",
  retrieve: "检索 DPL 组件",
  generate: "生成页面代码",
  validate: "语法校验 · 自修复",
  "structure-check": "结构自检",
  review: "自评审",
  refine: "按评审优化",
  edit: "应用修改",
  "desktop-claude": "客户端增强处理",
  preview: "渲染预览",
};

export const DOC_ICON: Record<UploadedDoc["kind"], string> = {
  html: "🌐",
  markdown: "📝",
  word: "📘",
  text: "📄",
};

type ZipEntry = {
  name: string;
  aliases: string[];
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  dataStart: number;
};

type ZipInlineContext = {
  arrayBuffer: ArrayBuffer;
  entries: Map<string, ZipEntry>;
  lowerEntries: Map<string, ZipEntry>;
  missing: Set<string>;
  rootDir: string;
};

type DecompressionStreamCtor = new (format: string) => TransformStream<Uint8Array, Uint8Array>;

const ZIP_HTML_RE = /\.html?$/i;
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

function readUint16(view: DataView, offset: number) {
  return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number) {
  return view.getUint32(offset, true);
}

function decodeBytes(bytes: Uint8Array, label: string, fatal = false) {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

function uniqueNames(names: Array<string | null>) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const normalized = name?.replace(/\\/g, "/");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function decodeZipNames(bytes: Uint8Array, flags: number) {
  const utf8 = decodeBytes(bytes, "utf-8", true);
  const gbk = decodeBytes(bytes, "gbk");
  const fallback = decodeBytes(bytes, "utf-8");
  return flags & 0x800 ? uniqueNames([utf8, fallback, gbk]) : uniqueNames([utf8, gbk, fallback]);
}

function findZipEocd(view: DataView) {
  const min = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= min; offset--) {
    if (readUint32(view, offset) === 0x06054b50) return offset;
  }
  return -1;
}

function parseZipEntries(arrayBuffer: ArrayBuffer): ZipEntry[] {
  const view = new DataView(arrayBuffer);
  const eocdOffset = findZipEocd(view);
  if (eocdOffset < 0) throw new Error("未识别到有效 ZIP 目录。");

  const totalEntries = readUint16(view, eocdOffset + 10);
  const centralDirOffset = readUint32(view, eocdOffset + 16);
  if (centralDirOffset === 0xffffffff || totalEntries === 0xffff) {
    throw new Error("暂不支持 ZIP64 格式，请压缩为普通 ZIP 后再上传。");
  }

  const entries: ZipEntry[] = [];
  let offset = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (readUint32(view, offset) !== 0x02014b50) throw new Error("ZIP 中央目录损坏。");
    const flags = readUint16(view, offset + 8);
    const method = readUint16(view, offset + 10);
    const compressedSize = readUint32(view, offset + 20);
    const uncompressedSize = readUint32(view, offset + 24);
    const nameLen = readUint16(view, offset + 28);
    const extraLen = readUint16(view, offset + 30);
    const commentLen = readUint16(view, offset + 32);
    const localHeaderOffset = readUint32(view, offset + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error("暂不支持 ZIP64 格式，请压缩为普通 ZIP 后再上传。");
    }
    const aliases = decodeZipNames(new Uint8Array(arrayBuffer, offset + 46, nameLen), flags);
    const name = aliases[0];
    const localNameLen = readUint16(view, localHeaderOffset + 26);
    const localExtraLen = readUint16(view, localHeaderOffset + 28);
    entries.push({
      name,
      aliases,
      method,
      compressedSize,
      uncompressedSize,
      dataStart: localHeaderOffset + 30 + localNameLen + localExtraLen,
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries.filter(
    (entry) => !entry.aliases.some((name) => name.endsWith("/") || name.startsWith("__MACOSX/") || name.includes("/._"))
  );
}

function normalizeZipPath(path: string) {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function dirName(path: string) {
  const clean = normalizeZipPath(path);
  const idx = clean.lastIndexOf("/");
  return idx >= 0 ? clean.slice(0, idx) : "";
}

function topDir(path: string) {
  const clean = normalizeZipPath(path);
  const idx = clean.indexOf("/");
  return idx >= 0 ? clean.slice(0, idx) : "";
}

function stripUrlSuffix(url: string) {
  return url.split("#")[0].split("?")[0];
}

function safeDecodePath(path: string) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function isLocalResourceUrl(url: string) {
  const s = url.trim();
  return !!s && !s.startsWith("#") && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(s);
}

function makeZipContext(arrayBuffer: ArrayBuffer, entries: ZipEntry[], htmlEntryName: string): ZipInlineContext {
  const map = new Map<string, ZipEntry>();
  const lowerMap = new Map<string, ZipEntry>();
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      const key = normalizeZipPath(alias);
      map.set(key, entry);
      lowerMap.set(key.toLowerCase(), entry);
    }
  }
  return { arrayBuffer, entries: map, lowerEntries: lowerMap, missing: new Set(), rootDir: topDir(htmlEntryName) };
}

function findResourceEntry(ctx: ZipInlineContext, baseDir: string, rawUrl: string) {
  if (!isLocalResourceUrl(rawUrl)) return null;
  const rawPath = safeDecodePath(stripUrlSuffix(rawUrl.trim()));
  const normalizedBase = normalizeZipPath(baseDir);
  const candidates = rawPath.startsWith("/")
    ? [
        normalizeZipPath(rawPath.replace(/^\/+/, "")),
        ctx.rootDir ? normalizeZipPath(`${ctx.rootDir}/${rawPath.replace(/^\/+/, "")}`) : "",
      ]
    : [normalizeZipPath(`${normalizedBase ? `${normalizedBase}/` : ""}${rawPath}`)];

  for (const key of candidates.filter(Boolean)) {
    const entry = ctx.entries.get(key) ?? ctx.lowerEntries.get(key.toLowerCase());
    if (entry) return { entry, path: normalizeZipPath(entry.name) };
  }

  if (candidates[0]) ctx.missing.add(candidates[0]);
  return null;
}

async function readZipEntryBytes(ctx: ZipInlineContext, entry: ZipEntry) {
  const compressed = new Uint8Array(ctx.arrayBuffer, entry.dataStart, entry.compressedSize);
  if (entry.method === 0) return new Uint8Array(compressed);
  if (entry.method !== 8) throw new Error(`暂不支持 ZIP 压缩方式 ${entry.method}。`);

  const Ctor = (globalThis as typeof globalThis & { DecompressionStream?: DecompressionStreamCtor }).DecompressionStream;
  if (!Ctor) throw new Error("当前浏览器不支持解压 ZIP，请使用最新版 Chrome/Edge。");
  const stream = new Blob([compressed]).stream().pipeThrough(new Ctor("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readTextResource(ctx: ZipInlineContext, baseDir: string, url: string) {
  const found = findResourceEntry(ctx, baseDir, url);
  if (!found) return null;
  const bytes = await readZipEntryBytes(ctx, found.entry);
  return { text: new TextDecoder("utf-8").decode(bytes), path: found.path };
}

async function readBinaryResource(ctx: ZipInlineContext, baseDir: string, url: string) {
  const found = findResourceEntry(ctx, baseDir, url);
  if (!found) return null;
  const bytes = await readZipEntryBytes(ctx, found.entry);
  return { bytes, path: found.path };
}

function mimeFromPath(path: string) {
  const lower = stripUrlSuffix(path).toLowerCase();
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".ico")) return "image/x-icon";
  if (lower.endsWith(".woff")) return "font/woff";
  if (lower.endsWith(".woff2")) return "font/woff2";
  if (lower.endsWith(".ttf")) return "font/ttf";
  if (lower.endsWith(".otf")) return "font/otf";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  return "application/octet-stream";
}

function bytesToDataUrl(bytes: Uint8Array, mime: string) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

// ---- 单文件打包器（__bundler/*）解包 ----
// 这类文件 <body> 只有加载脚手架，真实页面藏在 <script type="__bundler/template">（整份 HTML 被转义成
// JS 字符串）和 <script type="__bundler/manifest">（资源 gzip-base64 清单）里。不解包的话
// buildDomSummary 会剥掉 script 只看到脚手架，自动定位找不到目标，整页闸口也会因体积超标直接放弃。
const BUNDLER_TEMPLATE_RE = /<script type="__bundler\/template">([\s\S]*?)<\/script>/i;
const BUNDLER_MANIFEST_RE = /<script type="__bundler\/manifest">([\s\S]*?)<\/script>/i;

interface BundlerResource {
  mime?: string;
  compressed?: boolean;
  data: string;
}

/** 检测是否为 __bundler/* 打包器产物 */
export function isBundlerHtml(html: string): boolean {
  return BUNDLER_TEMPLATE_RE.test(html);
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const Ctor = (globalThis as typeof globalThis & { DecompressionStream?: DecompressionStreamCtor }).DecompressionStream;
  if (!Ctor) throw new Error("当前浏览器不支持 gzip 解压，请使用最新版 Chrome/Edge。");
  // slice() 得到 ArrayBuffer-backed 副本，满足 BlobPart 类型（避免 SharedArrayBuffer 推断冲突）
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new Ctor("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 把 __bundler/* 打包器产物解包成普通自包含 HTML：template 脚本 JSON.parse 出真实 HTML，
 * manifest 里的 59 个资源（图片/字体，部分 gzip）还原成 data: URI 内联回 uuid 引用处。
 * 任何异常都回退返回原 bundler HTML（loader 仍能渲染，不阻断上传）。
 */
export async function decodeBundlerHtml(html: string): Promise<string> {
  try {
    const tplMatch = BUNDLER_TEMPLATE_RE.exec(html);
    if (!tplMatch) return html;
    const realHtml = JSON.parse(tplMatch[1].trim().replace(/;$/, "")) as string;
    const manMatch = BUNDLER_MANIFEST_RE.exec(html);
    if (!manMatch) return realHtml;
    const manifest = JSON.parse(manMatch[1].trim().replace(/;$/, "")) as Record<string, BundlerResource>;
    const resolved = await Promise.all(
      Object.entries(manifest).map(async ([uuid, res]) => {
        const mime = res.mime || "application/octet-stream";
        const raw = res.compressed ? await gunzipBytes(base64ToBytes(res.data)) : base64ToBytes(res.data);
        return [uuid, bytesToDataUrl(raw, mime)] as const;
      })
    );
    // uuid 是 36 字符唯一 token，split/join 全局替换避免 $ 反向引用坑
    let out = realHtml;
    for (const [uuid, dataUri] of resolved) {
      out = out.split(uuid).join(dataUri);
    }
    return out;
  } catch {
    return html;
  }
}

async function inlineCssUrls(css: string, baseDir: string, ctx: ZipInlineContext) {
  let out = "";
  let lastIndex = 0;
  for (const match of css.matchAll(CSS_URL_RE)) {
    const full = match[0];
    const url = match[2];
    const index = match.index ?? 0;
    out += css.slice(lastIndex, index);
    const resource = await readBinaryResource(ctx, baseDir, url);
    out += resource ? `url("${bytesToDataUrl(resource.bytes, mimeFromPath(resource.path))}")` : full;
    lastIndex = index + full.length;
  }
  return out + css.slice(lastIndex);
}

async function inlineSrcset(srcset: string, baseDir: string, ctx: ZipInlineContext) {
  const parts = srcset.split(",");
  const next: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [url, ...descriptor] = trimmed.split(/\s+/);
    const resource = await readBinaryResource(ctx, baseDir, url);
    next.push([resource ? bytesToDataUrl(resource.bytes, mimeFromPath(resource.path)) : url, ...descriptor].join(" "));
  }
  return next.join(", ");
}

function escapeScriptText(text: string) {
  return text.replace(/<\/script/gi, "<\\/script");
}

function escapeStyleText(text: string) {
  return text.replace(/<\/style/gi, "<\\/style");
}

function disableScript(doc: Document, script: HTMLScriptElement) {
  const disabled = doc.createElement("script");
  disabled.type = "text/plain";
  disabled.setAttribute("data-yd-disabled-script", script.getAttribute("src") ?? "inline");
  disabled.textContent = escapeScriptText(script.textContent ?? "");
  script.replaceWith(disabled);
}

async function inlineHtmlResources(html: string, htmlDir: string, ctx: ZipInlineContext, keepScripts = false) {
  const doc = new DOMParser().parseFromString(html, "text/html");

  for (const style of Array.from(doc.querySelectorAll<HTMLStyleElement>("style"))) {
    style.textContent = escapeStyleText(await inlineCssUrls(style.textContent ?? "", htmlDir, ctx));
  }

  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[style]"))) {
    const styleText = el.getAttribute("style");
    if (styleText) el.setAttribute("style", await inlineCssUrls(styleText, htmlDir, ctx));
  }

  for (const link of Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'))) {
    const href = link.getAttribute("href") ?? "";
    const css = await readTextResource(ctx, htmlDir, href);
    if (!css) continue;
    const style = doc.createElement("style");
    style.setAttribute("data-yd-inline", href);
    style.textContent = escapeStyleText(await inlineCssUrls(css.text, dirName(css.path), ctx));
    link.replaceWith(style);
  }

  // script 类预载提示：禁脚本模式下移除（相对的会 404）；运行脚本模式下保留（绝对的能工作）
  if (!keepScripts) {
    for (const link of Array.from(
      doc.querySelectorAll<HTMLLinkElement>(
        'link[rel~="prefetch"][as="script"], link[rel~="preload"][as="script"], link[rel~="modulepreload"]'
      )
    )) {
      link.remove();
    }
  }

  let scTotal = 0,
    scInlined = 0,
    scNotFound = 0,
    scAbs = 0,
    scInline = 0,
    scDisabled = 0;
  for (const script of Array.from(doc.querySelectorAll<HTMLScriptElement>("script"))) {
    scTotal++;
    if (keepScripts) {
      // 运行脚本模式：本地相对 <script src> 内联成 inline 脚本（保留 type 如 module）；其余原样保留不禁用
      const src = script.getAttribute("src");
      if (src && isLocalResourceUrl(src)) {
        const js = await readTextResource(ctx, htmlDir, src);
        if (js) {
          const inline = doc.createElement("script");
          const type = script.getAttribute("type");
          if (type) inline.setAttribute("type", type);
          inline.textContent = escapeScriptText(js.text);
          script.replaceWith(inline);
          scInlined++;
        } else {
          scNotFound++; // 读不到则保留原标签（运行时 404，不崩解析）
        }
      } else if (src) {
        scAbs++; // 绝对地址/CDN -> 原样保留
      } else {
        scInline++; // 无 src（inline/importmap/json）-> 原样保留，不禁用
      }
    } else {
      disableScript(doc, script);
      scDisabled++;
    }
  }
  console.log(
    `[zip] keepScripts=${keepScripts} scripts total=${scTotal} inlined=${scInlined} notFound=${scNotFound} absKept=${scAbs} inlineKept=${scInline} disabled=${scDisabled} missingRes=${ctx.missing.size} htmlLen=${html.length}`
  );

  const mediaTargets: Array<[string, string]> = [
    ["img[src]", "src"],
    ["source[src]", "src"],
    ["audio[src]", "src"],
    ["video[src]", "src"],
    ["video[poster]", "poster"],
    ["track[src]", "src"],
    ["iframe[src]", "src"],
    ["embed[src]", "src"],
    ["object[data]", "data"],
    ['input[type="image"][src]', "src"],
    ['link[rel~="icon"][href]', "href"],
    ['link[rel~="apple-touch-icon"][href]', "href"],
    ['link[rel~="preload"][href]', "href"],
    ['link[rel~="modulepreload"][href]', "href"],
  ];
  for (const [selector, attr] of mediaTargets) {
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>(selector))) {
      const url = el.getAttribute(attr);
      if (!url) continue;
      const resource = await readBinaryResource(ctx, htmlDir, url);
      if (resource) el.setAttribute(attr, bytesToDataUrl(resource.bytes, mimeFromPath(resource.path)));
    }
  }
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("img[srcset], source[srcset]"))) {
    const srcset = el.getAttribute("srcset");
    if (srcset) el.setAttribute("srcset", await inlineSrcset(srcset, htmlDir, ctx));
  }

  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function chooseHtmlEntry(entries: ZipEntry[]) {
  const htmlEntries = entries
    .filter((entry) => entry.aliases.some((name) => ZIP_HTML_RE.test(name)))
    .sort((a, b) => normalizeZipPath(a.name).split("/").length - normalizeZipPath(b.name).split("/").length);
  return (
    htmlEntries.find((entry) => entry.aliases.some((name) => /(^|\/)index\.html?$/i.test(name))) ??
    htmlEntries.find((entry) => entry.aliases.some((name) => !name.includes("/"))) ??
    htmlEntries[0]
  );
}

/** SSR 文本量低于此阈值视为「纯 JS 渲染页」（SSR 几乎空），自动开启脚本尝试渲染；否则禁脚本保稳定可编辑 */
const SSR_EMPTY_THRESHOLD = 50;

/** 量 HTML 里 SSR 可见文本量（去掉 script/style/noscript/template 后 body textContent 长度） */
function measureSsrTextLen(html: string): number {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script,style,noscript,template").forEach((e) => e.remove());
    return (doc.body?.textContent || "").trim().replace(/\s+/g, " ").length;
  } catch {
    return 0;
  }
}

async function readHtmlZip(file: File): Promise<UploadedDoc | null> {
  const arrayBuffer = await file.arrayBuffer();
  const entries = parseZipEntries(arrayBuffer);
  const htmlEntry = chooseHtmlEntry(entries);
  if (!htmlEntry) {
    alert("ZIP 资源包里没有找到 .html / .htm 文件。");
    return null;
  }

  const ctx = makeZipContext(arrayBuffer, entries, htmlEntry.name);
  const htmlBytes = await readZipEntryBytes(ctx, htmlEntry);
  const html = new TextDecoder("utf-8").decode(htmlBytes);
  // ZIP 里若装的是 __bundler/* 打包器产物，跳过 inlineHtmlResources（会把 bundler 脚本禁用），直接解包
  if (isBundlerHtml(html)) {
    return { name: file.name, kind: "html", content: await decodeBundlerHtml(html), originalBlob: file };
  }
  // 自动判断是否开启脚本：SSR 文本量充足 -> 禁脚本（稳定可编辑）；SSR 几乎空（纯 JS 渲染页）-> 开脚本尝试渲染
  const ssrTextLen = measureSsrTextLen(html);
  const keepScripts = ssrTextLen < SSR_EMPTY_THRESHOLD;
  console.log(`[zip] auto-detect: ssrTextLen=${ssrTextLen} threshold=${SSR_EMPTY_THRESHOLD} -> keepScripts=${keepScripts}`);
  const content = await inlineHtmlResources(html, dirName(htmlEntry.name), ctx, keepScripts);
  if (ctx.missing.size > 0) {
    const sample = Array.from(ctx.missing).slice(0, 5).join("\n");
    alert(`ZIP 中有 ${ctx.missing.size} 个相对资源未找到，页面可能仍有少量缺失：\n${sample}`);
  }
  return { name: file.name, kind: "html", content, originalBlob: file };
}

/** 读取非图片文件并抽成文本（ZIP 会转自包含 HTML；Word 用 mammoth；其余直接读文本） */
export async function readDoc(file: File): Promise<UploadedDoc | null> {
  const name = file.name;
  const lower = name.toLowerCase();
  if (lower.endsWith(".zip")) return readHtmlZip(file);
  if (lower.endsWith(".docx")) {
    // @ts-ignore 浏览器构建无类型声明
    const mod = await import("mammoth/mammoth.browser.js");
    const mammoth = (mod.default ?? mod) as { extractRawText: (o: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> };
    const arrayBuffer = await file.arrayBuffer();
    const { value } = await mammoth.extractRawText({ arrayBuffer });
    return { name, kind: "word", content: value, originalBlob: file };
  }
  if (lower.endsWith(".doc")) {
    alert("旧版 .doc 暂不支持，请另存为 .docx，或上传 PDF 截图/文本/HTML");
    return null;
  }
  const content = await file.text();
  let kind: UploadedDoc["kind"] = "text";
  if (/\.html?$/.test(lower)) {
    kind = "html";
    // 单文件打包器（__bundler/*）产物：解包成普通自包含 HTML，否则管线只看到脚手架
    if (isBundlerHtml(content)) return { name, kind, content: await decodeBundlerHtml(content), originalBlob: file };
  } else if (/\.(md|markdown)$/.test(lower)) {
    kind = "markdown";
  }
  return { name, kind, content, originalBlob: file };
}

/** 读图并等比缩放到长边≤1568（控制请求体），导出 jpeg base64 */
export async function downscaleImage(file: File): Promise<UploadedImage> {
  const dataUrl: string = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as string);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = dataUrl;
  });
  // 尺寸上限维持 1568px（vision 模型输入足够，再大只会拖慢 generate）
  const max = 1568;
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const needScale = scale < 1;
  // 截图类（PNG）走无损：不转 JPEG，避免文字边缘振铃/糊
  const isPng = file.type === "image/png" || /\.png$/i.test(file.name);

  if (isPng) {
    if (!needScale) {
      // 原图尺寸已合格 → 原样直传，连重编码都不做（真无损）
      return { mediaType: "image/png", data: dataUrl.split(",")[1], name: file.name, originalBlob: file };
    }
    // 尺寸超限 → 下采样后仍输出 PNG（编码无损；下采样丢像素是尺寸超限不可避免的代价）
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, w, h); // PNG 保留透明，不铺白底
    const out = canvas.toDataURL("image/png");
    return { mediaType: "image/png", data: out.split(",")[1], name: file.name, originalBlob: file };
  }

  // 照片类（JPEG/其他）：维持 JPEG，质量略提到 0.92（视觉近无损）
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; // JPEG 不支持透明，铺白底
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const out = canvas.toDataURL("image/jpeg", 0.92);
  return { mediaType: "image/jpeg", data: out.split(",")[1], name: file.name, originalBlob: file };
}

/** 生成/编辑完成后给对话区的一句话摘要 */
export function assistantSummary(r: GenerationResult, isEdit = false): string {
  if (r.rawHtml) {
    return isEdit
      ? `已在这份 HTML 上完成修改（保留原页、只改你要求的部分）。继续说要怎么改即可。`
      : `已原样打开《${r.flow.title}》。你想怎么修改？直接说要改哪里、改成什么即可。`;
  }
  if (r.html) {
    return isEdit
      ? `已更新《${r.flow.title}》（原生 HTML，可在预览里直接编辑或继续描述修改）。`
      : `已生成《${r.flow.title}》（原生 HTML，可离线打开、支持直接编辑）。`;
  }
  const pages = r.flow.pages.map((p) => p.name).join(" → ");
  const flowLine = r.flow.pages.length > 1 ? `\n${pages}` : "";
  return `${isEdit ? "已按你的要求修改" : "已生成"}《${r.flow.title}》${flowLine}`;
}
