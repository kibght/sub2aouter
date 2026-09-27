# Upstream Check and Version Reminder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每 30 分钟检查上游，仅在上游变化时发布，并让 Docker 镜像、二进制 Release 和管理后台版本提醒使用统一版本号与自有仓库。

**Architecture:** 同步工作流先读取上游 SHA，并仅对定时触发执行去重；有效发布时生成一次版本号，写入 `backend/cmd/server/VERSION` 和上游 SHA 标记，再由 Docker 与后续二进制工作流共同读取。管理后台继续复用现有更新 API和状态卡片，增加 30 分钟轮询并修正自有仓库与镜像常量。

**Tech Stack:** GitHub Actions YAML、Node.js `node:test`、Vue 3、Pinia、Vitest、Go Release 服务。

---

### Task 1: 工作流合同测试

**Files:**
- Modify: `scripts/__tests__/theme-boundary.test.mjs`
- Modify: `.github/workflows/upstream-theme-sync.yml`
- Modify: `.github/workflows/theme-binary-release.yml`

- [ ] 新增失败测试，断言 cron 为 `*/30 * * * *`、存在 `.apophis-upstream-sha` 去重、同步工作流写入统一 VERSION、Docker 标签包含统一版本、二进制工作流读取 VERSION 而不是重新生成版本。
- [ ] 运行 `node --test scripts/__tests__/theme-boundary.test.mjs`，确认新断言因现有工作流缺少上述行为而失败。
- [ ] 修改同步和二进制工作流，以最小实现满足合同。
- [ ] 重跑合同测试并确认通过。

### Task 2: 版本卡片合同测试

**Files:**
- Modify: `scripts/__tests__/theme-boundary.test.mjs`
- Modify: `frontend/src/components/common/VersionBadge.vue`
- Modify: `theme/apophis/files/frontend/src/components/common/VersionBadge.vue`

- [ ] 新增失败测试，断言前端仓库为 `kibght/sub2aouter`、Docker 镜像为 `ghcr.io/kibght/sub2aouter`、存在 30 分钟刷新间隔并在卸载时清理。
- [ ] 运行合同测试，确认因当前官方仓库常量和无轮询而失败。
- [ ] 修改源文件与主题覆盖文件，增加 30 分钟强制检查和清理逻辑。
- [ ] 重跑合同测试并确认通过。

### Task 3: 主题覆盖与文档同步

**Files:**
- Modify: `theme/apophis/files/.github/workflows/upstream-theme-sync.yml`
- Modify: `theme/apophis/files/.github/workflows/theme-binary-release.yml`
- Modify: `README.md`
- Modify: `THEME.md`
- Modify: `theme/apophis/files/README.md`
- Modify: `theme/apophis/files/THEME.md`

- [ ] 使用主题覆盖机制同步工作流和前端修改，保证干净上游重新套主题后仍保留行为。
- [ ] 更新文档中的检查频率、SHA 去重、统一版本和版本提醒说明。
- [ ] 运行 `node scripts/apply-theme.mjs --root . --check` 与编码检查。

### Task 4: 完整验证和发布

**Files:**
- Verify only.

- [ ] 运行全部 Node 合同测试。
- [ ] 运行 VersionBadge 或相关前端测试、typecheck 和生产构建。
- [ ] 解析两个 GitHub Actions YAML，检查事件条件和步骤条件。
- [ ] 检查 `git diff --check` 和最终差异，确保未纳入用户的未跟踪文件。
- [ ] 只提交本次相关文件并推送 `main`。
