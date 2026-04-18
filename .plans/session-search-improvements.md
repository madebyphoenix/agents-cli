# Session Search Improvements Plan

## Current State

Session search is spread across five files totaling ~3,150 lines:

| File | Lines | Role |
|------|-------|------|
| `src/commands/sessions.ts` | 743 | CLI entry, filtering, scoring, rendering dispatch |
| `src/lib/session/discover.ts` | 1393 | Discovery, indexing, agent-specific scanners |
| `src/lib/session/parse.ts` | 641 | Format-specific parsers (Claude/Codex/Gemini/OpenCode) |
| `src/lib/session/render.ts` | 282 | Transcript / summary / trace / JSON output |
| `src/lib/session/prompt.ts` | 48 | Topic extraction from raw first user messages |

### Search Pipeline (End-to-End)

```
agents sessions [query]
  → discoverSessions()          discover.ts:64
      → discoverClaudeSessions()    discover.ts:367   (file walk)
      → discoverCodexSessions()     discover.ts:503   (file walk)
      → discoverGeminiSessions()    discover.ts:563   (file walk)
      → discoverOpenCodeSessions()  discover.ts:765   (sqlite3 subprocess)
      → discoverOpenClawSessions()  discover.ts:853   (CLI subprocess)
      → merge with persistent index                   discover.ts:83
      → buildContentIndex()                           discover.ts:207
      → saveContentIndex()                            discover.ts:242
      → apply --project / --since / --until / cwd
      → sort desc, slice to limit
  → filterSessionsByQuery()     sessions.ts:256
      → scoreSessionQuery()     sessions.ts:298   (metadata scoring)
      → searchContentIndex()    discover.ts:1355  (inverted index lookup)
      → combined sort + limit
  → render table or pick session
```

### Discovery: What Gets Indexed

`extractSessionTerms()` at `discover.ts:219` tokenizes these fields per session:
- `topic` (first user message, cleaned by `prompt.ts`)
- `project` (basename of cwd)
- `cwd` (full working directory path)
- `gitBranch`
- `account` (email or display name)
- `_userTerms` (tokenized terms from the first user message)

Tokenization (`discover.ts:230`): lowercase, split on non-alphanumeric, min 2 chars, deduplicated. No stemming, no stop words.

### Scoring Model

`scoreSessionQuery()` at `sessions.ts:298` scores each session against each query term using a flat priority ladder:

| Match type | Points |
|------------|--------|
| Exact ID | 1000 |
| ID prefix | 900 |
| Topic prefix | 700 |
| Project prefix | 600 |
| Account prefix | 550 |
| Agent/version prefix | 500 |
| Topic substring | 400 |
| Project substring | 300 |
| Account substring | 250 |
| CWD substring | 200 |
| Version/agent substring | 150 |
| No match | returns 0 immediately |

Multi-term queries accumulate scores additively. If metadata score is 0, falls back to content index match count.

### Content Index

Persisted at `~/.agents/sessions/content_index.jsonl` — one line per term: `{term, sessions: [id, ...]}`.

- **Built**: on every `discoverSessions()` call (`discover.ts:102-103`)
- **Loaded**: on every `filterSessionsByQuery()` call (`discover.ts:1359`)
- **Scope**: metadata fields only — not full message content

### Persistent Session Index

Persisted at `~/.agents/sessions/index.jsonl` — one line per `SessionMeta`.

- Survives session file deletion
- Loaded then re-written (full overwrite) on every discovery (`discover.ts:99`)
- Deduplication: first-occurrence wins (`discover.ts:190-194`)

### Storage Formats Per Agent

| Agent | Format | Path |
|-------|--------|------|
| Claude | JSONL (one event per line) | `~/.claude/projects/{key}/{uuid}.jsonl` |
| Codex | JSONL (one event per line) | `~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{ts}-{uuid}.jsonl` |
| Gemini | Single JSON array | `~/.gemini/tmp/{hash}/chats/session-{ts}-{uuid}.json` |
| OpenCode | SQLite `opencode.db` | `~/.local/share/opencode/opencode.db` |
| OpenClaw | Live CLI subprocess | No files — `openclaw channels status` / `openclaw cron list` |

---

## Strengths

### 1. Cross-agent normalization works
All five agents share the same `SessionMeta` type (`types.ts:21`) and render through the same pipeline. Adding a new agent requires only a new scanner function and a `switch` case in `discoverSessions()`.

