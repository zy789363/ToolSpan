[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("preflight", "install", "verify", "reboot-persistence", "uninstall")]
    [string]$Phase,
    [string]$ServiceName = "cloudflared",
    [string]$CloudflaredPath = "cloudflared.exe",
    [string]$ConfigPath = "",
    [string]$SessionId = "",
    [string]$OwnershipFile = ""
)

$ErrorActionPreference = "Stop"
$stdout = [System.Text.StringBuilder]::new()

function Write-Evidence([object]$Evidence) {
    $json = $Evidence | ConvertTo-Json -Depth 12
    $null = $stdout.AppendLine($json)
}

function Get-ToolSpanVersion {
    $packageFile = Join-Path (Get-Location) "package.json"
    try {
        $package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
        if ($package.version -match "^[0-9]+\.[0-9]+\.[0-9]+$") {
            return $package.version
        }
    } catch {
        return $null
    }
    return $null
}

function Get-CurrentTime {
    return (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
}

function Assert-Administrator {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "ADMIN_REQUIRED"
    }
}

function Resolve-OwnershipFile {
    if ($OwnershipFile -ne "") {
        return $OwnershipFile
    }
    $base = Join-Path (Get-Location) ".toolspan-dev"
    return Join-Path $base "cloudflared-service-ownership.json"
}

function Get-CloudflaredInfo([string]$Executable) {
    $resolved = (Get-Command $Executable -ErrorAction SilentlyContinue)
    if ($null -eq $resolved) {
        return @{ present = $false; version = $null; sha256 = $null; path = $null }
    }
    $path = $resolved.Source
    $version = $null
    try {
        $versionOutput = (& $Executable --version 2>&1) -join "`n"
        if ($versionOutput -match "cloudflared version\s+([^\s]+)") {
            $version = $Matches[1]
        }
    } catch {
        $version = $null
    }
    $hash = $null
    try {
        $hash = (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLowerInvariant()
    } catch {
        $hash = $null
    }
    return @{ present = $true; version = $version; sha256 = $hash; path = $path }
}

function Get-ServiceSnapshot([string]$Name) {
    $services = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne $Name }
    $names = @($services | ForEach-Object { $_.Name } | Sort-Object)
    $map = @{}
    foreach ($service in $services) {
        $startup = "Unknown"
        try {
            $startup = (Get-CimInstance Win32_Service -Filter "Name='$($service.Name)'" -ErrorAction Stop).StartMode
        } catch {
            $startup = "Unknown"
        }
        $map[$service.Name] = @{ status = $service.Status; startup = $startup }
    }
    return @{ count = $names.Count; names = $names; details = $map }
}

function Test-SameServiceList([object]$Before, [object]$After) {
    if ($Before.count -ne $After.count) {
        return @{ equal = $false; beforeCount = $Before.count; afterCount = $After.count; added = @(); removed = @() }
    }
    $beforeSet = @{}
    foreach ($name in $Before.names) { $beforeSet[$name] = $true }
    $added = @($After.names | Where-Object { -not $beforeSet.ContainsKey($_) })
    $removed = @($Before.names | Where-Object { $After.names -notcontains $_ })
    $equal = ($added.Count -eq 0) -and ($removed.Count -eq 0)
    return @{ equal = $equal; beforeCount = $Before.count; afterCount = $After.count; added = $added; removed = $removed }
}

function Get-OwnedServiceFingerprint([string]$Name) {
    $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $service) {
        return $null
    }
    $imagePath = ""
    try {
        $imagePath = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$Name" -Name ImagePath -ErrorAction Stop).ImagePath
    } catch {
        $imagePath = ""
    }
    $startup = "Unknown"
    try {
        $startup = (Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction Stop).StartMode
    } catch {
        $startup = "Unknown"
    }
    $running = ($service.Status -eq "Running")
    return @{ name = $Name; exists = $true; imagePath = $imagePath; startup = $startup; running = $running }
}

