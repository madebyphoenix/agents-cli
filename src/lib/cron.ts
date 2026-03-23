import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { getCronDir, getRunsDir, ensureAgentsDir } from './state.js';
import type { AgentId } from './types.js';

export interface JobAllowConfig {
  tools?: string[];
  sites?: string[];
  dirs?: string[];
}

export interface JobConfig {
  name: string;
  schedule: string;
  agent: AgentId;
  mode: 'plan' | 'edit';
  effort: 'fast' | 'default' | 'detailed';
  timeout: string;
  enabled: boolean;
  prompt: string;
  timezone?: string;
  variables?: Record<string, string>;
  sandbox?: boolean;
  allow?: JobAllowConfig;
  config?: Record<string, unknown>;
  version?: string;
}

export interface RunMeta {
  jobName: string;
  runId: string;
  agent: AgentId;
  pid: number | null;
  status: 'running' | 'completed' | 'failed' | 'timeout';
  startedAt: string;
  completedAt: string | null;
  exitCode: number | null;
}

const JOB_DEFAULTS: Partial<JobConfig> = {
  mode: 'plan',
  effort: 'default',
  timeout: '30m',
  enabled: true,
};

export function listJobs(): JobConfig[] {
  ensureAgentsDir();
  const jobsDir = getCronDir();
  if (!fs.existsSync(jobsDir)) return [];

  const files = fs.readdirSync(jobsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const jobs: JobConfig[] = [];
  for (const file of files) {
    const job = readJobFile(path.join(jobsDir, file));
    if (job) jobs.push(job);
  }
  return jobs;
}

export function readJob(name: string): JobConfig | null {
  ensureAgentsDir();
  const jobsDir = getCronDir();
  for (const ext of ['.yml', '.yaml']) {
    const filePath = path.join(jobsDir, name + ext);
    if (fs.existsSync(filePath)) {
      return readJobFile(filePath);
    }
  }
  return null;
}

function readJobFile(filePath: string): JobConfig | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;

    return {
      ...JOB_DEFAULTS,
      ...parsed,
      name: parsed.name || path.basename(filePath).replace(/\.ya?ml$/, ''),
    } as JobConfig;
  } catch {
    return null;
  }
}

export function writeJob(config: JobConfig): void {
  ensureAgentsDir();
  const jobsDir = getCronDir();
  const filePath = path.join(jobsDir, config.name + '.yml');

  const output: Record<string, unknown> = { ...config };
  if (output.mode === 'plan') delete output.mode;
  if (output.effort === 'default') delete output.effort;
  if (output.timeout === '30m') delete output.timeout;
  if (output.enabled === true) delete output.enabled;

  fs.writeFileSync(filePath, yaml.stringify(output), 'utf-8');
}

export function deleteJob(name: string): boolean {
  const jobsDir = getCronDir();
  for (const ext of ['.yml', '.yaml']) {
    const filePath = path.join(jobsDir, name + ext);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  }
  return false;
}

export function setJobEnabled(name: string, enabled: boolean): void {
  const job = readJob(name);
  if (!job) throw new Error(`Job '${name}' not found`);
  job.enabled = enabled;
  writeJob(job);
}

export function validateJob(config: Partial<JobConfig>): string[] {
  const errors: string[] = [];

  if (!config.name || typeof config.name !== 'string') {
    errors.push('name is required');
  }
  if (!config.schedule || typeof config.schedule !== 'string') {
    errors.push('schedule (cron expression) is required');
  }
  if (!config.agent || typeof config.agent !== 'string') {
    errors.push('agent is required');
  }
  const validJobAgents = ['claude', 'codex', 'gemini', 'cursor', 'opencode'];
  if (config.agent && !validJobAgents.includes(config.agent)) {
    errors.push(`agent must be one of: ${validJobAgents.join(', ')}`);
  }
  if (config.mode && !['plan', 'edit'].includes(config.mode)) {
    errors.push('mode must be plan or edit');
  }
  if (config.effort && !['fast', 'default', 'detailed'].includes(config.effort)) {
    errors.push('effort must be fast, default, or detailed');
  }
  if (!config.prompt || typeof config.prompt !== 'string') {
    errors.push('prompt is required');
  }
  if (config.timeout && !parseTimeout(config.timeout)) {
    errors.push('timeout must be like 30m, 2h, 1h30m');
  }

  return errors;
}

export function resolveJobPrompt(config: JobConfig): string {
  const now = new Date();
  const tz = config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Compute date/day/time in the job's configured timezone
  const dayIndex = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'narrow' }).formatToParts(now).find(p => p.type === 'weekday')?.value || '0', 10);
  const localDay = days[new Date(now.toLocaleString('en-US', { timeZone: tz })).getDay()];
  const localDate = now.toLocaleDateString('en-CA', { timeZone: tz }); // en-CA gives YYYY-MM-DD
  const localTime = now.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false }); // HH:MM:SS

  let prompt = config.prompt;

  // Built-in variables (timezone-aware)
  prompt = prompt.replace(/\{day\}/g, localDay);
  prompt = prompt.replace(/\{date\}/g, localDate);
  prompt = prompt.replace(/\{time\}/g, localTime);
  prompt = prompt.replace(/\{job_name\}/g, config.name);

  // User-defined variables
  if (config.variables) {
    for (const [key, value] of Object.entries(config.variables)) {
      prompt = prompt.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
  }

  // Last report (special handling)
  const latestRun = getLatestRun(config.name);
  if (latestRun) {
    const reportPath = path.join(getRunsDir(), config.name, latestRun.runId, 'report.md');
    if (fs.existsSync(reportPath)) {
      const report = fs.readFileSync(reportPath, 'utf-8');
      prompt = prompt.replace(/\{last_report\}/g, report);
    } else {
      prompt = prompt.replace(/\{last_report\}/g, '(no previous report)');
    }
  } else {
    prompt = prompt.replace(/\{last_report\}/g, '(no previous report)');
  }

  return prompt;
}

