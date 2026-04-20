#!/usr/bin/env bash
# Rebuild better-sqlite3 for plain Node.js.
#
# Why: bun install sometimes leaves better-sqlite3's native binary compiled
# against a mismatched ABI (e.g. Bun's NODE_MODULE_VERSION instead of Node's),
# which breaks vitest (runs under Node) with "napi_register_module_v1 not found"
# or "compiled against NODE_MODULE_VERSION X".
#
# This script is idempotent: it tries to load better-sqlite3 under Node first
# and only rebuilds if the load fails.
#
# Unlike rush/app, this is NOT an Electron project — do NOT pass --target or
# --dist-url flags. Plain node-gyp rebuild is correct here.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODULE_DIR="$REPO_ROOT/node_modules/better-sqlite3"

if [ ! -d "$MODULE_DIR" ]; then
  echo "better-sqlite3 not installed — skipping rebuild"
  exit 0
fi

# Probe: can Node load the module as-is?
if node -e "new (require('better-sqlite3'))(':memory:').close()" >/dev/null 2>&1; then
  exit 0
fi

echo "Rebuilding better-sqlite3 for Node $(node --version)..."
cd "$MODULE_DIR"
BUILD_LOG=$(mktemp)
if ! npx --no-install node-gyp rebuild --release >"$BUILD_LOG" 2>&1; then
  cat "$BUILD_LOG" >&2
  rm -f "$BUILD_LOG"
  exit 1
fi
rm -f "$BUILD_LOG"

# Verify
if ! node -e "new (require('better-sqlite3'))(':memory:').close()" >/dev/null 2>&1; then
  echo "Rebuild finished but module still fails to load" >&2
  exit 1
fi

echo "better-sqlite3 rebuilt successfully"
