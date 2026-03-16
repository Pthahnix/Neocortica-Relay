import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { handleSessionExport } from '../../src/mcp/tools/session_export.js'
import { handleSessionImport } from '../../src/mcp/tools/session_import.js'
import { handleSessionList } from '../../src/mcp/tools/session_list.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-tools-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('handleSessionExport', () => {
  it('exports a session and returns archive path', async () => {
    const ccDir = join(tempDir, 'cc-project')
    await mkdir(ccDir, { recursive: true })
    const sessionId = 'export-test'
    await writeFile(join(ccDir, `${sessionId}.jsonl`), '{"type":"user","message":{"content":"hi"}}\n')

    const result = await handleSessionExport({
      ccProjectDir: ccDir,
      sessionId,
      outputPath: join(tempDir, 'export.tar.gz'),
      projectDir: '/workspace',
    })

    assert.equal(result.ok, true)
    assert.ok(result.archivePath)
    assert.equal(result.sessionId, sessionId)
  })

  it('returns error for nonexistent session', async () => {
    const ccDir = join(tempDir, 'empty')
    await mkdir(ccDir, { recursive: true })

    const result = await handleSessionExport({
      ccProjectDir: ccDir,
      sessionId: 'nope',
      outputPath: join(tempDir, 'out.tar.gz'),
      projectDir: '/workspace',
    })

    assert.equal(result.ok, false)
    assert.ok(result.error)
  })
})

describe('handleSessionImport', () => {
  it('imports a session archive into target CC dir', async () => {
    const ccDir = join(tempDir, 'cc-source')
    await mkdir(ccDir, { recursive: true })
    const sessionId = 'import-test'
    await writeFile(join(ccDir, `${sessionId}.jsonl`), '{"type":"user","message":{"content":"hello"}}\n')

    const archivePath = join(tempDir, 'archive.tar.gz')
    await handleSessionExport({
      ccProjectDir: ccDir,
      sessionId,
      outputPath: archivePath,
      projectDir: '/source',
    })

    const targetCCDir = join(tempDir, 'cc-target')

    const result = await handleSessionImport({
      archivePath,
      targetCCDir,
      targetProjectDir: '/workspace',
    })

    assert.equal(result.ok, true)
    assert.equal(result.sessionId, sessionId)
    assert.ok(result.resumeCommand)
  })
})

describe('handleSessionList', () => {
  it('returns sessions from index', async () => {
    const ccDir = join(tempDir, 'cc-list')
    await mkdir(ccDir, { recursive: true })
    await writeFile(join(ccDir, 'sessions-index.json'), JSON.stringify({
      version: 1,
      entries: [{ sessionId: 'a', fullPath: '', fileMtime: 0, firstPrompt: 'hi', messageCount: 3, created: '', modified: '', projectPath: '/workspace', isSidechain: false }],
    }))

    const result = await handleSessionList({ ccProjectDir: ccDir })

    assert.equal(result.ok, true)
    assert.equal(result.sessions.length, 1)
    assert.equal(result.sessions[0].sessionId, 'a')
  })

  it('returns empty for missing project dir', async () => {
    const result = await handleSessionList({ ccProjectDir: join(tempDir, 'none') })
    assert.equal(result.ok, true)
    assert.equal(result.sessions.length, 0)
  })
})
