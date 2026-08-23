# ToolSpan Release 自动门禁

本文记录 Release 阶段的自动装配边界和 `04_RELEASE_AND_EXTERNAL_GATES.md` 外部门禁。源码自动检查只能证明确定性结果；没有日期化、脱敏的真实证据时，Windows、Host、Cloudflare、GitHub 和 Owner gate 不得成为 `PASS`。

## 自动命令

根 `package.json` 已声明以下命令：

```text
npm run verify:all:source
npm run check:test-environment
npm run release:dry-run
npm run verify:release
```

`verify:all:source` 通过解析后的 `npm-cli.js` 和 `shell: false` 顺序执行 `goal:check`、`verify:core`、`verify:desktop:source`、`verify:setup`。四个子项都不能调用 `verify:all:source`，因此不会递归。

`check:test-environment` 验证 `.toolspan-dev/test-environment.json` 的 schema v2 闭集。该文件只允许 capability flag、Cloudflare Zone/Account ID、固定目标、状态枚举和 Secret 环境变量名；Secret value 数量必须为 0。当前 Owner profile 固定为 `aiqushi.top`、`mcp.aiqushi.top`、Chrome/computer-use 已授权、不要求 ChatGPT Business，并由 Codex 承担 write E2E。检查器不读取、更不输出所引用环境变量的 value。

`release:dry-run` 只执行 Core build、Desktop Renderer build、`npm pack --ignore-scripts`、Cargo metadata 和本地装配。命令中没有 `npm publish`、`npm version`、Git tag 或 Release API。持久证据只写入已忽略的 `.toolspan-dev/evidence/release/run-*/`：

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

旧版本 native bundle 会列入 `staleNativeArtifactsExcluded`，不会复制进当前 dry-run。即使存在当前版本 bundle，dry-run 也只报告 `ASSEMBLED_NOT_NATIVE_VALIDATED`；只有安装、托盘和 owned-process smoke 的日期化证据才能让 Windows gate 成为 `PASS`。

## 04 Gate Matrix（2026-08-22 当前状态）

| ID | 必需性 | 当前状态 |
|---|---|---|
| `E-OWNER-01` | Release 必需 | `PASS`；Owner 已批准 publication/IP/trademark/Apache-2.0，闭集 proof 已验证 |
| `E-GH-01` | Release 必需 | `PASS`；公开默认分支、security policy、active ruleset、branch protection 与 private reporting 已远端读取验证 |
| `E-WIN-01` | Windows Release 必需 | `PASS`；Owner 手工 Tray smoke 与既有 install/lifecycle/process evidence 已绑定当前 MSI/NSIS hash |
| `E-SIGN-01` | 可选 unsigned | `NOT_CONFIGURED` |
| `E-CF-TOKEN-01` | one-click Cloudflare claim 前必需 | `PASS`；scoped-token API lifecycle + public HTTPS/OAuth/exact27 + owned cleanup 闭集证据已验证 |
| `E-CF-WIN-01` | Windows one-click claim 前必需 | `BLOCKED_BY_ENVIRONMENT`；源码工具链就绪（`scripts/cloudflared-service-lifecycle.ps1` + `uninstall-cloudflared-service.ps1` + 静态测试 + `docs/release/windows-cloudflared-service-validation.md`）。2026-08-23 Owner 决定跳过真实 admin VM 验证，同时将 `WINDOWS_ONE_CLICK_VALIDATED` claim 置为 `inactive`（basis=`WINDOWS_SETUP_USES_MANUAL_CLOUDFLARED_ONLY`）——Desktop 实际使用 manual cloudflared adapter，不承诺自动安装 Windows service，故本 gate 不再阻塞 `RELEASE_READY`；若未来重新宣传 Windows one-click cloudflared，必须先恢复 claim active 并补齐验证 |
| `E-HOST-01` | Release 必需 | `PASS`；Inspector 2.3.0 OAuth/exact 27/read/write/job/read-only rejection 闭集证据已验证 |
| `E-CODEX-01` | Release 必需 | `PASS`；真实 Codex remote OAuth/exact 27/read/write/job/hash isolation/cleanup proof 已验证 |
| `E-CGPT-UI-01` | 非 Release 必需 | `EXTERNAL_GATE_PENDING`（UI capability 已观察；连接/OAuth/tool scan 未完成） |
| `E-OAUTH-SOAK-01` | 非 Release 必需 | `NOT_REQUIRED` |
| `E-AFF-01` | 商业 CTA 前必需 | `STALE_FALLBACK`；2026-08-23 referral CTA 已完整移除，`COMMERCIAL_CTA_CURRENT` claim 置为 `inactive`（basis=`REFERRAL_CTA_REMOVED`），E-AFF-01 不再阻塞 `RELEASE_READY`；若未来重新引入 referral/推广路径，必须先恢复 claim active 并补齐当前性验证 |
| `E-ASSET-01` | Logo/Banner 前必需 | `TEXT_ONLY_FALLBACK` |
| `E-DATA-01` | OpenAI 数字展示前必需 | `STALE_FALLBACK`；官方来源覆盖不完整，具体数字与 MCP plan matrix 已隐藏 |

