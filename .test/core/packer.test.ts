import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

import { packSession, unpackSession, toPosixPath } from '../../src/core/packer.js'
import type { SessionMeta } from '../../src/core/types.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'packer-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('packSession', () => {
  it('packs a session with JSONL into tar.gz', async () => {
    const sessionId = 'test-session-001'
    const ccProjectDir = join(tempDir, 'cc-project')
    await mkdir(ccProjectDir, { recursive: true })

    const jsonlContent = [
      JSON.stringify({ type: 'user', sessionId, cwd: '/workspace', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'assistant', sessionId, cwd: '/workspace', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
    ].join('\n')
    await writeFile(join(ccProjectDir, `${sessionId}.jsonl`), jsonlContent)

    const subagentsDir = join(ccProjectDir, sessionId, 'subagents')
    await mkdir(subagentsDir, { recursive: true })
    await writeFile(join(subagentsDir, 'sub1.jsonl'), '{"type":"user"}\n')

    const toolResultsDir = join(ccProjectDir, sessionId, 'tool-results')
    await mkdir(toolResultsDir, { recursive: true })
    await writeFile(join(toolResultsDir, 'result1.json'), '{"output":"ok"}')

    const outputPath = join(tempDir, 'output.tar.gz')
    const result = await packSession(ccProjectDir, sessionId, outputPath, '/workspace')

    assert.ok(existsSync(result.archivePath))
    assert.equal(result.sessionId, sessionId)
    assert.equal(result.messageCount, 2)
  })

  it('throws if JSONL file not found', async () => {
    const ccProjectDir = join(tempDir, 'empty-project')
    await mkdir(ccProjectDir, { recursive: true })

    await assert.rejects(
      () => packSession(ccProjectDir, 'nonexistent', join(tempDir, 'out.tar.gz'), '/workspace'),
      /JSONL.*not found/i
    )
  })

  it('packs session without subagents or tool-results', async () => {
    const sessionId = 'minimal-session'
    const ccProjectDir = join(tempDir, 'cc-project')
    await mkdir(ccProjectDir, { recursive: true })
    await writeFile(join(ccProjectDir, `${sessionId}.jsonl`), '{"type":"user"}\n')

    const outputPath = join(tempDir, 'minimal.tar.gz')
    const result = await packSession(ccProjectDir, sessionId, outputPath, '/workspace')

    assert.ok(existsSync(result.archivePath))
    assert.equal(result.messageCount, 1)
  })
})

describe('unpackSession', () => {
  it('roundtrips pack → unpack', async () => {
    const sessionId = 'roundtrip-session'
    const ccProjectDir = join(tempDir, 'cc-project')
    await mkdir(ccProjectDir, { recursive: true })

    const jsonlLine = JSON.stringify({ type: 'user', sessionId, cwd: '/workspace', message: { content: 'test' } })
    await writeFile(join(ccProjectDir, `${sessionId}.jsonl`), jsonlLine + '\n')

    const archivePath = join(tempDir, 'roundtrip.tar.gz')
    await packSession(ccProjectDir, sessionId, archivePath, '/workspace')

    const unpackDir = join(tempDir, 'unpacked')
    const result = await unpackSession(archivePath, unpackDir)

    assert.equal(result.meta.sessionId, sessionId)
    assert.equal(result.meta.projectDir, '/workspace')
    assert.ok(existsSync(join(result.sessionDir, `${sessionId}.jsonl`)))
  })

  it('throws on invalid archive', async () => {
    const fakePath = join(tempDir, 'fake.tar.gz')
    await writeFile(fakePath, 'not a tar')

    await assert.rejects(
      () => unpackSession(fakePath, join(tempDir, 'out')),
      /failed|error/i
    )
  })
})

describe('packSession with memory', () => {
  let ccProjectDir: string
  let sessionId: string
  let archivePath: string

  beforeEach(async () => {
    sessionId = 'memory-session-001'
    ccProjectDir = join(tempDir, 'cc-project-mem')
    await mkdir(ccProjectDir, { recursive: true })
    await writeFile(join(ccProjectDir, `${sessionId}.jsonl`), '{"type":"user"}\n')
    archivePath = join(tempDir, 'memory-test.tar.gz')
  })

  it('includes memory directory in archive when present', async () => {
    const memoryDir = join(ccProjectDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'MEMORY.md'), '# Test Memory\nSome notes')
    await writeFile(join(memoryDir, 'patterns.md'), '# Patterns')

    const result = await packSession(ccProjectDir, sessionId, archivePath, '/test/project')

    const verifyDir = join(tempDir, 'verify')
    await mkdir(verifyDir, { recursive: true })
    await execFileAsync('tar', ['xzf', toPosixPath(result.archivePath), '-C', toPosixPath(verifyDir)])

    assert.ok(existsSync(join(verifyDir, 'memory', 'MEMORY.md')))
    assert.ok(existsSync(join(verifyDir, 'memory', 'patterns.md')))
    const content = await readFile(join(verifyDir, 'memory', 'MEMORY.md'), 'utf-8')
    assert.ok(content.includes('Test Memory'))
  })

  it('packs successfully when memory directory does not exist', async () => {
    const result = await packSession(ccProjectDir, sessionId, archivePath, '/test/project')
    assert.ok(existsSync(result.archivePath))
  })
})
