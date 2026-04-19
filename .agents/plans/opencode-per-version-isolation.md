# Plan: Per-Version OpenCode Isolation via XDG Env Vars

## Problem

All installed OpenCode versions share a single SQLite database at
`~/.local/share/opencode/opencode.db` (currently ~75MB: 222 sessions, 2,888
messages, 4 projects, one `control_account`). One `auth.json` next to it at
`~/.local/share/opencode/auth.json` holds provider tokens for every version.

`agents use opencode@X.Y.Z` does **not** isolate any of this. Switching versions
exposes the same history, same credentials, and same active account across
every installed OpenCode.

Contrast with Claude, where `CLAUDE_CONFIG_DIR` (set by our shim) already gives
per-version isolation. OpenCode has no equivalent agent-specific env var — but
the binary natively respects the standard `XDG_DATA_HOME` and `XDG_CONFIG_HOME`
variables.

## Evidence (from the compiled binary)

```js
// In opencode-darwin-arm64/bin/opencode
xdgData   = env.XDG_DATA_HOME   || path.join(homeDir, '.local', 'share');
xdgConfig = env.XDG_CONFIG_HOME || path.join(homeDir, '.config');

const sqlite = new BunDatabase(
  path.join(Global.Path.data, 'opencode.db'),
  { create: true }
);
```

`Global.Path.data` resolves to `$XDG_DATA_HOME/opencode`. Override the env var
and everything follows — DB, auth.json, bin cache, snapshots, logs, storage.

No NODE_OPTIONS require-hook needed. Plain env vars.

## What lives where today

| Data | Current path | Contents |
|---|---|---|
| SQLite DB | `~/.local/share/opencode/opencode.db` | sessions, messages, projects, permissions, todos, control_account |
| Auth tokens | `~/.local/share/opencode/auth.json` | provider API keys (zai, openrouter, …) |
| Binaries, logs, snapshots | `~/.local/share/opencode/{bin,log,snapshot,storage,tool-output}/` | downloaded LSPs, session snapshots, tool output |
| Config | `~/.config/opencode/` | config file(s), if present |
| Project config | `./.opencode/` and `~/.opencode/` | AGENTS.md, opencode.jsonc, commands, skills |

Project-level `.opencode/` directories (in a repo, or at `~/.opencode/` as a
global project dir) are **not** per-version and should stay shared. Only the
data/config dirs get redirected.

## Plan (6 steps)

### 1. Add an `envVars` field to `AgentConfig`

**File:** `src/lib/types.ts`

Add:
```ts
export interface AgentConfig {
  // …existing fields
  /** Env vars the shim should export, with `{versionHome}` templating. */
  envVars?: Record<string, string>;
}
```

**File:** `src/lib/agents.ts`

```ts
claude: {
  // …
  envVars: { CLAUDE_CONFIG_DIR: '{versionHome}/.claude' },
},
opencode: {
  // …
  envVars: {
    XDG_DATA_HOME:   '{versionHome}/.local/share',
    XDG_CONFIG_HOME: '{versionHome}/.config',
    XDG_CACHE_HOME:  '{versionHome}/.cache',
  },
},
```

Moves the hard-coded `export CLAUDE_CONFIG_DIR` in the shim to a declarative
per-agent config. Future agents that need env-var-based isolation just declare
it.

### 2. Update shim generation

**File:** `src/lib/shims.ts` — the shim template.

Replace the Claude-specific block:
```bash
# Claude stores OAuth credentials in the macOS keychain. Scope them to the
# selected version's config directory…
export CLAUDE_CONFIG_DIR="$VERSION_DIR/home/.claude"
```

with a generic emission loop driven by `AgentConfig.envVars`:
```bash
# Per-agent env vars (expanded from AgentConfig.envVars)
export CLAUDE_CONFIG_DIR="$VERSION_DIR/home/.claude"              # for claude shim
export XDG_DATA_HOME="$VERSION_DIR/home/.local/share"             # for opencode shim
export XDG_CONFIG_HOME="$VERSION_DIR/home/.config"
export XDG_CACHE_HOME="$VERSION_DIR/home/.cache"
```

Generator substitutes `{versionHome}` → `"$VERSION_DIR/home"` at shim-write
time. Existing Claude shims produce the same output as today (no behaviour
change). OpenCode shims gain the XDG exports.

### 3. Update session discovery

**File:** `src/lib/session/discover.ts`

Line 601 currently hard-codes:
```ts
const OPENCODE_DB = path.join(HOME, '.local', 'share', 'opencode', 'opencode.db');
```

