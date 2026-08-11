import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** POST /api/logout —— 清除登录 cookie */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("yd_auth", "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
