import chalk from 'chalk';
import type { AgentId } from '../lib/types.js';
import { agentLabel } from '../lib/agents.js';
import { itemPicker } from '../lib/picker.js';
import { isInteractiveTerminal, isPromptCancelled, printWithPager } from './utils.js';

export type SyncStatus = 'synced' | 'stale' | 'missing';

export interface SyncTarget {
  agent: AgentId;
  version: string;
  isDefault?: boolean;
  status: SyncStatus;
}

export interface ResourceRow {
  name: string;
  description?: string;
  extra?: string; // small per-type metric (e.g., "3 rules", "http")
  targets: SyncTarget[];
  buildDetail: () => string;
}

export interface ResourceViewOptions {
  resourcePlural: string;
  resourceSingular: string;
  extraLabel?: string;
  rows: ResourceRow[];
  emptyMessage: string;
  centralPath?: string;
  /** When the user specified agent or agent@version, we scope per-agent. */
  filterAgent?: AgentId;
  filterVersion?: string;
}

/** Entry point: picker in TTY, table otherwise. */
export async function showResourceList(opts: ResourceViewOptions): Promise<void> {
  if (opts.rows.length === 0) {
    console.log(chalk.gray(opts.emptyMessage));
    return;
  }

  if (!isInteractiveTerminal()) {
    printResourceTable(opts);
    return;
  }

  let picked;
  try {
    picked = await itemPicker<ResourceRow>({
      message: buildPickerMessage(opts),
      items: opts.rows,
      filter: (query) => filterRows(opts.rows, query),
      labelFor: (row) => formatPickerRow(row, opts),
      buildPreview: (row) => row.buildDetail(),
      pageSize: 12,
      emptyMessage: `No matching ${opts.resourcePlural}.`,
      enterHint: 'view',
    });
  } catch (err) {
    if (isPromptCancelled(err)) return;
    throw err;
  }

  if (!picked) return;

  // Dump the full detail in a pager for inspection.
  const detail = picked.item.buildDetail();
  const lines = detail.split('\n');
  printWithPager(detail, lines.length);
}

function buildPickerMessage(opts: ResourceViewOptions): string {
  const scope = opts.filterVersion
    ? ` (${opts.filterAgent}@${opts.filterVersion})`
    : opts.filterAgent
      ? ` (${opts.filterAgent})`
      : '';
  return `Search ${opts.resourcePlural}${scope}:`;
}

function filterRows(rows: ResourceRow[], query: string): ResourceRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) =>
    r.name.toLowerCase().includes(q) ||
    (r.description?.toLowerCase().includes(q) ?? false)
  );
}

/** Row label rendered inside the picker list. */
function formatPickerRow(row: ResourceRow, opts: ResourceViewOptions): string {
  const name = chalk.cyan(padRight(row.name, 22));
  const extra = opts.extraLabel
    ? chalk.gray(padRight(row.extra ?? '-', 10))
    : '';
  const sync = formatSyncSummary(row.targets, opts);
  const desc = row.description
    ? chalk.gray(truncate(row.description, 40))
    : '';
  return `${name} ${extra}${desc.padEnd(42)} ${sync}`;
}

/** Table mode (piped output). */
function printResourceTable(opts: ResourceViewOptions): void {
  const header = buildTableHeader(opts);
  console.log(header);
  console.log(chalk.gray('─'.repeat(Math.min(process.stdout.columns || 100, 120))));

  for (const row of opts.rows) {
    const name = chalk.cyan(padRight(row.name, 22));
    const extra = opts.extraLabel
      ? padRight(row.extra ?? '-', 10)
      : '';
    const desc = row.description ? chalk.gray(truncate(row.description, 40)) : chalk.gray('-');
    const sync = formatSyncSummary(row.targets, opts);
    console.log(`${name} ${extra}${desc.padEnd(42)} ${sync}`);
  }

  console.log();
  const summary: string[] = [
    `${opts.rows.length} ${opts.rows.length === 1 ? opts.resourceSingular : opts.resourcePlural}`,
  ];
  if (opts.centralPath) {
    summary.push(`central: ${opts.centralPath}`);
  }
  console.log(chalk.gray(summary.join(' · ')));
}

function buildTableHeader(opts: ResourceViewOptions): string {
  const name = chalk.bold(padRight('Name', 22));
  const extra = opts.extraLabel
    ? chalk.bold(padRight(opts.extraLabel, 10))
    : '';
  const desc = chalk.bold(padRight('Description', 40));
  const sync = chalk.bold('Synced');
  return `${name} ${extra}${desc.padEnd(42)} ${sync}`;
}

/** Compact human-friendly sync status (e.g. "all (6)", "4/6", "claude only"). */
function formatSyncSummary(targets: SyncTarget[], opts: ResourceViewOptions): string {
  if (targets.length === 0) {
    return chalk.gray('no targets');
  }

  const synced = targets.filter((t) => t.status === 'synced');
  const stale = targets.filter((t) => t.status === 'stale');
  const missing = targets.filter((t) => t.status === 'missing');

  // Narrow case: single-version scope gives a boolean answer.
  if (opts.filterVersion && targets.length === 1) {
    const t = targets[0];
    if (t.status === 'synced') return chalk.green('installed');
    if (t.status === 'stale') return chalk.yellow('stale');
    return chalk.red('missing');
  }

  const total = targets.length;
  const presentCount = synced.length + stale.length;

  let core: string;
  if (presentCount === 0) {
    core = chalk.red(`0/${total}`);
  } else if (presentCount === total && stale.length === 0) {
    core = chalk.green(`all (${total})`);
  } else {
    const color = presentCount === total ? chalk.yellow : chalk.yellow;
    core = color(`${presentCount}/${total}`);
  }

  const parts = [core];

  if (stale.length > 0) {
    parts.push(chalk.yellow(`${stale.length} stale`));
  }

  // Hint which agents are missing when the spread is lopsided.
  if (missing.length > 0 && missing.length <= 2) {
    const missLabels = missing.map((t) => `${t.agent}@${t.version}`).join(', ');
    parts.push(chalk.gray(`missing: ${missLabels}`));
  }

  return parts.join(chalk.gray(' · '));
}

/** Build the detail pane text shown when a row is focused. */
export function buildTargetsSection(targets: SyncTarget[]): string {
  if (targets.length === 0) return chalk.gray('  No capable agent versions installed.');

  // Group by agent
  const byAgent = new Map<AgentId, SyncTarget[]>();
  for (const t of targets) {
    const list = byAgent.get(t.agent) || [];
    list.push(t);
    byAgent.set(t.agent, list);
  }

  const lines: string[] = [];
  for (const [agent, list] of byAgent) {
    const label = agentLabel(agent);
    const pills = list.map((t) => formatVersionPill(t)).join(' ');
    lines.push(`  ${label}  ${pills}`);
  }
  return lines.join('\n');
}

function formatVersionPill(t: SyncTarget): string {
  const star = t.isDefault ? chalk.yellow('★ ') : '';
  const vtxt = `v${t.version}`;
  switch (t.status) {
    case 'synced':
      return star + chalk.green(vtxt);
    case 'stale':
      return star + chalk.yellow(`${vtxt} (stale)`);
    case 'missing':
      return star + chalk.gray.strikethrough(vtxt);
  }
}

function padRight(s: string, width: number): string {
  // Strip ANSI for length calc
  const raw = s.replace(/\x1b\[[0-9;]*m/g, '');
  if (raw.length >= width) return s;
  return s + ' '.repeat(width - raw.length);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
