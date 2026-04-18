import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { search } from '@inquirer/prompts';
import type { SessionAgentId, SessionMeta, ViewMode } from '../lib/session/types.js';
import { SESSION_AGENTS } from '../lib/session/types.js';
import { discoverSessions, resolveSessionById } from '../lib/session/discover.js';
import { parseSession } from '../lib/session/parse.js';
import { renderTranscript, renderSummary, renderTrace, renderJson } from '../lib/session/render.js';
import { renderMarkdown } from '../lib/markdown.js';
import { colorAgent } from '../lib/agents.js';
import { isInteractiveTerminal, isPromptCancelled, requireInteractiveSelection } from './utils.js';

interface SessionFilterOptions {
  agent?: string;
  project?: string;
  all?: boolean;
}

interface ListOptions extends SessionFilterOptions {
  limit?: string;
}

interface ViewOptions extends SessionFilterOptions {
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

interface ClaudeResumeMatch {
  session: SessionMeta;
  resumeTimestampMs: number;
  deltaMs: number;
}

const CLAUDE_RESUME_MATCH_WINDOW_MS = 10 * 60_000;

async function listAction(options: ListOptions): Promise<void> {
  const agent = parseAgentFilter(options.agent);

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
      console.log(chalk.gray(formatNoSessionsMessage(options.all, false, options.project)));
      return;
    }

    if (shouldUseFilteredSessionSearch(options)) {
      const picked = await pickSession(sessions, formatSearchMessage(options));
      if (picked) {
        await renderSession(picked, 'summary');
        return;
      }
    }