### Active claim policy

Conditional gate 不能仅因 `blockingFor` 使用条件名称就被 readiness 计算忽略。当前产品声明由 `RELEASE_CLAIM_POLICY` 显式冻结：

```text
ONE_CLICK_CLOUDFLARE_CLAIM     active
WINDOWS_ONE_CLICK_CLAIM        inactive（WINDOWS_SETUP_USES_MANUAL_CLOUDFLARED_ONLY；2026-08-23 Owner 跳过 admin VM 验证后停用）
COMMERCIAL_CTA                 inactive（REFERRAL_CTA_REMOVED；2026-08-23 移除 referral 路径后停用）
NUMERIC_OPENAI_QUOTA_CLAIM     inactive（OFFICIAL_SOURCE_COVERAGE_INCOMPLETE_STALE_FALLBACK）
LOGO_OR_BANNER                 inactive（TEXT_ONLY_FALLBACK active）
```

`RELEASE_READY` 要求 `requiredPending` 与 `activeConditionalPending` 同时为空。未知 claim policy 也按 active 保守处理。`E-CF-WIN-01=BLOCKED_BY_ENVIRONMENT`、`E-AFF-01=STALE_FALLBACK`、`E-ASSET-01=TEXT_ONLY_FALLBACK` 与 `E-DATA-01=STALE_FALLBACK` 会进入 `inactiveConditionalFallbacks`，不会阻塞；一旦产品重新宣传 Windows one-click cloudflared、referral/推广路径、Logo/Banner 或显示 OpenAI 数字/MCP plan matrix，必须先恢复对应 active policy 并提供 `PASS` 证据。

手工证据只从 `.toolspan-dev/evidence/external/<Requirement-ID>.json` 读取。非 `PASS` 使用六字段闭集 envelope：`schemaVersion`、`requirementId`、`status`、`observedAt`、`sanitized`、`secretValues`。`PASS` 必须额外包含 gate-specific 闭集 `proof`；Windows/签名/cloudflared 绑定当前 dry-run 的版本与 MSI/NSIS SHA-256，Codex/Inspector/Cloudflare 分别验证远端隔离、完整协议序列或完整资源生命周期。14 个 gate 均有冻结时效，未来、过期、空壳和旧 artifact evidence 一律回退，`externalGatesPromotedWithoutEvidence` 由真实矩阵计算。该机制仍不替代真实操作与人工审查。

`verify:release` 先执行 test-environment、全部源码阶段和 dry-run，再评估上述 matrix。自动部分全绿但必需或 active conditional 外部门禁未完成时，结果必须是 `EXTERNAL_GATE_PENDING` 和非零退出码；这不是源码回归，也不得改写为 `RELEASE_READY`。

