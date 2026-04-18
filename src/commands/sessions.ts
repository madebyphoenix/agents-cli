import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { select } from '@inquirer/prompts';
import type { SessionAgentId, SessionMeta, ViewMode } from '../lib/session/types.js';
import { SESSION_AGENTS } from '../lib/session/types.js';
import { discoverSessions, resolveSessionById } from '../lib/session/discover.js';
import { parseSession } from '../lib/session/parse.js';
import { renderTranscript, renderSummary, renderTrace, renderJson } from '../lib/session/render.js';
import { renderMarkdown } from '../lib/markdown.js';
import { colorAgent } from '../lib/agents.js';
import { isInteractiveTerminal, isPromptCancelled, requireInteractiveSelection } from './utils.js';

interface ListOptions {
  agent?: string;
  project?: string;
  all?: boolean;
  limit?: string;
}

interface ViewOptions {
  all?: boolean;
  transcript?: boolean;
  trace?: boolean;
  json?: boolean;
}

interface ClaudeHistoryEntry {
  sessionId: string;
  display?: string;
  project?: string;
  timestampMs?: number;
  historyPath: string;
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
      all: options.all,
      cwd: process.cwd(),
      project: options.project,
      limit,
    });

    spinner.stop();

    if (sessions.length === 0) {
      console.log(chalk.gray(formatNoSessionsMessage(options.all)));
      return;
    }

    // Print header
    console.log(
      chalk.gray(
        padRight('ID', 10) +
        padRight('Account', 20) +
        padRight('Agent', 18) +
        padRight('Project', 16) +
        padRight('When', 14) +
        'Topic'
      )
    );

    for (const session of sessions) {
      const agentColor = colorAgent(session.agent);
      const when = formatRelativeTime(session.timestamp);
      const project = session.project || '-';
      const account = session.account || '';
      const agentLabel = session.version
        ? `${session.agent}@${session.version}`
        : session.agent;
      const topic = session.topic || '';

      console.log(
        chalk.white(padRight(session.shortId, 10)) +
        chalk.gray(padRight(truncate(account, 18), 20)) +
        agentColor(padRight(truncate(agentLabel, 16), 18)) +
        chalk.cyan(padRight(truncate(project, 14), 16)) +
        chalk.gray(padRight(when, 14)) +
        chalk.white(truncate(topic, 40))
      );
    }

    console.log(chalk.gray(`\n${sessions.length} session${sessions.length === 1 ? '' : 's'}. Use 'agents sessions view <id>' to read.`));
  } catch (err: any) {
    spinner.stop();
    console.error(chalk.red(`Failed to discover sessions: ${err.message}`));
    process.exit(1);
  }
}

async function renderSession(session: SessionMeta, mode: ViewMode): Promise<void> {
  // OpenCode stores sessions in SQLite; filePath is "db_path#session_id"
  const realPath = session.filePath.split('#')[0];
  if (!fs.existsSync(realPath)) {
    console.log(chalk.yellow('Session transcript not available (file no longer exists).'));
    console.log(chalk.gray(`Path: ${session.filePath}`));
    if (session.version) console.log(chalk.gray(`Version: ${session.agent} ${session.version}`));
    if (session.project) console.log(chalk.gray(`Project: ${session.project}`));
    if (session.account) console.log(chalk.gray(`Account: ${session.account}`));
    console.log(chalk.gray(`Time: ${session.timestamp}`));
    return;
  }

  // Session header
  const agentColor = colorAgent(session.agent);
  console.log('');
  console.log(
    agentColor(session.agent) +
    (session.version ? chalk.yellow(` ${session.version}`) : '') +
    (session.project ? chalk.cyan(` ${session.project}`) : '') +
    chalk.gray(` ${formatRelativeTime(session.timestamp)}`) +
    (session.account ? chalk.gray(` (${session.account})`) : '')
  );
  console.log(chalk.gray('─'.repeat(60)));

  const spinner = ora(`Parsing ${session.agent} session...`).start();
  const events = parseSession(session.filePath, session.agent);
  spinner.stop();

  let output: string;
  switch (mode) {
    case 'transcript': output = renderTranscript(events); break;
    case 'summary': output = renderMarkdown(renderSummary(events)); break;
    case 'trace': output = renderMarkdown(renderTrace(events)); break;
    case 'json': output = renderJson(events); break;
  }

  process.stdout.write(output);
}

