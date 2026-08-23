# ToolSpan Connection Assistant 手册

本目录描述 v0.6.0 的连接辅助流程。ToolSpan 是 MCP Server 与本地桌面控制面，不是 MCP Client、Gateway、Agent Runtime 或 Shell。Cloudflare 是可选的 BYO 公网路径；Headless Core 不依赖 Cloudflare、NameSilo 或 ChatGPT。

## 选择路径

| 路径 | 管理凭证进入 ToolSpan | 适用情况 |
| --- | --- | --- |
| Guided Manual | 否 | 希望在 Cloudflare Dashboard 中逐项完成 |
| Scoped API Token | 只在当前受控 session 的内存中 | 推荐的自动 Dry Run / Apply |
| Global API Key | 只在当前受控 session 的内存中 | Advanced / Legacy；权限范围很大 |
| Agent-assisted | 否；只传 Safe Manifest | 由浏览器或终端 Agent 辅助，人工接管敏感 checkpoint |

四条路径都必须先验证本地 Core，再验证 Zone，最后才允许外部副作用。`PLANNED` 之前外部副作用必须为 0；Apply 前必须展示 Dry Run 并由用户确认。

## 文档导航

- [Cloudflare Guided Manual](cloudflare-manual.md)
- [Zone Pending 与 nameserver onboarding](cloudflare-zone-onboarding.md)
- [Scoped API Token 路径](cloudflare-scoped-token.md)
- [Global API Key Legacy 路径](cloudflare-global-key.md)
- [cloudflared 运行凭证与轮换](cloudflared-runtime-credential.md)
- [ChatGPT Custom MCP App](chatgpt-custom-mcp.md)
- [域名与 NameSilo 透明推荐](domains-and-namesilo.md)
- [Agent-assisted Safe Manifest](agent-assisted.md)
- [故障诊断、Receipt 与 Rollback](troubleshooting-and-rollback.md)

## 永久安全边界

- Cloudflare 管理 Token / Global Key 不进 config、DB、journal、日志、Prompt、receipt、诊断、崩溃报告或命令行；没有 Remember 选项。
- Tunnel 运行凭证只能由官方 `cloudflared` 机制持有；ToolSpan 不读取、显示或收集完整值。
- 登录、CAPTCHA、2FA、Secret 输入、UAC、购买、Apply、OAuth consent 与有后果的外部变更由人类接管或确认。
- 外部冲突默认停止；不覆盖来源不明的 Tunnel、DNS、service 或 hostname。
- Setup 不改变 exact 27 Tool Contract，也不添加任意 Shell Tool 或公网 Admin route。

所有文档与 Prompt 均可离线打包验证。平台 UI、权限标签、套餐或优惠随时间变化时，以 dated snapshot 的 stale fallback 为准；确定性源码 gate 不把过期数据伪装成真实外部 PASS。
