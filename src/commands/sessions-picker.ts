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
import type { SessionEvent, SessionMeta } from '../lib/session/types.js';
import { parseSession } from '../lib/session/parse.js';
import { cleanSessionPrompt } from '../lib/session/prompt.js';
import { linkPath, relativeToCwd } from '../lib/session/render.js';
import { renderMarkdown } from '../lib/markdown.js';

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
  labelFor: (s: SessionMeta, query: string) => string;
  pageSize?: number;
  initialSearch?: string;
}

const previewCache = new Map<string, string>();

export function buildPreview(session: SessionMeta): string {
  const cached = previewCache.get(session.id);
  if (cached) return cached;

  let events: SessionEvent[] = [];
  let parseError: string | undefined;
  try {
    events = parseSession(session.filePath, session.agent);
  } catch (err: any) {
    parseError = err.message;
  }

  const header = formatHeader(session, events);
  const body = parseError
    ? '  ' + chalk.red(`Failed to parse session: ${parseError}`)
    : formatCompactPreview(events, session);
  const output = [header, '', body].filter(Boolean).join('\n');
  previewCache.set(session.id, output);
  return output;
}

function displayAgent(agent: string): string {
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

const DOT = chalk.gray(' · ');

function formatHeader(session: SessionMeta, events: SessionEvent[]): string {
  const model = extractModel(events);
  const { startedAgo, duration } = extractTiming(events);
  const totalMessages = session.messageCount ?? countMessages(events);
  const totalTokens = session.tokenCount;

  // Line 1: Agent v version · model · account
  const line1: string[] = [];
  line1.push(chalk.gray(`${displayAgent(session.agent)}${session.version ? ` v${session.version}` : ''}`));
  if (model) line1.push(chalk.bold.white(model));
  if (session.account) line1.push(chalk.gray(session.account));

  // Line 2: cwd · branch · started X ago · lasted Y
  const line2: string[] = [];
  if (session.cwd) {
    const label = relativeToCwd(session.cwd);
    line2.push(chalk.bold.white(linkPath(session.cwd, label)));
  }
  if (session.gitBranch) line2.push(chalk.cyan(session.gitBranch));
  if (startedAgo) line2.push(chalk.gray('started ') + chalk.white(startedAgo + ' ago'));
  if (duration) line2.push(chalk.gray('lasted ') + chalk.white(duration));

  // Line 3: N msgs · T tokens · [label ·] uuid
  const line3: string[] = [];
  if (totalMessages !== undefined) {
    line3.push(chalk.bold.white(String(totalMessages)) + chalk.gray(` msg${totalMessages === 1 ? '' : 's'}`));
  }
  if (totalTokens !== undefined) {
    line3.push(chalk.bold.white(formatTokens(totalTokens)) + chalk.gray(' tokens'));
  }
  if (session.label) line3.push(chalk.white(session.label));
  line3.push(chalk.gray(session.id));

  return [
    line1.join(DOT),
    line2.join(DOT),
    line3.join(DOT),
  ].join('\n');
}

function extractModel(events: SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const m = events[i].model;
    if (events[i].type === 'usage' && m) return m;
  }
  for (const e of events) {
    if (e.type === 'init' && e.model) return e.model;
  }
  return undefined;
}

function extractTiming(events: SessionEvent[]): { startedAgo?: string; duration?: string } {
  if (events.length === 0) return {};
  const firstMs = Date.parse(events[0].timestamp);
  const lastMs = Date.parse(events[events.length - 1].timestamp);
  if (Number.isNaN(firstMs)) return {};
  const ago = humanDuration(Math.max(0, Date.now() - firstMs));
  const dur = Number.isNaN(lastMs) ? undefined : humanDuration(Math.max(0, lastMs - firstMs));
  return { startedAgo: ago, duration: dur };
}

function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm ? `${h}h ${mm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d}d ${hh}h` : `${d}d`;
}

