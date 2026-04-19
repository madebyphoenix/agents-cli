import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import type { SessionAgentId, SessionMeta, ViewMode } from '../lib/session/types.js';
import { SESSION_AGENTS } from '../lib/session/types.js';
import { discoverSessions, resolveSessionById, searchContentIndex, parseTimeFilter, type ScanProgress } from '../lib/session/discover.js';
import { parseSession } from '../lib/session/parse.js';
import { renderTranscript, renderSummary, renderSummaryHeader, computeSummaryStats, renderTrace, renderJson } from '../lib/session/render.js';
import { renderMarkdown } from '../lib/markdown.js';
import { colorAgent } from '../lib/agents.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { sessionPicker, type PickedSession } from './sessions-picker.js';

const SESSION_AGENT_FILTER_HELP = `Filter by agent, e.g. claude, codex, claude@2.0.65`;

interface SessionFilterOptions {
  agent?: string;
  project?: string;
  all?: boolean;
  since?: string;
  until?: string;
}

interface SessionsOptions extends SessionFilterOptions {
  limit?: string;
  json?: boolean;
  transcript?: boolean;
  trace?: boolean;
}

interface ListOptions extends SessionFilterOptions {
  limit?: string;
  json?: boolean;
}

interface ViewOptions {
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

const LOAD_VERBS = ['Loading', 'Scanning', 'Gathering', 'Indexing', 'Reading'];
const FIND_VERBS = ['Finding', 'Searching', 'Locating', 'Matching'];

interface ProgressTracker {
  onProgress: (progress: ScanProgress) => void;
  stop: () => void;
}

function createScanProgressTracker(
  verbs: string[],
  suffix: string,
  spinner: ReturnType<typeof ora> | null,
): ProgressTracker {
  const counts = new Map<SessionAgentId, { parsed: number; total: number }>();
  let verbIndex = 0;

  const render = (): void => {
    if (!spinner) return;
    const verb = verbs[verbIndex % verbs.length];
    const parts: string[] = [];
    for (const agent of SESSION_AGENTS) {
      const c = counts.get(agent);
      if (!c || c.total === 0) continue;
      parts.push(`${agent} ${c.parsed}/${c.total}`);
    }
    const base = `${verb} ${suffix}...`;
    spinner.text = parts.length > 0 ? `${base} (${parts.join(' · ')})` : base;
  };

  const interval = spinner
    ? setInterval(() => {
        verbIndex++;
        render();
      }, 900)
    : null;

  render();

  return {
    onProgress: (progress: ScanProgress) => {
      counts.set(progress.agent, { parsed: progress.parsed, total: progress.total });
      render();
    },
    stop: () => {
      if (interval) clearInterval(interval);
    },
  };
}

const PICKER_RECENT_COUNT = 15;
const PICKER_POOL_LIMIT = 200;

/**
 * Detect whether a positional argument looks like a filesystem path.
 * Naked paths (., ./, ../, /, ~) filter sessions by project directory.
 * Everything else is treated as a search query string.
 */
function isPathLike(query: string): boolean {
  return query === '.' || query.startsWith('./') || query.startsWith('../')
    || query.startsWith('/') || query.startsWith('~');
}

/**
 * Resolve a path-like query to an absolute directory path.
 */
function resolvePathFilter(query: string): string {
  const expanded = query.startsWith('~')
    ? path.join(os.homedir(), query.slice(1))
    : query;
  return path.resolve(expanded);
}

async function sessionsAction(query: string | undefined, options: SessionsOptions): Promise<void> {
  const { agent, version } = parseAgentFilter(options.agent);

  // Path-like queries filter by project directory instead of text search.
  let pathFilter: string | undefined;
  let searchQuery: string | undefined;
  if (query && isPathLike(query)) {
    const resolved = resolvePathFilter(query);
    if (!fs.existsSync(resolved)) {
      console.log(chalk.yellow(`Path not found: ${resolved}`));
      console.log(chalk.gray('Did you mean to search? Use quotes: agents sessions "' + query + '"'));
      return;
    }
    pathFilter = fs.realpathSync(resolved);
  } else {
    searchQuery = query;
  }

  // Interactive picker loads a deep pool but shows only recent sessions
  // until the user starts typing. Non-interactive/JSON uses the explicit limit.
  const isInteractive = !options.json && isInteractiveTerminal();
  const limit = parseInt(options.limit || (isInteractive ? String(PICKER_POOL_LIMIT) : '50'), 10);
  const since = options.since ?? (isInteractive && !options.all ? '30d' : undefined);
  const spinner = options.json ? null : ora().start();
  const tracker = createScanProgressTracker(LOAD_VERBS, 'sessions', spinner);

  try {
    let sessions = await discoverSessions({
      agent,
      all: pathFilter ? true : options.all,
      cwd: process.cwd(),
      project: options.project,
      limit,
      since,
      until: options.until,
      onProgress: tracker.onProgress,
    });

    if (pathFilter) {
      sessions = sessions.filter(s =>
        typeof s.cwd === 'string' && isWithinProject(s.cwd, pathFilter!)
      );
    }

    tracker.stop();
    spinner?.stop();

    if (version) {
      sessions = sessions.filter(s => s.version === version);
    }

    // Smart routing: if query looks like a session ID, render directly
    if (searchQuery) {
      const idMatches = resolveSessionById(sessions, searchQuery);
      if (idMatches.length === 1) {
        const mode = resolveViewMode(options);
        await renderSession(idMatches[0], mode);
        return;
      }
    }

    if (options.json) {
      const filtered = searchQuery ? filterSessionsByQuery(sessions, searchQuery) : sessions;
      const serializable = filtered.map(s => {
        const { _matchedTerms, _bm25Score, ...rest } = s;
        return rest;
      });
      process.stdout.write(JSON.stringify(serializable, null, 2) + '\n');
      return;
    }

    if (sessions.length === 0) {
      if (pathFilter) {
        console.log(chalk.gray(`No sessions found for ${pathFilter}.`));
      } else {
        console.log(chalk.gray(formatNoSessionsMessage(options.all, options.project)));
      }
      return;
    }

    if (isInteractiveTerminal()) {
      const message = pathFilter
        ? `Search sessions (${path.basename(pathFilter)}):`
        : formatSearchMessage(options);
      const picked = await pickSessionInteractive(sessions, message, searchQuery);
      if (picked) {
        await handlePickedSession(picked);
        return;
      }
      return;
    }

    // Non-interactive fallback (piped output)
    const filtered = searchQuery ? filterSessionsByQuery(sessions, searchQuery) : sessions;
    printSessionTable(filtered);
  } catch (err: any) {
    tracker.stop();
    spinner?.stop();
    console.error(chalk.red(`Failed to discover sessions: ${err.message}`));
    process.exit(1);
  }
}

async function listAction(query: string | undefined, options: ListOptions): Promise<void> {
  const { agent, version } = parseAgentFilter(options.agent);

  let pathFilter: string | undefined;
  let searchQuery: string | undefined;
  if (query && isPathLike(query)) {
    const resolved = resolvePathFilter(query);
    if (!fs.existsSync(resolved)) {
      console.log(chalk.yellow(`Path not found: ${resolved}`));
      console.log(chalk.gray('Did you mean to search? Use quotes: agents sessions list "' + query + '"'));
      return;
    }
    pathFilter = fs.realpathSync(resolved);
  } else {
    searchQuery = query;
  }

  const limit = parseInt(options.limit || '20', 10);
  const spinner = options.json ? null : ora().start();
  const tracker = createScanProgressTracker(LOAD_VERBS, 'sessions', spinner);

  try {
    let sessions = await discoverSessions({
      agent,
      all: pathFilter ? true : options.all,
      cwd: process.cwd(),
      project: options.project,
      limit,
      since: options.since,
      until: options.until,
      onProgress: tracker.onProgress,
    });

    tracker.stop();
    spinner?.stop();

    if (pathFilter) {
      sessions = sessions.filter(s =>
        typeof s.cwd === 'string' && isWithinProject(s.cwd, pathFilter!)
      );
    }

    if (version) {
      sessions = sessions.filter(s => s.version === version);
    }

    const filtered = searchQuery ? filterSessionsByQuery(sessions, searchQuery) : sessions;

    if (options.json) {
      const serializable = filtered.map(s => {
        const { _matchedTerms, _bm25Score, ...rest } = s;
        return rest;
      });
      process.stdout.write(JSON.stringify(serializable, null, 2) + '\n');
      return;
    }

    if (filtered.length === 0) {
      console.log(chalk.gray(formatNoSessionsMessage(options.all, options.project)));
      return;
    }

    printSessionTable(filtered);
  } catch (err: any) {
    tracker.stop();
    spinner?.stop();
    console.error(chalk.red(`Failed to discover sessions: ${err.message}`));
    process.exit(1);
  }
}

function printSessionTable(sessions: SessionMeta[]): void {
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
    const topic = (session as any).label ?? session.topic ?? '';

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

  console.log(chalk.gray(`\n${sessions.length} session${sessions.length === 1 ? '' : 's'}.`));
}

function resolveViewMode(options: { transcript?: boolean; trace?: boolean; json?: boolean }): ViewMode {
  if (options.transcript) return 'transcript';
  if (options.trace) return 'trace';
  if (options.json) return 'json';
  return 'summary';
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

  const spinner = ora(`Parsing ${session.agent} session...`).start();
  const events = parseSession(session.filePath, session.agent);
  spinner.stop();

  const agentColor = colorAgent(session.agent);
  console.log('');

  if (mode === 'summary') {
    const stats = computeSummaryStats(events);
    const modelStr = stats.models.length > 0 ? chalk.yellow(`  ${stats.models.join(', ')}`) : '';
    const branchStr = session.gitBranch ? chalk.gray(` (${session.gitBranch})`) : '';
    const absTime = formatAbsoluteTime(session.timestamp);

    console.log(
      agentColor(session.agent) +
      (session.version ? chalk.yellow(` ${session.version}`) : '') +
      modelStr +
      (session.project ? chalk.cyan(`  ${session.project}`) + branchStr : branchStr) +
      chalk.gray(`  ${absTime} (${formatRelativeTime(session.timestamp)})`) +
      (session.account ? chalk.gray(` · ${session.account}`) : '')
    );
    const statsLine = renderSummaryHeader(stats);
    if (statsLine) console.log(chalk.gray(statsLine));
    console.log(chalk.gray('─'.repeat(60)));

    process.stdout.write(renderSummary(events, session.cwd));
  } else {
    console.log(
      agentColor(session.agent) +
      (session.version ? chalk.yellow(` ${session.version}`) : '') +
      (session.project ? chalk.cyan(` ${session.project}`) : '') +
      chalk.gray(` ${formatRelativeTime(session.timestamp)}`) +
      (session.account ? chalk.gray(` (${session.account})`) : '')
    );
    console.log(chalk.gray('─'.repeat(60)));

    let output: string;
    switch (mode) {
      case 'transcript': output = renderTranscript(events); break;
      case 'trace': output = renderMarkdown(renderTrace(events)); break;
      case 'json': output = renderJson(events); break;
      default: output = '';
    }
    process.stdout.write(output);
  }
}

function highlightTerms(text: string, query: string): string {
  if (!query.trim()) return chalk.white(text);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const term of terms) {
    const idx = text.toLowerCase().indexOf(term);
    if (idx !== -1) {
      const before = text.slice(0, idx);
      const match = text.slice(idx, idx + term.length);
      const after = text.slice(idx + term.length);
      return chalk.white(before) + chalk.bold.white(match) + chalk.white(after);
    }
  }
  return chalk.white(text);
}

