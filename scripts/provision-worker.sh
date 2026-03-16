#!/bin/bash
# Provision a RunPod pod for neocortica-relay worker
# Usage: ssh root@<pod> 'bash -s' < scripts/provision-worker.sh
# Or: cat scripts/provision-worker.sh | ssh root@<pod> bash
#
# Expects env vars passed via ssh or set on pod:
#   RELAY_AUTH_TOKEN  — bearer token for worker HTTP auth
#   RELAY_REPO_URL    — git clone URL for neocortica-relay (optional, defaults to github)
#   ANTHROPIC_BASE_URL — API base URL (optional)
#   ANTHROPIC_AUTH_TOKEN — API auth token for CC interactive setup (optional)
#   ANTHROPIC_MODEL   — model override (optional)

set -euo pipefail

echo "=== [1/6] Creating cc user ==="
if ! id cc &>/dev/null; then
  useradd -m -s /bin/bash cc
  usermod -aG sudo cc
  chown -R cc:cc /home/cc
fi

echo "=== [2/6] Installing Claude Code CLI ==="
su - cc -c 'curl -fsSL https://claude.ai/install.sh | bash'
su - cc -c 'echo '\''export PATH="$HOME/.local/bin:$PATH"'\'' >> ~/.bashrc'

echo "=== [3/6] Configuring CC permissions (bypassPermissions) ==="
su - cc -c 'mkdir -p /home/cc/.claude && cat > /home/cc/.claude/settings.json << SETTINGS
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
SETTINGS'

echo "=== [4/6] Installing Node.js 22 ==="
if ! command -v node &>/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs git
fi
echo "Node: $(node -v), npm: $(npm -v)"

echo "=== [5/6] Cloning and installing neocortica-relay ==="
RELAY_REPO_URL="${RELAY_REPO_URL:-https://github.com/Pthahnix/neocortica-relay.git}"
cd /workspace
if [ -d neocortica-relay ]; then
  cd neocortica-relay && git pull
else
  git clone "$RELAY_REPO_URL"
  cd neocortica-relay
fi
npm install
mkdir -p /workspace/inbox /workspace/outbox /workspace/experiment /workspace/supervisor

echo "=== [6/6] Starting worker server ==="
export RELAY_AUTH_TOKEN="${RELAY_AUTH_TOKEN:-}"
export RELAY_PORT="${RELAY_PORT:-8080}"
export RELAY_WORKSPACE="/workspace"

# Write CC env config for the spawned CC process
cat > /workspace/.cc-env << CCENV
ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-}
ANTHROPIC_AUTH_TOKEN=${ANTHROPIC_AUTH_TOKEN:-}
ANTHROPIC_MODEL=${ANTHROPIC_MODEL:-}
CCENV

echo "Worker starting on port $RELAY_PORT..."
echo "Workspace: $RELAY_WORKSPACE"

# Run in foreground (use nohup/tmux externally if needed)
exec npx tsx src/worker/server.ts