function Read-Ownership([string]$File) {
    if (-not (Test-Path -LiteralPath $File)) {
        return $null
    }
    try {
        return Get-Content -LiteralPath $File -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Save-Ownership([object]$Ownership, [string]$File) {
    $directory = Split-Path -Parent $File
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $temp = "$File.tmp"
    ($Ownership | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $File -Force
}

function New-SessionId {
    if ($SessionId -ne "") {
        return $SessionId
    }
    $rand = -join ((48..57) + (97..102) | Get-Random -Count 10 | ForEach-Object { [char]$_ })
    return "$(Get-Date -Format yyyyMMdd)-$rand"
}

function New-EmptyEnvelope([string]$RequirementId, [string]$ObservedAt, [string]$Phase) {
    return @{
        schemaVersion = "1.0"
        requirementId = $RequirementId
        status = "PASS"
        observedAt = $ObservedAt
        sanitized = $true
        secretValues = 0
        phase = $Phase
    }
}

function New-BlockedEnvelope([string]$RequirementId, [string]$ObservedAt, [string]$Phase, [string[]]$Reasons) {
    return @{
        schemaVersion = "1.0"
        requirementId = $RequirementId
        status = "BLOCKED_BY_ENVIRONMENT"
        observedAt = $ObservedAt
        sanitized = $true
        secretValues = 0
        phase = $Phase
        reasons = $Reasons
    }
}

$requirementId = "E-CF-WIN-01"
$sessionId = New-SessionId
$ownershipPath = Resolve-OwnershipFile
$observedAt = Get-CurrentTime
$toolSpanVersion = Get-ToolSpanVersion

try {
    switch ($Phase) {
        "preflight" {
            $admin = $false
            $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
            $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
            $admin = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
            $cloudflared = Get-CloudflaredInfo $CloudflaredPath
            $service = Get-OwnedServiceFingerprint $ServiceName
            $snapshot = Get-ServiceSnapshot $ServiceName
            $blockedReasons = @()
            if (-not $admin) { $blockedReasons += "ADMIN_REQUIRED" }
            if (-not $cloudflared.present) { $blockedReasons += "CLOUDFLARED_NOT_FOUND" }
            if (-not $cloudflared.version) { $blockedReasons += "CLOUDFLARED_VERSION_UNREADABLE" }
            if (-not $cloudflared.sha256) { $blockedReasons += "CLOUDFLARED_SHA256_UNREADABLE" }

            $envelope = New-EmptyEnvelope $requirementId $observedAt "preflight"
            $envelope.proof = @{
                kind = "CLOUDFLARED_SERVICE_PREFLIGHT"
                sessionId = $sessionId
                toolSpanVersion = $toolSpanVersion
                admin = $admin
                cloudflared = $cloudflared
                service = $service
                unrelatedServiceSnapshot = $snapshot
            }
            if ($blockedReasons.Count -gt 0) {
                $envelope = New-BlockedEnvelope $requirementId $observedAt "preflight" $blockedReasons
                $envelope.proof = @{
                    kind = "CLOUDFLARED_SERVICE_PREFLIGHT"
                    sessionId = $sessionId
                    toolSpanVersion = $toolSpanVersion
                    admin = $admin
                    cloudflared = @{ present = $cloudflared.present; version = $cloudflared.version; sha256 = $cloudflared.sha256 }
                    service = $service
                }
                $LASTEXITCODE = 2
                Write-Evidence $envelope
                break
            }
            Write-Evidence $envelope
            $LASTEXITCODE = 0
            break
        }

        "install" {
            Assert-Administrator
            $cloudflared = Get-CloudflaredInfo $CloudflaredPath
            if (-not $cloudflared.present) { throw "CLOUDFLARED_NOT_FOUND" }
            if ($ConfigPath -eq "" -or -not (Test-Path -LiteralPath $ConfigPath)) { throw "CONFIG_PATH_INVALID" }
            $resolvedConfig = (Resolve-Path -LiteralPath $ConfigPath).Path

            $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
            $before = Get-ServiceSnapshot $ServiceName
            if ($null -ne $existing) {
                $envelope = New-BlockedEnvelope $requirementId $observedAt "install" @("EXTERNAL_SERVICE_PRESERVED")
                $envelope.proof = @{
                    kind = "CLOUDFLARED_SERVICE_INSTALL"
                    sessionId = $sessionId
                    serviceName = $ServiceName
                    reason = "Existing external cloudflared service detected; will not be changed automatically"
                    beforeSnapshot = $before
                }
                $LASTEXITCODE = 2
                Write-Evidence $envelope
                break
            }

            $ownership = @{
                sessionId = $sessionId
                installedAt = $observedAt
                serviceName = $ServiceName
                cloudflaredPath = $cloudflared.path
                cloudflaredSha256 = $cloudflared.sha256
                cloudflaredVersion = $cloudflared.version
                configPath = $resolvedConfig
            }
            Save-Ownership $ownership $ownershipPath

            & $CloudflaredPath service install
            if ($LASTEXITCODE -ne 0) { throw "CLOUDFLARED_SERVICE_INSTALL_FAILED" }

            $imagePath = ('"{0}" --config="{1}" tunnel run' -f $cloudflared.path, $resolvedConfig)
            Set-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName" -Name "ImagePath" -Value $imagePath
            Set-Service -Name $ServiceName -StartupType Automatic
            Restart-Service -Name $ServiceName
            Start-Sleep -Seconds 3

            $after = Get-OwnedServiceFingerprint $ServiceName
            $envelope = New-EmptyEnvelope $requirementId $observedAt "install"
            $envelope.proof = @{
                kind = "CLOUDFLARED_SERVICE_INSTALL"
                sessionId = $sessionId
                serviceName = $ServiceName
                toolSpanVersion = $toolSpanVersion
                cloudflared = @{ version = $cloudflared.version; sha256 = $cloudflared.sha256 }
                configPath = $resolvedConfig
                installPassed = $true
                runningAfterInstall = $after.running
                startupTypeAfterInstall = $after.startup
                ownershipFile = $ownershipPath
                beforeSnapshot = $before
                afterService = $after
            }
            Write-Evidence $envelope
            $LASTEXITCODE = 0
            break
        }

        "verify" {
            Assert-Administrator
            $service = Get-OwnedServiceFingerprint $ServiceName
            if ($null -eq $service) { throw "CLOUDFLARED_SERVICE_NOT_FOUND" }
            $ownership = Read-Ownership $ownershipPath
            $envelope = New-EmptyEnvelope $requirementId $observedAt "verify"
            $envelope.proof = @{
                kind = "CLOUDFLARED_SERVICE_VERIFY"
                sessionId = $sessionId
                serviceName = $ServiceName
                service = $service
                ownershipBound = ($null -ne $ownership) -and ($ownership.serviceName -eq $ServiceName)
            }
            Write-Evidence $envelope
            $LASTEXITCODE = 0
            break
        }

        "reboot-persistence" {
            Assert-Administrator
            $service = Get-OwnedServiceFingerprint $ServiceName
            if ($null -eq $service) { throw "CLOUDFLARED_SERVICE_NOT_FOUND" }
            $ownership = Read-Ownership $ownershipPath
            $snapshot = Get-ServiceSnapshot $ServiceName
            $envelope = New-EmptyEnvelope $requirementId $observedAt "reboot-persistence"
            $envelope.proof = @{
                kind = "CLOUDFLARED_SERVICE_REBOOT_PERSISTENCE"
                sessionId = $sessionId
                serviceName = $ServiceName
                serviceAfterReboot = $service
                ownershipBound = ($null -ne $ownership) -and ($ownership.serviceName -eq $ServiceName)
                unrelatedServiceSnapshot = $snapshot
            }
            Write-Evidence $envelope
            $LASTEXITCODE = 0
            break
        }

        "uninstall" {
            Assert-Administrator
            $ownership = Read-Ownership $ownershipPath
            if ($null -eq $ownership -or $ownership.serviceName -ne $ServiceName) {
                $envelope = New-BlockedEnvelope $requirementId $observedAt "uninstall" @("OWNERSHIP_NOT_PROVABLE")
                $envelope.proof = @{
                    kind = "CLOUDFLARED_SERVICE_UNINSTALL"
                    sessionId = $sessionId
                    serviceName = $ServiceName
                    reason = "No provable ownership record for this service; refusing to touch external services"
                }
                $LASTEXITCODE = 2
                Write-Evidence $envelope
                break
            }
            $before = Get-ServiceSnapshot $ServiceName
            $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
            if ($null -ne $existing) {
                Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
                & $CloudflaredPath service uninstall
                if ($LASTEXITCODE -ne 0) { throw "CLOUDFLARED_SERVICE_UNINSTALL_FAILED" }
            }
            $removed = $null -eq (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)
            $after = Get-ServiceSnapshot $ServiceName
            $comparison = Test-SameServiceList $before $after
            if (Test-Path -LiteralPath $ownershipPath) {
                Remove-Item -LiteralPath $ownershipPath -Force
            }
            $envelope = New-EmptyEnvelope $requirementId $observedAt "uninstall"
            $envelope.proof = @{
                kind = "CLOUDFLARED_SERVICE_UNINSTALL"
                sessionId = $sessionId
                serviceName = $ServiceName
                toolSpanVersion = $toolSpanVersion
                removed = $removed
                unrelatedServicePreserved = $comparison.equal
                unrelatedServiceComparison = $comparison
                ownershipFileRemoved = $true
            }
            Write-Evidence $envelope
            $LASTEXITCODE = 0
            break
        }
    }
} catch {
    $envelope = New-BlockedEnvelope $requirementId $observedAt $Phase @($_.Exception.Message)
    Write-Evidence $envelope
    $LASTEXITCODE = 2
}

$stdout.ToString().TrimEnd() | Write-Output
exit $LASTEXITCODE
