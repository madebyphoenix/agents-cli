fix(security): add safeJoin() to block path traversal in fs ops

## What changed

Introduced `src/lib/paths.ts` with a `safeJoin(base, name)` helper that:

1. Rejects names not matching `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$` (no slashes, no `..`, no leading dots).
2. Resolves the joined path and verifies it still lives under `base` (defense-in-depth against any future bypass).

Routed every user-named filesystem operation through `safeJoin`:

| File | Operations protected |
|---|---|
| `src/commands/plugins.ts` | `plugins remove` — `fs.rmSync` on plugin root |
| `src/lib/subagents.ts` | `installSubagentCentrally`, `removeSubagent`, `installSubagentToAgent`, `removeSubagentFromAgent` — `fs.rmSync` / `fs.cpSync` / `fs.writeFileSync` / `fs.unlinkSync` |
| `src/lib/routines.ts` | `readJob`, `writeJob`, `deleteJob`, `getJobPath` — YAML read/write/delete under `~/.agents/routines/` |
| `src/commands/routines.ts` | `routines edit` — template `fs.writeFileSync` on new job file |
| `src/lib/permissions.ts` | `savePermissionSet`, `removePermissionSet` — `fs.writeFileSync` / `fs.unlinkSync` under `~/.agents/permissions/groups/` |

## Why

`path.join(baseDir, userInput)` without validation allows `../` traversal. For example:

```
agents plugins remove ../../Documents
```

…would call `fs.rmSync(~/Documents, { recursive: true })`, wiping an arbitrary directory. Same class of bug existed in subagent, routine, and permission commands.

## How to test

```bash
# Should throw "Invalid name"
agents plugins remove '../../Documents'
agents subagents remove '../../../etc/passwd'
agents routines remove '../../sensitive'
agents permissions remove '../../../../home'

# Normal names should still work
agents plugins remove my-plugin
agents routines remove my-job
```

Closes RUSH-555.
