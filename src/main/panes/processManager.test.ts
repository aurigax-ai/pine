import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import { ownWorkspaceReach } from '../../../test/reach'
import type { Capability } from '../../shared/capabilities'
import type { CommandResult } from '../../shared/types'
import { grant, setCaps } from '../approvals/capabilityStore'
import { setScriptTokenCheck } from '../control/controlAuth'
import { registerControlServer, stopControlServer } from '../control/controlServer'
import {
  type PaneIdentity,
  getByPaneId,
  registerExtension,
  registerPane,
  removePane,
  resolveExternal,
} from '../control/idRegistry'
import { attachWorkspace } from '../sandbox/attachWorkspace'
import { PtyRingBuffer } from '../terminal/ptyRingBuffer'
import {
  type ProcessInfo,
  type ProcessOutput,
  ProcessRegistry,
  type ProcessTabRequest,
  registerProcessMethods,
} from './processManager'

const PROMPT = '\x1b]133;A\x1b\\user@host % \x1b]133;B\x1b\\'
const C = '\x1b]133;C\x1b\\'
const exit = (code: number): string => `\x1b]133;D;${code}\x1b\\`

const GRACE_MS = 40
const rings = new Map<string, PtyRingBuffer>()
const opened: ProcessTabRequest[] = []
const written: { paneId: string; data: string }[] = []
const ended: string[] = []
const reruns: { paneId: string; command: string }[] = []
const cwds = new Map<string, string>()
let tabSeq = 0
let onInterrupt: ((paneId: string) => void) | null = null
let openFails = false

const AGENTS: Record<string, string[]> = {
  claude: ['claude'],
  reviewer: ['codex', '--model', 'o4'],
}

const sandboxedWorkspaces = new Set<string>()

const registry = registerProcessMethods({
  isSandboxed: (workspaceId) => sandboxedWorkspaces.has(workspaceId),
  reach: ownWorkspaceReach((id) =>
    id === 'script_ostia_scoped'
      ? {
          scope: { kind: 'limited', groups: [], workspaces: ['ws2'], ownWorkspaces: false },
          created: [],
        }
      : undefined,
  ),
  openTab: async (req) => {
    if (openFails) return null
    opened.push(req)
    tabSeq += 1
    const paneId = `tab-${tabSeq}`
    rings.set(paneId, new PtyRingBuffer())
    return registerPane({ windowId: 'w1', workspaceId: req.workspaceId ?? '', paneId }).externalId
  },
  ring: (paneId) => {
    const ring = rings.get(paneId)
    return ring ? (from) => ring.since(from) : undefined
  },
  writePane: (paneId, data) => {
    written.push({ paneId, data })
    if (data === '\x03') onInterrupt?.(paneId)
    return rings.has(paneId)
  },
  endShell: (paneId) => {
    ended.push(paneId)
    rings.delete(paneId)
  },
  agentArgv: (name) => AGENTS[name] ?? null,
  hasShell: (paneId) => rings.has(paneId),
  runInPane: (paneId, command) => {
    reruns.push({ paneId, command })
    return true
  },
  cwdOfPane: (paneId) => cwds.get(paneId),
  interruptGraceMs: GRACE_MS,
})

function emit(paneId: string, data: string): void {
  const ring = rings.get(paneId)
  if (!ring) throw new Error(`no ring for ${paneId}`)
  ring.push(data)
  registry.feed(paneId, data, ring.end)
}

const agent = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'agent-pane' })
const neighbour = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'neighbour-pane' })
const stranger = registerPane({ windowId: 'w1', workspaceId: 'ws2', paneId: 'stranger-pane' })
const extension = registerExtension('probe')
setCaps(extension.externalId, ['process', 'all-workspaces'])

let socketPath = ''
let seq = 0
const clients: MessageConnection[] = []

async function client(identity: PaneIdentity): Promise<MessageConnection> {
  const socket = createConnection(socketPath)
  const conn = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  conn.listen()
  clients.push(conn)
  await conn.sendRequest('hello', { token: identity.token })
  return conn
}

interface Started {
  id: string
  name: string
  paneId: string
}

async function start(
  conn: MessageConnection,
  cmd: string,
  name?: string,
): Promise<Started & { tab: string }> {
  const started = await conn.sendRequest<Started>('process.run', { cmd, name })
  return { ...started, tab: `tab-${tabSeq}` }
}

