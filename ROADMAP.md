# ToolSpan 路线图

本路线图说明发展方向，不承诺发布日期或可用性。

## 已完成

### Core 0.3（2026-08 发布线）
- 稳定的无头 MCP server，遵循精确的 27 Tool Contract。
- 确定性 config、OAuth refresh lifecycle、最小公网 health 和 packed-release smoke。
- 双语操作员文档及开源/Release 规范，已通过 Owner legal 和 publication gates。

### Desktop 0.4
- 围绕可独立使用的无头 Core 提供可选的本地桌面控制面。
- 不提供 MCP Client、Agent Runtime、Gateway、任意 Shell 或公网管理界面。

### 连接助手（Connection Assistant 0.5）
- 由 Owner 控制的连接指引，具备安全的 dry-run、reconciliation 和 rollback 行为。
- 真实外部变更仍是 confirmation gates；management credentials 不会持久化。

### Desktop 0.6 · UI v2（现代 tech-blue）
- v2 design system 迁移为唯一产品 UI：十级 primary color scale、OKLCH tokens、4pt 间距、light/dark/system 三主题、1000×650 窗口。
- v2 component library（Tabs/Modal/Toggle/Stepper/EmptyState/CodeBlock/SecretInput 等 16 个组件）；7 导航页 + 7 步 First Run + 系统托盘落地。
- 移除参考实现（React 18）与 HTML prototype；v2 成为唯一产品线。

### Desktop 0.7 · 移除 Global API Key
- 彻底移除 Global API Key（legacy）路径，Cloudflare credential 收敛为单一 `api_token`。
- Setup Center 变为三条路径（Guided Manual / Scoped API Token / Agent-assisted）。

### Desktop 0.7.1 · 托盘设计落地
- 托盘图标按 Core 状态三态切换（running/stopped/attention），菜单启用态绑定状态，左键显示主窗口。

## 进行中 / 展望

- Release 节奏已建立：v0.6.0 / v0.7.0 / v0.7.1 已 tag + GitHub Release（附 SBOM）；后续版本沿用同一闭环。
- 可选外部门禁（不阻塞 releaseReady）：ChatGPT UI 兼容性（E-CGPT-UI-01）尚未完成连接/OAuth/tool scan。
- 若未来重新宣传 Windows one-click cloudflared 或 referral/推广路径、Logo/Banner、OpenAI 数字展示，需先恢复对应 claim active 并补齐 PASS 证据。

## 本产品线不计划提供

- Chat、model hosting、agent planning、memory、MCP federation、multi-device aggregation、automatic account creation、payment 或 domain purchase。

公共仓库、Release 节奏、Maintainer 身份、Sponsor 身份和商业承诺均属于 Owner Gates，本路线图不作承诺。
