import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { TeleportContext } from '../core/types.js'
import type { ApiCredentials } from '../core/env.js'

const execFileAsync = promisify(execFile)

export function buildProvisionCheckCommand(): string {
  return 'id cc 2>/dev/null && su - cc -c "claude --version" 2>/dev/null'
}

export function buildCreateUserCommands(): string {
  return [
    'useradd -m -s /bin/bash cc',
    'usermod -aG sudo cc',
  ].join(' && ')
}

export function buildInstallCcCommand(): string {
  return "su - cc -c 'curl -fsSL https://claude.ai/install.sh | bash'"
}

export function buildInstallNodeCommand(): string {
  return [
    'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -',
    'apt-get install -y nodejs git tmux',
  ].join(' && ')
}

export function buildWriteSettingsCommand(): string {
  return [
    'su - cc -c "mkdir -p /home/cc/.claude"',
    `su - cc -c 'cat > /home/cc/.claude/settings.json << SETTINGS
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
SETTINGS'`,
  ].join(' && ')
}

export function buildWriteEnvVarsCommand(creds: ApiCredentials): string {
  const lines: string[] = [
    'export PATH="$HOME/.local/bin:$PATH"',
  ]
  if (creds.baseUrl) lines.push(`export ANTHROPIC_BASE_URL="${creds.baseUrl}"`)
  lines.push(`export ANTHROPIC_AUTH_TOKEN="${creds.authToken}"`)
  if (creds.model) lines.push(`export ANTHROPIC_MODEL="${creds.model}"`)

  const block = lines.join('\n')
  return `su - cc -c 'cat >> /home/cc/.bashrc << "ENVBLOCK"\n${block}\nENVBLOCK'`
}

export function buildCopySshKeysCommand(): string {
  return [
    'mkdir -p /home/cc/.ssh',
    'cp /root/.ssh/authorized_keys /home/cc/.ssh/',
    'chown -R cc:cc /home/cc/.ssh',
    'chmod 700 /home/cc/.ssh',
    'chmod 600 /home/cc/.ssh/authorized_keys',
  ].join(' && ')
}

function sshCmd(host: string, port: number, user: string, remoteCmd: string): string[] {
  const target = `${user}@${host}`
  if (port !== 22) return ['ssh', '-o', 'StrictHostKeyChecking=no', '-p', String(port), target, remoteCmd]
  return ['ssh', '-o', 'StrictHostKeyChecking=no', target, remoteCmd]
}

export async function provision(
  ctx: TeleportContext,
  creds: ApiCredentials
): Promise<void> {
  const { host, port } = ctx

  console.log('[provision] Checking pod state...')
  try {
    const checkCmd = sshCmd(host, port, 'root', buildProvisionCheckCommand())
    await execFileAsync(checkCmd[0], checkCmd.slice(1), { timeout: 15000 })
    console.log('[provision] Pod already provisioned, skipping.')
    return
  } catch {
    console.log('[provision] Pod needs provisioning...')
  }

  console.log('[provision] Creating cc user...')
  const createCmd = sshCmd(host, port, 'root', buildCreateUserCommands())
  await execFileAsync(createCmd[0], createCmd.slice(1))

  console.log('[provision] Installing Claude Code CLI...')
  const ccCmd = sshCmd(host, port, 'root', buildInstallCcCommand())
  await execFileAsync(ccCmd[0], ccCmd.slice(1), { timeout: 120000 })

  console.log('[provision] Installing Node.js 22 + tmux...')
  const nodeCmd = sshCmd(host, port, 'root', buildInstallNodeCommand())
  await execFileAsync(nodeCmd[0], nodeCmd.slice(1), { timeout: 120000 })

  console.log('[provision] Configuring CC settings...')
  const settingsCmd = sshCmd(host, port, 'root', buildWriteSettingsCommand())
  await execFileAsync(settingsCmd[0], settingsCmd.slice(1))

  console.log('[provision] Writing API credentials...')
  const envCmd = sshCmd(host, port, 'root', buildWriteEnvVarsCommand(creds))
  await execFileAsync(envCmd[0], envCmd.slice(1))

  console.log('[provision] Copying SSH keys to cc user...')
  const sshKeysCmd = sshCmd(host, port, 'root', buildCopySshKeysCommand())
  await execFileAsync(sshKeysCmd[0], sshKeysCmd.slice(1))

  console.log('[provision] Done.')
}