function formatPickerLabel(s: SessionMeta, query: string): string {
  const agentColor = colorAgent(s.agent);
  const when = formatRelativeTime(s.timestamp);
  const project = s.project || '-';
  const displayText = padRight(truncate((s as any).label ?? s.topic ?? '', 50), 52);

  return (
    chalk.white(padRight(s.shortId, 10)) +
    agentColor(padRight(truncate(s.agent, 9), 10)) +
    chalk.cyan(padRight(truncate(project, 14), 16)) +
    highlightTerms(displayText, query) +
    chalk.gray(when)
  );
}

async function pickSessionInteractive(
  sessions: SessionMeta[],
  message = 'Search sessions:',
  initialSearch?: string,
): Promise<PickedSession | null> {
  try {
    return await sessionPicker({
      message,
      sessions,
      filter: (query: string) => {
        // No query: show only recent sessions. Typing: search the full pool.
        if (!query.trim()) return sessions.slice(0, PICKER_RECENT_COUNT);
        return filterSessionsByQuery(sessions, query);
      },
      labelFor: (s: SessionMeta, query: string) => formatPickerLabel(s, query),
      pageSize: PICKER_RECENT_COUNT,
      initialSearch,
    });
  } catch (err) {
    if (isPromptCancelled(err)) return null;
    throw err;
  }
}

