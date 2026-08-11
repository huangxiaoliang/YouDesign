/**
 * Next.js 启动钩子。
 *
 * 注意：这里不要直接预热 DPL MCP 或 embeddings。Next 会编译 instrumentation，
 * 这些 server-only 依赖会把 child_process / node:* 模块带进编译链，导致 dev server 首页 500。
 * 真实请求路径里再按需惰性加载即可。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
}
