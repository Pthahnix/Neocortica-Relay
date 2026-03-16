# neocortica-relay

Cross-device Claude Code agent coordination. A local MCP server dispatches experiment tasks to remote worker pods, tracks progress, and relays feedback — all through Claude Code's native tool interface.

## Architecture

```
┌──────────────────┐         HTTP          ┌──────────────────┐
│  Local Claude Code│◄──────────────────────►│  Worker (RunPod)  │
│                  │   HttpTransport        │                  │
│  MCP Server      │   Bearer token auth   │  Express Server   │
│  (stdio)         │   Retry + timeout     │  TaskExecutor     │
│                  │                       │  ProcessManager   │
│  9 tools         │                       │  7 endpoints      │
│  WorkerRegistry  │                       │  StateStore       │
│  TaskTracker     │                       │  File IPC         │
└──────────────────┘                       └──────────────────┘
```

Same codebase, two entry points:
- `npm run mcp` — Local MCP server (stdio), registers 9 tools for Claude Code
- `npm run worker` — Remote HTTP server on RunPod pods

## Quick Start

```bash
npm install

# Local side — add to Claude Code MCP config
npm run mcp

# Worker side — run on RunPod pod
RELAY_AUTH_TOKEN=your-secret npm run worker
```

### MCP Configuration

Add to your Claude Code `.mcp.json`:

```json
{
  "mcpServers": {
    "neocortica-relay": {
      "command": "npx",
      "args": ["tsx", "src/local/mcp_server.ts"],
      "cwd": "D:\\NEOCORTICA-RELAY",
      "env": {
        "RELAY_AUTH_TOKEN": "your-secret",
        "RELAY_DATA_DIR": "~/.neocortica-relay"
      }
    }
  }
}
```

## MCP Tools

### Worker Management

| Tool | Description |
|------|-------------|
| `worker_register` | Register a remote worker URL, health check before registering |
| `worker_unregister` | Remove a worker by ID |
| `worker_list` | List all registered workers with health status |

### Task Management

| Tool | Description |
|------|-------------|
| `task_dispatch` | Send experiment plan + checkpoints to a worker |
| `task_status` | Get current task status from worker |
| `task_report` | Get latest checkpoint report (awaiting approval) |
| `task_feedback` | Send feedback: continue / revise / abort |
| `task_files` | Download a file from worker experiment directory |
| `task_abort` | Abort a running task |

## Worker HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no auth) |
| POST | `/task` | Dispatch new task |
| GET | `/task/:id/status` | Task status |
| GET | `/task/:id/report` | Checkpoint report |
| POST | `/task/:id/feedback` | Send feedback |
| GET | `/task/:id/files/*filepath` | Download file |
| POST | `/task/:id/abort` | Abort task |

## Worker State Machine

```
idle → initializing → running ⇄ awaiting_approval → completed/failed/aborted
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_AUTH_TOKEN` | `""` | Bearer token for worker auth |
| `RELAY_DATA_DIR` | `~/.neocortica-relay` | Local persistence directory |
| `RELAY_PORT` | `7420` | Worker HTTP port |
| `RELAY_WORKSPACE` | `/workspace` | Worker workspace root |

## Testing

```bash
npm test                    # All 134 tests
npx tsx --test .test/e2e/   # E2E integration only
```

## Project Structure

```
src/
  shared/types.ts           # Shared types + validation
  worker/
    state_store.ts          # Task state persistence
    process_manager.ts      # CC subprocess lifecycle + file IPC
    task_executor.ts        # State machine orchestrator
    server.ts               # Express 5 HTTP server
  local/
    worker_registry.ts      # Worker connection management
    task_tracker.ts         # Local task state aggregation
    http_transport.ts       # HTTP client with retry/timeout
    mcp_server.ts           # MCP server entry point
    tools/                  # 9 MCP tool handlers
.test/                      # Mirror structure for tests
```

## License

[Apache-2.0](LICENSE)
