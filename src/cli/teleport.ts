import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFile, rm } from 'node:fs/promises'

import { packSession } from '../core/packer.js'
import { remapPaths } from '../core/remapper.js'
import { unpackSession, toPosixPath } from '../core/packer.js'
import { computeProjectHash, CC_PROJECTS_DIR } from '../core/types.js'
import { listSessions } from '../core/registry.js'

const execFileAsync = promisify(execFile)

export function assertSafeShellArg(value: string, name: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`Unsafe ${name}: contains invalid characters: ${value}`)
  }
}

export interface PodSsh {
  user: string
  host: string
  port?: string
}

export function parsePodSsh(podSsh: string): PodSsh {
  // Format: user@host or user@host:port
  const atIdx = podSsh.indexOf('@')
  if (atIdx < 0) throw new Error(`Invalid SSH string: ${podSsh}`)

  const user = podSsh.slice(0, atIdx)
  const rest = podSsh.slice(atIdx + 1)

  const colonIdx = rest.lastIndexOf(':')
  if (colonIdx >= 0 && !rest.includes('[')) {
    // user@host:port
    return { user, host: rest.slice(0, colonIdx), port: rest.slice(colonIdx + 1) }
  }
  return { user, host: rest }
}

export function buildScpUploadCommand(localPath: string, ssh: PodSsh): string[] {
  const target = `${ssh.user}@${ssh.host}:/tmp/neocortica-session.tar.gz`
  if (ssh.port) {
    return ['scp', '-P', ssh.port, localPath, target]
  }
  return ['scp', localPath, target]
}

export function buildRemoteUnpackCommands(
  targetHash: string,
  sessionId: string
): string {
  assertSafeShellArg(targetHash, 'targetHash')
  assertSafeShellArg(sessionId, 'sessionId')
  const ccDir = `~/.claude/projects/${targetHash}`
  const now = Date.now()
  const isoNow = new Date().toISOString()
  // Generate sessions-index.json on the pod with correct absolute paths
  // This ensures fullPath and projectPath point to the pod's actual CC project directory
  const indexJson = JSON.stringify({
    version: 1,
    entries: [{
      sessionId,
      fullPath: `\${HOME}/.claude/projects/${targetHash}/${sessionId}.jsonl`,
      fileMtime: now,
      firstPrompt: 'Teleported session',
      messageCount: 0,
      created: isoNow,
      modified: isoNow,
      projectPath: '/workspace',
      isSidechain: false,
    }],
  })
  return [
    `mkdir -p ${ccDir}/${sessionId} /tmp/neocortica-session-unpack`,
    `tar xzf /tmp/neocortica-session.tar.gz --no-same-owner -C /tmp/neocortica-session-unpack`,
    `cp /tmp/neocortica-session-unpack/${sessionId}.jsonl ${ccDir}/`,
    `[ -d /tmp/neocortica-session-unpack/${sessionId} ] && cp -r /tmp/neocortica-session-unpack/${sessionId}/* ${ccDir}/${sessionId}/ || true`,
    // Generate index with correct fullPath using shell variable expansion for $HOME
    `echo '${indexJson.replace(/\${HOME}/g, "'\"$HOME\"'")}' > ${ccDir}/sessions-index.json`,
    `rm -rf /tmp/neocortica-session-unpack`,
  ].join(' && ')
}

export function buildTmuxLaunchCommand(
  sessionId: string,
  workspaceDir: string
): string {
  assertSafeShellArg(sessionId, 'sessionId')
  return `tmux kill-session -t neocortica 2>/dev/null; tmux new-session -d -s neocortica "cd ${workspaceDir} && claude --resume ${sessionId} --fork-session"`
}

export function sshCommand(ssh: PodSsh, remoteCmd: string): string[] {
  const target = `${ssh.user}@${ssh.host}`
  if (ssh.port) {
    return ['ssh', '-p', ssh.port, target, remoteCmd]
  }
  return ['ssh', target, remoteCmd]
}