beforeEach(() => {
  seq += 1
  socketPath = join(tmpdir(), `ostia-proc-${process.pid}-${seq}.sock`)
  registerControlServer(
    {
      execCommand: async () => ({ ok: true }) as CommandResult,
      listCommandsFor: () => [],
      getTerminalState: () => undefined,
      isSandboxed: () => false,
    },
    socketPath,
  )
  opened.length = 0
  written.length = 0
  ended.length = 0
  reruns.length = 0
  cwds.clear()
  onInterrupt = null
  openFails = false
})

afterEach(() => {
  for (const c of clients.splice(0)) c.dispose()
  stopControlServer()
  for (const workspaceId of ['ws1', 'ws2']) registry.workspaceClosed(workspaceId)
  sandboxedWorkspaces.clear()
})

describe('agent.run', () => {
  it('starts a known agent in a background tab with the prompt as one quoted argument', async () => {
    cwds.set('agent-pane', '/home/u/proj')
    const conn = await client(agent)
    const prompt = `fix the "login" bug; don't touch $HOME`
    const started = await conn.sendRequest<Started>('agent.run', { agent: 'reviewer', prompt })

    expect(opened[0]).toMatchObject({
      command: `codex --model o4 'fix the "login" bug; don'\\''t touch $HOME'`,
      afterPaneId: 'agent-pane',
      backgroundTab: true,
      title: 'reviewer',
      cwd: '/home/u/proj',
    })
    expect(started).toMatchObject({ name: 'reviewer', paneId: expect.any(String) })
    const [info] = await conn.sendRequest<ProcessInfo[]>('process.list')
    expect(info).toMatchObject({ name: 'reviewer', status: 'starting', paneId: started.paneId })
  })

  it('refuses an agent Ostia does not know, a bad name and an empty prompt, opening nothing', async () => {
    const conn = await client(agent)
    await expect(conn.sendRequest('agent.run', { agent: 'aider', prompt: 'hi' })).resolves.toEqual(
      expect.objectContaining({ ok: false, error: 'unknown-agent' }),
    )
    await expect(conn.sendRequest('agent.run', { agent: 'rm -rf', prompt: 'hi' })).rejects.toThrow(
      'agent',
    )
    await expect(conn.sendRequest('agent.run', { agent: 'claude', prompt: '  ' })).rejects.toThrow(
      'prompt',
    )
    await expect(
      conn.sendRequest('agent.run', { agent: 'claude', prompt: 'x'.repeat(9000) }),
    ).rejects.toThrow('too long')
    expect(opened).toEqual([])
  })
})

