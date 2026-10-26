$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$logDirectory = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$workerLog = Join-Path $logDirectory 'worker-console.log'
"Worker starting at $(Get-Date -Format o)" | Out-File -FilePath $workerLog -Append -Encoding utf8
$rtkInstall = Join-Path $env:LOCALAPPDATA 'Programs\rtk'
if ((Test-Path (Join-Path $rtkInstall 'rtk.exe')) -and (($env:PATH -split ';') -notcontains $rtkInstall)) {
  $env:PATH = "$rtkInstall;$env:PATH"
}
if (Test-Path .env) {
  foreach ($line in Get-Content .env) {
    if ($line -match '^([A-Z0-9_]+)=(.*)$') {
      $name = $Matches[1]; $value = $Matches[2]
    if ($name -in @('TEMPORAL_ADDRESS','TEMPORAL_NAMESPACE','TEMPORAL_TASK_QUEUE','ORCHESTRATOR_MAX_ACTIVITY_CONCURRENCY','ORCHESTRATOR_QUEUE_WAIT_ALERT_MS','ORCHESTRATOR_DATA_DIR','OPENROUTER_API_KEY','PAPERCLIP_API_URL','PAPERCLIP_API_TOKEN','ORCHESTRATOR_WORKTREES_DIR','UNITY_AGENT_PLUGIN_DIR','UNITY_EDITOR_PATH','UNITY_EDITORS_ROOT','UNITY_IMPORT_TIMEOUT_SECONDS')) { [Environment]::SetEnvironmentVariable($name, $value, 'Process') }
    }
  }
}
$workerEntry = Join-Path $root 'dist\src\worker.js'
if (-not (Test-Path $workerEntry)) {
  "Worker cannot start: $workerEntry is missing. Run 'npm run build' first." | Out-File -FilePath $workerLog -Append -Encoding utf8
  exit 1
}
# Resolve node once instead of going through npm, which is not always on PATH for scheduled or hidden launches.
$node = (Get-Command node -ErrorAction Stop).Source
# Windows PowerShell 5.1 turns the first stderr line of a redirected native command into a terminating error under 'Stop', which killed the worker on its first log line.
$ErrorActionPreference = 'Continue'
# Periodic reconcile lives in the worker process itself now (src/reconcile-service.ts, heartbeat in data/logs/reconcile-heartbeat.json, checked by doctor); the Start-Job that used to be here never ran.
# Supervise in-process: Task Scheduler does not restart the task when the worker is killed, so loop here with a short back-off.
while ($true) {
  # After the machine was off or asleep, Temporal finished workflows that Paperclip never heard about. Report them before taking new work (idempotent; a failure here must never stop the worker).
  if ($env:PAPERCLIP_API_TOKEN) { try { & $node (Join-Path $root 'dist\src\cli.js') reconcile --apply *>> $workerLog } catch { "Reconcile skipped: $_" | Out-File -FilePath $workerLog -Append -Encoding utf8 } }
  & $node $workerEntry *>> $workerLog
  $workerExitCode = $LASTEXITCODE
  if ($null -eq $workerExitCode) { $workerExitCode = 1 }
  "Worker exited at $(Get-Date -Format o) with code $workerExitCode; restarting in 5s" | Out-File -FilePath $workerLog -Append -Encoding utf8
  Start-Sleep -Seconds 5
}