export async function teleport(
  podSsh: string,
  options: {
    archivePath?: string
    sessionId?: string
    projectDir?: string
    workspaceDir?: string
  } = {}
): Promise<void> {
  const ssh = parsePodSsh(podSsh)
  const projectDir = options.projectDir || process.cwd()
  const workspaceDir = options.workspaceDir || '/workspace'
  const targetHash = computeProjectHash(workspaceDir)

  let archivePath = options.archivePath

  // If no archive provided, export current session
  if (!archivePath) {
    const hash = computeProjectHash(projectDir)
    const ccProjectDir = join(CC_PROJECTS_DIR(), hash)

    // Determine sessionId
    let sessionId = options.sessionId
    if (!sessionId) {
      // Read index to find latest
      const sessions = await listSessions(ccProjectDir)
      if (sessions.length === 0) throw new Error('No sessions found')
      const sorted = [...sessions].sort(
        (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime()
      )
      sessionId = sorted[0].sessionId
    }

    // Pack
    archivePath = join(tmpdir(), `neocortica-session-${Date.now()}.tar.gz`)
    await packSession(ccProjectDir, sessionId!, archivePath, projectDir)

    // Pre-process: unpack, remap, repack for target
    const unpackDir = join(tmpdir(), `neocortica-remap-${Date.now()}`)
    const { meta, sessionDir } = await unpackSession(archivePath, unpackDir)

    if (meta.projectDir !== workspaceDir) {
      await remapPaths(sessionDir, meta.projectDir, workspaceDir)
    }

    // Update metadata
    const updatedMeta = { ...meta, projectDir: workspaceDir }
    await writeFile(join(sessionDir, 'metadata.json'), JSON.stringify(updatedMeta, null, 2))

    // Repack
    await execFileAsync('tar', ['czf', toPosixPath(archivePath), '-C', toPosixPath(sessionDir), '.'])
    await rm(unpackDir, { recursive: true, force: true })

    options.sessionId = sessionId
  }

  const sessionId = options.sessionId!

  console.log(`[teleport] Uploading session to ${podSsh}...`)

  // 1. SCP upload
  const scpCmd = buildScpUploadCommand(archivePath, ssh)
  await execFileAsync(scpCmd[0], scpCmd.slice(1))

  // 2. Remote unpack
  console.log(`[teleport] Unpacking session on pod...`)
  const unpackCmd = `mkdir -p /tmp/neocortica-session-unpack && ${buildRemoteUnpackCommands(targetHash, sessionId)}`
  const sshUnpack = sshCommand(ssh, unpackCmd)
  await execFileAsync(sshUnpack[0], sshUnpack.slice(1))

  // 3. Launch tmux + CC
  console.log(`[teleport] Launching Claude Code in tmux...`)
  const tmuxCmd = buildTmuxLaunchCommand(sessionId, workspaceDir)
  const sshTmux = sshCommand(ssh, tmuxCmd)
  await execFileAsync(sshTmux[0], sshTmux.slice(1))

  console.log(`\n[ok] Session teleported! Connect with:`)
  console.log(`  ssh ${ssh.port ? `-p ${ssh.port} ` : ''}${ssh.user}@${ssh.host}`)
  console.log(`  tmux attach -t neocortica`)
}

// CLI entry point
if (process.argv[1]?.endsWith('teleport.ts') || process.argv[1]?.endsWith('teleport.js')) {
  const args = process.argv.slice(2)
  if (args.length < 1) {
    console.error('Usage: teleport <pod-ssh> [archive-path] [--session <id>] [--project <dir>] [--workspace <dir>]')
    process.exit(1)
  }

  const podSsh = args[0]
  const options: any = {}

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--session' && args[i + 1]) { options.sessionId = args[++i] }
    else if (args[i] === '--project' && args[i + 1]) { options.projectDir = args[++i] }
    else if (args[i] === '--workspace' && args[i + 1]) { options.workspaceDir = args[++i] }
    else if (!args[i].startsWith('--')) { options.archivePath = args[i] }
  }

  teleport(podSsh, options).catch(err => {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  })
}
