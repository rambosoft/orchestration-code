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
    if ($name -in @('TEMPORAL_ADDRESS','TEMPORAL_NAMESPACE','TEMPORAL_TASK_QUEUE','ORCHESTRATOR_MAX_ACTIVITY_CONCURRENCY','ORCHESTRATOR_QUEUE_WAIT_ALERT_MS','ORCHESTRATOR_DATA_DIR','OPENROUTER_API_KEY','PAPERCLIP_API_URL','PAPERCLIP_API_TOKEN')) { [Environment]::SetEnvironmentVariable($name, $value, 'Process') }
    }
  }
}
& $env:ComSpec /d /c "npm run worker:node >> `"$workerLog`" 2>&1"
$workerExitCode = $LASTEXITCODE
if ($null -eq $workerExitCode) { $workerExitCode = 1 }
"Worker exited at $(Get-Date -Format o) with code $workerExitCode" | Out-File -FilePath $workerLog -Append -Encoding utf8
exit $workerExitCode