Replace with a helper that walks all candidate DB paths:
```ts
function getOpenCodeDbPaths(): string[] {
  const paths = [path.join(HOME, '.local', 'share', 'opencode', 'opencode.db')];
  const versionsBase = path.join(AGENTS_DIR, 'versions', 'opencode');
  if (fs.existsSync(versionsBase)) {
    for (const ver of fs.readdirSync(versionsBase)) {
      paths.push(path.join(versionsBase, ver, 'home', '.local', 'share', 'opencode', 'opencode.db'));
    }
  }
  return paths.filter(fs.existsSync);
}
```

`discoverOpenCodeSessions` queries each DB and dedupes sessions by id.

### 4. Update account detection

**File:** `src/lib/session/discover.ts` — `getOpenCodeAccount`.

Same pattern as the Claude fix landed earlier: build the candidate list of
per-version DBs, query each for `SELECT email FROM control_account WHERE active=1 LIMIT 1`,
return the first hit. Cache once.

Keep the legacy path (`~/.local/share/opencode/opencode.db`) as the last
fallback so users who don't migrate keep seeing their data.

### 5. First-use migration (optional but recommended)

On first `agents use opencode@X.Y.Z` after the shim gains XDG vars:

- If `~/.local/share/opencode/opencode.db` exists **and** the target version's
  per-version DB does not, copy the legacy DB to the version home. Same for
  `auth.json`.
- Subsequent versions start empty and require a fresh login — same tradeoff as
  Claude, no surprise.

Alternative: do the copy at `agents add opencode@…` time so a fresh install
inherits the currently-active account by default. Cleaner UX, more bytes on
disk.

Recommendation: implement both. Copy at `add` time if the legacy DB exists and
the target version's DB doesn't. Idempotent, safe.

### 6. Verify & document

End-to-end verification:

1. `agents add opencode@1.2.6` — shim now sets XDG; running `opencode` once
   creates `~/.agents/versions/opencode/1.2.6/home/.local/share/opencode/opencode.db`.
2. `opencode auth login` — credentials written to per-version `auth.json`.
3. `agents use opencode@1.0.204` — different DB, different auth.
4. `opencode auth list` on each version shows only that version's creds.
5. `agents sessions list --agent opencode` — sees sessions from both per-version
   DBs and the legacy DB (deduped by id).
6. `agents view` — OpenCode block shows correct per-version account, no false
   `(not signed in)` labels.

Docs: add one sentence to `docs/02-resource-sync.md` noting OpenCode is
isolated via XDG, Claude via CLAUDE_CONFIG_DIR.

## Non-goals

- Retroactive re-partitioning of the existing 75MB DB by version. Existing
  sessions stay where they are and show up as legacy; new sessions go
  per-version.
- OpenCode cross-machine sync (separate problem — drive-sync already covers
  config, not data).
- Isolating project-level `.opencode/` directories — intentionally shared
  across versions because they're keyed to the repo, not the CLI.

## Acceptance criteria

1. Two OpenCode versions installed. Log in to version A with account X. Switch
   to version B. `opencode auth list` on B shows B's credentials only. Log in
   to B with account Y. Switch back to A. A still reports account X.
2. `agents view` shows the correct account per OpenCode version (no
   cross-contamination, no false `(not signed in)` labels for versions that
   have been used).
3. `agents sessions list --agent opencode` returns sessions from every
   per-version DB plus the legacy one, deduped.
4. Non-OpenCode subprocesses spawned by `opencode` (shell, git, …) still see
   the real `~/.local/share/` — XDG is set only for the OpenCode child, via the
   shim, not exported in the user's shell.

## Related work

- Claude's fix (landed in this series of changes): `src/lib/agents.ts`
  `getAccountInfo` and `src/lib/session/discover.ts` `getClaudeAccount` now
  prefer `$CLAUDE_CONFIG_DIR/.claude.json` and fall back to the home-level
  legacy file. Same pattern here.
- Shim generator: `src/lib/shims.ts` — will gain the generic env-var emission
  loop.
- Legacy `homeFiles` / `switchHomeFileSymlinks` mechanism (shims.ts:557) stays
  in place for Claude as a safety net; OpenCode does not need it.

## Estimate

4–6 hours. Mostly plumbing:

- Types + config: 30 min
- Shim generator: 1 h (including regenerating existing shims on `agents use`)
- Discover + account detection: 1 h
- Migration copy: 1 h
- Verification with two versions and two accounts: 1–2 h