function countMessages(events: SessionEvent[]): number {
  return events.filter(e => e.type === 'message').length;
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

/** Patterns that indicate a user message is system context, not a real prompt. */
const SYSTEM_MESSAGE_PATTERNS = [
  /^\s*<environment_context>/i,
  /^\s*<system-reminder>/i,
  /^\s*<permissions\s/i,
  /^\s*<collaboration_mode>/i,
  /^\s*<local-command-caveat>/i,
  /^\s*# AGENTS\.md instructions for\b/i,
];

/** Strip XML/HTML tags and clean up content for display. */
function stripTags(text: string): string {
  // Remove complete tag pairs with their content for known system tags
  let cleaned = text.replace(/<(system-reminder|environment_context|permissions[^>]*)>[\s\S]*?<\/\1>/gi, '');
  // Remove remaining XML-like tags
  cleaned = cleaned.replace(/<\/?[a-z_-]+[^>]*>/gi, '');
  return cleaned;
}

const LAST_RESPONSE_MAX_LINES = 15;

function formatCompactPreview(events: ReturnType<typeof parseSession>, session: SessionMeta): string {
  let firstUser = '';
  let lastAssistant = '';
  const filesModified = new Set<string>();
  const filesRead = new Set<string>();
  let toolCalls = 0;
  let planFile = '';

  for (const event of events) {
    if (event.type === 'message') {
      if (event.role === 'user' && !firstUser && event.content) {
        if (!SYSTEM_MESSAGE_PATTERNS.some(p => p.test(event.content!))) {
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
      if (!planFile && p && /\/plans\/[^/]+\.md$/.test(p)) {
        planFile = p;
      }
      toolCalls++;
    }
  }

  const lines: string[] = [];
  const termWidth = process.stdout.columns || 80;

  if (firstUser) {
    const cleaned = cleanSessionPrompt(firstUser);
    const first = (cleaned || firstUser).split('\n').find(l => l.trim()) || '';
    lines.push(chalk.cyan('Prompt: ') + chalk.white(truncate(first.trim(), termWidth - 12)));
  }

  const activity: string[] = [];
  if (filesModified.size) activity.push(`${filesModified.size} modified`);
  if (filesRead.size) activity.push(`${filesRead.size} read`);
  if (toolCalls) activity.push(`${toolCalls} tool${toolCalls === 1 ? '' : 's'}`);
  if (activity.length) {
    lines.push(chalk.cyan('Activity: ') + chalk.gray(activity.join(' · ')));
  }

  if (planFile) {
    const basename = planFile.split('/').pop() || planFile;
    lines.push(chalk.cyan('Plan: ') + chalk.white(linkPath(planFile, basename)));
  }

  if (lastAssistant) {
    const rendered = renderLastResponse(lastAssistant);
    if (rendered.length > 0) {
      lines.push('');
      lines.push(chalk.cyan('Last response:'));
      for (const l of rendered) lines.push('  ' + l);
    }
  }

  if (lines.length === 0) {
    lines.push(chalk.gray('No activity recorded in this session.'));
  }

  return lines.map(l => '  ' + l).join('\n');
}

function renderLastResponse(content: string): string[] {
  const cleaned = stripTags(content).trim();
  if (!cleaned) return [];

  let rendered: string;
  try {
    rendered = renderMarkdown(cleaned);
  } catch {
    rendered = cleaned;
  }

  const all = rendered.replace(/\s+$/, '').split('\n');
  // Drop leading/trailing empty lines
  while (all.length && !all[0].trim()) all.shift();
  while (all.length && !all[all.length - 1].trim()) all.pop();

  if (all.length <= LAST_RESPONSE_MAX_LINES) return all;
  const shown = all.slice(0, LAST_RESPONSE_MAX_LINES);
  const more = all.length - LAST_RESPONSE_MAX_LINES;
  shown.push(chalk.gray(`… (${more} more line${more === 1 ? '' : 's'})`));
  return shown;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export const sessionPicker = createPrompt<PickedSession | null, PickerConfig>((config, done) => {
  const theme = makeTheme({});
  const [status, setStatus] = useState<'idle' | 'done'>('idle');
  const [searchTerm, setSearchTerm] = useState(config.initialSearch ?? '');
  const [previewOpen, setPreviewOpen] = useState(true);
  const prefix = usePrefix({ status, theme });

  const results = useMemo(() => {
    const filtered = config.filter(searchTerm).slice(0, 50);
    return filtered.map<Choice>(s => ({ value: s, label: config.labelFor(s, searchTerm) }));
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

  const searchStr = searchTerm ? chalk.cyan(searchTerm) : chalk.gray('(type to filter, space to hide preview)');
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
