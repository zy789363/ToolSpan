# ToolSpan 发布（Release）自动门禁

本文记录发布（Release）阶段的自动装配边界和 `04_RELEASE_AND_EXTERNAL_GATES.md` 外部门禁。源码自动检查只能证明确定性结果；没有日期化、脱敏的真实证据时，Windows、Host、Cloudflare、GitHub 和 Owner 门禁不得成为 `PASS`。

## 自动命令

根 `package.json` 已声明以下命令：

```text
npm run verify:all:source
npm run check:test-environment
npm run release:dry-run
npm run verify:release
```

`verify:all:source` 通过解析后的 `npm-cli.js` 和 `shell: false` 顺序执行 `goal:check`、`verify:core`、`verify:desktop:source`、`verify:setup`。四个子项都不能调用 `verify:all:source`，因此不会递归。

`check:test-environment` 验证 `.toolspan-dev/test-environment.json` 的 schema v2 闭集。该文件只允许能力标志（capability flag）、Cloudflare Zone/Account ID、固定目标、状态枚举和 Secret 环境变量名；Secret value 数量必须为 0。当前 Owner profile 固定为 `aiqushi.top`、`mcp.aiqushi.top`、Chrome/computer-use 已授权、不要求 ChatGPT Business，并由 Codex 承担 write E2E。检查器不读取、更不输出所引用环境变量的 value。

`release:dry-run` 只执行 Core 构建、Desktop Renderer 构建、`npm pack --ignore-scripts`、Cargo metadata 和本地装配。命令中没有 `npm publish`、`npm version`、Git tag 或 Release API。持久证据只写入已忽略的 `.toolspan-dev/evidence/release/run-*/`：

```text
artifact-manifest.json
desktop-bundles.manifest.json
release-scan.json
checksums.sha256
sbom.spdx.json
sbom.cyclonedx.json
package/*.tgz
desktop-native/*                 # 仅复制当前版本的既有 native bundle
```

SBOM 从根 `package-lock.json`、Desktop 独立 `package-lock.json` 和 `cargo metadata --locked --offline --filter-platform x86_64-pc-windows-msvc` 生成，并记录 Cargo lock/manifest 输入 hash。证据不记录 Cargo 的本地 `manifest_path`。npm 包内容、生成的 manifest 与 SBOM 会执行 Secret-like value 和个人绝对路径扫描；报告只写 finding code 和相对文件名，不写命中内容。

旧版本 native bundle 会列入 `staleNativeArtifactsExcluded`，不会复制进当前 dry-run。即使存在当前版本 bundle，dry-run 也只报告 `ASSEMBLED_NOT_NATIVE_VALIDATED`；只有安装、托盘和 owned-process smoke 的日期化证据才能让 Windows 门禁（gate）成为 `PASS`。

## 04 门禁矩阵（2026-08-22 当前状态）

