# ChatGPT 的 Custom MCP App 使用指南

本产品使用“Custom MCP App”描述用户要添加的 MCP 连接；当前官方 UI 可能将其称为 Plugin。不要把它与历史 Plugins 平台或浏览器扩展混淆。带日期的来源（dated source）位于 `config/chatgpt-mcp-guide.snapshot.json`，官方入口为 <https://developers.openai.com/plugins/deploy/connect-chatgpt>。

截至快照日期，官方文档给出的入口是 `Settings → Security and login → Developer mode`，随后从 ChatGPT Plugins 页面添加公开 HTTPS MCP endpoint。账号与 workspace policy 可能决定 Developer mode 是否出现。快照超过 30 天时，隐藏这条具体 UI path，只显示“查看当前官方教程”；不得根据旧路径推断套餐能力。

## 准备并复制材料

Setup Center 应提供以下彼此独立的复制按钮；复制前必须由用户点击，不能自动写入剪贴板：

- **Copy App Name：** 复制用户确认的 ToolSpan instance 名称；
- **Copy Public MCP URL：** 复制 `https://mcp.aiqushi.top/mcp`；
- **Copy OAuth discovery URL：** 复制 `https://mcp.aiqushi.top/.well-known/oauth-authorization-server`；
- **Copy expected tool count：** 复制 `27`；
- **Copy read-only verification prompt：** 复制要求初始化、列出工具、确认 27/27，并先调用只读 `devspace_info` / workspace 查询的提示词；
- **Copy write verification prompt：** 复制要求先由用户确认 instance/workspace/allowed root，再在 synthetic e2e workspace 创建可清理测试文件并读取验证、禁止触碰用户文件的提示词；
- **Open current official guide/settings：** 只打开 snapshot 允许的官方页面，不自动点击 Create 或 Authorize。

## 人工步骤

1. 先独立验证公开 HTTPS `/mcp` endpoint、OAuth metadata 和 MCP Inspector。
2. 打开当前账号的 Settings，检查 Developer mode。若不可见或被 policy 阻止，记录 `BLOCKED_BY_HOST_PLAN_OR_POLICY`；不要要求购买 ChatGPT Business。
3. 启用 Developer mode，添加连接并输入 App Name / MCP URL；在 Create 与 OAuth consent 之前触发 `CHATGPT_CREATE_AND_AUTHORIZE` checkpoint，由用户检查并确认。
4. 扫描工具；工具数必须恰好为 27。缺少或新增工具时保留真实错误，不修改冻结契约来迎合 Host。
5. 执行 read-only prompt。若当前 ChatGPT 能力允许，再执行用户确认的 write prompt；否则由 Codex 真实 MCP E2E 承担 write/job gate。
6. 在 `FINAL_VERIFY` checkpoint 展示 Host、时间、tool count、read/write evidence 与 blocker；不显示 OAuth token/code、owner hash 或 workspace 真实敏感路径。

## 真实状态

| 状态 | 含义 |
| --- | --- |
| `MANUAL_PENDING` | 尚未完成人工连接步骤 |
| `USER_CONFIRMED` | 用户表示已完成 UI 步骤，但还没有真实 Host 证据 |
| `VALIDATED` | 真实 Host evidence 证明 OAuth、tool scan 与要求的调用成功 |
| `BLOCKED_BY_HOST_PLAN_OR_POLICY` | 当前账号/策略阻止对应 UI 或能力；不是源码失败 |

用户点击“完成”只能进入 `USER_CONFIRMED`，不能直接变成 `VALIDATED`。ChatGPT Business/Full MCP write 不属于本 Goal 的 Release Gate；但 exact 27、OAuth 与至少一个真实 Host 的最终 Release gate 仍需分别提供真实证据。