describe('process.run', () => {
  it('opens a background tab beside the caller with the command exactly as written', async () => {
    cwds.set('agent-pane', '/home/u/proj')
    const conn = await client(agent)
    const cmd = `claude 'fix the "login" bug && run $TESTS' --model opus`
    const started = await start(conn, cmd, 'worker')

    expect(opened).toEqual([
      {
        command: cmd,
        workspaceId: 'ws1',
        windowId: 'w1',
        afterPaneId: 'agent-pane',
        openedPaneIds: [],
        backgroundTab: true,
        pinTitle: true,
        title: 'worker',
        cwd: '/home/u/proj',
      },
    ])
    expect(started).toMatchObject({ id: expect.stringMatching(/^proc-\d+$/), name: 'worker' })
    expect(started).not.toHaveProperty('pid')
    const [info] = await conn.sendRequest<ProcessInfo[]>('process.list')
    expect(info).toMatchObject({ name: 'worker', cmd, status: 'starting', paneId: started.paneId })
  })

  it("passes the caller's live tabs, oldest first, so the next one opens after them", async () => {
    const conn = await client(agent)
    const first = await start(conn, 'echo one')
    const second = await start(conn, 'echo two')
    registry.paneClosed(first.tab)
    await start(conn, 'echo three')
    await start(await client(neighbour), 'echo other')

    expect(opened.map((o) => o.openedPaneIds)).toEqual([[], [first.tab], [second.tab], []])
  })

  it('names an unnamed process after its program and opens it in the given folder', async () => {
    const conn = await client(agent)
    const started = await conn.sendRequest<Started>('process.run', {
      cmd: 'pnpm dev --port 3000',
      cwd: '/srv/app',
    })
    expect(started.name).toBe('pnpm')
    expect(opened[0]).toMatchObject({ title: 'pnpm', cwd: '/srv/app' })
  })

  it('refuses a command with control characters, a relative folder and an empty command', async () => {
    const conn = await client(agent)
    await expect(conn.sendRequest('process.run', { cmd: 'echo \x1b[201~rm' })).rejects.toThrow(
      'control characters',
    )
    await expect(conn.sendRequest('process.run', { cmd: 'ls', cwd: 'rel' })).rejects.toThrow(
      'cwd must be absolute',
    )
    await expect(conn.sendRequest('process.run', { cmd: '  ' })).rejects.toThrow('bad-request: cmd')
    expect(opened).toHaveLength(0)
  })

  it('reports not-opened and tracks nothing when no tab could be opened', async () => {
    openFails = true
    const conn = await client(agent)
    await expect(conn.sendRequest('process.run', { cmd: 'ls' })).resolves.toMatchObject({
      ok: false,
      error: 'not-opened',
    })
    await expect(conn.sendRequest('process.list')).resolves.toEqual([])
  })

  it('is refused to an extension, which may still list and read', async () => {
    const pane = await client(agent)
    await start(pane, 'pnpm dev', 'web')
    const ext = await client(extension)
    const target = { targetPaneId: agent.externalId }
    for (const method of ['process.run', 'process.kill', 'process.restart']) {
      await expect(ext.sendRequest(method, { ...target, cmd: 'ls', id: 'web' })).rejects.toThrow(
        'not-available-to-extension',
      )
    }
    const list = await ext.sendRequest<ProcessInfo[]>('process.list', target)
    expect(list.map((p) => p.name)).toEqual(['web'])
  })
})

const SCRIPT_TOKENS: Record<string, Capability[]> = {
  ostia_full: ['process', 'all-workspaces'],
  ostia_no_reach: ['process'],
  ostia_no_process: ['all-workspaces'],
  ostia_scoped: ['process'],
}
setScriptTokenCheck((token) => {
  const caps = SCRIPT_TOKENS[token]
  return caps ? { id: `script_${token}`, caps } : undefined
})

let reachSeq = 0
function freshPane(workspaceId: string): PaneIdentity {
  reachSeq += 1
  return registerPane({ windowId: 'w1', workspaceId, paneId: `reach-pane-${reachSeq}` })
}

describe('process.run in another workspace', () => {
  it('is refused without the all-workspaces grant and opens nothing', async () => {
    const conn = await client(freshPane('ws1'))
    await expect(conn.sendRequest('process.run', { cmd: 'ls', workspace: 'ws2' })).rejects.toThrow(
      'needs-elevation: all-workspaces',
    )
    await expect(
      conn.sendRequest('agent.run', { agent: 'claude', prompt: 'hi', workspace: 'ws2' }),
    ).rejects.toThrow('needs-elevation: all-workspaces')
    expect(opened).toEqual([])
  })

  it('opens the tab in the named workspace once all-workspaces is granted', async () => {
    const me = freshPane('ws1')
    grant(me.externalId, 'all-workspaces')
    const conn = await client(me)
    const started = await conn.sendRequest<Started>('process.run', {
      cmd: 'ls',
      name: 'far',
      workspace: 'ws2',
    })

    expect(opened).toEqual([
      { command: 'ls', workspaceId: 'ws2', backgroundTab: true, pinTitle: true, title: 'far' },
    ])
    const [info] = await conn.sendRequest<ProcessInfo[]>('process.list')
    expect(info).toMatchObject({ name: 'far', paneId: started.paneId })
  })

  it('needs no grant when the named workspace is the caller own', async () => {
    const conn = await client(freshPane('ws1'))
    await conn.sendRequest('process.run', { cmd: 'ls', workspace: 'ws1' })
    expect(opened[0]).toMatchObject({ workspaceId: 'ws1', windowId: 'w1' })
  })

  it('refuses a workspace that is not a non-empty string', async () => {
    const conn = await client(freshPane('ws1'))
    await expect(conn.sendRequest('process.run', { cmd: 'ls', workspace: '' })).rejects.toThrow(
      'bad-request: workspace',
    )
    await expect(conn.sendRequest('process.run', { cmd: 'ls', workspace: 7 })).rejects.toThrow(
      'bad-request: workspace',
    )
  })
})

