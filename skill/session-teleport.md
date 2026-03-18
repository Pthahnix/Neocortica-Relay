# Session Teleport — Git-based Context Transfer SOP

Orchestrates deploying a CC research context to a remote GPU pod via Git. No session JSONL transfer — CLAUDE.md + MEMORY provide equivalent durable context.

## Prerequisites
- RunPod MCP server configured
- Experiment repo on GitHub (public or private)
- Local `.env` with API credentials (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL)
- For private repos: GitHub PAT available in environment or `.env`

## Phase 1: Hardware Estimation

1. Read the experiment plan from the current research context
2. Estimate: GPU type/count, disk space, estimated cost/hour
3. Present estimate to user and **wait for confirmation**
   - If user declines → STOP (no cleanup needed)

## Phase 2: Pod Creation (RunPod MCP)

1. Call `create-pod` with estimated hardware:
   - `gpuTypeIds`: from Phase 1 estimate
   - `gpuCount`: from Phase 1 estimate
   - `imageName`: `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04`
   - `containerDiskInGb`: from Phase 1 estimate
   - `volumeInGb`: 0 (no persistent volume needed)
   - `ports`: `['22/tcp']`
   - `name`: `neocortica-experiment`
2. Wait for pod status = RUNNING
3. Extract SSH connection info (host, port)
4. **Record `podId` for cleanup**
   - If pod creation fails → STOP (no cleanup needed)

## Phase 3: Context Collection + Push

1. Copy local CC memory files to repo:
   ```bash
   # Compute local project hash (Windows: D:\path → D--path)
   cp ~/.claude/projects/<project-hash>/memory/* ./memory/
   ```
2. Commit and push:
   ```bash
   git add memory/
   git commit -m "sync: context for pod deployment"
   git push
   ```
   - If no memory files exist, skip copy — CLAUDE.md alone provides context

## Phase 4: Provision (SSH — smart detection + per-need scripts)

SSH into the pod and detect what's present, then execute only what's needed.

### Step 1: Detection
```bash
ssh -p <port> root@<host> "node --version 2>/dev/null; id cc 2>/dev/null; echo '---'"
```

### Step 2: Install Node.js (if missing or < v22)
```bash
scp -P <port> scripts/install-node.sh root@<host>:/tmp/
ssh -p <port> root@<host> "bash /tmp/install-node.sh"
```

### Step 3: Create cc user (if missing)
```bash
scp -P <port> scripts/create-cc-user.sh root@<host>:/tmp/
ssh -p <port> root@<host> "bash /tmp/create-cc-user.sh"
```

### Step 4: Install Claude Code (if missing)
```bash
scp -P <port> scripts/install-cc.sh root@<host>:/tmp/
ssh -p <port> root@<host> "bash /tmp/install-cc.sh"
```

### Step 5: Configure API credentials
```bash
scp -P <port> scripts/setup-env.sh root@<host>:/tmp/
ssh -p <port> root@<host> "bash /tmp/setup-env.sh '<BASE_URL>' '<AUTH_TOKEN>' '<MODEL>'"
```
Read credentials from local `.env` file.

### Step 6: Configure bypassPermissions
```bash
ssh -p <port> root@<host> "mkdir -p /home/cc/.claude && cat > /home/cc/.claude/settings.json << 'SETTINGSEOF'
{
  \"permissions\": {
    \"defaultMode\": \"bypassPermissions\"
  }
}
SETTINGSEOF
chown -R cc:cc /home/cc/.claude"
```

### Step 7: Configure GitHub auth (private repos only)
```bash
ssh -p <port> root@<host> "su - cc -c 'git config --global credential.helper store && echo \"https://<PAT>@github.com\" > /home/cc/.git-credentials'"
```

### Step 8: Deploy context
```bash
scp -P <port> scripts/deploy-context.sh root@<host>:/tmp/
ssh -p <port> root@<host> "bash /tmp/deploy-context.sh '<REPO_URL>' /workspace"
```

- If any provision step fails → inform user, suggest `session-return` for cleanup

## Phase 5: Handoff

Output to user:
```
Pod ready. Connect:
  ssh -p <port> cc@<host>
  cd /workspace/<repo>
  claude
```

No tmux, no auto-start. User connects and starts CC themselves.
CC reads CLAUDE.md from repo root and MEMORY from ~/.claude/projects/<hash>/memory/ automatically.

## Error Recovery Matrix

| Phase | Failure | Action |
|-------|---------|--------|
| 1 | User declines | Stop, no cleanup needed |
| 2 | Pod creation fails | Stop, no cleanup needed |
| 3 | Git push fails | Fix locally, retry. Pod not yet provisioned |
| 4 | Provision fails | Inform user, suggest session-return for cleanup |
| 5 | User can't connect | Troubleshoot SSH, cleanup if unresolvable |
