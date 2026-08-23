# cloudflared 运行凭证、轮换与撤销

Cloudflare 管理凭证和 Tunnel 运行凭证不是一回事：

- 管理凭证（Scoped API Token）只用于当前 Setup session 的远程管理，必须在完成后丢弃。
- Tunnel 运行凭证用于持久连接，只能由官方 `cloudflared` service / credential storage 机制持有。ToolSpan 不保存、不显示完整值，也不把值复制到 config、DB、journal、Prompt、receipt、日志或诊断。

## 安装与 ownership

先记录 `cloudflared` 版本、官方来源、service 是否已存在以及本次 session 是否创建它。需要 UAC 时暂停，由用户确认。已有外部 foreground process 或 service 不得被 ToolSpan 接管；不得按端口或进程名批量终止。

support bundle 必须排除 service 命令行、注册表 credential、credential file 内容、环境值、shell history 与可能包含 token 的截图。可以报告版本、service 状态、非秘密 Tunnel ID 和错误分类。

## 轮换步骤

1. 确认目标 Tunnel ID/name 与当前 service ownership，保存非秘密 pre-change fingerprint。
2. 告知用户轮换会短暂中断公网连接；在 `CLOUDFLARE_APPLY` checkpoint 暂停确认。
3. 在 Cloudflare 官方 Dashboard/流程中 rotate or revoke（轮换或撤销）旧运行凭证。不要把新值粘贴到聊天或 ToolSpan。
4. 由用户通过官方 `cloudflared` 本地流程更新本次 owned service；若需要 UAC，再次暂停。不要让录屏、命令回显或诊断捕获值。
5. 验证 service health、配置 hostname 的 HTTPS health、OAuth metadata 和 MCP 27/27 tools。
6. 确认旧凭证已撤销；receipt 只写轮换时间、Tunnel ID、验证状态与 rollback 状态，Secret 数量为 0。

若更新失败，不把旧 token 从日志/历史中恢复。状态进入 `NEEDS_CREDENTIAL_REENTRY` 或 `NEEDS_RECONCILIATION`，由用户重新进入官方流程。partial rollback 应列出仍需人工处理的 service/Tunnel，但不包含凭证。

## 卸载

卸载 ToolSpan 不擅自删除外部 Tunnel、DNS 或用户已有 cloudflared service。只有本 session 安装且 ownership 可证明的 service 才可在用户确认后卸载；删除远程 Tunnel/DNS 仍遵循 created-only / fingerprint precondition。