## 安全与发布边界

- exact 27 Tool Contract、`shell: false`、allowed roots、OAuth scope、Host/Origin 和 runner allowlist 不变。
- 不实现 MCP Client、Gateway、Agent Runtime 或任意 Shell。
- Cloudflare Secret 只通过本地受控输入或环境变量引用；不会进入子进程、命令行、日志、Prompt、receipt、诊断、manifest 或 SBOM。
- `release:dry-run` 不 tag、不 publish、不调用外部账号，也不修改 `.toolspan-dev/goal-state.json`。
- Maintainer 只有在必需的真实 gate 和 Owner publication approval 都有证据后，才能显式执行正式 tag/Release。

## 2026-08-22 当前权威验证记录

Stage: `RELEASE_GATES`

Status: 确定性源码与装配门禁 `PASS`；总体 `EXTERNAL_GATE_PENDING`；`releaseReady=false`。`verify:release` 没有把外部门禁伪装成自动 `PASS`。

Commit / working tree: 当前交付目录已初始化本地 Git，未出生分支为 `main`，`origin` 指向私有空仓库 `zy789363/ToolSpan`。`HEAD` 不存在，未 commit、未 push、未执行 reset、clean、tag、publish 或 Release API。

Commands actually run:

```text
npm run goal:preflight         PASS；gitRepository/gitStatusAvailable/remoteConfigured=true
npm run check:oss              PASS_WITH_OWNER_GATE；Apache-2.0 官方全文与 npm 元数据一致
node --test scripts/tests/host-e2e-safety.test.mjs scripts/tests/release-scripts.test.mjs
  PASS                         40/40 Host/Release focused tests
node --test scripts/tests/cloudflare-e2e.test.mjs
  PASS                         33/33 runner tests；未执行 Apply
npm run e2e:mcp-inspector      PASS；official Inspector 2.3.0；exact 27/read/write/job；auth state removed
npm run e2e:codex-remote       PASS；Codex 0.149.0-alpha.4.1；remote read/write/job；closed cleanup
npm run verify:all:source      PASS
  Core                         159/159；exact MCP Tool Contract 27/27
  Desktop static/verifier      17/17
  Renderer                     37/37
  i18n                         3/3
  accessibility                10/10
  Rust                         50/50
  Setup scenarios              62/62
npm run verify:desktop:windows EXTERNAL_GATE_PENDING
  native build                 PASS
  install/lifecycle/isolation  PASS
  direct system tray menu      NOT_PERFORMED
Owner manual E-WIN-01          PASS；direct Tray smoke；current MSI/NSIS hash bound
npm run release:dry-run        PASS
npm run verify:release         EXTERNAL_GATE_PENDING
  deterministicGates           testEnvironmentV2/allSource/releaseDryRun PASS
  releaseReady                 false
```

Release evidence:

```text
latest dry-run                 run-20260822T141053722Z-d7d6def5
latest verification            release-verification-20260822T141059199Z.json
npm package files              83
Desktop Renderer files         4
current native artifacts       2
stale/rejected artifacts       2
SBOM components                764
SPDX / CycloneDX               2.3 / 1.6；closed-schema semantic validation PASS
tag created / published        false / false
```

`.toolspan-dev/evidence/release/latest.json` 保持 `scope=RELEASE_DRY_RUN_ASSEMBLY`、`dryRunOnly=true`；`.toolspan-dev/evidence/release/latest-verification.json` 指向上述 verification。该目录已被 `.gitignore` 覆盖。

Windows release artifacts:

