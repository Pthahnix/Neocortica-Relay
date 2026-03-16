import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  type SessionMeta,
  type SessionsIndex,
  type SessionIndexEntry,
  validateSessionMeta,
  computeProjectHash,
  CC_PROJECTS_DIR,
} from '../../src/core/types.js'

describe('computeProjectHash', () => {
  it('converts Windows path to hash', () => {
    assert.equal(computeProjectHash('D:\\NEOCORTICA'), 'D--NEOCORTICA')
  })

  it('converts Linux path to hash', () => {
    assert.equal(computeProjectHash('/workspace'), '-workspace')
  })

  it('converts complex path', () => {
    assert.equal(
      computeProjectHash('/home/user/my_project'),
      '-home-user-my-project'
    )
  })

  it('handles path with multiple special chars', () => {
    assert.equal(computeProjectHash('C:\\Users\\Dev\\app'), 'C--Users-Dev-app')
  })
})

describe('CC_PROJECTS_DIR', () => {
  it('returns path under home directory', () => {
    const dir = CC_PROJECTS_DIR()
    assert.ok(dir.includes('.claude'))
    assert.ok(dir.includes('projects'))
  })
})

describe('validateSessionMeta', () => {
  it('accepts valid metadata', () => {
    const meta: SessionMeta = {
      sessionId: 'abc-123',
      projectDir: '/workspace',
      platform: 'linux',
      hostname: 'pod-xyz',
      timestamp: '2026-03-16T00:00:00.000Z',
      messageCount: 42,
    }
    assert.doesNotThrow(() => validateSessionMeta(meta))
  })

  it('rejects missing sessionId', () => {
    const meta = {
      projectDir: '/workspace',
      platform: 'linux',
      hostname: 'pod',
      timestamp: '2026-03-16T00:00:00.000Z',
      messageCount: 1,
    }
    assert.throws(() => validateSessionMeta(meta as any))
  })

  it('rejects negative messageCount', () => {
    const meta: SessionMeta = {
      sessionId: 'abc',
      projectDir: '/workspace',
      platform: 'linux',
      hostname: 'pod',
      timestamp: '2026-03-16T00:00:00.000Z',
      messageCount: -1,
    }
    assert.throws(() => validateSessionMeta(meta))
  })

  it('accepts optional fields', () => {
    const meta: SessionMeta = {
      sessionId: 'abc',
      projectDir: '/workspace',
      platform: 'linux',
      hostname: 'pod',
      timestamp: '2026-03-16T00:00:00.000Z',
      messageCount: 5,
      gitBranch: 'main',
      ccVersion: '2.1.68',
    }
    assert.doesNotThrow(() => validateSessionMeta(meta))
  })
})