| ID | 必需性 | 当前状态 |
|---|---|---|
| `E-OWNER-01` | Release 必需 | `PASS`；Owner 已批准发布（publication）、IP、商标（trademark）和 Apache-2.0，闭集 proof 已验证 |
| `E-GH-01` | Release 必需 | `PASS`；公开默认分支、security policy、active ruleset、branch protection 与 private reporting 已通过远端读取验证 |
| `E-WIN-01` | Windows Release 必需 | `PASS`；Owner 手工 Tray smoke 与既有安装/生命周期/进程 evidence 已绑定当前 MSI/NSIS hash |
| `E-SIGN-01` | 可选未签名（unsigned） | `NOT_CONFIGURED` |
| `E-CF-TOKEN-01` | Cloudflare 一键声明（one-click Cloudflare claim）前必需 | `PASS`；scoped-token API 生命周期、public HTTPS/OAuth/exact27 与仅限自有资源清理（owned cleanup）的闭集证据已验证 |
| `E-CF-WIN-01` | Windows 一键声明（one-click claim）前必需 | `BLOCKED_BY_ENVIRONMENT`；源码工具链已就绪（`scripts/cloudflared-service-lifecycle.ps1` + `uninstall-cloudflared-service.ps1` + 静态测试 + `docs/release/windows-cloudflared-service-validation.md`）。2026-08-23 Owner 决定跳过真实管理员 VM 验证，同时将 `WINDOWS_ONE_CLICK_VALIDATED` claim 置为 `inactive`（basis=`WINDOWS_SETUP_USES_MANUAL_CLOUDFLARED_ONLY`）——Desktop 实际使用手动 cloudflared adapter，不承诺自动安装 Windows service，因此本 gate 不再阻塞 `RELEASE_READY`；若未来重新宣传 Windows one-click cloudflared，必须先恢复 claim active 并补齐验证 |
| `E-HOST-01` | Release 必需 | `PASS`；Inspector 2.3.0 OAuth/exact 27/read/write/job/read-only rejection 闭集证据已验证 |
| `E-CODEX-01` | Release 必需 | `PASS`；真实 Codex 远程 OAuth/exact 27/read/write/job/hash isolation/cleanup proof 已验证 |
| `E-CGPT-UI-01` | 非 Release 必需 | `EXTERNAL_GATE_PENDING`（UI capability 已观察；连接/OAuth/tool scan 未完成） |
| `E-OAUTH-SOAK-01` | 非 Release 必需 | `NOT_REQUIRED` |
| `E-AFF-01` | 商业 CTA 前必需 | `STALE_FALLBACK`；2026-08-23 referral CTA 已完整移除，`COMMERCIAL_CTA_CURRENT` claim 置为 `inactive`（basis=`REFERRAL_CTA_REMOVED`），E-AFF-01 不再阻塞 `RELEASE_READY`；若未来重新引入 referral/推广路径，必须先恢复 claim active 并补齐当前性验证 |
| `E-ASSET-01` | Logo/Banner 前必需 | `TEXT_ONLY_FALLBACK` |
| `E-DATA-01` | OpenAI 数字展示前必需 | `STALE_FALLBACK`；官方来源覆盖不完整，具体数字与 MCP plan matrix 已隐藏 |

### 当前声明策略（Active claim policy）

条件门禁（conditional gate）不能仅因 `blockingFor` 使用条件名称就被 readiness 计算忽略。当前产品声明由 `RELEASE_CLAIM_POLICY` 显式冻结：

```text
ONE_CLICK_CLOUDFLARE_CLAIM     active
WINDOWS_ONE_CLICK_CLAIM        inactive（WINDOWS_SETUP_USES_MANUAL_CLOUDFLARED_ONLY；2026-08-23 Owner 跳过 admin VM 验证后停用）
COMMERCIAL_CTA                 inactive（REFERRAL_CTA_REMOVED；2026-08-23 移除 referral 路径后停用）
NUMERIC_OPENAI_QUOTA_CLAIM     inactive（OFFICIAL_SOURCE_COVERAGE_INCOMPLETE_STALE_FALLBACK）
LOGO_OR_BANNER                 inactive（TEXT_ONLY_FALLBACK active）
```

`RELEASE_READY` 要求 `requiredPending` 与 `activeConditionalPending` 同时为空。未知 claim policy 也按 active 保守处理。`E-CF-WIN-01=BLOCKED_BY_ENVIRONMENT`、`E-AFF-01=STALE_FALLBACK`、`E-ASSET-01=TEXT_ONLY_FALLBACK` 与 `E-DATA-01=STALE_FALLBACK` 会进入 `inactiveConditionalFallbacks`，不会阻塞；一旦产品重新宣传 Windows one-click cloudflared、referral/推广路径、Logo/Banner 或显示 OpenAI 数字/MCP plan matrix，必须先恢复对应 active policy 并提供 `PASS` 证据。

