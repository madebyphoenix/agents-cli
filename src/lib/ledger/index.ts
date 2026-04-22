/**
 * Ledger module — shared substrate for cross-agent memory within a team.
 *
 * Use resolveLedger() in agents-cli code paths; it returns a LocalDiskLedger
 * by default. R2Ledger is constructed explicitly from env/config when the
 * cloud dispatch path opts in.
 */
import { LocalDiskLedger } from './local.js';
import { R2Ledger, r2ConfigFromEnv } from './r2.js';
import type { LedgerStore } from './types.js';

export type { LedgerStore, LedgerArtifact, LedgerTaskView, LedgerSearchHit, LedgerRegistry, ArtifactKind } from './types.js';
export { LocalDiskLedger } from './local.js';
export { R2Ledger, r2ConfigFromEnv } from './r2.js';
export type { R2LedgerConfig } from './r2.js';
export { syncTeammate, syncOnEviction } from './sync.js';
export type { TeammateSnapshot } from './sync.js';

let cachedDefault: LedgerStore | null = null;

/**
 * Return the default ledger for this CLI/MCP process.
 *
 * If AGENTS_R2_BUCKET is set, returns an R2Ledger wired to the configured
 * endpoint. Otherwise falls back to LocalDiskLedger at ~/.agents/ledger so
 * non-cloud workflows never require network access.
 */
export function resolveLedger(): LedgerStore {
  if (cachedDefault) return cachedDefault;
  const r2 = r2ConfigFromEnv();
  cachedDefault = r2 ? new R2Ledger(r2) : new LocalDiskLedger();
  return cachedDefault;
}

/** Test hook: reset the cached default so tests can inject a fresh root. */
export function resetLedgerCache(): void {
  cachedDefault = null;
}
