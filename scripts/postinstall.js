#!/usr/bin/env node
// Runs after npm install -g @phnx-labs/agents-cli
// Sets up PATH for version switching

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const HOME = os.homedir();
const SHIMS_DIR = path.join(HOME, '.agents', 'shims');
const AGENTS_DIR = path.join(HOME, '.agents');

// Only run for global installs
if (!process.env.npm_config_global && !process.argv.includes('-g')) {
  process.exit(0);
}

// Create directories
fs.mkdirSync(SHIMS_DIR, { recursive: true });
fs.mkdirSync(AGENTS_DIR, { recursive: true });

// Detect shell rc file
function getShellRc() {
  const shell = process.env.SHELL || '/bin/bash';
  const shellName = path.basename(shell);

  switch (shellName) {
    case 'zsh':
      return path.join(HOME, '.zshrc');
    case 'fish':
      return path.join(HOME, '.config', 'fish', 'config.fish');
    case 'bash':
      const bashProfile = path.join(HOME, '.bash_profile');
      if (fs.existsSync(bashProfile)) {
        return bashProfile;
      }
      return path.join(HOME, '.bashrc');
    default:
      return path.join(HOME, '.profile');
  }
}

const rcFile = getShellRc();
const shellName = path.basename(process.env.SHELL || '/bin/bash');

// Check if already configured
let alreadyConfigured = false;
if (fs.existsSync(rcFile)) {
  const content = fs.readFileSync(rcFile, 'utf-8');
  alreadyConfigured = content.includes('.agents/shims');
}

if (alreadyConfigured) {
  process.exit(0);
}

// Add to shell rc
const exportLine = shellName === 'fish'
  ? `fish_add_path ${SHIMS_DIR}`
  : `export PATH="${SHIMS_DIR}:$PATH"`;

const addition = `
# agents-cli: version switching for AI coding agents
${exportLine}
`;

// Ensure parent directory exists (for fish)
fs.mkdirSync(path.dirname(rcFile), { recursive: true });
fs.appendFileSync(rcFile, addition);

console.log(`\n  Added ${SHIMS_DIR} to PATH in ${path.basename(rcFile)}`);
console.log(`  Restart your shell to enable version switching\n`);
