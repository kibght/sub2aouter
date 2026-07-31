# Sub2API Apophis 风格主题

这个仓库保留 Sub2API 的全部后端、数据库、接口、鉴权和业务功能，只覆盖前端视觉层：公开首页、认证页面、用户控制台和管理后台。

## 分支

- `main`：永久保存主题、覆盖脚本和自动同步工作流。
- `themed-release`：GitHub Actions 根据最新上游源码自动生成的部署分支。

## 覆盖范围

- Apophis 黑白网格公开首页。
- 登录、注册和找回密码认证外壳。
- 用户控制台与管理后台的侧边栏、顶部栏和通用组件。
- 动态站点名称、Logo、副标题、API 地址、联系方式和文档地址。
- 桌面端、移动端和深色模式。

主题覆盖层不修改后端 Go 源码、数据库 Schema、Migration、API 协议、鉴权或业务逻辑。
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

## Docker 部署

三个 Compose 部署文件现在默认使用：

```text
ghcr.io/kibght/sub2aouter:latest
```

也可以通过环境变量临时指定其他镜像：

```dotenv
SUB2API_IMAGE=ghcr.io/kibght/sub2aouter:latest
```

服务器更新命令：

```bash
cd deploy
docker compose pull sub2api
docker compose up -d --no-deps sub2api
```

不再需要额外的 `docker-compose.theme.yml` 覆盖文件。
## 自动更新

`.github/workflows/upstream-theme-sync.yml` 每 30 分钟检查一次 `Wei-Shaw/sub2api`；上游 SHA 未变化时跳过构建和发布：

1. 获取最新上游源码。
2. 覆盖 `theme/apophis` 中的首页主题。
3. 检查 UTF-8 编码和主题漂移。
4. 运行前端测试、构建和后端单元测试。
5. 更新 `themed-release` 分支。
6. 使用统一版本号发布 `ghcr.io/kibght/sub2aouter:<version>`、`latest` 和二进制 Release。
7. 管理后台每 30 分钟检查自有仓库 Release，发现新版本后显示提醒。
8. Docker 构建只展示 Compose 更新命令，裸机 Release 构建保留二进制更新。
9. 自有 Release 自动继承当前源码已包含的上游 Release 完整更新日志。
10. 上游未发布对应 Release 或 API 不可用时，回退为提交摘要。


上游更新不会直接修改 `theme/apophis`，因此不会覆盖自定义模板。同步失败时不会更新 `themed-release` 和 `latest` 镜像。

## 回滚

每次同步都会发布带上游提交号的镜像：

```text
ghcr.io/kibght/sub2aouter:upstream-<commit-sha>
```

将部署镜像切换到上一个标签即可回滚。