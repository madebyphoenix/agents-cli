import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionMeta, TeamOrigin } from './types.js';
import { HEADLESS_PLAN_MODE_PREFIX } from './prompt.js';

const HOME = os.homedir();

// Default path; tests can override via AGENTS_TEAMS_DIR env var.
function teamsAgentsDir(): string {
  return process.env.AGENTS_TEAMS_DIR ?? path.join(HOME, '.agents', 'teams', 'agents');
}

/**
 * Determine whether `session` was spawned by `agents teams`.
 *
 * Two signals checked in order:
 *  1. Exact: `~/.agents/teams/agents/<session-id>/meta.json` exists.
 *  2. Fallback: the stored topic begins with the HEADLESS PLAN MODE prefix
 *     (covers sessions whose meta.json was cleaned up or removed).
 *
 * Returns the TeamOrigin metadata when the session is team-origin, or null
 * when it is a normal interactive session.
 */
export function classifyTeamSession(session: SessionMeta): TeamOrigin | null {
  const metaPath = path.join(teamsAgentsDir(), session.id, 'meta.json');

  if (fs.existsSync(metaPath)) {
    try {
      const raw = fs.readFileSync(metaPath, 'utf-8');
      const meta = JSON.parse(raw) as Record<string, unknown>;
      const name = typeof meta.name === 'string' && meta.name ? meta.name : undefined;
      const handle = name ?? session.id.slice(0, 8);
      const mode = typeof meta.mode === 'string' ? meta.mode : undefined;
      return { handle, mode };
    } catch {
      return { handle: session.id.slice(0, 8) };
    }
  }

  // Fallback: topic stored before extractSessionTopic was fixed still contains
  // the raw prefix line as the first line of text.
  if (session.topic?.startsWith(HEADLESS_PLAN_MODE_PREFIX)) {
    return {};
  }

  return null;
}

export interface FilterResult {
  visible: SessionMeta[];
  hiddenCount: number;
}

/**
 * Split `sessions` into visible and hidden (team-origin) groups.
 * When `showTeams` is true every session is visible and `teamOrigin` is
 * populated on team sessions for display. When false, team sessions are
 * excluded and counted in `hiddenCount`.
 */
export function filterTeamSessions(
  sessions: SessionMeta[],
  showTeams: boolean,
): FilterResult {
  let hiddenCount = 0;
  const visible: SessionMeta[] = [];

  for (const session of sessions) {
    const origin = classifyTeamSession(session);
    if (origin !== null) {
      if (showTeams) {
        visible.push({ ...session, teamOrigin: origin });
      } else {
        hiddenCount++;
      }
    } else {
      visible.push(session);
    }
  }

  return { visible, hiddenCount };
}
