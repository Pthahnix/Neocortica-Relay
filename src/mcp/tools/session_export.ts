import { packSession } from '../../core/packer.js'

interface ExportInput {
  ccProjectDir: string
  sessionId: string
  outputPath: string
  projectDir: string
}

export async function handleSessionExport(input: ExportInput) {
  try {
    const result = await packSession(
      input.ccProjectDir,
      input.sessionId,
      input.outputPath,
      input.projectDir
    )
    return { ok: true as const, ...result }
  } catch (err) {
    return { ok: false as const, error: (err as Error).message }
  }
}