手工证据只从 `.toolspan-dev/evidence/external/<Requirement-ID>.json` 读取。非 `PASS` 使用六字段闭集 envelope：`schemaVersion`、`requirementId`、`status`、`observedAt`、`sanitized`、`secretValues`。`PASS` 必须额外包含 gate-specific 闭集 `proof`；Windows/签名/cloudflared 绑定当前 dry-run 的版本与 MSI/NSIS SHA-256，Codex/Inspector/Cloudflare 分别验证远端隔离、完整协议序列或完整资源生命周期。14 个 gate 均有冻结时效，未来、过期、空壳和旧 artifact evidence 一律回退，`externalGatesPromotedWithoutEvidence` 由真实矩阵计算。该机制仍不替代真实操作与人工审查。

`verify:release` 先执行 test-environment、全部源码阶段和 dry-run，再评估上述矩阵（matrix）。自动部分全绿但必需或 active conditional 外部门禁未完成时，结果必须是 `EXTERNAL_GATE_PENDING` 和非零退出码；这不是源码回归，也不得改写为 `RELEASE_READY`。

## 安全与发布边界

  - exact 27 Tool Contract、`shell: false`、allowed roots、OAuth scope、Host/Origin 和 runner allowlist 不变。
- 不实现 MCP Client、Gateway、Agent Runtime 或任意 Shell。
- Cloudflare Secret 只通过本地受控输入或环境变量引用；不会进入子进程、命令行、日志、Prompt、receipt、诊断、manifest 或 SBOM。
- `release:dry-run` 不 tag、不 publish、不调用外部账号，也不修改 `.toolspan-dev/goal-state.json`。
- Maintainer 只有在必需的真实 gate 和 Owner publication approval 都有证据后，才能显式执行正式 tag/Release。

## 2026-08-22 当前权威验证记录

阶段：`RELEASE_GATES`（已被 2026-08-23 releaseReady 收敛及 v0.6.0 / v0.7.0 / v0.7.1 正式 Release 取代；以下保留当时的门禁证明指针，详细执行命令与 hash 见对应 release 证据文件）。

当时 `verify:release` 的外部门禁最终矩阵为：

```text
E-OWNER-01      PASS                    proofValidated=true
E-GH-01         PASS                    proofValidated=true
E-WIN-01        PASS                    proofValidated=true
E-SIGN-01       NOT_CONFIGURED          proofValidated=false
E-CF-TOKEN-01   PASS                    proofValidated=true
E-CF-WIN-01     BLOCKED_BY_ENVIRONMENT  proofValidated=false
E-HOST-01       PASS                    proofValidated=true
E-CODEX-01      PASS                    proofValidated=true
E-CGPT-UI-01    EXTERNAL_GATE_PENDING   proofValidated=false
E-OAUTH-SOAK-01 NOT_REQUIRED            proofValidated=false
E-AFF-01        STALE_FALLBACK          proofValidated=false（2026-08-23 已随 referral CTA 移除转为 inactive claim，见下文）
E-ASSET-01      TEXT_ONLY_FALLBACK      proofValidated=false
E-DATA-01       STALE_FALLBACK          proofValidated=false
```

当时闭集证据指针（仅供历史回溯，最新权威以 `.toolspan-dev/evidence/release/latest-verification.json` 为准）：

- `E-OWNER-01` / `E-GH-01` / `E-WIN-01` / `E-CF-TOKEN-01` / `E-HOST-01` / `E-CODEX-01`：`.toolspan-dev/evidence/external/E-*-01.json`
- Cloudflare API lifecycle / public e2e：`.toolspan-dev/evidence/cloudflare-e2e-20260822-cc6cd8b988.json`、`cloudflare-public-e2e-20260822-cc6cd8b988.json`
- Codex remote e2e：`.toolspan-dev/evidence/codex-remote-e2e-202608221403547af16438e2.json`
- Windows tray manual：`.toolspan-dev/evidence/windows-tray-manual-20260822T130308Z.json`
- Freshness / Namesilo / OpenAI data：`.toolspan-dev/evidence/namesilo-currentness-20260822T063449Z.json`、`openai-data-currentness-20260822T055319Z.json`

当时已检查的安全不变量（仍有效）：

