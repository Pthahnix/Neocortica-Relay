# Worker Provisioning & Task Execution

End-to-end SOP for provisioning a RunPod pod, deploying the relay worker, executing a task, and cleaning up.

## Prerequisites

- RunPod MCP server configured and available
- neocortica-relay MCP server configured and available
- User's Anthropic API credentials (base URL, auth token, model)

## Phase 1: Create Pod

Use RunPod MCP `create-pod`:

```
create-pod:
  name: "relay-worker-<purpose>"
  gpuTypeIds: ["NVIDIA GeForce RTX 3090"]  # or user-specified
  imageName: "runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04"
  containerDiskInGb: 20
  volumeInGb: 0
  ports: ["8080/http", "22/tcp"]
  cloudType: "COMMUNITY"  # cheaper, use SECURE if user requests
```

Wait for pod status to become `RUNNING`. Note the pod ID.

## Phase 2: Provision Worker Environment

The pod needs: cc user, Claude CLI, Node.js 22, neocortica-relay code, worker server running.

Execute via SSH (RunPod provides SSH access or web terminal). Run these commands sequentially on the pod:

```bash
# 1. Create cc user
useradd -m -s /bin/bash cc
usermod -aG sudo cc
chown -R cc:cc /home/cc

# 2. Install Claude Code CLI under cc user
su - cc -c 'curl -fsSL https://claude.ai/install.sh | bash'
su - cc -c 'echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> ~/.bashrc'

# 3. Configure CC bypass permissions
su - cc -c 'mkdir -p /home/cc/.claude && cat > /home/cc/.claude/settings.json << EOF
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
EOF'

# 4. Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git

# 5. Clone and install relay
cd /workspace
git clone https://github.com/Pthahnix/neocortica-relay.git
cd neocortica-relay
npm install

# 6. Create workspace dirs
mkdir -p /workspace/inbox /workspace/outbox /workspace/experiment /workspace/supervisor

# 7. Start worker server (in tmux so it persists)
tmux new-session -d -s relay \
  "RELAY_AUTH_TOKEN=<token> RELAY_PORT=8080 RELAY_WORKSPACE=/workspace npx tsx src/worker/server.ts"
```

Alternatively, pipe the provisioning script:
```bash
ssh root@<pod-ip> 'RELAY_AUTH_TOKEN=<token> bash -s' < scripts/provision-worker.sh
```

## Phase 3: Register Worker

Once the worker server is running, use relay MCP tools:

```
worker_register:
  url: "https://<pod-id>-8080.proxy.runpod.net"
  name: "relay-worker-<purpose>"
```

Verify: response should have `ok: true` and `lastHealth.status: "ok"`.

If health check fails, the worker server may not be ready yet. Wait 10s and retry.

## Phase 4: Dispatch Task

```
task_dispatch:
  workerId: "<w-xxx from Phase 3>"
  experimentPlan: "<user's task description in markdown>"
  checkpoints: ["<phase names>"]
  apiKey: "<user's Anthropic API key>"
  baseUrl: "<user's API base URL, if custom>"
  model: "<model name, if custom>"
```

The worker will:
1. Write the experiment plan to `/workspace/inbox/task.md`
2. Spawn `claude -p "$(cat /workspace/inbox/task.md)"` with allowed tools
3. CC executes the task in `/workspace/experiment/`

## Phase 5: Monitor & Collect Results

Poll status until terminal:

```
task_status:
  taskId: "<t-xxx from Phase 4>"
```

Status transitions: `initializing → running → completed/failed`

If `awaiting_approval`: check report, send feedback:
```
task_report:   { taskId: "<t-xxx>" }
task_feedback: { taskId: "<t-xxx>", action: "continue" }
```

When `completed`, download results:
```
task_files:
  taskId: "<t-xxx>"
  path: "<relative path in /workspace/experiment/>"
```

## Phase 6: Cleanup

Always clean up, even if task failed:

```
1. worker_unregister: { workerId: "<w-xxx>" }
2. RunPod delete-pod: { podId: "<pod-id>" }
```

## Error Recovery

| Situation | Action |
|-----------|--------|
| Pod creation fails | Check GPU availability, try different GPU type |
| SSH/provision fails | Check pod is RUNNING, retry provision |
| Health check fails | Worker server not started, check tmux logs |
| Task fails immediately | CC not installed or API key invalid |
| Task stalls | Use `task_abort`, check worker logs |
| Cleanup fails | Manually delete pod from RunPod console |

## Environment Variables Reference

| Variable | Where | Purpose |
|----------|-------|---------|
| `RELAY_AUTH_TOKEN` | Worker pod + local MCP | Bearer token for HTTP auth |
| `ANTHROPIC_API_KEY` | Injected into CC process | API authentication (auto-mapped from `apiKey` in dispatch) |
| `ANTHROPIC_BASE_URL` | Injected into CC process | Custom API endpoint (auto-mapped from `baseUrl`) |
| `ANTHROPIC_MODEL` | Injected into CC process | Model override (auto-mapped from `model`) |