### 2. Persistent index survives file deletion
The JSONL index at `~/.agents/sessions/index.jsonl` preserves metadata for sessions whose source files were removed or rotated. This is a real operational need for Codex's dated directory structure.

### 3. Metadata scoring is explicit and tunable
`scoreSessionQuery()` is a single, readable function with named priority levels. Easy to adjust without touching other code.

### 4. Content index provides fallback beyond metadata
When a query doesn't match structured fields, `searchContentIndex()` falls back to the inverted term index built from `_userTerms`. Covers cases like searching for a tool name or file path mentioned early in a session.

### 5. Multi-version deduplication
`getAgentSessionDirs()` (`discover.ts:284`) uses `safeRealpathSync` to deduplicate symlinked version homes before walking. Without this, every installed Claude version would double-count sessions.

### 6. OpenCode handled without file access
Using `sqlite3` subprocess (`discover.ts:774-802`) avoids native SQLite bindings in the npm package. Works on every platform that has `sqlite3` in PATH.

### 7. CWD scoping is the right default
Limiting discovery to the current project by default (`discover.ts:125-128`) means `agents sessions` in a repo only shows that repo's sessions. Correct zero-config behavior.

---

## Weaknesses

### 1. Content index rebuilt on every invocation — no incremental updates

`buildContentIndex()` is called unconditionally inside `discoverSessions()` at `discover.ts:102`. Every `agents sessions` invocation re-scans all sessions, re-tokenizes all fields, and overwrites the content index file. With 500+ sessions this takes seconds and adds disk I/O on every run.

There is no mtime check, no diff, no version stamp. The index is fully thrown away and rebuilt each time.

### 2. `searchContentIndex()` loads the full index from disk on every query

`sessions.ts:264` calls `searchContentIndex()` which calls `loadContentIndex()` at `discover.ts:1359`. This reads and parses the entire `content_index.jsonl` on every search, with no in-memory cache. If the content index grows to 10k terms × 500 sessions, this is a cold disk read per query.

### 3. Content index is shallow — only first user message is indexed

`extractSessionTerms()` at `discover.ts:219` indexes `_userTerms` (derived from the first user message) plus static metadata fields. Message content from the rest of the conversation — assistant responses, tool arguments, file paths written, bash commands run — is never indexed. A session that ran `git rebase -i main` cannot be found by searching "rebase".

### 4. Scoring does not distinguish multi-word query intent

Multi-term queries at `sessions.ts:263` split on whitespace and score each term independently, accumulating additively. The query "fix auth bug" scores the same as three separate unrelated matches for "fix", "auth", and "bug". There is no phrase boosting, no AND-must-match semantics, no way to require all terms to be present.

A query that matches every term in a session is indistinguishable at the scoring level from a query where each term hits a different low-relevance field.

### 5. `sessions.find()` in `searchContentIndex()` is O(n) per result

`discover.ts:1386`:
```typescript
const session = sessions.find(s => s.id === sessionId);
```

This linear scan runs inside a loop over all scored results. If there are 500 scored IDs and 500 sessions, this is 250,000 comparisons. Should be a pre-built `Map<id, SessionMeta>`.

### 6. Index full-overwrite is not atomic — corruption risk on interrupt

`saveIndex()` at `discover.ts:197` and `saveContentIndex()` at `discover.ts:249` write directly to the target file path with `fs.writeFileSync`. If the process is killed mid-write (Ctrl-C during discovery), the file is left truncated. Next run will fail to parse the partial JSON and lose the entire cache.

No write-to-temp-then-rename pattern is used.

### 7. `--since` / `--until` applied after full discovery and index rebuild

Time filters at `discover.ts:113-121` run after `buildContentIndex()` and `saveIndex()` at lines 102-103. The index is rebuilt for all sessions, including those outside the requested time range. With `--since 1d`, you still pay the full discovery cost.

### 8. OpenCode query truncates tool output at 2000 chars in SQL

`discover.ts:538`:
```sql
substr(p.data, 1, 2000)
```

This truncates `tool` parts at the SQL level. Combined with no full-text indexing of tool output, long bash output or large file writes are invisibly dropped. The caller has no way to know the data was cut.

### 9. Topic extraction is a single cleaned line — too lossy for search

`prompt.ts:46` returns only the first non-empty line after stripping XML tags and noise patterns. A session with the prompt:

```
Review the failing tests in the auth module and fix the root cause.
The test is in src/auth/login_test.go.
```

