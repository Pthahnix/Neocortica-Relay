import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildProvisionCheckCommand,
  buildCreateUserCommands,
  buildInstallCcCommand,
  buildInstallNodeCommand,
  buildWriteSettingsCommand,
  buildWriteEnvVarsCommand,
  buildCopySshKeysCommand,
} from '../../src/cli/provision.js'

describe('buildProvisionCheckCommand', () => {
  it('checks for cc user and claude CLI', () => {
    const cmd = buildProvisionCheckCommand()
    assert.ok(cmd.includes('id cc'))
    assert.ok(cmd.includes('claude --version'))
  })
})

describe('buildCreateUserCommands', () => {
  it('creates cc user with bash shell', () => {
    const cmd = buildCreateUserCommands()
    assert.ok(cmd.includes('useradd'))
    assert.ok(cmd.includes('-s /bin/bash'))
    assert.ok(cmd.includes('cc'))
  })
})

describe('buildInstallCcCommand', () => {
  it('installs CC as cc user', () => {
    const cmd = buildInstallCcCommand()
    assert.ok(cmd.includes('su - cc'))
    assert.ok(cmd.includes('claude.ai/install.sh'))
  })
})

describe('buildInstallNodeCommand', () => {
  it('installs Node.js 22 and tmux', () => {
    const cmd = buildInstallNodeCommand()
    assert.ok(cmd.includes('nodesource'))
    assert.ok(cmd.includes('nodejs'))
    assert.ok(cmd.includes('tmux'))
  })
})

describe('buildWriteSettingsCommand', () => {
  it('writes bypassPermissions settings', () => {
    const cmd = buildWriteSettingsCommand()
    assert.ok(cmd.includes('bypassPermissions'))
    assert.ok(cmd.includes('/home/cc/.claude/settings.json'))
  })
})

describe('buildWriteEnvVarsCommand', () => {
  it('writes API env vars to bashrc', () => {
    const cmd = buildWriteEnvVarsCommand({
      baseUrl: 'https://api.example.com',
      authToken: 'sk-test',
      model: 'claude-opus-4-6',
    })
    assert.ok(cmd.includes('ANTHROPIC_BASE_URL'))
    assert.ok(cmd.includes('ANTHROPIC_AUTH_TOKEN'))
    assert.ok(cmd.includes('ANTHROPIC_MODEL'))
    assert.ok(cmd.includes('.local/bin'))
  })

  it('omits baseUrl when not provided', () => {
    const cmd = buildWriteEnvVarsCommand({
      authToken: 'sk-test',
    })
    assert.ok(!cmd.includes('ANTHROPIC_BASE_URL'))
    assert.ok(cmd.includes('ANTHROPIC_AUTH_TOKEN'))
  })
})

describe('buildCopySshKeysCommand', () => {
  it('copies authorized_keys to cc user', () => {
    const cmd = buildCopySshKeysCommand()
    assert.ok(cmd.includes('/home/cc/.ssh'))
    assert.ok(cmd.includes('authorized_keys'))
    assert.ok(cmd.includes('chown'))
  })
})