describe('process.run across a sandbox', () => {
  it('refuses a sandboxed caller another workspace even with all-workspaces, and opens nothing', async () => {
    sandboxedWorkspaces.add('ws1')
    const me = freshPane('ws1')
    grant(me.externalId, 'all-workspaces')
    const conn = await client(me)

    await expect(conn.sendRequest('process.run', { cmd: 'ls', workspace: 'ws2' })).rejects.toThrow(
      'sandboxed: a sandboxed workspace reaches only the sandboxed terminals of its own workspace',
    )
    await expect(
      conn.sendRequest('agent.run', { agent: 'claude', prompt: 'hi', workspace: 'ws2' }),
    ).rejects.toThrow('sandboxed:')
    expect(opened).toEqual([])
  })

  it('still opens a sandboxed caller a tab in its own workspace', async () => {
    sandboxedWorkspaces.add('ws1')
    const conn = await client(freshPane('ws1'))
    await conn.sendRequest('process.run', { cmd: 'ls', workspace: 'ws1' })
    expect(opened[0]).toMatchObject({ workspaceId: 'ws1', windowId: 'w1' })
  })

  it('SBX-C2 ostia process run in a sandboxed workspace runs its command in a sandboxed tab', async () => {
    sandboxedWorkspaces.add('ws1')
    const conn = await client(freshPane('ws1'))
    const cmd = 'cat ~/.ssh/id_ed25519 || echo C2-DENIED; echo proxy=${HTTPS_PROXY:+on}'
    const started = await start(conn, cmd, 'probe')
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ command: cmd, workspaceId: 'ws1', title: 'probe' })
    expect(opened[0]).not.toHaveProperty('hostToken')
    const pane = resolveExternal(started.paneId)
    const paneId = pane?.kind === 'pane' ? pane.paneId : ''
    expect(getByPaneId(paneId)?.workspaceId).toBe('ws1')
  })

  it('opens a tab in a sandboxed workspace as that workspace pane, so its shell spawns wrapped', async () => {
    sandboxedWorkspaces.add('ws2')
    const me = freshPane('ws1')
    grant(me.externalId, 'all-workspaces')
    const conn = await client(me)

    const started = await conn.sendRequest<Started>('process.run', { cmd: 'ls', workspace: 'ws2' })

    expect(opened[0]).not.toHaveProperty('hostToken')
    const pane = resolveExternal(started.paneId)
    const paneId = pane?.kind === 'pane' ? pane.paneId : ''
    expect(getByPaneId(paneId)?.workspaceId).toBe('ws2')
    expect(attachWorkspace(getByPaneId(paneId)?.workspaceId, 'ws1')).toEqual({ ok: false })
  })
})

