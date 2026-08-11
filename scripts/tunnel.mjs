#!/usr/bin/env node
/**
 * 内测穿透：把本机 dev server（默认 :3000）通过 cloudflared 暴露成一个公网 URL，
 * 供非同事朋友访问 YouDesign 内测。
 *
 * 用法：
 *   npm run dev                 # 先在另一个终端起 dev server
 *   npm run tunnel              # 默认穿透 http://localhost:3000
 *   npm run tunnel -- 3001      # 指定端口
 *   PORT=3001 npm run tunnel    # 等价
 *
 * 前置：需安装 cloudflared（macOS: brew install cloudflared）。
 * 默认走 trycloudflare.com 快速隧道：URL 每次重启会变，但零配置、够内测用。
 * 想要固定域名：参考 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
 * 配 named tunnel + DNS 路由，再把本脚本里的命令换成 `cloudflared tunnel run <name>`。
 *
 * 给朋友：URL + .env.local 里的 YOUDESIGN_ACCESS_PASSWORD。口令请私下单独发送。
 */
import { spawn, spawnSync } from "node:child_process";

const port = Number(process.argv[2] || process.env.PORT || 3000);
const target = `http://localhost:${port}`;

const probe = spawnSync("command", ["-v", "cloudflared"], {
  stdio: "ignore",
  shell: true,
});
if (probe.status !== 0) {
  console.error(
    "[tunnel] 未找到 cloudflared。安装方式：\n" +
      "  macOS:   brew install cloudflared\n" +
      "  其他:    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  );
  process.exit(1);
}

console.log(`[tunnel] 穿透目标：${target}`);
console.log("[tunnel] 启动 cloudflared（trycloudflare 快速隧道）…");
console.log("[tunnel] 看到类似 https://xxx.trycloudflare.com 的 URL 即可发给朋友。Ctrl+C 退出。");

const child = spawn(
  "cloudflared",
  ["tunnel", "--protocol", "http2", "--url", target],
  { stdio: "inherit" }
);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
child.on("exit", (code) => process.exit(code ?? 0));
