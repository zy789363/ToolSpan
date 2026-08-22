# ToolSpan

Remote tools for AI agents. ToolSpan Core is a headless MCP server that exposes a deliberately bounded set of workspace, file, job, and artifact tools on the machine where **ToolSpan is deployed**.

> [!IMPORTANT]
> **Codex built-in read/write acts on the machine running Codex. ToolSpan MCP read/write acts on the machine running ToolSpan.** They may be different machines, accounts, and filesystems. Before any write, deletion, job, or publication, call `devspace_info`, confirm the intended instance, keep `allowedRoots` narrow, and review the requested OAuth scopes.

ToolSpan is a server and local control surface—not an MCP client, gateway, agent runtime, chat application, or arbitrary shell. The headless Core is the complete functional path; a desktop control surface is optional and is not required to use any Core tool.

ToolSpan was formerly developed as WebGPT. That name remains only where migration compatibility requires it.

## Local tools and remote tools

| Action | Runs on | Typical use |
| --- | --- | --- |
| Codex built-in file or terminal action | The Codex host | Change the checkout that Codex can already access |
| ToolSpan MCP tool call | The ToolSpan host | Work on an explicitly allowed root on a remote or separate machine |

The Agent Host supplies the MCP client. The connection is:

```text
Agent Host → host-provided MCP client → user-owned HTTPS → ToolSpan Core → files/jobs/artifacts
```

ToolSpan does not proxy one MCP server to another and does not provide a public administration route.

## Security warning

An authorized ToolSpan client may read or change files, run **allowlisted developer tasks** with `shell: false`, and publish artifacts from the ToolSpan machine. There is no arbitrary shell tool. Even so, a permitted build or test can execute repository code with the operating-system rights of the ToolSpan service account.

Start with `workspace:read`. Grant `workspace:write`, `jobs:run`, or `artifacts:publish` only when the workflow needs it. Use a dedicated low-privilege service account for untrusted repositories, keep state and password-hash files outside every allowed root, and treat a persistent published-artifact URL as a disclosure.

## Quick start: deterministic local smoke

Requirements:

- Node.js 22.17+ within major 22, or Node.js 24.x;
- npm with clean-install access to the package registry;
- Git and ripgrep (`rg`) for the workflows that use them.

No domain, Cloudflare account, public endpoint, or real Agent Host is required for the local source and packed-release smoke:

```powershell
npm.cmd ci
npm.cmd run verify:core
npm.cmd run smoke:core-release
```

`verify:core` is deterministic and does not fetch plan limits or external documentation. `smoke:core-release` packs the release, installs production dependencies in an isolated directory, exercises the compiled password/doctor/start commands, checks `/healthz`, and cleans up. It does not publish a package or create a tag.

### Run the compiled server manually

1. Build the project and copy `toolspan.config.example.json` to a gitignored local path such as `.toolspan-dev/toolspan.config.json`.
2. Set `publicBaseUrl` to the HTTPS origin that will serve `/mcp`, or to a localhost origin for local-only testing. Point `allowedRoots` only at directories that already exist. Keep `stateDirectory` and `ownerPasswordHashFile` outside those roots.
3. Create the owner password hash without putting the password in shell history:

```powershell
npm.cmd run build
$ToolSpanPassword = Read-Host "ToolSpan owner password" -AsSecureString
$ToolSpanPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ToolSpanPassword)
try {
    $ToolSpanPlaintext = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ToolSpanPointer)
    $ToolSpanPlaintext | npm.cmd run password:init -- --file .\.toolspan-dev\owner.bcrypt
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ToolSpanPointer)
    Remove-Variable ToolSpanPlaintext -ErrorAction SilentlyContinue
}
```

4. Point the config's `ownerPasswordHashFile` at that bcrypt file, then diagnose and start:

```powershell
npm.cmd run doctor -- --config .\.toolspan-dev\toolspan.config.json
npm.cmd start -- --config .\.toolspan-dev\toolspan.config.json
```

`GET http://127.0.0.1:8787/healthz` returns only minimal service/version/status data. It does not expose the instance name, real paths, owner details, account details, or credentials. The MCP endpoint itself requires OAuth authorization.

Config resolution is deterministic:

```text
--config
> TOOLSPAN_CONFIG
> WEBGPT_CONFIG (legacy; warns once)
> existing toolspan.config.json
> existing webgpt.config.json (legacy; warns once)
> expected toolspan.config.json
```

## Remote connection overview

1. Run ToolSpan on a loopback listener on a machine you control.
2. Put a user-owned HTTPS endpoint in front of that listener. Forward only the intended ToolSpan endpoint; do not expose an admin interface.
3. Set the public origin in `toolspan.config.json`, keep the listener on loopback, and run `doctor`.
4. In the Agent Host, add the public `/mcp` URL and complete OAuth. Request only the scopes needed for the session.
5. After authorization, call `devspace_info` and confirm `instanceName` before the first write or job.

Account login, DNS changes, tunnel creation, consent, and other external side effects remain owner-controlled. See [deployment guidance](docs/deployment.md), the [product contract](docs/product-contract.md), and the [threat model](docs/threat-model.md).

## Four common workflows

### 1. Read-only analysis

