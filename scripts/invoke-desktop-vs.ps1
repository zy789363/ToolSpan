[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("probe", "fmt", "check", "clippy", "test", "tauri-build")]
    [string]$Operation,

    [Parameter(Mandatory = $true)]
    [string]$LaunchVsDevShell,

    [string]$NodePath,
    [string]$NpmCliPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $LaunchVsDevShell -PathType Leaf)) {
    throw "Launch-VsDevShell.ps1 was not found."
}

. $LaunchVsDevShell -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
if ($null -eq (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    throw "The Visual C++ compiler was not initialized by Launch-VsDevShell."
}

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DesktopRoot = Join-Path $ProjectRoot "apps\desktop"
$CargoManifest = Join-Path $DesktopRoot "src-tauri\Cargo.toml"

if ($Operation -eq "probe") {
    exit 0
}

if (-not (Test-Path -LiteralPath $CargoManifest -PathType Leaf)) {
    throw "Desktop Cargo.toml was not found."
}

switch ($Operation) {
    "fmt" {
        & cargo fmt --manifest-path $CargoManifest -- --check
    }
    "check" {
        & cargo check --locked --manifest-path $CargoManifest
    }
    "clippy" {
        & cargo clippy --locked --manifest-path $CargoManifest --all-targets -- -D warnings
    }
    "test" {
        & cargo test --locked --manifest-path $CargoManifest
    }
    "tauri-build" {
        if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
            throw "The explicit Node executable was not found."
        }
        if (-not (Test-Path -LiteralPath $NpmCliPath -PathType Leaf) -or
            -not $NpmCliPath.EndsWith("npm-cli.js", [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "A resolved npm-cli.js path is required."
        }
        & $NodePath $NpmCliPath --prefix $ProjectRoot run build
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
        & $NodePath $NpmCliPath --prefix $DesktopRoot run build
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
        & $NodePath $NpmCliPath --prefix $DesktopRoot run tauri -- build
    }
}

if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
