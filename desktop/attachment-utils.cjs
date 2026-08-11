const path = require("node:path");
const crypto = require("node:crypto");
const { CAPTURE_RUNTIME_SOURCE, captureRuntimeScriptTag } = require("./captured-page-runtime.cjs");

const WINDOWS_RESERVED_ATTACHMENT_STEM = /^(?:con|prn|aux|nul|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))$/i;

function avoidWindowsReservedAttachmentName(name) {
  const value = String(name || "");
  // Windows 会把 CON.txt、CON.backup.html 等都视为设备名；只看最后一个
  // 扩展名会漏掉多重扩展，因此检查第一个点号前的名称段。
  const stem = path.basename(value).split(".", 1)[0].replace(/[ .]+$/g, "");
  return WINDOWS_RESERVED_ATTACHMENT_STEM.test(stem) ? `_${value}` : value;
}

function sanitizeAttachmentName(name, kind, kindConfig) {
  const config = kindConfig[kind];
  if (!config) throw new Error("不支持的附件类型");
  const rawBase = path.basename(String(name || `attachment${config.defaultExt}`));
  const cleaned = rawBase
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]+/g, "_")
    .trim()
    .slice(0, 180);
  const fallback = `attachment${config.defaultExt}`;
  let safe = cleaned || fallback;
  const ext = path.extname(safe).toLowerCase();
  if (!config.extensions.includes(ext)) {
    safe = `${safe.replace(/\.+$/, "")}${config.defaultExt}`;
  }
  return avoidWindowsReservedAttachmentName(safe);
}

function bufferFromIpcBytes(bytes) {
  if (!bytes) throw new Error("附件内容为空");
  if (Buffer.isBuffer(bytes)) return Buffer.from(bytes);
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (Array.isArray(bytes)) return Buffer.from(bytes);
  throw new Error("附件内容格式不支持");
}

