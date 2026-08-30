# Setup 故障诊断、Receipt 与 Rollback 指南

## 先分类，再重试

| 现象 | 分类/处理 |
| --- | --- |
| Zone 缺失 / Pending | `EXTERNAL_GATE_PENDING`；禁止 Apply，转到 nameserver onboarding |
| 当前 ChatGPT 没有 Developer mode / Custom MCP UI | `BLOCKED_BY_HOST_PLAN_OR_POLICY`；由 Codex 承担 write gate |
| credential 无效或权限不足 | 保持在 `PREFLIGHT`；不写资源，不记录值 |
| DNS/Tunnel 外部冲突 | `NEEDS_RECONCILIATION`；停止覆盖 |
| rate limit | 仅 GET 或幂等操作按 `Retry-After` 做有限重试；create 不盲目重放 |
| Apply 期间发生 crash | 只读 journal，进入 `NEEDS_RECONCILIATION`；不得自动继续写入 |
| 重启后需要远程操作 | `NEEDS_CREDENTIAL_REENTRY`；用户重新在本地 masked field 输入 |
| service/UAC 失败 | 报告实际状态；没有安装就不写 installed |
| public DNS/TLS 超时 | 保留资源，只读诊断；同一无新证据的失败不无限重跑 |

## Receipt 允许字段

Receipt 只保存 session ID、资源 ID/name、created/reused/updated/untouched 分类、pre-change 非秘密 fingerprint、验证时间/状态码、错误分类与 rollback 状态。不得包含 Authorization、X-Auth 值、Token、Key、password/hash、runtime credential、OAuth code/token、真实文件内容或无关个人路径。

Sanitized diagnostics 同样只报告版本、非秘密 ID、状态码、时间和分类；请求或响应 body 若可能反射输入，应先做结构化 redaction。support bundle 不收集 cloudflared service 命令行、注册表 credential、shell history 或 Secret 截图。

## 仅限自有资源的回滚（Owned-only Rollback）

1. 取得 session lock；同一实例只允许一个 `APPLYING` 或 `ROLLING_BACK`。
2. 展示将删除、恢复和保留的资源，并由用户确认。
3. 只有本 session 的 create response + journal 都证明资源为 `created`，该资源才可自动删除。
4. `reused` 永不自动删除；owned DNS/ingress 只有当前 fingerprint 等于 precondition 时才能恢复。
5. `service uninstall` 只作用于本 session 安装且 ownership 可证明的 service。
6. 每步写入 journal；成功为 `ROLLED_BACK`，任一 precondition 变化或外部操作失败为 `ROLLBACK_PARTIAL`。
7. partial 结果列出非秘密资源与人工步骤，不把 Secret 放进 receipt。

相同计划第一次与第二次运行后，第二次 `duplicates = 0`。若无法证明这一点，不能把 mock idempotency 标为 PASS。真实 Cloudflare/Host gate 与 deterministic mock gate 分开报告，外部缺失不应伪造成源码失败或真实 PASS。
