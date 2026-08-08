# 上游自动更新加固设计

## 目标

修复定时同步错误选择 `upstream` 仓库的问题，并确保 Infinite Canvas 子模块更新只有在完整 CI 对更新提交执行成功后才允许合并到 `main`。同步频率、发布去重、版本号、镜像发布顺序和二进制修复语义保持不变。

## 已确认问题

1. `upstream-theme-sync.yml` 在添加 `upstream` remote 后执行未带 `--repo` 的 `gh workflow run`，GitHub CLI 会把目标解析成 `Wei-Shaw/sub2api`。
2. Infinite Canvas 自动 PR 使用仓库 `GITHUB_TOKEN` 创建后立即合并；`main` 没有 required checks，PR 工作流不能作为真实合并门禁。
3. 活跃 README 仍描述每 30 分钟同步和页面定时刷新，与当前每小时协调器及按需版本检查不一致。
4. 本地子模块 checkout 与父仓库记录的 gitlink 不一致。

## 方案

### 显式仓库选择

所有跨工作流调度和 PR 操作显式传入 `--repo "$GITHUB_REPOSITORY"`。不允许 GitHub CLI 根据 `origin`、`upstream` 顺序推断仓库。

### 可复用完整 CI

`.github/workflows/backend-ci.yml` 同时支持：

- `push`；
- `pull_request`；
- `workflow_call`，接收可选字符串输入 `ref`。

每个 checkout 都使用 `${{ inputs.ref || github.sha }}`。Canvas 协调器把更新提交推到自动分支后，以该不可变 commit SHA 调用完整 CI。

### Canvas 协调器分层

工作流拆为四个 job：

1. `update`：检测 Release、更新子模块、执行快速 adapter 预检、推送自动分支、创建或复用 PR，输出 `changed`、`update_sha`、`pr_number`。
2. `full-ci`：仅在 `changed == true` 时调用可复用 CI，验证自动分支提交。
3. `merge`：仅在 `full-ci` 成功后合并 PR，并显式指定仓库。
4. `dispatch-release`：无 Canvas 变化时直接运行；有变化时必须等待合并成功，再显式调度统一 Sub2API/Canvas 发布。

任何完整 CI 或合并失败都会阻止 `dispatch-release`，因此不会把未验证状态发布为 `themed-release`、GHCR `latest` 或二进制 Release。

## 兼容性

- 保留现有 `cron: '7 * * * *'`。
- 保留已发布 Release 优先、无 Release 回退 `main` 的逻辑。
- 保留自动分支名 `automation/infinite-canvas-upstream`。
- 保留 squash merge。
- 保留统一发布输入 `repository_release=false` 和 `scheduled_round=true`。
- 不依赖 PAT、GitHub App 或分支保护配置即可完成完整 CI 门禁。

## 测试

- 契约测试拒绝缺少 `--repo` 的工作流调度。
- 契约测试拒绝不可复用或未按指定 SHA checkout 的 CI。
- 契约测试拒绝在完整 CI 之前合并 Canvas PR。
- 契约测试拒绝在合并失败或 CI 跳过时调度发布。
- 活跃 README 必须描述每小时协调和按需版本检查。
- 运行全部 Node 契约测试、UTF-8 检查、YAML 重复键检查和 `git diff --check`。
