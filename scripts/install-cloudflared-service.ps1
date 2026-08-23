[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,
    [string]$CloudflaredPath = "cloudflared.exe",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object System.Security.Principal.WindowsPrincipal($Identity)
if (-not $Principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell session"
}

function Write-CloudflaredOwnership([string]$ServiceName, [string]$CloudflaredSource, [string]$Config) {
    $rand = -join ((48..57) + (97..102) | Get-Random -Count 10 | ForEach-Object { [char]$_ })
    $sessionId = "$(Get-Date -Format yyyyMMdd)-$rand"
    $directory = Join-Path (Get-Location) ".toolspan-dev"
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $ownership = @{
        sessionId = $sessionId
        installedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        serviceName = $ServiceName
        cloudflaredPath = $CloudflaredSource
        configPath = $Config
    }
    $path = Join-Path $directory "cloudflared-service-ownership.json"
    ($ownership | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath "$path.tmp" -Encoding UTF8
    Move-Item -LiteralPath "$path.tmp" -Destination $path -Force
    return $sessionId
}

$Executable = (Get-Command $CloudflaredPath -ErrorAction Stop).Source
$ResolvedConfig = (Resolve-Path $ConfigPath).Path
& $Executable --config $ResolvedConfig tunnel ingress validate
if ($LASTEXITCODE -ne 0) { throw "cloudflared ingress validation failed" }

$Service = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
if ($null -ne $Service -and -not $Force) {
    throw "The cloudflared service already exists; pass -Force to update its command"
}
if ($null -eq $Service) {
    & $Executable service install
    if ($LASTEXITCODE -ne 0) { throw "cloudflared service install failed" }
}

$ImagePath = ('"{0}" --config="{1}" tunnel run' -f $Executable, $ResolvedConfig)
Set-ItemProperty `
    -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\cloudflared" `
    -Name "ImagePath" `
    -Value $ImagePath
Set-Service -Name "cloudflared" -StartupType Automatic
Restart-Service -Name "cloudflared"
$SessionId = Write-CloudflaredOwnership "cloudflared" $Executable $ResolvedConfig
Write-Host "Installed and started the cloudflared service (session $SessionId)."
