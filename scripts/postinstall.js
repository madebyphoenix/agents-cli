#!/usr/bin/env node
// Runs after npm install -g @swarmify/agents-cli
// Sets up shims directory and prints PATH instructions.
// Set AGENTS_INIT_SHELL=1 to opt in to automatic shell-rc mutation.

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

const shellName = path.basename(process.env.SHELL || '/bin/bash');

function getShellRc() {
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

const exportLine = shellName === 'fish'
  ? `fish_add_path ${SHIMS_DIR}`
  : `export PATH="${SHIMS_DIR}:$PATH"`;

// Opt-in: AGENTS_INIT_SHELL=1 npm install -g @swarmify/agents-cli
if (process.env.AGENTS_INIT_SHELL === '1') {
  const rcFile = getShellRc();
  let alreadyConfigured = false;
  if (fs.existsSync(rcFile)) {
    const content = fs.readFileSync(rcFile, 'utf-8');
    alreadyConfigured = content.includes('.agents/shims');
  }
  if (!alreadyConfigured) {
    const addition = `\n# agents-cli: version switching for AI coding agents\n${exportLine}\n`;
    fs.mkdirSync(path.dirname(rcFile), { recursive: true });
    fs.appendFileSync(rcFile, addition);
    console.log(`\n  Added ${SHIMS_DIR} to PATH in ${path.basename(rcFile)}`);
    console.log(`  Restart your shell to enable version switching\n`);
  }
  process.exit(0);
}

// Default: print, do not mutate.
console.log(`
agents-cli installed.
To enable version-aware shims, add the following line to your shell config:

  ${exportLine}

(zsh: ~/.zshrc, bash: ~/.bashrc, fish: ~/.config/fish/config.fish)

Or re-run with AGENTS_INIT_SHELL=1 to have the installer add it for you.
`);
