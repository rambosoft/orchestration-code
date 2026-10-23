#!/bin/sh
# Reproduce the CI job (Linux) locally in a throwaway container: copies the working tree without node_modules,
# installs from the lockfile and runs the same steps as .github/workflows/ci.yml. Requires Docker.
# The bridge runs on Linux while developers use Windows, so path and line-ending bugs show up here first.
set -eu
IMAGE="${CI_LINUX_IMAGE:-node:22}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MSYS_NO_PATHCONV=1 docker run --rm -v "$ROOT:/src:ro" "$IMAGE" sh -c '
  set -e
  mkdir /w && tar -C /src --exclude=node_modules --exclude=.git --exclude=data --exclude=dist --exclude=.runtime -cf - . | tar -C /w -xf -
  cd /w
  git init -q && git add -A >/dev/null 2>&1 && git config --global user.name ci && git config --global user.email ci@example.test
  npm ci --no-audit --no-fund
  npm run check:chars
  npm run scan:secrets
  npm run typecheck
  npx vitest run
'
