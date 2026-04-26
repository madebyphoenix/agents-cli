fix(security): migrate shell-exec sites to execFile (RUSH-554)

## What changed

Replaced all `exec`/`execAsync` call sites that built command strings via
template-literal interpolation with `execFile`/`execFileAsync`, passing
arguments as arrays. No shell is involved, so user-controlled values (MCP
server names, remote hosts, binary paths, package specs) are passed as
literal argv entries and cannot escape into shell metacharacter injection.

### Files modified

- **`src/lib/agents.ts`** — primary fix
  - `getCliVersion` (line 370): `${agent.cliCommand} --version` → `execFileAsync(cliCommand, ['--version'])`
  - `isMcpRegistered` (line 753): `${agent.cliCommand} mcp list` → `execFileAsync(cliCommand, ['mcp', 'list'])`
  - `registerMcp` (lines 783–789): template-literal `cmd` string replaced with explicit argv array; `command` string split on whitespace into tokens and spread after `--`
  - `unregisterMcp` (line 813): `"${name}"` shell quoting replaced with `execFileAsync(bin, ['mcp', 'remove', name])`

- **`src/lib/drive-sync.ts`** — rsync + ssh calls
  - `pull`: rsync template → `execFileAsync('rsync', ['-az', '--exclude=config.json', remote, localDir])`
  - `push`: ssh mkdir template → `execFileAsync('ssh', [remote, 'mkdir -p ~/.agents/drive'])`; rsync template → `execFileAsync('rsync', [...])`

- **`src/lib/versions.ts`** — npm calls + binary version check
  - `getLatestNpmVersion`: `npm view ${pkg} version` → `execFileAsync('npm', ['view', pkg, 'version'])`
  - `installVersion`: `npm install ${spec}` → `execFileAsync('npm', ['install', spec], { cwd })`
  - `getInstalledVersion`: `${binaryPath} --version` → `execFileAsync(binaryPath, ['--version'])`

- **`src/commands/fork.ts`** — gh CLI call
  - `gh repo fork ${repoSlug} --clone=false` → `execFileAsync('gh', ['repo', 'fork', repoSlug, '--clone=false'])`

- **`tests/agents.test.ts`** — regression test
  - New test: calls `registerMcp('claude', '"; touch /tmp/pwn_RUSH554 #', ...)` with `/bin/echo` as the binary and asserts `/tmp/pwn_RUSH554` does not exist after the call.

## Why

`exec` runs commands through `/bin/sh -c`. Any template-literal interpolation
is shell-parsed, so a value like `"; touch /tmp/pwn #` in an MCP server name
would break out of the surrounding double-quotes and run arbitrary commands.
`execFile` bypasses the shell entirely — each argument is a verbatim string
handed to the OS `execve` syscall.

Closes RUSH-554.

## How to test

```bash
npm run build
npm test -- tests/agents.test.ts
```

The new regression test (`registerMcp - shell injection prevention`) should
pass. It would fail on the old `exec`-based code because `/tmp/pwn_RUSH554`
would be created by the injected `touch` command.
