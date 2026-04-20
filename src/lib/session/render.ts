import chalk from 'chalk';
import type { SessionEvent } from './types.js';
import { summarizeToolUse } from './parse.js';
import { cleanSessionPrompt, extractSessionTopic } from './prompt.js';

// ── Path helpers ──────────────────────────────────────────────────────────────

/**
 * Return absPath relative to cwd; fall back to ~/… then absolute.
 */
export function relativeToCwd(absPath: string, cwd?: string): string {
  if (cwd && (absPath === cwd || absPath.startsWith(cwd + '/'))) {
    const rel = absPath.slice(cwd.length + 1);
    return rel || '.';
  }
  const home = process.env.HOME || '';
  if (home && (absPath === home || absPath.startsWith(home + '/'))) {
    return '~' + absPath.slice(home.length);
  }
  return absPath;
}

/**
 * Wrap label in an OSC 8 hyperlink when the terminal supports it.
 * Degrades to plain label otherwise.
 */
export function linkPath(absPath: string, label: string): string {
  if (
    process.stdout.isTTY &&
    (process.env.TERM_PROGRAM ||
      process.env.WT_SESSION ||
      process.env.KITTY_WINDOW_ID ||
      process.env.WEZTERM_PANE)
  ) {
    return `\x1b]8;;file://${absPath}\x1b\\${label}\x1b]8;;\x1b\\`;
  }
  return label;
}

// ── Command grouping ──────────────────────────────────────────────────────────

/**
 * Unwrap wrapper prefixes to find the actual executable.
 */
export function unwrapCommand(cmd: string): string {
  const ssh = cmd.match(/^ssh\s+\S+\s+"(.+)"\s*(?:\|.*)?$/);
  if (ssh) return unwrapCommand(ssh[1]);
  const lead = cmd.match(/^(?:sudo|env\s+\S+=\S+|time)\s+(.+)/);
  if (lead) return unwrapCommand(lead[1]);
  // Strip shell-style leading env assignments: `PATH=/x CMD ...`, `FOO=bar BAR=baz CMD ...`
  const shellEnv = cmd.match(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+(\S.*)$/);
  if (shellEnv) return unwrapCommand(shellEnv[1]);
  const cd = cmd.match(/^cd\s+\S+\s*&&\s*(.+)/);
  if (cd) return unwrapCommand(cd[1]);
  const npx = cmd.match(/^npx\s+(.+)/);
  if (npx) return unwrapCommand(npx[1]);
  return cmd;
}

/**
 * Normalize a command so trivial flag/pipe variations collapse to the same key.
 */