describe('process.run from a script token', () => {
  it('opens a tab in the named workspace when the token holds process and all-workspaces', async () => {
    const conn = await client({ token: 'ostia_full' } as PaneIdentity)
    const started = await conn.sendRequest<Started>('process.run', {
      cmd: 'claude',
      name: 'line',
      workspace: 'ws2',
    })
    expect(opened).toEqual([
      { command: 'claude', workspaceId: 'ws2', backgroundTab: true, pinTitle: true, title: 'line' },
    ])
    expect(started.name).toBe('line')
  })

  it('has no workspace of its own, so it must name one', async () => {
    const conn = await client({ token: 'ostia_full' } as PaneIdentity)
    await expect(conn.sendRequest('process.run', { cmd: 'ls' })).rejects.toThrow(
      'bad-request: workspace: a script token has no workspace of its own; pass --workspace <id|name>',
    )
    await expect(conn.sendRequest('agent.run', { agent: 'claude', prompt: 'hi' })).rejects.toThrow(
      'needs all-workspaces on the token',
    )
  })

  it('lists, reads, restarts and kills processes of every workspace', async () => {
    const theirs = await start(await client(agent), 'pnpm dev', 'web')
    const conn = await client({ token: 'ostia_full' } as PaneIdentity)
    const mine = await conn.sendRequest<Started>('process.run', {
      cmd: 'make',
      name: 'build',
      workspace: 'ws2',
    })
    const tab = `tab-${tabSeq}`

    const list = await conn.sendRequest<ProcessInfo[]>('process.list')
    expect(list.map((p) => p.name)).toEqual(['web', 'build'])
    await expect(conn.sendRequest('process.info', { id: theirs.id })).resolves.toMatchObject({
      name: 'web',
    })
    emit(tab, `${PROMPT}make\r\n${C}compiling\r\n`)
    await expect(
      conn.sendRequest<ProcessOutput>('process.output', { id: 'build' }),
    ).resolves.toMatchObject({ data: 'compiling\n' })
    await expect(conn.sendRequest('process.restart', { id: mine.id })).resolves.toMatchObject({
      error: 'still-running',
    })
    await expect(conn.sendRequest('process.kill', { id: mine.id })).resolves.toMatchObject({
      ok: true,
    })
    expect(written.filter((w) => w.paneId === tab).map((w) => w.data)).toEqual(['\x03', '\x03'])
    expect(ended).toEqual([tab])
  })

  it('must name the process it reads or stops', async () => {
    const conn = await client({ token: 'ostia_full' } as PaneIdentity)
    for (const method of ['process.info', 'process.output', 'process.kill', 'process.restart']) {
      await expect(conn.sendRequest(method, {})).rejects.toThrow('bad-request: id')
    }
  })

  it('needs process and all-workspaces to see or stop any process', async () => {
    const { id } = await start(await client(agent), 'pnpm dev', 'web')
    const noReach = await client({ token: 'ostia_no_reach' } as PaneIdentity)
    const noProcess = await client({ token: 'ostia_no_process' } as PaneIdentity)
    for (const method of [
      'process.list',
      'process.info',
      'process.output',
      'process.kill',
      'process.restart',
    ]) {
      await expect(noReach.sendRequest(method, { id })).rejects.toThrow(
        'needs-elevation: all-workspaces',
      )
      await expect(noProcess.sendRequest(method, { id })).rejects.toThrow(
        'needs-elevation: process',
      )
    }
    expect(written).toEqual([])
  })

  it('reaches only the processes and workspaces in a limited scope', async () => {
    const theirs = await start(await client(agent), 'pnpm dev', 'web')
    const scoped = await client({ token: 'ostia_scoped' } as PaneIdentity)
    await expect(
      scoped.sendRequest('process.run', { cmd: 'ls', workspace: 'ws1' }),
    ).rejects.toThrow('needs-elevation: all-workspaces')
    const mine = await scoped.sendRequest<Started>('process.run', {
      cmd: 'make',
      name: 'build',
      workspace: 'ws2',
    })
    const list = await scoped.sendRequest<ProcessInfo[]>('process.list')
    expect(list.map((p) => p.name)).toEqual(['build'])
    await expect(scoped.sendRequest('process.info', { id: theirs.id })).resolves.toMatchObject({
      error: 'not-found',
    })
    await expect(scoped.sendRequest('process.kill', { id: theirs.id })).resolves.toMatchObject({
      ok: false,
    })
    await expect(scoped.sendRequest('process.info', { id: mine.id })).resolves.toMatchObject({
      name: 'build',
    })
    expect(written).toEqual([])
  })

  it('is refused without all-workspaces or without process', async () => {
    const noReach = await client({ token: 'ostia_no_reach' } as PaneIdentity)
    await expect(
      noReach.sendRequest('process.run', { cmd: 'ls', workspace: 'ws2' }),
    ).rejects.toThrow('needs-elevation: all-workspaces')
    const noProcess = await client({ token: 'ostia_no_process' } as PaneIdentity)
    await expect(
      noProcess.sendRequest('process.run', { cmd: 'ls', workspace: 'ws2' }),
    ).rejects.toThrow('needs-elevation: process')
    expect(opened).toEqual([])
  })
})

