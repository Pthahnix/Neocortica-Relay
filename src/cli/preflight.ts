import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

import { computeProjectHash, CC_PROJECTS_DIR } from '../core/types.js'
import type { TeleportContext } from '../core/types.js'
import { listSessions } from '../core/registry.js'

export interface ParsedArgs {
  podSsh: string
  sessionId?: string
  projectDir: string
  workspaceDir: string
}

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length < 1 || argv[0].startsWith('--')) {
    throw new Error('Usage: teleport <pod-ssh> [--session <id>] [--project <dir>] [--workspace <dir>]')
  }

  const result: ParsedArgs = {
    podSsh: argv[0],
    projectDir: process.cwd(),
    workspaceDir: '/workspace',
  }

  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--session' && argv[i + 1]) result.sessionId = argv[++i]
    else if (argv[i] === '--project' && argv[i + 1]) result.projectDir = argv[++i]
    else if (argv[i] === '--workspace' && argv[i + 1]) result.workspaceDir = argv[++i]
  }

  return result
}

export function applyMsysGuard(): void {
  const isMsys = process.env.MSYS_SYSTEM ||
    (process.env.OSTYPE && process.env.OSTYPE.includes('msys'))
  if (isMsys) {
    process.env.MSYS_NO_PATHCONV = '1'
  }
}

export interface ResolvedSession {
  sessionId: string
  sessionPath: string
  ccVersion: string
  memoryDir: string | null
}

export async function resolveSession(
  ccProjectDir: string,
  sessionId: string | undefined
): Promise<ResolvedSession> {
  if (sessionId) {
    const sessionPath = join(ccProjectDir, `${sessionId}.jsonl`)
    const ccVersion = await extractCcVersion(sessionPath)
    const memoryDir = getMemoryDir(ccProjectDir)
    return { sessionId, sessionPath, ccVersion, memoryDir }
  }

  const sessions = await listSessions(ccProjectDir)
  if (sessions.length === 0) {
    throw new Error(`No sessions found in ${ccProjectDir}`)
  }

  const sorted = [...sessions].sort(
    (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime()
  )
  const latest = sorted[0]
  const sessionPath = join(ccProjectDir, `${latest.sessionId}.jsonl`)
  const ccVersion = await extractCcVersion(sessionPath)
  const memoryDir = getMemoryDir(ccProjectDir)

  return { sessionId: latest.sessionId, sessionPath, ccVersion, memoryDir }
}

async function extractCcVersion(sessionPath: string): Promise<string> {
  try {
    if (!existsSync(sessionPath)) return 'unknown'
    const content = await readFile(sessionPath, 'utf-8')
    const firstLine = content.split('\n')[0]
    if (firstLine) {
      const record = JSON.parse(firstLine)
      if (record.version) return record.version
    }
  } catch { /* ignore */ }
  return 'unknown'
}

function getMemoryDir(ccProjectDir: string): string | null {
  const memDir = join(ccProjectDir, 'memory')
  return existsSync(memDir) ? memDir : null
}

export async function buildTeleportContext(
  args: ParsedArgs,
  resolved: ResolvedSession
): Promise<TeleportContext> {
  const { parsePodSsh } = await import('./teleport.js')
  const ssh = parsePodSsh(args.podSsh)

  return {
    host: ssh.host,
    port: ssh.port ? parseInt(ssh.port, 10) : 22,
    sessionId: resolved.sessionId,
    ccVersion: resolved.ccVersion,
    projectDir: args.projectDir,
    workspaceDir: args.workspaceDir,
    sessionPath: resolved.sessionPath,
    memoryDir: resolved.memoryDir,
    projectHash: computeProjectHash(args.projectDir),
    remoteHash: computeProjectHash(args.workspaceDir),
  }
}
