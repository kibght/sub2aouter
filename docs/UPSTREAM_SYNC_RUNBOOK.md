# 上游自动同步运行手册

## 1. 这套自动化做什么

仓库有两条协作流程：

| 流程 | 作用 | 调度 |
|---|---|---|
| `Sync Infinite Canvas Upstream` | 检查并门禁 Infinite Canvas 子模块更新，然后触发统一同步 | 每小时第 17 分钟；支持手动触发 |
| `Sync Upstream With Apophis Theme` | 获取 Sub2API 最新正式 Release，生成主题发布分支、镜像和二进制 | 由 Canvas 协调器 dispatch；main push 也会触发 |
| `Sync Watchdog` | 检查前两条流程的成功时间、失败状态和卡死状态 | 每小时第 41 分钟；支持手动触发 |

同步只跟随上游**已发布 Release**。上游 `main` 上尚未发布的 commit 不会被定时流程直接发布。

## 2. 发布不变量

以下任一条件不满足时，流程必须停止，不得移动 `latest`：

1. 上游 Release tag 能解析到有效 commit；
2. 上游提交满足单调升级规则；
3. main 中的 Infinite Canvas 子模块等于最新正式发布版本；
4. Canvas 更新已经通过 exact SHA 的完整 CI；
5. 主题 overlay、前端测试、后端测试和生产构建全部通过；
6. 版本镜像已经推送并可读取；
7. 六个二进制附件和 `checksums.txt` 全部存在；
8. GitHub Release 不是 draft/prerelease，target 是 `themed-release`；
9. 发布完成后才允许提升 `latest`。

## 3. 常用检查命令

### 查看最近运行

```powershell
gh run list --repo kibght/sub2aouter --workflow infinite-canvas-upstream-sync.yml --limit 20
gh run list --repo kibght/sub2aouter --workflow upstream-theme-sync.yml --limit 20
gh run list --repo kibght/sub2aouter --workflow sync-watchdog.yml --limit 20
```

### 查看单次运行

```powershell
gh run view <RUN_ID> --repo kibght/sub2aouter
gh run view <RUN_ID> --repo kibght/sub2aouter --log-failed
```

### 手动运行 watchdog

```powershell
gh workflow run sync-watchdog.yml --repo kibght/sub2aouter --ref main
gh run list --repo kibght/sub2aouter --workflow sync-watchdog.yml --limit 1
```

### 手动运行统一协调器

只应该 dispatch 协调器，不要直接并发调用主题发布流程：

```powershell
gh workflow run infinite-canvas-upstream-sync.yml --repo kibght/sub2aouter --ref main
gh run list --repo kibght/sub2aouter --workflow infinite-canvas-upstream-sync.yml --limit 1
```

### 手动运行一次已知 Release 检查

```powershell
gh workflow run upstream-theme-sync.yml `
  --repo kibght/sub2aouter `
  --ref main `
  -f repository_release=false `
  -f scheduled_round=true
```

## 4. 健康状态含义

watchdog 输出四种状态：

| 状态 | 含义 | 是否 dispatch | 是否告警 |
|---|---|---:|---:|
| `healthy` | 两条流程都有新鲜成功运行 | 否 | 否 |
| `running` | 有正在运行且未超过卡死阈值的任务 | 否 | 否 |
| `recoverable` | 最近失败或成功时间超过 120 分钟，且没有活动任务 | 是，dispatch Canvas 协调器 | 是 |
| `critical` | API 检查失败、运行记录缺失或活动任务超过 90 分钟 | 否 | 是 |

watchdog 不会直接 dispatch `upstream-theme-sync.yml`，避免绕过 Canvas 门禁和统一协调逻辑。

## 5. 告警处理

默认会创建或更新一个固定标题的 Issue：

```text
[automation] Upstream synchronization unhealthy
```

Telegram secret 已配置时会同时发送消息；没有 Telegram secret 时，GitHub Issue 仍然是主告警通道。

