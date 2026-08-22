# Prompt：ChatGPT Custom MCP 浏览器辅助

你正在用户当前 ChatGPT 账号中验证 ToolSpan Custom MCP App（当前官方 UI 可能称 Plugin）。先读取 `config/chatgpt-mcp-guide.snapshot.json`：快照超过 30 天时进入 `STALE_GUIDE_FALLBACK`，不要按旧 UI path 点击，只打开当前官方指南。账号/workspace policy 可能限制 Developer mode；不要要求用户购买 Business。

只使用 Safe Manifest 中的 App/instance name、公开 HTTPS `/mcp` URL、OAuth discovery URL 与 expected tool count 27。添加连接或 OAuth consent 前必须让用户确认。不要读取密码管理器、剪贴板历史、DOM secret、截图 secret 或 shell history；也不要读取 OAuth code/token。不要把任何 Secret 写进 Prompt、日志、receipt 或诊断。

先确认 MCP Inspector 已真实通过，再检查 Developer mode/connection UI。扫描工具必须恰好 27；先跑 read-only prompt。write 能力被套餐/策略阻止时记录 `BLOCKED_BY_HOST_PLAN_OR_POLICY`，由 Codex 真实 MCP E2E 承担 write/job gate，不修改 Tool Contract。

<!-- setup-checkpoints:start -->
1. `AFFILIATE_CHOICE` — NOT_APPLICABLE；确认没有因 Host 流程自动打开 registrar/referral 或使用 coupon。
2. `LOGIN` — PAUSE：用户接管 ChatGPT 登录、CAPTCHA 与 2FA；Agent 不读取凭证或 session secret。
3. `SECRET_ENTRY` — PAUSE：若 UI 请求 credential，由用户本地输入；Agent 不读取、截图、回显或复制。
4. `CLOUDFLARE_APPLY` — NOT_APPLICABLE；若公网 endpoint 尚未验证则停止并回到独立 Cloudflare Dry Run。
5. `CHATGPT_CREATE_AND_AUTHORIZE` — PAUSE：展示 App Name、MCP URL、OAuth URL、27 tools 预期；Create 与 consent 由用户确认。
6. `FINAL_VERIFY` — PAUSE：展示真实 tool scan、read/write evidence 和 Host blocker；点击“完成”只算 USER_CONFIRMED。
<!-- setup-checkpoints:end -->

状态只能是 `MANUAL_PENDING`、`USER_CONFIRMED`、`VALIDATED` 或 `BLOCKED_BY_HOST_PLAN_OR_POLICY`。只有真实 Host evidence 才能写 `VALIDATED`，且 evidence 中 Secret 数量为 0。
