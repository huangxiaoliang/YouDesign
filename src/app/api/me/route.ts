import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { findUserById } from "@/lib/auth/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/me —— 返回当前登录用户的 id/姓名/角色（顶栏显示用）。未登录 401（middleware 已门禁）。 */
export async function GET(req: NextRequest) {
  const session = await verifySession(req.cookies.get(SESSION_COOKIE_NAME)?.value, config.auth.secret);
  if (!session) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const user = findUserById(session.userId);
  const name = user?.name ?? (session.userId === "default" ? "默认" : session.userId);
  return NextResponse.json({ userId: session.userId, name, role: user?.role ?? "user" });
}