```text
ToolSpan_0.5.0_x64_en-US.msi
  bytes                         4427776
  sha256                        2c3554cf01f1ff19f0799a50b13a1db0327e471dee080ffa63d1dca0109ec310
ToolSpan_0.5.0_x64-setup.exe
  bytes                         3339802
  sha256                        325d6e895efaa91b950fd55d44950e103aea95c75f0ab38922f45e442b87f21c
toolspan-desktop.exe
  bytes                         7197184
  sha256                        fa7d2f58085604c083c1f58837c1f34a1bcb57a9c40d57eae83373559eb9fb4d
  PE subsystem                  WINDOWS_GUI
Authenticode                    NotSigned（E-SIGN-01=NOT_CONFIGURED，非阻塞）
```

Windows 真实 smoke 已完成当前安装器 UI、标准 per-user 安装、已安装 dashboard、Start/Restart/Stop、single-instance restore、确认退出、owned Host cleanup 与 unrelated external Node isolation。`toolspan-desktop.exe` 没有 Console 子窗口，运行态为 exact 27 tools。详细脱敏证据：`.toolspan-dev/evidence/windows-release-binary-20260822T051102Z.json`。

Computer Use backend 仍只暴露目标窗口；该能力限制由 `.toolspan-dev/evidence/computer-use-tray-targeting-20260822T061954Z.json` 如实保留。Owner 随后于 2026-08-22 手工完成最终 Windows Tray smoke，并明确确认通过。确认记录 `.toolspan-dev/evidence/windows-tray-manual-20260822T130308Z.json` 与既有安装/生命周期/process evidence 合并，绑定 MSI `2c3554cf01f1ff19f0799a50b13a1db0327e471dee080ffa63d1dca0109ec310` 和 NSIS `325d6e895efaa91b950fd55d44950e103aea95c75f0ab38922f45e442b87f21c`；最新 Release verifier 已确认 `E-WIN-01=PASS`、`proofValidated=true`。

External gates（以 `release-verification-20260822T163130909Z.json` 为准）：

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

Required blockers: none。Active conditional blockers: 无（`E-CF-WIN-01`、`E-AFF-01` 均已随 claim 停用转为 inactive；`E-ASSET-01=TEXT_ONLY_FALLBACK` 与 `E-DATA-01=STALE_FALLBACK` 属于 inactive conditional fallback）。历史审计证据为 `.toolspan-dev/evidence/namesilo-currentness-20260822T063449Z.json` 与 `.toolspan-dev/evidence/openai-data-currentness-20260822T055319Z.json`。

Owner 于 2026-08-22 批准采用 Apache License 2.0，并进一步明确批准 publication、IP rights 与 trademark 四项闭集声明；`LICENSE` 为 Apache 官方完整文本，规范化 SHA-256 为 `58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd`，npm package/lock/shrinkwrap 元数据均为 SPDX ID `Apache-2.0`。闭集 proof 为 `.toolspan-dev/evidence/external/E-OWNER-01.json`；Release verifier 已确认 `E-OWNER-01=PASS`、`proofValidated=true`。

GitHub 插件与 `gh` CLI 均已连接账号 `zy789363`。2026-08-22 首个私有 `main` commit `e22d3414befa45162287eaed4bbd002e4d101e7f` 已推送；GitHub Free 明确拒绝私有仓库的 ruleset/branch protection，且 private vulnerability reporting 仅支持 public repository。由于 `E-OWNER-01` 已明确批准公开发布权且随后批准 `E-GH-01`，仓库 `zy789363/ToolSpan` 已转为 `PUBLIC`。远端回查确认默认分支为 `main`、根 `SECURITY.md` 存在、branch protection 启用 linear history/conversation resolution 并禁止 force push/deletion、`Protect main` ruleset 为 `active` 且包含 deletion/non-fast-forward/linear-history 三项规则、private vulnerability reporting 返回 `enabled=true`。闭集 proof 为 `.toolspan-dev/evidence/external/E-GH-01.json`；Release verifier 已确认 `E-GH-01=PASS`、`proofValidated=true`。未创建 tag 或 Release。

