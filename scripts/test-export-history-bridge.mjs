#!/usr/bin/env node
// 回归：导出移动窄框时 history bridge 必须注入外层文档，不得注入 srcdoc 属性内。
// 历史 bug：injectHistoryBridge 用正则匹配第一个 </body>，而 applyMobileNarrowFrame
// 的外层 HTML 里 srcdoc 属性内嵌的原型自己也带 </body> 且排在前面，导致 bridge
// 被注进 srcdoc、跑进 iframe、找不到 .yd-phone-frame 就 return、监听挂不上，
// 浏览器后退无法回退多级页面。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

const stubPlugin = {
  name: "stub-basepath",
  setup(b) {
    // applyMobileNarrowFrame / injectHistoryBridge 不依赖 withBase，stub 掉即可编译。
    b.onResolve({ filter: /^@\/lib\/basePath$/ }, () => ({ path: "stub:basepath", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export function withBase(p){return p;}", loader: "js" }));
  },
};

(async () => {
  const sourcePath = new URL("../src/lib/exportInline.ts", import.meta.url).pathname;
  const result = await build({
    entryPoints: [sourcePath],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    target: "node20",
    plugins: [stubPlugin],
  });
  const bundled = result.outputFiles[0].text;
  const compiled = { exports: {} };
  new Function("require", "module", "exports", bundled)(require, compiled, compiled.exports);
  const { applyMobileNarrowFrame, injectHistoryBridge } = compiled.exports;

  // 原型自己带 </body>，模拟 srcdoc 内嵌 </body> 的真实场景。
  const proto = '<!doctype html><html><head><title>p</title></head><body><div>原型</div></body></html>';
  const outer = applyMobileNarrowFrame(proto, 390);
  const withBridge = injectHistoryBridge(outer);

  assert.match(withBridge, /id="__yd_export_history_bridge"/, "bridge 脚本必须注入到导出外层");

  const srcdocMatch = withBridge.match(/srcdoc="([\s\S]*?)" title="移动端预览"/);
  assert(srcdocMatch, "applyMobileNarrowFrame 必须产出 yd-phone-frame srcdoc iframe");
  assert.doesNotMatch(
    srcdocMatch[1],
    /__yd_export_history_bridge/,
    "bridge 不得注入 srcdoc 属性内——否则跑进 iframe、找不到 .yd-phone-frame、监听挂不上，浏览器后退无法回退多级页面"
  );

  const iframeClose = withBridge.indexOf("</iframe>");
  const bridgeIdx = withBridge.indexOf("__yd_export_history_bridge");
  assert(bridgeIdx > iframeClose, "bridge 必须位于外层 iframe 关闭标签之后，而非 srcdoc 内");

  assert.equal(injectHistoryBridge(withBridge), withBridge, "injectHistoryBridge 幂等：重复注入不重复");

  assert.match(injectHistoryBridge("plain no closing tags"), /__yd_export_history_bridge/, "无 </body> 时 bridge 追加末尾");

  console.log("✓ 导出 history bridge 注入位置回归通过");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
