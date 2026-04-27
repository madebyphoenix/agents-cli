/**
 * Account rotation across agent versions.
 *
 * Detects which installed versions have expired credentials and rotates
 * authentication tokens so users maintain active sessions across version switches.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import type { AgentId, RunStrategy } from './types.js';
import { getAccountInfo, type AccountInfo } from './agents.js';
import { readMeta, writeMeta } from './state.js';
import { listInstalledVersions, getVersionHomePath, resolveVersion } from './versions.js';
import {
  getUsageInfoByIdentity,
  getUsageLookupKey,
  isClaudeAuthValid,
  type UsageSnapshot,
} from './usage.js';

export interface RotateCandidate {
  agent: AgentId;
  version: string;
  email: string | null;
  usageStatus: AccountInfo['usageStatus'];
  usageSnapshot: UsageSnapshot | null;
  authValid: boolean;
  lastActive: Date | null;
}

export interface RotateResult {
  /** The version picked for this run. */
  picked: RotateCandidate;
  /** Candidates that were considered healthy (including the picked one). */
  healthy: RotateCandidate[];
  /** Candidates excluded (not signed in, or out of credits). */
  excluded: RotateCandidate[];
}

export const RUN_STRATEGIES: RunStrategy[] = ['pinned', 'available', 'rotate'];

/** Return a run strategy when the input is valid, otherwise null. */
export function normalizeRunStrategy(value: unknown): RunStrategy | null {
  return typeof value === 'string' && RUN_STRATEGIES.includes(value as RunStrategy)
    ? value as RunStrategy
    : null;
}

/** Read project-local run strategy from the nearest agents.yaml, if present. */
export function getProjectRunStrategy(agent: AgentId, startPath: string): RunStrategy | null {
  let dir = path.resolve(startPath);
  const userAgentsYaml = path.join(os.homedir(), '.agents', 'agents.yaml');

  while (dir !== path.dirname(dir)) {
    const manifestPath = path.join(dir, 'agents.yaml');
    if (manifestPath !== userAgentsYaml && fs.existsSync(manifestPath)) {
      try {
        const parsed = yaml.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const strategy = normalizeRunStrategy(parsed?.run?.[agent]?.strategy);
        if (strategy) return strategy;
      } catch {
        // Ignore malformed project config and keep walking, matching version resolution.
      }
    }
    dir = path.dirname(dir);
  }

  return null;
}

/** Resolve the configured strategy: project agents.yaml, then ~/.agents/agents.yaml, then pinned. */
export function getConfiguredRunStrategy(agent: AgentId, startPath: string = process.cwd()): RunStrategy {
  return getProjectRunStrategy(agent, startPath)
    ?? normalizeRunStrategy(readMeta().run?.[agent]?.strategy)
    ?? 'pinned';
}

/** Persist the global run strategy used by bare `agents run <agent>`. */
export function setGlobalRunStrategy(agent: AgentId, strategy: RunStrategy): void {
  const meta = readMeta();
  if (!meta.run) meta.run = {};
  meta.run[agent] = { ...(meta.run[agent] ?? {}), strategy };
  writeMeta(meta);
}

function isRotationEligible(candidate: RotateCandidate): boolean {
  return !!candidate.email
    && candidate.authValid
    && hasUsageAvailable(candidate);
}

function isAvailableEligible(candidate: RotateCandidate): boolean {
  return !!candidate.email
    && candidate.authValid
    && hasUsageAvailable(candidate);
}

function hasUsageAvailable(candidate: RotateCandidate): boolean {
  if (candidate.usageStatus === 'out_of_credits' || candidate.usageStatus === 'rate_limited') {
    return false;
  }

  const usedPercent = getMaxUsedPercent(candidate.usageSnapshot);
  return usedPercent === null || usedPercent < 100;
}

function getMaxUsedPercent(snapshot: UsageSnapshot | null | undefined): number | null {
  if (!snapshot || snapshot.windows.length === 0) return null;
  return Math.max(...snapshot.windows.map((window) => window.usedPercent));
}

function compareCandidates(a: RotateCandidate, b: RotateCandidate): number {
  const au = getMaxUsedPercent(a.usageSnapshot);
  const bu = getMaxUsedPercent(b.usageSnapshot);

  if (au !== null || bu !== null) {
    if (au === null) return 1;
    if (bu === null) return -1;
    if (au !== bu) return au - bu;
  }

  const ta = a.lastActive ? a.lastActive.getTime() : 0;
  const tb = b.lastActive ? b.lastActive.getTime() : 0;
  if (ta !== tb) return ta - tb;
  return Math.random() - 0.5;
}

function dedupeAndSortCandidates(candidates: RotateCandidate[]): RotateCandidate[] {
  const byEmail = new Map<string, RotateCandidate>();
  for (const c of candidates) {
    const email = c.email!;
    const existing = byEmail.get(email);
    if (!existing) {
      byEmail.set(email, c);
      continue;
    }
    if (compareCandidates(c, existing) < 0) byEmail.set(email, c);
  }

  return [...byEmail.values()].sort(compareCandidates);
}

