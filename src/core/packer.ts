import { execFile } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { hostname, platform } from 'node:os'
import { promisify } from 'node:util'

import type { SessionMeta } from './types.js'
import { validateSessionMeta } from './types.js'

const execFileAsync = promisify(execFile)

/**
 * Convert a Windows absolute path to POSIX format for Git Bash tar.
 * e.g. C:\Users\foo -> /c/Users/foo
 * On non-Windows platforms, returns the path unchanged.
 */
export function toPosixPath(p: string): string {
  if (platform() === 'win32') {
    const backslash = String.fromCharCode(92)
    return p.replace(/^([A-Za-z]):/, (_: string, d: string) => '/' + d.toLowerCase()).split(backslash).join('/')
  }
  return p
}

export interface PackResult {
  archivePath: string
  sessionId: string
  messageCount: number
}

export interface UnpackResult {
  meta: SessionMeta
  sessionDir: string
}

export async function packSession(
  ccProjectDir: string,
  sessionId: string,
  outputPath: string,
  projectDir: string
): Promise<PackResult> {
  const jsonlPath = join(ccProjectDir, `${sessionId}.jsonl`)
  if (!existsSync(jsonlPath)) {
    throw new Error(`JSONL file not found: ${jsonlPath}`)
  }

  // Count messages and detect CC version from JSONL records
  const jsonlContent = await readFile(jsonlPath, 'utf-8')
  const lines = jsonlContent.trim().split('\n').filter(l => l.length > 0)
  const messageCount = lines.length

  // Try to extract CC version from JSONL records (each line has a "version" field)
  let ccVersion: string | undefined
  try {
    const firstLine = JSON.parse(lines[0])
    if (firstLine.version) ccVersion = firstLine.version
  } catch { /* ignore parse errors */ }

  // Build metadata
  const meta: SessionMeta = {
    sessionId,
    projectDir,
    platform: platform(),
    hostname: hostname(),
    timestamp: new Date().toISOString(),
    messageCount,
    ccVersion,
  }

  // Create staging dir
  const stageDir = outputPath + '.stage'
  await mkdir(stageDir, { recursive: true })

  // Copy JSONL
  const jsonlBytes = await readFile(jsonlPath)
  await writeFile(join(stageDir, `${sessionId}.jsonl`), jsonlBytes)

  // Copy subagents if exists
  const subagentsDir = join(ccProjectDir, sessionId, 'subagents')
  if (existsSync(subagentsDir)) {
    const targetSubDir = join(stageDir, sessionId, 'subagents')
    await mkdir(targetSubDir, { recursive: true })
    await copyDirContents(subagentsDir, targetSubDir)
  }

  // Copy tool-results if exists
  const toolResultsDir = join(ccProjectDir, sessionId, 'tool-results')
  if (existsSync(toolResultsDir)) {
    const targetToolDir = join(stageDir, sessionId, 'tool-results')
    await mkdir(targetToolDir, { recursive: true })
    await copyDirContents(toolResultsDir, targetToolDir)
  }

  // Write metadata
  await writeFile(join(stageDir, 'metadata.json'), JSON.stringify(meta, null, 2))

  // Create tar.gz (use POSIX paths for Git Bash tar on Windows)
  await execFileAsync('tar', ['czf', toPosixPath(outputPath), '-C', toPosixPath(stageDir), '.'])

  // Cleanup staging
  await rm(stageDir, { recursive: true, force: true })

  return { archivePath: outputPath, sessionId, messageCount }
}

export async function unpackSession(
  archivePath: string,
  tempDir: string
): Promise<UnpackResult> {
  await mkdir(tempDir, { recursive: true })

  try {
    await execFileAsync('tar', ['xzf', toPosixPath(archivePath), '--no-same-owner', '-C', toPosixPath(tempDir)])
  } catch (err) {
    throw new Error(`Unpack failed: ${(err as Error).message}`)
  }

  const metaPath = join(tempDir, 'metadata.json')
  if (!existsSync(metaPath)) {
    throw new Error('metadata.json not found in archive')
  }

  const meta: SessionMeta = validateSessionMeta(JSON.parse(await readFile(metaPath, 'utf-8')))

  return { meta, sessionDir: tempDir }
}

async function copyDirContents(src: string, dest: string): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isFile()) {
      const content = await readFile(srcPath)
      await writeFile(destPath, content)
    } else if (entry.isDirectory()) {
      await mkdir(destPath, { recursive: true })
      await copyDirContents(srcPath, destPath)
    }
  }
}