export function normalizeForDedup(cmd: string): string {
  let s = cmd.trim();
  s = s.replace(/\s+-[a-zA-Z]+/g, '');
  s = s.replace(/\s+--[a-zA-Z][-a-zA-Z0-9]*(?:=\S+)?/g, '');
  s = s.replace(/\s*\|\s*(head|tail|wc|less|more|cat)(\s+\S+)?.*$/, '');
  s = s.replace(/\s*2>&1\s*$/, '');
  s = s.replace(/\s*;\s*echo\b.*$/, '');
  const home = process.env.HOME ?? '';
  if (home) {
    s = s.replace(new RegExp('^' + home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '~');
  }
  return s.trim();
}

const CATEGORIES: Array<{
  name: string;
  match: (first: string) => boolean;
  signal: 'high' | 'mid' | 'low';
}> = [
  { name: 'Probes',     match: t => ['ls','cat','head','tail','wc','stat','file','which','tree','pwd'].includes(t),                          signal: 'low'  },
  { name: 'Search',     match: t => ['grep','rg','ag','fd','find'].includes(t),                                                               signal: 'low'  },
  { name: 'Build/test', match: t => ['make','cargo','pytest','go','bun','npm','pnpm','yarn','tsc','vitest','tsx','node','python','python3','jest'].includes(t), signal: 'high' },
  { name: 'Install',    match: t => ['brew','pip','apt','apk'].includes(t),                                                                    signal: 'high' },
  { name: 'VCS',        match: t => ['git','gh'].includes(t),                                                                                  signal: 'mid'  },
  { name: 'HTTP',       match: t => ['curl','wget','rush','http'].includes(t),                                                                 signal: 'mid'  },
  { name: 'Remote',     match: t => ['ssh','scp','rsync'].includes(t),                                                                         signal: 'mid'  },
  { name: 'Shell',      match: t => ['rm','mv','cp','mkdir','touch','echo','printf','chmod','ln','awk','sed','tee','xargs','for'].includes(t), signal: 'low'  },
  { name: 'Wait',       match: t => ['sleep','wait'].includes(t),                                                                              signal: 'low'  },
];

const TWO_LEVEL_TOKENS = new Set([
  'git','gh','bun','npm','cargo','docker','kubectl','rush','openclaw','pnpm','yarn',
]);

/**
 * Return the bucket key for a command (used for grouping within a category).
 */
export function bucketKey(cmd: string): string {
  const unwrapped = unwrapCommand(cmd);
  const tokens = unwrapped.trim().split(/\s+/);
  const first = tokens[0] ?? 'other';
  const isRemote = cmd.trim().startsWith('ssh ') || cmd.trim().startsWith('scp ');
  if (TWO_LEVEL_TOKENS.has(first) && tokens[1]) {
    const key = `${first} ${tokens[1]}`;
    return isRemote ? `ssh\u2192${key}` : key;
  }
  return isRemote ? `ssh\u2192${first}` : first;
}

function categoryOf(cmd: string): { name: string; signal: 'high' | 'mid' | 'low' } | null {
  const rawFirst = cmd.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  // Remote wrappers: classify as Remote regardless of inner command.
  if (['ssh', 'scp', 'rsync'].includes(rawFirst)) {
    return CATEGORIES.find(c => c.name === 'Remote') ?? null;
  }
  const unwrapped = unwrapCommand(cmd);
  const first = unwrapped.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return CATEGORIES.find(c => c.match(first)) ?? null;
}

interface CmdRun {
  normalized: string;
  raw: string;
  firstTs: number;
  lastTs: number;
  count: number;
}

/**
 * Collapse consecutive same-normalized commands within a 60-second window
 * when they appear 3+ times. Fewer than 3 stay as separate entries.
 */
export function collapseRetries(commands: Array<{ cmd: string; ts: number }>): CmdRun[] {
  const groups: CmdRun[] = [];
  for (const { cmd, ts } of commands) {
    const normalized = normalizeForDedup(unwrapCommand(cmd));
    const last = groups[groups.length - 1];
    if (last && last.normalized === normalized && ts - last.lastTs <= 60_000) {
      last.count++;
      last.lastTs = ts;
    } else {
      groups.push({ normalized, raw: cmd, firstTs: ts, lastTs: ts, count: 1 });
    }
  }
  // Expand groups with count < 3 back to individual entries
  const result: CmdRun[] = [];
  for (const g of groups) {
    if (g.count >= 3) {
      result.push(g);
    } else {
      for (let i = 0; i < g.count; i++) {
        result.push({ normalized: g.normalized, raw: g.raw, firstTs: g.firstTs, lastTs: g.lastTs, count: 1 });
      }
    }
  }
  return result;
}

// ── Stats rollup ──────────────────────────────────────────────────────────────

export interface SessionStats {
  models: string[];
  userTurns: number;
  assistantTurns: number;
  toolCount: number;
  errorCount: number;
  outputTokens: number;
  cacheReadTokens: number;
  firstTs: number;
  lastTs: number;
}

export function computeSummaryStats(events: SessionEvent[]): SessionStats {
  const modelSet = new Set<string>();
  let userTurns = 0;
  let assistantTurns = 0;
  let toolCount = 0;
  let errorCount = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let firstTs = Infinity;
  let lastTs = -Infinity;

  for (const e of events) {
    const ts = new Date(e.timestamp).getTime();
    if (!isNaN(ts)) {
      if (ts < firstTs) firstTs = ts;
      if (ts > lastTs) lastTs = ts;
    }
    if (e.type === 'message') {
      if (e.role === 'user') userTurns++;
      else if (e.role === 'assistant') assistantTurns++;
    } else if (e.type === 'tool_use' && !e._local) {
      toolCount++;
    } else if (e.type === 'error') {
      errorCount++;
    } else if (e.type === 'usage') {
      if (e.model) modelSet.add(shortenModel(e.model));
      outputTokens += e.outputTokens ?? 0;
      cacheReadTokens += e.cacheReadTokens ?? 0;
    }
  }

  return {
    models: Array.from(modelSet),
    userTurns,
    assistantTurns,
    toolCount,
    errorCount,
    outputTokens,
    cacheReadTokens,
    firstTs: firstTs === Infinity ? 0 : firstTs,
    lastTs: lastTs === -Infinity ? 0 : lastTs,
  };
}

/**
 * Format a unix-ms timestamp as "HH:MM am/pm" in local time.
 */
export function formatClockTime(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes();
  const suffix = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${String(h).padStart(2, ' ')}:${String(m).padStart(2, '0')} ${suffix}`;
}

function shortenModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function formatTokenCount(n: number): string {
  if (n === 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return (k >= 100 ? Math.round(k) : parseFloat(k.toFixed(1))) + 'K';
  }
  const m = n / 1_000_000;
  return (m >= 100 ? Math.round(m) : parseFloat(m.toFixed(1))) + 'M';
}

function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 1) return 'under 1 min';
  if (totalMin < 60) return `${totalMin} min`;
  const hrs = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins > 0 ? `${hrs}h ${mins}min` : `${hrs}h`;
}

/**
 * Return the stats line for a session summary header.
 * e.g. "221 turns · 198 tools (10 errors) · 67.5M cached / 361K out · 12 min"
 */
export function renderSummaryHeader(stats: SessionStats): string {
  const turns = stats.userTurns + stats.assistantTurns;
  const parts: string[] = [];

  parts.push(`${turns} turn${turns !== 1 ? 's' : ''}`);

  if (stats.toolCount > 0) {
    const toolPart = stats.errorCount > 0
      ? `${stats.toolCount} tools (${stats.errorCount} error${stats.errorCount !== 1 ? 's' : ''})`
      : `${stats.toolCount} tools`;
    parts.push(toolPart);
  }

  if (stats.cacheReadTokens > 0 || stats.outputTokens > 0) {
    const tokenPart = stats.cacheReadTokens > 0
      ? `${formatTokenCount(stats.cacheReadTokens)} cached / ${formatTokenCount(stats.outputTokens)} out`
      : `${formatTokenCount(stats.outputTokens)} out`;
    parts.push(tokenPart);
  }

  if (stats.lastTs > stats.firstTs) {
    parts.push(formatDuration(stats.lastTs - stats.firstTs));
  }

  return parts.join(' · ');
}

// ── Prompt reference extraction ───────────────────────────────────────────────

function extractReferences(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(/@[\w/.-]+/g)) refs.add(m[0]);
  for (const m of text.matchAll(/(?:^|\s)(\/[\w/.-]{3,})/gm)) refs.add(m[1]);
  for (const m of text.matchAll(/~\/[\w/.-]+/g)) refs.add(m[0]);
  return Array.from(refs);
}

// ── Tool summary (short form for reasoning section) ───────────────────────────

function toolSummaryShort(event: SessionEvent, cwd?: string): string {
  const tool = event.tool || '';
  const args = event.args || {};
  const p = event.path || args.file_path || args.path || '';

  switch (tool) {
    case 'Read':
    case 'Write':
    case 'Edit': {
      const label = p ? relativeToCwd(p, cwd) : '';
      return label ? `${tool} ${label}` : tool;
    }
    case 'Bash': {
      const cmd = String(args.command || '').replace(/\n/g, ' ').trim();
      return cmd ? `Bash ${cmd.slice(0, 50)}${cmd.length > 50 ? '…' : ''}` : 'Bash';
    }
    case 'Grep':
      return `Grep "${(String(args.pattern || '')).slice(0, 30)}"`;
    case 'Glob':
      return `Glob ${args.pattern || ''}`;
    case 'Agent':
    case 'Task':
      return `${tool}: ${String(args.description || args.prompt || '').slice(0, 50)}`;
    case 'TodoWrite':
      return 'TodoWrite';
    case 'ExitPlanMode':
      return 'ExitPlanMode';
    default: {
      for (const k of ['file_path', 'path', 'pattern', 'command', 'description']) {
        if (args[k]) return `${tool}: ${String(args[k]).slice(0, 50)}`;
      }
      return tool;
    }
  }
}

// ── Command section renderer ──────────────────────────────────────────────────

interface BucketEntry {
  catName: string;
  catSignal: 'high' | 'mid' | 'low';
  key: string;
  count: number;
  samples: string[];
}

function renderCommandsSection(
  cmds: Array<{ cmd: string; ts: number }>,
  lines: string[],
): void {
  if (cmds.length === 0) return;

  const runs = collapseRetries(cmds);

  // Group runs by category → key → {count, samples}
  const catMap = new Map<string, { signal: 'high' | 'mid' | 'low'; keys: Map<string, { count: number; samples: string[] }> }>();
  let otherCount = 0;
  const otherKeys = new Map<string, { count: number; samples: string[] }>();

  for (const run of runs) {
    const cat = categoryOf(run.raw);
    const key = bucketKey(run.raw);

    if (cat) {
      let catEntry = catMap.get(cat.name);
      if (!catEntry) {
        catEntry = { signal: cat.signal, keys: new Map() };
        catMap.set(cat.name, catEntry);
      }
      const existing = catEntry.keys.get(key) ?? { count: 0, samples: [] };
      existing.count += run.count;
      if (existing.samples.length < 5 && !existing.samples.some(s => sharesPrefix(s, run.raw, 30))) {
        existing.samples.push(run.raw);
      }
      catEntry.keys.set(key, existing);
    } else {
      otherCount += run.count;
      const existing = otherKeys.get(key) ?? { count: 0, samples: [] };
      existing.count += run.count;
      if (existing.samples.length < 3) existing.samples.push(run.raw);
      otherKeys.set(key, existing);
    }
  }

  // Total command count (sum of all run counts)
  const total = runs.reduce((sum, r) => sum + r.count, 0);
  lines.push(chalk.bold('Commands') + chalk.gray(` (${total})`));

  // Sort categories: high-signal first, then mid, then low, by total count desc. Other last.
  const SIGNAL_ORDER: Record<string, number> = { high: 0, mid: 1, low: 2 };
  const sortedCats = Array.from(catMap.entries()).sort((a, b) => {
    const sigA = SIGNAL_ORDER[a[1].signal] ?? 3;
    const sigB = SIGNAL_ORDER[b[1].signal] ?? 3;
    if (sigA !== sigB) return sigA - sigB;
    const countA = Array.from(a[1].keys.values()).reduce((s, v) => s + v.count, 0);
    const countB = Array.from(b[1].keys.values()).reduce((s, v) => s + v.count, 0);
    return countB - countA;
  });

  for (const [catName, catEntry] of sortedCats) {
    const catTotal = Array.from(catEntry.keys.values()).reduce((s, v) => s + v.count, 0);

    if (catEntry.signal === 'low') {
      // Single inline line: category name + top 5 first tokens
      const topTokens = Array.from(catEntry.keys.keys()).slice(0, 5).join(', ');
      lines.push(`  ${chalk.dim(catName)} ${chalk.gray(`(${catTotal})`)} ${chalk.gray('— ' + topTokens)}`);
    } else {
      lines.push(`  ${chalk.dim(catName)} ${chalk.gray(`(${catTotal})`)}`);
      const keysSorted = Array.from(catEntry.keys.entries()).sort((a, b) => b[1].count - a[1].count);
      const limit = catEntry.signal === 'high' ? Infinity : 3;
      let shown = 0;
      for (const [key, v] of keysSorted) {
        if (shown >= limit) break;
        if (catEntry.signal === 'mid') {
          // Mid signal: display the bucket key (e.g. ssh→openclaw browser) with aggregate count
          const countSuffix = v.count > 1 ? chalk.gray(` × ${v.count}`) : '';
          lines.push(`    ${chalk.cyan(truncateCmd(key, 80))}${countSuffix}`);
        } else {
          // High signal: display distinct raw sample commands
          const distinctSamples = pickDistinct(v.samples, 3);
          for (const sample of distinctSamples) {
            const countSuffix = v.count > 1 ? chalk.gray(` × ${v.count}`) : '';
            lines.push(`    ${chalk.cyan(truncateCmd(sample, 80))}${countSuffix}`);
          }
        }
        shown++;
      }
    }
  }

  if (otherCount > 0) {
    lines.push(`  ${chalk.dim('Other')} ${chalk.gray(`(${otherCount})`)}`);
    for (const [, v] of Array.from(otherKeys.entries()).slice(0, 5)) {
      const countSuffix = v.count > 1 ? chalk.gray(` × ${v.count}`) : '';
      lines.push(`    ${chalk.cyan(truncateCmd(v.samples[0] ?? '', 80))}${countSuffix}`);
    }
  }

  lines.push('');
}

function sharesPrefix(a: string, b: string, len: number): boolean {
  return a.slice(0, len) === b.slice(0, len);
}

function pickDistinct(samples: string[], max: number): string[] {
  const result: string[] = [];
  for (const s of samples) {
    if (result.length >= max) break;
    if (!result.some(r => sharesPrefix(r, s, 30))) result.push(s);
  }
  return result.length > 0 ? result : samples.slice(0, max);
}

function truncateCmd(cmd: string, max: number): string {
  return cmd.length <= max ? cmd : cmd.slice(0, max - 1) + '…';
}

// ── File grouping ─────────────────────────────────────────────────────────────

function groupByParentDir(paths: Iterable<string>, cwd?: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const rel = relativeToCwd(p, cwd);
    const slashIdx = rel.lastIndexOf('/');
    const dir = slashIdx >= 0 ? rel.slice(0, slashIdx) : '.';
    const base = slashIdx >= 0 ? rel.slice(slashIdx + 1) : rel;
    const arr = groups.get(dir) ?? [];
    arr.push(base);
    groups.set(dir, arr);
  }
  return new Map(Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length));
}

function renderFileGroup(lines: string[], groups: Map<string, string[]>, absPathMap: Map<string, string>): void {
  if (groups.size === 1) {
    const [dir, files] = Array.from(groups.entries())[0];
    for (const f of files) {
      const abs = absPathMap.get(dir === '.' ? f : `${dir}/${f}`) ?? '';
      const label = dir === '.' ? f : `${dir}/${f}`;
      lines.push('  ' + chalk.cyan(abs ? linkPath(abs, label) : label));
    }
  } else {
    for (const [dir, files] of groups) {
      lines.push(`  ${chalk.dim(dir + '/')}`);
      for (const f of files) {
        const abs = absPathMap.get(dir === '.' ? f : `${dir}/${f}`) ?? '';
        const label = f;
        lines.push('    ' + chalk.cyan(abs ? linkPath(abs, label) : label));
      }
    }
  }
}

// ── Main summary renderer ─────────────────────────────────────────────────────

/**
 * Render session as an activity summary.
 * Returns a chalk-formatted string (not markdown) for direct terminal output.
 */
export function renderSummary(events: SessionEvent[], cwd?: string): string {
  // ── Collect data in a single chronological pass ───────────────────────────

  let firstUserMessage = '';
  const attachments: Array<{ mediaType: string }> = [];
  let lastAssistantMessage = '';

  // File paths (absolute) for grouping — split by whether they're inside cwd
  const filesModifiedAbs = new Set<string>();
  const filesReadAbs = new Set<string>();
  const filesModifiedExternal = new Set<string>();

  // Commands with timestamps
  const cmdList: Array<{ cmd: string; ts: number }> = [];

  // Timeline: one entry per assistant text message, with tools/errors that followed
  interface TimelineTool { summary: string; error?: string }
  interface TimelineEntry { ts: number; text: string; tools: TimelineTool[] }
  const timeline: TimelineEntry[] = [];
  let currentEntry: TimelineEntry | null = null;

  // Plan items
  const todoItems: string[] = [];
  let exitPlanContent: string | null = null;

  // Subagent spawns
  const subagents: Array<{ description: string; subagentType: string }> = [];

  // Errors
  const errors: Array<{ tool: string; cmd?: string; content?: string }> = [];

  const isInsideCwd = (p: string): boolean => !!(cwd && p.startsWith(cwd + '/'));

  for (const event of events) {
    const ts = new Date(event.timestamp).getTime() || 0;

    if (event.type === 'tool_use') {
      if (event._local) continue;

      const tool = event.tool || '';
      const args = event.args || {};
      const p = event.path || args.file_path || args.path || '';

      if (['Read', 'read_file', 'view_file', 'cat_file', 'get_file'].includes(tool)) {
        if (p) filesReadAbs.add(p);
      } else if (['Write', 'Edit', 'write_file', 'edit_file', 'create_file', 'replace', 'patch'].includes(tool)) {
        if (p) (isInsideCwd(p) || !cwd ? filesModifiedAbs : filesModifiedExternal).add(p);
      }

      if (event.command) {
        const cmd = event.command.replace(/\n/g, ' ').trim();
        if (cmd) cmdList.push({ cmd, ts });
      }

      // Plan items: TodoWrite items + TaskCreate descriptions (project's task tracker)
      if (tool === 'TodoWrite' && Array.isArray(args.todos)) {
        for (const item of args.todos) {
          const text = item.content || item.text || String(item);
          if (text && !todoItems.includes(text)) todoItems.push(text);
        }
      }
      if (tool === 'TaskCreate' && (args.description || args.prompt)) {
        const text = String(args.description || args.prompt || '').slice(0, 140);
        if (text && !todoItems.includes(text)) todoItems.push(text);
      }
      if (tool === 'ExitPlanMode') {
        exitPlanContent = args.result || args.plan || args.content || null;
      }

      // Subagent spawns
      if ((tool === 'Agent' || tool === 'Task') && (args.description || args.prompt)) {
        subagents.push({
          description: String(args.description || args.prompt || '').slice(0, 120),
          subagentType: String(args.subagent_type || ''),
        });
      }

      // Attach to current timeline entry
      if (currentEntry) {
        currentEntry.tools.push({ summary: toolSummaryShort(event, cwd) });
      }

    } else if (event.type === 'error') {
      errors.push({
        tool: event.tool || 'unknown',
        cmd: event.args?.command ? String(event.args.command).slice(0, 80) : undefined,
        content: event.content?.slice(0, 120),
      });
      // Attach to the last tool in the current entry (it's the one that failed)
      if (currentEntry && currentEntry.tools.length > 0) {
        const lastTool = currentEntry.tools[currentEntry.tools.length - 1];
        lastTool.error = (event.content ?? event.tool ?? 'error').slice(0, 100);
      }

    } else if (event.type === 'message') {
      if (event.role === 'user') {
        currentEntry = null;
        if (!firstUserMessage) {
          const content = event.content || '';
          if (!/^\s*<local-command-caveat>/i.test(content)) {
            const topic = extractSessionTopic(content);
            if (topic) firstUserMessage = content;
          }
        }
      } else if (event.role === 'assistant' && event.content) {
        lastAssistantMessage = event.content;
        const firstSentence = event.content.split(/(?<=[.!?])\s+|\n/)[0]?.trim() || event.content.slice(0, 100);
        currentEntry = { ts, text: firstSentence, tools: [] };
        timeline.push(currentEntry);
      }

    } else if (event.type === 'attachment') {
      attachments.push({ mediaType: event.mediaType || 'image/png' });
    }
  }

  // Dedupe: files in Modified should not appear in Read
  for (const p of filesModifiedAbs) filesReadAbs.delete(p);
  for (const p of filesModifiedExternal) filesReadAbs.delete(p);

  // Build abs→rel mapping for linkPath
  const buildAbsMap = (absSet: Set<string>): Map<string, string> => {
    const m = new Map<string, string>();
    for (const abs of absSet) {
      const rel = relativeToCwd(abs, cwd);
      m.set(rel, abs);
    }
    return m;
  };

  const modifiedAbsMap = buildAbsMap(filesModifiedAbs);
  const readAbsMap = buildAbsMap(filesReadAbs);

  // ── Render sections ───────────────────────────────────────────────────────

  const lines: string[] = [''];

  // 1. Prompt
  if (firstUserMessage) {
    const cleaned = cleanSessionPrompt(firstUserMessage);
    if (cleaned) {
      lines.push(chalk.bold('Prompt:') + ' ' + cleaned.split('\n')[0]);
      const secondLine = cleaned.split('\n')[1]?.trim();
      if (secondLine) lines.push('  ' + secondLine);

      const refs = extractReferences(cleaned);
      if (refs.length > 0) {
        lines.push(chalk.gray('  Referenced: ' + refs.join(', ')));
      }
    }
  }

  // Attachments (images/documents in the first user turn)
  if (attachments.length > 0) {
    const mediaTypes = [...new Set(attachments.map(a => a.mediaType))].join(', ');
    lines.push(chalk.gray(`  + ${attachments.length} screenshot${attachments.length !== 1 ? 's' : ''} (${mediaTypes})`));
  }

  if (firstUserMessage || attachments.length > 0) lines.push('');

  // 2. Plan
  if (todoItems.length > 0 || exitPlanContent) {
    lines.push(chalk.bold('Plan'));
    if (exitPlanContent) {
      const planLines = exitPlanContent.split('\n').slice(0, 10);
      for (const l of planLines) lines.push('  ' + l);
    } else {
      for (const item of todoItems.slice(0, 20)) {
        lines.push('  · ' + item);
      }
    }
    lines.push('');
  }

  // 3. Subagents
  if (subagents.length > 0) {
    lines.push(chalk.bold('Subagents') + chalk.gray(` (${subagents.length})`));
    for (const s of subagents) {
      const typeSuffix = s.subagentType ? chalk.gray(` (${s.subagentType})`) : '';
      lines.push('  Task: ' + s.description + typeSuffix);
    }
    lines.push('');
  }

  // 4. Timeline — assistant messages as narration, tools clustered under each
  const meaningful = timeline.filter(e => e.text.length > 0 || e.tools.length > 0);
  if (meaningful.length > 0) {
    lines.push(chalk.bold('Timeline'));
    for (const entry of meaningful) {
      const when = entry.ts ? formatClockTime(entry.ts) : '        ';
      lines.push('  ' + chalk.gray.italic(when) + '  ' + entry.text.slice(0, 140));
      const MAX_TOOLS_PER_ENTRY = 8;
      for (const t of entry.tools.slice(0, MAX_TOOLS_PER_ENTRY)) {
        const marker = t.error ? chalk.red('⚠') : ' ';
        const suffix = t.error ? chalk.gray(' — ' + t.error) : '';
        lines.push('            ' + marker + ' ' + t.summary + suffix);
      }
      if (entry.tools.length > MAX_TOOLS_PER_ENTRY) {
        lines.push(chalk.gray('              + ' + (entry.tools.length - MAX_TOOLS_PER_ENTRY) + ' more'));
      }
    }
    lines.push('');
  }

  // 5. Modified files
  if (filesModifiedAbs.size > 0) {
    lines.push(chalk.bold('Modified') + chalk.gray(` (${filesModifiedAbs.size})`));
    const groups = groupByParentDir(filesModifiedAbs, cwd);
    renderFileGroup(lines, groups, modifiedAbsMap);
    lines.push('');
  }

  // 5b. External edits (files edited outside the project root — typically /tmp)
  if (filesModifiedExternal.size > 0) {
    const externalList = [...filesModifiedExternal].sort();
    const home = process.env.HOME ?? '';
    const display = externalList.slice(0, 3).map(p => home && p.startsWith(home) ? p.replace(home, '~') : p);
    const more = externalList.length > 3 ? chalk.gray(` +${externalList.length - 3} more`) : '';
    lines.push(chalk.gray(`External edits (${filesModifiedExternal.size}): ${display.join(', ')}${more}`));
    lines.push('');
  }

  // 6. Read files
  if (filesReadAbs.size > 0) {
    if (filesReadAbs.size <= 5) {
      lines.push(chalk.bold('Read') + chalk.gray(` (${filesReadAbs.size})`));
      const groups = groupByParentDir(filesReadAbs, cwd);
      renderFileGroup(lines, groups, readAbsMap);
    } else {
      lines.push(chalk.bold('Read') + chalk.gray(` ${filesReadAbs.size} other files`));
    }
    lines.push('');
  }

  // 7. Commands
  renderCommandsSection(cmdList, lines);

  // 8. Errors
  if (errors.length > 0) {
    const first = errors[0];
    const firstDesc = first.cmd
      ? `${first.tool} "${first.cmd.slice(0, 60)}"`
      : first.content
        ? `${first.tool}: ${first.content.slice(0, 60)}`
        : first.tool;
    lines.push(
      chalk.red(chalk.bold('Errors')) +
      chalk.gray(`: ${errors.length} failure${errors.length !== 1 ? 's' : ''} — first: ${firstDesc}`)
    );
    lines.push('');
  }

  // 9. Final message
  if (lastAssistantMessage) {
    const hasActivity = filesModifiedAbs.size > 0 || filesReadAbs.size > 0 || cmdList.length > 0;
    if (hasActivity || errors.length > 0) lines.push(chalk.gray('─'.repeat(60)));
    lines.push('');
    const truncated = lastAssistantMessage.length > 3000
      ? lastAssistantMessage.slice(0, 2997) + '...'
      : lastAssistantMessage;
    lines.push(truncated);
    lines.push('');
  } else if (
    filesModifiedAbs.size === 0 &&
    filesReadAbs.size === 0 &&
    cmdList.length === 0 &&
    timeline.length === 0
  ) {
    lines.push(chalk.gray('No activity recorded in this session.'));
    lines.push('');
  }

  return lines.join('\n');
}

// ── Other view modes (unchanged) ──────────────────────────────────────────────

/**
 * Render session as a conversation transcript.
 */
export function renderTranscript(events: SessionEvent[]): string {
  const lines: string[] = [];
  let lastRole: string | null = null;

  for (const event of events) {
    if (event.type === 'message') {
      if (lastRole && lastRole !== event.role) {
        lines.push('');
      }
      if (event.role === 'user') {
        lines.push(`> ${event.content}`);
        lines.push('');
      } else {
        lines.push(event.content || '');
      }
      lastRole = event.role || null;
    } else if (event.type === 'tool_use') {
      const summary = summarizeToolUse(event.tool || 'unknown', event.args);
      lines.push(`  [${summary}]`);
      lastRole = 'tool';
    } else if (event.type === 'error') {
      lines.push(`  [ERROR: ${event.content || event.tool || 'unknown'}]`);
      lastRole = 'error';
    }
  }

  return lines.join('\n');
}

/**
 * Render session as a markdown trace.
 */
export function renderTrace(events: SessionEvent[]): string {
  const reasoning: string[] = [];
  const conversation: string[] = [];

  for (const event of events) {
    if (event.type === 'thinking' && event.content) {
      reasoning.push(event.content);
    }
    if (event.type === 'message') {
      if (event.role === 'user') {
        conversation.push(`## User\n\n${event.content}`);
      } else if (event.role === 'assistant' && event.content) {
        conversation.push(`## Agent\n\n${event.content}`);
      }
    } else if (event.type === 'tool_use') {
      const tool = event.tool || 'unknown';
      if (event.command) {
        conversation.push(`## Tool: ${tool}\n\n\`\`\`bash\n${event.command}\n\`\`\``);
      } else if (event.path) {
        conversation.push(`## Tool: ${tool}\n\n\`${shortenPathTrace(event.path)}\``);
      } else {
        const summary = summarizeToolUse(tool, event.args);
        conversation.push(`## Tool: ${tool}\n\n${summary}`);
      }
    } else if (event.type === 'error') {
      conversation.push(`## Error\n\n${event.content || 'Unknown error'}`);
    }
  }

  const parts: string[] = [];
  if (reasoning.length > 0) {
    parts.push('# Agent Reasoning\n');
    parts.push(reasoning.join('\n\n---\n\n'));
  }
  parts.push('\n\n# Full Conversation\n');
  parts.push(conversation.join('\n\n'));
  return parts.join('\n');
}

/**
 * Render session as JSON (normalized events).
 */
export function renderJson(events: SessionEvent[]): string {
  return JSON.stringify(events, null, 2);
}

function shortenPathTrace(p: string): string {
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}
