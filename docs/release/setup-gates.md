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

Setup verifier 不调用 `verify:all:source`，子检查也不得回调 `verify:setup`，从而避免递归。Cloudflare 管理 Secret 环境变量在进入任何子进程前按变量名剔除；CI 不注入外部凭证。

## Requirement 覆盖

以下 21 个 Setup Goal ID 均为 `SETUP_IMPLEMENTATION_COMPLETE` 的 deterministic gate：

```text
S-LOCK-01          S-STATE-01       S-CRED-01         S-TUNNEL-CRED-01
S-CF-MANUAL-01     S-CF-ZONE-01     S-CF-TOKEN-01     S-CF-GLOBAL-01
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

Stage: `SETUP_v0.5`

Status: `SETUP_IMPLEMENTATION_COMPLETE`

Commit / working tree: 当前交付目录不含 `.git` 元数据；无法取得可信 commit、status 或 diff。未执行 reset、clean、tag、release 或自动提交。

Requirements passed:

```text
S-LOCK-01          S-STATE-01       S-CRED-01         S-TUNNEL-CRED-01
S-CF-MANUAL-01     S-CF-ZONE-01     S-CF-TOKEN-01     S-CF-GLOBAL-01
S-CF-IDEMP-01      S-CF-ROLLBACK-01 S-CGPT-01         S-AGENT-01
S-DOMAIN-01        S-AFF-01         S-AFF-02          S-ASSET-01
S-URL-01           S-DIAG-01        S-MOCK-01         S-EXTENV-01
S-PACK-01          S-OWNER-PROFILE-01                  S-BROWSER-NS-01
```

Commands actually run:

```text
Node used for final gate                              v24.19.0
npm run verify:setup                                  PASS（22 checks；SETUP_IMPLEMENTATION_COMPLETE）
node --test scripts/tests/setup-verification.test.mjs PASS（9/9）
npm run setup:test                                    PASS（4 files / 61 tests）
npm run check:setup-docs                              PASS（10 documents / 9 manual steps）
npm run check:setup-prompts                           PASS（5 prompts / 6 checkpoints each）
npm run check:commercial-links                        PASS（CURRENT snapshot projection）
node scripts/check-commercial-links.mjs --now=2026-09-21
                                                       PASS（offer/guide/docs stale fallback）
npm run check:affiliate-disclosure                    PASS（direct rid=0 / telemetry=0）
npm run check:vendor-assets                           FALLBACK_PASS（TEXT_ONLY_FALLBACK）
npm run smoke:setup-manifest                          PASS（81 files / 24 required / secret-like 0）
npm run check:setup:security                          PASS（persisted credential 0 / secret value 0）
npm --prefix apps/desktop run test -- tests/components/setup-page.test.tsx
                                                       PASS（10/10）
npm --prefix apps/desktop run typecheck               PASS
npm --prefix apps/desktop run build                   PASS
npm --prefix apps/desktop run check:i18n              PASS（3/3）
npm --prefix apps/desktop run test:a11y               PASS（9/9）
cargo fmt/check/clippy/test（通过 VS Developer PowerShell）
                                                       PASS（Rust 40/40）
npm run verify:core                                   PASS（24 files / 154 tests；27/27 tools）
npm run verify:desktop:source                         PASS（15 checks；Renderer 31/31）
npm run smoke:core-release                            PASS（81 packaged files）
npm run goal:check                                    PASS（64 requirements / 55 deterministic）
npm run check:ci                                      PASS（Setup Ubuntu/Windows jobs；Secret injection 0）
git status --short                                    BLOCKED_BY_ENVIRONMENT（源码快照无 .git）
git diff --check                                      BLOCKED_BY_ENVIRONMENT（源码快照无 .git）
```

Mock scenarios passed: `61/61` Setup tests；`setup-engine.test.ts` 包含 36 个显式场景声明，超过 root verifier 的 23 场景最低证据门槛。覆盖 active-zone gate、pagination、Cloudflare error envelope、429/Retry-After、create 不盲重放、same-name/DNS conflict、idempotency、crash/reentry、full/partial rollback、redaction 与 external blocker 语义。

Regressions fixed:

- Windows 下 `tests/setup*.test.ts` 不会由 `shell: false` 展开；根 `setup:test` 改为 Vitest 的稳定 `setup` filter，并由验证器拒绝 shell glob。
- Rust/Tauri `check` 依赖打包的 `dist/desktop-host/main.js`；`verify:setup` 现在先显式构建 Core/Desktop Host，再运行 Rust gates。
- v0.5 Protocol 安全检查精确允许 7 个冻结 `setup.*` method；管理 credential 仅可作为 preflight/apply/rollback/reconcile 的可选 Rust→Host 注入，其他 request/response/event/snapshot/manifest/journal/receipt/log 或未知 secret field 均失败。
- Setup loading/error 状态现在稳定呈现页面标题，消除 Desktop 全导航 integration regression；Renderer full suite 复跑通过。
- `setup.discardCredential` 只清理 session credential，不删除非秘密 plan/receipt；credential re-entry 状态由 focused tests 覆盖。

Environment capabilities:

```text
CORE_CAPABLE: true（Node v24.19.0）
DESKTOP_SOURCE_CAPABLE: true
SETUP_MOCK_CAPABLE: true
WINDOWS_PACKAGE_CAPABLE: true
Rust / Cargo / rustfmt / clippy: available（1.94.1）
Visual Studio 2022 Developer PowerShell: available
Windows x64 / WebView2: available
```

Environment blockers:

- 默认 PATH Node 是 `v22.16.0`，低于 `>=22.17.0`；终局阶段验证显式使用现有 bundled Node `v24.19.0`，未修改系统 Node。
- 当前源码快照无 `.git` 元数据，因此 Git status/diff 证据是 `BLOCKED_BY_ENVIRONMENT`，不是源码 PASS。
- Vite 生产 bundle 约 610 kB，输出非阻塞 chunk-size warning；构建、功能和 a11y 门禁均通过。

External gates:

```text
Cloudflare sandbox: EXTERNAL_GATE_PENDING
Host validation: EXTERNAL_GATE_PENDING
ChatGPT UI compatibility: EXTERNAL_GATE_PENDING
Vendor asset currentness/rights: EXTERNAL_GATE_PENDING（TEXT_ONLY_FALLBACK active）
```

Owner inputs still needed:

- 在 ToolSpan Desktop masked credential UI 本地输入 Cloudflare credential，再对 `aiqushi.top` / `mcp.aiqushi.top` 执行真实 preflight、Dry Run、人工确认、Apply、二次幂等与 owned-only cleanup；Secret 不进入聊天或命令行。
- 用当前 ChatGPT 账号执行 UI compatibility smoke；套餐阻止时记录 `BLOCKED_BY_HOST_PLAN_OR_POLICY`，不购买 Business。
- 由 Codex 在 synthetic workspace 完成真实 read/write/job Host gate。
- Release 前重新核验 NameSilo/ChatGPT/Cloudflare snapshot currentness，并完成许可证、仓库、维护者联系方式与发布授权 Owner gates。

Security invariants checked:

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

NameSilo offer: `CURRENT`（仅指 `verifiedAt: 2026-08-20` 的 owner-provided snapshot 仍在 30 天窗口；Release currentness 尚未外部复核）。

ChatGPT guide: `CURRENT`（同样是 dated snapshot）；`2026-09-21` 模拟已证明 `STALE_GUIDE_FALLBACK` 会隐藏旧 UI path。

Next stage: `RELEASE / NATIVE / EXTERNAL VALIDATION`

Exact next command: `npm run goal:preflight`