function formatPickerLabel(s: SessionMeta): string {
  const agentColor = colorAgent(s.agent);
  const when = formatRelativeTime(s.timestamp);
  const project = s.project || '-';
  const account = s.account || '';
  const agentLabel = s.version ? `${s.agent}@${s.version}` : s.agent;
  const topic = s.topic || '';

  return (
    chalk.white(padRight(s.shortId, 10)) +
    chalk.gray(padRight(truncate(account, 18), 20)) +
    agentColor(padRight(truncate(agentLabel, 16), 18)) +
    chalk.cyan(padRight(truncate(project, 14), 16)) +
    chalk.gray(padRight(when, 14)) +
    chalk.white(truncate(topic, 30))
  );
}

async function pickSession(sessions: SessionMeta[]): Promise<SessionMeta | null> {
  try {
    return await select({
      message: 'Select a session:',
      choices: sessions.map(s => ({
        name: formatPickerLabel(s),
        value: s,
      })),
    });
  } catch (err) {
    if (isPromptCancelled(err)) return null;
    throw err;
  }
}

async function viewAction(idQuery: string | undefined, options: ViewOptions): Promise<void> {
  // Default to summary, opt into full transcript
  let mode: ViewMode = 'summary';
  if (options.transcript) mode = 'transcript';
  else if (options.trace) mode = 'trace';
  else if (options.json) mode = 'json';

  const spinner = ora('Finding session...').start();

  try {
    const allSessions = await discoverSessions({
      all: Boolean(idQuery) || options.all,
      cwd: process.cwd(),
      limit: 5000,
    });
    let session: SessionMeta;

    if (!idQuery) {
      // No ID provided -- show interactive picker
      spinner.stop();

      if (allSessions.length === 0) {
        console.log(chalk.gray(formatNoSessionsMessage(options.all, true)));
        return;
      }

      if (!isInteractiveTerminal()) {
        requireInteractiveSelection('Selecting a session to view', [
          'agents sessions list',
          'agents sessions view <id>',
        ]);
      }

      // Show at most 30 in the picker
      const picked = await pickSession(allSessions.slice(0, 30));
      if (!picked) return;
      session = picked;
    } else {
      // Resolve by ID
      const matches = resolveSessionById(allSessions, idQuery);

      if (matches.length === 0) {
        spinner.stop();
        const historyEntry = findClaudeHistoryEntry(idQuery);
        if (historyEntry) {
          renderClaudeHistoryOnlyId(idQuery, historyEntry, allSessions);
          process.exit(1);
        }
        console.error(chalk.red(`No session found matching: ${idQuery}`));
        console.error(chalk.gray('Run "agents sessions" to list available sessions.'));
        process.exit(1);
      }

      if (matches.length > 1) {
        spinner.stop();
        if (!isInteractiveTerminal()) {
          console.error(chalk.red(`Multiple sessions match: ${idQuery}`));
          console.error(chalk.gray('Pass a longer ID or one of these exact IDs:'));
          for (const match of matches.slice(0, 10)) {
            console.error(chalk.cyan(`  ${match.id}`));
          }
          process.exit(1);
        }
        // Multiple matches -- let the user pick
        const picked = await pickSession(matches);
        if (!picked) return;
        session = picked;
      } else {
        session = matches[0];
      }
    }

    spinner.stop();
    await renderSession(session, mode);
  } catch (err: any) {
    if (isPromptCancelled(err)) return;
    spinner.stop();
    console.error(chalk.red(`Failed to read session: ${err.message}`));
    process.exit(1);
  }
}

export function registerSessionsCommands(program: Command): void {
  const sessionsCmd = program
    .command('sessions')
    .description('List and view agent sessions for the current directory by default')
    .option('--agent <agent>', 'Filter by agent (claude, codex, gemini)')
    .option('--all', 'Show sessions from every directory')
    .option('--project <name>', 'Filter by project name')
    .option('-n, --limit <n>', 'Max sessions to show', '20')
    .action(async (options: ListOptions) => {
      await listAction(options);
    });

  sessionsCmd
    .command('list')
    .description('List sessions for the current directory by default')
    .option('--agent <agent>', 'Filter by agent (claude, codex, gemini)')
    .option('--all', 'Show sessions from every directory')
    .option('--project <name>', 'Filter by project name')
    .option('-n, --limit <n>', 'Max sessions to show', '20')
    .action(async (options: ListOptions) => {
      await listAction(options);
    });

  sessionsCmd
    .command('view [id]')
    .description('View a session (picker defaults to the current directory)')
    .option('--all', 'Show sessions from every directory')
    .option('--transcript', 'Show full conversation transcript')
    .option('--trace', 'Show reasoning trace as markdown')
    .option('--json', 'Output normalized events as JSON')
    .action(async (id: string | undefined, options: ViewOptions) => {
      await viewAction(id, options);
    });
}

