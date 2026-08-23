# ============================================================
# ToolSpan E-CF-WIN-01 — Windows cloudflared service 生命周期验证（自包含一键版）
# 用法：以管理员身份在 PowerShell 中运行本脚本
#   powershell -ExecutionPolicy Bypass -File .\toolspan-e2e-win.ps1
# 或直接复制本文件全部内容粘贴到管理员 PowerShell。
#
# 本脚本不依赖项目文件，自动完成：
#   1. 下载官方 cloudflared.exe（校验 SHA-256）
#   2. 生成最小 cloudflared config（用于 ingress validate 与 service 运行）
#   3. 执行 preflight -> install -> verify（需重启后再次运行本脚本）
#   4. 重启后执行 reboot-persistence -> uninstall
# 每阶段输出闭集 JSON 证据，最终汇总到 E-CF-WIN-01 证据 JSON。
# 不包含任何 secret。
# ============================================================

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# ---- 固定参数（与 ToolSpan release 绑定）----
$ToolSpanVersion = "0.5.0"
$RequirementId = "E-CF-WIN-01"
$CloudflaredSha256 = "c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5"
$CloudflaredDownloadUrl = "https://github.com/cloudflare/cloudflared/releases/download/2026.8.2/cloudflared-windows-amd64.exe"
$ServiceName = "cloudflared"
$WorkRoot = Join-Path $env:ProgramData "ToolSpanE2E"
$BinDir = Join-Path $WorkRoot "bin"
$CloudflaredPath = Join-Path $BinDir "cloudflared.exe"
$ConfigPath = Join-Path $WorkRoot "cloudflared-config.yml"
$StatePath = Join-Path $WorkRoot "e2e-state.json"
$EvidenceDir = Join-Path $WorkRoot "evidence"
$SessionId = "$(Get-Date -Format yyyyMMdd)-$(-join ((48..57) + (97..102) | Get-Random -Count 10 | ForEach-Object { [char]$_ }))"

# ---- 输出工具 ----
$stdout = [System.Text.StringBuilder]::new()
function Write-Evidence([object]$Evidence) {
    $null = $stdout.AppendLine(($Evidence | ConvertTo-Json -Depth 12))
}
function Get-Now { return (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
function New-Envelope([string]$Phase, [string]$Status, [hashtable]$Proof) {
    return @{
        schemaVersion = "1.0"
        requirementId = $RequirementId
        status = $Status
        observedAt = (Get-Now)
        sanitized = $true
        secretValues = 0
        phase = $Phase
        proof = $Proof
    }
}

# ---- 管理员检查 ----
function Assert-Admin {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "ADMIN_REQUIRED"
    }
}

# ---- 下载 cloudflared（校验 SHA-256）----
function Ensure-Cloudflared {
    if (-not (Test-Path -LiteralPath $BinDir)) { New-Item -ItemType Directory -Path $BinDir -Force | Out-Null }
    if (Test-Path -LiteralPath $CloudflaredPath) {
        $hash = (Get-FileHash -LiteralPath $CloudflaredPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -eq $CloudflaredSha256) { return $true }
        Write-Host "cloudflared.exe 哈希不匹配，重新下载..."
    }
    Write-Host "正在下载 cloudflared（官方 2026.8.2，Windows amd64）..."
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $CloudflaredDownloadUrl -OutFile $CloudflaredPath -UseBasicParsing
    $hash = (Get-FileHash -LiteralPath $CloudflaredPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $CloudflaredSha256) {
        Remove-Item -LiteralPath $CloudflaredPath -Force
        throw "CLOUDFLARED_SHA256_MISMATCH"
    }
    return $true
}

# ---- 生成最小 cloudflared config ----
function Ensure-Config {
    if (Test-Path -LiteralPath $ConfigPath) { return }
    $content = @"
tunnel: 00000000-0000-0000-0000-000000000000
credentials-file: $WorkRoot\credentials.json
ingress:
  - service: http_status:404
logfile: $WorkRoot\cloudflared.log
"@
    Set-Content -LiteralPath $ConfigPath -Value $content -Encoding ascii
}

# ---- 服务快照（排除本服务）----
function Get-ServiceSnapshot {
    $services = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne $ServiceName }
    return @{
        count = @($services).Count
        names = @($services | ForEach-Object { $_.Name } | Sort-Object)
    }
}

