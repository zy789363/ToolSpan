# Global API Key — Advanced / Legacy

Global API Key 是 Advanced / Legacy 路径。它通常代表用户级广泛访问（Full Access 风险），无法描述为“最小权限”。能使用 Scoped API Token 时应优先迁移。

## 两次明确确认

1. 输入前显示：需要 account email + masked Global API Key；两者都只留在当前 session 内存。完整展示 Full Access 风险后，让用户输入确认短语 `I UNDERSTAND GLOBAL API KEY ACCESS`。
2. Dry Run 完成后再次显示目标 account、`aiqushi.top`、`mcp.aiqushi.top`、created/reused/updated/untouched 和冲突；在 `CLOUDFLARE_APPLY` checkpoint 再确认一次。

任何 email/key 都不得进入 config、DB、journal、日志、Prompt、receipt、diagnostics、crash report 或命令行。`X-Auth-Email` / `X-Auth-Key` header 名可以出现在 adapter contract 中，header 值必须在日志前完全删除。失败 envelope 若反射输入也必须二次 redaction。

流程、Zone Active gate、idempotency、owned-only rollback、public/OAuth/27 tools 验证与 Scoped 路径相同。完成后立即丢弃管理 credential，并建议创建 scoped token 后迁移。真实 E2E 若只有 Global Key，仍不能据此削弱冲突停止、二次确认或持久化 0 的安全边界。
