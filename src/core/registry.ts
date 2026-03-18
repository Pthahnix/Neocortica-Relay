import { readFile, writeFile, mkdir, cp, stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

import type { SessionMeta, SessionsIndex, SessionIndexEntry } from './types.js'

export async function loadIndex(ccProjectDir: string): Promise<SessionsIndex> {
  const indexPath = join(ccProjectDir, 'sessions-index.json')
  if (!existsSync(indexPath)) {
    return { version: 1, entries: [] }
  }

  try {
    const raw = await readFile(indexPath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed.version && Array.isArray(parsed.entries)) {
      return parsed as SessionsIndex
    }
    return { version: 1, entries: [] }
  } catch {
    return { version: 1, entries: [] }
  }
}

export async function saveIndex(
  ccProjectDir: string,
  index: SessionsIndex
): Promise<void> {
  await mkdir(ccProjectDir, { recursive: true })
  await writeFile(
    join(ccProjectDir, 'sessions-index.json'),
    JSON.stringify(index, null, 2)
  )
}

export async function registerSession(
  targetCCDir: string,
  sourceSessionDir: string,
  sessionId: string,
  meta: SessionMeta
): Promise<void> {
  await mkdir(targetCCDir, { recursive: true })

  // Copy JSONL
  const srcJsonl = join(sourceSessionDir, `${sessionId}.jsonl`)
  const dstJsonl = join(targetCCDir, `${sessionId}.jsonl`)
  if (existsSync(srcJsonl)) {
    const content = await readFile(srcJsonl)
    await writeFile(dstJsonl, content)
  }

  // Copy session subdirectory (subagents, tool-results) if exists
  const srcSessionDir = join(sourceSessionDir, sessionId)
  const dstSessionDir = join(targetCCDir, sessionId)
  if (existsSync(srcSessionDir)) {
    await cp(srcSessionDir, dstSessionDir, { recursive: true, force: true })
  }

  // Extract firstPrompt from JSONL
  let firstPrompt = '[imported session]'
  if (existsSync(dstJsonl)) {
    try {
      const content = await readFile(dstJsonl, 'utf-8')
      const firstLine = content.split('\n')[0]
      if (firstLine) {
        const record = JSON.parse(firstLine)
        if (record.message?.content) {
          const text = typeof record.message.content === 'string'
            ? record.message.content
            : JSON.stringify(record.message.content)
          firstPrompt = `[shared] ${text.slice(0, 100)}`
        }
      }
    } catch { /* ignore parse errors */ }
  }

  // Update index
  const index = await loadIndex(targetCCDir)
  const now = new Date().toISOString()
  const mtime = Date.now()

  const existing = index.entries.findIndex(e => e.sessionId === sessionId)
  const entry: SessionIndexEntry = {
    sessionId,
    fullPath: dstJsonl,
    fileMtime: mtime,
    firstPrompt,
    messageCount: meta.messageCount,
    created: existing >= 0 ? index.entries[existing].created : now,
    modified: now,
    gitBranch: meta.gitBranch,
    projectPath: meta.projectDir,
    isSidechain: false,
  }

  if (existing >= 0) {
    index.entries[existing] = entry
  } else {
    index.entries.push(entry)
  }

  await saveIndex(targetCCDir, index)
}

export async function listSessions(
  ccProjectDir: string
): Promise<SessionIndexEntry[]> {
  const index = await loadIndex(ccProjectDir)
  if (index.entries.length > 0) return index.entries

  // Fallback: scan .jsonl files by mtime
  return scanJsonlFiles(ccProjectDir)
}

async function scanJsonlFiles(dir: string): Promise<SessionIndexEntry[]> {
  if (!existsSync(dir)) return []

  const entries = await readdir(dir)
  const jsonlFiles = entries.filter(f => f.endsWith('.jsonl'))

  const results: SessionIndexEntry[] = []
  for (const file of jsonlFiles) {
    const filePath = join(dir, file)
    const fileStat = await stat(filePath)
    const sessionId = file.replace('.jsonl', '')

    let firstPrompt = '[scanned session]'
    try {
      const content = await readFile(filePath, 'utf-8')
      const firstLine = content.split('\n')[0]
      if (firstLine) {
        const record = JSON.parse(firstLine)
        if (record.message?.content) {
          const text = typeof record.message.content === 'string'
            ? record.message.content
            : JSON.stringify(record.message.content)
          firstPrompt = text.slice(0, 100)
        }
      }
    } catch { /* ignore */ }

    results.push({
      sessionId,
      fullPath: filePath,
      fileMtime: fileStat.mtimeMs,
      firstPrompt,
      messageCount: 0,
      created: fileStat.birthtime.toISOString(),
      modified: fileStat.mtime.toISOString(),
      projectPath: '',
      isSidechain: false,
    })
  }

  results.sort((a, b) => b.fileMtime - a.fileMtime)
  return results
}
