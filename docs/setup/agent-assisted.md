# Agent 辅助 Setup 与 Safe Manifest

Agent 辅助路径只把 `schemas/setup-safe-manifest.schema.json` 允许的非秘密字段交给 Agent。Safe Manifest 的根字段必须且只能是：

```text
schemaVersion
toolSpanVersion
instanceName
localUrl
desiredHostname
publicMcpUrl
oauthDiscoveryUrl
expectedToolCount
tunnelName
domainChoice
officialDocs
generatedAt
```

禁止加入 Cloudflare Token/Key、Tunnel 运行凭证（runtime credential）、Owner password/hash、OAuth token/code、email、真实 config/state DB、任意文件内容、不必要的个人路径、浏览器 DOM、截图或 shell history。`expectedToolCount` 固定为 27；`localUrl` 只能是 loopback；公网 URL 必须是同一目标 hostname 的 HTTPS URL。

`schemaVersion` 固定为 `1.0`。`domainChoice` 只允许 `existing`、`other_registrar`、`namesilo_no_referral`（referral 路径已移除）；Setup session/snapshot 自身的 `setupProtocolVersion` 不得复制进 Safe Manifest。

## 六个强制 checkpoint（检查点）

每个 `docs/prompts/*.md` 都按以下顺序声明 checkpoint。即使某个动作对当前 prompt 不适用，也要显式标为 `NOT_APPLICABLE`，不能静默跳过：

1. `AFFILIATE_CHOICE` — 由用户选择已有域名、任意 registrar 或 no-referral；不存在 referral 路径；Agent 不预选、不打开链接、不使用 coupon。
2. `LOGIN` — 登录、CAPTCHA 与 2FA 由用户接管；Agent 不读取密码管理器、剪贴板历史或 DOM secret。
3. `SECRET_ENTRY` — 用户在本地 masked field 输入 Secret；Agent 不读取、截图、回显、复制或将其放入命令行。
4. `CLOUDFLARE_APPLY` — 先展示 Dry Run；在创建、更新、删除、nameserver 最终 Save 和 UAC 前暂停并等待确认。
5. `CHATGPT_CREATE_AND_AUTHORIZE` — 在创建连接和 OAuth consent 前暂停；套餐不支持时记录 blocker。
6. `FINAL_VERIFY` — 展示真实证据与 blocker；用户确认不等于自动变为 `VALIDATED`。

## Agent 行为约束

- 先只读检查本地健康状态（local health）、Zone status、现有 DNS/Tunnel collision 和 manifest schema。
- Zone 缺失/Pending 时停止 Named Tunnel/DNS Apply；浏览器辅助只操作 `aiqushi.top`，到 NameSilo nameserver 最终 Save 前暂停。
- 不购买域名、不改支付、不操作其他域名、不自动授权 OAuth。
- 不收集 Secret；发现 Secret 出现在页面、日志或输出中时停止 capture，只报告已 redacted 的分类。
- 不执行任意 Shell、不开发 MCP Client/Gateway/Agent Runtime，不改变 exact 27 tools。
- 写入只发生在用户确认的 synthetic e2e workspace；先调用 `devspace_info` 确认 instance 和 root。

模板见 `docs/prompts/`。Safe Manifest 示例仅用于 schema smoke，不能当作真实外部 E2E evidence。
