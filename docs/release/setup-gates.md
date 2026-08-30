# ToolSpan Setup v0.5.0 验证门禁

本文记录 `SETUP_IMPLEMENTATION_COMPLETE` 的确定性源码门禁，并将真实 Cloudflare、Agent Host 与 ChatGPT UI 证据明确留在外部门禁。`npm run verify:setup` 的 `PASS` 只代表源码阶段；它不会把未执行的真实账号测试升级为 `PASS`。

## 源码完成门禁

`verify:setup` 必须以 `shell: false` 顺序编排以下真实检查，任一步失败都终止并返回非零状态：

```text
Setup 验证器单元测试
Desktop clean install
Setup engine 与本地 Cloudflare mock
Guided Manual / ChatGPT Setup 文档
Prompt Pack 与六个人工 checkpoint
商业链接、affiliate disclosure 与 stale fallback
Vendor asset 验证或 TEXT_ONLY_FALLBACK
Safe Manifest 与 npm pack Setup smoke
Setup 安全边界与 no-secret scan
Setup UI focused test / typecheck / build / i18n / a11y
Rust fmt / check / clippy / test
Core source regression
Desktop source regression
```

`check:vendor-assets` 有两种合法成功结果：已核验资产时为 `PASS`；素材缺失或权利未确认且产品使用纯文字卡片时为 `FALLBACK_PASS`。素材部分存在、hash 不一致，或未授权素材进入发布包时必须失败。

Setup 验证器不调用 `verify:all:source`，子检查也不得回调 `verify:setup`，从而避免递归。Cloudflare 管理 Secret 环境变量在进入任何子进程前按变量名剔除；CI 不注入外部凭证。

## 需求（Requirement）覆盖

以下 21 个 Setup Goal ID 均为 `SETUP_IMPLEMENTATION_COMPLETE` 的 deterministic gate：

```text
S-LOCK-01          S-STATE-01       S-CRED-01         S-TUNNEL-CRED-01
S-CF-MANUAL-01     S-CF-ZONE-01     S-CF-TOKEN-01
S-CF-IDEMP-01      S-CF-ROLLBACK-01 S-CGPT-01         S-AGENT-01
S-DOMAIN-01        S-AFF-01         S-AFF-02          S-ASSET-01
S-URL-01           S-DIAG-01        S-MOCK-01         S-EXTENV-01
S-PACK-01
```

Owner profile 与浏览器 nameserver 边界分别保留为额外 deterministic requirements：`S-OWNER-PROFILE-01`、`S-BROWSER-NS-01`。

## 外部门禁

源码验证默认且真实地报告：

```text
Cloudflare sandbox: EXTERNAL_GATE_PENDING
Host validation: EXTERNAL_GATE_PENDING
```

只有日期化、脱敏的真实 E2E 证据才能改变这些状态。ChatGPT 当前套餐若阻止 Custom MCP/full write，记录 `BLOCKED_BY_HOST_PLAN_OR_POLICY`，不要求购买 Business，也不阻塞 Setup source。Codex real-write E2E 承担发布所需的 write gate。

真实 Cloudflare 测试固定使用 `aiqushi.top` 与首选 `mcp.aiqushi.top`。管理 credential 只由 Owner 在本地受控 UI 输入；不得进入聊天、命令行、日志、Prompt、receipt、诊断、配置或 journal。

## 本轮验证记录

阶段：`SETUP_v0.5`（`SETUP_IMPLEMENTATION_COMPLETE`）。该快照已被 release-gates.md 中的 `2026-08-23 releaseReady 收敛记录` 与 v0.7.0 / v0.7.1 正式 Release 记录收敛取代，当前权威口径以 [release-gates.md](release-gates.md) 为准。

本阶段留下的安全不变量仍有效：

```text
Setup child process shell: false
Secret environment values forwarded to verification children: 0
Management credentials persisted/logged/reported: 0
Safe Manifest fields: exact 12；expected tools: 27
Tunnel runtime credential: only in-memory handoff to official cloudflared service controller
Second-run duplicate creates: 0
Rollback: full owned-only + fingerprint-guarded partial behavior PASS
Renderer-supplied credential accepted by generic desktop invoke: false
Unknown setup/cloudflare protocol methods accepted: 0
Unexecuted external gates reported as PASS: 0
Setup Goal IDs represented: 21/21
CI external credential injection: 0
Exact MCP Tool Contract: 27/27
```

