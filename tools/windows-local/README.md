# Windows 完整本地版

该目录运行完整的主题版 Sub2API，不是前端 Mock，包含：

- 当前仓库中的 Apophis 风格前端
- Go 后端
- PostgreSQL 18
- Redis 8
- 真实管理员登录、用户控制台和数据持久化

## 第一次使用

1. 双击 `install-prerequisites.cmd`，同意 UAC，安装 WSL2 和 Docker Desktop。
2. 如果系统要求重启，重启 Windows 一次。
3. 启动 Docker Desktop，等待状态变为 Running。
4. 双击 `start-local.cmd`。

第一次启动会从当前源码构建镜像，需要下载 Node、Go、Alpine、PostgreSQL 和 Redis 镜像，耗时取决于网络。

## 地址

```text
http://127.0.0.1:18080/home
```

首次启动时脚本会自动生成 `.env`，并在窗口中显示本地管理员邮箱和密码。

## 管理

- `start-local.cmd`：构建并启动完整服务
- `status-local.cmd`：查看容器状态和后端日志
- `stop-local.cmd`：停止服务但保留全部数据

数据库、Redis 和应用配置保存在 Docker named volumes 中。不要执行带 `-v` 的 `docker compose down`，否则会删除本地数据。