    // Print header
    console.log(
      chalk.gray(
        padRight('ID', 10) +
        padRight('Account', 20) +
        padRight('Agent', 18) +
        padRight('Project', 16) +
        padRight('When', 14) +
        padRight('Msgs', 8) +
        padRight('Tokens', 10) +
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
        chalk.gray(padRight(formatCompactMetric(session.messageCount), 8)) +
        chalk.gray(padRight(formatCompactMetric(session.tokenCount), 10)) +
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
    chalk.gray(padRight(formatCompactMetric(s.messageCount), 8)) +
    chalk.gray(padRight(formatCompactMetric(s.tokenCount), 10)) +
    chalk.white(truncate(topic, 30))
  );
}

async function pickSession(
  sessions: SessionMeta[],
  message = 'Search sessions:',
): Promise<SessionMeta | null> {
  try {
    return await search({
      message,
      pageSize: 12,
      source: async (input) => {
        const matches = filterSessionsByQuery(sessions, input).slice(0, 30);
        if (matches.length === 0) {
          return [{
            name: input?.trim()
              ? `No sessions found for "${input.trim()}"`
              : 'No sessions found',
            value: null,
            disabled: 'Keep typing',
          }];
        }

        return matches.map(s => ({
          name: formatPickerLabel(s),
          value: s,
          description: formatSearchDescription(s),
          short: s.shortId,
        }));
      },
      validate: (value) => value ? true : 'No matching sessions.',
    });
  } catch (err) {
    if (isPromptCancelled(err)) return null;
    throw err;
  }
}

function parseAgentFilter(agentName?: string): SessionAgentId | undefined {
  const agent = agentName as SessionAgentId | undefined;
  if (agent && !SESSION_AGENTS.includes(agent)) {
    console.error(chalk.red(`Unknown agent: ${agent}. Use: ${SESSION_AGENTS.join(', ')}`));
    process.exit(1);
  }
  return agent;
}

function shouldUseFilteredSessionSearch(options: SessionFilterOptions): boolean {
  return isInteractiveTerminal() && Boolean(options.agent || options.project);
}

function formatSearchMessage(options: SessionFilterOptions): string {
  const filters: string[] = [];
  if (options.agent) filters.push(`agent: ${options.agent}`);
  if (options.project?.trim()) filters.push(`project: ${options.project.trim()}`);
  if (filters.length === 0) return 'Search sessions:';
  return `Search sessions (${filters.join(', ')}):`;
}

function formatSearchDescription(session: SessionMeta): string {
  return [session.id, session.cwd].filter(Boolean).join('  ');
}

function filterSessionsByQuery(
  sessions: SessionMeta[],
  query: string | undefined,
): SessionMeta[] {
  const trimmed = query?.trim().toLowerCase() || '';
  if (!trimmed) return sessions;

  const terms = trimmed.split(/\s+/).filter(Boolean);

  return sessions
    .map(session => ({ session, score: scoreSessionQuery(session, terms) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.session.timestamp).getTime() - new Date(a.session.timestamp).getTime();
    })
    .map(entry => entry.session);
}

function scoreSessionQuery(session: SessionMeta, terms: string[]): number {
  let score = 0;

  for (const term of terms) {
    const exactId = session.id.toLowerCase() === term || session.shortId.toLowerCase() === term;
    const prefixId = session.id.toLowerCase().startsWith(term) || session.shortId.toLowerCase().startsWith(term);
    const topic = session.topic?.toLowerCase() || '';
    const project = session.project?.toLowerCase() || '';
    const account = session.account?.toLowerCase() || '';
    const cwd = session.cwd?.toLowerCase() || '';
    const agent = session.agent.toLowerCase();
    const version = session.version?.toLowerCase() || '';

    let termScore = 0;
    if (exactId) termScore = 1000;
    else if (prefixId) termScore = 900;
    else if (topic.startsWith(term)) termScore = 700;
    else if (project.startsWith(term)) termScore = 600;
    else if (account.startsWith(term)) termScore = 550;
    else if (agent.startsWith(term) || version.startsWith(term)) termScore = 500;
    else if (topic.includes(term)) termScore = 400;
    else if (project.includes(term)) termScore = 300;
    else if (account.includes(term)) termScore = 250;
    else if (cwd.includes(term)) termScore = 200;
    else if (version.includes(term) || agent.includes(term)) termScore = 150;
    else return 0;

    score += termScore;
  }

  return score;
}

async function viewAction(idQuery: string | undefined, options: ViewOptions): Promise<void> {
  // Default to summary, opt into full transcript
  let mode: ViewMode = 'summary';
  if (options.transcript) mode = 'transcript';
  else if (options.trace) mode = 'trace';
  else if (options.json) mode = 'json';
  const agent = parseAgentFilter(options.agent);

  const spinner = ora('Finding session...').start();

  try {
    const allSessions = await discoverSessions({
      agent,
      all: Boolean(idQuery) || options.all,
      cwd: process.cwd(),
      project: options.project,
      limit: 5000,
    });
    let session: SessionMeta | undefined;

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

      const picked = await pickSession(allSessions, formatSearchMessage(options));
      if (!picked) return;
      session = picked;
    } else {
      const matches = resolveSessionById(allSessions, idQuery);
      const queryMatches = matches.length > 0 ? matches : filterSessionsByQuery(allSessions, idQuery);

      if (queryMatches.length === 0) {
        spinner.stop();
        const historyEntry = findClaudeHistoryEntry(idQuery);
        if (historyEntry) {
          const resumeMatch = resolveClaudeHistoryEntryToTranscript(historyEntry, allSessions);
          if (resumeMatch) {
            session = resumeMatch.session;
            console.log(chalk.gray(
              `Resolved Claude history entry ${idQuery} to transcript ${resumeMatch.session.id}.`
            ));
          } else {
            renderClaudeHistoryOnlyId(idQuery, historyEntry, allSessions);
            process.exit(1);
          }
        } else {
          console.error(chalk.red(`No session found matching: ${idQuery}`));
          console.error(chalk.gray('Run "agents sessions" to list available sessions.'));
          process.exit(1);
        }
      }

      if (queryMatches.length === 0) {
        // session already resolved from history fallback
      } else if (queryMatches.length > 1) {
        spinner.stop();
        if (!isInteractiveTerminal()) {
          console.error(chalk.red(`Multiple sessions match: ${idQuery}`));
          console.error(chalk.gray('Pass a longer ID/query or one of these exact IDs:'));
          for (const match of queryMatches.slice(0, 10)) {
            console.error(chalk.cyan(`  ${match.id}`));
          }
          process.exit(1);
        }
        // Multiple matches -- let the user pick
        const picked = await pickSession(queryMatches, formatSearchMessage(options));
        if (!picked) return;
        session = picked;
      } else {
        session = queryMatches[0];
      }
    }

    if (!session) {
      throw new Error('Session resolution failed');
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
    .option('--project <name>', 'Filter by project name across all directories')
    .option('-n, --limit <n>', 'Max sessions to show', '20')
    .action(async (options: ListOptions) => {
      await listAction(options);
    });

  sessionsCmd
    .command('list')
    .description('List sessions for the current directory by default')
    .option('--agent <agent>', 'Filter by agent (claude, codex, gemini)')
    .option('--all', 'Show sessions from every directory')
    .option('--project <name>', 'Filter by project name across all directories')
    .option('-n, --limit <n>', 'Max sessions to show', '20')
    .action(async (options: ListOptions) => {
      await listAction(options);
    });

  sessionsCmd
    .command('view [id]')
    .description('View a session by ID or search query (picker defaults to live search)')
    .option('--agent <agent>', 'Filter by agent (claude, codex, gemini)')
    .option('--all', 'Show sessions from every directory')
    .option('--project <name>', 'Filter by project name across all directories')
    .option('--transcript', 'Show full conversation transcript')
    .option('--trace', 'Show reasoning trace as markdown')
    .option('--json', 'Output normalized events as JSON')
    .action(async (id: string | undefined, options: ViewOptions) => {
      await viewAction(id, options);
    });
}

function formatNoSessionsMessage(
  showAll: boolean | undefined,
  picker = false,
  project?: string,
): string {
  const projectQuery = project?.trim();
  if (projectQuery) {
    return `No sessions found for project "${projectQuery}".`;
  }
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
  return findClaudeProjectSessions(sessions, historyEntry)
    .sort((a, b) => sessionDistance(a, historyEntry) - sessionDistance(b, historyEntry))
    .slice(0, 3);
}

function findClaudeProjectSessions(
  sessions: SessionMeta[],
  historyEntry: ClaudeHistoryEntry,
): SessionMeta[] {
  if (!historyEntry.project) return [];
  const projectRoot = historyEntry.project;

  return sessions.filter(session =>
    session.agent === 'claude' &&
    typeof session.cwd === 'string' &&
    isWithinProject(session.cwd, projectRoot)
  );
}

function resolveClaudeHistoryEntryToTranscript(
  historyEntry: ClaudeHistoryEntry,
  sessions: SessionMeta[],
): ClaudeResumeMatch | null {
  if (historyEntry.display !== '/resume') return null;

  const candidates = findClaudeProjectSessions(sessions, historyEntry);
  const matches: ClaudeResumeMatch[] = [];

  for (const session of candidates) {
    const resumeTimestampMs = findClaudeResumeTimestamp(session.filePath, historyEntry.timestampMs);
    if (resumeTimestampMs === null) continue;

    const deltaMs = historyEntry.timestampMs === undefined
      ? 0
      : Math.abs(resumeTimestampMs - historyEntry.timestampMs);

    if (historyEntry.timestampMs !== undefined && deltaMs > CLAUDE_RESUME_MATCH_WINDOW_MS) {
      continue;
    }

    matches.push({ session, resumeTimestampMs, deltaMs });
  }

  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    if (a.deltaMs !== b.deltaMs) return a.deltaMs - b.deltaMs;
    return b.resumeTimestampMs - a.resumeTimestampMs;
  });

