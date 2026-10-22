$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root '.runtime\paperclip'
$tag = 'v2026.916.1'
$commit = 'd554c4789ed3930f8a53ac9fdf6503b3187097da'

if (-not (Test-Path (Join-Path $source '.git'))) {
  New-Item -ItemType Directory -Force (Split-Path -Parent $source) | Out-Null
  git clone --filter=blob:none --branch $tag --depth 1 https://github.com/paperclipai/paperclip.git $source
  if ($LASTEXITCODE -ne 0) { throw 'Paperclip source checkout failed.' }
}
$actual = (git -C $source rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actual -ne $commit) { throw "Paperclip source must be $tag ($commit), found $actual." }
git -C $source config core.autocrlf false

# The release generators compare LF-normalized source metadata. Keep these
# three manifest inputs stable when the repository is checked out on Windows.
foreach ($relative in @(
  'packages/paperclip-runner/spec/capability/capabilities.yaml',
  'packages/paperclip-runner/spec/capability/eval-traceability.yaml',
  'packages/paperclip-runner/spec/capability/mcp-tool-map.yaml'
)) {
  $file = Join-Path $source $relative
  if (Test-Path $file) {
    $text = [IO.File]::ReadAllText($file) -replace "`r`n", "`n"
    [IO.File]::WriteAllText($file, $text, [Text.UTF8Encoding]::new($false))
  }
}

$dockerfile = Join-Path $source 'Dockerfile'
$text = [IO.File]::ReadAllText($dockerfile) -replace "`r`n", "`n"
$entrypoint = 'RUN chmod +x /usr/local/bin/docker-entrypoint.sh'
if ($text.Contains($entrypoint)) {
  $text = $text.Replace($entrypoint, "RUN sed -i 's/\r`$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh")
}
$anchor = "COPY . .`n"
$generation = @'
RUN pnpm --filter @paperclipai/paperclip-runner generate:protocol-manifest \
  && pnpm --filter @paperclipai/paperclip-runner generate:protocol-types \
  && pnpm --filter @paperclipai/paperclip-runner generate:capability-contract \
  && pnpm --filter @paperclipai/paperclip-runner build:typescript \
  && pnpm --filter @paperclipai/paperclip-runner generate:protocol-coverage \
  && pnpm --filter @paperclipai/paperclip-runner generate:semantic-contracts \
  && pnpm --filter @paperclipai/paperclip-runner generate:replay-goldens \
  && pnpm --filter @paperclipai/paperclip-runner generate:semantic-action-catalog
'@
 # The capability inventory generator consumes Paperclip's private paperclip-evals corpus.
 # The release includes the generated, schema-checked inventory, so leave it intact when
 # that separately permissioned corpus is unavailable to a local Docker build.
$generationStart = $text.IndexOf('RUN pnpm --filter @paperclipai/paperclip-runner generate:protocol-manifest')
$generationEnd = if ($generationStart -ge 0) { $text.IndexOf('RUN find packages/paperclip-runner/runner packages/paperclip-runner/protocol', $generationStart) } else { -1 }
if ($generationStart -ge 0 -and $generationEnd -gt $generationStart) {
  $text = $text.Substring(0, $generationStart) + $generation.Trim() + "`n" + $text.Substring($generationEnd)
} elseif (-not $text.Contains('generate:semantic-action-catalog')) {
  if (-not $text.Contains($anchor)) { throw 'Paperclip Dockerfile build anchor changed; refusing to patch an unknown release.' }
  $text = $text.Replace($anchor, "$anchor$($generation.Trim())`n")
}
[IO.File]::WriteAllText($dockerfile, $text, [Text.UTF8Encoding]::new($false))
Write-Output "Paperclip $tag is prepared under .runtime\paperclip."
