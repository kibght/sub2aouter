# Upstream Release Notes Inheritance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自有主题 Release 自动继承当前源码已包含的上游 Release 标题、版本、链接和完整更新日志，并在无法匹配 Release 时生成提交摘要。

**Architecture:** 上游同步工作流通过 GitHub API获取最新上游 Release，拉取其 tag 并验证 tag 提交是当前上游 SHA 的祖先。匹配成功时将 Release 元数据和正文保存到 `themed-release`；匹配失败或 API 不可用时写入基于提交记录的回退说明。二进制发布工作流读取这些文件，通过 `--notes-file` 发布。

**Tech Stack:** GitHub Actions、Bash、GitHub CLI、Git、Node.js `node:test`。

---

### Task 1: 发布日志合同测试

**Files:**
- Modify: `scripts/__tests__/theme-boundary.test.mjs`

- [ ] 断言同步工作流请求 `Wei-Shaw/sub2api` 最新 Release。
- [ ] 断言同步工作流验证 Release tag 已包含在当前上游 SHA 中。
- [ ] 断言同步工作流生成上游版本、标题、链接和正文元数据文件。
- [ ] 断言二进制工作流使用 `--notes-file`，且不再使用硬编码 `--notes`。
- [ ] 运行合同测试并确认因功能缺失而失败。

### Task 2: 上游 Release 元数据捕获

**Files:**
- Modify: `.github/workflows/upstream-theme-sync.yml`

- [ ] 在有效发布任务中调用 GitHub Releases API。
- [ ] 拉取最新 Release tag 并解析到提交 SHA。
- [ ] 用 `git merge-base --is-ancestor` 验证 Release 已包含于当前源码。
- [ ] 匹配成功时保存 `.apophis-upstream-release-*` 文件和完整 Markdown 正文。
- [ ] API失败或 tag 不匹配时，根据上次同步 SHA 到当前 SHA 的提交生成回退说明。
- [ ] 重跑合同测试。

### Task 3: 自有 Release 使用上游更新日志

**Files:**
- Modify: `.github/workflows/theme-binary-release.yml`
- Modify: `theme/apophis/files/.github/workflows/theme-binary-release.yml`

- [ ] 读取上游 Release 元数据。
- [ ] 生成包含上游版本链接、原始正文和主题构建信息的临时 Markdown 文件。
- [ ] Release 标题包含上游版本。
- [ ] `gh release create` 改用 `--notes-file`。
- [ ] 保持根工作流和主题覆盖副本字节一致。

### Task 4: 验证与交付

**Files:**
- Verify only.

- [ ] 运行全部 Node 合同测试。
- [ ] 解析 GitHub Actions YAML。
- [ ] 在临时干净源码中应用主题并检查工作流持久化。
- [ ] 运行 UTF-8 与 `git diff --check`。
- [ ] 提交、合并到 `main`、推送并即时确认同步任务触发。