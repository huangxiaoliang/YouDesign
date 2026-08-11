import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { config as appConfig } from "@/lib/config";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth/session";

/**
 * 登录门禁：验签 yd_auth cookie。
 * - 页面：未登录重定向到 /login（已登录访问 /login 则跳回 /）
 * - 接口：返回 401（不重定向，避免前端拿到 HTML）
 * userId 由各 API 路由自行读 cookie + verifySession 解出（见 /api/generate）。
 * matcher 已排除 /login、登录/登出接口与静态资源、自托管运行时。
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const session = await verifySession(req.cookies.get(SESSION_COOKIE_NAME)?.value, appConfig.auth.secret);
  const authed = Boolean(session);

  if (pathname === "/login") {
    if (authed) {
      const url = req.nextUrl.clone();
      url.pathname = "/";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  if (authed) return NextResponse.next();

  if (pathname.startsWith("/api")) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  // 放行：登录页相关接口、Next 静态资源、favicon 系列、登录 logo、移动预览自托管运行时(第三方库资源)
  // 显式补 "/"：basePath 下负向 lookahead 模式不匹配根路径，首页会绕过门禁
  matcher: ["/", "/((?!api/login|api/logout|_next/static|_next/image|favicon|logo\\.svg|logo/).*)"],
};
