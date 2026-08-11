import { contentToText, type CompletionOptions, type LLMProvider } from "./types";

/**
 * 离线 Mock provider：不调用任何外部服务，让整条管线在无密钥时也能跑通。
 * 通过 json 模式区分"需求结构化"与"代码生成"两类调用，产出可信的占位结果。
 */
export class MockProvider implements LLMProvider {
  readonly id = "mock:llm";
  readonly ready = true;

  async complete(opts: CompletionOptions): Promise<string> {
    const lastUser = [...opts.messages].reverse().find((m) => m.role === "user");
    const requirement = (lastUser ? contentToText(lastUser.content) : "未命名页面").slice(0, 2000);
    const hasImages = opts.messages.some(
      (message) => Array.isArray(message.content) && message.content.some((block) => block.type === "image")
    );

    if (opts.json) {
      return JSON.stringify(this.mockSpec(requirement, hasImages), null, 2);
    }
    return this.mockCode(requirement);
  }

  private mockSpec(requirement: string, hasImages: boolean) {
    const title = requirement.split(/[，。,.\n]/)[0]?.slice(0, 20) || "原型";
    return {
      title,
      summary: `（Mock）根据需求「${title}」生成的多页高保真原型`,
      prototypeContract: {
        pageArchetype: "数据管理列表页",
        primaryUser: "业务运营人员",
        primaryJob: "筛选、查看并维护业务记录",
        mustHave: ["顶部筛选区", "数据表格", "新建入口"],
        interactions: [],
        requiredStates: ["默认列表态"],
        assumptions: ["离线 Mock 只验证生成管线，不模拟真实交互合同"],
        ...(hasImages
          ? {
              visualReference: {
                referenceMode: "faithful",
                preserve: ["截图中清晰可见的布局、内容与视觉层级"],
                change: [],
                infer: ["完成主任务所需的页内交互状态"],
              },
            }
          : {}),
      },
      pages: [
        {
          id: "list",
          name: "列表页",
          summary: "展示与筛选数据列表",
          sections: [
            { name: "顶部筛选区", description: "类型 / 日期范围 / 状态 等筛选条件" },
            { name: "数据表格", description: "带分页的列表，含操作列" },
            { name: "操作区", description: "右上角新建按钮" },
          ],
          componentNeeds: [
            { componentName: "Form", description: "顶部筛选表单" },
            { componentName: "Table", description: "带分页和操作列的数据表格" },
            { componentName: "Button", description: "新建按钮" },
          ],
          dataFields: ["编号", "名称", "状态", "金额", "创建时间"],
        },
        {
          id: "create",
          name: "新建页",
          summary: "新建一条记录的表单",
          sections: [{ name: "表单区", description: "填写各字段" }],
          componentNeeds: [
            { componentName: "Form", description: "录入表单" },
            { componentName: "Input", description: "文本输入" },
            { componentName: "Button", description: "提交/返回" },
          ],
          dataFields: ["名称", "状态", "金额"],
        },
      ],
      navigations: [
        { from: "list", trigger: "点击新建按钮", to: "create" },
        { from: "create", trigger: "点击返回/提交", to: "list" },
      ],
    };
  }

  private mockCode(requirement: string): string {
    const title = requirement.split(/[，。,.\n]/)[0]?.slice(0, 20) || "原型页面";
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8"/><title>${title}</title>
<style>
body{margin:0;font-family:-apple-system,PingFang SC,sans-serif;background:#f5f6f8;color:#1f2329}
.wrap{max-width:960px;margin:0 auto;padding:32px 24px}
h1{font-size:20px;margin:0 0 20px}
.card{background:#fff;border-radius:10px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,.06)}
.pill{display:inline-block;margin-top:12px;padding:4px 12px;background:#eef2ff;border-radius:999px;font-size:12px;color:#3a4}
.hint{margin-top:14px;color:#8a94a6;font-size:13px}
</style></head><body><div class="wrap">
<h1>${title}</h1>
<div class="card"><p>（Mock 生成）配置模型密钥后，这里会由模型生成高保真可交互原型。</p><span class="pill">需求：${title}</span></div>
<p class="hint">设置 YOUDESIGN_FORCE_MOCK=false 并配置模型 key 即可生成真实原型。</p>
</div></body></html>`;
  }
}
