# 贡献指南 · Contributing

感谢你有兴趣为 YouDesign 贡献代码！

## 先读

本项目所有 AI 协作工具与人类协作者的**唯一约定真源**是 [`AGENTS.md`](./AGENTS.md)：架构、生成管线、踩坑铁律、协作流程都在那里。开工前请完整阅读。

## 提交流程

1. 一功能一 PR，base 指向 `main`。
2. 分支命名：`feat/...`、`fix/...`、`docs/...`、`chore/...`。
3. 提交前必须通过自检：

   ```bash
   npm run typecheck && npm run build
   ```

   若改动的是 AGENTS.md 里标注的对应链路（抓取扩展、导航守卫、桌面 Claude、合并、计量等），另跑相关 `npm run test:*` 回归。
4. PR 描述说清「改了什么 / 为什么 / reviewer 注意」；若动了 `src/lib/prompts.ts` 或 `.env` 的 `ROUTE_*`，请在描述里点明并说明已人工验证保真度。
5. 不要在 `main` 直接改；不要把「格式化整文件」和「功能改动」混在一个 PR。
6. AI 工具提交保留各自的 `Co-Authored-By` 行；人类提交可不带。

## 安全

- 任何密钥、口令、内部凭据**绝不提交**。`.env.local` 已 gitignore。
- 发现安全漏洞请按 [`SECURITY.md`](./SECURITY.md) 私下联系维护者，**不要**开公开 issue。

## 行为准则

参与本项目即视为接受 [行为准则](./CODE_OF_CONDUCT.md)。
