#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transform } from "esbuild";

const ROOT = process.cwd();

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const promptSource = read("src/lib/prompts.ts");
assert(promptSource.includes("Prototype Contract（原型验收合同"), "结构化 Prompt 必须生成 Prototype Contract");
assert(promptSource.includes('priority="must" 的每一条都必须可实际操作'), "生成 Prompt 必须逐条落实 must 交互");
assert(promptSource.includes("不得降级为 alert、toast、console"), "生成 Prompt 必须禁止用提示消息冒充交互完成");
assert(promptSource.includes("验收证据：${item.proof}"), "生成 brief 必须携带交互 proof");
assert(promptSource.includes("Visual Reference Contract（本次附有截图"), "有截图时结构化 Prompt 必须生成 Visual Reference Contract");
assert(
  promptSource.includes("用户明确修改要求 > 截图中清晰可见的事实 > 已选产品风格 > 模型自行推断"),
  "视觉参考冲突优先级必须固定"
);
assert(promptSource.includes("不得把 change 扩大到用户未要求的区域"), "生成 Prompt 必须约束截图修改边界");
assert(promptSource.includes("【Visual Reference Contract｜截图参考边界】"), "生成 brief 必须携带视觉参考合同");

const orchestratorSource = read("src/lib/pipeline/orchestrator.ts");
assert(orchestratorSource.includes("prototypeContract: PrototypeContractSchema"), "结构化解析必须要求 Prototype Contract");
assert(
  orchestratorSource.includes("const SKIP_NON_CLAUDE_STRUCTURE_CHECK = true") &&
    orchestratorSource.includes("if (SKIP_NON_CLAUDE_STRUCTURE_CHECK) return []"),
  "非 Claude Code CLI 生成链路必须跳过通用结构自检（含 must 交互验收）"
);
assert(orchestratorSource.includes("visualReference: VisualReferenceContractSchema.optional()"), "结构化解析必须校验 Visual Reference Contract");
assert(orchestratorSource.includes("requireVisualReference: hasImages"), "有截图时必须要求 Visual Reference Contract");
assert(
  orchestratorSource.includes('title === "图片参考原型" ? { visualReference: visualReferenceContract(normalizedRequirement) } : {}'),
  "快速图片模式必须生成零调用默认视觉合同"
);

const structureCheckSource = read("src/lib/pipeline/structureCheck.ts");
const compiled = await transform(structureCheckSource, { loader: "ts", format: "esm", target: "es2022" });
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`;
const { checkGeneratedStructure } = await import(moduleUrl);

const flow = {
  title: "客户风险",
  summary: "查看客户风险并下钻详情",
  prototypeContract: {
    pageArchetype: "风险客户列表页",
    primaryUser: "客户成功经理",
    primaryJob: "识别高风险客户并查看风险详情",
    mustHave: ["客户列表"],
    interactions: [
      {
        priority: "must",
        trigger: "点击客户行",
        result: "打开风险详情抽屉",
        proof: "右侧出现可关闭的客户风险详情抽屉",
      },
    ],
    requiredStates: ["详情抽屉打开态"],
    assumptions: [],
  },
  pages: [
    {
      id: "list",
      name: "客户列表",
      summary: "风险客户列表",
      sections: [{ name: "客户列表", description: "展示风险客户" }],
      componentNeeds: [],
      dataFields: ["客户名称", "风险等级"],
    },
  ],
  navigations: [],
};

const staticCode = `<!doctype html><html><body><main><h1>客户列表</h1><button>查看客户</button>${"客户风险数据".repeat(
  220
)}</main></body></html>`;
const staticResult = checkGeneratedStructure({
  requirement: "点击客户行打开风险详情抽屉",
  flow,
  code: staticCode,
  useDpl: false,
  device: "pc",
});
assert(
  staticResult.issues.some((issue) => issue.includes("必须可演示交互")),
  "只有静态按钮、没有事件和状态变化时必须验收失败"
);

const interactiveCode = `<!doctype html><html><body><main><h1>客户列表</h1><button id="customer">查看客户</button><aside class="risk-drawer" hidden><h2>风险详情抽屉</h2><button id="close">关闭</button></aside>${"客户风险数据".repeat(
  220
)}</main><script>const drawer=document.querySelector('.risk-drawer');document.querySelector('#customer').addEventListener('click',()=>{drawer.hidden=false});document.querySelector('#close').addEventListener('click',()=>{drawer.hidden=true});</script></body></html>`;
const interactiveResult = checkGeneratedStructure({
  requirement: "点击客户行打开风险详情抽屉",
  flow,
  code: interactiveCode,
  useDpl: false,
  device: "pc",
});
assert(
  !interactiveResult.issues.some((issue) => /Prototype Contract|必须交互/.test(issue)),
  `带事件、可见抽屉和关闭逻辑的实现应通过合同验收：${interactiveResult.issues.join("；")}`
);

console.log("Prototype Contract regression passed");
