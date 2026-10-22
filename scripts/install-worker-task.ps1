$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$taskName = 'Paperclip Temporal Orchestration Worker'
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'run-worker.ps1')`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Starts the local Temporal orchestration worker at sign-in and restarts it after unexpected exits.' -Force | Out-Null
$existingWorker = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object { $_.CommandLine -match 'dist[\\/]src[\\/]worker\.js' }
if ($existingWorker) {
  Write-Output "Registered '$taskName' for $currentUser. An orchestration worker is already running (PID $($existingWorker[0].ProcessId)); the scheduled task will manage its next sign-in. Activity events append to $root\data\logs\worker-activity-events.jsonl."
} else {
  Start-ScheduledTask -TaskName $taskName
  Write-Output "Registered and started '$taskName' for $currentUser. Activity events append to $root\data\logs\worker-activity-events.jsonl."
}
