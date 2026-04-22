/**
 * DAG supervisor — the continuous dispatch loop that makes the Factory
 * dynamic.
 *
 * `teams start --watch` and `factory run` both use this. Each wave:
 *   1. call startReady(team) to fire any now-ready teammates
 *   2. listByTask(team) to count pending / running / done / failed
 *   3. emit one status event (via the caller's callback)
 *   4. exit when pending + running == 0 (DAG drained)
 *
 * Why a shared function:
 *  - the loop is the orchestration, the thing that lets any worker add
 *    tasks mid-flight via `agents teams add` and have them picked up
 *  - `factory run` is just `teams start --watch` with factory-flavored
 *    presentation; keeping them in sync avoids drift
 *
 * The caller supplies a presenter callback so the same loop can drive
 * terminal output, json-per-wave output, or a TUI.
 */
import type { AgentManager, AgentProcess } from './agents.js';

export interface WaveSummary {
  wave: number;
  timestamp: string;
  team: string;
  launched: AgentProcess[];
  pending: number;
  running: number;
  completed: number;
  failed: number;
  drained: boolean;
}

export interface SupervisorOptions {
  team: string;
  intervalMs?: number;
  maxWaves?: number;
  /** Called once per wave. Return false to stop the loop gracefully. */
  onWave: (summary: WaveSummary) => void | Promise<void> | boolean | Promise<boolean>;
}

export interface SupervisorResult {
  waves: number;
  stoppedBy: 'drained' | 'max-waves' | 'signal' | 'callback';
  elapsed_ms: number;
}

/**
 * Run the continuous DAG dispatcher until the team drains, the caller
 * returns false from onWave, or SIGINT/SIGTERM arrives.
 */
export async function runSupervisor(
  mgr: AgentManager,
  opts: SupervisorOptions
): Promise<SupervisorResult> {
  const intervalMs = opts.intervalMs ?? 8000;
  const maxWaves = opts.maxWaves ?? 1000;
  const team = opts.team;
  const startedAt = Date.now();

  let stopSignal = false;
  const onSig = () => { stopSignal = true; };
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);

  try {
    for (let wave = 1; wave <= maxWaves; wave++) {
      // Pick up teammates added by other processes (e.g. the Planner's
      // `agents teams add` calls). Without this the supervisor only ever
      // sees teammates it created itself.
      await mgr.rescanFromDisk();
      const launched = await mgr.startReady(team);
      const all = await mgr.listByTask(team);
      let pending = 0, running = 0, completed = 0, failed = 0;
      for (const a of all) {
        if (a.status === 'pending') pending++;
        else if (a.status === 'running') running++;
        else if (a.status === 'completed') completed++;
        else if (a.status === 'failed') failed++;
      }
      const summary: WaveSummary = {
        wave,
        timestamp: new Date().toISOString(),
        team,
        launched,
        pending,
        running,
        completed,
        failed,
        drained: pending === 0 && running === 0,
      };

      const keepGoing = await opts.onWave(summary);
      if (keepGoing === false) {
        return { waves: wave, stoppedBy: 'callback', elapsed_ms: Date.now() - startedAt };
      }

      // Re-check drain AFTER the callback. The callback may have added new
      // teammates mid-flight (that's the whole point of the dynamic DAG), so
      // trusting the pre-callback snapshot would drain prematurely. Rescan
      // too, because the callback could have triggered a sibling process
      // that wrote a fresh meta.json.
      await mgr.rescanFromDisk();
      const afterCallback = await mgr.listByTask(team);
      const stillLive = afterCallback.some(
        (a) => a.status === 'pending' || a.status === 'running'
      );
      if (!stillLive) {
        return { waves: wave, stoppedBy: 'drained', elapsed_ms: Date.now() - startedAt };
      }
      if (stopSignal) {
        return { waves: wave, stoppedBy: 'signal', elapsed_ms: Date.now() - startedAt };
      }
      await new Promise((r) => setTimeout(r, intervalMs));
      if (stopSignal) {
        return { waves: wave, stoppedBy: 'signal', elapsed_ms: Date.now() - startedAt };
      }
    }
    return { waves: maxWaves, stoppedBy: 'max-waves', elapsed_ms: Date.now() - startedAt };
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }
}
