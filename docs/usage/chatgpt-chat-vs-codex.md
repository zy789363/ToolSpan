# ChatGPT Chat、MCP 与 Codex 用量

<!-- openai-plan-usage-keys: chat.go,chat.plus,chat.pro5x,chat.pro20x,chat.business,codex.plus,codex.pro5x,codex.pro20x,codex.business,mcp.plus,mcp.pro,mcp.business,mcp.enterpriseEdu -->

快照来源：[`config/openai-plan-usage.snapshot.json`](../../config/openai-plan-usage.snapshot.json)

## 中文

这些是不同的产品，也采用不同的计量单位。ChatGPT Chat 消息不等于 MCP Tool Call，两者也都不等于 Codex message/task。ToolSpan 不会在这些额度之间做换算，也不声明固定兑换比例。

| 界面 | 计量单位 | ToolSpan 可安全展示的内容 |
| --- | --- | --- |
| ChatGPT Chat | 当前套餐定义的窗口内消息数 | 快照仍在有效期内时的时间点数据 |
| MCP | Tool Call 与 Host 策略判定 | 当前 Host 实测结果与官方来源说明的可用性 |
| Codex | 官方窗口内的本地消息或任务 | 官方公布的范围，不是对单个任务的承诺 |

运行确定性的中文视图生成器：

```bash
node scripts/check-openai-plan-usage.mjs --render=zh
```

脚本根据 `verifiedAt` 计算快照年龄，并要求官方来源完整覆盖每项展示声明。超过 30 天，或当前官方来源无法证明全部声明时，状态变为 `STALE_FALLBACK`，并把具体数量替换为“查看当前官方限制”。普通检查不会联网，fallback 也不是 Core 源码失败；事实与覆盖范围的刷新属于 Release Gate。

不要把聊天界面中的“无限”标签理解成 API、MCP 或 Codex 工作不受限制。防滥用规则、Host 策略、Workspace 策略、模型选择、任务规模和预览功能状态都可能影响实测结果。

## English（英文说明）

These are different products and different accounting units. A ChatGPT Chat message is not an MCP tool call, and neither is a Codex message or task. ToolSpan cannot convert one allowance into another and does not claim a fixed exchange rate.

| Surface | Counted unit | What ToolSpan can safely show |
| --- | --- | --- |
| ChatGPT Chat | Messages in the window defined by the current plan | A point-in-time snapshot while it is current |
| MCP | Tool calls and host policy decisions | Availability as reported by the current host and official source |
| Codex | Local messages or tasks in the published window | A published range, not a promise for a particular task |

Run the deterministic renderer for the point-in-time view:

```bash
node scripts/check-openai-plan-usage.mjs --render=en
```

The renderer calculates age from `verifiedAt` and also requires complete official-source coverage. At more than 30 days, or whenever current official sources do not establish every displayed claim, it returns `STALE_FALLBACK` and replaces specific quantities with “See current official limits.” The ordinary check performs no network request and a fallback snapshot is not a Core source-code failure. Refreshing the facts and coverage is a Release gate.

Do not infer that an “unlimited” chat label means unmetered API, MCP, or Codex work. Guardrails, host policy, workspace policy, model choice, task size, and preview availability may all change the observed result.

## 快照来源

检查脚本只接受获准 OpenAI 域名上的 HTTPS URL，并验证中英文视图使用相同的快照键。普通 CI 不会抓取这些页面。

The checker accepts only HTTPS URLs on the approved OpenAI domains and verifies that both language views use the same snapshot keys. Ordinary CI never fetches these pages.

- Chat pricing / Chat 套餐：<https://learn.chatgpt.com/docs/pricing>
- GPT-5.5 limits / GPT-5.5 限制：<https://learn.chatgpt.com/docs/pricing>
- GPT-5.6 limits / GPT-5.6 限制：<https://learn.chatgpt.com/docs/pricing>
- Codex pricing / Codex 定价：<https://learn.chatgpt.com/docs/pricing>
- Codex rate card / Codex 费率表：<https://learn.chatgpt.com/docs/pricing>
- Business Chat rate card / Business Chat 费率表：<https://learn.chatgpt.com/docs/pricing>
- MCP availability / MCP 可用性：<https://developers.openai.com/plugins/deploy/connect-chatgpt>