```text
exact MCP Tool Contract                    27/27
Release child process shell                false
external gates promoted without evidence  0
tag / publish side effects                 0
MCP Client / Gateway / Agent Runtime / Shell added  0
```

Owner 于 2026-08-22 批准采用 Apache License 2.0（`LICENSE` 规范化 SHA-256 `58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd`，npm 元数据均为 SPDX ID `Apache-2.0`）；仓库 `zy789363/ToolSpan` 已转为 PUBLIC，默认分支 `main`、branch protection 启用 linear history 并禁止 force push/deletion、`Protect main` ruleset 为 `active`、private vulnerability reporting 返回 `enabled=true`。未创建 tag 或 Release（后续 tag/Release 见下文）。

## 2026-08-23 releaseReady 收敛记录

阶段：`RELEASE_GATES` → `RELEASE_READY`（自动门禁收敛，正式 tag/Release 仍待 Maintainer）

状态：`verify:release` 输出 `PASS / releaseReady=true / exit 0`。

收敛过程（本机）：

1. 修复本地环境缺口：本机 PATH 缺少 ripgrep，Core files 测试 `spawn rg ENOENT`。将官方 ripgrep 15.0.0（经 `@vscode/ripgrep-win32-x64` 获取，SHA 校验后）放入已忽略的 `.toolspan-dev/bin/rg.exe` 并复制至 PATH 内 node 目录；files 测试 12/12 PASS。CI 环境无此问题（workflow 已安装 ripgrep）。
2. 重新构建后的 native artifact（MSI `3868cbbc…`、NSIS `22cd1b95…`）使旧 E-WIN-01 证据 hash 绑定失效。对当前 artifact 重新执行 Windows native smoke：
   - NSIS per-user 安装存在（`C:\Users\86799\AppData\Local\ToolSpan`，含 desktop-host bundle 与 uninstaller）；
   - 启动 smoke：窗口 Title=`ToolSpan`、Responding=true；
   - owned child（msedgewebview2 + node Desktop Host）在退出后清理为 0；
   - 无关 node 进程在 ToolSpan 生命周期前后保持存活（隔离有效）；
   - Owner 手工托盘确认：托盘图标、右键菜单（Show/Start/Restart/Stop/Copy MCP URL/Open logs/Quit）、Quit 确认框均出现，确认后干净退出。
   - 证据：`.toolspan-dev/evidence/windows-native-smoke-20260823T105236Z.json`，`E-WIN-01.json` 已更新为当前 hash 绑定的 `PASS`（observedAt 2026-08-23T10:55:36Z，7 天时效窗口内）。
3. `npm run verify:release`（CI=true）最终：deterministic gates 全 PASS（goal:check / core / desktop / setup）、dry-run PASS（83 package files、SBOM 764 组件、secret/personal-path findings 0）、`requiredPending=[]`、`activeConditionalPending=[]`、`externalGatesPromotedWithoutEvidence=0`。evidence：`.toolspan-dev/evidence/release/release-verification-20260823T110143089Z.json`。
4. `.toolspan-dev/goal-state.json` 已收敛：`stages.release.status=PASS`、`environment.releaseReady=true`、`windowsLastBuiltMsiSha256/NsisSha256` 更新为当前 hash、`windowsNativeSmokeCurrentArtifactVerified=true`、blockers 清空。`goal:check` errors 0、`goal-status` VALID。

剩余项（不阻塞 `RELEASE_READY`）：

- 可选外部验证：`E-CGPT-UI-01`（ChatGPT UI Smoke，connection/OAuth/tool scan 未完成）。

---

## 2026-08-23 · v0.6.0 正式 Release 记录（tag + GitHub Release + 安装包实装 smoke）

背景：v2 UI 迁移落地完成（plan electric-forging-lovelace），产品版本 0.5.0 → 0.6.0，安装包重构建（MSI `55878074…`、NSIS `335b6a67…`）。

