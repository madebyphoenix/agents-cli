import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import type { SessionAgentId, ViewMode } from '../lib/session/types.js';
import { SESSION_AGENTS } from '../lib/session/types.js';
import { discoverSessions, resolveSessionById } from '../lib/session/discover.js';
import { parseSession } from '../lib/session/parse.js';
import { renderTranscript, renderSummary, renderTrace, renderJson } from '../lib/session/render.js';

const AGENT_COLORS: Record<SessionAgentId, (s: string) => string> = {
  claude: chalk.magenta,
  codex: chalk.green,
  gemini: chalk.blue,
};

interface ListOptions {
  agent?: string;
  project?: string;
  limit?: string;
}

interface ViewOptions {
  summary?: boolean;
  trace?: boolean;
  json?: boolean;
}

async function listAction(options: ListOptions): Promise<void> {
  const agent = options.agent as SessionAgentId | undefined;
  if (agent && !SESSION_AGENTS.includes(agent)) {
    console.error(chalk.red(`Unknown agent: ${agent}. Use: ${SESSION_AGENTS.join(', ')}`));
    process.exit(1);
  }

  const limit = parseInt(options.limit || '20', 10);
  const spinner = ora('Scanning sessions...').start();

  try {
    const sessions = await discoverSessions({
      agent,
      project: options.project,
      limit,
    });

    spinner.stop();

    if (sessions.length === 0) {
      console.log(chalk.gray('No sessions found.'));
      return;
    }

    // Print header
    console.log(
      chalk.gray(
        padRight('ID', 10) +
        padRight('Agent', 8) +
        padRight('Project', 20) +
        padRight('When', 16) +
        'Branch'
      )
    );

    for (const session of sessions) {
      const agentColor = AGENT_COLORS[session.agent] || chalk.white;
      const when = formatRelativeTime(session.timestamp);
      const project = session.project || '-';
      const branch = session.gitBranch || '';

      console.log(
        chalk.white(padRight(session.shortId, 10)) +
        agentColor(padRight(session.agent, 8)) +
        chalk.cyan(padRight(project.length > 18 ? project.slice(0, 17) + '.' : project, 20)) +
        chalk.gray(padRight(when, 16)) +
        chalk.gray(branch)
      );
    }

    console.log(chalk.gray(`\n${sessions.length} session${sessions.length === 1 ? '' : 's'}. Use 'agents sessions view <id>' to read.`));
  } catch (err: any) {
    spinner.stop();
    console.error(chalk.red(`Failed to discover sessions: ${err.message}`));
    process.exit(1);
  }
}

async function viewAction(idQuery: string, options: ViewOptions): Promise<void> {
  // Determine output mode
  let mode: ViewMode = 'transcript';
  if (options.summary) mode = 'summary';
  else if (options.trace) mode = 'trace';
  else if (options.json) mode = 'json';

  const spinner = ora('Finding session...').start();

  try {
    // Discover all sessions to resolve the ID
    const allSessions = await discoverSessions({ limit: 500 });
    const matches = resolveSessionById(allSessions, idQuery);

    if (matches.length === 0) {
      spinner.stop();
      console.error(chalk.red(`No session found matching: ${idQuery}`));
      console.error(chalk.gray('Run "agents sessions" to list available sessions.'));
      process.exit(1);
    }

    if (matches.length > 1) {
      spinner.stop();
      console.error(chalk.yellow(`Multiple sessions match "${idQuery}":`));
      for (const m of matches) {
        const agentColor = AGENT_COLORS[m.agent] || chalk.white;
        console.error(
          `  ${chalk.white(m.id)} ${agentColor(m.agent)} ${chalk.cyan(m.project || '-')} ${chalk.gray(formatRelativeTime(m.timestamp))}`
        );
      }
      console.error(chalk.gray('\nProvide a longer ID to narrow the match.'));
      process.exit(1);
    }

    const session = matches[0];
    spinner.text = `Parsing ${session.agent} session...`;

    const events = parseSession(session.filePath, session.agent);
    spinner.stop();

    // Render and output
    let output: string;
    switch (mode) {
      case 'transcript': output = renderTranscript(events); break;
      case 'summary': output = renderSummary(events); break;
      case 'trace': output = renderTrace(events); break;
      case 'json': output = renderJson(events); break;
    }

    console.log(output);
  } catch (err: any) {
    spinner.stop();
    console.error(chalk.red(`Failed to read session: ${err.message}`));
    process.exit(1);
  }
}

export function registerSessionsCommands(program: Command): void {
  const sessionsCmd = program
    .command('sessions')
    .description('List and view agent sessions')
    .option('--agent <agent>', 'Filter by agent (claude, codex, gemini)')
    .option('--project <name>', 'Filter by project name')
    .option('-n, --limit <n>', 'Max sessions to show', '20')
    .action(async (options: ListOptions) => {
      await listAction(options);
    });

  sessionsCmd
    .command('list')
    .description('List sessions across agents')
    .option('--agent <agent>', 'Filter by agent (claude, codex, gemini)')
    .option('--project <name>', 'Filter by project name')
    .option('-n, --limit <n>', 'Max sessions to show', '20')
    .action(async (options: ListOptions) => {
      await listAction(options);
    });

  sessionsCmd
    .command('view <id>')
    .description('View a session')
    .option('--summary', 'Show activity fingerprint (files, commands)')
    .option('--trace', 'Show reasoning trace as markdown')
    .option('--json', 'Output normalized events as JSON')
    .action(async (id: string, options: ViewOptions) => {
      await viewAction(id, options);
    });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function padRight(s: string, width: number): string {
  return s.length >= width ? s + ' ' : s + ' '.repeat(width - s.length);
}

function formatRelativeTime(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  if (isNaN(then)) return isoTimestamp;

  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHrs = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHrs < 24) return `${diffHrs} hour${diffHrs === 1 ? '' : 's'} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;

  // Older: show date
  const d = new Date(then);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}
