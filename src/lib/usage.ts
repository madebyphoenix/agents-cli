import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { promisify } from 'util';
import chalk from 'chalk';

import type { AccountInfo } from './agents.js';
import { getAgentsDir } from './state.js';
import type { AgentId } from './types.js';
import { walkForFiles } from './session/discover.js';

const execFileAsync = promisify(execFile);

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const CLAUDE_REFRESH_LEEWAY_MS = 5 * 60 * 1000;
const CLAUDE_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
];
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CLAUDE_USAGE_CACHE_PATH = path.join(getAgentsDir(), 'cache', 'claude-usage.json');
const CACHED_CLAUDE_USAGE_SOURCE_LABEL = 'last seen live account data';

const COMPACT_BAR_LEN = 5;
const USAGE_BAR_LEN = 10;
const FULL = '\u2588';
const EMPTY = '\u2591';

export type UsageWindowKey = 'session' | 'week' | 'sonnet_week';

export interface UsageWindow {
  key: UsageWindowKey;
  label: string;
  shortLabel: string;
  usedPercent: number;
  resetsAt: Date | null;
  windowMinutes: number | null;
}

export interface UsageSnapshot {
  source: 'live' | 'last_seen';
  sourceLabel: string;
  capturedAt: Date | null;
  windows: UsageWindow[];
}

export interface UsageInfo {
  snapshot: UsageSnapshot | null;
  error: string | null;
}

export interface UsageIdentityInput {
  agentId: AgentId;
  info: AccountInfo;
  home?: string;
  cliVersion?: string | null;
}

interface UsageOptions {
  home?: string;
  cliVersion?: string | null;
  organizationId?: string | null;
}

export interface UsageFetchInput {
  agentId: AgentId;
  home?: string;
  cliVersion: string | null;
  organizationId: string | null;
}

interface CodexRateLimitWindow {
  used_percent?: number | null;
  window_minutes?: number | null;
  resets_at?: number | string | null;
}

interface CodexRateLimits {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
}

interface ClaudeUsageWindow {
  utilization?: number | null;
  resets_at?: number | string | null;
}

interface ClaudeUsageResponse {
  five_hour?: ClaudeUsageWindow | null;
  seven_day?: ClaudeUsageWindow | null;
  seven_day_sonnet?: ClaudeUsageWindow | null;
}

interface ClaudeOauthCredentials {
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  scopes?: string[] | null;
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
  organizationUuid?: string | null;
}

interface ClaudeKeychainPayload {
  organizationUuid?: string | null;
  claudeAiOauth?: ClaudeOauthCredentials | null;
}

interface ClaudeTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

interface CachedUsageWindow {
  key: UsageWindowKey;
  label: string;
  shortLabel: string;
  usedPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
}

interface CachedUsageSnapshot {
  capturedAt: string | null;
  windows: CachedUsageWindow[];
}

interface CodexRateLimitMatch {
  capturedAt: Date | null;
  rateLimits: CodexRateLimits;
}

export async function getUsageInfo(agentId: AgentId, options?: UsageOptions): Promise<UsageInfo> {
  switch (agentId) {
    case 'claude':
      return getClaudeUsageInfo(options);
    case 'codex':
      return getCodexUsageInfo(options);
    default:
      return { snapshot: null, error: null };
  }
}

export function getUsageLookupKey(
  info?: Pick<AccountInfo, 'usageKey' | 'accountKey'> | null
): string | null {
  return info?.usageKey || info?.accountKey || null;
}

export function buildCanonicalUsageContext(inputs: UsageIdentityInput[]): {
  canonicalByUsageKey: Map<string, AccountInfo>;
  usageFetchInputs: Map<string, UsageFetchInput>;
} {
  const canonicalByUsageKey = new Map<string, AccountInfo>();
  const usageFetchInputs = new Map<string, UsageFetchInput>();

  for (const input of inputs) {
    const key = getUsageLookupKey(input.info);
    if (!key) continue;

    const existing = canonicalByUsageKey.get(key);
    const existingMs = existing?.lastActive?.getTime() ?? -1;
    const currentMs = input.info.lastActive?.getTime() ?? -1;
    if (existing && existingMs >= currentMs) {
      continue;
    }

    canonicalByUsageKey.set(key, input.info);
    usageFetchInputs.set(key, {
      agentId: input.agentId,
      home: input.home,
      cliVersion: input.cliVersion || null,
      organizationId: input.info.organizationId,
    });
  }

  return { canonicalByUsageKey, usageFetchInputs };
}

