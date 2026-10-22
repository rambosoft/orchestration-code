$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
foreach ($relative in @('data\artifacts\demo-run', 'demo\worktrees')) {
  $target = Join-Path $root $relative
  if (Test-Path -LiteralPath $target) {
    $resolved = (Resolve-Path -LiteralPath $target).Path
    if (-not $resolved.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing to remove path outside workspace: $resolved" }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
Write-Output 'Disposable demo outputs removed. Paperclip, Temporal and demo source were preserved.'
