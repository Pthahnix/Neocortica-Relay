import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { handleSessionExport } from './tools/session_export.js'
import { handleSessionImport } from './tools/session_import.js'
import { handleSessionList } from './tools/session_list.js'
import { computeProjectHash, CC_PROJECTS_DIR } from '../core/types.js'

const server = new McpServer({
  name: 'neocortica-session',
  version: '0.1.0',
})

server.tool(
  'session_export',
  'Export a CC session as a portable archive',
  {
    projectDir: z.string().optional().describe('Project directory (default: CWD)'),
    sessionId: z.string().optional().describe('Session ID (default: latest)'),
    outputPath: z.string().optional().describe('Output archive path'),
  },
  async (args) => {
    const projectDir = args.projectDir || process.cwd()
    const hash = computeProjectHash(projectDir)
    const ccProjectDir = join(CC_PROJECTS_DIR(), hash)

    let sessionId = args.sessionId
    if (!sessionId) {
      const listResult = await handleSessionList({ ccProjectDir })
      if (listResult.ok && listResult.sessions.length > 0) {
        const sorted = [...listResult.sessions].sort(
          (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime()
        )
        sessionId = sorted[0].sessionId
      } else {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'No sessions found' }) }] }
      }
    }

    const outputPath = args.outputPath || join(tmpdir(), `neocortica-session-${Date.now()}.tar.gz`)
    const result = await handleSessionExport({ ccProjectDir, sessionId, outputPath, projectDir })
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
)

server.tool(
  'session_import',
  'Import a session archive into local CC',
  {
    archivePath: z.string().describe('Path to session archive (.tar.gz)'),
    projectDir: z.string().optional().describe('Target project directory (default: CWD)'),
  },
  async (args) => {
    const targetProjectDir = args.projectDir || process.cwd()
    const hash = computeProjectHash(targetProjectDir)
    const targetCCDir = join(CC_PROJECTS_DIR(), hash)

    const result = await handleSessionImport({
      archivePath: args.archivePath,
      targetCCDir,
      targetProjectDir,
    })
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
)

server.tool(
  'session_list',
  'List CC sessions for a project',
  {
    projectDir: z.string().optional().describe('Project directory (default: CWD)'),
  },
  async (args) => {
    const projectDir = args.projectDir || process.cwd()
    const hash = computeProjectHash(projectDir)
    const ccProjectDir = join(CC_PROJECTS_DIR(), hash)

    const result = await handleSessionList({ ccProjectDir })
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(console.error)
