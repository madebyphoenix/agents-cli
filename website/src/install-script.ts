export const INSTALL_SH = `#!/usr/bin/env bash
# agents installer
# Usage: curl -fsSL agents-cli.sh | sh
set -e

RED='\\033[0;31m'
GREEN='\\033[0;32m'
BLUE='\\033[0;34m'
DIM='\\033[2m'
NC='\\033[0m'

echo ""
echo "  \${BLUE}agents\${NC} installer"
echo ""

if command -v bun >/dev/null 2>&1; then
  echo "  \${DIM}installing with bun...\${NC}"
  bun install -g @phnx-labs/agents-cli
elif command -v npm >/dev/null 2>&1; then
  echo "  \${DIM}installing with npm...\${NC}"
  npm install -g @phnx-labs/agents-cli
else
  echo "  \${RED}error:\${NC} no package manager found"
  echo "  install bun (https://bun.sh) or node.js and retry"
  exit 1
fi

echo ""
echo "  \${GREEN}done\${NC} — run \\\`agents --help\\\` to get started"
echo ""
`;
