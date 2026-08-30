# 更新日志

ToolSpan 的所有重要变更均记录在此。日期和发布链接将在确认后补充；不会推断仓库 URL。

## [0.7.1] — 2026-08-24

### Desktop 0.7.1 · 托盘设计落地

- 托盘图标现在按 Core 状态切换：`tray-running.png`（蓝色，`--primary-500`）、`tray-stopped.png`（`gray-400`）和 `tray-attention.png`（警告）；ICO 16/24/32 多尺寸图标和 32px PNG 已打包到 `apps/desktop/src-tauri/icons/`。
- 菜单项现在反映状态：Start/Restart/Stop 按 Core 状态启用；只有运行中才能 Copy MCP URL；Show/Open logs/Quit 始终可用。
- 左键单击托盘图标现在会显示并聚焦主窗口（此前无操作）。
- Tauri 启用 `image-png` feature，用于 `Image::from_bytes` 运行时解码；`app.rs build_tray`/`TrayStatus`/`update_tray_status` 已重写，以集中管理菜单项、图标和状态文本；`commands.rs` 的调用点现在传递状态键（`running`/`stopped`/`attention`）。

## [0.7.0] — 2026-08-23

### Desktop 0.7 · 移除 Global API Key

- 完全移除 Global API Key（legacy）配置路径：Core `CloudflareCredential` 收敛为单一的 `api_token` 类型，Rust credential vault 移除 `GlobalApiKey`，桌面 protocol/schema 只接受 `api_token`。
- Setup Center 变为三条路径（Guided Manual / Scoped API Token / Agent-assisted）；移除 Global Key warning、confirmation phrase 和第二次 Apply confirmation。Scoped-token Domain/Zone 门禁保持不变。
- 移除 `S-CF-GLOBAL-01` 和 `E-CF-GLOBAL-01` 要求及 `docs/setup/cloudflare-global-key.md` 指南；release/setup gate 文档和根级 goal 文档同步更新。

## [0.6.0] — 2026-08-23

### Desktop 0.6 · UI v2（现代 tech-blue）

- 将 v2 design system 迁移到产品桌面端：十级 primary color scale、brand/success gradients（面积 ≤ 8%）、`--surface-3` / `--overlay`、蓝色调阴影、`--dur-slow` / `--ease-spring` 和 22px H1。
- 新增 v2 component library：Tabs、Modal（由 Radix AlertDialog 控制）、Toggle、Stepper、EmptyState、Stat、CodeBlock、MonoBox、Field/Input、SecretInput、ConfirmPhrase、StatusBanner、NavBadge、Toast；增强 Button（subtle/xs/loading）、Badge（pulse）、Card（interactive）、Notice（four tones）和 PageHeader（eyebrow icon）。
- 新增 Setup progress card（Overview）、Setup banner（Connection）、Connection Assistant section（Settings），并在 Workspaces/Jobs/Artifacts 中加入 EmptyState；Logs pause 改为 Toggle。Setup Center 保留实际 state machine 和 labels。
- 移除参考实现（`apps/desktop`、React 18）和 HTML prototype（`ui-prototype`）；v2 现在是唯一的产品 UI。新增 16 个 v2 component tests（共 53 个）。

## [0.5.0] — 内部阶段（Setup / Release 集成，无正式 GitHub Release）

### 设置与连接助手（Setup / Connection Assistant 0.5）

- 新增带版本的 single-session setup state、Cloudflare contract mocks、guided setup material、安全 Prompt Pack 和 Desktop Setup Center verification。
- 新增透明的 NameSilo referral 和 direct paths，带有 dated commercial snapshots、stale-data hiding 和 text-only vendor asset fallback。
- Setup source verification 具有确定性，并将真实 Cloudflare、ChatGPT 和 Agent Host 证据保留在独立 external gates 中。
- 缺少 vendor material 时产生 `FALLBACK_PASS`；缺少真实账号仍明确记录为 external blockers，绝不作为 source-test evidence 报告。

### Release 自动化

- 为所有确定性源码阶段新增非递归的 `shell: false` orchestration，并为本地 external-test manifest 新增 closed schema v2 检查。
- 新增 no-publish/no-tag release dry-run：构建并打包源码制品、盘点 Desktop bundles、排除过期 native packages、生成 SHA-256 checksums，并根据 lockfiles 和 Cargo metadata 生成 SPDX 2.3 及 CycloneDX 1.6 SBOM evidence。
- Release artifacts 和 sanitized gate reports 只写入被忽略的 `.toolspan-dev/evidence/release/` 目录下；Secret-like values 和个人绝对路径会使 dry-run 失败，且不会被回显。
- Owner license/publication、GitHub settings、Windows native validation、MCP Inspector、Codex remote write/job 和 Cloudflare account gates 仍如实作为 external 或 owner gates，不会被 source tests 提升为已通过。

## [0.3.0] — 内部阶段（Core 基线，无正式 GitHub Release）

### 新增

- ToolSpan Core 0.3 服务标识和确定性配置解析。
- 仅在授权后可见、且经过校验的可选实例名。
- ToolSpan 自有的精确 27-tool registry 和 MCP protocol fixture 检查。
- 支持 refresh-token rotation 的 OAuth 生命周期，且不扩展 Tool 权限。
- 编译后的 release CLI smoke、双语文档、用量快照检查和确定性 Core CI。

### 变更

- 当前产品身份为 ToolSpan；legacy WebGPT 名称只为文档化的迁移兼容而保留。
- 源码验证和已安装运行时 preflight 使用独立命令。

### 安全

- 公网 health 响应保持最小化，不暴露实例名或真实路径。
- 现有 allowed-root、path、Host/Origin、OAuth-scope、runner-allowlist 和 `shell: false` 边界保持冻结。
- Cloudflare management credentials 仅存在于 session；Setup persistence、logs、diagnostics、Prompt Pack、receipts 和 verification child environments 不包含 Secret values。

## [Unreleased]

- 无已确认的未发布变更。

## [0.2.0] — 导入的基线

- 导入此前的 WebGPT development baseline。本文不声明其原始发布日期和仓库 URL。
