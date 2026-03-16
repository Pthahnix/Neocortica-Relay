import { listSessions } from '../../core/registry.js'

interface ListInput {
  ccProjectDir: string
}

export async function handleSessionList(input: ListInput) {
  try {
    const sessions = await listSessions(input.ccProjectDir)
    return {
      ok: true as const,
      sessions: sessions.map(s => ({
        sessionId: s.sessionId,
        firstPrompt: s.firstPrompt,
        messageCount: s.messageCount,
        created: s.created,
        modified: s.modified,
        gitBranch: s.gitBranch,
      })),
    }
  } catch (err) {
    return { ok: false as const, error: (err as Error).message, sessions: [] }
  }
}
