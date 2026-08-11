import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { findUserByPasscode, isMultiUserMode } from "@/lib/auth/users";
import { signSession, SESSION_COOKIE_NAME } from "@/lib/auth/session";

export const runtime = "nodejs";

/**
 * POST /api/login —— 多人模式按口令查用户；无用户表时回退共享口令（登录为匿名 default）。
 * 成功下发签名 cookie（yd_auth = userId.exp.sig）。
 */
export async function POST(req: Request) {
  const { secret, sharedPassword, sessionTtlSec } = config.auth;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "服务未配置 YOUDESIGN_AUTH_SECRET" }, { status: 500 });
  }

  let password = "";
  try {
    password = (await req.json())?.password ?? "";
  } catch {
    /* 忽略 */
  }
  if (typeof password !== "string" || !password) {
    return NextResponse.json({ ok: false, error: "请输入口令" }, { status: 400 });
  }

  let userId: string | null = null;
  const useUsers = config.auth.mode !== "shared" && isMultiUserMode();
  const useShared = config.auth.mode !== "users";
  if (useUsers) {
    const user = findUserByPasscode(password);
    if (!user) {
      return NextResponse.json({ ok: false, error: "口令不正确或已停用" }, { status: 401 });
    }
    userId = user.id;
  } else if (useShared && sharedPassword && password === sharedPassword) {
    // 回退：无用户表时用共享口令，登录为匿名 default 用户（计量仍记录到 default）
    userId = "default";
  } else {
    return NextResponse.json({ ok: false, error: "口令不正确" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, await signSession(userId, secret, sessionTtlSec), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: sessionTtlSec,
  });
  return res;
}
