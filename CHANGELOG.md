# Changelog

All notable changes to ToolSpan are recorded here. Dates and release links are omitted until they are known; no repository URL is inferred.

## [Unreleased]

### Desktop 0.7 · Remove Global API Key

- Removes the Global API Key (legacy) setup path entirely: Core `CloudflareCredential` converges to the single `api_token` kind, the Rust credential vault drops `GlobalApiKey`, and the desktop protocol/schema accepts only `api_token`.
- Setup Center becomes three paths (Guided Manual / Scoped API Token / Agent-assisted); the Global Key warning, confirmation phrase and second Apply confirmation are gone. Scoped-token Domain/Zone gates are unchanged.
- Removes `S-CF-GLOBAL-01` and `E-CF-GLOBAL-01` requirements and the `docs/setup/cloudflare-global-key.md` guide; release/setup gate docs and root goal docs are updated accordingly.

### Added

- ToolSpan Core 0.3 service identity and deterministic configuration resolution.
- Optional, validated instance names visible only after authorization.
- ToolSpan-owned exact 27-tool registry and MCP protocol fixture checks.
- OAuth lifecycle support for refresh-token rotation without expanding Tool permissions.
- Compiled release CLI smoke, bilingual documentation, usage snapshot checks, and deterministic Core CI.

### Desktop 0.6 · UI v2 (modern tech-blue)

- Migrates the v2 design system into the product desktop: ten-step primary color scale, brand/success gradients (area ≤ 8%), `--surface-3` / `--overlay`, blue-tinted shadows, `--dur-slow` / `--ease-spring`, H1 22px.
- Adds v2 component library: Tabs, Modal (Radix AlertDialog controlled), Toggle, Stepper, EmptyState, Stat, CodeBlock, MonoBox, Field/Input, SecretInput, ConfirmPhrase, StatusBanner, NavBadge, Toast; enhances Button (subtle/xs/loading), Badge (pulse), Card (interactive), Notice (four tones), PageHeader (eyebrow icon).
- Adds Setup progress card (Overview), Setup banner (Connection), Connection Assistant section (Settings), and EmptyState on Workspaces/Jobs/Artifacts; Logs pause becomes a Toggle. Setup Center keeps its real state machine and labels.
- Removes the reference implementation (`apps/desktop`, React 18) and the HTML prototype (`ui-prototype`); v2 is now the single product UI. Adds 16 v2 component tests (total 53).

### Changed

- The current product identity is ToolSpan; legacy WebGPT names remain only for documented migration compatibility.
- Source verification and installed-runtime preflight are separate commands.

### Setup / Connection Assistant 0.5

- Adds versioned single-session setup state, Cloudflare contract mocks, guided setup material, a safe Prompt Pack, and Desktop Setup Center verification.
- Adds transparent NameSilo referral and direct paths with dated commercial snapshots, stale-data hiding, and a text-only vendor asset fallback.
- Setup source verification is deterministic and keeps real Cloudflare, ChatGPT, and Agent Host evidence in independent external gates.
- Missing vendor material produces `FALLBACK_PASS`; missing real accounts remain explicit external blockers and are never reported as source-test evidence.

### Release automation

- Adds non-recursive, `shell: false` orchestration for all deterministic source stages and a closed schema v2 check for the local external-test manifest.
- Adds a no-publish/no-tag release dry-run that builds and packs source artifacts, inventories Desktop bundles, excludes stale native packages, emits SHA-256 checksums, and generates SPDX 2.3 plus CycloneDX 1.6 SBOM evidence from lockfiles and Cargo metadata.
- Release artifacts and sanitized gate reports are written only below the ignored `.toolspan-dev/evidence/release/` directory; Secret-like values and personal absolute paths fail the dry-run without being echoed.
- Owner license/publication, GitHub settings, Windows native validation, MCP Inspector, Codex remote write/job and Cloudflare account gates remain truthful external or owner gates and are never promoted by source tests.

### Security

- Public health responses remain minimal and do not expose instance names or real paths.
- Existing allowed-root, path, Host/Origin, OAuth-scope, runner-allowlist, and `shell: false` boundaries remain frozen.
- Cloudflare management credentials remain session-only; Setup persistence, logs, diagnostics, Prompt Pack, receipts, and verification child environments contain no Secret values.

### Owner gates

- Selection of the open-source license, public repository URL, maintainer/security contacts, and Sponsor identity remain pending.

## [0.2.0] — imported baseline

- Imported the prior WebGPT development baseline. Its original release date and repository URL are not asserted here.
