# Sub2API Apophis 风格主题

这个仓库保留 Sub2API 的全部后端和控制台功能，只替换公开首页主题。

## 分支

- `main`：永久保存主题、覆盖脚本和自动同步工作流。
- `themed-release`：GitHub Actions 根据最新上游源码自动生成的部署分支。

## 本地应用主题

```powershell
node scripts/apply-theme.mjs --root .
node scripts/apply-theme.mjs --root . --check
node scripts/check-encoding.mjs .
```

## 本地构建

项目使用 pnpm 9：

```powershell
cd frontend
corepack prepare pnpm@9.15.9 --activate
corepack pnpm install --frozen-lockfile
corepack pnpm run typecheck
corepack pnpm run build
```

## 自动更新

`.github/workflows/upstream-theme-sync.yml` 每天检查一次 `Wei-Shaw/sub2api`：

1. 获取最新上游源码。
2. 覆盖 `theme/apophis` 中的首页主题。
3. 检查 UTF-8 编码和主题漂移。
4. 运行前端测试、构建和后端单元测试。
5. 更新 `themed-release` 分支。
6. 发布 `ghcr.io/kibght/sub2aouter:latest`。

上游更新不会直接修改 `theme/apophis`，因此不会覆盖自定义模板。同步失败时不会更新 `themed-release` 和 `latest` 镜像。

## 回滚

每次同步都会发布带上游提交号的镜像：

```text
ghcr.io/kibght/sub2aouter:upstream-<commit-sha>
```

将部署镜像切换到上一个标签即可回滚。