export async function getUsageInfoByIdentity(inputs: UsageIdentityInput[]): Promise<{
  canonicalByUsageKey: Map<string, AccountInfo>;
  usageByKey: Map<string, UsageInfo>;
}> {
  const { canonicalByUsageKey, usageFetchInputs } = buildCanonicalUsageContext(inputs);
  const usageResults = await Promise.all(
    [...usageFetchInputs.entries()].map(async ([key, input]) => ({
      key,
      usage: await getUsageInfoForIdentity({
        agentId: input.agentId,
        home: input.home,
        cliVersion: input.cliVersion,
        info: canonicalByUsageKey.get(key)!,
      }),
    }))
  );

  return {
    canonicalByUsageKey,
    usageByKey: new Map(usageResults.map(({ key, usage }) => [key, usage])),
  };
}

const USAGE_CACHE_FRESH_MS = 2 * 60 * 1000; // 2 minutes

export async function getUsageInfoForIdentity(input: UsageIdentityInput): Promise<UsageInfo> {
  const usageKey = getUsageLookupKey(input.info);

  // Fast path: serve from cache if fresh. Skips the network call entirely.
  if (input.agentId === 'claude' && usageKey) {
    const cached = readClaudeUsageCache(usageKey);
    if (cached?.capturedAt) {
      const ageMs = Date.now() - cached.capturedAt.getTime();
      if (ageMs < USAGE_CACHE_FRESH_MS) {
        return { snapshot: cached, error: null };
      }
    }
  }

  // Cache miss or stale — make the network call.
  const usage = await getUsageInfo(input.agentId, {
    home: input.home,
    cliVersion: input.cliVersion,
    organizationId: input.info.organizationId,
  });
  if (input.agentId !== 'claude' || !usageKey) {
    return usage;
  }

  if (usage.snapshot?.source === 'live') {
    writeClaudeUsageCache(usageKey, usage.snapshot);
    return usage;
  }

  const cached = readClaudeUsageCache(usageKey);
  if (cached) {
    return { snapshot: cached, error: usage.error };
  }
  return usage;
}

export function formatUsageSummary(
  plan: string | null,
  snapshot: UsageSnapshot | null,
  planWidth = 3
): string {
  const parts: string[] = [];

  if (plan) {
    parts.push(chalk.gray(plan.padEnd(planWidth)));
  }

  if (snapshot) {
    const windows = snapshot.windows
      .filter((window) => window.key !== 'sonnet_week')
      .map((window) =>
      `${chalk.gray(`${window.shortLabel}:`)} ${renderCompactUsageBar(window.usedPercent)}`
    );
    if (windows.length > 0) {
      parts.push(windows.join(' '));
    }
  }

  return parts.join('  ');
}

export function formatUsageSection(usage: UsageInfo): string[] {
  if (!usage.snapshot && !usage.error) {
    return [];
  }

  const lines = ['  Usage', ''];

  if (!usage.snapshot) {
    lines.push(`    ${chalk.dim(usage.error || 'Usage data unavailable right now.')}`);
    return lines;
  }

  const labelWidth = usage.snapshot.windows.reduce((max, window) => Math.max(max, window.label.length), 0);
  for (const window of usage.snapshot.windows) {
    const bar = renderUsageBar(window.usedPercent);
    lines.push(`    ${chalk.bold(window.label.padEnd(labelWidth))}  ${bar} ${formatPercent(window.usedPercent)}% used`);
    if (window.resetsAt) {
      lines.push(`    ${chalk.dim(`Resets ${formatResetAt(window.resetsAt)}`)}`);
    }
    lines.push('');
  }

  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  lines.push(`    ${chalk.dim(`Source: ${usage.snapshot.sourceLabel}`)}`);
  return lines;
}