  const [best, second] = matches;
  if (second && best.deltaMs === second.deltaMs && best.resumeTimestampMs === second.resumeTimestampMs) {
    return null;
  }

  return best;
}

function findClaudeResumeTimestamp(filePath: string, targetTimestampMs?: number): number | null {
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    let bestTimestampMs: number | null = null;

    for (const line of lines) {
      if (!line.includes('SessionStart:resume')) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (parsed.attachment?.hookName !== 'SessionStart:resume') continue;

      const timestampMs = Date.parse(parsed.timestamp || '');
      if (Number.isNaN(timestampMs)) continue;

      if (targetTimestampMs === undefined) {
        return timestampMs;
      }

      if (bestTimestampMs === null || Math.abs(timestampMs - targetTimestampMs) < Math.abs(bestTimestampMs - targetTimestampMs)) {
        bestTimestampMs = timestampMs;
      }
    }

    return bestTimestampMs;
  } catch {
    return null;
  }
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

function formatCompactMetric(value?: number): string {
  if (value === undefined) return '-';
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    const compact = value / 1000;
    return compact >= 100 ? `${Math.round(compact)}k` : `${compact.toFixed(1).replace(/\.0$/, '')}k`;
  }
  const compact = value / 1_000_000;
  return compact >= 100 ? `${Math.round(compact)}m` : `${compact.toFixed(1).replace(/\.0$/, '')}m`;
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