首轮真实 GitHub clean-checkout CI 暴露并修复了四类仅在新仓库可见的问题：嵌套 `src/state` 被宽泛 ignore、CI 未从 example 初始化 gitignored goal state、runner 未安装 ripgrep、Windows/POSIX 路径与 checkout 行尾不一致；高负载 Windows integration tests 仅在 `CI=true` 时使用 15 秒有界 timeout，本地仍为 5 秒。代码 HEAD `894fc7bc3366bb2b77ad00b62eec84071cf98279` 的 GitHub Actions run `32581011705` 最终 7/7 jobs success：Core Ubuntu Node 22.17/24、Core Windows Node 24、Desktop source Ubuntu/Windows Node 24、Setup source Ubuntu/Windows Node 24；Windows Desktop 的 native build attempt 也成功。随后对同一代码 HEAD 运行完整 `verify:release`，dry-run evidence 为 `.toolspan-dev/evidence/release/run-20260822T153439306Z-b7d8a0b5`，verification evidence 为 `.toolspan-dev/evidence/release/release-verification-20260822T153445652Z.json`，`requiredPending=[]`、`externalGatesPromotedWithoutEvidence=0`、`tagCreated=false`、`published=false`。

`E-HOST-01=PASS`：2026-08-22 的 `npm run e2e:mcp-inspector` 先验证无凭证 `auth_required / exit 3`，再由 official Inspector 2.3.0 使用自身 PKCE、loopback callback 与两个随机临时 auth store 完成 full-scope/read-only 两条链。真实调用覆盖 initialize、exact 27、read、`apply_patch` dry-run/apply/readback、allowlisted job/poll/output 与 read-only 写拒绝；SDK 辅助链进一步确认 `_meta` 的 `insufficient_scope`。Password 未进入参数、环境、浏览器控制指令、日志或 evidence；两个 auth store 无论成功/失败均由 `finally` 删除，当前 `%TEMP%` 遗留数为 0。详细证据为 `.toolspan-dev/evidence/release-e-host-01.json`，闭集 proof 为 `.toolspan-dev/evidence/external/E-HOST-01.json`。

`E-CODEX-01=PASS`：`npm run e2e:codex-remote` 使用 Cloudflare 官方签名的 `cloudflared 2026.8.2` 建立一次性 HTTPS Quick Tunnel，并以 Desktop-bundled Codex CLI `0.149.0-alpha.4.1` 的真实 Streamable HTTP OAuth/DCR 会话调用 ToolSpan。Codex 事件闭集覆盖 `devspace_info`、`open_workspace`、`read`、`apply_patch` dry-run/apply/readback、`start_job`、`poll_job` 与 job output；tool count 为 27。Remote writable SHA-256 从 `50a3e798962c81bc11699808fd02831ed1ca3397f8b91dc365fd7a322fd06675` 变为 `c94a2c2a4ea4bb0b3d9f5da74a62ff140a29bd857b9d2ca559a58c7067bd9777`，local source fixture 前后保持 `50a3e798962c81bc11699808fd02831ed1ca3397f8b91dc365fd7a322fd06675`。详细证据为 `.toolspan-dev/evidence/codex-remote-e2e-202608221403547af16438e2.json`，闭集 proof 为 `.toolspan-dev/evidence/external/E-CODEX-01.json`；测试后 Codex OAuth/MCP entry、Quick Tunnel、ToolSpan process、synthetic workspace 和下载 binary 均已移除。

Cloudflare fresh read-only preflight `20260822-de7b39b2a0` 验证 Global Key、active Zone、零 DNS/tunnel collision，并生成三项 mutation 的 exact plan；`Apply attempted=false`，证据为 `.toolspan-dev/evidence/cloudflare-e2e-20260822-de7b39b2a0.json`。该 optional Global legacy path 不能提升 active scoped-token gate，也没有获得 Apply 权限。Secret value 仍不得进入聊天、配置、Prompt、receipt、诊断或命令行。

