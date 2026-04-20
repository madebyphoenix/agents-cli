import chalk from 'chalk';
import { itemPicker } from '../lib/picker.js';
import type { AgentStatusDetail, TaskInfo } from '../lib/teams/api.js';

export interface TeamRow {
  team: TaskInfo;
  agents: AgentStatusDetail[];
  description?: string;
}

export interface PickedTeam {
  team: string;
}

const AGENT_LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  cursor: 'Cursor',
  opencode: 'OpenCode',
};

const DOT = chalk.gray(' · ');

function statusColor(status: string): (s: string) => string {
  switch (status) {
    case 'pending': return chalk.blue;
    case 'running': return chalk.yellow;
    case 'completed': return chalk.green;
    case 'failed': return chalk.red;
    case 'stopped': return chalk.gray;
    default: return chalk.white;
  }
}

function relTime(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function firstLine(s: string): string {
  // Collapse to the first non-empty line so multi-line messages (markdown,
  // code blocks) render cleanly inside a one-line preview slot.
  for (const line of s.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function displayAgent(agent: string, version?: string | null): string {
  const label = AGENT_LABEL[agent] || agent;
  return version ? `${label}@${version}` : label;
}

function statusSummaryParts(t: TaskInfo): string[] {
  const parts: string[] = [];
  if (t.pending) parts.push(chalk.blue(`${t.pending} pending`));
  if (t.running) parts.push(chalk.yellow(`${t.running} working`));
  if (t.completed) parts.push(chalk.green(`${t.completed} done`));
  if (t.failed) parts.push(chalk.red(`${t.failed} failed`));
  if (t.stopped) parts.push(chalk.gray(`${t.stopped} stopped`));
  return parts;
}

export function formatTeamRow(row: TeamRow, nameWidth: number): string {
  const t = row.team;
  const summary = statusSummaryParts(t).join(' ') || chalk.gray(t.agent_count === 0 ? 'empty' : '-');
  const members = `${t.agent_count} member${t.agent_count === 1 ? '' : 's'}`;
  const when = chalk.gray(relTime(t.modified_at));
  const main = `${chalk.cyan(t.task_name.padEnd(nameWidth))}  ${chalk.gray(members.padEnd(11))}  ${summary.padEnd(40)}`;
  return `${main} ${when}`;
}

function handle(a: AgentStatusDetail): string {
  return a.name || a.agent_id.slice(0, 8);
}

export function buildTeamPreview(row: TeamRow): string {
  const t = row.team;
  const lines: string[] = [];

  const head: string[] = [];
  head.push(chalk.bold.white(t.task_name));
  head.push(chalk.gray(`created ${relTime(t.created_at)}`));
  if (t.modified_at !== t.created_at) {
    head.push(chalk.gray(`last activity ${relTime(t.modified_at)}`));
  }
  const summary = statusSummaryParts(t);
  if (summary.length) head.push(summary.join(' '));
  lines.push(head.join(DOT));

  if (row.description) {
    lines.push(chalk.gray(row.description));
  }

  if (row.agents.length === 0) {
    lines.push('');
    lines.push(chalk.gray('  (no teammates yet — add one with `agents teams add`)'));
    return lines.join('\n');
  }

  lines.push('');

  // Column widths
  const nameW = Math.max(6, ...row.agents.map((a) => handle(a).length));
  const agentW = Math.max(8, ...row.agents.map((a) => displayAgent(a.agent_type, a.version).length));

  for (const a of row.agents) {
    const stat = statusColor(a.status)(a.status);
    const metaParts: string[] = [];
    if (a.duration) metaParts.push(chalk.white(a.duration));
    metaParts.push(chalk.gray(`${a.tool_count} tools`));
    const modified = a.files_modified.length;
    if (modified) metaParts.push(chalk.gray(`${modified} file${modified === 1 ? '' : 's'} modified`));
    const meta = metaParts.join(DOT);

    lines.push(
      `  ${chalk.cyan(handle(a).padEnd(nameW))}  ${displayAgent(a.agent_type, a.version).padEnd(agentW)}  ${stat}${DOT}${meta}`
    );

    const lastMsg = a.last_messages[a.last_messages.length - 1];
    if (lastMsg) {
      const oneLine = firstLine(lastMsg);
      if (oneLine) {
        lines.push(`    ${chalk.gray('└')} ${chalk.gray(truncate(oneLine, 96))}`);
      }
    }
    if (a.has_errors) {
      lines.push(`    ${chalk.red('!')} ${chalk.red('reported an error')}`);
    }
  }

  return lines.join('\n');
}

export async function teamPicker(rows: TeamRow[], initialSearch?: string): Promise<PickedTeam | null> {
  const nameWidth = Math.max(12, ...rows.map((r) => r.team.task_name.length));

  const picked = await itemPicker<TeamRow>({
    message: 'Select a team:',
    items: rows,
    filter: (query: string) => {
      if (!query.trim()) return rows;
      const q = query.toLowerCase();
      return rows.filter((r) => {
        if (r.team.task_name.toLowerCase().includes(q)) return true;
        if (r.description && r.description.toLowerCase().includes(q)) return true;
        return r.agents.some(
          (a) =>
            (a.name || '').toLowerCase().includes(q) ||
            a.agent_type.toLowerCase().includes(q)
        );
      });
    },
    labelFor: (row) => formatTeamRow(row, nameWidth),
    buildPreview: buildTeamPreview,
    shortIdFor: (row) => row.team.task_name,
    pageSize: 10,
    initialSearch,
    emptyMessage: 'No teams match.',
    enterHint: 'view status',
  });

  if (!picked) return null;
  return { team: picked.item.team.task_name };
}