function formatNoSessionsMessage(showAll: boolean | undefined, picker = false): string {
  if (showAll) return 'No sessions found.';
  const command = picker ? 'agents sessions view --all' : 'agents sessions --all';
  return `No sessions found for ${process.cwd()}. Run "${command}" to see sessions from every directory.`;
}

function findClaudeHistoryEntry(idQuery: string): ClaudeHistoryEntry | null {
  const historyPath = path.join(os.homedir(), '.claude', 'history.jsonl');
  if (!fs.existsSync(historyPath)) return null;

  try {
    const lines = fs.readFileSync(historyPath, 'utf-8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (parsed.sessionId !== idQuery) continue;

      const timestampMs = typeof parsed.timestamp === 'number'
        ? parsed.timestamp
        : typeof parsed.timestamp === 'string'
          ? Date.parse(parsed.timestamp)
          : undefined;

      return {
        sessionId: parsed.sessionId,
        display: typeof parsed.display === 'string' ? parsed.display : undefined,
        project: typeof parsed.project === 'string' ? parsed.project : undefined,
        timestampMs: Number.isFinite(timestampMs) ? timestampMs : undefined,
        historyPath,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function renderClaudeHistoryOnlyId(
  idQuery: string,
  historyEntry: ClaudeHistoryEntry,
  allSessions: SessionMeta[],
): void {
  console.error(chalk.red(`No transcript session found matching: ${idQuery}`));
  console.error(chalk.yellow('This ID exists in Claude history, but not as a saved transcript session.'));
  console.error(chalk.gray(`History file: ${historyEntry.historyPath}`));

  if (historyEntry.display) {
    console.error(chalk.gray(`History entry: ${historyEntry.display}`));
  }

  if (historyEntry.project) {
    console.error(chalk.gray(`Project root: ${historyEntry.project}`));
  }

  if (historyEntry.timestampMs) {
    console.error(chalk.gray(`History time: ${new Date(historyEntry.timestampMs).toISOString()}`));
  }

  const relatedSessions = findClaudeSessionsInProject(allSessions, historyEntry);
  if (relatedSessions.length > 0) {
    console.error(chalk.gray('Claude transcript sessions in the same project tree:'));
    for (const session of relatedSessions) {
      console.error(
        chalk.gray(
          `  ${session.shortId}  ${session.id}  ${session.project || '-'}  ${formatRelativeTime(session.timestamp)}`
        )
      );
    }

    console.error(chalk.gray('Use one of the transcript IDs above with "agents sessions view <id>".'));
    return;
  }

  if (historyEntry.display === '/resume') {
    console.error(chalk.gray('This looks like a Claude /resume history entry. In this case, the resumed conversation continued under a different transcript session ID.'));
  }

  const projectHint = historyEntry.project ? path.basename(historyEntry.project) : 'the project';
  console.error(chalk.gray(`Try "agents sessions --agent claude --project ${projectHint}" to find the resumed transcript session.`));
}

function findClaudeSessionsInProject(
  sessions: SessionMeta[],
  historyEntry: ClaudeHistoryEntry,
): SessionMeta[] {
  if (!historyEntry.project) return [];

  return sessions
    .filter(session =>
      session.agent === 'claude' &&
      typeof session.cwd === 'string' &&
      isWithinProject(session.cwd, historyEntry.project!)
    )
    .sort((a, b) => sessionDistance(a, historyEntry) - sessionDistance(b, historyEntry))
    .slice(0, 3);
}

function isWithinProject(sessionCwd: string, projectRoot: string): boolean {
  return sessionCwd === projectRoot || sessionCwd.startsWith(projectRoot + path.sep);
}

function sessionDistance(session: SessionMeta, historyEntry: ClaudeHistoryEntry): number {
  if (!historyEntry.timestampMs) return Number.MAX_SAFE_INTEGER;
  const sessionTime = new Date(session.timestamp).getTime();
  if (Number.isNaN(sessionTime)) return Number.MAX_SAFE_INTEGER;
  return Math.abs(sessionTime - historyEntry.timestampMs);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function padRight(s: string, width: number): string {
  return s.length >= width ? s + ' ' : s + ' '.repeat(width - s.length);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '.' : s;
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