`E-CF-TOKEN-01=PASS`：Owner 在本地 `TOOLSPAN_E2E_CF_API_TOKEN` 环境变量配置 scoped token，test-environment 只保存变量名。session `20260822-cc6cd8b988` 的 read-only preflight 验证 `aiqushi.top=ACTIVE`、`mcp.aiqushi.top` 无 DNS/Tunnel collision，并绑定 plan hash `d2cf8f83f011f711b2cce807725fe4c9413850cef1de12c51837bac59852aba8`。经两次独立 Owner checkpoint，runner 创建 session Tunnel、配置 exact ingress、创建 proxied CNAME；独立 Reconcile 证明 duplicate create `0`、mutation delta `0`、Tunnel/DNS/fingerprint/ingress 全匹配。官方签名且 SHA-256 固定的 `cloudflared 2026.8.2` 使用 child-only `TUNNEL_TOKEN` 环境变量连接 Named Tunnel；packed ToolSpan 在 `https://mcp.aiqushi.top` 完成 public health、OAuth discovery/authorization、official Inspector exact 27、read、write、job 与 insufficient-scope。随后 owned-only cleanup 按 DNS→复查→Tunnel 顺序完成，terminal Reconcile 再次只用 GET 确认 DNS/Tunnel 为 0。API lifecycle evidence 为 `.toolspan-dev/evidence/cloudflare-e2e-20260822-cc6cd8b988.json`，public evidence 为 `.toolspan-dev/evidence/cloudflare-public-e2e-20260822-cc6cd8b988.json`，闭集 proof 为 `.toolspan-dev/evidence/external/E-CF-TOKEN-01.json`；Secret values、credential argument/file/log/evidence findings 均为 0，临时 cloudflared binary 已删除。最新 verifier 已确认 `E-CF-TOKEN-01=PASS`、`proofValidated=true`。

Security invariants checked:

```text
exact MCP Tool Contract                    27/27
Release child process shell                false
external gates promoted without evidence  0
tag / publish side effects                 0
MCP Client / Gateway / Agent Runtime / Shell added  0
```

Current stage: `RELEASE_GATES`（native / external validation）

Windows native Release gate 已由当前 hash-bound install/lifecycle/process evidence 与 Owner 手工 Tray smoke 闭集收敛；没有剩余 `E-WIN-01` 动作。

其余外部门禁依次使用真实环境继续：Cloudflare 仅在本地存在 scoped token 引用后重新执行 `npm run e2e:cloudflare -- --preflight`，并在独立动态确认前保持 Apply=false；Owner/GitHub/affiliate gate 分别补齐自己的日期化 evidence。任何新证据写入后重新运行：

```text
npm run verify:release
```

## 2026-08-21 阻塞审计（历史，已被 2026-08-22 证据取代）

本节仅保留当时的审计轨迹，不代表当前 credential、artifact 或 gate 状态。

同一 Owner-input 条件已连续三次 goal turn 出现。最终只读检查：

```text
TOOLSPAN_E2E_CF_GLOBAL_EMAIL  Process=false / User=false / Machine=false
CloudFlareAPIKEY              present=true（只检查名称存在，不读取 value）
TOOLSPAN_E2E_CF_API_TOKEN     Process=false / User=false / Machine=false

npm run e2e:cloudflare -- --preflight
  status                      NEEDS_HUMAN_CHECKPOINT
  reason                      GLOBAL_KEY_EMAIL_ENV_VALUE_REQUIRED
  apiRequests                 0
  Apply attempted             false
  runner-specific reflection scan PASS
  evidence                    .toolspan-dev/evidence/cloudflare-e2e-20260820-48001cae77.json
```

该旧阻塞已由后续本地 email 设置与正确 Global API Key 替换解决。

## 2026-08-21 恢复执行记录（历史，已被 2026-08-22 证据取代）

本节中的 hash、测试数量与 Windows 覆盖只适用于当时快照。

