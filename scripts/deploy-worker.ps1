param([int]$WaitMinutes = 0, [switch]$Force)
# Drain-aware deploy: build, then restart the host worker only when no run is in flight (or wait up to -WaitMinutes). -Force skips the drain check.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not $Force) {
  node dist/src/cli.js drain --wait-minutes $WaitMinutes
  if ($LASTEXITCODE -ne 0) { Write-Error 'Deploy refused: runs are in flight. Re-run with -WaitMinutes N, or -Force to interrupt them.'; exit 1 }
}
npm run build
if ($LASTEXITCODE -ne 0) { exit 1 }
$workers = @(Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object { $_.CommandLine -match 'dist[\\/]src[\\/]worker\.js' })
# run-worker.ps1 supervises and restarts the node process after a short back-off, so stopping node is enough.
foreach ($worker in $workers) { Stop-Process -Id $worker.ProcessId -Force }
if ($workers.Count -eq 0) { Write-Output "No worker process was running; start it with 'npm run worker:install' or 'npm run worker'." }
else { Write-Output "Stopped $($workers.Count) worker process(es); the supervisor restarts it within ~5s. Verify with 'npm run doctor'." }
