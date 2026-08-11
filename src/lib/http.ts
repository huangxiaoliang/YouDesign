import { fetch as undiciFetch, ProxyAgent, Agent, type RequestInit, type Dispatcher } from "undici";

/**
 * 统一的服务端 HTTP 客户端，自己做 NO_PROXY 判断。
 *
 * 背景：开发机里公网 API（Anthropic 等）可能需走本地代理，而某些内网/特定
 * 服务须直连。undici 的 EnvHttpProxyAgent 对 NO_PROXY 的子域后缀匹配不可靠
 * （`example.com` 匹配不到 `x.y.example.com`，会导致本应直连的请求被错误代理），
 * 故这里自行解析 NO_PROXY：命中则直连，否则走代理。
 */

function normalizeProxyUrl(value: string): string {
  const v = value.trim();
  if (!v) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
  return `http://${v}`;
}

const proxyUrl = normalizeProxyUrl(
  process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || ""
);

const noProxy = (process.env.NO_PROXY || process.env.no_proxy || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function bypassProxy(host: string): boolean {
  host = host.toLowerCase();
  return noProxy.some((entry) => {
    if (entry === "*") return true;
    const d = entry.startsWith(".") ? entry.slice(1) : entry;
    return host === d || host.endsWith("." + d);
  });
}

const directAgent = new Agent();
const proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 过载/网关类 HTTP 状态码：服务端临时不可用，退避后重试通常能恢复。
 * 不含 500——500 多为真实 bug，重试无益且白烧 token。
 */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/**
 * 过载退避表（毫秒）：对应 3 次重试，累计上限 ≈ 1+3+9 = 13s。
 * 网络层抛错用更短的退避（代理抖动通常瞬时恢复），见 networkBackoff。
 */
const OVERLOAD_BACKOFF_MS = [1000, 3000, 9000];

/** Retry-After 单次封顶 9s，避免长 Retry-After 把一次调用拖到分钟级。 */
const RETRY_AFTER_CAP_MS = 9000;

/**
 * 解析 Retry-After 响应头（HTTP-date 或秒数），返回退避毫秒（已封顶）。
 * 解析失败返回 null，由调用方退回 OVERLOAD_BACKOFF_MS。
 */
function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const sec = Number(value);
  if (Number.isFinite(sec) && sec >= 0) {
    return Math.min(sec * 1000, RETRY_AFTER_CAP_MS);
  }
  const t = Date.parse(value);
  if (Number.isFinite(t)) {
    const diff = t - Date.now();
    return diff > 0 ? Math.min(diff, RETRY_AFTER_CAP_MS) : 0;
  }
  return null;
}

/**
 * 服务端 fetch：自动按 NO_PROXY 选直连/代理，并重试两类**可恢复**失败：
 *
 * 1. 网络层抛错（fetch failed / other side closed 等）：未拿到响应，安全幂等，短退避 0.5s/1s/1.5s。
 * 2. 过载/网关响应（429/502/503/504）：服务端临时不可用，退避 1s/3s/9s（≈13s 上限），
 *    尊重 Retry-After 头（单次封顶 9s）。
 *
 * 其它 HTTP 错误响应（4xx 非 429、5xx 非 502/3/4）不重试，直接返回交给调用方处理。
 * 重试只发生在请求幂等安全的前提下；POST LLM 调用幂等（同一 prompt 重发不影响结果正确性）。
 */
export async function httpFetch(url: string, init?: RequestInit, maxRetries = 3) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* keep empty */
  }
  const dispatcher: Dispatcher = proxyAgent && !bypassProxy(host) ? proxyAgent : directAgent;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await undiciFetch(url, { ...init, dispatcher });
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) await sleep(500 * (attempt + 1)); // 0.5s, 1s, 1.5s
      continue;
    }
    // 过载/网关响应：退避后重试（重试名额用尽则原样返回，由调用方处理）
    if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
      // 释放 socket 供下一次复用
      try {
        await res.text();
      } catch {
        /* body 读不出无所谓，主要为了释放连接 */
      }
      const ra = parseRetryAfterMs(res.headers.get("retry-after"));
      await sleep(ra ?? OVERLOAD_BACKOFF_MS[attempt] ?? OVERLOAD_BACKOFF_MS[OVERLOAD_BACKOFF_MS.length - 1]);
      continue;
    }
    return res;
  }
  throw lastErr;
}
