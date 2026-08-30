# E-CF-WIN-01 — Windows cloudflared service 生命周期验证（管理员 VM）

> **门禁：** `E-CF-WIN-01` — Windows cloudflared service 的安装、启动、重启、卸载（install/start/reboot/uninstall）均已验证。
> **类型：** `native`。仅在宣传 "Windows one-click" 时作为发布（Release）条件激活。
> **当前状态：** `BLOCKED_BY_ENVIRONMENT`。需要一台可丢弃的 Windows 11 x64 管理员 VM。
> **证据格式：** 日期化、脱敏闭集 JSON（`schemaVersion` / `requirementId` / `status` / `observedAt` / `sanitized` / `secretValues` + `proof`），写入 `.toolspan-dev/evidence/external/E-CF-WIN-01.json` 后运行 `npm run verify:release` 复核。

---

## 1. 目的

证明 ToolSpan 的 cloudflared service 服务管理在真实 Windows 上满足：

1. **安装**：`cloudflared service install` + ingress 配置 + Automatic 启动类型 + 启动；
2. **持久性**：Windows 重启后 service 仍存在且为 Running + Automatic；
3. **安全卸载**：只卸载本 session 安装、ownership 可证明的 service；
4. **无关服务保持**：安装/卸载前后除 `cloudflared` 外无任何 service 变化；
5. **不按端口杀进程**：脚本不得出现 stop-process / taskkill / 按 PID 终止逻辑；
6. **Secret 数量 0**：证据不包含任何 token/key/password。

这些要求在源码侧已由以下脚本实现，并被 `scripts/tests/cloudflared-service-lifecycle.test.mjs` 静态冻结：

```text
scripts/cloudflared-service-lifecycle.ps1     # 分阶段生命周期验证 + 证据输出
scripts/uninstall-cloudflared-service.ps1     # 安全卸载（ownership 可证明才卸载）
scripts/install-cloudflared-service.ps1       # 安装 + ownership 记录（已配对）
```

---

## 2. 前置条件

```text
Windows 11 x64 管理员 VM（可丢弃，勿用生产机）
已安装 Node 22.17+ 或 24（ToolSpan 运行时所需）
ToolSpan 项目 checkout（本仓库，当前版本 0.6.0）
官方 cloudflared.exe（Windows amd64，签名来源已验证）
一份本地 cloudflared config（含真实 Tunnel ID 与 credentials-file 路径）
```

cloudflared 获取方式建议与 `scripts/e2e-cloudflare-public.mjs` 一致：从 Cloudflare 官方 GitHub release 下载，校验 SHA-256 后，放在项目内 `.toolspan-dev/bin/`。

---

## 3. 分阶段执行

在管理员 PowerShell 中，进入项目根目录后按顺序执行。所有命令都在 **管理员** 会话中运行。

### 3.1 预检（Preflight）

```powershell
.\scripts\cloudflared-service-lifecycle.ps1 -Phase preflight
```

预期输出 JSON 信封（envelope）：

```json
{
  "phase": "preflight",
  "status": "PASS",
  "requirementId": "E-CF-WIN-01",
  "sanitized": true,
  "secretValues": 0,
  "proof": {
    "kind": "CLOUDFLARED_SERVICE_PREFLIGHT",
    "admin": true,
    "cloudflared": { "present": true, "version": "2026.8.2", "sha256": "c29e...57b5" },
    "service": null
  }
}
```

- `admin` 必须为 `true`；
- `cloudflared.present` / `version` / `sha256` 必须非空；
- `service` 为 `null`（该 VM 上不得已有 cloudflared service）。
- 若输出 `BLOCKED_BY_ENVIRONMENT`，按 `reasons` 补齐环境后再继续；不得跳过本阶段继续安装。

### 3.2 安装（Install）

```powershell
.\scripts\cloudflared-service-lifecycle.ps1 -Phase install -CloudflaredPath .\.toolspan-dev\bin\cloudflared.exe -ConfigPath .\deploy\cloudflared\config.example.yml
```

预期：

```json
{
  "phase": "install",
  "status": "PASS",
  "proof": {
    "kind": "CLOUDFLARED_SERVICE_INSTALL",
    "installPassed": true,
    "runningAfterInstall": true,
    "startupTypeAfterInstall": "Automatic",
    "ownershipFile": "...\\.toolspan-dev\\cloudflared-service-ownership.json",
    "beforeSnapshot": { "count": 83 },
    "afterService": { "exists": true, "running": true }
  }
}
```

- `runningAfterInstall: true` 且 `startupTypeAfterInstall: "Automatic"`；
- ownership 文件已生成（这是后续卸载的证明依据）；
- 若输出 `BLOCKED_BY_ENVIRONMENT` 且 `reasons=["EXTERNAL_SERVICE_PRESERVED"]`，说明 VM 上已有外部 cloudflared service，应换一台干净 VM。

### 3.3 重启（Reboot）+ 持久性验证

保持 ownership 文件不动，**重启 VM**。重启后重新打开管理员 PowerShell，进入项目根目录：

```powershell
.\scripts\cloudflared-service-lifecycle.ps1 -Phase reboot-persistence
```

预期：

```json
{
  "phase": "reboot-persistence",
  "status": "PASS",
  "proof": {
    "kind": "CLOUDFLARED_SERVICE_REBOOT_PERSISTENCE",
    "serviceAfterReboot": { "exists": true, "running": true, "startup": "Automatic" },
    "ownershipBound": true,
    "unrelatedServiceSnapshot": { "count": 83 }
  }
}
```

- `serviceAfterReboot.exists: true` 且 `running: true`、`startup: "Automatic"` —— 证明重启后服务自愈；
- `ownershipBound: true` —— 服务与本次 session 的 ownership 记录绑定。

