# ToolSpan

面向 AI Agent 的远程工具。ToolSpan Core 是无头 MCP Server，只在 **ToolSpan 部署机器**上提供边界明确的工作区、文件、作业和制品工具。

> [!IMPORTANT]
> **Codex 内置 read/write 操作 Codex 所在机器；ToolSpan MCP read/write 操作 ToolSpan 所在机器。** 两者可能是不同的电脑、账号和文件系统。任何写入、删除、作业或发布之前，都应先调用 `devspace_info`，确认目标实例，缩小 `allowedRoots`，并检查申请的 OAuth Scope。

ToolSpan 是 MCP Server 与本地控制面，不是 MCP Client、Gateway、Agent Runtime、聊天应用或任意 Shell。无头 Core 就是完整功能路径；使用全部 Core Tool 不需要桌面控制面。

ToolSpan 的旧项目名是 WebGPT；该名称只保留在迁移兼容所需的位置。

## 本地工具与远程工具

| 操作 | 实际运行位置 | 常见用途 |
| --- | --- | --- |
| Codex 内置文件或终端操作 | Codex Host | 修改 Codex 已经能够访问的 Checkout |
| ToolSpan MCP Tool Call | ToolSpan Host | 操作另一台或远程机器上显式允许的根目录 |

MCP Client 由 Agent Host 提供，连接链路为：

```text
Agent Host → Host 内置 MCP Client → 用户自有 HTTPS → ToolSpan Core → Files/Jobs/Artifacts
```

ToolSpan 不代理其他 MCP Server，也不提供公网管理路由。

## 安全警告

获得授权的 ToolSpan Client 可以读取或修改文件、以 `shell: false` 运行**白名单开发任务**，以及发布 ToolSpan 机器上的制品。ToolSpan 没有任意 Shell Tool；但获准执行的构建或测试仍可能以 ToolSpan 服务账号的操作系统权限运行仓库代码。

优先只申请 `workspace:read`。仅在工作流确实需要时授予 `workspace:write`、`jobs:run` 或 `artifacts:publish`。处理不可信仓库时应使用专用低权限账号；状态目录和密码哈希文件必须位于所有允许根目录之外；持久制品公开 URL 应视为一次信息披露。

## 快速开始：确定性本地 Smoke

环境要求：

- Node.js 22 主版本中的 22.17+，或 Node.js 24.x；
- npm 能够从包仓库执行 clean install；
- 使用相关工作流时可在 `PATH` 中找到 Git 和 ripgrep（`rg`）。

本地源码和打包 Release Smoke 不需要域名、Cloudflare 账号、公共 Endpoint 或真实 Agent Host：

```powershell
npm.cmd ci
npm.cmd run verify:core
npm.cmd run smoke:core-release
```

`verify:core` 是确定性检查，不会联网抓取套餐限制或外部文档。`smoke:core-release` 会打包 Release，在隔离目录安装生产依赖，检查编译后的 password/doctor/start 命令与 `/healthz`，然后清理；它不会发布包或创建 Tag。

### 手动运行编译后的 Server

1. 构建项目，将 `toolspan.config.example.json` 复制到 `.toolspan-dev/toolspan.config.json` 等已忽略的本地路径。
2. 将 `publicBaseUrl` 设为对外提供 `/mcp` 的 HTTPS Origin；只做本地测试时可使用 localhost Origin。`allowedRoots` 只能指向已存在目录，`stateDirectory` 与 `ownerPasswordHashFile` 必须在这些目录之外。
3. 创建 Owner 密码哈希，不让密码进入命令历史：

```powershell
npm.cmd run build
$ToolSpanPassword = Read-Host "ToolSpan Owner 密码" -AsSecureString
$ToolSpanPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ToolSpanPassword)
try {
    $ToolSpanPlaintext = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ToolSpanPointer)
    $ToolSpanPlaintext | npm.cmd run password:init -- --file .\.toolspan-dev\owner.bcrypt
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ToolSpanPointer)
    Remove-Variable ToolSpanPlaintext -ErrorAction SilentlyContinue
}
```

