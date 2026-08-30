# Release Host 端到端验证

本页说明 `E-HOST-01` 的本地确定性协议验证，以及它与真实 Codex 远程 Host 门禁的边界。

## 运行命令

```powershell
npm run e2e:mcp-inspector
npm run e2e:host:local
```

两个命令都会重新构建项目、执行 `npm pack`、把 tarball 安装到隔离临时目录，并从安装后的 `dist/main.js` 启动 ToolSpan。它们不会直接从源码导入 Runtime，也不会连接 Cloudflare 或修改外部资源。

默认脱敏证据分别写入：

```text
.toolspan-dev/evidence/release-e-host-01.json
.toolspan-dev/evidence/release-host-local.json
```

`.toolspan-dev/` 已被 gitignore 忽略。证据符合 `schemas/release-evidence.schema.json`，不包含本机绝对路径、密码（password）、OAuth code、PKCE verifier、access token、refresh token 或 Authorization header。

## Inspector 与固定 SDK 的证据边界

Harness 首先对打包后的本地 Server 真实运行官方 `@modelcontextprotocol/inspector@latest` v2 CLI：

```text
mcp-inspector --cli <loopback-mcp-url> --transport http \
  --method tools/list --format json --stored-auth-only
```

该负向 smoke 不传 `--header`、token、client secret 或任何 stored auth。OAuth state 与 client config 路径指向隔离临时目录；预期结果必须为 JSON `auth_required`、退出码 3，且目录仍为空。这证明 Inspector 能到达打包后的 ToolSpan OAuth 保护边界。

随后，同一 Inspector 版本使用只含 loopback URL、transport 与 scope 名称的临时只读 server config 执行 Authorization Code + PKCE。Harness 只在当前 Node 进程内截获 Inspector 生成的授权 URL，以内存中的 synthetic Owner password 提交 loopback consent，再访问 Inspector 自己的 callback。Password 不进入 Inspector 参数、环境变量、浏览器控制指令、日志或 evidence。官方 CLI 随后通过临时 stored auth 执行 exact 27、read、`apply_patch`、allowlisted job 与 read-only 写拒绝。

Inspector 的两个 `oauth.json` 只存在于随机 `%TEMP%/toolspan-release-e2e-*` 目录：一个 full-scope session、一个 read-only session。Harness 不读取其中的 token value；无论成功或失败，都在 `finally` 中删除整个受控临时根目录并验证不存在。项目固定的官方 `@modelcontextprotocol/sdk@1.30.0` 仍执行同一完整协议链，作为打包产物与细粒度 `mcp/www_authenticate=insufficient_scope` 的辅助证据。

## 被验证的协议链

1. 官方 Inspector latest v2 CLI 在无凭证时，`tools/list` 必须返回 `auth_required` / exit 3，且不写 auth store；
2. 官方 Inspector 以 Authorization Code + PKCE 完成 full-scope loopback OAuth；
3. 官方 Inspector 的 `tools/list` 必须一次返回 exact 27 Tool Contract；
4. 官方 Inspector 调用 `devspace_info` 并读取 fixture `README.txt`；
5. 官方 Inspector 的 `apply_patch` dry run 不得改文件，授权 apply 必须修改并能通过 MCP readback 观察；
6. 官方 Inspector 通过 `npm` allowlisted runner 启动固定 job，并持续 `poll_job` 直到 completed；
7. 官方 Inspector 的独立 read-only session 调用 `apply_patch` 必须返回 `tool_is_error`，且 fixture digest 不变；
8. SDK 辅助链再次验证 OAuth discovery、PKCE、`2025-11-25`、exact 27、read/write/job，并确认 read-only tool result 的 `_meta` 含 `insufficient_scope`；
9. 恢复 fixture，并删除、复核两个 Inspector 临时 auth store；
10. 生成闭集 `.toolspan-dev/evidence/external/E-HOST-01.json`。

## Fixture 隔离证明

合成配置（synthetic config）的唯一 `allowedRoots` 条目是：

```text
tests/e2e-fixtures/remote-workspace
```

测试同时执行三项证明：

- 尝试打开外围仓库根目录必须失败；
- `writable.txt` 的直接 digest 与 MCP readback 都必须观察到修改；
- 外围 `README.md` sentinel 的 digest 必须保持不变。

Owner 密码（password）由 harness 在内存中生成，只通过 stdin 交给打包后的 `password:init`；磁盘只保存 bcrypt hash。OAuth consent 必须把 password 发送到 loopback form，但不会把它放进命令行、配置、日志或 evidence。启动 Server 时使用非秘密环境变量 allowlist，因此 `CloudFlareAPIKEY` 等外部 credential 不会被子进程继承。

## 门禁说明（Gate）

- `E-HOST-01 = PASS`：Inspector 2.3.0 已真实完成临时 OAuth、initialize、exact 27、read/write/job 与 read-only 写拒绝；闭集 evidence 由 Release verifier 独立校验。
- `E-CODEX-01 = PASS`：Codex CLI 0.149.0-alpha.4.1 通过临时 HTTPS Quick Tunnel 与 OAuth/DCR 连接合成 ToolSpan，真实完成 exact 27、read、`apply_patch`、job 与 readback；远程 remote digest 改变、本地 local fixture digest 不变，且 OAuth/MCP 配置、Tunnel、进程、workspace 与下载 binary 全部清理。

不得用 SDK full PASS 或 Inspector auth-boundary PASS 宣称 `E-HOST-01` 完成；Codex remote write 也只有闭集 `E-CODEX-01` proof 通过 Release verifier 后才算完成。