### 3.4 验证（Verify，可选中间检查）

```powershell
.\scripts\cloudflared-service-lifecycle.ps1 -Phase verify
```

确认 service 处于 Running 状态且 ownership 已绑定。

### 3.5 卸载（Uninstall）

```powershell
.\scripts\cloudflared-service-lifecycle.ps1 -Phase uninstall -CloudflaredPath .\.toolspan-dev\bin\cloudflared.exe
```

预期：

```json
{
  "phase": "uninstall",
  "status": "PASS",
  "proof": {
    "kind": "CLOUDFLARED_SERVICE_UNINSTALL",
    "removed": true,
    "unrelatedServicePreserved": true,
    "unrelatedServiceComparison": { "equal": true, "beforeCount": 83, "afterCount": 83, "added": [], "removed": [] },
    "ownershipFileRemoved": true
  }
}
```

- `removed: true` —— cloudflared service 已删除；
- `unrelatedServicePreserved: true` 且 `added/removed` 均为空 —— 无关服务零影响；
- `ownershipFileRemoved: true` —— ownership 记录已清理。

---

## 4. 产出闭集证据并交给 verify:release

在项目根目录手工组装（或由执行脚本生成）`docs/release/windows-cloudflared-service-validation.md` 的配套证据：

```json
{
  "schemaVersion": "1.0",
  "requirementId": "E-CF-WIN-01",
  "status": "PASS",
  "observedAt": "2026-08-23T00:00:00Z",
  "sanitized": true,
  "secretValues": 0,
  "proof": {
    "kind": "CLOUDFLARED_SERVICE_LIFECYCLE",
    "toolSpanVersion": "0.6.0",
    "cloudflaredVersion": "2026.8.2",
    "cloudflaredSha256": "c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5",
    "hostOs": "Windows 11 Pro x64",
    "adminVm": true,
    "installPassed": true,
    "startPassed": true,
    "startupType": "Automatic",
    "rebootPersistencePassed": true,
    "uninstallPassed": true,
    "unrelatedServiceDelta": 0,
    "serviceCountBefore": 83,
    "serviceCountAfter": 83,
    "noPortOrProcessKill": true
  }
}
```

将上述对象写入 `.toolspan-dev/evidence/external/E-CF-WIN-01.json`（该目录已被 `.gitignore` 覆盖），然后运行：

```bash
npm run verify:release
```

当 `verify:release` 输出 `releaseReady: true`（需同时满足其他必需门禁）时，`E-CF-WIN-01` 即视为 PASS。

---

## 5. 失败分支与安全边界

| 情况 | 行为 |
|---|---|
| 非管理员运行 | 输出 `BLOCKED_BY_ENVIRONMENT`，`reasons=["ADMIN_REQUIRED"]`，不执行任何操作 |
| VM 已有外部 cloudflared service | install 阶段输出 `EXTERNAL_SERVICE_PRESERVED`，**不覆盖**，改用干净 VM |
| 无 ownership 记录尝试卸载 | 输出 `OWNERSHIP_NOT_PROVABLE`，拒绝卸载外部 service |
| 卸载后无关服务有变化 | `unrelatedServicePreserved: false`，视为 FAIL，需人工排查 |
| reboot 后 service 消失 | `reboot-persistence` 失败，不能声明 PASS |

安全不变量（与 `00_MASTER_GOAL.md` 一致）：

- 不按端口杀进程、不按进程名批量终止；
- 管理/运行凭证不进入 config、日志、Prompt、receipt、证据；
- 只卸载 ownership 可证明的 service；外部 service/Tunnel/DNS 永不自动删除；
- 不创建 tag、不发布、不调用外部账号。

---

## 6. 完成后

- 将本文件的日期化执行记录与证据摘要附入 `docs/release/release-gates.md` 的 E-CF-WIN-01 行；
- 若产品停用 "Windows one-click" claim，可把 `WINDOWS_ONE_CLICK_CLAIM` 置为 inactive，使该门禁不再阻塞（由 `verify:release` 的 claim policy 机制处理）；
- 清理：卸载后确认 VM 上无残留 cloudflared service、无 ownership 文件、无 token。

---

## 7. 已知问题与规避（实测记录）

**cloudflared 2026.8.2 以 agent 模式安装服务，`Restart-Service` / `Stop-Service` 可能永久卡在 `StopPending` 假死状态**（服务进程已退出但 SCM 状态不刷新）。实测于 2026-08-23 腾讯云 Windows Server VM。

- **症状**：install 阶段执行 `Restart-Service -Name cloudflared` 后无限输出 "正在等待服务停止…"，脚本挂起。
- **根因**：新版 cloudflared agent service 对停止请求不响应，SCM 在等待超时前一直保持 `StopPending`。
- **规避（已内置到脚本）**：
  - install/verify 阶段不再使用 `Restart-Service`，改用 `Start-CloudflaredService`（已 Running 则跳过；未运行则通过 30s 有界 Job 启动）；
  - uninstall 阶段使用 `Stop-CloudflaredServiceBounded`（45s 有界 Job），超时后记录 WARNING 并继续 `service uninstall`，脚本不会挂死；
  - install 证据新增 `boundedStartConfirmed` 字段如实反映有界启动结果。
- **人工兜底**：若执行期间服务仍卡在 `StopPending`（重启后通常自动恢复），重启 VM 后重新运行对应 phase 即可；`Automatic` 启动类型会在重启后自愈。
- **占位 config 说明**：`deploy/cloudflared/config.example.yml` 使用占位 tunnel ID（`00000000-...`），`tunnel run` 启动后连接会失败重试；这是验证 service 生命周期（install/start/reboot/uninstall + 无关服务保全）的可接受状态，`runningAfterInstall` 如实反映即可，不影响本 gate 结论。
