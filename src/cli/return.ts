import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { unpackSession } from '../core/packer.js'
import { remapPaths } from '../core/remapper.js'
import { registerSession } from '../core/registry.js'
import { computeProjectHash, CC_PROJECTS_DIR } from '../core/types.js'
import { parsePodSsh, sshCommand, type PodSsh } from './teleport.js'

const execFileAsync = promisify(execFile)

export function buildRemotePackCommand(
  targetHash: string,
  sessionId: string
): string {
  const ccDir = `~/.claude/projects/${targetHash}`
  return `cd ${ccDir} && tar czf /tmp/neocortica-session-return.tar.gz ${sessionId}.jsonl ${sessionId}/ sessions-index.json 2>/dev/null || tar czf /tmp/neocortica-session-return.tar.gz ${sessionId}.jsonl sessions-index.json`
}

export function buildScpDownloadCommand(ssh: PodSsh, localPath: string): string[] {
  const source = `${ssh.user}@${ssh.host}:/tmp/neocortica-session-return.tar.gz`
  if (ssh.port) {
    return ['scp', '-P', ssh.port, source, localPath]
  }
  return ['scp', source, localPath]
}

export async function sessionReturn(
  podSsh: string,
  options: {
    sessionId?: string
    remoteProjectDir?: string
    localProjectDir?: string
    outputPath?: string
  } = {}
): Promise<void> {
  const ssh = parsePodSsh(podSsh)
  const remoteProjectDir = options.remoteProjectDir || '/workspace'
  const localProjectDir = options.localProjectDir || process.cwd()
  const remoteHash = computeProjectHash(remoteProjectDir)

  // Determine session ID on pod
  let sessionId = options.sessionId
  if (!sessionId) {
    // Read remote sessions-index.json to find latest
    console.log(`[return] Finding latest session on pod...`)
    const findCmd = sshCommand(ssh, `cat ~/.claude/projects/${remoteHash}/sessions-index.json 2>/dev/null || echo '{"entries":[]}'`)
    const { stdout } = await execFileAsync(findCmd[0], findCmd.slice(1))
    const index = JSON.parse(stdout)
    if (!index.entries || index.entries.length === 0) {
      throw new Error('No sessions found on pod')
    }
    const sorted = [...index.entries].sort(
      (a: any, b: any) => new Date(b.modified).getTime() - new Date(a.modified).getTime()
    )
    sessionId = sorted[0].sessionId
  }

  console.log(`[return] Packing session ${sessionId} on pod...`)

  // 1. Remote pack
  const packCmd = buildRemotePackCommand(remoteHash, sessionId!)
  const sshPack = sshCommand(ssh, packCmd)
  await execFileAsync(sshPack[0], sshPack.slice(1))

  // 2. SCP download
  const localArchive = options.outputPath || join(tmpdir(), `neocortica-session-return-${Date.now()}.tar.gz`)
  console.log(`[return] Downloading session...`)
  const scpCmd = buildScpDownloadCommand(ssh, localArchive)
  await execFileAsync(scpCmd[0], scpCmd.slice(1))

  // 3. Unpack + remap + register locally
  console.log(`[return] Importing session locally...`)
  const unpackDir = join(tmpdir(), `neocortica-return-unpack-${Date.now()}`)
  const { meta, sessionDir } = await unpackSession(localArchive, unpackDir)

  // Remap from remote to local
  const sourceDir = meta.projectDir || remoteProjectDir
  if (sourceDir !== localProjectDir) {
    await remapPaths(sessionDir, sourceDir, localProjectDir)
  }

  // Register
  const localHash = computeProjectHash(localProjectDir)
  const targetCCDir = join(CC_PROJECTS_DIR(), localHash)
  await registerSession(
    targetCCDir,
    sessionDir,
    sessionId!,
    { ...meta, projectDir: localProjectDir }
  )

  console.log(`\n[ok] Session returned! Resume with:`)
  console.log(`  claude --resume ${sessionId}`)
}

// CLI entry point
if (process.argv[1]?.endsWith('return.ts') || process.argv[1]?.endsWith('return.js')) {
  const args = process.argv.slice(2)
  if (args.length < 1) {
    console.error('Usage: return <pod-ssh> [--session <id>] [--remote-project <dir>] [--local-project <dir>]')
    process.exit(1)
  }

  const podSsh = args[0]
  const options: any = {}

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--session' && args[i + 1]) { options.sessionId = args[++i] }
    else if (args[i] === '--remote-project' && args[i + 1]) { options.remoteProjectDir = args[++i] }
    else if (args[i] === '--local-project' && args[i + 1]) { options.localProjectDir = args[++i] }
    else if (args[i] === '--output' && args[i + 1]) { options.outputPath = args[++i] }
  }

  sessionReturn(podSsh, options).catch(err => {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  })
}
