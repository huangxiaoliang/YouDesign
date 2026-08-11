#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = readFileSync(new URL("../src/lib/pipeline/orchestrator.ts", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");

function compileFunctions(snippet, exportedNames) {
  const compiled = ts.transpileModule(
    `${snippet}\nmodule.exports = { ${exportedNames.join(", ")} };`,
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }
  ).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    Buffer,
    console: { log() {} },
  });
  return module.exports;
}

const routingStart = source.indexOf("function resolveMergeForm");
const routingEnd = source.indexOf("/**\n * 从用户指令里抽取次要 HTML", routingStart);
assert.ok(routingStart >= 0 && routingEnd > routingStart, "必须能提取合并形态与主次页解析函数");
const { resolveMergeForm, resolvePrimarySecondary } = compileFunctions(
  source.slice(routingStart, routingEnd),
  ["resolveMergeForm", "resolvePrimarySecondary"]
);

assert.equal(resolveMergeForm("点击机构管理，在新页面打开吉县宏天"), "page");
assert.equal(resolveMergeForm("点击后用独立页展示"), "page");
assert.equal(resolveMergeForm("点击后弹窗展示"), "modal");
assert.equal(resolveMergeForm("点击后嵌入详情"), "drawer", "未指定形态时应保持抽屉默认值");

// hint（LLM 预抽取）传入时优先于正则：覆盖"弹个层""做成覆盖层"等正则漏判的口语。
assert.equal(resolveMergeForm("随便一句无形态词的话", "modal"), "modal", "hint 必须优先于正则（补充口语漏判）");
assert.equal(resolveMergeForm("点击后弹窗展示", "page"), "page", "hint 覆盖正则命中");
assert.equal(resolveMergeForm("点击后弹窗展示", "unknown"), "modal", "hint=unknown 时回退正则");
assert.equal(resolveMergeForm("点击后弹窗展示", null), "modal", "hint=null 时回退正则");

const docs = [
  { name: "机构管理.html", content: "<html></html>", kind: "html" },
  { name: "吉县宏天.html", content: "<html></html>", kind: "html" },
];
assert.equal(
  resolvePrimarySecondary(docs, "点击“机构管理”的企业名称，在新页面打开吉县宏天").primary.name,
  "机构管理.html",
  "“点击 X 的…”句式必须把 X 识别为入口主页"
);
assert.equal(
  resolvePrimarySecondary(docs, "以吉县宏天作为主页面合并").primary.name,
  "吉县宏天.html",
  "显式主页面优先于上传顺序"
);

// hints（LLM 预抽取）传入时优先于正则：覆盖"把X嵌入到Y"这类正则抽取脆的口语。
assert.equal(
  resolvePrimarySecondary(docs, "随便一句无关键词的话", { primaryName: "吉县宏天" }).primary.name,
  "吉县宏天.html",
  "hints.primaryName 必须优先于正则抽取"
);
assert.equal(
  resolvePrimarySecondary(docs, "以吉县宏天作为主页面合并", { primaryName: "机构管理" }).primary.name,
  "机构管理.html",
  "hints.primaryName 覆盖正则命中"
);
// hints 为 null 时回退正则（行为不变）
assert.equal(
  resolvePrimarySecondary(docs, "以吉县宏天作为主页面合并", null).primary.name,
  "吉县宏天.html",
  "hints=null 时回退正则抽取"
);

const navStart = source.indexOf("function tagNavTrigger");
const navEnd = source.indexOf("\nconst FlowPageSchema", navStart);
assert.ok(navStart >= 0 && navEnd > navStart, "必须能提取新页面程序化合并函数");
const { programmaticNavigationMerge } = compileFunctions(
  `const MAX_MERGE_HTML_UPLOAD_BYTES = 10 * 1024 * 1024;\n${source.slice(navStart, navEnd)}`,
  ["programmaticNavigationMerge"]
);

const main = "<!doctype html><html><body><a>机构管理</a></body></html>";
const institution =
  "<!doctype html><html><body><nav>机构管理</nav><button>吉县宏天</button></body></html>";
const county = "<!doctype html><html><body><nav>机构管理 / 吉县宏天</nav></body></html>";
const chained = programmaticNavigationMerge({
  primaryEditHtml: main,
  secondaryDocs: [
    { name: "机构管理.html", content: institution, kind: "html" },
    { name: "吉县宏天.html", content: county, kind: "html" },
  ],
});
assert.equal(chained.ok, true, "主页→次页→三级页必须可程序化合并");
assert.match(chained.editHtml, /<a data-yd-nav-trigger="1">机构管理<\/a>/);
const firstBlob = /id="yd-nav-data-1">([\s\S]*?)<\/script>/.exec(chained.editHtml)?.[1];
assert.ok(firstBlob, "一级次页必须保存为独立数据块");
const decodedFirst = Buffer.from(firstBlob, "base64").toString("utf8");
assert.match(decodedFirst, /<button data-yd-nav-trigger="2">吉县宏天<\/button>/);
assert.match(decodedFirst, /parent\.__ydNavShow/, "次页内的下一级入口必须接到主页导航控制器");

const parallel = programmaticNavigationMerge({
  primaryEditHtml:
    "<!doctype html><html><body><a>机构管理</a><a>吉县宏天</a></body></html>",
  secondaryDocs: [
    { name: "机构管理.html", content: institution, kind: "html" },
    { name: "吉县宏天.html", content: county, kind: "html" },
  ],
});
assert.equal(parallel.ok, true);
assert.match(parallel.editHtml, /<a data-yd-nav-trigger="1">机构管理<\/a>/);
assert.match(
  parallel.editHtml,
  /<a data-yd-nav-trigger="2">吉县宏天<\/a>/,
  "主页已有入口时必须优先埋在主页，不能被次页面包屑误判成父子关系"
);

const oversized = programmaticNavigationMerge({
  primaryEditHtml: main,
  secondaryDocs: [
    { name: "机构管理.html", content: "中".repeat(4 * 1024 * 1024), kind: "html" },
  ],
});
assert.equal(oversized.ok, false);
assert.match(oversized.reason, /^merge-too-large:/, "合并总体积上限必须按 UTF-8 字节而不是字符数计算");

assert.match(
  pageSource,
  /const EDIT_MERGE_KEYWORD = \/[^/]*打开[^/]*\//,
  "编辑态“打开”指令必须保留上传 HTML 并进入合并路由"
);
assert.doesNotMatch(source, /drawer-merged-debug/, "生产编排器不得残留抽屉合并调试文件写入");

console.log("HTML merge regression passed");
