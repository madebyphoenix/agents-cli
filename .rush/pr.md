fix(deps): bump simple-git, yaml, smol-toml + audit fix transitive (RUSH-556)

## What changed

Bumped three direct dependencies to eliminate critical and high-severity CVEs, then ran `npm audit fix` to clear all remaining fixable transitive issues.

| Package | Before | After | Severity | Advisories |
|---|---|---|---|---|
| `simple-git` | `^3.27.0` | `^3.36.0` | **CRITICAL** | GHSA-jcxm-m3jx-f287, GHSA-r275-fr43-pm7q |
| `yaml` | `^2.6.0` | `^2.8.3` | HIGH | GHSA-48c2-rrv3-qjmp |
| `smol-toml` | `^1.6.0` | `^1.6.1` | MODERATE | stack overflow on malformed TOML |

Transitive packages fixed via `npm audit fix` (non-breaking): `@hono/node-server`, `hono`, `path-to-regexp`, `express-rate-limit`, `rollup`, `ajv`, `qs`, `postcss`.

## What was NOT changed

- `diff` — fix requires `9.0.0` (breaking). Low severity. Tracked separately.
- `vitest`/`vite`/`esbuild` — fix requires `vitest@4.x` (breaking). Dev-only, moderate severity. Tracked separately.

## Why it matters

The `simple-git` RCE (GHSA-r275-fr43-pm7q) is reachable via `agents install gh:<user>/<repo>` — user-supplied input flows into `cloneRepo()` in `src/lib/git.ts:219` with the vulnerable option-parsing bypass. The `yaml` stack-overflow hits `src/lib/manifest.ts:17` where user-controlled `agents.yaml` is parsed.

## How to test

```bash
# Confirm installed versions
node -e "console.log(require('./node_modules/simple-git/package.json').version)"  # 3.36.0
node -e "console.log(require('./node_modules/yaml/package.json').version)"         # 2.8.3
node -e "console.log(require('./node_modules/smol-toml/package.json').version)"    # 1.6.1

# Confirm no critical/high advisories remain
npm audit

# Smoke test install and clone flows
agents install --help
```