/**
 * Pure selection: given a set of candidates, return the best one for the
 * next run. Kept separate from I/O so it can be unit-tested with fixtures.
 *
 * Eligibility: signed in (email present) and not out of credits.
 * Dedupe: when multiple versions share an email (same Anthropic account
 * installed under several agent versions), collapse to one candidate per
 * email — the least-recently-active version. Without this, two parallel
 * pods could "rotate" to different versions but hit the same account and
 * both 429 against the same Anthropic quota.
 * Primary order: lowest live usage utilization wins. Least-recently-active is
 * the tie-breaker when usage is equal or unavailable. Never-used versions sort
 * oldest so fresh installs are tried before recently-used ones.
 * Tie-break: random — when two candidates share a `lastActive` timestamp
 * (common when N pods read the same snapshot), distribute across them so
 * parallel callers fan out instead of all picking the same version.
 */
export function pickRotateCandidate(candidates: RotateCandidate[]): RotateResult | null {
  const healthy: RotateCandidate[] = [];
  const excluded: RotateCandidate[] = [];
  for (const c of candidates) {
    if (!isRotationEligible(c)) {
      excluded.push(c);
      continue;
    }
    healthy.push(c);
  }

  if (healthy.length === 0) return null;

  const sorted = dedupeAndSortCandidates(healthy);
  const deduped = new Set(sorted);
  for (const c of healthy) {
    if (!deduped.has(c)) excluded.push(c);
  }

  return { picked: sorted[0], healthy: sorted, excluded };
}

/**
 * Pick an available candidate. Prefers the configured pinned version when that
 * version has usage available; otherwise routes to the candidate with the most
 * usage headroom.
 */
export function pickAvailableCandidate(
  candidates: RotateCandidate[],
  preferredVersion?: string | null,
): RotateResult | null {
  const healthy: RotateCandidate[] = [];
  const excluded: RotateCandidate[] = [];
  for (const c of candidates) {
    if (!isAvailableEligible(c)) {
      excluded.push(c);
      continue;
    }
    healthy.push(c);
  }

  if (healthy.length === 0) return null;

  const sorted = dedupeAndSortCandidates(healthy);
  const deduped = new Set(sorted);
  for (const c of healthy) {
    if (!deduped.has(c)) excluded.push(c);
  }

  const preferred = preferredVersion
    ? sorted.find((candidate) => candidate.version === preferredVersion)
    : undefined;
  return { picked: preferred ?? sorted[0], healthy: sorted, excluded };
}

async function collectRunCandidates(agent: AgentId): Promise<RotateCandidate[]> {
  const versions = listInstalledVersions(agent);
  const rows = await Promise.all(
    versions.map(async (version) => {
      const home = getVersionHomePath(agent, version);
      const info = await getAccountInfo(agent, home);
      const authValid = info.email
        ? agent === 'claude' ? await isClaudeAuthValid(home) : true
        : false;
      return {
        agent,
        version,
        home,
        info,
        email: info.email,
        usageStatus: info.usageStatus,
        authValid,
        lastActive: info.lastActive,
      };
    })
  );

  const { usageByKey } = await getUsageInfoByIdentity(
    rows.map(({ home, info, version }) => ({
      agentId: agent,
      home,
      cliVersion: version,
      info,
    }))
  );

  return rows.map(({ home: _home, info, ...candidate }) => {
    const usageKey = getUsageLookupKey(info);
    const usageSnapshot = usageKey
      ? usageByKey.get(usageKey)?.snapshot ?? null
      : null;
    return { ...candidate, usageSnapshot };
  });
}

/**
 * Rotate across installed versions of an agent and pick the best one for the
 * next run. "Best" means: signed in, usage available, and lowest usage
 * utilization, with least-recently-active as a tie-breaker.
 *
 * No external state: rotation and health are both read off per-version
 * AccountInfo — the same data `agents view` already surfaces. `lastActive`
 * advances naturally after each run, so the cursor is self-maintaining.
 *
 * Returns null if no installed version is eligible (either nothing installed
 * or every account is exhausted / not signed in). Callers fall back to the
 * global default so behavior stays predictable — we never refuse to run.
 */
export async function selectRotateVersion(agent: AgentId): Promise<RotateResult | null> {
  return pickRotateCandidate(await collectRunCandidates(agent));
}

/** Select the configured version if available, otherwise another available version. */
export async function selectAvailableVersion(
  agent: AgentId,
  preferredVersion?: string | null,
): Promise<RotateResult | null> {
  return pickAvailableCandidate(await collectRunCandidates(agent), preferredVersion);
}

/**
 * Resolve the version `agents run` should use when the caller did not pin
 * one with `@version`. The caller supplies the effective strategy; if that
 * strategy cannot find a usable candidate, fall back to the pinned
 * workspace/global version.
 */
export async function resolveRunVersion(agent: AgentId, strategy: RunStrategy, cwd: string = process.cwd()): Promise<{
  version: string | null;
  rotation: RotateResult | null;
}> {
  const fallback = resolveVersion(agent, cwd);
  if (strategy === 'pinned') {
    return { version: fallback, rotation: null };
  }

  const rotation = strategy === 'available'
    ? await selectAvailableVersion(agent, fallback)
    : await selectRotateVersion(agent);
  if (rotation) return { version: rotation.picked.version, rotation };

  return { version: fallback, rotation: null };
}