async function handlePickedSession(picked: PickedSession): Promise<void> {
  if (picked.action === 'view') {
    await renderSession(picked.session, 'summary');
    return;
  }

  const resume = buildResumeCommand(picked.session);
  if (!resume) {
    console.log(chalk.yellow(
      `Resume is not supported for ${picked.session.agent} sessions yet. Showing summary instead.`
    ));
    await renderSession(picked.session, 'summary');
    return;
  }

  const cwd = picked.session.cwd && fs.existsSync(picked.session.cwd)
    ? picked.session.cwd
    : process.cwd();

  console.log(chalk.gray(`Resuming: ${resume.join(' ')} (cwd: ${cwd})`));

  await new Promise<void>((resolve) => {
    const child = spawn(resume[0], resume.slice(1), {
      cwd,
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', (err: any) => {
      console.error(chalk.red(`Failed to launch ${resume[0]}: ${err.message}`));
      if (err.code === 'ENOENT') {
        console.error(chalk.gray(`Make sure '${resume[0]}' is on your PATH.`));
      }
      resolve();
    });
    child.on('close', () => resolve());
  });
}

function buildResumeCommand(session: SessionMeta): string[] | null {
  switch (session.agent) {
    case 'claude':
      return ['claude', '--resume', session.id];
    case 'codex':
      return ['codex', 'resume', session.id];
    case 'opencode':
      return ['opencode', '--session', session.id];
    case 'gemini':
    case 'openclaw':
      return null;
  }
}


