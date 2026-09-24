#!/bin/bash
# Installs workspace dependencies when a Claude Code on the web session
# starts, so typecheck, tests and the build work immediately. Local sessions
# are left alone: developers run `npm install` themselves.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

# `npm install` rather than `npm ci`: it reuses the cached node_modules from
# the previous container snapshot and is a no-op when nothing changed.
npm install --no-audit --no-fund

# Route commits through the repository's pre-commit secret check, and make
# sure the scanner it needs exists. Same version and checksum as CI.
git config core.hooksPath .githooks
GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
if ! command -v gitleaks >/dev/null 2>&1; then
  bin="$HOME/.local/bin"
  mkdir -p "$bin"
  tmp="$(mktemp -d)"
  archive="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
  if curl -sSfL -o "$tmp/$archive" "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${archive}" \
    && echo "${GITLEAKS_SHA256}  $tmp/$archive" | sha256sum -c - >/dev/null; then
    tar -xzf "$tmp/$archive" -C "$bin" gitleaks
    echo "export PATH=\"$bin:\$PATH\"" >> "${CLAUDE_ENV_FILE:-/dev/null}"
  else
    echo "session-start: could not install gitleaks; commits will not be scanned locally" >&2
  fi
  rm -rf "$tmp"
fi