is indexed as `"Review the failing tests in the auth module and fix the root cause."` — the file path is lost. The `_userTerms` field preserves more, but only for content index fallback, not for the primary metadata score.

### 10. CWD matching uses exact equality — no subdirectory awareness

`discover.ts:127`:
```typescript
sessions = sessions.filter(s => normalizeCwd(s.cwd) === currentDir);
```

Running `agents sessions` from `/workspace/src/lib` will not show sessions started from `/workspace`, even though they're in the same project. The only workaround is `--all` which removes all scoping.

### 11. OpenClaw returns no transcript content

`discover.ts:888, 932` set `filePath` to empty string for OpenClaw sessions. `renderSession()` at `sessions.ts:131` checks `fs.existsSync(realPath)` and shows "Session file not found" for all OpenClaw view requests. OpenClaw sessions are list-only and cannot be viewed.

### 12. Scoring ladder uses prefix matching on `topic` but topic starts with cleaned noise

`cleanSessionPrompt()` at `prompt.ts:19` strips XML tags, metadata keys, and date strings. But topics often still begin with words like "You", "I", "Please", "Can you" — which get 700-point prefix matches for queries like "you" or "can". High-frequency words pollute prefix scoring.

### 13. No `--git-branch` filter

Git branch is captured in `SessionMeta.gitBranch` and indexed via `extractSessionTerms()`. But there is no `--git-branch <name>` flag. Branch is only searchable via the freetext query, where it competes with other fields and has no dedicated score tier.

---

## Proposed Improvements

Ranked by impact. Each item includes an effort estimate (S = half-day, M = 1-2 days, L = 3-5 days).

---

### P1 — Fix O(n) linear scan in `searchContentIndex()` [S]

**File**: `discover.ts:1384-1390`

Replace the `sessions.find()` loop with a pre-built `Map<string, SessionMeta>` passed into the function. This is a pure mechanical fix with no behavioral change and eliminates a quadratic hotspot.

```typescript
// Before (O(n) per scored result)
const session = sessions.find(s => s.id === sessionId);

// After: build once before the loop
const sessionMap = new Map(sessions.map(s => [s.id, s]));
const session = sessionMap.get(sessionId);
```

---

### P2 — Make index writes atomic [S]

**Files**: `discover.ts:186-201` (saveIndex), `discover.ts:242-251` (saveContentIndex)

Write to a `.tmp` file then `fs.renameSync` into place. `rename` is atomic on POSIX. Eliminates the corruption-on-interrupt risk with two lines of change per function.

---

### P3 — Add `--git-branch` filter flag [S]

**Files**: `sessions.ts:449-493` (registerSessionsCommands), `discover.ts:64` (DiscoverOptions)

Add `--git-branch <name>` as a CLI flag mirroring `--project`. Apply as a substring filter in `discoverSessions()` alongside the project filter. Also add a score tier between "account prefix" (550) and "agent prefix" (500) for branch matches in `scoreSessionQuery()`.

Branch is already captured and indexed — this just exposes it as a first-class filter.

---

### P4 — Cache content index in memory across a process lifetime [S]

**File**: `discover.ts:253-270` (loadContentIndex)

The content index is currently read from disk on every call to `searchContentIndex()`. Add a module-level `Map | null` variable initialized to `null`. On first call, load from disk and cache. Invalidate (set to `null`) only when `saveContentIndex()` is called. In a single `agents sessions` invocation this reduces disk reads from O(queries) to 1.

---

### P5 — Skip content index rebuild when sessions have not changed [M]

**File**: `discover.ts:101-103`

Before calling `buildContentIndex()`, compare the current set of session IDs + their timestamps against what was saved in the index (or a separate mtime stamp file). If nothing changed, skip the rebuild entirely.

Simplest implementation: store a hash of all `{id, timestamp}` pairs at the top of `content_index.jsonl`. On load, recompute the hash; if equal, skip rebuild.

---

### P6 — Require all query terms to match (AND semantics) [M]

**File**: `sessions.ts:266-295` (filterSessionsByQuery)

Currently a session passes the filter if *any* term scores above 0. A three-word query can match sessions that only contain one of the three words. Change the filter to require a non-zero score contribution from every term:

```typescript
// Before: any term match passes
if (entry.score > 0) return true;

// After: require all terms to contribute
const matchedTermCount = terms.filter(t => sessionMatchesTerm(session, t)).length;
if (matchedTermCount === terms.length) return true;
```

