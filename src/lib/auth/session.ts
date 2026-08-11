/**
 * 登录会话签名 cookie（Web Crypto，Edge/Node 通用）。
 * 值 = `${userId}.${exp}.${sig}`，sig = HMAC-SHA256(secret, `${userId}.${exp}`) 的十六进制。
 * 用全局 crypto.subtle（Edge 与 Node 20+ 均自带），避免 node:crypto 在 middleware(Edge runtime) 不可用。
 * 中间件验签后即可信任 userId。停用用户的旧 cookie 在过期前仍有效（见 AGENTS.md 多用户说明）。
 */

export const SESSION_COOKIE_NAME = "yd_auth";

const enc = new TextEncoder();
const keyCache = new Map<string, CryptoKey>();

async function getKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    keyCache.set(secret, k);
  }
  return k;
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

export async function signSession(userId: string, secret: string, ttlSec: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${userId}.${exp}`;
  const key = await getKey(secret);
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return `${payload}.${toHex(sigBuf)}`;
}

/** 验签并解出 userId；过期或签名不符返回 null。重算签名后常量时间比对。 */
export async function verifySession(
  cookieValue: string | undefined | null,
  secret: string
): Promise<{ userId: string } | null> {
  if (!cookieValue || !secret) return null;
  const parts = cookieValue.split(".");
  if (parts.length !== 3) return null;
  const [userId, expStr, sig] = parts;
  if (!userId || !expStr || !sig) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  const payload = `${userId}.${expStr}`;
  const key = await getKey(secret);
  const expected = toHex(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? { userId } : null;
}
