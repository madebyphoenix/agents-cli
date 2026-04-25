/**
 * Account rotation across agent versions.
 *
 * Detects which installed versions have expired credentials and rotates
 * authentication tokens so users maintain active sessions across version switches.
 */

import type { AgentId } from './types.js';
import { getAccountInfo, type AccountInfo } from './agents.js';
import { listInstalledVersions, getVersionHomePath, getGlobalDefault } from './versions.js';
import { isClaudeAuthValid } from './usage.js';

export interface RotateCandidate {
  agent: AgentId;
  version: string;
  email: string | null;
  usageStatus: AccountInfo['usageStatus'];
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
 * Primary order: least-recently-active wins. Never-used versions sort oldest
 * so fresh installs are tried before recently-used ones.
 * Tie-break: random — when two candidates share a `lastActive` timestamp
 * (common when N pods read the same snapshot), distribute across them so
 * parallel callers fan out instead of all picking the same version.
 */
export function pickRotateCandidate(candidates: RotateCandidate[]): RotateResult | null {
  const healthy: RotateCandidate[] = [];
  const excluded: RotateCandidate[] = [];
  for (const c of candidates) {
    if (!c.email) {
      excluded.push(c);
      continue;
    }
    if (c.usageStatus === 'out_of_credits') {
      excluded.push(c);
      continue;
    }
    if (!c.authValid) {
      excluded.push(c);
      continue;
    }
    healthy.push(c);
  }

  if (healthy.length === 0) return null;

  const byEmail = new Map<string, RotateCandidate>();
  for (const c of healthy) {
    const email = c.email!;
    const existing = byEmail.get(email);
    if (!existing) {
      byEmail.set(email, c);
      continue;
    }
    const tc = c.lastActive ? c.lastActive.getTime() : 0;
    const te = existing.lastActive ? existing.lastActive.getTime() : 0;
    if (tc < te) byEmail.set(email, c);
  }
  const deduped = [...byEmail.values()];
  for (const c of healthy) {
    if (byEmail.get(c.email!) !== c) excluded.push(c);
  }

  const sorted = deduped.sort((a, b) => {
    const ta = a.lastActive ? a.lastActive.getTime() : 0;
    const tb = b.lastActive ? b.lastActive.getTime() : 0;
    if (ta !== tb) return ta - tb;
    return Math.random() - 0.5;
  });

  return { picked: sorted[0], healthy: sorted, excluded };
}

/**
 * Rotate across installed versions of an agent and pick the best one for the
 * next run. "Best" means: signed in, not out of credits, and least-recently-
 * active (so two back-to-back runs hit different accounts automatically).
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
  const versions = listInstalledVersions(agent);
  if (versions.length === 0) return null;

  const candidates: RotateCandidate[] = await Promise.all(
    versions.map(async (version) => {
      const home = getVersionHomePath(agent, version);
      const info = await getAccountInfo(agent, home);
      const authValid = info.email
        ? agent === 'claude' ? await isClaudeAuthValid(home) : true
        : false;
      return {
        agent,
        version,
        email: info.email,
        usageStatus: info.usageStatus,
        authValid,
        lastActive: info.lastActive,
      };
    })
  );

  return pickRotateCandidate(candidates);
}

/**
 * Resolve the version `agents run` should use when the caller did not pin
 * one with `@version`. Rotation is the default; falls back to the global
 * default if no version is healthy, and to null if the agent isn't installed
 * under agents-cli at all (let exec surface its own error).
 */
export async function resolveRunVersion(agent: AgentId): Promise<{
  version: string | null;
  rotation: RotateResult | null;
}> {
  const rotation = await selectRotateVersion(agent);
  if (rotation) {
    return { version: rotation.picked.version, rotation };
  }
  const fallback = getGlobalDefault(agent);
  return { version: fallback, rotation: null };
}
