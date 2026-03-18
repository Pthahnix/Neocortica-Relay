# Teleport v2 — Full Pipeline Automation

## Problem

E2E testing revealed that teleport requires extensive manual setup to work:
- Pod needs CC CLI, Node.js, tmux, cc user, API credentials
- CC first-run wizard blocks automated resume
- Memory directory not transferred
- Resumed CC doesn't know it was teleported, blindly continues previous operations
- MSYS path conversion on Windows Git Bash corrupts remote paths
- `listSessions` fails silently when `sessions-index.json` doesn't exist

## Solution

Upgrade teleport from a transfer tool to a one-command deploy + transfer pipeline.

## Architecture

```
teleport.ts (orchestrator)
  ├── 1. preflight.ts    — MSYS guard, arg parsing, session lookup
  ├── 2. provision.ts    — remote env setup (cc user, CC CLI, Node.js, settings, API keys)
  ├── 3. transfer.ts     — pack (JSONL + memory), scp, unpack, path remap
  └── 4. launch.ts       — context injection (JSONL + CLAUDE.md), tmux start
```

Each stage is an independent module. `teleport.ts` orchestrates them sequentially.

## Module Details

### 1. Preflight (`src/cli/preflight.ts`)

Ensures local environment and parameters are ready before any remote operation.

**Responsibilities:**

1. **MSYS guard**: Detect `MSYS_SYSTEM` or `OSTYPE` containing `msys`, auto-set `process.env.MSYS_NO_PATHCONV = '1'`
2. **Arg parsing**: `host:port`, `--session`, `--project`, `--workspace`
3. **Session lookup**:
   - Prefer `--session` if provided
   - Otherwise read `sessions-index.json`
   - If index missing or empty → **fallback: scan `.jsonl` files by mtime, pick newest**
4. **Output**: `TeleportContext` object

```ts
interface TeleportContext {
  host: string
  port: number
  sessionId: string
  projectDir: string       // local project path
  workspaceDir: string     // remote workspace path
  sessionPath: string      // local JSONL file path
  memoryDir: string | null // local memory dir (may not exist)
  projectHash: string      // local project hash
  remoteHash: string       // remote project hash
}
```

**listSessions fallback** goes in `src/core/registry.ts` so MCP `session_list` also benefits.

### 2. Provision (`src/cli/provision.ts`)

Transforms a bare pod into a CC-ready environment. Idempotent — safe to run repeatedly.

**Detection** (skip if already provisioned):
```bash
ssh root@pod "id cc 2>/dev/null && su - cc -c 'claude --version' 2>/dev/null"
```
Both succeed → skip, print "Pod already provisioned".

**Steps** (executed as root via SSH):

1. Create cc user: `useradd -m -s /bin/bash cc && usermod -aG sudo cc`
2. Install CC CLI: `su - cc -c 'curl -fsSL https://claude.ai/install.sh | bash'`
3. Install Node.js 22 + tmux: `curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs git tmux`
4. Write CC settings to `/home/cc/.claude/settings.json`:
   ```json
   {
     "permissions": {
       "defaultMode": "bypassPermissions"
     }
   }
   ```
5. Write API env vars to `/home/cc/.bashrc`:
   - `ANTHROPIC_BASE_URL`
   - `ANTHROPIC_AUTH_TOKEN`
   - `ANTHROPIC_MODEL`
   - `PATH` with `$HOME/.local/bin`
6. Skip first-run wizard: write onboarding completion marker to `/home/cc/.claude/`
7. Copy SSH authorized_keys to cc user:
   ```bash
   mkdir -p /home/cc/.ssh && cp /root/.ssh/authorized_keys /home/cc/.ssh/ && chown -R cc:cc /home/cc/.ssh
   ```

**API credential source**: Read local `.env` file (project root). Parse `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`. Fallback to `process.env`. Error if none found.

**Post-provision**: All subsequent SSH operations use `cc@host` instead of `root@host`.

### 3. Transfer (`src/cli/transfer.ts`)

Packs local session data, transfers to remote, unpacks with path remapping.

**Archive contents** (upgraded from current):
```
archive.tar.gz
├── <sessionId>.jsonl
├── <sessionId>/           # session subdirectory (if exists)
└── memory/                # memory directory (if exists)
    ├── MEMORY.md
    └── *.md
```

