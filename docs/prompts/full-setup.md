# Prompt：ToolSpan 完整连接 Setup

目标：从本地 ToolSpan health 开始，完成域名选择、Cloudflare Zone/Tunnel/DNS、official cloudflared、公开 health/OAuth、ChatGPT UI compatibility 与真实 Host 27/27 验证。ToolSpan 仍只是 MCP Server 与 Desktop 控制面；不要开发 MCP Client、Gateway、Agent Runtime 或 Shell。

输入只能是符合 `schemas/setup-safe-manifest.schema.json` 的 Safe Manifest。禁止索取 Cloudflare/registrar/ChatGPT Secret、owner hash、OAuth token/code、真实 DB/config、个人路径或文件内容。不要读取密码管理器、剪贴板历史、DOM secret、截图 secret 或 shell history。不要把 Secret 放进 Prompt、命令行、日志、receipt 或诊断。

执行顺序：local health → domain choice → Zone exists/Active → Dry Run → confirmed Tunnel/ingress/DNS Apply → official cloudflared runtime → public health → OAuth metadata → MCP Inspector → ChatGPT compatibility → Codex real write/job → cleanup/receipt。PLANNED 前副作用为 0；未知冲突停止；second run duplicates=0；rollback created-only/fingerprint-guarded。

<!-- setup-checkpoints:start -->
1. `AFFILIATE_CHOICE` — PAUSE：四个等权选项；披露 commission/coupon attribution；no-referral 无 rid 且不用 coupon。
2. `LOGIN` — PAUSE：用户接管 Cloudflare、registrar、ChatGPT 登录、CAPTCHA、2FA；Agent 不观察/记录。
3. `SECRET_ENTRY` — PAUSE：Scoped Token 或 Legacy Key/email 只在本地 masked field 输入；不持久化、不回显。
4. `CLOUDFLARE_APPLY` — PAUSE：Zone Active 且 Dry Run 已展示后确认；nameserver 最终 Save、UAC、外部写/删也在此确认。
5. `CHATGPT_CREATE_AND_AUTHORIZE` — PAUSE：用户确认 Create/OAuth consent；套餐受限记录 blocker，不购买 Business。
6. `FINAL_VERIFY` — PAUSE：逐项展示真实 local/public/OAuth/27-tools/write/duplicates/rollback evidence 与外部门禁。
<!-- setup-checkpoints:end -->

管理凭证持久化必须为 0；Tunnel runtime credential 只由 official cloudflared mechanism 持有。最终 receipt 只含 session/resource ID、classification、fingerprint、时间、verification 与 rollback status。不能用“预计”“用户说完成”或 mock 结果代替真实外部 PASS。
