/**
 * 口令生成与校验（多人模式）。
 * 口令为高熵随机串（剔除易混淆字符），库内只存 sha256 摘要；登录时对输入同样摘要后常量时间比对。
 * 写入（开户/重置）由 scripts/user.mjs 完成；运行时本模块只做校验。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// 去掉 I/L/O/U/0/1 等易混淆字符，方便人工抄读转交
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/** 生成可读随机口令（默认 16 位） */
export function generatePasscode(length = 16): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** sha256 摘要（十六进制），用于入库比对，不明文存口令 */
export function hashPasscode(passcode: string): string {
  return createHash("sha256").update(passcode, "utf8").digest("hex");
}

/** 常量时间比对，避免时序侧信道 */
export function verifyPasscode(passcode: string, hash: string): boolean {
  const a = Buffer.from(hashPasscode(passcode), "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
