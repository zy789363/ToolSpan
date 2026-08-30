# ToolSpan Setup：故障诊断提示词

默认只读。先将故障最小化：读取 Safe Manifest、Setup state/journal 的非秘密视图、local health、Zone status、Tunnel/DNS classification、cloudflared version/status、public health、OAuth metadata 和 Host evidence。不要读取真实 config/state DB 内容、service credential、Authorization header 或用户文件。

按 `PREEXISTING_FAILURE`、`REGRESSION`、`BLOCKED_BY_ENVIRONMENT`、`BLOCKED_BY_EXTERNAL_ACCOUNT`、`BLOCKED_BY_OWNER_INPUT`、`BLOCKED_BY_UPSTREAM_CHANGE`、`SPEC_CONFLICT` 分类。同一无新证据或代码变化的失败不重复完整套件。不要读取密码管理器、剪贴板历史、DOM secret、截图 secret 或 shell history；不要把 Secret 放进提示词、命令行、日志、receipt 或诊断。发现泄漏风险时立即停止 capture，并仅报告 redacted 分类。

Zone missing/Pending、DNS/Tunnel collision、crash reconcile、credential re-entry、rate limit、service/UAC、DNS/TLS、Host policy 分支分别处理。任何 fix 都必须先做 focused check；外部写入或回滚必须另行确认。不得通过放宽 SSRF/Host/Origin/allowedRoots、减少 27 tools 或启用任意 Shell 来“修复”。

<!-- setup-checkpoints:start -->
1. `AFFILIATE_CHOICE` — PAUSE/NOT_APPLICABLE：确认故障不来自隐藏 coupon 或 referral state（当前产品已无 referral 路径）；不自动打开商业链接。
2. `LOGIN` — PAUSE：若需重现账号问题，由用户接管登录、CAPTCHA、2FA；Agent 不取 session secret。
3. `SECRET_ENTRY` — PAUSE：远程 reconcile 需要 credential 时让用户本地重输；不从历史恢复或打印。
4. `CLOUDFLARE_APPLY` — PAUSE：任何修复写入、rollback、nameserver Save、service/UAC 前展示范围与 precondition。
5. `CHATGPT_CREATE_AND_AUTHORIZE` — PAUSE/NOT_APPLICABLE：重试 Create/OAuth consent 前由用户确认；policy blocker 不盲重试。
6. `FINAL_VERIFY` — PAUSE：运行 focused re-test，展示真实证据、仍存资源、partial rollback 与 blocker。
<!-- setup-checkpoints:end -->

Sanitized report 仅包含版本、非秘密 ID、状态码、时间、错误分类和 rollback status；Secret、hash、OAuth code/token、命令行、注册表 credential、路径和文件内容数量必须为 0。
