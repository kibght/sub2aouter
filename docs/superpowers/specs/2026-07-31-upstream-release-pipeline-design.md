# 上游自动发布与前端更新链设计

## 背景

KKBK-233 是上游 v0.1.169 安全问题报告者。仓库模板代码没有硬编码该账号或 Contributors 模块；GitHub 页面展示属于上游历史或 Release 元数据，不通过篡改模板、日志或 Git 历史删除。

## 目标

1. 对“上游提交变化 → 套用主题 → Docker latest → themed-release → 二进制 Release”建立可执行契约检查。
2. 对“新 Release → 后端查询自定义仓库 → 前端 VersionBadge 定时发现更新”建立回归保护。
3. 保证前端模板不显式植入 KKBK-233 或 Contributors 卡片，同时保留上游完整更新日志。
4. 检查失败时阻止发布，避免生成无法更新或缺失主题的新版本。

## 方案

新增一个 Node.js 契约校验模块和 CLI。模块只读取仓库文件，检查工作流触发条件、步骤顺序、发布目标、更新仓库、Docker 镜像、前端刷新周期以及主题 manifest 中的持久化补丁。CLI 在 GitHub Actions 同步构建前执行。

测试使用临时目录复制最小契约文件，分别破坏 schedule、二进制触发、前端仓库和模板 Contributors 内容，确认校验器能够拒绝错误配置。现有主题回归套件继续验证上游套用结果。

## 非目标

- 不删除或改写上游 Release 中的贡献者署名。
- 不重写 Git 历史。
- 不在本次验证中强制创建重复 Release。
- 不修改认证、计费、订阅、网关或数据库业务逻辑。

## 验收

- 契约 CLI 在当前仓库退出 0。
- 四类破坏性 fixture 均被检测。
- 上游同步 workflow 在构建发布前运行契约 CLI。
- 全部 Node 主题测试和相关 Go update service 测试通过。
- 代码与主题文件中不存在显式 KKBK-233/Contributors 模块。