function htmlWithAttachmentCsp(html, opts = {}) {
  let safe = String(html || "");
  const hasCapturedInteraction = /data-yd-capture-(?:drawer|tab)(?:[-\w]*)?\s*=/i.test(safe);
  const protectedFrames = [];
  // 任何“无 src、有 srcdoc”的 iframe 内容已离线内联，不联网，予以保留。
  // 含 live src 的 iframe 仍按不可信移除（交给下方无差别清洗）。
  // 覆盖 V2 构建器产物（data-yd-captured-frame）与移动端窄框导出（yd-phone-frame）两类纯 srcdoc iframe。
  const protectSrcdocOnly = (frameHtml) => {
    if (!/\ssrcdoc\s*=/i.test(frameHtml)) return frameHtml;
    // srcdoc 值里会含被捕获子页的 <img src=...>（已转义成 &lt;img src=&quot;...&quot;&gt;）。
    // 不能拿整段 iframe HTML 做 \ssrc= 子串匹配，否则会把这些文本里的 src= 误判成
    // iframe 元素自己的 live src，从而把安全的纯 srcdoc iframe 当联网 iframe 删掉。
    // 先剥掉 srcdoc="..." 整个属性（其值内无裸引号，[^"]* 可精确覆盖），再在剩余属性里查 src=。
    const withoutSrcdoc = frameHtml.replace(/\ssrcdoc\s*=\s*"[^"]*"/i, " ");
    if (/\ssrc\s*=/i.test(withoutSrcdoc)) return frameHtml;
    const token = `__YD_CAPTURED_FRAME_${protectedFrames.length}__`;
    protectedFrames.push(frameHtml);
    return token;
  };
  safe = safe.replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, protectSrcdocOnly);
  safe = safe.replace(/<iframe\b[^>]*\/?>/gi, protectSrcdocOnly);
  // 桌面附件绝不能保留来源 iframe：它会在系统浏览器里重新访问来源站点。
  safe = safe.replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, '<section data-yd-capture-frame-placeholder="true" role="status" class="yd-capture-frame-placeholder"><strong>内嵌区域未捕获</strong><span>已按离线安全策略移除联网内容。</span></section>');
  safe = safe.replace(/<iframe\b[^>]*\/?>/gi, '<section data-yd-capture-frame-placeholder="true" role="status" class="yd-capture-frame-placeholder"><strong>内嵌区域未捕获</strong><span>已按离线安全策略移除联网内容。</span></section>');
  safe = safe.replace(/<link\b(?=[^>]*\brel\s*=\s*(?:"[^"]*\bstylesheet\b[^"]*"|'[^']*\bstylesheet\b[^']*'|stylesheet))[^>]*\bhref\s*=\s*(?:"https?:[^"]*"|'https?:[^']*'|https?:[^\s>]+)[^>]*>/gi, "");
  safe = neutralizeExternalImages(safe);
  safe = safe.replace(/\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  safe = safe.replace(/\s+(?:src|href|action|formaction)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|\s*javascript:[^\s>]+)/gi, "");
  // Web 预览构建器可能已注入上一轮的受控运行时。附件输出始终只保留
  // 此处重新生成、且与 CSP hash 一致的一份，避免重复 id 和失活副本。
  safe = safe.replace(/<script\b(?=[^>]*\bid\s*=\s*(?:"__yd_capture_interaction_runtime"|'__yd_capture_interaction_runtime'|__yd_capture_interaction_runtime))[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  // 任何来源脚本一律失活；即使它伪装成 YouDesign 的 id 也不能得到执行权。
  safe = safe.replace(/<script\b([^>]*)>/gi, (_m, attrs) => {
    const withoutType = String(attrs || "").replace(/\s+type\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    return `<script type="text/plain" data-yd-disabled-script${withoutType}>`;
  });
  protectedFrames.forEach((frameHtml, index) => {
    safe = safe.replace(`__YD_CAPTURED_FRAME_${index}__`, frameHtml);
  });
  const scriptDirective = hasCapturedInteraction
    ? `'sha256-${crypto.createHash("sha256").update(CAPTURE_RUNTIME_SOURCE, "utf8").digest("base64")}'`
    : "'none'";
  const csp =
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: blob: file:; style-src 'self' 'unsafe-inline' data: blob: file:; font-src 'self' data: blob: file:; script-src ${scriptDirective}; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'">`;
  const ownedRuntime = hasCapturedInteraction ? captureRuntimeScriptTag() : "";
  if (/<head\b[^>]*>/i.test(safe)) {
    safe = safe.replace(/<head\b([^>]*)>/i, (m) => `${m}\n${csp}${ownedRuntime}`);
  } else if (/<html\b[^>]*>/i.test(safe)) {
    safe = safe.replace(/<html\b([^>]*)>/i, (m) => `${m}\n<head>${csp}${ownedRuntime}</head>`);
  } else {
    safe = `<!doctype html><html><head>${csp}${ownedRuntime}</head><body>${safe}</body></html>`;
  }
  return safe;
}

function neutralizeExternalImages(html) {
  return String(html || "").replace(/<img\b[^>]*>/gi, (tag) => {
    const srcMatch = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const src = srcMatch ? srcMatch[1] || srcMatch[2] || srcMatch[3] || "" : "";
    const srcsetMatch = /\ssrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const srcset = srcsetMatch ? srcsetMatch[1] || srcsetMatch[2] || srcsetMatch[3] || "" : "";
    if (!/^https?:/i.test(src) && !/(?:^|,)\s*https?:/i.test(srcset)) return tag;
    let neutralized = tag
      .replace(/\ssrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "")
      .replace(/\ssrcset\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "")
      .replace(/\salt\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, ' alt=""')
      .replace(/\sdata-yd-capture-resource-omitted(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/i, "");
    if (!/\salt\s*=/i.test(neutralized)) neutralized = neutralized.replace(/<img\b/i, '<img alt=""');
    return neutralized.replace(/<img\b/i, '<img data-yd-capture-resource-omitted="image" aria-hidden="true"');
  });
}

module.exports = {
  bufferFromIpcBytes,
  htmlWithAttachmentCsp,
  neutralizeExternalImages,
  sanitizeAttachmentName,
};
