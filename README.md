<p align="center">
  <img src="apps/desktop/src-tauri/icons/app-icon.png" width="96" alt="ToolSpan 图标">
</p>

<h1 align="center">ToolSpan</h1>

<p align="center">
  <strong>让 ChatGPT 在你的 Windows 开发机上安全编程。</strong><br>
  下载桌面端，按 GUI 向导完成配置，无需 OpenAI API Key。
</p>

<p align="center">
  <a href="https://github.com/zy789363/ToolSpan/releases/latest"><img src="https://img.shields.io/github/v/release/zy789363/ToolSpan?label=Release" alt="Latest release"></a>
  <a href="https://github.com/zy789363/ToolSpan/actions/workflows/core.yml"><img src="https://github.com/zy789363/ToolSpan/actions/workflows/core.yml/badge.svg" alt="Core CI"></a>
  <img src="https://img.shields.io/badge/Windows-x64-0078D4?logo=windows" alt="Windows x64">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-blue" alt="Apache 2.0"></a>
</p>

<p align="center">
  <a href="https://github.com/zy789363/ToolSpan/releases/latest"><strong>下载最新版</strong></a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#更多文档">更多配置方式</a>
</p>

## 为什么使用 ToolSpan

| | 能力 |
| --- | --- |
| 🖥️ **GUI 优先** | 首次启动、工作区、Owner 密码、公网连接和诊断均由 Desktop 向导完成。 |
| 💬 **ChatGPT 编程** | 在普通对话中读取项目、修改代码、运行测试并继续长任务。 |
| 🔒 **边界明确** | 只能访问你通过原生文件夹选择器授权的目录；状态和密码数据与工作区隔离。 |
| 🧰 **固定工具集** | 提供精确的 27 个工作区、文件、任务和产物工具，不开放任意 Shell。 |

## 工作方式

```text
ChatGPT 对话 → HTTPS /mcp → ToolSpan Core → 你授权的项目目录
                         ↑
                  ToolSpan Desktop 管理
```

> [!IMPORTANT]
> ChatGPT 消息、MCP Tool Call 与 Codex task 是不同计量面。实际能力和额度取决于当前账号及 workspace policy，ToolSpan 不承诺固定换算关系。

## 快速开始

### 1. 下载并打开

从 [GitHub Releases](https://github.com/zy789363/ToolSpan/releases/latest) 下载 Windows x64 安装包。推荐使用 `x64-setup.exe`；需要 MSI 部署时选择 `x64_en-US.msi`。

安装后打开 ToolSpan，点击“设置这台计算机”。

### 2. 完成首次启动向导

1. 为实例填写容易识别的名称。
2. 点击“选择文件夹”，只添加需要让 ChatGPT 操作的项目。
3. 检查状态与日志路径，设置至少 8 个字符的 Owner 密码。
4. 保持“保存后启动 Core”开启，点击“验证并启动”。
5. 进入“概览”，确认 Core“运行中”、MCP 工具 `27/27`、本地“就绪”。

Node 未就绪时，前往“设置 → 运行时 → 选择 Node 可执行文件”，选择 Node.js 22.17+ 或 24。

### 3. 用 GUI 配置公网连接

1. 在“概览”的“公网连接设置”点击“去设置”。
2. 选择推荐的“Scoped API Token”路径，填写 Cloudflare Zone 和 MCP hostname。
3. 输入 Token，点击“验证凭证并运行 Preflight”。Token 只在当前会话使用，页面离开后清空。
4. 确认 Zone 为 Active，再点击“生成 Dry Run”，逐项检查新建、复用和更新内容。
5. Dry Run 无误后重新输入 Token，点击“为 Apply 重新输入凭证”，再确认“Apply 已确认计划”。
6. 状态显示“公网访问已验证”后，前往“连接”，测试本地和公网端点。

> [!WARNING]
> 遇到来源不明的 DNS 或 Tunnel 冲突时停止。若页面显示“需要恢复”，只使用 Reconcile 或“回滚可证明拥有的变更”，不要重复 Apply。

### 4. 连接 ChatGPT

ToolSpan 的“公网配置”页面底部提供“Host 接入教程”，可直接复制 App 名称、公网 MCP URL、OAuth 地址和验证 Prompt。

1. 在 ChatGPT 打开 `Settings → Security and login`，启用 `Developer mode`。
2. 进入 ChatGPT Plugins 页面，点击“+”，填写名称和说明。
3. 在 Connection 中选择公网 Endpoint，粘贴 Desktop 提供且包含 `/mcp` 的 URL。
4. 创建连接并完成 OAuth；只在 ToolSpan 授权页输入 Owner 密码，并核对实例名称。
5. 确认发现的工具恰好为 27 个。
6. 新建对话，从工具菜单启用 ToolSpan。

该流程与 [OpenAI 官方 MCP/Plugin 测试指南](https://developers.openai.com/plugins/deploy/connect-chatgpt) 一致。Developer mode 是否可见取决于账号和 workspace policy。

## 开始第一个编程任务

复制到 ChatGPT：

```text
请使用 ToolSpan 处理我的项目。
先调用 devspace_info 报告实例名称，等我确认后再打开工作区。
先只读分析相关代码并给出最小修改方案；确认后再修改并运行适合项目的白名单测试。
不要访问未授权目录，不要永久删除文件，不要发布含敏感信息的产物。
最后汇总变更、测试结果和剩余风险。
```

推荐循环：**确认实例 → 确认工作区 → 只读分析 → 审查方案 → 修改 → 测试 → 汇总**。

## 安全边界

- 只授权具体项目文件夹，不选择整个磁盘或用户目录。
- 密码与 Token 只在对应的本地或官方页面输入，不粘贴到 ChatGPT。
- Apply、回滚、永久删除和公开产物前，先核对目标与影响范围。
- ToolSpan 是 MCP Server 和本地控制面，不是 MCP Client、Gateway 或任意 Shell。

## 常见问题

| 问题 | 在 GUI 中处理 |
| --- | --- |
| Core 无法启动 | “设置”中重新选择 Node，再到“日志”查看脱敏错误。 |
| 公网未就绪 | 回到“公网配置”，按状态横幅完成 Preflight、Zone、Dry Run 或恢复。 |
| ChatGPT 无法连接 | 在“连接”重测公网端点，并确认 URL 包含 `/mcp`。 |
| Developer mode 不可见 | 检查账号与 workspace policy；这不代表 ToolSpan 本地故障。 |
| 工具数不是 27 | 在 ChatGPT Plugins 页面 Refresh，并新建对话重新验证。 |
| 只能读不能写 | 检查 OAuth 授权、ChatGPT 当前能力及 workspace policy。 |

## 更多文档

| 场景 | 文档 |
| --- | --- |
| 所有设置路径 | [设置文档索引](docs/setup/index.md) |
| 命令行、配置文件与 Windows 服务 | [非 GUI 配置与部署](docs/deployment.md) |
| Cloudflare 手工设置 | [Cloudflare 引导](docs/setup/cloudflare-manual.md) |
| Scoped Token 设置 | [Scoped Token 说明](docs/setup/cloudflare-scoped-token.md) |
| Agent 辅助设置 | [Agent 辅助 Setup](docs/setup/agent-assisted.md) |
| ChatGPT Host 接入 | [ChatGPT 接入指南](docs/setup/chatgpt-custom-mcp.md) |
| 安全与工具边界 | [产品契约](docs/product-contract.md) · [威胁模型](docs/threat-model.md) |
