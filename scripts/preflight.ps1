[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ResolvedConfig = (Resolve-Path $ConfigPath).Path

Push-Location $ProjectRoot
try {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "build failed" }
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw "tests failed" }
    & npm.cmd run doctor -- --config $ResolvedConfig
    if ($LASTEXITCODE -ne 0) { throw "doctor failed" }
}
finally {
    Pop-Location
}
