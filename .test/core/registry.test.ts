import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

import {
  listSessions,
  registerSession,
  loadIndex,
  saveIndex,
} from '../../src/core/registry.js'
import type { SessionMeta, SessionsIndex } from '../../src/core/types.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'registry-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('loadIndex', () => {
  it('returns empty index if file does not exist', async () => {
    const index = await loadIndex(join(tempDir, 'nonexistent'))
    assert.equal(index.version, 1)
    assert.equal(index.entries.length, 0)
  })

  it('loads existing index', async () => {
    const existing: SessionsIndex = {
      version: 1,
      entries: [{
        sessionId: 'abc',
        fullPath: '/path/to/abc.jsonl',
        fileMtime: 1700000000000,
        firstPrompt: 'hello',
        messageCount: 5,
        created: '2026-03-16T00:00:00Z',
        modified: '2026-03-16T00:00:00Z',
        projectPath: '/workspace',
        isSidechain: false,
      }],
    }
    await writeFile(join(tempDir, 'sessions-index.json'), JSON.stringify(existing))

    const index = await loadIndex(tempDir)
    assert.equal(index.entries.length, 1)
    assert.equal(index.entries[0].sessionId, 'abc')
  })

  it('handles corrupt index file gracefully', async () => {
    await writeFile(join(tempDir, 'sessions-index.json'), 'not json{{{')

    const index = await loadIndex(tempDir)
    assert.equal(index.version, 1)
    assert.equal(index.entries.length, 0)
  })
})

describe('saveIndex', () => {
  it('writes index to disk', async () => {
    const index: SessionsIndex = {
      version: 1,
      entries: [{ sessionId: 'x', fullPath: '', fileMtime: 0, firstPrompt: '', messageCount: 0, created: '', modified: '', projectPath: '', isSidechain: false }],
    }
    await saveIndex(tempDir, index)

    const raw = JSON.parse(await readFile(join(tempDir, 'sessions-index.json'), 'utf-8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.entries.length, 1)
  })
})

describe('registerSession', () => {
  it('copies JSONL and updates index', async () => {
    const sourceDir = join(tempDir, 'source')
    await mkdir(sourceDir, { recursive: true })
    const sessionId = 'register-test'
    const jsonlContent = '{"type":"user","message":{"content":"hello"}}\n'
    await writeFile(join(sourceDir, `${sessionId}.jsonl`), jsonlContent)

    const targetCCDir = join(tempDir, 'target-cc')
    await mkdir(targetCCDir, { recursive: true })

    const meta: SessionMeta = {
      sessionId,
      projectDir: '/workspace',
      platform: 'linux',
      hostname: 'pod',
      timestamp: '2026-03-16T00:00:00Z',
      messageCount: 1,
    }

    await registerSession(targetCCDir, sourceDir, sessionId, meta)

    assert.ok(existsSync(join(targetCCDir, `${sessionId}.jsonl`)))

    const index = JSON.parse(await readFile(join(targetCCDir, 'sessions-index.json'), 'utf-8'))
    assert.equal(index.entries.length, 1)
    assert.equal(index.entries[0].sessionId, sessionId)
    assert.equal(index.entries[0].projectPath, '/workspace')
    assert.equal(index.entries[0].isSidechain, false)
  })

  it('updates existing entry instead of duplicating', async () => {
    const targetCCDir = join(tempDir, 'target-cc')
    await mkdir(targetCCDir, { recursive: true })

    const sourceDir = join(tempDir, 'source')
    await mkdir(sourceDir, { recursive: true })
    const sessionId = 'dup-test'
    await writeFile(join(sourceDir, `${sessionId}.jsonl`), '{"type":"user"}\n')

    const meta: SessionMeta = {
      sessionId,
      projectDir: '/workspace',
      platform: 'linux',
      hostname: 'pod',
      timestamp: '2026-03-16T00:00:00Z',
      messageCount: 1,
    }

    await registerSession(targetCCDir, sourceDir, sessionId, meta)
    await registerSession(targetCCDir, sourceDir, sessionId, { ...meta, messageCount: 5 })

    const index = JSON.parse(await readFile(join(targetCCDir, 'sessions-index.json'), 'utf-8'))
    assert.equal(index.entries.length, 1)
    assert.equal(index.entries[0].messageCount, 5)
  })

  it('copies subagents and tool-results if present', async () => {
    const sourceDir = join(tempDir, 'source')
    const sessionId = 'with-extras'
    await mkdir(join(sourceDir, sessionId, 'subagents'), { recursive: true })
    await mkdir(join(sourceDir, sessionId, 'tool-results'), { recursive: true })
    await writeFile(join(sourceDir, `${sessionId}.jsonl`), '{"type":"user"}\n')
    await writeFile(join(sourceDir, sessionId, 'subagents', 'a.jsonl'), '{}')
    await writeFile(join(sourceDir, sessionId, 'tool-results', 'r.json'), '{}')

    const targetCCDir = join(tempDir, 'target-cc')
    await mkdir(targetCCDir, { recursive: true })

    const meta: SessionMeta = {
      sessionId,
      projectDir: '/workspace',
      platform: 'linux',
      hostname: 'pod',
      timestamp: '2026-03-16T00:00:00Z',
      messageCount: 1,
    }

    await registerSession(targetCCDir, sourceDir, sessionId, meta)

    assert.ok(existsSync(join(targetCCDir, sessionId, 'subagents', 'a.jsonl')))
    assert.ok(existsSync(join(targetCCDir, sessionId, 'tool-results', 'r.json')))
  })
})

describe('listSessions', () => {
  it('returns entries from index', async () => {
    const index: SessionsIndex = {
      version: 1,
      entries: [
        { sessionId: 'a', fullPath: '', fileMtime: 0, firstPrompt: 'first', messageCount: 3, created: '2026-03-16T00:00:00Z', modified: '2026-03-16T01:00:00Z', projectPath: '/workspace', isSidechain: false },
        { sessionId: 'b', fullPath: '', fileMtime: 0, firstPrompt: 'second', messageCount: 7, created: '2026-03-16T00:00:00Z', modified: '2026-03-16T02:00:00Z', projectPath: '/workspace', isSidechain: false },
      ],
    }
    await writeFile(join(tempDir, 'sessions-index.json'), JSON.stringify(index))

    const sessions = await listSessions(tempDir)
    assert.equal(sessions.length, 2)
    assert.equal(sessions[0].sessionId, 'a')
    assert.equal(sessions[1].messageCount, 7)
  })

  it('returns empty array for missing index', async () => {
    const sessions = await listSessions(join(tempDir, 'nonexistent'))
    assert.equal(sessions.length, 0)
  })
})
