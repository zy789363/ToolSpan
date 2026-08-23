# Prompt：Cloudflare 浏览器辅助

你正在帮助用户把 ToolSpan 的公开 MCP endpoint 配置到 Cloudflare。只能使用符合 `schemas/setup-safe-manifest.schema.json` 的 Safe Manifest；不要请求或读取 config/state DB。目标固定为 manifest 中的域名，本次 Owner profile 只允许 `aiqushi.top` 与 `mcp.aiqushi.top`。

先做只读检查：确认 account、Zone ID/status、Cloudflare assigned nameservers、现有 `mcp.aiqushi.top` DNS、`toolspan-` Tunnel collision 与 planned changes。只有 Zone 实际为 `Active` 才能提出 Named Tunnel/DNS Apply。Zone 缺失或 Pending 时进入 Cloudflare Add site 与 registrar nameserver onboarding；只操作 `aiqushi.top`，到 NameSilo 最终 Save 前暂停。不得购买域名、改支付信息或操作其他域名。

Scoped API Token 为推荐模式。到 credential field 时让用户本地输入。不要读取密码管理器、剪贴板历史、DOM secret、截图 secret 或 shell history；不要把 Secret 放进聊天、Prompt、命令行、日志、receipt 或诊断。

Dry Run 必须列出 created/reused/updated/untouched、冲突、rollback precondition 和第二次运行 duplicates=0 的预期。未知 Tunnel/DNS 一律停止，不覆盖。运行凭证只交给官方 cloudflared 机制。

<!-- setup-checkpoints:start -->
1. `AFFILIATE_CHOICE` — PAUSE：让用户选择已有域名、任意 registrar 或 NameSilo no-referral；不预选、不打开、不用券。
2. `LOGIN` — PAUSE：用户接管 Cloudflare/registrar 登录、CAPTCHA 与 2FA；Agent 不观察或记录凭证。
3. `SECRET_ENTRY` — PAUSE：用户在本地 masked field 输入 credential；Agent 不读取、截图、回显或复制。
4. `CLOUDFLARE_APPLY` — PAUSE：展示 Dry Run；Tunnel/DNS Apply、NameSilo 最终 Save、UAC、rotate/revoke 前由用户确认。
5. `CHATGPT_CREATE_AND_AUTHORIZE` — NOT_APPLICABLE，除非用户另行进入 ChatGPT；不得静默跳过该状态。
6. `FINAL_VERIFY` — PAUSE：展示真实 Zone/public/OAuth/27-tools evidence 与 blocker；不得把用户确认当作自动 PASS。
<!-- setup-checkpoints:end -->

最终只输出非秘密 evidence：目标 account/zone/tunnel/DNS ID、状态、时间、created/reused/updated/untouched、rollback 状态和 blocker 分类。任何 credential 数量必须为 0。
