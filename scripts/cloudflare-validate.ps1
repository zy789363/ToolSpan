[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,
    [string]$CloudflaredPath = "cloudflared.exe"
)

$ErrorActionPreference = "Stop"
$Executable = (Get-Command $CloudflaredPath -ErrorAction Stop).Source
$ResolvedConfig = (Resolve-Path $ConfigPath).Path
& $Executable --config $ResolvedConfig tunnel ingress validate
if ($LASTEXITCODE -ne 0) { throw "cloudflared ingress validation failed" }
& $Executable --version
if ($LASTEXITCODE -ne 0) { throw "cloudflared version check failed" }
