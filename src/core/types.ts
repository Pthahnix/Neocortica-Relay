import { z } from 'zod'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── Types ──

export interface SessionMeta {
  sessionId: string
  projectDir: string
  platform: string
  hostname: string
  timestamp: string
  gitBranch?: string
  messageCount: number
  ccVersion?: string
}

export interface SessionsIndex {
  version: number
  entries: SessionIndexEntry[]
}

export interface SessionIndexEntry {
  sessionId: string
  fullPath: string
  fileMtime: number
  firstPrompt: string
  summary?: string
  messageCount: number
  created: string
  modified: string
  gitBranch?: string
  projectPath: string
  isSidechain: boolean
}

// ── Validation ──

const SessionMetaSchema = z.object({
  sessionId: z.string().min(1),
  projectDir: z.string().min(1),
  platform: z.string().min(1),
  hostname: z.string().min(1),
  timestamp: z.string().min(1),
  gitBranch: z.string().optional(),
  messageCount: z.number().int().min(0),
  ccVersion: z.string().optional(),
})

export function validateSessionMeta(meta: unknown): SessionMeta {
  return SessionMetaSchema.parse(meta) as SessionMeta
}

// ── Helpers ──

export function computeProjectHash(projectDir: string): string {
  return projectDir.replace(/[^a-zA-Z0-9]/g, '-')
}

export function CC_PROJECTS_DIR(): string {
  return join(homedir(), '.claude', 'projects')
}