describe('process status', () => {
  it('follows the pane: starting, running at the command start, exited with its exit code', async () => {
    const conn = await client(agent)
    const { id, tab } = await start(conn, 'make build', 'build')
    const status = async (): Promise<ProcessInfo> => conn.sendRequest('process.info', { id })

    emit(tab, PROMPT)
    expect((await status()).status).toBe('starting')
    emit(tab, `make build\r\n${C}compiling\r\n`)
    expect(await status()).toMatchObject({ status: 'running' })
    expect(await status()).not.toHaveProperty('exitCode')
    emit(tab, `failed\r\n${exit(2)}${PROMPT}`)
    expect(await status()).toMatchObject({ status: 'exited', exitCode: 2 })
  })

  it('ignores what the human runs in the tab after the command ended', async () => {
    const conn = await client(agent)
    const { id, tab } = await start(conn, 'true', 'once')
    emit(tab, `${PROMPT}true\r\n${C}${exit(0)}${PROMPT}`)
    emit(tab, `vim\r\n${C}editing`)
    expect(await conn.sendRequest('process.info', { id })).toMatchObject({
      status: 'exited',
      exitCode: 0,
    })
  })

  it('is exited without a code when the shell ends under a running command', async () => {
    const conn = await client(agent)
    const { id, tab } = await start(conn, 'sleep 99', 'nap')
    emit(tab, `${PROMPT}sleep 99\r\n${C}zzz\r\n`)
    const ring = rings.get(tab) as PtyRingBuffer
    registry.shellEnded(tab, (from) => ring.since(from))
    rings.delete(tab)

    const info = await conn.sendRequest<ProcessInfo>('process.info', { id })
    expect(info.status).toBe('exited')
    expect(info).not.toHaveProperty('exitCode')
    const out = await conn.sendRequest<ProcessOutput>('process.output', { id })
    expect(out.data).toBe('zzz\n')
  })

  it('is closed once the human closes its tab, and its output is gone', async () => {
    const conn = await client(agent)
    const { id, tab } = await start(conn, 'pnpm dev', 'web')
    emit(tab, `${PROMPT}pnpm dev\r\n${C}listening\r\n`)
    registry.paneClosed(tab)
    removePane(tab)

    expect(await conn.sendRequest('process.info', { id })).toMatchObject({ status: 'closed' })
    for (const method of ['process.output', 'process.kill', 'process.restart']) {
      await expect(conn.sendRequest(method, { id })).resolves.toMatchObject({
        ok: false,
        error: 'closed',
      })
    }
    expect(registry.isChild('agent-pane', tab)).toBe(false)
  })
})

describe('process.output', () => {
  it('returns only the command output as plain text, not the prompt or later commands', async () => {
    const conn = await client(agent)
    const { id, tab } = await start(conn, 'pnpm test', 'test')
    emit(tab, `secret-before\r\n${PROMPT}pnpm test\r\n${C}`)
    emit(tab, '\x1b[32m✓\x1b[0m one\r\n\x1b[32m✓\x1b[0m two\r\n')
    emit(tab, `${exit(0)}${PROMPT}cat ~/.ssh/id_rsa\r\n${C}PRIVATE KEY\r\n`)

    const out = await conn.sendRequest<ProcessOutput>('process.output', { id })
    expect(out.data).toBe('✓ one\n✓ two\n')
    expect(out.dropped).toBe(false)
  })

  it('resumes from the cursor of the previous read while the command runs', async () => {
    const conn = await client(agent)
    const { id, tab } = await start(conn, 'pnpm dev', 'web')
    emit(tab, `${PROMPT}pnpm dev\r\n${C}first\r\n`)
    const one = await conn.sendRequest<ProcessOutput>('process.output', { id })
    expect(one.data).toBe('first\n')

    emit(tab, 'second\r\n\x1b[3')
    const two = await conn.sendRequest<ProcessOutput>('process.output', {
      id,
      sinceCursor: one.cursor,
    })
    expect(two.data).toBe('second\n')

    emit(tab, '1mthird\x1b[0m\r\n')
    const three = await conn.sendRequest<ProcessOutput>('process.output', {
      id,
      sinceCursor: two.cursor,
    })
    expect(three.data).toBe('third\n')
  })

  it('is empty before the command starts', async () => {
    const conn = await client(agent)
    const { id, tab } = await start(conn, 'ls', 'ls')
    emit(tab, `motd\r\n${PROMPT}`)
    await expect(conn.sendRequest('process.output', { id })).resolves.toEqual({
      data: '',
      cursor: 0,
      dropped: false,
    })
  })

  it('says dropped when the terminal no longer holds the start of the output', () => {
    const ring = new PtyRingBuffer(64)
    const small = new ProcessRegistry({
      ring: () => (from) => ring.since(from),
      workspaceOfPane: () => 'ws1',
      now: () => new Date(0),
    })
    const entry = small.add({
      name: 'noisy',
      cmd: 'yes',
      cwd: undefined,
      workspaceId: 'ws1',
      ownerPaneId: 'agent-pane',
      paneId: 'p',
      externalPaneId: 'ext-p',
    })
    const push = (data: string): void => {
      ring.push(data)
      small.feed('p', data, ring.end)
    }
    push(C)
    for (let i = 0; i < 40; i++) push(`line ${i}\r\n`)
    const out = small.output(entry, 0)
    expect(out?.dropped).toBe(true)
    expect(out?.data.endsWith('line 39\n')).toBe(true)
  })
})

