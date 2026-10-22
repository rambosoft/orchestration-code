$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
New-Item -ItemType Directory -Force data\temporal,data\orchestrator,data\paperclip,data\artifacts | Out-Null
& (Join-Path $PSScriptRoot 'scripts\prepare-paperclip.ps1')
if (-not (Test-Path .env)) {
  $apiToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
  $authSecret = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
  "ORCHESTRATOR_API_TOKEN=$apiToken`nBETTER_AUTH_SECRET=$authSecret`nDEMO_PROJECT_ROOT=$root\demo\project`nCALCULATOR_PROJECT_ROOT=C:\workspace\calculator`nORCHESTRATOR_HOST_DATA_DIR=$root\data`nORCHESTRATOR_MAX_ACTIVITY_CONCURRENCY=2" | Set-Content -Encoding utf8 .env
} elseif (-not (Select-String -Path .env -Pattern '^CALCULATOR_PROJECT_ROOT=' -Quiet)) {
  Add-Content -Path .env -Value 'CALCULATOR_PROJECT_ROOT=C:/workspace/calculator'
}
npm ci
npm run build
Write-Output 'Local setup is ready. Secrets are stored in the ignored .env file.'