Request `workspace:read`, call `devspace_info`, open an allowed existing directory with `open_workspace`, then use `search_files`, `list_directory`, `read`, or `read_many`. The returned `workspaceId` anchors subsequent paths to the registered workspace.

### 2. Modify and test

Confirm the ToolSpan instance again. Request `workspace:write` only for the modification and `jobs:run` only for the test. Prefer `apply_patch` or `edit` for reviewable changes, then use `start_job` with an allowlisted runner and `poll_job` for output. ToolSpan passes an executable plus an argument array with `shell: false`; it does not accept arbitrary command text.

### 3. Capture and share an artifact

Use `start_capture`, inspect the bounded result with `inspect_artifact`, and create a short-lived URL with `preview_artifact`. Request `artifacts:publish` only if a persistent public link is intentionally required; `publish_artifact` is an explicit disclosure action.

### 4. Resume a long task

Keep the `workspaceId`, `jobId`, and the last poll cursor outside the chat transcript when appropriate. A later session can use `resume_workspace`, `list_jobs`, and `poll_job` to continue without starting the work twice. A process lost during a service restart is reported as interrupted rather than silently restarted.

## Exact 27-tool contract

The production MCP baseline is `2025-11-25`. Tool names, required inputs, scopes, and security annotations are frozen by a generated contract fixture.

<!-- tool-contract:start -->
| Group | Tools |
| --- | --- |
| Workspaces | `open_workspace`, `list_workspaces`, `resume_workspace` |
| Files | `read`, `write`, `edit`, `search_files`, `list_directory`, `stat_path`, `make_directory`, `move_path`, `copy_path`, `delete_path`, `restore_path`, `read_many`, `apply_patch`, `import_asset` |
| Jobs | `start_job`, `poll_job`, `cancel_job`, `list_jobs` |
| Artifacts | `start_capture`, `inspect_artifact`, `list_artifacts`, `preview_artifact`, `publish_artifact` |
| Service | `devspace_info` |
<!-- tool-contract:end -->

ToolSpan has no terminal, arbitrary shell, MCP-client, gateway, or agent-runtime tool.

## ChatGPT Chat, MCP, and Codex usage

<!-- openai-plan-usage-keys: chat.go,chat.plus,chat.pro5x,chat.pro20x,chat.business,codex.plus,codex.pro5x,codex.pro20x,codex.business,mcp.plus,mcp.pro,mcp.business,mcp.enterpriseEdu -->

Snapshot source: [`config/openai-plan-usage.snapshot.json`](config/openai-plan-usage.snapshot.json)

| Surface | Unit | Safe interpretation |
| --- | --- | --- |
| ChatGPT Chat | ChatGPT Chat messages in a plan-defined window | A chat allowance; not an MCP or Codex allowance |
| MCP | MCP tool call plus the current Host's policy | Host/account capabilities must be tested; a plan label is not a write guarantee |
| Codex | Codex message/task ranges in a published window | Task cost varies; no fixed conversion to Chat messages |

The snapshot checker validates calculations, approved source domains, and English/Chinese key parity without using the network. If `verifiedAt` is more than 30 days old, its rendered view reports `STALE_FALLBACK` and replaces specific quantities with “See current official limits.” See the bilingual [usage note](docs/usage/chatgpt-chat-vs-codex.md).

## Troubleshooting decision tree

```text
Does /healthz fail locally?
├─ Yes → Check Node version, config selection, existing allowed roots, loopback host,
│        password-hash path, state path, and port ownership. Run doctor.
└─ No
   ├─ Does the public /healthz fail?
   │  ├─ Yes → Check HTTPS, DNS/tunnel routing, and Host header. Keep Core on loopback.
   │  └─ No
   │     ├─ Does OAuth discovery/authorization fail?
   │     │  ├─ Yes → Check publicBaseUrl, exact redirect URI, PKCE, requested scopes,
   │     │  │        and client registration. Unknown scopes are rejected.
   │     │  └─ No
   │     │     ├─ Is a filesystem tool denied?
   │     │     │  ├─ Yes → Check workspaceId, relative path, allowedRoots, and links/junctions.
   │     │     │  └─ No
   │     │     │     ├─ Did a job fail to start?
   │     │     │     │  ├─ Yes → Check doctor runner availability and the runner allowlist.
   │     │     │     │  └─ No → Check tool scope, exact contract, job cursor, and artifact state.
```

Do not solve a connection problem by binding to a public address, widening `allowedRoots`, disabling Host/Origin checks, adding a shell, or logging tokens/configuration.

## Development

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run check:contract
npm.cmd run check:brand
npm.cmd run check:version
npm.cmd run check:docs
npm.cmd run check:oss
npm.cmd run check:ci
npm.cmd run check:openai-plan-usage
```

Network audit, external-link freshness, native packaging, real Host compatibility, and real account validation are Release/Owner gates rather than ordinary Core CI checks.

Desktop contributors should follow the [Desktop v0.4 verification guide](docs/development/desktop-verification.md), which keeps deterministic source completion separate from Windows install, tray, and owned-process evidence.

## Contributing, support, and license

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [SUPPORT.md](SUPPORT.md). ToolSpan is licensed under the [Apache License 2.0](LICENSE). The public repository URL, maintainer security contact, and sponsor identity remain Owner Gates and are not invented here.

中文文档见 [README.zh-CN.md](README.zh-CN.md).
