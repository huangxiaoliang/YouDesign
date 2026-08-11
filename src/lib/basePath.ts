/**
 * 应用 basePath（如 "/youdesign"）。由 next.config.mjs 的 env.NEXT_PUBLIC_BASE_PATH 注入。
 * 客户端：Next 构建时把 NEXT_PUBLIC_* 内联进 bundle；服务端：运行时从 process.env 读。
 *
 * 用 withBase() 给「不自动加 basePath 前缀」的路径加前缀：
 *   原始 fetch("/api/x")、<img src="/logo.svg">、<a href="/login">、
 *   iframe srcDoc 里的 importmap 运行时路径、window.location.href 跳转等。
 * next/link、next/router、next/image、<Link> 会自动加前缀，不要重复包。
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

export function withBase(p: string): string {
  return BASE_PATH + p;
}
