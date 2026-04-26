fix(security): prevent path-traversal in fs ops via safeJoin helper

## What changed

Added `src/lib/paths.ts` exporting `safeJoin(base, name)`, which:
1. Validates `name` against `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/` — rejects any segment containing `/`, starting with `.`, or using unusual characters.
2. Resolves the joined path and confirms it starts with `resolve(base) + sep` — a belt-and-suspenders containment check that catches any edge case the regex misses.

All user-supplied name arguments that feed into destructive or write filesystem operations now go through `safeJoin`:

| File | Functions patched |
|------|------------------|
| `src/commands/plugins.ts` | `plugins remove` — `pluginRoot` used in `fs.rmSync` |
| `src/lib/subagents.ts` | `installSubagentCentrally`, `removeSubagent`, `installSubagentToAgent`, `removeSubagentFromAgent` |
| `src/lib/routines.ts` | `readJob`, `writeJob`, `deleteJob`, `getJobPath` |
| `src/commands/routines.ts` | `routines edit` new-file creation path |
| `src/lib/permissions.ts` | `savePermissionSet`, `removePermissionSet` |

## Why

`path.join(baseDir, userSuppliedName)` with no validation allows `../` traversal. For example:
- `agents plugins remove ../../Documents` → `fs.rmSync('~/Documents', {recursive:true})`
- `agents routines edit ../../.ssh/config` → creates/overwrites `~/.ssh/config`
- `agents permissions remove ../../.bashrc` → `fs.unlinkSync('~/.bashrc')`

Severity: CRITICAL (arbitrary file deletion/overwrite with user privileges).

## How to test

```bash
# Should throw "Invalid name: ../../Documents"
agents plugins remove ../../Documents

# Should throw "Invalid name: ../secrets"
agents routines edit ../secrets

# Should throw "Invalid name: ../authorized_keys.yml" (after ext appended, regex fails)
agents permissions remove ../authorized_keys

# Normal names still work
agents routines edit daily-standup
agents plugins remove my-plugin
```