1. **安装包实装 smoke（E-WIN-01 重新验证，绑定 0.6.0 新 hash）**：
   - 卸载旧 0.5.0（NSIS per-user `/S`）→ 目录与 HKCU 卸载注册表清空；
   - 安装 0.6.0（`ToolSpan_0.6.0_x64-setup.exe /S /currentuser`）→ `DisplayVersion=0.6.0`、exe 存在于 `C:\Users\86799\AppData\Local\ToolSpan`；
   - 启动 smoke：窗口 `Title=ToolSpan`、`MainWindowHandle` 有效、`Responding=True`；
   - owned child 验证：`msedgewebview2.exe --webview-exe-version=0.6.0` + `node ...\ToolSpan\desktop-host\main.js`（Desktop Host 从安装目录运行）；
   - Owner 手工托盘确认：图标/菜单/Quit 确认框正常，确认后干净退出；
   - 退出后复查：toolspan-desktop / owned webview / desktop-host 均无残留（排除 pwsh 自匹配误报后）。
   - 证据：`.toolspan-dev/evidence/windows-native-smoke-20260823T153617Z.json`；`E-WIN-01.json` 更新为 0.6.0 hash 绑定 PASS（observedAt 2026-08-23T15:36:17Z）。
2. **`npm run verify:release`（CI=true）**：dry-run PASS（83 package files、SBOM 764 组件、secret/personal-path findings 0）、`releaseReady=true`、`requiredPending=[]`、`tagCreated=false`、`published=false`。evidence：`.toolspan-dev/evidence/release/release-verification-20260823T154242461Z.json`。版本连锁同步：`npm-shrinkwrap.json`（package-runtime-policy 测试）、desktop-verification 断言、protocol fixture、setup-service 运行时版本正则、schemas pattern、setup-engine/desktop-setup-service fixtures、docs。
3. **`.toolspan-dev/goal-state.json`**：`windowsLastBuiltMsiSha256=55878074…`、`windowsLastBuiltNsisSha256=335b6a67…` 更新；`goal:check` errors 0。
4. **正式 tag + GitHub Release 已执行**：
   - `git tag v0.6.0`（指向 `49062eb`）已推送 origin；
   - `gh release create v0.6.0`（publishedAt 2026-08-23T15:51:00Z，非 draft）→ https://github.com/zy789363/ToolSpan/releases/tag/v0.6.0；
   - 资产 6 项：MSI、NSIS setup、`toolspan-mcp-0.6.0.tgz`、SPDX 2.3、CycloneDX 1.6、`checksums.sha256`。

至此 v0.6.0 正式发布闭环完成：源码迁移 + 测试全绿 + 安装包实装验证 + tag + GitHub Release。
- 环境备注：发布过程中 github.com:443 数次断连（api.github.com 正常），push 重试 5 次成功；tag 先本地创建后随网络恢复推送。

---

## 2026-08-23 · v0.7.0 移除 Global API Key + 重新发布

背景：按 Owner 决策彻底移除 Global API Key（legacy）路径，随后升版 0.7.0 并重新发布（breaking change）。

