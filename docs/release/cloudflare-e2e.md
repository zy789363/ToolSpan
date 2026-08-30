# Cloudflare 真实 API 端到端验证（安全 runner）

`scripts/e2e-cloudflare.mjs` 只面向固定测试边界：Zone `aiqushi.top`、首选主机名 hostname `mcp.aiqushi.top`（被占用时只允许使用基于 session 生成的 `mcp-e2e-<session>.aiqushi.top`）、Tunnel 名称前缀 `toolspan-e2e-`。它不接受 Zone、hostname、Secret 或确认文本的命令行参数，也不会覆盖来源未知的 DNS/Tunnel。

本 runner 的证据范围是 `API_RESOURCE_LIFECYCLE_ONLY`。即使跨两个独立进程完成 Apply → Reconcile → cleanup 并返回 `PASS`，也不能单独宣称 `CLOUDFLARE_REAL_VALIDATED`；发布门禁仍需结合 cloudflared runtime、公开 HTTPS/OAuth/MCP 验证与 Host E2E。

## Secret 输入边界

runner 读取已被 gitignore 忽略的 `.toolspan-dev/test-environment.json`，只把清单（manifest）中声明的环境变量名称用于当前 Node 进程内查值。Secret value 不进入参数、stdout/stderr、日志、Dry Run、evidence、Prompt、receipt 或诊断。

支持的显式模式：

- `SCOPED_API_TOKEN`：只读取 `apiTokenEnv` 指向的环境变量；
- `UNKNOWN`：返回 `NEEDS_HUMAN_CHECKPOINT / CREDENTIAL_TYPE_SELECTION_REQUIRED`，绝不根据字符串猜类型。

Secret 必须由 Owner 在本地系统设置或 masked UI 中输入。不要把值发到聊天，也不要在命令行中赋值。

## 默认只读预检（preflight）

```powershell
npm run e2e:cloudflare -- --preflight
```

默认命令只执行 GET：

1. 显式 credential 类型与有效性检查；
2. 精确解析 `aiqushi.top` 的 zone/account ID；
3. 读取真实 zone status 与 Cloudflare assigned nameservers；
4. 检查 `mcp.aiqushi.top` 的全部 DNS 类型；若存在未知记录，再检查唯一的 session fallback，避免只查 CNAME 后误覆盖 A/AAAA；
5. 读取 Tunnel 后只把 `toolspan-e2e-` 前缀项纳入脱敏证据；其他 Tunnel 不输出、不修改；
6. 生成带 hash 的脱敏 Dry Run。Plan hash 同时绑定 zone ID、account ID、实际 hostname、目标 Tunnel、当前只读 inspection fingerprint，以及 Tunnel `config_src`、exact ingress、DNS type/content rule/proxied/ttl 等完整变更载荷（mutation payload）。

Zone 不是 `ACTIVE` 时仍保留已完成的只读 DNS/Tunnel 检查，然后以 `ZONE_NOT_ACTIVE` 停止。Zone 不存在或目标 ID 不一致时停止；首选 hostname 被未知 DNS 占用时只切换到固定 session fallback，只有 fallback 也碰撞，或本 session 的 Tunnel 名已有未知资源时才停止。

预期的可继续结果不是外部门禁 PASS，而是：

```text
status   = NEEDS_HUMAN_CHECKPOINT
decision = DRY_RUN_READY
reason   = CHECKPOINT_CLOUDFLARE_APPLY
```

## 应用操作（Apply）与一次性确认

Apply 有两层显式闸门：

1. 非秘密开关 `TOOLSPAN_E2E_ENABLE_APPLY=1`；默认未设置；
2. 同一进程、交互式 stdin 中输入 runner 刚生成的一次性确认文本。确认文本绑定 session、完整 Dry Run hash 和随机 nonce，不能通过参数或环境变量预置。

Owner 审阅 Dry Run 后，才可在 PowerShell 中运行：

```powershell
$env:TOOLSPAN_E2E_ENABLE_APPLY = "1"
npm run e2e:cloudflare -- --apply
Remove-Item Env:\TOOLSPAN_E2E_ENABLE_APPLY
```

上述命令不含 Secret。runner 会在第一笔写入前重新查询目标，并要求重新计算的完整 plan hash 与已经确认的 hash 完全一致；任何 zone/account/inspection race 都会停止。写操作只允许：

- 创建本 session 的 `toolspan-e2e-<session>` Tunnel；
- 配置该新 Tunnel 的实际选定 hostname（首选或 session fallback）`→ http://127.0.0.1:8787` ingress；
- 在确认该实际 hostname 的 DNS 仍为空后创建指向该 Tunnel 的 CNAME。

Apply 在每笔 mutation 前后都把脱敏状态原子写入固定 session receipt。成功 Apply **不会**在同一进程内执行 second run 或 cleanup，而是以以下 checkpoint 停止：

```text
status   = NEEDS_HUMAN_CHECKPOINT
decision = RECONCILE_REQUIRED
reason   = SECOND_INVOCATION_REQUIRED
```

POST/PUT/DELETE 都不会自动重放。即使 HTTP 为 2xx，变更响应（mutation response）缺少 exact config/ID、语义与请求不一致，或无法可靠解析，也按不确定结果处理：receipt 记录 `OUTCOME_UNKNOWN`，decision 为 `RECONCILE_REQUIRED`；后续只读 reconcile 不会凭名称采用资源，也不会盲目重试。

