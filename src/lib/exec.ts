import { spawn } from 'child_process';
import type { AgentId } from './types.js';
import { parseTimeout } from './routines.js';

export type ExecMode = 'plan' | 'edit' | 'full';
export type ExecEffort = 'fast' | 'default' | 'detailed';

export interface ExecOptions {
  agent: AgentId;
  version?: string;
  prompt: string;
  mode: ExecMode;
  effort: ExecEffort;
  cwd?: string;
  headless?: boolean;
  json?: boolean;
  model?: string;
  addDirs?: string[];
  timeout?: string;
  sessionId?: string;
  verbose?: boolean;
  env?: Record<string, string>;
}

const EXEC_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseExecEnvEntry(entry: string): [string, string] {
  const separatorIndex = entry.indexOf('=');
  if (separatorIndex <= 0) {
    throw new Error(`Invalid --env value "${entry}". Use KEY=VALUE.`);
  }

  const key = entry.slice(0, separatorIndex).trim();
  const value = entry.slice(separatorIndex + 1);

  if (!EXEC_ENV_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid environment variable name "${key}".`);
  }

  return [key, value];
}

export function parseExecEnv(entries: string[]): Record<string, string> | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries.map(parseExecEnvEntry));
}

export function buildExecEnv(options: ExecOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...options.env,
  };
}

// Model mapping per agent per effort level
export const EFFORT_MODELS: Record<AgentId, Record<ExecEffort, string>> = {
  claude: {
    fast: 'claude-haiku-4-5-20251001',
    default: 'claude-sonnet-4-5',
    detailed: 'claude-opus-4-5',
  },
  codex: {
    fast: 'gpt-4o-mini',
    default: 'gpt-5.2-codex',
    detailed: 'gpt-5.1-codex-max',
  },
  gemini: {
    fast: 'gemini-3-flash-preview',
    default: 'gemini-3-flash-preview',
    detailed: 'gemini-3-pro-preview',
  },
  cursor: {
    fast: 'composer-1',
    default: 'composer-1',
    detailed: 'composer-1',
  },
  opencode: {
    fast: 'zai-coding-plan/glm-4.7-flash',
    default: 'zai-coding-plan/glm-4.7',
    detailed: 'zai-coding-plan/glm-4.7',
  },
  openclaw: {
    fast: 'claude-haiku-4-5-20251001',
    default: 'claude-sonnet-4-5',
    detailed: 'claude-opus-4-5',
  },
  copilot: {
    fast: 'gpt-4o-mini',
    default: 'gpt-4o',
    detailed: 'claude-sonnet-4-5',
  },
  amp: {
    fast: 'claude-haiku-4-5-20251001',
    default: 'claude-sonnet-4-5',
    detailed: 'claude-opus-4-5',
  },
  kiro: {
    fast: 'claude-haiku-4-5-20251001',
    default: 'claude-sonnet-4-5',
    detailed: 'claude-opus-4-5',
  },
  goose: {
    fast: 'gpt-4o-mini',
    default: 'gpt-4o',
    detailed: 'claude-sonnet-4-5',
  },
  roo: {
    fast: 'claude-haiku-4-5-20251001',
    default: 'claude-sonnet-4-5',
    detailed: 'claude-opus-4-5',
  },
};

// Command templates per agent
export interface AgentCommandTemplate {
  base: string[];
  promptFlag: 'positional' | string;
  modeFlags: {
    plan: string[];
    edit: string[];
    full: string[];
  };
  jsonFlags?: string[];
  modelFlag?: string;
  printFlags?: string[];
  verboseFlag?: string;
}

export const AGENT_COMMANDS: Record<AgentId, AgentCommandTemplate> = {
  claude: {
    base: ['claude'],
    promptFlag: '-p',
    modeFlags: {
      plan: ['--permission-mode', 'plan'],
      edit: ['--permission-mode', 'acceptEdits'],
      full: ['--dangerously-skip-permissions'],
    },
    jsonFlags: ['--output-format', 'stream-json', '--verbose'],
    modelFlag: '--model',
    printFlags: ['--print'],
    verboseFlag: '--verbose',
  },
  codex: {
    base: ['codex', 'exec'],
    promptFlag: 'positional',
    modeFlags: {
      plan: ['--sandbox', 'workspace-write'],
      edit: ['--sandbox', 'workspace-write', '--full-auto'],
      full: ['--full-auto'],
    },
    jsonFlags: ['--json'],
    modelFlag: '--model',
  },
  gemini: {
    base: ['gemini'],
    promptFlag: 'positional',
    modeFlags: {
      plan: [],
      edit: ['--yolo'],
      full: ['--yolo'],
    },
    jsonFlags: ['--output-format', 'stream-json'],
    modelFlag: '--model',
  },
  cursor: {
    base: ['cursor-agent'],
    promptFlag: '-p',
    modeFlags: {
      plan: [],
      edit: ['-f'],
      full: ['-f'],
    },
    jsonFlags: ['--output-format', 'stream-json'],
    modelFlag: '--model',
  },
  opencode: {
    base: ['opencode', 'run'],
    promptFlag: 'positional',
    modeFlags: {
      plan: ['--agent', 'plan'],
      edit: ['--agent', 'build'],
      full: ['--agent', 'build'],
    },
    jsonFlags: ['--format', 'json'],
    modelFlag: '--model',
  },
  openclaw: {
    base: ['openclaw'],
    promptFlag: 'positional',
    modeFlags: {
      plan: ['--mode', 'plan'],
      edit: ['--mode', 'edit'],
      full: ['--mode', 'full'],
    },
    jsonFlags: ['--output-format', 'stream-json'],
    modelFlag: '--model',
  },
  copilot: {
    base: ['copilot'],
    promptFlag: 'positional',
    modeFlags: {
      plan: [],
      edit: [],
      full: [],
    },
    modelFlag: '--model',
  },
  amp: {
    base: ['amp'],
    promptFlag: 'positional',
    modeFlags: {
      plan: ['--mode', 'plan'],
      edit: ['--mode', 'edit'],
      full: ['--mode', 'edit'],
    },
    modelFlag: '--model',
  },
  kiro: {
    base: ['kiro-cli'],
    promptFlag: 'positional',
    modeFlags: {
      plan: [],
      edit: [],
      full: [],
    },
    modelFlag: '--model',
  },
  goose: {
    base: ['goose', 'run'],
    promptFlag: 'positional',
    modeFlags: {
      plan: [],
      edit: [],
      full: [],
    },
  },
  roo: {
    base: ['roo'],
    promptFlag: 'positional',
    modeFlags: {
      plan: ['--mode', 'architect'],
      edit: ['--mode', 'code'],
      full: ['--mode', 'code'],
    },
    modelFlag: '--model',
  },
};

export function buildExecCommand(options: ExecOptions): string[] {
  const template = AGENT_COMMANDS[options.agent];
  const cmd: string[] = [...template.base];

  // Use versioned alias if a specific version was requested (e.g., claude@2.1.98)
  if (options.version && cmd.length > 0) {
    cmd[0] = `${cmd[0]}@${options.version}`;
  }

  // Add mode flags
  const modeFlags = template.modeFlags[options.mode];
  cmd.push(...modeFlags);

  // Add print/headless flags
  if (options.headless && template.printFlags) {
    cmd.push(...template.printFlags);
  }

  // Add session ID (Claude only)
  if (options.sessionId && options.agent === 'claude') {
    cmd.push('--session-id', options.sessionId);
  }

  // Add model (from explicit option or effort mapping)
  const model = options.model || EFFORT_MODELS[options.agent][options.effort];
  if (model && template.modelFlag) {
    cmd.push(template.modelFlag, model);
  }

  // Add JSON output flags if requested
  if (options.json && template.jsonFlags) {
    cmd.push(...template.jsonFlags);
  }

  // Add verbose flag independently of JSON
  if (options.verbose && template.verboseFlag) {
    // Avoid duplicate if jsonFlags already included --verbose
    if (!(options.json && template.jsonFlags?.includes(template.verboseFlag))) {
      cmd.push(template.verboseFlag);
    }
  }

  // Add prompt
  if (template.promptFlag === 'positional') {
    cmd.push(options.prompt);
  } else {
    cmd.push(template.promptFlag, options.prompt);
  }

  // Claude-specific: add dirs
  if (options.agent === 'claude' && options.addDirs) {
    for (const dir of options.addDirs) {
      cmd.push('--add-dir', dir);
    }
  }

  return cmd;
}

export async function execAgent(options: ExecOptions): Promise<number> {
  const cmd = buildExecCommand(options);
  const [executable, ...args] = cmd;

  const timeoutMs = options.timeout ? parseTimeout(options.timeout) : undefined;

  // When stdout is piped, separate agent output (stdout) from status (stderr)
  // so `agents exec claude "..." | agents exec codex "..."` works cleanly.
  // When interactive (TTY), inherit everything for the full experience.
  const piped = !process.stdout.isTTY;

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd || process.cwd(),
      stdio: piped ? ['inherit', 'pipe', 'inherit'] : 'inherit',
      env: buildExecEnv(options),
      shell: false,
    });

    if (piped && child.stdout) {
      child.stdout.pipe(process.stdout);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
      }, timeoutMs);
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve(code ?? 0);
    });
  });
}