describe('process scope', () => {
  it('shows a pane only the processes of its own workspace', async () => {
    const mine = await client(agent)
    const theirs = await client(stranger)
    const { id } = await start(mine, 'pnpm dev', 'web')

    const near = await client(neighbour)
    expect((await near.sendRequest<ProcessInfo[]>('process.list')).map((p) => p.id)).toEqual([id])
    expect(await theirs.sendRequest('process.list')).toEqual([])
    for (const ref of [id, 'web']) {
      await expect(theirs.sendRequest('process.info', { id: ref })).resolves.toEqual({
        ok: false,
        error: 'not-found',
      })
      await expect(theirs.sendRequest('process.kill', { id: ref })).resolves.toEqual({
        ok: false,
        error: 'not-found',
      })
    }
  })

  it('shows every workspace to a pane holding all-workspaces', async () => {
    const mine = await client(agent)
    const { id } = await start(mine, 'pnpm dev', 'web')
    const elevated = registerPane({ windowId: 'w1', workspaceId: 'ws2', paneId: 'elevated-pane' })
    const conn = await client(elevated)
    grant(elevated.externalId, 'all-workspaces')
    expect((await conn.sendRequest<ProcessInfo[]>('process.list')).map((p) => p.id)).toEqual([id])
    await expect(conn.sendRequest('process.info', { id: 'web' })).resolves.toMatchObject({ id })
  })

  it('resolves a reused name to the newest process', async () => {
    const conn = await client(agent)
    await start(conn, 'pnpm dev', 'web')
    const second = await start(conn, 'pnpm dev --port 2', 'web')
    await expect(conn.sendRequest('process.info', { id: 'web' })).resolves.toMatchObject({
      id: second.id,
    })
  })
})

describe('process.kill', () => {
  it('interrupts the command and leaves the tab and its shell alone', async () => {
    const conn = await client(agent)
    const { id, tab } = await start(conn, 'sleep 30', 'nap')
    emit(tab, `${PROMPT}sleep 30\r\n${C}`)
    onInterrupt = (paneId) => emit(paneId, `^C\r\n${exit(130)}${PROMPT}`)

    await expect(conn.sendRequest('process.kill', { id })).resolves.toEqual({
      ok: true,
      status: 'exited',
      exitCode: 130,
    })
    expect(written).toEqual([{ paneId: tab, data: '\x03' }])
    expect(ended).toEqual([])
  })

  it('ends the shell when the command ignores the interrupt, keeping its output', async () => {
    const conn = await client(agent)
    const { id, tab } = await start(conn, './stubborn', 'stubborn')
    emit(tab, `${PROMPT}./stubborn\r\n${C}ignoring you\r\n`)

    await expect(conn.sendRequest('process.kill', { id })).resolves.toMatchObject({
      ok: true,
      status: 'exited',
    })
    expect(ended).toEqual([tab])
    const out = await conn.sendRequest<ProcessOutput>('process.output', { id })
    expect(out.data).toBe('ignoring you\n')
  })

  it('does nothing to a command that already ended', async () => {
    const conn = await client(agent)
    const { id, tab } = await start(conn, 'true', 'once')
    emit(tab, `${PROMPT}true\r\n${C}${exit(0)}${PROMPT}`)
    await expect(conn.sendRequest('process.kill', { id })).resolves.toEqual({
      ok: true,
      status: 'exited',
    })
    expect(written).toEqual([])
  })
})

