# Cloudflare 引导式手册

这条路径不要求把 Cloudflare 管理凭证交给 ToolSpan。用户在 Cloudflare Dashboard 和本机官方 `cloudflared` 流程中操作，ToolSpan 只展示非秘密状态、URL 与检查结果。示例目标固定为 `aiqushi.top` / `mcp.aiqushi.top`；若使用其他域名，必须明确重新选择，不能让 Agent 自行替换。

每一步都包含目的、操作、预期结果、失败分支和回滚/恢复。任何一步没有得到预期结果都先停止，不跳过门禁。

## 1. 本机健康检查

- **目的：** 证明 Headless Core 在 loopback（本机回环地址）上可用，并且本地端口与当前实例一致。
- **操作：** 启动 ToolSpan；在 Desktop 中读取本地 endpoint，或对 `http://127.0.0.1:<port>/healthz` 发起 GET。通过 Desktop Host 的已授权状态确认 `instanceName`，不要从公开 `/healthz` 期待实例名。
- **预期结果：** HTTP 200；响应只含 `service`、`status`、`version`，且 `status` 为 `ok`。本地 MCP endpoint 是同一 loopback origin 的 `/mcp`。
- **失败分支：** 连接拒绝时检查 Core 是否启动、端口是否一致；Host/Origin 拒绝时不要放宽 allowlist；端口冲突时在本地配置中显式更换端口。
- **回滚/恢复：** 只停止本次启动且 ownership 可证明的 ToolSpan 进程；不得按端口杀进程。修复后从本步骤重试。

## 2. 域名 / Zone

- **目的：** 证明目标域名已位于正确的 Cloudflare account 中，并且 Zone 确实可用于代理流量。
- **操作：** 在 Dashboard 中选择 `aiqushi.top`，记录非秘密的 account ID、zone ID、zone status 与 Cloudflare assigned nameservers；检查 `mcp.aiqushi.top` 是否已有 DNS 记录。
- **预期结果：** Zone 存在且 status 为 `Active`；未知来源的同名 DNS 记录为 0，或已明确标为冲突并停止。
- **失败分支：** Zone 缺失或 `Pending Nameserver Update` 时禁止 Apply，转到 [Zone 接入指南](cloudflare-zone-onboarding.md)。状态为 Moved、Deleted 或 Initializing 时也停止，并按 Cloudflare 官方说明处理。
- **回滚/恢复：** 本步骤只读，外部副作用为 0。不删除其他 account/zone，不修改 registrar credential。

## 3. 创建或选择 Tunnel

- **目的：** 获得一个专用于当前 ToolSpan instance 的 Named Tunnel，同时避免与外部资源冲突。
- **操作：** 在 Cloudflare Dashboard 中创建以 `toolspan-` 为前缀、可识别 instance 的 Tunnel；若同名 Tunnel 已存在，先核对 receipt/journal 中的 ID 和 ownership，无法证明时视为 external collision。
- **预期结果：** 新建 Tunnel 分类为 `created`，或由既有 ToolSpan receipt 证明的 Tunnel 分类为 `reused`；记录 Tunnel ID/name，但不记录任何运行 token。
- **失败分支：** 同名但 ID/ownership 不符、API/UI 返回冲突、账号不匹配时停止，不自动删除或改名重试。
- **回滚/恢复：** 只有本 session 的创建响应和 journal 同时证明资源为 `created`，才可在已确认的 rollback 中删除；`reused` 永不自动删除。

## 4. 将 hostname 路由到本地 Core

- **目的：** 将 `mcp.aiqushi.top` 的 Tunnel ingress 指向 `http://127.0.0.1:<port>`，避免无意暴露其他本地服务。
- **操作：** 在 Tunnel 的 Public Hostname/ingress 中设置唯一目标 hostname 和本地 loopback service；保留明确的末尾 catch-all（例如 HTTP 404），不要使用 `0.0.0.0`、LAN IP 或任意 URL。
- **预期结果：** ingress 只包含所需 hostname → loopback ToolSpan service，以及安全 catch-all；已记录 pre-change 非秘密 fingerprint。
- **失败分支：** 现有 ingress 来源未知、指向不同端口/服务、或缺少可验证的 precondition 时停止；不要覆盖整个配置。
- **回滚/恢复：** 仅在 fingerprint 仍匹配时恢复本 session 修改前的 ingress；不匹配时进入 `ROLLBACK_PARTIAL`，并给出人工步骤。

## 5. DNS

