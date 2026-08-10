# Unified Upstream Sync Design

## Goal

让 Infinite Canvas 与 Sub2API 在同一轮自动检查中完成状态收敛，并在两者同时更新时只生成一个主题版本。

## Current failure mode

当前有两个独立调度器：Infinite Canvas 在 `17` 分运行，Sub2 模板在 `7` 分运行。Canvas 更新合并后还会派发一次主题发布，而 `main` push 也会触发主题发布，导致重复发布风险；Canvas 派发使用 `repository_release=true` 时还不会同时拉取最新 Sub2API。

## Chosen design

- Infinite Canvas 工作流成为唯一每小时调度入口，改为 `7 * * * *`。
- 移除 Sub2 模板工作流的独立 `schedule`，保留手动触发与普通 `main` push 兼容。
- Canvas 工作流每轮检查结束后都派发一次统一主题同步：
  - Canvas 未更新：直接检查并同步最新 Sub2API；
  - Canvas 已更新：先合并子模块 PR，再检查并同步最新 Sub2API。
- 统一派发显式使用 `repository_release=false`，确保当前 Canvas 与最新 Sub2API 一起进入同一个发布计算。
- 跳过由 Infinite Canvas 自动合并产生的 `main` push 发布，避免“push 发布 + 派发发布”重复。
- 保留主题同步现有 release metadata 去重逻辑，保证无变化时不发布。

## Success criteria

1. 只有一个 scheduled workflow 启动同步轮次。
2. Canvas 更新与 Sub2API 更新可以进入同一个主题发布任务。
3. 自动 Canvas 合并不会再产生额外的 repository-only 版本。
4. 手动 `workflow_dispatch` 与普通仓库 push 行为不被破坏。
5. 工作流契约测试和完整 Node 测试通过。
