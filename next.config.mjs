const BASE_PATH = "/youdesign";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // 挂在 /youdesign 子路径下（一个域名跑多应用时共用前缀）
  basePath: BASE_PATH,
  // 注入给客户端/服务端代码，供 withBase() 给原始 fetch/<a>/<img>/importmap 加前缀
  env: { NEXT_PUBLIC_BASE_PATH: BASE_PATH },
  // lzutf8 运行在 server 端，避免被打进 client bundle
  serverExternalPackages: ["lzutf8"],
};

export default nextConfig;
