import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildRemotePackCommand,
  buildScpDownloadCommand,
} from '../../src/cli/return.js'

describe('buildRemotePackCommand', () => {
  it('builds tar command for session on pod', () => {
    const cmd = buildRemotePackCommand('-workspace', 'my-session')
    assert.ok(cmd.includes('tar czf'))
    assert.ok(cmd.includes('.claude/projects/-workspace'))
    assert.ok(cmd.includes('my-session.jsonl'))
    assert.ok(cmd.includes('sessions-index.json'))
  })
})

describe('buildScpDownloadCommand', () => {
  it('builds scp download without port', () => {
    const cmd = buildScpDownloadCommand({ user: 'root', host: '10.0.0.1' }, '/tmp/out.tar.gz')
    assert.deepEqual(cmd, ['scp', 'root@10.0.0.1:/tmp/neocortica-session-return.tar.gz', '/tmp/out.tar.gz'])
  })

  it('builds scp download with port', () => {
    const cmd = buildScpDownloadCommand({ user: 'root', host: '10.0.0.1', port: '2222' }, '/tmp/out.tar.gz')
    assert.deepEqual(cmd, ['scp', '-P', '2222', 'root@10.0.0.1:/tmp/neocortica-session-return.tar.gz', '/tmp/out.tar.gz'])
  })
})