- **目的：** 让目标 hostname 解析到选定 Tunnel，同时保留外部 DNS 所有权边界。
- **操作：** 使用 Cloudflare Tunnel 的 Public Hostname 流程或官方 DNS 指引创建 `mcp.aiqushi.top` 对应记录。先读取现有记录；只有记录由本 session 创建或 receipt 证明 owned 才能更新。
- **预期结果：** 新记录分类为 `created`，完全匹配的 owned 记录分类为 `reused`；第二次运行重复记录数为 0。
- **失败分支：** 任意同名但类型、目标、owner 标记或 fingerprint 不匹配的记录均为 DNS conflict；停止，不覆盖、不删除。
- **回滚/恢复：** 本 session 创建的记录可在确认后删除；reused 记录不删；owned 更新仅在 precondition fingerprint 匹配时恢复。

## 6. 安装 / 运行 cloudflared

- **目的：** 使用 Cloudflare 官方 runtime，把 Named Tunnel 连接到本机 ToolSpan。
- **操作：** 从 Cloudflare 官方来源核对 `cloudflared` 版本；选择 foreground test 或 service。需要管理员权限时显示 UAC checkpoint 并暂停。运行凭证只能进入官方 `cloudflared` credential/service storage，不得粘贴到 ToolSpan。
- **预期结果：** foreground 连接健康，或 service 的创建/ownership/运行状态被明确验证；ToolSpan config、DB、journal、日志、Prompt 与 receipt 中运行凭证数量为 0。
- **失败分支：** 没有管理员权限时只输出人工步骤，不声称 service installed；已有外部 service 时不接管；错误日志必须 redacted。
- **回滚/恢复：** 只停止或卸载本 session 安装且 ownership 可证明的 service。卸载 ToolSpan 不自动删除外部 Tunnel。轮换见 [运行凭证指南](cloudflared-runtime-credential.md)。

## 7. 公网健康检查

- **目的：** 证明配置的 HTTPS hostname 经 Tunnel 到达当前 ToolSpan，而不是测试任意 URL。
- **操作：** 只对当前配置的 `https://mcp.aiqushi.top/healthz` 发起受限 GET；拒绝 userinfo、非 HTTPS、私网目标、跨 hostname 跳转和 HTTPS→HTTP 降级，并限制 redirect 次数与响应大小。
- **预期结果：** HTTP 200，最小 health body 与本地版本一致；URL 的最终 origin 仍是配置 hostname。
- **失败分支：** DNS/TLS/502/超时分别记录；不要用任意 URL 调试器扫描其他目标，也不要因验证失败放宽 Host/Origin 安全边界。
- **回滚/恢复：** 先保持资源不变并检查 cloudflared / DNS；若确认本 session 的变更有误，再进入受控 rollback。

## 8. OAuth 元数据

- **目的：** 证明 Agent Host 能发现 ToolSpan OAuth metadata，并且 resource 指向公开 `/mcp`。
- **操作：** 读取 `https://mcp.aiqushi.top/.well-known/oauth-protected-resource` 与 `https://mcp.aiqushi.top/.well-known/oauth-authorization-server`；检查 issuer/resource/registration endpoint 使用同一 HTTPS origin。
- **预期结果：** metadata 可解析，resource 精确为 `https://mcp.aiqushi.top/mcp`；没有 owner hash、token、真实路径或无关账号信息。
- **失败分支：** origin 不一致、HTTP URL、路径错误或 metadata 缺失时停止 Host 添加流程；修复 `publicBaseUrl` 时用原子更新，不手改安全测试。
- **回滚/恢复：** 若本 session 更新了 `publicBaseUrl` 且外部验证失败，按 journal 恢复原值；不导出 OAuth code/token。

## 9. Host 扫描与精确 27 个工具

- **目的：** 证明协议初始化、OAuth、工具发现及 exact 27 Tool Contract 在真实 Host 上成立。
- **操作：** 先用 MCP Inspector 对公开 `/mcp` 执行初始化、列出并抽样调用工具；再在实际可用 Host 中添加连接。执行写操作前调用 `devspace_info`，确认 `instanceName`、workspace 与 allowed roots。
- **预期结果：** 工具总数恰好 27，名称/输入 schema 与冻结 fixture 一致；只读验证与受控写验证分别留存非秘密证据。
- **失败分支：** 工具不是 27、OAuth consent 未完成、Host 套餐或策略受限，或 write 不可用时，不修改契约。ChatGPT 受限时记 `BLOCKED_BY_HOST_PLAN_OR_POLICY`；由 Codex 承担真实 write/job gate。
- **回滚/恢复：** 撤销测试 OAuth grant、清理由验证创建且 ownership 可证明的 synthetic workspace 资源；保留非秘密 evidence，不删除用户数据。

## 完成证据

引导式手册（Guided Manual）完成不等于外部 Gate 自动 PASS。记录真实命令或页面、时间、非秘密资源 ID、27/27 结果、rollback 状态和 blocker 分类；不得写“预计通过”。管理凭证持久化必须为 0，第二次执行的重复资源必须为 0。