export function parseTimeout(timeout: string): number | null {
  const match = timeout.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!match) return null;

  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const ms = (hours * 60 + minutes) * 60 * 1000;
  return ms > 0 ? ms : null;
}

export function listRuns(jobName: string): RunMeta[] {
  const runsDir = getRunsDir();
  const jobRunsDir = path.join(runsDir, jobName);
  if (!fs.existsSync(jobRunsDir)) return [];

  const entries = fs.readdirSync(jobRunsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const runs: RunMeta[] = [];
  for (const runId of entries) {
    const meta = readRunMeta(jobName, runId);
    if (meta) runs.push(meta);
  }
  return runs;
}

export function getLatestRun(jobName: string): RunMeta | null {
  const runs = listRuns(jobName);
  return runs.length > 0 ? runs[runs.length - 1] : null;
}

export function writeRunMeta(meta: RunMeta): void {
  ensureAgentsDir();
  const runDir = path.join(getRunsDir(), meta.jobName, meta.runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

export function readRunMeta(jobName: string, runId: string): RunMeta | null {
  const metaPath = path.join(getRunsDir(), jobName, runId, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as RunMeta;
  } catch {
    return null;
  }
}

export function getRunDir(jobName: string, runId: string): string {
  return path.join(getRunsDir(), jobName, runId);
}

export function discoverJobsFromRepo(repoPath: string): Array<{ name: string; path: string }> {
  const jobsPath = path.join(repoPath, 'cron');
  if (!fs.existsSync(jobsPath)) return [];

  return fs.readdirSync(jobsPath)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => ({
      name: f.replace(/\.ya?ml$/, ''),
      path: path.join(jobsPath, f),
    }));
}

export function jobExists(name: string): boolean {
  return readJob(name) !== null;
}

export function getJobPath(name: string): string | null {
  const jobsDir = getCronDir();
  for (const ext of ['.yml', '.yaml']) {
    const filePath = path.join(jobsDir, name + ext);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

/**
 * Parse an "at" time string into a one-shot cron expression.
 * Supports formats like:
 * - "9:00" or "09:00" - today at 9:00 AM (or tomorrow if past)
 * - "14:30" - today at 2:30 PM
 * - "2026-02-24 09:00" - specific date and time
 * Returns null if invalid format.
 */
export function parseAtTime(atTime: string): { schedule: string; runOnce: boolean } | null {
  // Try parsing as "HH:MM" format
  const timeMatch = atTime.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1], 10);
    const minute = parseInt(timeMatch[2], 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

    const now = new Date();
    let targetDate = new Date();
    targetDate.setHours(hour, minute, 0, 0);

    // If the time has already passed today, schedule for tomorrow
    if (targetDate <= now) {
      targetDate.setDate(targetDate.getDate() + 1);
    }

    const day = targetDate.getDate();
    const month = targetDate.getMonth() + 1;
    // Cron format: minute hour day month *
    return { schedule: `${minute} ${hour} ${day} ${month} *`, runOnce: true };
  }

  // Try parsing as "YYYY-MM-DD HH:MM" format
  const dateTimeMatch = atTime.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (dateTimeMatch) {
    const year = parseInt(dateTimeMatch[1], 10);
    const month = parseInt(dateTimeMatch[2], 10);
    const day = parseInt(dateTimeMatch[3], 10);
    const hour = parseInt(dateTimeMatch[4], 10);
    const minute = parseInt(dateTimeMatch[5], 10);

    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

    // Note: croner doesn't support year, so we just use month/day
    // The job will fire on that date each year unless removed
    return { schedule: `${minute} ${hour} ${day} ${month} *`, runOnce: true };
  }

  return null;
}

export function jobContentMatches(name: string, sourcePath: string): boolean {
  const existing = readJob(name);
  if (!existing) return false;

  try {
    const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
    const sourceJob = yaml.parse(sourceContent);
    if (!sourceJob) return false;

    const existingNormalized = yaml.stringify(existing);
    const fullSource = { ...JOB_DEFAULTS, ...sourceJob, name: sourceJob.name || name };
    const sourceNormalized = yaml.stringify(fullSource);
    return existingNormalized === sourceNormalized;
  } catch {
    return false;
  }
}

export function installJobFromSource(sourcePath: string, name: string): { success: boolean; error?: string } {
  try {
    const content = fs.readFileSync(sourcePath, 'utf-8');
    const parsed = yaml.parse(content);
    if (!parsed) return { success: false, error: 'Invalid YAML' };

    const config: JobConfig = {
      ...JOB_DEFAULTS,
      ...parsed,
      name: parsed.name || name,
    } as JobConfig;

    const errors = validateJob(config);
    if (errors.length > 0) {
      return { success: false, error: errors.join(', ') };
    }

    writeJob(config);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