1. **移除范围（6 层）**：Core `CloudflareCredential` 收敛为单一 `api_token`（fetch adapter/desktop-host/redaction/setup-service 删 global 分支）；Rust `setup.rs`/`protocol.rs` 删 `GlobalApiKey` 变体；协议与 config/test-environment schema 删 global 字段；前端 Setup Center 三路径（删 Global 卡/确认短语/二次 Apply 确认，i18n -13 key×2）；测试删 global 用例（setup-engine×2、setup-cloudflare×2、setup-page×1、cloudflare-e2e×3）；脚本层 10+ 处（check-desktop-security/check-commercial-links/check-setup-security/check-test-environment/e2e-cloudflare/verify-setup/verify-release/gate 矩阵等）。
2. **需求与文档**：`goal/requirements.json` 删 `S-CF-GLOBAL-01`+`E-CF-GLOBAL-01`（72→70）；goal-state 删 `optionalLegacyGlobalKeyApplyPending` 与 passedRequirements 条目；删除 `docs/setup/cloudflare-global-key.md`；index/zone-onboarding/runtime-credential/prompts/release-gates/setup-gates/cloudflare-e2e 与根 goal 文档（00/02/03/04）同步清理。
3. **版本 0.7.0 连锁**：8 版本文件 + 运行时正则（setup-service ^0.7.）+ 3 schema pattern + fixtures/docs 同步；`verify:desktop:source` 16 项 PASS、`verify:setup` 22 项 PASS、`verify:release` PASS（dry-run 82 files、SBOM 764、releaseReady=true）。
4. **E-WIN-01 实装 smoke（0.7.0 新 hash：MSI `0275a933…`、NSIS `d5af3705…`）**：卸载 0.6.0 → 装 0.7.0 → 启动/WebView2 0.7.0/Desktop Host → Owner 托盘确认 → 干净退出。证据 `.toolspan-dev/evidence/windows-native-smoke-20260823T170535Z.json`；`E-WIN-01.json` 更新（observedAt 17:05:35Z）。
5. **正式 tag + Release**：`git tag v0.7.0`（→`ce4d7d2`）已推送；`gh release create v0.7.0`（publishedAt 2026-08-23T17:12:15Z）→ https://github.com/zy789363/ToolSpan/releases/tag/v0.7.0，资产 6 项。

至此 v0.7.0 发布闭环完成：Global API Key 完全移除（全库 grep 归零，仅保留历史 dated 记录）+ 全部验证绿 + 安装包实装 + tag + Release。

---

## 2026-08-24 · v0.7.1 托盘设计落地 + 发布

背景：托盘此前从未进入设计系统（参考原型已删且回收站无记录），按 v2 设计语言补写规范并落地实现，随后升版 0.7.1 发布。

1. **设计规范**：托盘设计事实源落档为 `docs/desktop-design-v2.md` 第 7 章「系统托盘」（唯一设计事实源）：token（`--tray-active #3b82f6`/`--tray-idle #9ca3af`/`--tray-attention #f59e0b`）、图标规格（16/24/32px ICO + 32px PNG、状态=整体色）、菜单结构（4 分组 + 启用/禁用态）、交互（左键显示窗口/Quit 确认）、无障碍、实现对照矩阵。该文件原计划随 v0.7.1 提交但当时缺失，2026-08-31 已按源码补建。
2. **实现（commit `3dc375c`）**：`app.rs` `build_tray`/`TrayStatus`/`update_tray_status` 重写——三态图标 `set_icon`（running/stopped/attention）、`MenuItem::set_enabled` 状态绑定（Start↔Stop 互斥、Copy 仅 running）、`on_tray_icon_event` 左键 → `show_main_window`；`commands.rs` 调用点传状态键；tauri 启用 `image-png` feature；`smoke-core-release.mjs` 错误诊断附 stderr。
3. **验证**：cargo fmt/check/clippy（无 warning）/test 49/49；`check:desktop:security` 11 项；**verify:desktop:source 16/16 PASS**；**verify:release PASS / releaseReady=true**（dry-run 82 files、SBOM 770）。
4. **E-WIN-01（0.7.1：MSI `ba81d937…`、NSIS `e3e1c928…`）**：卸载 0.7.0 → 装 0.7.1 → 启动/WebView2 0.7.1/Desktop Host → Owner 确认托盘（状态图标/菜单禁用态/左键）→ 退出路径与 v0.7.0 零 diff（v0.7.0 干净退出已验证）。**已知观察**：Core stopped 状态下托盘 Quit 的 runtime.stop 握手可能挂起（Core/desktop-host 层，非托盘回归），Owner 决策按现状发布并已记入 release notes。证据 `windows-native-smoke-20260824T114433Z.json`。
5. **正式 tag + Release**：`git tag v0.7.1`（→`814167d`）已推送；`gh release create v0.7.1`（publishedAt 2026-08-24T11:59:31Z）→ https://github.com/zy789363/ToolSpan/releases/tag/v0.7.1，资产 6 项。

至此 v0.7.1 发布闭环完成：托盘设计从零补写 → 落地 → 全量验证绿 → 实装确认 → tag + Release。
