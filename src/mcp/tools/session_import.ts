import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { unpackSession } from '../../core/packer.js'
import { remapPaths } from '../../core/remapper.js'
import { registerSession } from '../../core/registry.js'

interface ImportInput {
  archivePath: string
  targetCCDir: string
  targetProjectDir: string
}

export async function handleSessionImport(input: ImportInput) {
  try {
    const unpackDir = await mkdtemp(join(tmpdir(), 'session-import-'))
    const { meta, sessionDir } = await unpackSession(input.archivePath, unpackDir)

    if (meta.projectDir !== input.targetProjectDir) {
      await remapPaths(sessionDir, meta.projectDir, input.targetProjectDir)
    }

    await registerSession(
      input.targetCCDir,
      sessionDir,
      meta.sessionId,
      { ...meta, projectDir: input.targetProjectDir }
    )

    // Warn on CC version mismatch (don't block)
    let warning: string | undefined
    if (meta.ccVersion) {
      try {
        const { execFile } = await import('node:child_process')
        const { promisify } = await import('node:util')
        const execFileAsync = promisify(execFile)
        const { stdout } = await execFileAsync('claude', ['--version'])
        const localVersion = stdout.trim()
        if (localVersion && localVersion !== meta.ccVersion) {
          warning = `CC version mismatch: archive=${meta.ccVersion}, local=${localVersion}. Resume may behave unexpectedly.`
        }
      } catch { /* CC not found or version check failed — skip warning */ }
    }

    return {
      ok: true as const,
      sessionId: meta.sessionId,
      resumeCommand: `claude --resume ${meta.sessionId}`,
      ...(warning ? { warning } : {}),
    }
  } catch (err) {
    return { ok: false as const, error: (err as Error).message }
  }
}
