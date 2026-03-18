# Neocortica-Session

CC session sharing for distributed experiment execution. Export a Claude Code session (with full research context from Stages 1-4), transfer it to a remote GPU pod, resume it there, and return results.

Inspired by [cc-go-on](https://github.com/Johnixr/cc-go-on).

## Architecture

```
┌──────────────────────────────────────────────────────┐
│ MCP Server (stdio)         — local session ops       │
│   session_export           → pack session as tar.gz  │
│   session_import           → unpack + remap + register│
│   session_list             → list sessions for project│
├──────────────────────────────────────────────────────┤
│ Core                       — shared logic            │
│   packer                   → pack/unpack archives    │
│   remapper                 → cross-platform paths    │
│   registry                 → sessions-index.json CRUD│
│   types                    → SessionMeta, hash       │
├──────────────────────────────────────────────────────┤
│ CLI                        — remote pod operations   │
│   teleport                 → scp + unpack + tmux     │
│   return                   → remote pack + scp back  │
├──────────────────────────────────────────────────────┤
│ Skill SOP                  — full lifecycle          │
│   session-teleport.md      → 7-phase pod orchestration│
└──────────────────────────────────────────────────────┘
```

## Quick Start

```bash
npm install
```

### MCP Server Configuration

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "neocortica-session": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "/path/to/Neocortica-Session"
    }
  }
}
```

### CLI Usage

**Teleport** a session to a remote pod:
```bash
npx tsx src/cli/teleport.ts root@10.0.0.1:22222
npx tsx src/cli/teleport.ts root@10.0.0.1:22222 --session <session-id> --project /my/project
```

**Return** a session from a pod:
```bash
npx tsx src/cli/return.ts root@10.0.0.1:22222
```

## User Experience

```
Local CC (research complete) → Export session → Transfer to GPU pod
  → Remote CC resumes with full context → Run experiment
    → Return session → Local CC imports results
```

1. User completes Stages 1-4 of research locally
2. Session teleport creates a pod, exports session, transfers it
3. User SSH + `tmux attach` to interact with CC on the pod
4. When done, session return brings results back
5. Pod is cleaned up automatically

## Testing

```bash
npx tsx --test .test/**/*.test.ts
```

## License

[Apache-2.0 License](LICENSE)
