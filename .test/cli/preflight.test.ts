import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseArgs, applyMsysGuard, resolveSession } from '../../src/cli/preflight.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'preflight-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('parseArgs', () => {
  it('parses host:port', () => {
    const result = parseArgs(['root@10.0.0.1:2222'])
    assert.equal(result.podSsh, 'root@10.0.0.1:2222')
  })

  it('parses all flags', () => {
    const result = parseArgs([
      'root@host:22',
      '--session', 'abc-123',
      '--project', '/my/project',
      '--workspace', '/workspace',
    ])
    assert.equal(result.sessionId, 'abc-123')
    assert.equal(result.projectDir, '/my/project')
    assert.equal(result.workspaceDir, '/workspace')
  })

  it('defaults workspace to /workspace', () => {
    const result = parseArgs(['root@host'])
    assert.equal(result.workspaceDir, '/workspace')
  })

  it('throws on missing pod-ssh', () => {
    assert.throws(() => parseArgs([]), /pod-ssh/)
  })
})

describe('applyMsysGuard', () => {
  it('sets MSYS_NO_PATHCONV when MSYS_SYSTEM is set', () => {
    const orig = process.env.MSYS_NO_PATHCONV
    const origMsys = process.env.MSYS_SYSTEM
    process.env.MSYS_SYSTEM = 'MINGW64'
    delete process.env.MSYS_NO_PATHCONV

    try {
      applyMsysGuard()
      assert.equal(process.env.MSYS_NO_PATHCONV, '1')
    } finally {
      if (orig !== undefined) process.env.MSYS_NO_PATHCONV = orig
      else delete process.env.MSYS_NO_PATHCONV
      if (origMsys !== undefined) process.env.MSYS_SYSTEM = origMsys
      else delete process.env.MSYS_SYSTEM
    }
  })
})

describe('resolveSession', () => {
  it('uses provided sessionId', async () => {
    const result = await resolveSession(tempDir, 'explicit-id')
    assert.equal(result.sessionId, 'explicit-id')
    assert.ok(result.sessionPath.includes('explicit-id.jsonl'))
  })

  it('finds latest session by scanning .jsonl when no index', async () => {
    await writeFile(join(tempDir, 'old-session.jsonl'), '{"type":"user","version":"2.1.70"}\n')
    await new Promise(r => setTimeout(r, 50))
    await writeFile(join(tempDir, 'new-session.jsonl'), '{"type":"user","version":"2.1.78"}\n')

    const result = await resolveSession(tempDir, undefined)
    assert.equal(result.sessionId, 'new-session')
    assert.equal(result.ccVersion, '2.1.78')
  })

  it('extracts ccVersion from JSONL', async () => {
    await writeFile(join(tempDir, 'versioned.jsonl'), '{"type":"user","version":"2.1.75"}\n')

    const result = await resolveSession(tempDir, 'versioned')
    assert.equal(result.ccVersion, '2.1.75')
  })

  it('throws when no sessions found', async () => {
    await assert.rejects(
      () => resolveSession(tempDir, undefined),
      /No sessions found/
    )
  })
})