For content index fallback, require that `_matchedTerms.length === terms.length`.

This change makes multi-word queries precise. Single-word queries are unaffected.

---

### P7 — Extend topic/index to include assistant's first response summary [M]

**Files**: `discover.ts:219-228` (extractSessionTerms), agent scanners

When scanning Claude sessions, `scanClaudeSession()` already reads the first few lines. Extend the scan to also capture the first assistant text block (up to 300 chars). Store it in a new `SessionMeta.summary` field. Include it in `extractSessionTerms()` and display it as a second line in the summary view.

This doubles the indexed content per session with minimal overhead (still only reads the first portion of each file) and makes sessions findable by what the agent *did*, not just what the user asked.

---

### P8 — CWD filter: match parent directories [M]

**File**: `discover.ts:125-128`

Change exact CWD equality to prefix matching so that running `agents sessions` from `/workspace/src/lib` also shows sessions from `/workspace` and `/workspace/src`:

```typescript
// Before
sessions = sessions.filter(s => normalizeCwd(s.cwd) === currentDir);

// After: show sessions from this dir or any parent (up to repo root)
sessions = sessions.filter(s => {
  const sessionCwd = normalizeCwd(s.cwd);
  return sessionCwd === currentDir ||
         currentDir.startsWith(sessionCwd + '/') ||
         sessionCwd.startsWith(currentDir + '/');
});
```

The "or startsWith in reverse" case handles sessions started from a subdirectory of the current location.

---

### P9 — Apply time filters before building content index [M]

**File**: `discover.ts:64-138`

Reorder the discovery pipeline: apply `--since` / `--until` filtering immediately after merging the persistent index (line 99), before `buildContentIndex()` (line 102). This means the content index is built only for the sessions that will actually be returned, reducing index build time proportionally to the time window.

For `--since 7d` on a 2-year session history, this could reduce index build work by 95%.

---

### P10 — Full-text index of tool invocations [L]

**Files**: `discover.ts` (new scanner pass), `parse.ts`

The most requested "search" use case — "find the session where I ran that migration" or "which session touched auth.go" — requires indexing tool arguments and file paths, not just the opening user message.

Add a secondary index pass that reads the first N tool events from each session file and extracts:
- `Bash` command strings
- `Read`/`Write`/`Edit` file paths
- `WebFetch` URLs

Store these as additional `_toolTerms` in `SessionMeta`. Include in `extractSessionTerms()`. Add a new score tier (350 points, between topic substring and project prefix) for tool term matches.

Keep N bounded (e.g., first 50 tool events) to avoid re-reading entire session files during discovery.

---

### P11 — Phrase query support [L]

**File**: `sessions.ts:256-296` (filterSessionsByQuery), `discover.ts:1355-1393` (searchContentIndex)

Support quoted phrases in queries: `agents sessions view "fix auth bug"` should require the three words to appear adjacent in the topic or first message.

Implementation requires storing term positions in the content index (not just presence), and phrase-matching logic in the scoring layer. This is a structural change to the index format.

Defer until P6 (AND semantics) is in place — phrase search is a refinement of AND.

---

### P12 — Show matched terms in list output [M]

**File**: `sessions.ts:99-119` (list table rendering)

`SessionMeta._matchedTerms` is already populated by `searchContentIndex()` (`discover.ts:1388`) but is never shown to the user. When a search query is active, highlight the matched terms in the topic column (or add a "matched" column showing which fields were hit).

This makes it immediately obvious why a result appeared and helps users refine their queries.

---

## Summary Table

| # | Improvement | Impact | Effort | Risk |
|---|-------------|--------|--------|------|
| P1 | O(n) linear scan fix | Perf | S | None |
| P2 | Atomic index writes | Reliability | S | None |
| P3 | `--git-branch` filter | UX | S | Low |
| P4 | In-memory content index cache | Perf | S | Low |
| P5 | Skip index rebuild when unchanged | Perf | M | Low |
| P6 | AND semantics for multi-term queries | Search quality | M | Medium — changes existing behavior |
| P7 | Index assistant first response | Search coverage | M | Low |
| P8 | CWD prefix matching | UX | M | Low |
| P9 | Apply time filters before index build | Perf | M | Low |
| P10 | Full-text tool invocation index | Search coverage | L | Medium |
| P11 | Phrase query support | Search quality | L | High |
| P12 | Show matched terms in output | UX | M | Low |