## 独立协调（Reconcile）/ 第二次调用

从 Apply 输出取得非秘密 `sessionId`，在新的 Node 进程中运行：

```powershell
npm run e2e:cloudflare -- --reconcile <sessionId>
```

CLI 只接受固定格式的 session ID；receipt 路径始终由 runner 在 `.toolspan-dev/evidence` 内推导，不接受任意文件路径。Reconcile 加载并校验 schema v2 receipt、plan hash、固定 target、ID 和 fingerprint；Apply 时的 zone/plan/ownership identity 保持不可变，当前只读结果另存为 `reconcileZone` / `reconcile*Inspection`，临时 PENDING/缺失不会破坏后续恢复。second-run 阶段只执行 GET，重新读取 Zone、DNS、Tunnel 与 ingress；Tunnel 必须仍是本 session 的 exact desired name，DNS 必须仍是指向该 Tunnel 的 exact proxied CNAME 且 TTL 为 1。只有这些语义全部匹配，且该阶段的 mutation delta 为 `0`，`secondRun.status` 才能为 `PASS`。不请求 cleanup 时仍返回 `OWNED_CLEANUP_PENDING`；请求 cleanup 时也只会在 second-run PASS 和独立确认之后进入 DELETE 阶段。

如果 receipt 停在变更前的崩溃检查点（crash checkpoint），或记录 `OUTCOME_UNKNOWN`，Reconcile 仍会只读检查实际状态，但保持 fail-closed：不重放、不采用、不删除。

已经 `PASS / COMPLETE` 的 cleanup receipt 再次 Reconcile 时只用 GET 确认两个 owned ID 仍不存在；确认成功保持 PASS，不再提示或删除。若临时无法复核，当前调用不会降级覆盖原有权威 PASS receipt。

Apply 后必须由上述独立 Reconcile 调用（invocation）真实重新读取 Zone/DNS/Tunnel/config，要求 duplicate create 为 `0`。未清理时结果为 `OWNED_CLEANUP_PENDING`，不会虚构生命周期完成。

## Reconcile 中的仅限自有资源清理（owned-only cleanup）

cleanup 只能附加到独立的 Reconcile 调用（invocation）：

```powershell
npm run e2e:cloudflare -- --reconcile <sessionId> --cleanup-after-verify
```

cleanup 需要与 Apply 无关的全新随机 nonce，并要求在当前 Reconcile 进程的交互式 stdin 中精确输入；确认文本不能由参数或环境变量预置，且只消费一次。其 confirmation hash 绑定 zone/account、实际 hostname、expected ingress，以及每个 owned resource 的 ID 与 fingerprint。确认后、删除前，runner 再次读取资源与 ingress；删除 owned DNS 后，还会再次读取 zone、Tunnel identity、DNS 空状态和 ingress，确认没有 race 才删除 Tunnel。任一 fingerprint、语义或 ingress 改变都会停止。每笔 DELETE 都要求响应返回 exact ID，并原子 checkpoint；不确定结果绝不重放。已发生部分删除但后续明确停止时保留 receipt/deleted history，并返回 `PARTIAL_CLEANUP_REQUIRES_MANUAL_RECONCILE`。其他 `toolspan-e2e-` Tunnel 只记录为 `UNKNOWN_UNTOUCHED`，绝不删除。

## 脱敏证据

每次运行在写文件前执行两次结构化 Secret 扫描，输出到：

```text
.toolspan-dev/evidence/cloudflare-e2e-<session>.json
```

目录已由 `.gitignore` 排除。同一个固定路径既是当前脱敏 evidence，也是可抗崩溃的 receipt；写入采用同目录临时文件后原子重命名（atomic rename）。它只包含固定目标、非秘密 ID/fingerprint、status、nameserver、资源类型/所有权分类、planned/applied action、checkpoint、HTTP status/Cloudflare 数字错误码以及 second-run/cleanup 结果；不包含 header、请求/响应 body、Cloudflare message、email 或任意 Secret value。格式由 `schemas/cloudflare-e2e-evidence.schema.json` v2 固定。

这里的 schema 校验和原子重命名（atomic rename）只防格式漂移、半写文件与 runner 自身误操作，不是签名，也不构成对同一 Windows 用户、本地管理员、junction/reparse point 或并发进程的防篡改保证。`.toolspan-dev/evidence` 必须保持为 Owner 控制的普通本地目录；同一 session 不得并发运行 Apply/Reconcile。发现 receipt/schema/identity 不一致、cleanup 非终态或 mutation response 不确定时，CLI 一律 fail-closed，不继续 cleanup。

CLI 退出码不混淆成功、外部阻塞与人工检查点（checkpoint）：

```text
PASS = 0
FAIL = 1
BLOCKED_BY_ENVIRONMENT / BLOCKED_BY_EXTERNAL_ACCOUNT = 2
NEEDS_HUMAN_CHECKPOINT = 3
```

专项 mock 验证命令（focused mock）：

```powershell
node --test scripts/tests/cloudflare-e2e.test.mjs
```

它覆盖 UNKNOWN 不猜测、Global email-before-Key、Scoped/Global auth header、非 Active Zone 与恢复、未知 collision、默认禁止 Apply、错误确认零写入、atomic crash checkpoint、真实第二次 invocation 的零 POST/PUT、2xx mutation response shape、unknown outcome 不重放/不采用、ownership substitution、两次 DELETE 之间的 race、partial cleanup receipt 保留，以及 evidence Secret scan。
