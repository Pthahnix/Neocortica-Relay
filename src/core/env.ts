import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

export interface ApiCredentials {
  baseUrl?: string
  authToken: string
  model?: string
}

export async function loadEnvCredentials(projectDir: string): Promise<ApiCredentials> {
  const envPath = join(projectDir, '.env')
  let envVars: Record<string, string> = {}

  if (existsSync(envPath)) {
    const content = await readFile(envPath, 'utf-8')
    envVars = parseEnvFile(content)
  }

  const baseUrl = envVars['ANTHROPIC_BASE_URL'] || process.env.ANTHROPIC_BASE_URL
  const authToken = envVars['ANTHROPIC_AUTH_TOKEN'] || process.env.ANTHROPIC_AUTH_TOKEN
  const model = envVars['ANTHROPIC_MODEL'] || process.env.ANTHROPIC_MODEL

  if (!authToken) {
    throw new Error('ANTHROPIC_AUTH_TOKEN not found in .env or process.env')
  }

  return { baseUrl, authToken, model }
}

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let value = trimmed.slice(eqIdx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}
