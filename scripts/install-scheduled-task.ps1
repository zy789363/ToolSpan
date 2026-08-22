[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,
    [string]$TaskName = "WebGPT-MCP",
    [switch]$Force,
    [switch]$Start
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RunScript = (Resolve-Path (Join-Path $ProjectRoot "scripts\run-webgpt.ps1")).Path
$ResolvedConfig = (Resolve-Path $ConfigPath).Path
$PowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $Existing -and -not $Force) {
    throw "Scheduled task '$TaskName' already exists; pass -Force to replace it"
}

$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$ActionArguments = ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ConfigPath "{1}"' -f $RunScript, $ResolvedConfig)
$Action = New-ScheduledTaskAction -Execute $PowerShell -Argument $ActionArguments -WorkingDirectory $ProjectRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$Principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
    -RestartCount 10 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

$Parameters = @{
    TaskName = $TaskName
    Action = $Action
    Trigger = $Trigger
    Principal = $Principal
    Settings = $Settings
    Description = "Run the local WebGPT MCP server at user logon"
}
if ($Force) { $Parameters.Force = $true }
Register-ScheduledTask @Parameters | Out-Null
if ($Start) { Start-ScheduledTask -TaskName $TaskName }
Write-Host "Installed scheduled task '$TaskName'."
