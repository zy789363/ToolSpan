[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$MainScript = (Resolve-Path (Join-Path $ProjectRoot "dist\main.js")).Path
$ResolvedConfig = (Resolve-Path $ConfigPath).Path
$Config = Get-Content -LiteralPath $ResolvedConfig -Raw | ConvertFrom-Json
$ConfigDirectory = Split-Path $ResolvedConfig -Parent
$StateDirectory = if ([IO.Path]::IsPathRooted($Config.stateDirectory)) {
    [IO.Path]::GetFullPath($Config.stateDirectory)
} else {
    [IO.Path]::GetFullPath((Join-Path $ConfigDirectory $Config.stateDirectory))
}
New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
$LogPath = Join-Path $StateDirectory "webgpt-service.log"
if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt 10MB) {
    Move-Item -LiteralPath $LogPath -Destination "$LogPath.1" -Force
}

$Node = (Get-Command node.exe -ErrorAction Stop).Source
$ErrorActionPreference = "Continue"
& $Node $MainScript --config $ResolvedConfig *>> $LogPath
exit $LASTEXITCODE