Memory directory location: `~/.claude/projects/<projectHash>/memory/`
If memory dir doesn't exist or is empty, skip silently.

**Transfer**: `scp -P <port> archive.tar.gz cc@host:/tmp/neocortica-session.tar.gz`

**Remote unpack**:
```bash
tar xzf /tmp/neocortica-session.tar.gz --no-same-owner -C /tmp/neocortica-session-unpack
cp <sessionId>.jsonl → ~/.claude/projects/<remoteHash>/
cp <sessionId>/* → ~/.claude/projects/<remoteHash>/<sessionId>/
cp memory/* → ~/.claude/projects/<remoteHash>/memory/
```

Generate `sessions-index.json` with correct `fullPath` using `$HOME` expansion.

**Path remapping**: Apply to both JSONL and memory files (memory may reference local paths).

**Changes to existing code:**
- `src/core/packer.ts` — `packSession` adds memory directory
- `src/core/packer.ts` — `unpackSession` extracts memory directory
- Remote unpack commands add memory cp step

### 4. Launch (`src/cli/launch.ts`)

Injects context information and starts the resumed CC session.

**Context injection — two layers:**

1. **JSONL append**: Append a user message to the remote JSONL file:
   ```json
   {
     "type": "user",
     "message": {
       "role": "user",
       "content": "[Session Teleported]\nThis session was teleported to a new environment.\n- Previous workspace: D:\\NEOCORTICA-SESSION (Windows)\n- Current workspace: /workspace (Linux)\n- Previous operations are no longer relevant to this environment.\nAwait user instructions."
     },
     "uuid": "<generated>",
     "timestamp": "<now>",
     "sessionId": "<sessionId>",
     "version": "2.1.78"
   }
   ```
   Via SSH: `echo '<json>' >> <jsonl-path>`

2. **Remote CLAUDE.md**: Write/append to workspace CLAUDE.md:
   ```markdown
   # Teleported Session
   This session was teleported from another machine.
   - Source: D:\NEOCORTICA-SESSION (Windows)
   - Target: /workspace (Linux)
   - Do NOT continue previous tool calls or operations.
   - The local environment has changed. Await user instructions.
   ```
   If remote CLAUDE.md already exists, append. Otherwise create.

**tmux start**:
```bash
ssh cc@host "tmux new-session -d -s neocortica 'cd /workspace && claude --resume <sessionId>'"
```
Env vars already in `.bashrc`, sourced by bash in tmux.

**User output**:
```
Session teleported to pod. Connect:
  ssh -p <port> cc@<host>
  tmux attach -t neocortica
```

## Orchestrator Changes

`src/cli/teleport.ts` becomes a thin orchestrator:

```ts
async function teleport(args) {
  const ctx = await preflight(args)
  await provision(ctx)
  await transfer(ctx)
  await launch(ctx)
}
```

Existing `buildRemoteUnpackCommands` and inline logic move into the appropriate modules.

## Error Handling

Each module throws on failure. Orchestrator catches and reports which phase failed. No automatic cleanup (pod cleanup is Phase 7 in the skill SOP, handled by the calling CC).

## Testing

- `preflight.test.ts` — MSYS detection, session fallback scan, arg parsing
- `provision.test.ts` — idempotency check, command generation
- `transfer.test.ts` — archive contents verification (JSONL + memory), unpack commands
- `launch.test.ts` — JSONL message format, CLAUDE.md append logic
- `registry.test.ts` — listSessions fallback when index missing

## Files Changed

| File | Change |
|------|--------|
| `src/cli/teleport.ts` | Refactor to orchestrator calling 4 modules |
| `src/cli/preflight.ts` | New — MSYS guard, args, session lookup |
| `src/cli/provision.ts` | New — remote env setup |
| `src/cli/transfer.ts` | New — pack + scp + unpack |
| `src/cli/launch.ts` | New — context injection + tmux |
| `src/core/packer.ts` | Add memory dir to pack/unpack |
| `src/core/registry.ts` | Add listSessions fallback (scan .jsonl) |
| `src/core/types.ts` | Add TeleportContext interface |
