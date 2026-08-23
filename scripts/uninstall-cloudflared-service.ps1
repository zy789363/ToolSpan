[CmdletBinding()]
param(
    [string]$ServiceName = "cloudflared",
    [string]$CloudflaredPath = "cloudflared.exe",
    [string]$OwnershipFile = ""
)

$ErrorActionPreference = "Stop"

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

function Stop-CloudflaredServiceBounded([string]$Name) {
    # cloudflared 2026.8.2 agent service can hang forever in StopPending when
    # asked to stop, so stop through a bounded job and never block indefinitely.
    $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $service) {
        return $true
    }
    if ($service.Status -eq "Stopped") {
        return $true
    }
    $job = Start-Job -ScriptBlock {
        param($serviceName)
        Stop-Service -Name $serviceName -Force -ErrorAction Stop
    } -ArgumentList $Name
    if (-not (Wait-Job -Job $job -Timeout 45)) {
        Stop-Job -Job $job -ErrorAction SilentlyContinue
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        return $false
    }
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    $after = Get-Service -Name $Name -ErrorAction SilentlyContinue
    return ($null -eq $after -or $after.Status -eq "Stopped")
}

function Resolve-OwnershipFile {
    if ($OwnershipFile -ne "") {
        return $OwnershipFile
    }
    $base = Join-Path (Get-Location) ".toolspan-dev"
    return Join-Path $base "cloudflared-service-ownership.json"
}

function Get-ServiceSnapshot([string]$Name) {
    $services = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne $Name }
    $names = @($services | ForEach-Object { $_.Name } | Sort-Object)
    return @{ count = $names.Count; names = $names }
}

function Test-SameServiceList([object]$Before, [object]$After) {
    if ($Before.count -ne $After.count) {
        return @{ equal = $false; beforeCount = $Before.count; afterCount = $After.count }
    }
    $added = @($After.names | Where-Object { $Before.names -notcontains $_ })
    $removed = @($Before.names | Where-Object { $After.names -notcontains $_ })
    return @{ equal = (($added.Count -eq 0) -and ($removed.Count -eq 0)); beforeCount = $Before.count; afterCount = $After.count; added = $added; removed = $removed }
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

$requirementId = "E-CF-WIN-01"
$observedAt = Get-CurrentTime
$ownershipPath = Resolve-OwnershipFile
$stdout = [System.Text.StringBuilder]::new()

function Write-Evidence([object]$Evidence) {
    $json = $Evidence | ConvertTo-Json -Depth 12
    $null = $stdout.AppendLine($json)
}

try {
    Assert-Administrator
    $ownership = Read-Ownership $ownershipPath
    if ($null -eq $ownership -or $ownership.serviceName -ne $ServiceName) {
        $evidence = @{
            schemaVersion = "1.0"
            requirementId = $requirementId
            status = "BLOCKED_BY_EXTERNAL_ACCOUNT"
            observedAt = $observedAt
            sanitized = $true
            secretValues = 0
            phase = "uninstall"
            reasons = @("OWNERSHIP_NOT_PROVABLE")
            proof = @{
                kind = "CLOUDFLARED_SERVICE_UNINSTALL"
                serviceName = $ServiceName
                reason = "No provable ownership record; refusing to touch external cloudflared services"
                ownershipFilePresent = (Test-Path -LiteralPath $ownershipPath)
            }
        }
        Write-Evidence $evidence
        exit 2
    }

    $before = Get-ServiceSnapshot $ServiceName
    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
        $stopped = Stop-CloudflaredServiceBounded $ServiceName
        if (-not $stopped) {
            Write-Host "WARNING: cloudflared service did not stop within the bounded window; continuing with uninstall."
        }
        & $CloudflaredPath service uninstall
        if ($LASTEXITCODE -ne 0) { throw "CLOUDFLARED_SERVICE_UNINSTALL_FAILED" }
    }
    $removed = $null -eq (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)
    $after = Get-ServiceSnapshot $ServiceName
    $comparison = Test-SameServiceList $before $after
    if (Test-Path -LiteralPath $ownershipPath) {
        Remove-Item -LiteralPath $ownershipPath -Force
    }

    $evidence = @{
        schemaVersion = "1.0"
        requirementId = $requirementId
        status = "PASS"
        observedAt = $observedAt
        sanitized = $true
        secretValues = 0
        phase = "uninstall"
        proof = @{
            kind = "CLOUDFLARED_SERVICE_UNINSTALL"
            serviceName = $ServiceName
            sessionId = $ownership.sessionId
            removed = $removed
            unrelatedServicePreserved = $comparison.equal
            unrelatedServiceComparison = $comparison
            ownershipFileRemoved = $true
        }
    }
    Write-Evidence $evidence
    exit 0
} catch {
    $evidence = @{
        schemaVersion = "1.0"
        requirementId = $requirementId
        status = "BLOCKED_BY_EXTERNAL_ACCOUNT"
        observedAt = $observedAt
        sanitized = $true
        secretValues = 0
        phase = "uninstall"
        reasons = @($_.Exception.Message)
        proof = @{
            kind = "CLOUDFLARED_SERVICE_UNINSTALL"
            serviceName = $ServiceName
        }
    }
    Write-Evidence $evidence
    exit 2
}