第一次恢复时以不回显 value 的格式确认旧值实际为 User API Token，并发现缺 Tunnel 权限。Owner 随后将 `CloudFlareAPIKEY` 替换为正确 Global API Key；manifest 已切回 `GLOBAL_API_KEY`，Secret value 未进入 manifest、日志或 evidence。

```text
VERIFY_GLOBAL_KEY    200 PASS
RESOLVE_ZONE         200 PASS（ACTIVE）
INSPECT_DNS          200 PASS（recordCount 0 / collision false）
INSPECT_TUNNELS      200 PASS（prefixedCount 0 / collision false）
credentialVerified  true
Dry Run              DRY_RUN_READY / mutationCount 3
planHash             61ec90917349b8bd445b25eca111e89238064b5c2249a67dd5d74b3dc6ed22d8
Apply attempted      false
runner-specific reflection scan PASS
evidence             .toolspan-dev/evidence/cloudflare-e2e-20260821-ee93a77b22.json
```

Windows production NSIS 的旧 binary 经 Computer Use 显示安装完成并成功打开 ToolSpan First Run；受控 `remote-workspace` 由原生 picker 登记。真实启动发现 Node 不可用时 error page 无法进入 Settings 的 recovery dead-end；新增 native Node picker recovery 后，成功/拒绝 focused 7/7、Renderer 33/33、Desktop source verification 和 production bundle 均 PASS。路径修复前的历史 NSIS（SHA-256 `3bb0aa57e0ff0f236967c92d0e4d1c0dd0099f8bd749dd9701aa2e1967b7fdcd`）实测在物理 Esc 后暂停；它不是当前 shipping artifact。其安装与进程隔离 pending 状态已由 2026-08-22 当前-hash smoke 取代，只有直接系统托盘菜单 smoke 仍未执行。

## 2026-08-21 恢复后的第三次阻塞审计（历史，已被 2026-08-22 证据取代）

自动源码、production assembly 与 Release verifier 均已收敛；post-audit Renderer 34/34、a11y 10/10、Tauri adapter 7/7，Node validation/discovery 子进程 Secret 环境继承为 0。连续三个 resumed goal turn 仍存在相同的两个外部条件：

当时 Windows UI smoke 尚未恢复、Cloudflare Apply 也尚未进入动态一次性确认流程，`releaseReady=false`。Windows 等待条件已于 2026-08-22 解除并完成安装、生命周期和进程隔离 smoke；Cloudflare 仍未 Apply，且不因 Windows 授权而获得 mutation 权限。

## 2026-08-21 Windows Host 路径修复与 artifacts（历史，已被 2026-08-22 证据取代）

真实普通安装排除了 Node、standalone bundle、配置、env allowlist 和基础 Supervisor 后，进一步复现发现：Tauri 2.11 的 Windows Resource 路径源于 canonicalized current executable，因此固定入口以 `\\?\` verbatim-disk 路径传给 Node。Node 24 将该 ESM entry 错误解析并快速退出；Tauri command 因而真实返回 `DESKTOP_HOST_UNAVAILABLE`。修复前的 extended-path Supervisor 为 `HostError::Crashed`，修复后同一真实 Node、bundle 和 config 完成 hello + snapshot（27/27）。

```text
npm run verify:desktop:source
  resource/verifier tests      10/10 PASS
  Renderer                     34/34 PASS
  i18n                          3/3 PASS
  a11y                         10/10 PASS
  Rust                         45/45 PASS
  Core                        157/157 PASS
  MCP Tool Contract            27/27 PASS

npm run verify:desktop:windows
  status                       EXTERNAL_GATE_PENDING
  validatedSubgate             WINDOWS_RELEASE_NATIVE_BUILD
  MSI sha256                   fc08416f66b4de25ca9b53f27663a458e0643daf687fe913f388031a51daf8a1
  NSIS sha256                  0caf117583fdcf2dcd7039b20a2e0277ec82a97446c010fdfb99e5c74a54a72b