4. 让配置中的 `ownerPasswordHashFile` 指向该 bcrypt 文件，然后诊断并启动：

```powershell
npm.cmd run doctor -- --config .\.toolspan-dev\toolspan.config.json
npm.cmd start -- --config .\.toolspan-dev\toolspan.config.json
```

`GET http://127.0.0.1:8787/healthz` 只返回最小 service/version/status，不包含实例名、真实路径、Owner 信息、账号或凭证。MCP Endpoint 本身需要 OAuth 授权。

配置选择顺序固定为：

```text
--config
> TOOLSPAN_CONFIG
> WEBGPT_CONFIG（Legacy；只警告一次）
> 已存在的 toolspan.config.json
> 已存在的 webgpt.config.json（Legacy；只警告一次）
> 预期的 toolspan.config.json
```

## 远程连接概览

1. 在你控制的机器上以回环地址启动 ToolSpan。
2. 在回环 Listener 前放置用户自有 HTTPS Endpoint，只转发预期的 ToolSpan Endpoint，不暴露管理界面。
3. 在 `toolspan.config.json` 设置公共 Origin，保持 Listener 只监听回环地址，并运行 `doctor`。
4. 在 Agent Host 中添加公共 `/mcp` URL，完成 OAuth，只申请本次会话所需的 Scope。
5. 授权后先调用 `devspace_info`，在首次写入或执行作业前确认 `instanceName`。

账号登录、DNS 修改、Tunnel 创建、Consent 和其他外部副作用始终由 Owner 控制。更多信息见[部署说明](docs/deployment.md)、[产品契约](docs/product-contract.md)和[威胁模型](docs/threat-model.md)。

## 四个常用工作流

### 1. 只读分析

申请 `workspace:read`，调用 `devspace_info`，用 `open_workspace` 打开允许范围内的现有目录，再用 `search_files`、`list_directory`、`read` 或 `read_many`。返回的 `workspaceId` 会把后续路径固定到已注册工作区。

### 2. 修改并测试

再次确认 ToolSpan 实例。只有修改时才申请 `workspace:write`，只有测试时才申请 `jobs:run`。优先使用便于审查的 `apply_patch` 或 `edit`，再用 `start_job` 选择白名单 Runner，并通过 `poll_job` 获取输出。ToolSpan 只传递 executable 与参数数组，且使用 `shell: false`，不接受任意命令文本。

### 3. 采集并分享制品

使用 `start_capture` 采集，通过 `inspect_artifact` 检查有大小限制的内容，再用 `preview_artifact` 建立短期 URL。只有确实需要持久公网链接时才申请 `artifacts:publish`；`publish_artifact` 是显式披露操作。

### 4. 恢复长任务

在适当位置保存 `workspaceId`、`jobId` 和最后的 Poll Cursor。后续会话可通过 `resume_workspace`、`list_jobs` 与 `poll_job` 继续，而不会重复启动任务。服务重启时丢失进程的作业会被标记为 interrupted，不会静默重启。

## Exact 27 Tool Contract

生产 MCP Baseline 为 `2025-11-25`。生成的 Contract Fixture 冻结 Tool 名、必填输入、Scope 与安全 Annotation。

<!-- tool-contract:start -->
| 分组 | Tools |
| --- | --- |
| 工作区 | `open_workspace`、`list_workspaces`、`resume_workspace` |
| 文件 | `read`、`write`、`edit`、`search_files`、`list_directory`、`stat_path`、`make_directory`、`move_path`、`copy_path`、`delete_path`、`restore_path`、`read_many`、`apply_patch`、`import_asset` |
| 作业 | `start_job`、`poll_job`、`cancel_job`、`list_jobs` |
| 制品 | `start_capture`、`inspect_artifact`、`list_artifacts`、`preview_artifact`、`publish_artifact` |
| 服务 | `devspace_info` |
<!-- tool-contract:end -->

