import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildRemoteUnpackWithMemory,
  buildScpUpload,
} from '../../src/cli/transfer.js'

describe('buildScpUpload', () => {
  it('builds scp command with port', () => {
    const cmd = buildScpUpload('/tmp/archive.tar.gz', 'cc', '10.0.0.1', 2222)
    assert.deepEqual(cmd, ['scp', '-P', '2222', '/tmp/archive.tar.gz', 'cc@10.0.0.1:/tmp/neocortica-session.tar.gz'])
  })

  it('builds scp command with default port', () => {
    const cmd = buildScpUpload('/tmp/archive.tar.gz', 'cc', '10.0.0.1', 22)
    assert.deepEqual(cmd, ['scp', '/tmp/archive.tar.gz', 'cc@10.0.0.1:/tmp/neocortica-session.tar.gz'])
  })
})

describe('buildRemoteUnpackWithMemory', () => {
  it('includes memory copy step', () => {
    const cmd = buildRemoteUnpackWithMemory('-workspace', 'session-123')
    assert.ok(cmd.includes('tar xzf'))
    assert.ok(cmd.includes('--no-same-owner'))
    assert.ok(cmd.includes('session-123.jsonl'))
    assert.ok(cmd.includes('memory'))
  })

  it('includes sessions-index.json generation', () => {
    const cmd = buildRemoteUnpackWithMemory('-workspace', 'session-123')
    assert.ok(cmd.includes('sessions-index.json'))
  })

  it('rejects unsafe inputs', () => {
    assert.throws(
      () => buildRemoteUnpackWithMemory('foo;rm -rf /', 'session-1'),
      /Unsafe/
    )
    assert.throws(
      () => buildRemoteUnpackWithMemory('-workspace', '$(whoami)'),
      /Unsafe/
    )
  })
})