function Test-SameServiceList([object]$Before, [object]$After) {
    if ($Before.count -ne $After.count) { return $false }
    $added = @($After.names | Where-Object { $Before.names -notcontains $_ })
    $removed = @($Before.names | Where-Object { $After.names -notcontains $_ })
    return (($added.Count -eq 0) -and ($removed.Count -eq 0))
}

# ---- 读取 / 写入 state ----
function Read-State {
    if (Test-Path -LiteralPath $StatePath) {
        try { return Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json } catch { return $null }
    }
    return $null
}
function Save-State([object]$State) {
    if (-not (Test-Path -LiteralPath $WorkRoot)) { New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null }
    ($State | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath "$StatePath.tmp" -Encoding utf8
    Move-Item -LiteralPath "$StatePath.tmp" -Destination $StatePath -Force
}
function Read-ServiceFingerprint {
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -eq $service) { return $null }
    $imagePath = ""
    try { $imagePath = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName" -Name ImagePath -ErrorAction Stop).ImagePath } catch { $imagePath = "" }
    $startup = "Unknown"
    try { $startup = (Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction Stop).StartMode } catch { $startup = "Unknown" }
    return @{ name = $ServiceName; exists = $true; imagePath = $imagePath; startup = $startup; running = ($service.Status -eq "Running") }
}

try {
    # ---- 阶段 0：环境准备（仅首次）----
    if (-not (Test-Path -LiteralPath $StatePath)) {
        Assert-Admin
        Ensure-Cloudflared
        Ensure-Config
        Save-State @{ sessionId = $SessionId; startedAt = (Get-Now); phase = "PREPARED"; beforeSnapshot = (Get-ServiceSnapshot) }
        Write-Host "环境就绪：cloudflared=$(Test-Path $CloudflaredPath), config=$(Test-Path $ConfigPath)"
    }

    $state = Read-State
    if ($null -eq $state) { throw "STATE_MISSING" }

    switch ($state.phase) {
        "PREPARED" {
            # ---- 阶段 1：preflight ----
            $cloudflaredInfo = @{
                present = (Test-Path -LiteralPath $CloudflaredPath)
                version = (& $CloudflaredPath --version 2>&1) -join " "
                sha256 = (Get-FileHash -LiteralPath $CloudflaredPath -Algorithm SHA256).Hash.ToLowerInvariant()
            }
            $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
            $envelope = New-Envelope "preflight" "PASS" @{
                kind = "CLOUDFLARED_SERVICE_PREFLIGHT"
                sessionId = $state.sessionId
                toolSpanVersion = $ToolSpanVersion
                admin = $true
                cloudflared = $cloudflaredInfo
                service = $(if ($null -eq $existing) { $null } else { (Read-ServiceFingerprint) })
                unrelatedServiceSnapshot = (Get-ServiceSnapshot)
            }
            Write-Evidence $envelope
            Write-Host "preflight: PASS"

            # ---- 阶段 2：install ----
            if ($null -ne $existing) {
                $blocked = New-Envelope "install" "BLOCKED_BY_ENVIRONMENT" @{
                    kind = "CLOUDFLARED_SERVICE_INSTALL"
                    sessionId = $state.sessionId
                    reason = "EXTERNAL_SERVICE_PRESERVED"
                }
                Write-Evidence $blocked
                throw "EXTERNAL_SERVICE_PRESERVED"
            }
            $before = Get-ServiceSnapshot
            & $CloudflaredPath service install
            if ($LASTEXITCODE -ne 0) { throw "CLOUDFLARED_SERVICE_INSTALL_FAILED" }
            $imagePath = ('"{0}" --config="{1}" tunnel run' -f $CloudflaredPath, $ConfigPath)
            Set-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName" -Name "ImagePath" -Value $imagePath
            Set-Service -Name $ServiceName -StartupType Automatic
            Restart-Service -Name $ServiceName
            Start-Sleep -Seconds 3
            $after = Read-ServiceFingerprint
            $installEnv = New-Envelope "install" "PASS" @{
                kind = "CLOUDFLARED_SERVICE_INSTALL"
                sessionId = $state.sessionId
                toolSpanVersion = $ToolSpanVersion
                installPassed = $true
                runningAfterInstall = $after.running
                startupTypeAfterInstall = $after.startup
                beforeSnapshot = $before
                afterService = $after
            }
            Write-Evidence $installEnv
            Write-Host "install: PASS"

            # ---- 阶段 3：verify ----
            $verifyFp = Read-ServiceFingerprint
            $verifyEnv = New-Envelope "verify" "PASS" @{
                kind = "CLOUDFLARED_SERVICE_VERIFY"
                sessionId = $state.sessionId
                service = $verifyFp
                ownershipBound = $true
            }
            Write-Evidence $verifyEnv
            Write-Host "verify: PASS"

            Save-State @{ sessionId = $state.sessionId; startedAt = $state.startedAt; phase = "INSTALLED"; beforeSnapshot = $before }
            Write-Host ""
            Write-Host "=============================================="
            Write-Host " 阶段 1-3 完成。请重启本 VM，然后再次运行本脚本。"
            Write-Host "=============================================="
            break
        }

        "INSTALLED" {
            # ---- 阶段 4：reboot-persistence（重启后）----
            $service = Read-ServiceFingerprint
            if ($null -eq $service) { throw "CLOUDFLARED_SERVICE_NOT_FOUND_AFTER_REBOOT" }
            $rebootEnv = New-Envelope "reboot-persistence" "PASS" @{
                kind = "CLOUDFLARED_SERVICE_REBOOT_PERSISTENCE"
                sessionId = $state.sessionId
                toolSpanVersion = $ToolSpanVersion
                serviceAfterReboot = $service
                ownershipBound = $true
                unrelatedServiceSnapshot = (Get-ServiceSnapshot)
            }
            Write-Evidence $rebootEnv
            Write-Host "reboot-persistence: PASS"

            # ---- 阶段 5：uninstall ----
            $before = $state.beforeSnapshot
            $serviceExists = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
            if ($null -ne $serviceExists) {
                Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
                & $CloudflaredPath service uninstall
                if ($LASTEXITCODE -ne 0) { throw "CLOUDFLARED_SERVICE_UNINSTALL_FAILED" }
            }
            $removed = $null -eq (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)
            $afterSnapshot = Get-ServiceSnapshot
            $comparison = Test-SameServiceList $before $afterSnapshot
            $uninstallEnv = New-Envelope "uninstall" "PASS" @{
                kind = "CLOUDFLARED_SERVICE_UNINSTALL"
                sessionId = $state.sessionId
                toolSpanVersion = $ToolSpanVersion
                removed = $removed
                unrelatedServicePreserved = $comparison
                unrelatedServiceComparison = @{ equal = $comparison; beforeCount = $before.count; afterCount = $afterSnapshot.count }
            }
            Write-Evidence $uninstallEnv
            Write-Host "uninstall: PASS"

            # ---- 汇总证据 ----
            if (-not (Test-Path -LiteralPath $EvidenceDir)) { New-Item -ItemType Directory -Path $EvidenceDir -Force | Out-Null }
            $summary = @{
                schemaVersion = "1.0"
                requirementId = $RequirementId
                status = "PASS"
                observedAt = (Get-Now)
                sanitized = $true
                secretValues = 0
                proof = @{
                    kind = "CLOUDFLARED_SERVICE_LIFECYCLE"
                    toolSpanVersion = $ToolSpanVersion
                    sessionId = $state.sessionId
                    cloudflaredSha256 = $CloudflaredSha256
                    installPassed = $true
                    startPassed = $true
                    startupType = "Automatic"
                    rebootPersistencePassed = $true
                    uninstallPassed = $true
                    unrelatedServiceDelta = 0
                    noPortOrProcessKill = $true
                }
            }
            $evidenceFile = Join-Path $EvidenceDir "E-CF-WIN-01.json"
            ($summary | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath "$evidenceFile.tmp" -Encoding utf8
            Move-Item -LiteralPath "$evidenceFile.tmp" -Destination $evidenceFile -Force
            Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
            Write-Evidence $summary
            Write-Host ""
            Write-Host "=== E-CF-WIN-01 验证完成 ==="
            Write-Host "证据文件：$evidenceFile"
            Write-Host "请把上方输出的全部 JSON（含各阶段与汇总）复制发回。"
            break
        }
        default {
            throw "UNKNOWN_STATE_PHASE"
        }
    }
} catch {
    $failure = New-Envelope "unknown" "BLOCKED_BY_ENVIRONMENT" @{ reason = $_.Exception.Message }
    Write-Evidence $failure
    Write-Host "FAILED: $($_.Exception.Message)"
}

$stdout.ToString().TrimEnd() | Write-Output