ToolSpan 不包含 Terminal、任意 Shell、MCP Client、Gateway 或 Agent Runtime Tool。

## ChatGPT Chat、MCP 与 Codex 用量

<!-- openai-plan-usage-keys: chat.go,chat.plus,chat.pro5x,chat.pro20x,chat.business,codex.plus,codex.pro5x,codex.pro20x,codex.business,mcp.plus,mcp.pro,mcp.business,mcp.enterpriseEdu -->

快照来源：[`config/openai-plan-usage.snapshot.json`](config/openai-plan-usage.snapshot.json)

| 使用界面 | 单位 | 安全解释 |
| --- | --- | --- |
| ChatGPT Chat | 套餐定义窗口内的 ChatGPT Chat 消息 | 聊天额度，不是 MCP 或 Codex 额度 |
| MCP | MCP Tool Call 与当前 Host 策略 | 必须实测 Host/账号能力；套餐标签不保证写能力 |
| Codex | 官方窗口内的 Codex message/task 范围 | 任务消耗会变化，不能固定换算成 Chat 消息 |

快照检查会在不联网的情况下验证计算、获准来源域名和中英文 Key 一致性。当 `verifiedAt` 超过 30 天，渲染状态为 `STALE_FALLBACK`，具体数量替换为“查看当前官方限制”。详见双语[用量说明](docs/usage/chatgpt-chat-vs-codex.md)。

## Troubleshooting 决策树

```text
本机 /healthz 是否失败？
├─ 是 → 检查 Node 版本、配置选择、允许根目录是否存在、回环 Host、
│        密码哈希路径、状态路径和端口占用；运行 doctor。
└─ 否
   ├─ 公网 /healthz 是否失败？
   │  ├─ 是 → 检查 HTTPS、DNS/Tunnel 路由与 Host Header；Core 仍只监听回环。
   │  └─ 否
   │     ├─ OAuth Discovery/Authorization 是否失败？
   │     │  ├─ 是 → 检查 publicBaseUrl、精确 Redirect URI、PKCE、请求 Scope
   │     │  │        与 Client Registration；未知 Scope 会被拒绝。
   │     │  └─ 否
   │     │     ├─ 文件 Tool 是否被拒绝？
   │     │     │  ├─ 是 → 检查 workspaceId、相对路径、allowedRoots 与 Link/Junction。
   │     │     │  └─ 否
   │     │     │     ├─ 作业是否无法启动？
   │     │     │     │  ├─ 是 → 检查 doctor 的 Runner 可用性与 Allowlist。
   │     │     │     │  └─ 否 → 检查 Tool Scope、精确契约、Cursor 和制品状态。
```

不要通过监听公网地址、放宽 `allowedRoots`、关闭 Host/Origin 检查、添加 Shell 或记录 Token/配置来“修复”连接问题。

## 开发

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run check:contract
npm.cmd run check:brand
npm.cmd run check:version
npm.cmd run check:docs
npm.cmd run check:oss
npm.cmd run check:ci
npm.cmd run check:openai-plan-usage
```

网络 Audit、外链 Freshness、原生打包、真实 Host 兼容与真实账号验证属于 Release/Owner Gate，不进入普通 Core CI。

Desktop 贡献者应遵循 [Desktop v0.4 验证说明](docs/development/desktop-verification.md)；确定性源码完成与 Windows 安装、托盘及 owned-process 证据保持独立。

## 贡献、支持与许可证

参见 [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md) 与 [SUPPORT.md](SUPPORT.md)。ToolSpan 采用 [Apache License 2.0](LICENSE)。公共仓库 URL、Maintainer 安全联系方式和 Sponsor 身份仍属于 Owner Gate，本文不会编造。

English documentation: [README.md](README.md).