describe('process.restart', () => {
  it('stops the command and runs the same line again in the same tab', async () => {
    const conn = await client(agent)
    const cmd = `node server.js --title 'my app'`
    const { id, tab, paneId } = await start(conn, cmd, 'server')
    emit(tab, `${PROMPT}${cmd}\r\n${C}up 1\r\n`)
    onInterrupt = (pane) => emit(pane, `${exit(130)}${PROMPT}`)

    await expect(conn.sendRequest('process.restart', { id })).resolves.toEqual({
      id,
      name: 'server',
      paneId,
    })
    expect(reruns).toEqual([{ paneId: tab, command: cmd }])
    expect(opened).toHaveLength(1)
    expect(await conn.sendRequest('process.info', { id })).toMatchObject({ status: 'starting' })

    emit(tab, `${cmd}\r\n${C}up 2\r\n`)
    expect(await conn.sendRequest('process.info', { id })).toMatchObject({ status: 'running' })
    const out = await conn.sendRequest<ProcessOutput>('process.output', { id })
    expect(out.data).toBe('up 2\n')
  })

  it('types nothing while the command keeps running', async () => {
    const conn = await client(agent)
    const { id, tab } = await start(conn, './stubborn', 'stubborn')
    emit(tab, `${PROMPT}./stubborn\r\n${C}`)
    await expect(conn.sendRequest('process.restart', { id })).resolves.toMatchObject({
      ok: false,
      error: 'still-running',
    })
    expect(reruns).toEqual([])
    expect(ended).toEqual([])
  })

  it('refuses when the tab has no shell left', async () => {
    const conn = await client(agent)
    const { id, tab } = await start(conn, 'true', 'once')
    emit(tab, `${PROMPT}true\r\n${C}${exit(0)}`)
    rings.delete(tab)
    await expect(conn.sendRequest('process.restart', { id })).resolves.toMatchObject({
      ok: false,
      error: 'no-shell',
    })
    expect(reruns).toEqual([])
  })
})

describe('ProcessRegistry', () => {
  it('knows which pane opened a process tab', async () => {
    const conn = await client(agent)
    const { tab } = await start(conn, 'pnpm dev', 'web')
    expect(registry.isChild('agent-pane', tab)).toBe(true)
    expect(registry.isChild('neighbour-pane', tab)).toBe(false)
  })

  it('forgets a workspace when it closes', async () => {
    const conn = await client(agent)
    await start(conn, 'pnpm dev', 'web')
    registry.workspaceClosed('ws1')
    expect(registry.list(null)).toEqual([])
  })

  it('stops waiting for an exit when the grace period passes', async () => {
    vi.useFakeTimers()
    try {
      const local = new ProcessRegistry({
        ring: () => undefined,
        workspaceOfPane: () => 'ws1',
        now: () => new Date(0),
      })
      const entry = local.add({
        name: 'x',
        cmd: 'x',
        cwd: undefined,
        workspaceId: 'ws1',
        ownerPaneId: 'a',
        paneId: 'p',
        externalPaneId: 'ext-p',
      })
      const waited = local.waitForExit(entry, 1000)
      await vi.advanceTimersByTimeAsync(1000)
      await expect(waited).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('KSH-C37 takes back a process tab whose shell was kept, still running, and sees it end', () => {
    const changes: string[] = []
    const local = new ProcessRegistry({
      ring: () => undefined,
      workspaceOfPane: () => 'ws1',
      now: () => new Date(0),
      onChange: (entry) => changes.push(`${entry.name}:${entry.status}`),
    })
    const entry = local.adopt(
      {
        name: 'web',
        cmd: 'pnpm dev',
        cwd: '/w',
        workspaceId: 'ws1',
        ownerPaneId: 'agent-pane',
        paneId: 'tab-1',
        externalPaneId: 'ext-tab-1',
        startedAt: '2026-10-05T00:00:00.000Z',
        status: 'running',
      },
      120,
    )
    expect(local.info(entry)).toMatchObject({ name: 'web', status: 'running', paneId: 'ext-tab-1' })
    expect(local.isChild('agent-pane', 'tab-1')).toBe(true)
    expect(local.forPane('tab-1')).toBe(entry)
    local.feed('tab-1', `${exit(0)}`, 140)
    expect(local.info(entry).status).toBe('exited')
    expect(changes).toEqual(['web:exited'])
  })
})