async function getCodexUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const files = collectCodexSessionFiles(options?.home);
    for (const filePath of files) {
      const match = await readLatestCodexRateLimits(filePath);
      if (!match) continue;

      const windows = normalizeCodexWindows(match.rateLimits);
      if (windows.length === 0) continue;

      return {
        snapshot: {
          source: 'last_seen',
          sourceLabel: 'last seen in latest Codex session',
          capturedAt: match.capturedAt,
          windows,
        },
        error: null,
      };
    }

    return { snapshot: null, error: null };
  } catch {
    return { snapshot: null, error: null };
  }
}

async function getClaudeUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const oauth = await loadClaudeOauth(options?.home);
    if (!oauth?.accessToken) {
      return { snapshot: null, error: null };
    }

    const requestedOrgId = normalizeString(options?.organizationId);
    const liveOrgId = normalizeString(oauth.organizationUuid);
    if (!isClaudeUsageOrgMatch(requestedOrgId, liveOrgId)) {
      return { snapshot: null, error: null };
    }

    const accessToken = await getClaudeAccessToken(oauth);
    if (!accessToken) {
      return { snapshot: null, error: null };
    }

    const response = await fetch(CLAUDE_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-beta': CLAUDE_OAUTH_BETA_HEADER,
        'User-Agent': getClaudeUserAgent(options?.cliVersion),
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return { snapshot: null, error: formatClaudeUsageError(response.status) };
    }

    const data = await response.json() as ClaudeUsageResponse;
    const windows = normalizeClaudeWindows(data);
    if (windows.length === 0) {
      return { snapshot: null, error: null };
    }

    return {
      snapshot: {
        source: 'live',
        sourceLabel: 'live account data',
        capturedAt: new Date(),
        windows,
      },
      error: null,
    };
  } catch {
    return { snapshot: null, error: 'Usage data unavailable right now.' };
  }
}

function collectCodexSessionFiles(home?: string): string[] {
  const base = home || os.homedir();
  const dir = path.join(base, '.codex', 'sessions');
  if (!fs.existsSync(dir)) return [];

  const seenFiles = new Set<string>();
  const files: Array<{ path: string; mtime: number }> = [];
  for (const filePath of walkForFiles(dir, '.jsonl', 20)) {
    const real = safeRealpathSync(filePath) || filePath;
    if (seenFiles.has(real)) continue;
    seenFiles.add(real);
    const stat = safeStatSync(filePath);
    if (!stat) continue;
    files.push({ path: filePath, mtime: stat.mtimeMs });
  }

  files.sort((a, b) => b.mtime - a.mtime);
  return files.map((file) => file.path);
}

async function readLatestCodexRateLimits(filePath: string): Promise<CodexRateLimitMatch | null> {
  return new Promise((resolve) => {
    let latest: CodexRateLimitMatch | null = null;
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type !== 'event_msg' || parsed.payload?.type !== 'token_count' || !parsed.payload?.rate_limits) {
          return;
        }

        latest = {
          capturedAt: parseDateValue(parsed.timestamp),
          rateLimits: parsed.payload.rate_limits as CodexRateLimits,
        };
      } catch {
        /* malformed session line */
      }
    });

    rl.on('close', () => resolve(latest));
    rl.on('error', () => resolve(latest));
  });
}

function normalizeCodexWindows(rateLimits: CodexRateLimits): UsageWindow[] {
  const windows: UsageWindow[] = [];

  const primary = normalizeCodexWindow(rateLimits.primary, 'session', 'Current session', 'S');
  if (primary) windows.push(primary);

  const secondary = normalizeCodexWindow(rateLimits.secondary, 'week', 'Current week', 'W');
  if (secondary) windows.push(secondary);

  return windows;
}

function normalizeCodexWindow(
  window: CodexRateLimitWindow | null | undefined,
  key: UsageWindowKey,
  label: string,
  shortLabel: string
): UsageWindow | null {
  const usedPercent = normalizePercent(window?.used_percent);
  if (usedPercent === null) return null;

  return {
    key,
    label,
    shortLabel,
    usedPercent,
    resetsAt: parseDateValue(window?.resets_at),
    windowMinutes: normalizeWindowMinutes(window?.window_minutes),
  };
}

function normalizeClaudeWindows(data: ClaudeUsageResponse): UsageWindow[] {
  const windows = [
    normalizeClaudeWindow(data.five_hour, 'session', 'Current session', 'S'),
    normalizeClaudeWindow(data.seven_day, 'week', 'Current week (all models)', 'W'),
    normalizeClaudeWindow(data.seven_day_sonnet, 'sonnet_week', 'Current week (Sonnet only)', 'So'),
  ];

  return windows.filter((window): window is UsageWindow => window !== null);
}