interface AgentFilter {
  agent?: SessionAgentId;
  version?: string;
}

function parseAgentFilter(agentName?: string): AgentFilter {
  if (!agentName) return {};
  const [name, version] = agentName.split('@', 2);
  const agent = name as SessionAgentId;
  if (!SESSION_AGENTS.includes(agent)) {
    console.error(chalk.red(`Unknown agent: ${name}. Use: ${SESSION_AGENTS.join(', ')}`));
    process.exit(1);
  }
  return { agent, version };
}

function formatSearchMessage(options: SessionFilterOptions): string {
  const filters: string[] = [];
  if (options.agent) filters.push(`agent: ${options.agent}`);
  if (options.project?.trim()) filters.push(`project: ${options.project.trim()}`);
  if (filters.length === 0) return 'Search sessions:';
  return `Search sessions (${filters.join(', ')}):`;
}

export function filterSessionsByQuery(
  sessions: SessionMeta[],
  query: string | undefined,
): SessionMeta[] {
  const trimmed = query?.trim().toLowerCase() || '';
  if (!trimmed) return sessions;

  const terms = trimmed.split(/\s+/).filter(Boolean);
  const contentIndex = searchContentIndex(sessions, trimmed);

  // If the query exactly matches a session label, short-circuit the structural
  // scorer (which would otherwise surface every session whose topic happens to
  // contain the same words) and return only the label hits.
  const EXACT_LABEL_SCORE = 1_000_000;
  const exactLabelHits = [...contentIndex.values()].filter(
    s => (s._bm25Score ?? 0) >= EXACT_LABEL_SCORE,
  );
  if (exactLabelHits.length > 0) {
    return exactLabelHits.sort(
      (a, b) => (b._bm25Score ?? 0) - (a._bm25Score ?? 0),
    );
  }

  return sessions
    .map(session => ({ session, score: scoreSessionQuery(session, terms) }))
    .filter(entry => {
      // Include if scored by topic/project/etc, or matched by content search
      if (entry.score > 0) return true;
      const contentMatch = contentIndex.get(entry.session.id);
      if (contentMatch && contentMatch._matchedTerms && contentMatch._matchedTerms.length > 0) {
        return true;
      }
      return false;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const cmA = contentIndex.get(a.session.id);
      const cmB = contentIndex.get(b.session.id);
      const bmA = cmA?._bm25Score ?? 0;
      const bmB = cmB?._bm25Score ?? 0;
      if (bmB !== bmA) return bmB - bmA;
      return new Date(b.session.timestamp).getTime() - new Date(a.session.timestamp).getTime();
    })
    .map(entry => {
      // Attach content match terms for highlighting
      const cm = contentIndex.get(entry.session.id);
      if (cm && cm._matchedTerms) {
        return { ...cm };
      }
      return entry.session;
    });
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

async function viewAction(idQuery: string, options: ViewOptions): Promise<void> {
  const mode = resolveViewMode(options);

  const spinner = ora().start();
  const tracker = createScanProgressTracker(FIND_VERBS, 'session', spinner);

  try {
    const allSessions = await discoverSessions({
      all: true,
      cwd: process.cwd(),
      limit: 5000,
      onProgress: tracker.onProgress,
    });
    tracker.stop();
    let session: SessionMeta | undefined;

    const matches = resolveSessionById(allSessions, idQuery);
    let queryMatches: SessionMeta[] = matches.length > 0 ? matches : filterSessionsByQuery(allSessions, idQuery);

    // Content search fallback when no title/topic/project matches
    if (queryMatches.length === 0) {
      const contentResults = searchContentIndex(allSessions, idQuery);
      if (contentResults.size > 0) {
        const matchedSessions = Array.from(contentResults.values())
          .sort((a, b) => (b._bm25Score ?? 0) - (a._bm25Score ?? 0));
        if (matchedSessions.length === 1) {
          session = matchedSessions[0];
        } else {
          queryMatches = matchedSessions;
        }
      }
    }

    if (queryMatches.length === 0 && !session) {
      spinner.stop();
      const historyEntry = findClaudeHistoryEntry(idQuery);
      if (historyEntry) {
        const resumeMatch = resolveClaudeHistoryEntryToTranscript(historyEntry, allSessions);
        if (resumeMatch) {
          session = resumeMatch.session;
        } else {
          renderClaudeHistoryOnlyId(idQuery, historyEntry, allSessions);
          process.exit(1);
        }
      } else {
        console.error(chalk.red(`No session found matching: ${idQuery}`));
        console.error(chalk.gray('Run "agents sessions" to browse sessions.'));
        process.exit(1);
      }
    }

    if (!session) {
      if (queryMatches.length > 1) {
        spinner.stop();
        console.error(chalk.red(`Multiple sessions match "${idQuery}":`));
        for (const match of queryMatches.slice(0, 10)) {
          console.error(chalk.cyan(`  ${match.shortId}  ${match.id}  ${(match as any).label ?? match.topic ?? ''}`));
        }
        console.error(chalk.gray('Pass a longer ID to narrow it down.'));
        process.exit(1);
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
    tracker.stop();
    spinner.stop();
    console.error(chalk.red(`Failed to read session: ${err.message}`));
    process.exit(1);
  }
}

export function registerSessionsCommands(program: Command): void {
  const sessionsCmd = program
    .command('sessions')
    .argument('[query]', 'Session ID, search query, or path (., ../, /path) to filter by project')
    .description('Browse, search, and resume agent sessions')
    .option('-a, --agent <agent>', SESSION_AGENT_FILTER_HELP)
    .option('--all', 'Show sessions from every directory')
    .option('--project <name>', 'Filter by project name across all directories')
    .option('--since <time>', 'Filter sessions newer than time (e.g., "2h", "7d", "4w", ISO date)')
    .option('--until <time>', 'Filter sessions older than time (ISO timestamp)')
    .option('-n, --limit <n>', 'Max sessions to show', '50')
    .option('--transcript', 'Show full conversation transcript (with ID)')
    .option('--trace', 'Show reasoning trace as markdown (with ID)')
    .option('--json', 'Output as JSON')
    .action(async (query: string | undefined, options: SessionsOptions) => {
      await sessionsAction(query, options);
    });

  sessionsCmd
    .command('list')
    .argument('[query]', 'Search query or path (., ../, /path) to filter by project')
    .description('List sessions (non-interactive, for scripts and AI agents)')
    .option('-a, --agent <agent>', SESSION_AGENT_FILTER_HELP)
    .option('--all', 'Show sessions from every directory')
    .option('--project <name>', 'Filter by project name across all directories')
    .option('--since <time>', 'Filter sessions newer than time (e.g., "2h", "7d", "4w", ISO date)')
    .option('--until <time>', 'Filter sessions older than time (ISO timestamp)')
    .option('-n, --limit <n>', 'Max sessions to show', '50')
    .option('--json', 'Output sessions as JSON array')
    .action(async (query: string | undefined, options: ListOptions, command) => {
      const parentOptions = typeof command?.parent?.opts === 'function'
        ? command.parent.opts()
        : {};
      await listAction(query, { ...parentOptions, ...options });
    });

  sessionsCmd
    .command('view <id>')
    .description('Render a session by ID (non-interactive)')
    .option('--transcript', 'Show full conversation transcript')
    .option('--trace', 'Show reasoning trace as markdown')
    .option('--json', 'Output normalized events as JSON')
    .action(async (id: string, options: ViewOptions) => {
      await viewAction(id, options);
    });
}

function formatNoSessionsMessage(
  showAll: boolean | undefined,
  project?: string,
): string {
  const projectQuery = project?.trim();
  if (projectQuery) {
    return `No sessions found for project "${projectQuery}".`;
  }
  if (showAll) return 'No sessions found.';
  const command = 'agents sessions --all';
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

    console.error(chalk.gray('Use one of the transcript IDs above with "agents sessions <id>".'));
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
  // Resolve symlinks (e.g. macOS /var -> /private/var) so we match sessions
  // whose cwd was canonicalized at scan time.
  let projectRoot = historyEntry.project;
  try { projectRoot = fs.realpathSync(projectRoot); } catch { /* dir gone */ }

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

function formatAbsoluteTime(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (isNaN(d.getTime())) return isoTimestamp;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${months[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`;
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
