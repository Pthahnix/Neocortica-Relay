import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadEnvCredentials } from '../../src/core/env.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'env-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('loadEnvCredentials', () => {
  it('parses KEY=VALUE format', async () => {
    await writeFile(join(tempDir, '.env'), [
      'ANTHROPIC_BASE_URL=https://api.example.com',
      'ANTHROPIC_AUTH_TOKEN=sk-test123',
      'ANTHROPIC_MODEL=claude-opus-4-6',
    ].join('\n'))

    const creds = await loadEnvCredentials(tempDir)
    assert.equal(creds.baseUrl, 'https://api.example.com')
    assert.equal(creds.authToken, 'sk-test123')
    assert.equal(creds.model, 'claude-opus-4-6')
  })

  it('handles quoted values', async () => {
    await writeFile(join(tempDir, '.env'), [
      'ANTHROPIC_BASE_URL="https://api.example.com"',
      "ANTHROPIC_AUTH_TOKEN='sk-test123'",
      'ANTHROPIC_MODEL=claude-opus-4-6',
    ].join('\n'))

    const creds = await loadEnvCredentials(tempDir)
    assert.equal(creds.baseUrl, 'https://api.example.com')
    assert.equal(creds.authToken, 'sk-test123')
  })

  it('skips comments and blank lines', async () => {
    await writeFile(join(tempDir, '.env'), [
      '# This is a comment',
      '',
      'ANTHROPIC_AUTH_TOKEN=sk-test',
      'ANTHROPIC_MODEL=claude-opus-4-6',
    ].join('\n'))

    const creds = await loadEnvCredentials(tempDir)
    assert.equal(creds.authToken, 'sk-test')
  })

  it('falls back to process.env when .env missing', async () => {
    const origToken = process.env.ANTHROPIC_AUTH_TOKEN
    const origModel = process.env.ANTHROPIC_MODEL
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-token'
    process.env.ANTHROPIC_MODEL = 'env-model'

    try {
      const creds = await loadEnvCredentials(join(tempDir, 'nonexistent'))
      assert.equal(creds.authToken, 'env-token')
      assert.equal(creds.model, 'env-model')
    } finally {
      if (origToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = origToken
      else delete process.env.ANTHROPIC_AUTH_TOKEN
      if (origModel !== undefined) process.env.ANTHROPIC_MODEL = origModel
      else delete process.env.ANTHROPIC_MODEL
    }
  })

  it('throws when no credentials found anywhere', async () => {
    const origToken = process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.ANTHROPIC_AUTH_TOKEN

    try {
      await assert.rejects(
        () => loadEnvCredentials(join(tempDir, 'nonexistent')),
        /ANTHROPIC_AUTH_TOKEN/
      )
    } finally {
      if (origToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = origToken
    }
  })
})
