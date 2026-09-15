# Infinite Canvas 集成与运维

Sub2Aouter 将 `basketikun/infinite-canvas` 构建为同源子应用 `/canvas-app/`，用户入口是 `/workspace/canvas`。Canvas 产物直接嵌入 Sub2Aouter 发布镜像和二进制，不需要额外容器、子域名或跨域配置。

## 获取源码

必须初始化子模块：

```bash
git clone --recurse-submodules https://github.com/kibght/sub2aouter.git
cd sub2aouter
git submodule update --init --recursive
```

## Docker 发布

```bash
docker build -t sub2aouter:canvas .
docker run --rm -p 8080:8080 sub2aouter:canvas
```

发布后检查：

```text
GET /health
GET /canvas-app/
GET /canvas-app/version.txt
```

登录后访问：

```text
/workspace/canvas
```

页面只读取当前用户的 active API Key，并通过同源 `postMessage` 传递给 Canvas。API Key 不会放进 URL。

## 第一阶段 Codex Agent 连接

- 固定入口：`/canvas-app/canvas?mode=new`
- 页面里增加“连接 Codex”帮助卡片。
- 复制命令：`npx -y @basketikun/canvas-agent`
- 自动检测：`http://127.0.0.1:17371/config`
- 检测失败时显示“下载/启动 Agent”说明。
- 不把 token 放在公共 URL 中。

## 上游升级

### Sub2API

每小时 / The hourly `infinite-canvas-upstream-sync.yml` coordinator dispatches `upstream-theme-sync.yml` for Canvas and `Wei-Shaw/sub2api`. After theme application it runs:

```bash
node scripts/apply-sub2-infinite-canvas-integration.mjs --root <generated-root>
```

A marker mismatch fails the workflow before the generated snapshot or `latest` can move. Release discovery is read once and fails closed; only an explicit missing Release may fall back to `main`.

### Infinite Canvas

The hourly Canvas coordinator checks the published `basketikun/infinite-canvas` Release. An explicit missing Release may fall back to `main`; API failures stop the run.

1. 更新 Git submodule 指针。
2. 应用 `scripts/apply-infinite-canvas-patches.mjs`。
3. 运行 Canvas typecheck 和生产构建。
4. 创建或复用 PR，并记录自动分支提交 SHA。
5. 通过 `.github/workflows/backend-ci.yml` 对该提交运行完整 CI。
6. Merge only with `--match-head-commit` for the exact SHA that passed full CI, then dispatch the unified release workflow.
7. Await binary publication for the immutable generated commit and promote `latest` only after every asset is verified.

补丁不直接写进上游子模块，避免后续升级时产生长期分叉。

## 故障定位

### 页面提示连接失败

检查发布产物是否包含：

```text
backend/internal/web/dist/canvas-app/index.html
```

同时确认 `/canvas-app/` 返回 Canvas HTML，而不是 Sub2 主站 HTML。

### Canvas 打开但没有模型

确认所选 API Key：

- 状态为 active。
- 能访问 `/v1/models`。
- 所属分组包含图片、视频或文本模型。
- 没有被额度、到期时间或 IP 规则阻止。

### 更新后适配器失败

不要跳过失败门禁。先对新上游提交运行：

```bash
node scripts/apply-infinite-canvas-patches.mjs --root integrations/infinite-canvas
```

根据报出的缺失 marker 更新适配器和契约测试，再合并升级 PR。

## 回滚

回滚包含 submodule 指针的主仓库提交，然后重新构建镜像。Canvas 的 localStorage 和 IndexedDB 数据不会被回滚命令主动删除。

## 许可证

Infinite Canvas 使用 AGPL-3.0。二次发布时保留其作者信息、许可证和对应修改源码。Sub2Aouter 的适配代码与 Infinite Canvas 上游源码通过 Git submodule 和构建时适配器保持边界。
