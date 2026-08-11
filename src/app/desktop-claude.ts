const CLAUDE_LOG_PATH_MARKER = "__YD_CLAUDE_LOG_PATH__=";
const LEGACY_CLAUDE_LOG_PATH_MARKERS = ["**YD_CLAUDE_LOG_PATH**=", "YD_CLAUDE_LOG_PATH="];
export const DESKTOP_CLAUDE_PROTOCOL_VERSION = 5;
export const REQUIRED_DESKTOP_CLAUDE_CAPABILITIES = [
  "prepared-html",
  "raw-html-state",
  "precise-focus",
  "strong-validation",
  "electron-only-executor",
  "job-scoped-cancel",
  "reconstructed-html-input",
  "sha256-bridge",
] as const;

export async function sha256Text(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  const bridgeDigest =
    typeof window !== "undefined" && typeof window.youdesignDesktop?.sha256Text === "function"
      ? await Promise.resolve(window.youdesignDesktop.sha256Text(value))
      : "";
  if (/^[a-f0-9]{64}$/i.test(bridgeDigest)) return bridgeDigest.toLowerCase();
  throw new Error("当前页面缺少 SHA-256 能力，请升级 YouDesign 桌面客户端后重试");
}

export function desktopClaudeCompatibilityError(status: { protocolVersion?: number; capabilities?: string[] }): string | null {
  const protocolVersion = Number(status.protocolVersion);
  if (!Number.isFinite(protocolVersion) || protocolVersion < DESKTOP_CLAUDE_PROTOCOL_VERSION) {
    return `桌面客户端版本过旧，请升级后重试（需要 Claude bridge v${DESKTOP_CLAUDE_PROTOCOL_VERSION}）`;
  }
  const capabilities = new Set(Array.isArray(status.capabilities) ? status.capabilities : []);
  const missing = REQUIRED_DESKTOP_CLAUDE_CAPABILITIES.filter((capability) => !capabilities.has(capability));
  return missing.length ? `桌面客户端缺少 Claude 能力：${missing.join("、")}，请升级后重试` : null;
}

export async function openClaudeLog(rawLogPath: string) {
  if (!hasDesktopClaudeLogBridge()) return;
  await window.youdesignDesktop!.openClaudeLog!(rawLogPath);
}

export function hasDesktopClaudeBridge(): boolean {
  return typeof window !== "undefined" && typeof window.youdesignDesktop?.runClaudeHtmlEdit === "function";
}
export function hasDesktopClaudeStatusBridge(): boolean {
  return typeof window !== "undefined" && typeof window.youdesignDesktop?.getClaudeStatus === "function";
}
export function hasDesktopClaudeCancelBridge(): boolean {
  return typeof window !== "undefined" && typeof window.youdesignDesktop?.cancelClaudeHtmlEdit === "function";
}
export function hasDesktopClaudeLogBridge(): boolean {
  return typeof window !== "undefined" && typeof window.youdesignDesktop?.openClaudeLog === "function";
}

export function parseClaudeLogPath(detail: string): { detail: string; rawLogPath?: string } {
  const markers = [CLAUDE_LOG_PATH_MARKER, ...LEGACY_CLAUDE_LOG_PATH_MARKERS];
  const found = markers
    .map((marker) => ({ marker, idx: detail.indexOf(marker) }))
    .filter((item) => item.idx >= 0)
    .sort((a, b) => a.idx - b.idx)[0];
  if (!found) return { detail };
  const visible = detail.slice(0, found.idx).trim();
  const rawLogPath = detail.slice(found.idx + found.marker.length).trim().split(/\r?\n/)[0]?.trim();
  return { detail: visible, rawLogPath: rawLogPath || undefined };
}

export function formatDesktopClaudeFailure(err: unknown): { detail: string; prefix: string; rawLogPath?: string } {
  const parsed = parseClaudeLogPath(err instanceof Error ? err.message : String(err));
  const detail = parsed.detail
    .replace(/^Error invoking remote method 'desktop-claude:edit-html':\s*Error:\s*/i, "")
    .replace(/^Claude Code CLI 执行失败:\s*/i, "")
    .trim();
  if (/已取消|用户取消|cancel/i.test(detail)) {
    return { detail: "", prefix: "客户端增强已取消", rawLogPath: parsed.rawLogPath };
  }
  const incomplete =
    /达到最大轮次|达到预算上限|执行超时|未修改|返回的 HTML|返回内容|校验|fragment|片段|事务|真实页面导航|Prototype Contract|超过 Claude Code 增强大小上限/.test(
      detail
    );
  return {
    detail,
    prefix: incomplete ? "客户端增强未完成" : "客户端增强不可用",
    rawLogPath: parsed.rawLogPath,
  };
}
