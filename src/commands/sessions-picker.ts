import {
  createPrompt,
  useState,
  useKeypress,
  useEffect,
  useMemo,
  usePagination,
  usePrefix,
  makeTheme,
  isEnterKey,
  isUpKey,
  isDownKey,
  isSpaceKey,
  Separator,
} from '@inquirer/core';
import chalk from 'chalk';
import type { SessionMeta } from '../lib/session/types.js';
import { parseSession } from '../lib/session/parse.js';
import { cleanSessionPrompt } from '../lib/session/prompt.js';

export interface PickedSession {
  session: SessionMeta;
  action: 'resume' | 'view';
}

interface Choice {
  value: SessionMeta;
  label: string;
}

interface PickerConfig {
  message: string;
  sessions: SessionMeta[];
  filter: (query: string) => SessionMeta[];
  labelFor: (s: SessionMeta) => string;
  pageSize?: number;
}

const previewCache = new Map<string, string>();

function buildPreview(session: SessionMeta): string {
  const cached = previewCache.get(session.id);
  if (cached) return cached;

  let body: string;
  try {
    const events = parseSession(session.filePath, session.agent);
    body = formatCompactPreview(events);
  } catch (err: any) {
    body = chalk.red(`Failed to parse session: ${err.message}`);
  }

  const agentLabel = displayAgent(session.agent) + (session.version ? ` v${session.version}` : '');
  const headerParts = ['preview', agentLabel];
  if (session.account) headerParts.push(session.account);
  headerParts.push(session.id);
  const header = chalk.gray(headerParts.join(' · '));

  const stats = formatStatsRow(session);
  const output = [header, body, stats].filter(Boolean).join('\n');
  previewCache.set(session.id, output);
  return output;
}

function displayAgent(agent: string): string {
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

function formatStatsRow(session: SessionMeta): string {
  const parts: string[] = [];
  if (session.messageCount !== undefined) {
    parts.push(`${session.messageCount} msg${session.messageCount === 1 ? '' : 's'}`);
  }
  if (session.tokenCount !== undefined) {
    parts.push(`${formatTokens(session.tokenCount)} tokens`);
  }
  if (session.gitBranch) parts.push(session.gitBranch);
  if (parts.length === 0) return '';
  return '  ' + chalk.gray(parts.join(' · '));
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const v = n / 1000;
    return (v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, '')) + 'k';
  }
  const v = n / 1_000_000;
  return (v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, '')) + 'm';
}

function formatCompactPreview(events: ReturnType<typeof parseSession>): string {
  let firstUser = '';
  let lastAssistant = '';
  const filesModified = new Set<string>();
  const filesRead = new Set<string>();
  let toolCalls = 0;

  for (const event of events) {
    if (event.type === 'message') {
      if (event.role === 'user' && !firstUser && event.content) {
        if (!/^\s*<local-command-caveat>/i.test(event.content)) {
          firstUser = event.content;
        }
      }
      if (event.role === 'assistant' && event.content) {
        lastAssistant = event.content;
      }
    } else if (event.type === 'tool_use' && !event._local) {
      const tool = event.tool || '';
      const p = event.path || event.args?.file_path || event.args?.path || '';
      if (['Write', 'Edit', 'write_file', 'edit_file', 'create_file', 'replace', 'patch'].includes(tool) && p) {
        filesModified.add(p);
      } else if (['Read', 'read_file', 'view_file', 'cat_file', 'get_file'].includes(tool) && p) {
        filesRead.add(p);
      }
      toolCalls++;
    }
  }

  const lines: string[] = [];

  if (firstUser) {
    const cleaned = cleanSessionPrompt(firstUser);
    const first = (cleaned || firstUser).split('\n').find(l => l.trim()) || '';
    lines.push(chalk.cyan('Prompt: ') + truncate(first.trim(), 120));
  }

  const activity: string[] = [];
  if (filesModified.size) activity.push(`${filesModified.size} modified`);
  if (filesRead.size) activity.push(`${filesRead.size} read`);
  if (toolCalls) activity.push(`${toolCalls} tool${toolCalls === 1 ? '' : 's'}`);
  if (activity.length) {
    lines.push(chalk.cyan('Activity: ') + chalk.gray(activity.join(' · ')));
  }

  if (lastAssistant) {
    const first = lastAssistant.split('\n').find(l => l.trim()) || '';
    lines.push(chalk.cyan('Last: ') + chalk.white(truncate(first.trim(), 120)));
  }

  if (lines.length === 0) {
    lines.push(chalk.gray('No activity recorded in this session.'));
  }

  return lines.map(l => '  ' + l).join('\n');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export const sessionPicker = createPrompt<PickedSession | null, PickerConfig>((config, done) => {
  const theme = makeTheme({});
  const [status, setStatus] = useState<'idle' | 'done'>('idle');
  const [searchTerm, setSearchTerm] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const prefix = usePrefix({ status, theme });

  const results = useMemo(() => {
    const filtered = config.filter(searchTerm).slice(0, 50);
    return filtered.map<Choice>(s => ({ value: s, label: config.labelFor(s) }));
  }, [searchTerm]);

  const [active, setActive] = useState(0);

  useEffect(() => {
    if (active >= results.length) setActive(0);
  }, [results]);

  const selected = results[active];

  useKeypress((key, rl) => {
    if (isEnterKey(key)) {
      if (selected) {
        setStatus('done');
        done({ session: selected.value, action: 'resume' });
      }
      return;
    }

    if (isSpaceKey(key) && searchTerm === '') {
      rl.clearLine(0);
      setPreviewOpen(!previewOpen);
      return;
    }

    if (isUpKey(key)) {
      rl.clearLine(0);
      if (results.length > 0) {
        setActive((active - 1 + results.length) % results.length);
      }
      return;
    }

    if (isDownKey(key)) {
      rl.clearLine(0);
      if (results.length > 0) {
        setActive((active + 1) % results.length);
      }
      return;
    }

    setSearchTerm(rl.line);
    if (previewOpen) setPreviewOpen(false);
  });

  const message = theme.style.message(config.message, status);

  if (status === 'done' && selected) {
    return `${prefix} ${message} ${chalk.cyan(selected.value.shortId)}`;
  }

  const searchStr = searchTerm ? chalk.cyan(searchTerm) : chalk.gray('(type to filter, space for preview)');
  const header = [prefix, message, searchStr].filter(Boolean).join(' ');

  const page = usePagination({
    items: results as any,
    active,
    renderItem({ item, isActive }: { item: Choice; isActive: boolean }) {
      if (Separator.isSeparator(item)) return ` ${(item as any).separator}`;
      const cursor = isActive ? chalk.cyan('>') : ' ';
      const row = isActive ? chalk.bold(item.label) : item.label;
      return `${cursor} ${row}`;
    },
    pageSize: config.pageSize ?? 10,
    loop: false,
  });

  const parts: string[] = [header, page];
  if (results.length === 0) {
    parts.push(chalk.gray('  No sessions match.'));
  }

  if (previewOpen && selected) {
    parts.push(chalk.gray('─'.repeat(Math.min(process.stdout.columns || 80, 80))));
    parts.push(buildPreview(selected.value));
  }

  const help = previewOpen
    ? chalk.gray('↑↓ navigate · space: close preview · ⏎ resume · esc: cancel')
    : chalk.gray('↑↓ navigate · space: preview · ⏎ resume · esc: cancel');
  parts.push(help);

  return [header, parts.slice(1).join('\n')];
});