处理顺序：

1. 先看 watchdog 的 JSON artifact 和 step summary；
2. 再看最新 Canvas 协调器的失败 step；
3. 再看主题发布流程的 source、binary、promote-latest 三个 job；
4. 确认是网络瞬时错误还是确定性校验失败；
5. 网络错误可以等待 watchdog 重试；确定性错误必须修代码或修上游状态；
6. 修复后手动运行 watchdog 验证恢复，Issue 会在真正进入 `healthy` 后关闭。

## 6. 二进制 Release 修复

### 缺失或不完整附件

binary workflow 会复用当前版本并用 `--clobber` 补齐附件，不会自动创建新版本。

查看版本和附件：

```powershell
gh release view v0.1.241 --repo kibght/sub2aouter
```

手动修复指定 generated release ref：

```powershell
gh workflow run theme-binary-release.yml `
  --repo kibght/sub2aouter `
  --ref main `
  -f release_ref=<THEMED_RELEASE_COMMIT>
```

修复完成前不要手动推 `latest`。

### 上游 Release 回退或被删除

遇到以下日志时不要强制重跑：

```text
Refusing to downgrade or cross-grade Sub2API
Unable to verify the previously published upstream commit
```

先确认：

```powershell
gh release list --repo Wei-Shaw/sub2api --limit 10
gh api repos/Wei-Shaw/sub2api/releases/latest
```

只有确认上游正式 Release 恢复且 commit 历史可验证后，才重新运行协调器。

## 7. 版本元数据核对

主题分支应保持以下文件一致：

```text
.apophis-upstream-sha
.apophis-upstream-release-id
.apophis-upstream-release-tag
.apophis-repository-sha
.apophis-canvas-sha
backend/cmd/server/VERSION
```

查看 themed-release 文件：

```powershell
$repo = 'kibght/sub2aouter'
foreach ($file in @('.apophis-upstream-sha','.apophis-upstream-release-id','.apophis-upstream-release-tag','.apophis-repository-sha','.apophis-canvas-sha','backend/cmd/server/VERSION')) {
  $encoded = gh api "repos/$repo/contents/$file?ref=themed-release" --jq .content
  $value = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($encoded -replace '\s',''))).Trim()
  "${file}: $value"
}
```

## 8. 回滚原则

回滚必须保持 source、image、binary 和 metadata 一致：

1. 先停止或等待当前同步队列完成；
2. 记录当前 `main`、`themed-release`、release tag 和 image digest；
3. 选择一个已验证的历史 `themed-release` commit；
4. 通过人工审查的 release ref 重新发布或恢复版本镜像；
5. 只有二进制附件、Release target、metadata 和镜像 digest 全部验证后，才恢复 `latest`；
6. 在 watchdog 中确认两条流程重新进入 `healthy`。

不要只回滚 Docker tag，也不要只删除 GitHub Release。

## 9. 本地提交前检查

在隔离 worktree 中执行：

```powershell
node scripts/verify-release-pipeline.mjs --root .
$tests = Get-ChildItem scripts/__tests__/*.test.mjs | ForEach-Object FullName
node --test @tests
python -c "from pathlib import Path; import yaml; [yaml.safe_load(p.read_text(encoding='utf-8')) for p in Path('.github/workflows').glob('*.y*ml')]; print('workflow YAML parsed')"
git diff --check
node scripts/check-encoding.mjs
```

不允许在旧的 `codex/fix-upstream-automation` 分支上直接开发自动化修复。

## 10. 重要阈值

| 参数 | 默认值 |
|---|---:|
| 协调器调度 | 每小时第 17 分钟 |
| watchdog 调度 | 每小时第 41 分钟 |
| 成功记录过期阈值 | 120 分钟 |
| 活动运行卡死阈值 | 90 分钟 |
| 网络最大重试次数 | 5 次 |
| 网络退避上限 | 120 秒 |
| watchdog evidence 保留 | 30 天 |