current release EXE / Tauri IPC
  runtime.getSnapshot          resolved / ok
  state                        stopped
  totalTools                   27
  managedByDesktop             true
  owned Host children          1 while parent alive / 0 after exact parent stop
  partial machine evidence     .toolspan-dev/evidence/windows-release-binary-20260821T055204Z.json

npm run verify:release
  deterministic gates          PASS
  overall                      EXTERNAL_GATE_PENDING / exit 3
  dry-run evidence             .toolspan-dev/evidence/release/run-20260821T054445055Z-b17f18c6
  verification evidence        .toolspan-dev/evidence/release/release-verification-20260821T054449976Z.json
  tag / publish                false / false
```

这些历史证据证明了当时源码、release EXE、fixed Host entry 和 owned-child cleanup，但旧 artifact hash 不得用于提升当前 gate。2026-08-22 已进一步完成当前安装器 UI、生命周期、unrelated-process isolation 与 Owner 手工系统托盘 smoke，因此最新 verifier 中 `E-WIN-01=PASS`。

## 标准交接字段（2026-08-22）

Files changed by this report update:

- `LICENSE`
- `package.json`
- `package-lock.json`
- `npm-shrinkwrap.json`
- `README.md`
- `README.zh-CN.md`
- `.gitattributes`
- `.github/workflows/core.yml`
- `scripts/check-oss.mjs`
- `scripts/check-ci.mjs`
- `scripts/desktop-verification-utils.mjs`
- `scripts/e2e-mcp-inspector.mjs`
- `scripts/e2e-cloudflare.mjs`
- `scripts/e2e-cloudflare-public.mjs`
- `scripts/tests/cloudflare-e2e.test.mjs`
- `scripts/tests/cloudflare-public-e2e.test.mjs`
- `scripts/tests/host-e2e-safety.test.mjs`
- `scripts/e2e-codex-remote.mjs`
- `scripts/tests/codex-remote-e2e.test.mjs`
- `scripts/tests/release-scripts.test.mjs`
- `scripts/tests/setup-verification.test.mjs`
- `src/state/state-store.ts`
- `tests/artifacts.test.ts`
- `tests/runner-registry.test.ts`
- `vitest.config.ts`
- `docs/release/host-e2e.md`
- `.toolspan-dev/evidence/windows-tray-manual-20260822T130308Z.json`
- `.toolspan-dev/evidence/external/E-WIN-01.json`
- `.toolspan-dev/evidence/codex-remote-e2e-202608221403547af16438e2.json`
- `.toolspan-dev/evidence/external/E-CODEX-01.json`
- `.toolspan-dev/evidence/external/E-OWNER-01.json`
- `.toolspan-dev/evidence/external/E-GH-01.json`
- `.toolspan-dev/evidence/cloudflare-recovery-cleanup-20260822-d6d529bfa9.json`
- `.toolspan-dev/evidence/cloudflare-e2e-20260822-cc6cd8b988.json`
- `.toolspan-dev/evidence/cloudflare-public-e2e-20260822-cc6cd8b988.json`
- `.toolspan-dev/evidence/external/E-CF-TOKEN-01.json`
- `.toolspan-dev/goal-state.json`
- `docs/release/release-gates.md`

Exact next external action: required Release gates 与 scoped-token one-click Cloudflare claim 已无 pending。Windows one-click cloudflared service 仍需 disposable admin VM；Affiliate CTA 若继续显示，需提供 exact affiliate ID/coupon 的日期化账号证据，否则移除 referral CTA。正式 tag/Release 仍须 Maintainer 另行显式批准。

## 2026-08-23 releaseReady 收敛记录

Stage: `RELEASE_GATES` → `RELEASE_READY`（自动门禁收敛，正式 tag/Release 仍待 Maintainer）

Status: `verify:release` 输出 `PASS / releaseReady=true / exit 0`。

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

Remaining（不阻塞 `RELEASE_READY`）：

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
