import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFile, rm } from 'node:fs/promises'

import { packSession, toPosixPath, unpackSession } from '../core/packer.js'
import { remapPaths } from '../core/remapper.js'
import { computeProjectHash, CC_PROJECTS_DIR } from '../core/types.js'
import type { TeleportContext } from '../core/types.js'
import { assertSafeShellArg } from './teleport.js'

const execFileAsync = promisify(execFile)

export function buildScpUpload(
  localPath: string,
  user: string,
  host: string,
  port: number
): string[] {
  const target = `${user}@${host}:/tmp/neocortica-session.tar.gz`
  if (port !== 22) return ['scp', '-P', String(port), localPath, target]
  return ['scp', localPath, target]
}

export function buildRemoteUnpackWithMemory(
  targetHash: string,
  sessionId: string
): string {
  assertSafeShellArg(targetHash, 'targetHash')
  assertSafeShellArg(sessionId, 'sessionId')
  const ccDir = `~/.claude/projects/${targetHash}`
  const now = Date.now()
  const isoNow = new Date().toISOString()

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
    `mkdir -p ${ccDir}/${sessionId} ${ccDir}/memory /tmp/neocortica-session-unpack`,
    `tar xzf /tmp/neocortica-session.tar.gz --no-same-owner -C /tmp/neocortica-session-unpack`,
    `cp /tmp/neocortica-session-unpack/${sessionId}.jsonl ${ccDir}/`,
    `[ -d /tmp/neocortica-session-unpack/${sessionId} ] && cp -r /tmp/neocortica-session-unpack/${sessionId}/* ${ccDir}/${sessionId}/ || true`,
    `[ -d /tmp/neocortica-session-unpack/memory ] && cp -r /tmp/neocortica-session-unpack/memory/* ${ccDir}/memory/ || true`,
    `echo '${indexJson.replace(/\${HOME}/g, "'\"$HOME\"'")}' > ${ccDir}/sessions-index.json`,
    `rm -rf /tmp/neocortica-session-unpack`,
  ].join(' && ')
}

function sshCmd(host: string, port: number, user: string, remoteCmd: string): string[] {
  const target = `${user}@${host}`
  if (port !== 22) return ['ssh', '-o', 'StrictHostKeyChecking=no', '-p', String(port), target, remoteCmd]
  return ['ssh', '-o', 'StrictHostKeyChecking=no', target, remoteCmd]
}

export async function transfer(ctx: TeleportContext): Promise<void> {
  const { host, port, sessionId, projectDir, workspaceDir, remoteHash } = ctx
  const projectHash = computeProjectHash(projectDir)
  const ccProjectDir = join(CC_PROJECTS_DIR(), projectHash)

  console.log('[transfer] Packing session...')
  const archivePath = join(tmpdir(), `neocortica-session-${Date.now()}.tar.gz`)
  await packSession(ccProjectDir, sessionId, archivePath, projectDir)

  if (projectDir !== workspaceDir) {
    console.log('[transfer] Remapping paths...')
    const unpackDir = join(tmpdir(), `neocortica-remap-${Date.now()}`)
    const { meta, sessionDir } = await unpackSession(archivePath, unpackDir)

    await remapPaths(sessionDir, meta.projectDir, workspaceDir)

    const updatedMeta = { ...meta, projectDir: workspaceDir }
    await writeFile(join(sessionDir, 'metadata.json'), JSON.stringify(updatedMeta, null, 2))

    await execFileAsync('tar', ['czf', toPosixPath(archivePath), '-C', toPosixPath(sessionDir), '.'])
    await rm(unpackDir, { recursive: true, force: true })
  }

  console.log(`[transfer] Uploading to ${host}...`)
  const scpCmd = buildScpUpload(archivePath, 'cc', host, port)
  await execFileAsync(scpCmd[0], scpCmd.slice(1))

  console.log('[transfer] Unpacking on pod...')
  const unpackCmd = buildRemoteUnpackWithMemory(remoteHash, sessionId)
  const sshUnpack = sshCmd(host, port, 'cc', unpackCmd)
  await execFileAsync(sshUnpack[0], sshUnpack.slice(1))

  await rm(archivePath, { force: true })

  console.log('[transfer] Done.')
}
