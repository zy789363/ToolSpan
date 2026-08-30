# Scoped API Token 自动配置路径

Scoped API Token 是默认推荐的 Cloudflare 自动配置方式。权限标签来自 `config/cloudflare-api-docs.snapshot.json`；普通 CI 只验证 schema、Mock 与 stale fallback，不联网断言权限名称仍然当前。Release 或真实 E2E 前必须重新打开 snapshot 中的官方文档核验。

## 凭证边界（Credential 边界）

- 在 masked field 处暂停，由 Owner 在本地输入；不要把值发到聊天、Prompt、命令行、环境清单或截图中。
- Token 只在当前受控 process/session 的内存中存在；不进入 config、DB、journal、log、receipt、diagnostics 或 crash report；没有 Remember。
- request/error tracing 必须删除 `Authorization` header 与任何反射值。
- `.toolspan-dev/test-environment.json` 只能保存 capability、ID 和 Secret 环境变量名，不能保存值。

## 流程

1. `verify only`：只验证 credential 以及可访问的 account/zone，不写远程资源。
2. 选择 account 和 `aiqushi.top`，读取 Zone status。若 Zone 缺失或 Pending，则执行 `STOP_APPLY` 并进入 nameserver onboarding。
3. 验证本地 Core health、loopback MCP 与当前实例。
4. 读取 Tunnel、ingress、DNS 现状，生成 Dry Run；分类 created、reused、updated、untouched 与 collision。
5. 用户检查 Dry Run 并确认 `CLOUDFLARE_APPLY`；在此之前外部副作用为 0。
6. 创建或复用 Tunnel；非幂等 create 不盲目重放。对 GET 或幂等操作只按 `Retry-After` 做有限重试。
7. 更新 owned ingress，保留 catch-all；创建或复用 DNS，遇到未知记录冲突时停止。
8. 将运行凭证直接交给官方 `cloudflared` 机制，不写入 ToolSpan 持久层。
9. 原子更新 `publicBaseUrl`，依次验证 public health、OAuth metadata、MCP 初始化和 27/27 tools。
10. 写入非秘密 receipt，立即丢弃管理 Token；第二次运行必须 duplicates = 0。

失败或 crash 后，不得凭旧 credential 或旧假设继续写入。没有 credential 时进入 `NEEDS_CREDENTIAL_REENTRY`；需要远程 reconcile 或 rollback 时，由 Owner 再次在本地 masked field 输入。