function normalizeClaudeWindow(
  window: ClaudeUsageWindow | null | undefined,
  key: UsageWindowKey,
  label: string,
  shortLabel: string
): UsageWindow | null {
  const usedPercent = normalizePercent(window?.utilization);
  if (usedPercent === null) return null;

  return {
    key,
    label,
    shortLabel,
    usedPercent,
    resetsAt: parseDateValue(window?.resets_at),
    windowMinutes: inferWindowMinutes(key),
  };
}

export async function loadClaudeOauth(home?: string): Promise<ClaudeOauthCredentials | null> {
  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    const account = os.userInfo().username;
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-a',
      account,
      '-s',
      // Managed Claude homes must stay pinned to their own service name.
      getClaudeKeychainService(home),
      '-w',
    ]);

    const payload = JSON.parse(stdout.trim()) as ClaudeKeychainPayload;
    if (!payload.claudeAiOauth) {
      return null;
    }
    return {
      ...payload.claudeAiOauth,
      organizationUuid: normalizeString(payload.organizationUuid),
    };
  } catch {
    return null;
  }
}

export function getClaudeKeychainService(home?: string): string {
  if (!home) {
    return CLAUDE_KEYCHAIN_SERVICE;
  }

  const configDir = path.join(home, '.claude').normalize('NFC');
  const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${hash}`;
}

export function isClaudeUsageOrgMatch(
  requestedOrgId: string | null | undefined,
  liveOrgId: string | null | undefined
): boolean {
  const requested = normalizeString(requestedOrgId);
  const live = normalizeString(liveOrgId);
  return !requested || !live || requested === live;
}

export function readClaudeUsageCache(
  usageKey: string,
  cachePath = CLAUDE_USAGE_CACHE_PATH,
  now = new Date()
): UsageSnapshot | null {
  const cache = readClaudeUsageCacheFile(cachePath);
  const cached = cache[usageKey];
  if (!cached) {
    return null;
  }

  const snapshot = deserializeClaudeUsageSnapshot(cached, now);
  if (!snapshot) {
    delete cache[usageKey];
    writeClaudeUsageCacheFile(cache, cachePath);
  }
  return snapshot;
}

export function writeClaudeUsageCache(
  usageKey: string,
  snapshot: UsageSnapshot,
  cachePath = CLAUDE_USAGE_CACHE_PATH
): void {
  const cache = readClaudeUsageCacheFile(cachePath);
  cache[usageKey] = serializeClaudeUsageSnapshot(snapshot);
  writeClaudeUsageCacheFile(cache, cachePath);
}

function readClaudeUsageCacheFile(cachePath: string): Record<string, CachedUsageSnapshot> {
  if (!fs.existsSync(cachePath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as Record<string, CachedUsageSnapshot>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeClaudeUsageCacheFile(
  cache: Record<string, CachedUsageSnapshot>,
  cachePath: string
): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  } catch {
    /* best-effort cache write */
  }
}

function serializeClaudeUsageSnapshot(snapshot: UsageSnapshot): CachedUsageSnapshot {
  return {
    capturedAt: snapshot.capturedAt?.toISOString() || null,
    windows: snapshot.windows.map((window) => ({
      key: window.key,
      label: window.label,
      shortLabel: window.shortLabel,
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt?.toISOString() || null,
      windowMinutes: window.windowMinutes,
    })),
  };
}

function deserializeClaudeUsageSnapshot(
  snapshot: CachedUsageSnapshot,
  now: Date
): UsageSnapshot | null {
  const capturedAt = parseDateValue(snapshot.capturedAt);
  const windows = snapshot.windows
    .map((window) => {
      const w = {
        key: window.key,
        label: window.label,
        shortLabel: window.shortLabel,
        usedPercent: window.usedPercent,
        resetsAt: parseDateValue(window.resetsAt),
        windowMinutes: window.windowMinutes,
      };
      if (!isCachedUsageWindowFresh(w, capturedAt, now)) {
        w.usedPercent = 0;
      }
      return w;
    });

  if (windows.length === 0) {
    return null;
  }

  return {
    source: 'last_seen',
    sourceLabel: CACHED_CLAUDE_USAGE_SOURCE_LABEL,
    capturedAt,
    windows,
  };
}

function isCachedUsageWindowFresh(
  window: UsageWindow,
  capturedAt: Date | null,
  now: Date
): boolean {
  if (window.resetsAt && window.resetsAt.getTime() <= now.getTime()) {
    return false;
  }
  if (capturedAt && window.windowMinutes !== null) {
    const expiresAt = capturedAt.getTime() + window.windowMinutes * 60 * 1000;
    if (expiresAt <= now.getTime()) {
      return false;
    }
  }
  return true;
}

async function getClaudeAccessToken(oauth: ClaudeOauthCredentials): Promise<string | null> {
  const accessToken = oauth.accessToken?.trim();
  if (!accessToken) {
    return null;
  }

  const expiresAt = oauth.expiresAt ?? null;
  if (expiresAt === null || Date.now() + CLAUDE_REFRESH_LEEWAY_MS < expiresAt) {
    return accessToken;
  }

  if (!oauth.refreshToken) {
    return null;
  }

  const refreshed = await refreshClaudeToken(oauth);
  return refreshed?.accessToken?.trim() || null;
}

async function refreshClaudeToken(oauth: ClaudeOauthCredentials): Promise<ClaudeOauthCredentials | null> {
  const response = await fetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: oauth.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
      scope: (oauth.scopes?.length ? oauth.scopes : CLAUDE_SCOPES).join(' '),
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json() as ClaudeTokenResponse;
  if (!data.access_token || !data.expires_in) {
    return null;
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || oauth.refreshToken || null,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: data.scope ? data.scope.split(/\s+/).filter(Boolean) : (oauth.scopes || CLAUDE_SCOPES),
  };
}

function getClaudeUserAgent(cliVersion?: string | null): string {
  return cliVersion ? `claude-code/${cliVersion}` : 'claude-code';
}

function formatClaudeUsageError(status: number): string {
  if (status === 429) {
    return 'Usage data unavailable right now.';
  }
  return 'Could not load usage data right now.';
}

function normalizePercent(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, value));
}

function normalizeWindowMinutes(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

function inferWindowMinutes(key: UsageWindowKey): number | null {
  switch (key) {
    case 'session':
      return 300;
    case 'week':
    case 'sonnet_week':
      return 10080;
  }
}

function parseDateValue(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value);
  }

  if (typeof value === 'string') {
    const numeric = Number(value);
    if (!Number.isNaN(numeric)) {
      return parseDateValue(numeric);
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function renderUsageBar(usedPercent: number): string {
  return renderBar(usedPercent, USAGE_BAR_LEN);
}

function renderCompactUsageBar(usedPercent: number): string {
  return renderBar(usedPercent, COMPACT_BAR_LEN, usedPercent > 0 ? 1 : 0);
}

function renderBar(usedPercent: number, length: number, minimumVisible = 0): string {
  const rounded = Math.round((usedPercent / 100) * length);
  const filled = Math.max(minimumVisible, Math.max(0, Math.min(length, rounded)));
  const color = getUsageColor(usedPercent);
  return color(FULL.repeat(filled)) + chalk.dim(EMPTY.repeat(length - filled));
}

function colorUsage(text: string, usedPercent: number): string {
  return getUsageColor(usedPercent)(text);
}

function getUsageColor(usedPercent: number): (text: string) => string {
  if (usedPercent >= 100) return chalk.red;
  if (usedPercent >= 80) return chalk.yellow;
  return chalk.cyan;
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatResetAt(date: Date): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const isWithinDay = (date.getTime() - now.getTime()) / 3600000 <= 24;
  const minutes = date.getMinutes();

  if (isWithinDay) {
    return `${date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: minutes === 0 ? undefined : '2-digit',
      hour12: true,
    })} (${timezone})`;
  }

  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: minutes === 0 ? undefined : '2-digit',
    hour12: true,
  };

  if (date.getFullYear() !== now.getFullYear()) {
    options.year = 'numeric';
  }

  return `${date.toLocaleString('en-US', options)} (${timezone})`;
}

function safeRealpathSync(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function safeStatSync(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}
