# Cloudflare Zone Pending 与 nameserver 接入

Named Tunnel / DNS Apply 的硬前置条件是：目标 Zone 存在且 `zone status = Active`。`aiqushi.top` 缺失、Initializing、Moved、Deleted 或 `Pending Nameserver Update` 时一律执行 `STOP_APPLY`。Quick Tunnel 只能作为临时公网 Smoke，不能替代 Named Tunnel / DNS 的真实 E2E。

## 自动检查（只读）

在任何 Apply 前展示：

1. 当前凭证模式（credential mode：Scoped API Token；不显示值）；
2. `aiqushi.top` 的 zone ID、account ID 与 zone status；
3. Pending 时的 Cloudflare assigned nameservers；
4. `mcp.aiqushi.top` 的现有 DNS 状态；
5. 所有以 `toolspan-` 为前缀的 Tunnel collision；
6. 计划变更（planned changes）：created / reused / updated / untouched。

读不到 Zone 不等于可以创建并继续 Apply。先完成下面的人工 onboarding，再重新读取状态。

## 浏览器辅助接入（Browser-assisted onboarding）

Chrome/computer-use 可以帮助导航，但不能代替人类输入 Secret 或执行最终保存：

1. 打开 Cloudflare Dashboard，确认当前 account；如 Zone 不存在，选择 Add site / Add domain，并且只输入 `aiqushi.top`。
2. 完成 Cloudflare 页面要求的计划或扫描步骤。不要购买额外产品，不修改付款方式。
3. 读取并逐字展示 Cloudflare assigned nameservers。不要从旧 receipt 或其他 Zone 猜测 nameserver。
4. 打开 NameSilo 中 **仅 `aiqushi.top`** 的 nameserver 设置；整个 registrar 辅助流程只操作 `aiqushi.top`。不得接收 NameSilo API credential，不得操作其他域名。
5. 填入本次 Cloudflare 分配的 nameservers；要删除或替换哪些现有值，必须先展示差异。
6. 到 NameSilo 最终 `Save` / `Submit` 按钮前触发 `CLOUDFLARE_APPLY` checkpoint 并暂停，让 Owner 检查域名、旧值、新值和影响后亲自确认。
7. 返回 Cloudflare，先等待其正常检查；若用户明确选择 Re-check，也只触发一次，并尊重 rate limit。
8. 只有 Dashboard/API 实际返回 `Active` 后，才重新生成 Named Tunnel / DNS Dry Run。

## Pending 分支

- assigned nameservers 与 registrar 不一致：展示两组非秘密 NS，回到第 4 步；不得自动保存。
- DNSSEC/DS 可能阻止 delegation：引用 Cloudflare 当前官方排错文档，由用户核对 registrar；不擅自关闭 DNSSEC。
- 已保存但仍 Pending：记录时间和真实状态，等待下一次激活检查；不反复盲目点击 Re-check。
- 账号或 Zone 不匹配：停止并让用户选择正确 account；不在多个 account 中批量搜索或创建。
- 无法访问 registrar：记录 `BLOCKED_BY_OWNER_INPUT` / `EXTERNAL_GATE_PENDING`，其余 Setup source 继续。

## 恢复与安全边界

nameserver 变更可能影响整个 Zone。ToolSpan 不保存 registrar credential，不自动还原 nameserver，也不将页面 DOM、截图、密码管理器、剪贴板历史或 shell history 纳入诊断。若要恢复旧 nameserver，必须由 Owner 根据变更前人工记录决定并执行。

官方状态说明以 `config/cloudflare-api-docs.snapshot.json` 的 dated source 为入口。快照超过 30 天时只显示“查看当前官方文档并重新核验”，不会把旧状态标签当作 Release 当前性证据。
