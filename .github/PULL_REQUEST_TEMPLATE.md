# PR 模板

## 改了什么 / 为什么

<!-- 简述本 PR 的目的与动机 -->

## Reviewer 请注意

<!-- 关键文件、风险点、需要重点看的逻辑 -->

## 自检

- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
- [ ] 若动了 AGENTS.md 标注的对应链路，已跑相关 `npm run test:*` 回归
- [ ] 若动了 `src/lib/prompts.ts` 或 `.env` 的 `ROUTE_*`，已人工对比保真度并在下方说明
- [ ] 未提交任何密钥/口令/内部凭据（`.env.local` 未入库）
- [ ] 未在 `main` 直接提交；未把「格式化整文件」与「功能改动」混在一起

## 关联

<!-- 关联 issue 或背景链接，无则留空 -->
