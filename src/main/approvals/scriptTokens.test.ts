import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
import { type Capability, DEFAULT_CAPABILITIES } from '../../shared/capabilities'
import type { ApprovalOutcome } from '../../shared/permissions/approvals'
import { SCRIPT_CAPABILITIES, type ScriptTokenScope } from '../../shared/permissions/scriptTokens'
import { emptyWorkspaceSandbox } from '../../shared/sandbox/sandbox'
import type { CommandResult } from '../../shared/types'
import type { ReachListing } from './reach'

let answer: ApprovalOutcome = 'deny'
const request = vi.fn(async () => answer)

vi.mock('./approvals', () => ({ approvals: () => ({ request }) }))

const { setCapFilter, setScriptTokenCheck } = await import('../control/controlAuth')
const { SCRIPT_COMMANDS } = await import('../control/commandArgs')
const { registerControlMethod, registerControlServer, stopControlServer } = await import(
  '../control/controlServer'
)
const { markManager, registerPane } = await import('../control/idRegistry')
const { registerDocsMethods } = await import('../control/docs')
const { registerPaneListMethods } = await import('../panes/paneList')
const { createReach } = await import('./reach')
const {
  checkScriptToken,
  createScriptToken,
  listScriptTokens,
  parseTokenRequest,
  recordCreatedWorkspace,
  registerScriptTokenMethods,
  retireLegacyScriptTokens,
  revokeScriptToken,
  scriptTokenScope,
  setUserPresenceCheck,
  verifyScriptToken,
} = await import('./scriptTokens')

const dirs: string[] = []
let storeFile = ''
let retiredFile = ''
let listing: ReachListing = { workspaces: [], groups: [] }

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'script-tokens-'))
  dirs.push(dir)
  return dir
}

registerScriptTokenMethods({
  path: () => storeFile,
  retiredPath: () => retiredFile,
  listing: async () => listing,
})
registerDocsMethods({ extensions: () => [] })
setScriptTokenCheck((token) =>
  checkScriptToken({ path: storeFile, retiredPath: retiredFile }, token),
)
registerControlMethod('test.scriptsOpen', {
  cap: 'read-board',
  scripts: true,
  handler: (_params, ctx) => ({ kind: ctx.identity.kind }),
})
registerControlMethod('test.scriptsWrite', {
  cap: 'type-other-pane',
  scripts: true,
  handler: () => ({ ok: true }),
})
registerControlMethod('test.panesOnly', {
  callers: 'all',
  handler: () => ({ ok: true }),
})

const ALL = { kind: 'all' } as const

let socketPath = ''
let seq = 0
const clients: MessageConnection[] = []

async function client(token: string): Promise<MessageConnection> {
  const socket = createConnection(socketPath)
  const conn = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  conn.listen()
  clients.push(conn)
  await conn.sendRequest('hello', { token })
  return conn
}

beforeEach(() => {
  seq += 1
  const dir = tempDir()
  storeFile = join(dir, 'script-tokens-v2.json')
  retiredFile = join(dir, 'retired-script-tokens.json')
  listing = { workspaces: [], groups: [] }
  socketPath = join(tmpdir(), `ostia-script-${process.pid}-${seq}.sock`)
  registerControlServer(
    {
      execCommand: async () => ({ ok: true }) as CommandResult,
      listCommandsFor: () => [],
      getTerminalState: () => undefined,
      isSandboxed: () => false,
    },
    socketPath,
  )
  answer = 'deny'
  request.mockClear()
  setCapFilter(() => true)
})

afterEach(() => {
  for (const c of clients.splice(0)) c.dispose()
  stopControlServer()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('script token store', () => {
  it('keeps only a hash on disk, private to the user, and verifies the token', () => {
    const created = createScriptToken(storeFile, 'dispatcher', ['read-board', 'type-other-pane'])

    expect(created.token).toMatch(/^ostia_[0-9a-f]{64}$/)
    expect(created.id).toMatch(/^script_/)
    const raw = readFileSync(storeFile, 'utf8')
    expect(raw).not.toContain(created.token)
    expect(statSync(storeFile).mode & 0o777).toBe(0o600)
    expect(verifyScriptToken(storeFile, created.token)).toMatchObject({
      id: created.id,
      caps: ['read-board', 'type-other-pane'],
    })
    const last = created.token.endsWith('0') ? '1' : '0'
    expect(verifyScriptToken(storeFile, `${created.token.slice(0, -1)}${last}`)).toBeUndefined()
    expect(verifyScriptToken(storeFile, created.token.slice(6))).toBeUndefined()
  })

  it('lists tokens without their values and revokes them', () => {
    const created = createScriptToken(storeFile, 'board', ['read-board'])
    expect(listScriptTokens(storeFile)).toEqual([
      {
        id: created.id,
        name: 'board',
        caps: ['read-board'],
        scope: { kind: 'limited', groups: [], workspaces: [], ownWorkspaces: false },
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        expiresAt: expect.any(String),
        lastUsedAt: null,
        source: 'cli',
      },
    ])
    expect(JSON.stringify(listScriptTokens(storeFile))).not.toContain('hash')
    expect(revokeScriptToken(storeFile, created.id)).toBe(true)
    expect(revokeScriptToken(storeFile, created.id)).toBe(false)
    expect(verifyScriptToken(storeFile, created.token)).toBeUndefined()
  })

  it('drops capabilities a script token may not hold when the file was edited by hand', () => {
    const created = createScriptToken(storeFile, 'x', ['read-board'])
    const store = JSON.parse(readFileSync(storeFile, 'utf8'))
    store[created.id].caps = ['read-board', 'destructive', 'settings-write']
    writeFileSync(storeFile, JSON.stringify(store))
    expect(verifyScriptToken(storeFile, created.token)?.caps).toEqual(['read-board'])
  })

  it('refuses bad names and capabilities outside the script set', () => {
    expect(parseTokenRequest({ name: ' cron ', caps: ['read-board'], scope: ALL })).toEqual({
      name: 'cron',
      caps: ['read-board'],
      scope: ALL,
      expires: '90d',
    })
    expect(() => parseTokenRequest({ name: '', caps: ['read-board'] })).toThrow('name')
    expect(() => parseTokenRequest({ name: 'a\nb', caps: ['read-board'] })).toThrow('name')
    expect(() => parseTokenRequest({ name: 'x', caps: [] })).toThrow('caps')
    expect(() => parseTokenRequest({ name: 'x', caps: ['destructive'] })).toThrow('can hold only')
  })

  it('lets a token hold process, send-other-pane, kill-pane and notify, but never shell', () => {
    expect(
      parseTokenRequest({
        name: 'cron',
        caps: ['notify', 'process', 'send-other-pane', 'all-workspaces', 'kill-pane'],
      }),
    ).toEqual({
      name: 'cron',
      caps: ['process', 'send-other-pane', 'kill-pane', 'notify'],
      scope: ALL,
      expires: '90d',
    })
    expect(() => parseTokenRequest({ name: 'x', caps: ['shell'] })).toThrow('can hold only')
    expect(() => parseTokenRequest({ name: 'x', caps: ['destructive'] })).toThrow('can hold only')
  })
})

describe('script callers on the control socket', () => {
  it('reaches only methods open to scripts, with exactly the token capabilities', async () => {
    const { token } = createScriptToken(storeFile, 'board', ['read-board'])
    const conn = await client(token)

    expect(await conn.sendRequest('whoami')).toMatchObject({ kind: 'script' })
    expect(await conn.sendRequest('test.scriptsOpen')).toEqual({ kind: 'script' })
    await expect(conn.sendRequest('test.scriptsWrite')).rejects.toThrow(
      'needs-elevation: type-other-pane',
    )
    await expect(conn.sendRequest('test.panesOnly')).rejects.toThrow('not-available-to-script')
    expect(request).not.toHaveBeenCalled()
  })

  it('reads the CLI reference', async () => {
    const conn = await client(createScriptToken(storeFile, 'docs', ['read-board']).token)
    const res = await conn.sendRequest<{ cli: string }>('docs')
    expect(res.cli).toContain('Scripts reach only these methods')
    expect(res.cli).not.toContain('Manager only')
  })

  it('refuses an unknown token and cuts a revoked one off at once', async () => {
    const socket = createConnection(socketPath)
    const bad = createMessageConnection(
      new StreamMessageReader(socket),
      new StreamMessageWriter(socket),
    )
    bad.listen()
    clients.push(bad)
    await expect(bad.sendRequest('hello', { token: 'ostia_nope' })).rejects.toThrow(
      'invalid or missing token',
    )

    const created = createScriptToken(storeFile, 'cron', ['read-board'])
    const conn = await client(created.token)
    await conn.sendRequest('test.scriptsOpen')
    const owner = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'token-owner' })
    answer = 'once'
    const admin = await client(owner.token)
    await admin.sendRequest('token.revoke', { id: created.id })
    await expect(conn.sendRequest('test.scriptsOpen')).rejects.toThrow('unknown identity')
  })

  it('creates a token from a pane only after the human approves it', async () => {
    const pane = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'token-maker' })
    const conn = await client(pane.token)

    await expect(
      conn.sendRequest('token.create', { name: 'cron', caps: ['type-other-pane'], scope: ALL }),
    ).rejects.toThrow('denied: settings-write, type-other-pane, all-workspaces')
    expect(listScriptTokens(storeFile)).toEqual([])

    answer = 'once'
    const created = await conn.sendRequest<{ token: string; caps: string[] }>('token.create', {
      name: 'cron',
      caps: ['read-board'],
      scope: ALL,
    })
    expect(created.caps).toEqual(['read-board'])
    expect(request).toHaveBeenCalledTimes(2)
    const script = await client(created.token)
    expect(await script.sendRequest('test.scriptsOpen')).toEqual({ kind: 'script' })
  })

  it('does not let a script manage tokens', async () => {
    const { token } = createScriptToken(storeFile, 'board', ['read-board'])
    const conn = await client(token)
    await expect(
      conn.sendRequest('token.create', { name: 'more', caps: ['type-other-pane'] }),
    ).rejects.toThrow('not-available-to-script')
  })
})

describe('script tokens on command.exec', () => {
  const descriptor = (id: string, capabilities: string[], target = 'active') => ({
    id,
    title: id,
    category: null,
    hidden: false,
    argsSchema: null,
    resultSchema: null,
    capabilities,
    target,
  })
  const COMMANDS = [
    descriptor('workspace.new', DEFAULT_CAPABILITIES, 'none'),
    descriptor('pane.close', ['kill-pane']),
    descriptor('tab.new', []),
    descriptor('workspace.group', ['drive-self']),
    descriptor('workspace.ungroup', ['drive-self']),
    descriptor('workspace.describe', ['drive-self']),
    descriptor('workspace.groupColor', ['drive-self'], 'none'),
    descriptor('workspace.newScratch', DEFAULT_CAPABILITIES, 'none'),
    descriptor('workspace.hibernateAgents', ['kill-pane']),
    descriptor('workspace.hibernateGroupAgents', ['kill-pane']),
    descriptor('workspace.resumeAgents', ['type-other-pane']),
    descriptor('workspace.resumeGroupAgents', ['type-other-pane']),
    descriptor('workspace.deleteGroup', DEFAULT_CAPABILITIES),
    descriptor('settings.set', ['settings-write']),
    descriptor('workspace.goto', DEFAULT_CAPABILITIES),
  ]
  const WS2 = { workspaceId: 'ws2', paneId: null }
  const inWs2 = { windowId: 'w1', workspaceId: 'ws2', paneId: null }
  let executed: { target: unknown; id: string; args: unknown }[] = []

  beforeEach(() => {
    executed = []
    stopControlServer()
    registerControlServer(
      {
        execCommand: async (target, id, args) => {
          executed.push({ target, id, args })
          return { ok: true, result: { workspaceId: 'ws-new' } } as CommandResult
        },
        listCommandsFor: (windowId) => (windowId === 'w1' ? (COMMANDS as never) : []),
        getTerminalState: (paneId) =>
          paneId === 'inner-info'
            ? { paneId, generation: 1, cwd: '/w', running: true, blockCount: 2 }
            : undefined,
        isSandboxed: () => false,
        windowOfWorkspace: (workspaceId) => (workspaceId === 'ws2' ? 'w1' : undefined),
        primaryWindow: () => 'w1',
      },
      socketPath,
    )
  })

  it('creates a workspace in the primary window when the token holds all-workspaces', async () => {
    const { token } = createScriptToken(storeFile, 'f5', ['all-workspaces'])
    const conn = await client(token)
    const res = await conn.sendRequest<CommandResult>('command.exec', {
      id: 'workspace.new',
      args: { name: 'W-two', focus: false },
    })
    expect(res).toEqual({ ok: true, result: { workspaceId: 'ws-new' } })
    expect(executed).toEqual([
      {
        target: { windowId: 'w1', workspaceId: '', paneId: null },
        id: 'workspace.new',
        args: { name: 'W-two', focus: false },
      },
    ])
  })

  it('refuses workspace.new without all-workspaces and never asks the human', async () => {
    const { token } = createScriptToken(storeFile, 'f5', ['process'])
    const conn = await client(token)
    await expect(conn.sendRequest('command.exec', { id: 'workspace.new' })).rejects.toThrow(
      'needs-elevation: all-workspaces',
    )
    await expect(
      conn.sendRequest('command.exec', { id: 'workspace.new', args: { focus: false } }),
    ).rejects.toThrow('needs-elevation: all-workspaces')
    expect(executed).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })

  it('lets an in-app pane token run workspace.new with its default capabilities', async () => {
    const me = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'pane-ws-new' })
    const conn = await client(me.token)
    const res = await conn.sendRequest<CommandResult>('command.exec', { id: 'workspace.new' })
    expect(res).toEqual({ ok: true, result: { workspaceId: 'ws-new' } })
    expect(request).not.toHaveBeenCalled()
  })

  it('closes a pane named by its pane.list id, in that pane workspace, with kill-pane', async () => {
    const target = registerPane({ windowId: 'w1', workspaceId: 'ws2', paneId: 'inner-close-1' })
    const { token } = createScriptToken(storeFile, 'f5', ['all-workspaces', 'kill-pane'])
    const conn = await client(token)
    await conn.sendRequest('command.exec', {
      id: 'pane.close',
      args: { paneId: target.externalId },
    })
    expect(executed).toEqual([
      {
        target: { windowId: 'w1', workspaceId: 'ws2', paneId: null },
        id: 'pane.close',
        args: { paneId: 'inner-close-1' },
      },
    ])
  })

  it('refuses pane.close without kill-pane or without all-workspaces', async () => {
    const target = registerPane({ windowId: 'w1', workspaceId: 'ws2', paneId: 'inner-close-2' })
    const noKill = await client(createScriptToken(storeFile, 'a', ['all-workspaces']).token)
    await expect(
      noKill.sendRequest('command.exec', { id: 'pane.close', args: { paneId: target.externalId } }),
    ).rejects.toThrow('needs-elevation: kill-pane')
    const noReach = await client(createScriptToken(storeFile, 'b', ['kill-pane']).token)
    await expect(
      noReach.sendRequest('command.exec', {
        id: 'pane.close',
        args: { paneId: target.externalId },
      }),
    ).rejects.toThrow('needs-elevation: all-workspaces')
    expect(executed).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses pane.close for an id no pane has, and every other command', async () => {
    const conn = await client(
      createScriptToken(storeFile, 'c', ['all-workspaces', 'kill-pane']).token,
    )
    await expect(
      conn.sendRequest('command.exec', { id: 'pane.close', args: { paneId: 'no-such-pane' } }),
    ).rejects.toThrow('unknown-pane: no-such-pane')
    await expect(conn.sendRequest('command.exec', { id: 'pane.close' })).rejects.toThrow(
      'needs {"paneId"',
    )
    await expect(conn.sendRequest('command.exec', { id: 'tab.new' })).rejects.toThrow(
      'not-available-to-script',
    )
    expect(executed).toEqual([])
  })

  it.each([
    ['workspace.group', { name: 'AurigaX' }],
    ['workspace.ungroup', undefined],
    ['workspace.describe', { text: 'tracker#24' }],
  ])('runs %s on the workspace it names, with all-workspaces', async (id, args) => {
    const conn = await client(createScriptToken(storeFile, 'ceo', ['all-workspaces']).token)
    await expect(conn.sendRequest('command.exec', { id, args, target: WS2 })).resolves.toEqual({
      ok: true,
      result: { workspaceId: 'ws-new' },
    })
    expect(executed).toEqual([{ target: inWs2, id, args }])
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    ['workspace.groupColor', { group: 'AurigaX', color: 'blue' }],
    ['workspace.newScratch', undefined],
  ])('runs %s, which needs no workspace, in the primary window', async (id, args) => {
    const conn = await client(createScriptToken(storeFile, 'ceo', ['all-workspaces']).token)
    await conn.sendRequest('command.exec', { id, args })
    expect(executed).toEqual([
      { target: { windowId: 'w1', workspaceId: '', paneId: null }, id, args },
    ])
  })

  it.each<[string, Capability]>([
    ['workspace.hibernateAgents', 'kill-pane'],
    ['workspace.hibernateGroupAgents', 'kill-pane'],
    ['workspace.resumeAgents', 'type-other-pane'],
    ['workspace.resumeGroupAgents', 'type-other-pane'],
  ])('runs %s on a named workspace only with %s and all-workspaces', async (id, cap) => {
    const without = await client(createScriptToken(storeFile, 'a', ['all-workspaces']).token)
    await expect(without.sendRequest('command.exec', { id, target: WS2 })).rejects.toThrow(
      `needs-elevation: ${cap}`,
    )
    const noReach = await client(createScriptToken(storeFile, 'b', [cap]).token)
    await expect(noReach.sendRequest('command.exec', { id, target: WS2 })).rejects.toThrow(
      'needs-elevation: all-workspaces',
    )
    expect(executed).toEqual([])
    const full = await client(createScriptToken(storeFile, 'c', ['all-workspaces', cap]).token)
    await full.sendRequest('command.exec', { id, target: WS2 })
    expect(executed).toEqual([{ target: inWs2, id }])
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    'workspace.group',
    'workspace.ungroup',
    'workspace.describe',
    'workspace.hibernateAgents',
    'workspace.hibernateGroupAgents',
    'workspace.resumeAgents',
    'workspace.resumeGroupAgents',
  ])('refuses %s without a workspace instead of picking one', async (id) => {
    const conn = await client(
      createScriptToken(storeFile, 'c', ['all-workspaces', 'kill-pane', 'type-other-pane']).token,
    )
    await expect(conn.sendRequest('command.exec', { id, args: { name: 'x' } })).rejects.toThrow(
      `bad-request: ${id} from a script token needs a workspace`,
    )
    expect(executed).toEqual([])
  })

  it('refuses a workspace command without all-workspaces', async () => {
    const conn = await client(createScriptToken(storeFile, 'k', ['kill-pane']).token)
    await expect(
      conn.sendRequest('command.exec', { id: 'workspace.group', args: { name: 'x' }, target: WS2 }),
    ).rejects.toThrow('needs-elevation: all-workspaces')
    expect(executed).toEqual([])
  })

  it.each(['settings.set', 'workspace.deleteGroup', 'workspace.goto', 'tab.new'])(
    'still refuses %s to a token holding every script capability',
    async (id) => {
      const conn = await client(createScriptToken(storeFile, 'all', [...SCRIPT_CAPABILITIES]).token)
      await expect(conn.sendRequest('command.exec', { id, target: WS2 })).rejects.toThrow(
        'not-available-to-script',
      )
      expect(executed).toEqual([])
    },
  )

  it('lists only the commands open to scripts, from the primary window', async () => {
    const conn = await client(createScriptToken(storeFile, 'l', ['read-board']).token)
    const list = await conn.sendRequest<{ id: string }[]>('command.list')
    expect(list.map((d) => d.id).sort()).toEqual([...SCRIPT_COMMANDS].sort())
  })

  it('reads the terminal state of a named pane, never its own or the manager', async () => {
    const pane = registerPane({ windowId: 'w1', workspaceId: 'ws2', paneId: 'inner-info' })
    registerPane({ windowId: 'w1', workspaceId: 'ws2', paneId: 'inner-info-mgr' })
    const manager = markManager('inner-info-mgr')
    const conn = await client(createScriptToken(storeFile, 'i', ['read-board']).token)
    await expect(conn.sendRequest('pane.info', { paneId: pane.externalId })).resolves.toMatchObject(
      {
        cwd: '/w',
        running: true,
      },
    )
    await expect(conn.sendRequest('pane.info', {})).rejects.toThrow('bad-request: paneId')
    await expect(conn.sendRequest('pane.info', { paneId: manager?.externalId })).resolves.toBeNull()
    const blind = await client(createScriptToken(storeFile, 'j', ['process']).token)
    await expect(blind.sendRequest('pane.info', { paneId: pane.externalId })).rejects.toThrow(
      'needs-elevation: read-board',
    )
  })
})

const WORK = 'g-work'
const OTHER = 'g-other'

function baseListing(): ReachListing {
  return {
    workspaces: [
      { workspaceId: 'wsA', name: 'alpha', workDir: '/w/a', groupId: WORK },
      { workspaceId: 'wsB', name: 'beta', workDir: '/w/b', groupId: WORK },
      { workspaceId: 'wsC', name: 'gamma', workDir: '/w/c', groupId: OTHER },
      { workspaceId: 'wsD', name: 'delta', workDir: '/w/d' },
      { workspaceId: 'wsE', name: 'epsilon', workDir: '/w/e' },
    ],
    groups: [
      { groupId: WORK, name: 'Work' },
      { groupId: OTHER, name: 'Other' },
    ],
  }
}

function limited(
  groups: string[],
  workspaces: string[] = [],
  ownWorkspaces = false,
): ScriptTokenScope {
  return { kind: 'limited', groups, workspaces, ownWorkspaces }
}

const scopedReach = createReach({
  mode: () => 'project',
  home: '/nonexistent-home',
  workDir: (id) => listing.workspaces.find((w) => w.workspaceId === id)?.workDir,
  isScratch: () => false,
  hasManager: () => false,
  sandbox: () => emptyWorkspaceSandbox(),
  workspaces: async () => structuredClone(listing),
  ask: () => null,
  agentGroupsChanged: () => {},
  scriptScope: (id) => scriptTokenScope(storeFile, id),
  scriptCreated: (id, workspaceId) => recordCreatedWorkspace(storeFile, id, workspaceId),
})

const paneA = registerPane({ windowId: 'w1', workspaceId: 'wsA', paneId: 'scoped-pane-a' })
const paneC = registerPane({ windowId: 'w1', workspaceId: 'wsC', paneId: 'scoped-pane-c' })

registerPaneListMethods({
  execCommand: async (_target, id) => {
    if (id === 'pane.list') {
      return {
        ok: true,
        result: [paneA, paneC].map((p) => ({
          paneId: p.paneId,
          workspaceId: p.workspaceId,
          kind: 'terminal',
          title: p.paneId,
        })),
      } as CommandResult
    }
    if (id === 'workspace.list') {
      return {
        ok: true,
        result: listing.workspaces.map((w) => ({ ...w, kind: 'normal', state: 'idle' })),
      } as CommandResult
    }
    return {
      ok: true,
      result: listing.groups.map((g) => ({
        ...g,
        collapsed: false,
        workspaceIds: listing.workspaces
          .filter((w) => w.groupId === g.groupId)
          .map((w) => w.workspaceId),
      })),
    } as CommandResult
  },
  getTerminalState: () => undefined,
  ptyPid: () => undefined,
  windowIds: () => ['w1'],
  waking: () => false,
  reach: scopedReach,
})

registerControlMethod('test.ensureReach', {
  scripts: true,
  handler: async (params, ctx) => {
    const { workspaceId } = params as { workspaceId: string }
    await scopedReach.ensure(ctx, workspaceId, 'test.ensureReach', workspaceId)
    return { ok: true }
  },
})

describe('scoped script tokens', () => {
  const descriptor = (id: string, capabilities: string[], target = 'active') => ({
    id,
    title: id,
    category: null,
    hidden: false,
    argsSchema: null,
    resultSchema: null,
    capabilities,
    target,
  })
  const COMMANDS = [
    descriptor('workspace.new', DEFAULT_CAPABILITIES, 'none'),
    descriptor('workspace.describe', ['drive-self']),
    descriptor('workspace.group', ['drive-self']),
    descriptor('workspace.groupColor', ['drive-self'], 'none'),
    descriptor('workspace.newScratch', DEFAULT_CAPABILITIES, 'none'),
    descriptor('workspace.hibernateAgents', ['kill-pane']),
    descriptor('workspace.hibernateGroupAgents', ['kill-pane']),
  ]
  let executed: { target: unknown; id: string }[] = []
  let made = 0

  beforeEach(() => {
    executed = []
    listing = baseListing()
    stopControlServer()
    registerControlServer(
      {
        execCommand: async (target, id, args) => {
          executed.push({ target, id })
          const a = (args ?? {}) as { group?: string; name?: string }
          if (id === 'workspace.new') {
            const workspaceId = `ws-new-${++made}`
            const groupId = listing.groups.find((g) => g.name === a.group)?.groupId
            listing.workspaces.push({
              workspaceId,
              name: workspaceId,
              workDir: '/w/new',
              ...(groupId ? { groupId } : {}),
            })
            return { ok: true, result: { workspaceId } } as CommandResult
          }
          if (id === 'workspace.group') {
            const ws = listing.workspaces.find((w) => w.workspaceId === target.workspaceId)
            const groupId = listing.groups.find((g) => g.name === a.name)?.groupId
            if (ws && groupId) ws.groupId = groupId
          }
          return { ok: true } as CommandResult
        },
        listCommandsFor: () => COMMANDS as never,
        getTerminalState: (paneId) => ({ paneId, generation: 1, running: true, blockCount: 0 }),
        isSandboxed: () => false,
        windowOfWorkspace: () => 'w1',
        primaryWindow: () => 'w1',
        byAgent: scopedReach.byAgent,
        reach: scopedReach,
      },
      socketPath,
    )
  })

  const on = (workspaceId: string) => ({ workspaceId, paneId: null })

  it('reaches the workspaces of its groups and the ones it names, without all-workspaces', async () => {
    const { token } = createScriptToken(storeFile, 'work', ['read-board'], {
      scope: limited([WORK], ['wsD']),
    })
    const conn = await client(token)
    for (const ws of ['wsA', 'wsB', 'wsD']) {
      await conn.sendRequest('command.exec', { id: 'workspace.describe', target: on(ws) })
      await conn.sendRequest('test.ensureReach', { workspaceId: ws })
    }
    expect(executed.map((e) => (e.target as { workspaceId: string }).workspaceId)).toEqual([
      'wsA',
      'wsB',
      'wsD',
    ])
    expect(request).not.toHaveBeenCalled()
  })

  it.each(['wsC', 'wsE'])('refuses %s, outside its scope, with needs-elevation', async (ws) => {
    const { token } = createScriptToken(storeFile, 'work', ['read-board', 'kill-pane'], {
      scope: limited([WORK], ['wsD']),
    })
    const conn = await client(token)
    await expect(
      conn.sendRequest('command.exec', { id: 'workspace.describe', target: on(ws) }),
    ).rejects.toThrow('needs-elevation: all-workspaces')
    await expect(
      conn.sendRequest('command.exec', { id: 'workspace.hibernateAgents', target: on(ws) }),
    ).rejects.toThrow('needs-elevation: all-workspaces')
    await expect(conn.sendRequest('test.ensureReach', { workspaceId: ws })).rejects.toThrow(
      'needs-elevation: all-workspaces',
    )
    expect(executed).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })

  it('still needs the action capability inside its scope', async () => {
    const { token } = createScriptToken(storeFile, 'work', ['read-board'], {
      scope: limited([WORK]),
    })
    const conn = await client(token)
    await expect(
      conn.sendRequest('command.exec', { id: 'workspace.hibernateAgents', target: on('wsA') }),
    ).rejects.toThrow('needs-elevation: kill-pane')
    expect(executed).toEqual([])
  })

  it('does not count a workspace an agent moved into its group', async () => {
    const admin = await client(createScriptToken(storeFile, 'admin', ['all-workspaces']).token)
    await admin.sendRequest('command.exec', {
      id: 'workspace.group',
      args: { name: 'Work' },
      target: on('wsE'),
    })
    expect(listing.workspaces.find((w) => w.workspaceId === 'wsE')?.groupId).toBe(WORK)
    const { token } = createScriptToken(storeFile, 'work', ['read-board'], {
      scope: limited([WORK]),
    })
    const conn = await client(token)
    await expect(conn.sendRequest('test.ensureReach', { workspaceId: 'wsE' })).rejects.toThrow(
      'needs-elevation: all-workspaces',
    )
    const names = (await conn.sendRequest<{ workspaceId: string }[]>('workspace.list')).map(
      (w) => w.workspaceId,
    )
    expect(names).toEqual(['wsA', 'wsB'])
  })

  it('creates a workspace in a group of its scope and then reaches it', async () => {
    const { token, id } = createScriptToken(storeFile, 'maker', ['read-board'], {
      scope: limited([WORK], [], true),
    })
    const conn = await client(token)
    await conn.sendRequest('command.exec', { id: 'workspace.new', args: { group: 'Work' } })
    expect(scriptTokenScope(storeFile, id)?.created).toEqual([`ws-new-${made}`])
    const createdId = `ws-new-${made}`
    await conn.sendRequest('command.exec', { id: 'workspace.describe', target: on(createdId) })
    await expect(
      conn.sendRequest('command.exec', { id: 'workspace.new', args: { group: 'Other' } }),
    ).rejects.toThrow('needs-elevation: all-workspaces')
    await expect(conn.sendRequest('command.exec', { id: 'workspace.new' })).rejects.toThrow(
      'needs-elevation: all-workspaces',
    )
    await expect(conn.sendRequest('command.exec', { id: 'workspace.newScratch' })).rejects.toThrow(
      'needs-elevation: all-workspaces',
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('creates nothing when the scope leaves out the workspaces it creates', async () => {
    const { token } = createScriptToken(storeFile, 'maker', ['read-board'], {
      scope: limited([WORK]),
    })
    const conn = await client(token)
    await expect(
      conn.sendRequest('command.exec', { id: 'workspace.new', args: { group: 'Work' } }),
    ).rejects.toThrow('needs-elevation: all-workspaces')
    expect(executed).toEqual([])
  })

  it('runs group-wide commands only when the group itself is in scope', async () => {
    const one = await client(
      createScriptToken(storeFile, 'one', ['kill-pane'], { scope: limited([], ['wsA']) }).token,
    )
    await expect(
      one.sendRequest('command.exec', { id: 'workspace.hibernateGroupAgents', target: on('wsA') }),
    ).rejects.toThrow('needs-elevation: all-workspaces')
    const group = await client(
      createScriptToken(storeFile, 'group', ['kill-pane'], { scope: limited([WORK]) }).token,
    )
    await group.sendRequest('command.exec', {
      id: 'workspace.hibernateGroupAgents',
      target: on('wsA'),
    })
    await group.sendRequest('command.exec', {
      id: 'workspace.groupColor',
      args: { group: 'Work', color: 'blue' },
    })
    await expect(
      group.sendRequest('command.exec', {
        id: 'workspace.groupColor',
        args: { group: 'Other', color: 'blue' },
      }),
    ).rejects.toThrow('needs-elevation: all-workspaces')
    expect(executed.map((e) => e.id)).toEqual([
      'workspace.hibernateGroupAgents',
      'workspace.groupColor',
    ])
  })

  it('lists only the panes, workspaces and groups in its scope', async () => {
    const { token } = createScriptToken(storeFile, 'board', ['read-board'], {
      scope: limited([], ['wsA']),
    })
    const conn = await client(token)
    const panes = await conn.sendRequest<{ paneId: string }[]>('pane.list')
    expect(panes.map((p) => p.paneId)).toEqual([paneA.externalId])
    const workspaces = await conn.sendRequest<{ workspaceId: string }[]>('workspace.list')
    expect(workspaces.map((w) => w.workspaceId)).toEqual(['wsA'])
    const groups =
      await conn.sendRequest<{ groupId: string; workspaceIds: string[] }[]>('workspace.groups')
    expect(groups).toEqual([expect.objectContaining({ groupId: WORK, workspaceIds: ['wsA'] })])
    await expect(conn.sendRequest('pane.info', { paneId: paneC.externalId })).resolves.toBeNull()
    await expect(
      conn.sendRequest('pane.info', { paneId: paneA.externalId }),
    ).resolves.toMatchObject({ running: true })
  })

  it('lists every workspace to a token whose scope is all', async () => {
    const conn = await client(
      createScriptToken(storeFile, 'all', ['read-board', 'all-workspaces']).token,
    )
    const workspaces = await conn.sendRequest<{ workspaceId: string }[]>('workspace.list')
    expect(workspaces).toHaveLength(5)
    const panes = await conn.sendRequest<{ paneId: string }[]>('pane.list')
    expect(panes).toHaveLength(2)
  })

  it('gives a token whose scope is all the all-workspaces capability without storing it', async () => {
    const created = createScriptToken(storeFile, 'all', ['all-workspaces', 'kill-pane'])
    expect(created.caps).toEqual(['kill-pane'])
    expect(created.scope).toEqual({ kind: 'all' })
    const conn = await client(created.token)
    await conn.sendRequest('command.exec', { id: 'workspace.hibernateAgents', target: on('wsC') })
    expect(executed).toEqual([
      { target: { windowId: 'w1', ...on('wsC') }, id: 'workspace.hibernateAgents' },
    ])
  })
})

describe('script token expiry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('expires in 90 days by default and never only when asked', () => {
    const now = new Date('2026-10-11T00:00:00.000Z')
    const t = createScriptToken(storeFile, 'a', ['read-board'], {}, now)
    expect(t.expiresAt).toBe('2027-01-09T00:00:00.000Z')
    expect(createScriptToken(storeFile, 'b', ['read-board'], { expiresAt: null }).expiresAt).toBe(
      null,
    )
  })

  it('refuses an expired token at hello with token-expired', async () => {
    const created = createScriptToken(storeFile, 'old', ['read-board'], {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    expect(verifyScriptToken(storeFile, created.token)).toBeUndefined()
    const socket = createConnection(socketPath)
    const conn = createMessageConnection(
      new StreamMessageReader(socket),
      new StreamMessageWriter(socket),
    )
    conn.listen()
    clients.push(conn)
    await expect(conn.sendRequest('hello', { token: created.token })).rejects.toThrow(
      'token-expired: the script token "old"',
    )
  })

  it('cuts off a connection once its token expires', async () => {
    const created = createScriptToken(storeFile, 'soon', ['read-board'], {
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    const conn = await client(created.token)
    await expect(conn.sendRequest('test.scriptsOpen')).resolves.toEqual({ kind: 'script' })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 7_200_000)
    await expect(conn.sendRequest('test.scriptsOpen')).rejects.toThrow('token-expired')
  })

  it('records when a token was last used, at most once a minute', async () => {
    const created = createScriptToken(storeFile, 'used', ['read-board'])
    const first = new Date('2026-10-11T00:00:00.000Z')
    checkScriptToken({ path: storeFile, retiredPath: retiredFile }, created.token, first)
    expect(listScriptTokens(storeFile)[0].lastUsedAt).toBe(first.toISOString())
    const soon = new Date(first.getTime() + 30_000)
    checkScriptToken({ path: storeFile, retiredPath: retiredFile }, created.token, soon)
    expect(listScriptTokens(storeFile)[0].lastUsedAt).toBe(first.toISOString())
    const later = new Date(first.getTime() + 61_000)
    checkScriptToken({ path: storeFile, retiredPath: retiredFile }, created.token, later)
    expect(listScriptTokens(storeFile)[0].lastUsedAt).toBe(later.toISOString())
  })
})

describe('tokens from before the upgrade', () => {
  const legacyToken = `ostia_${'ab'.repeat(32)}`
  const legacyHash = createHash('sha256').update(legacyToken, 'utf8').digest('hex')

  function writeLegacy(): string {
    const legacy = join(tempDir(), 'script-tokens.json')
    writeFileSync(
      legacy,
      JSON.stringify({
        script_old: {
          id: 'script_old',
          name: 'ostia-ceo',
          hash: legacyHash,
          caps: ['all-workspaces'],
          createdAt: '2026-09-01T00:00:00.000Z',
        },
      }),
    )
    return legacy
  }

  it('moves old tokens to the retired list, deletes the old store and never verifies them', () => {
    const legacy = writeLegacy()
    expect(retireLegacyScriptTokens(legacy, retiredFile)).toEqual(['ostia-ceo'])
    expect(existsSync(legacy)).toBe(false)
    expect(retireLegacyScriptTokens(legacy, retiredFile)).toEqual([])
    expect(verifyScriptToken(storeFile, legacyToken)).toBeUndefined()
    expect(listScriptTokens(storeFile)).toEqual([])
    expect(readFileSync(retiredFile, 'utf8')).not.toContain(legacyToken)
  })

  it('tells an old token it was retired, and forgets it after 30 days', async () => {
    retireLegacyScriptTokens(writeLegacy(), retiredFile, new Date())
    const socket = createConnection(socketPath)
    const conn = createMessageConnection(
      new StreamMessageReader(socket),
      new StreamMessageWriter(socket),
    )
    conn.listen()
    clients.push(conn)
    await expect(conn.sendRequest('hello', { token: legacyToken })).rejects.toThrow(
      'token-retired: the script token "ostia-ceo"',
    )
    const later = new Date(Date.now() + 31 * 86_400_000)
    expect(
      checkScriptToken({ path: storeFile, retiredPath: retiredFile }, legacyToken, later),
    ).toBeUndefined()
  })

  it('lists the retired names for the human', async () => {
    retireLegacyScriptTokens(writeLegacy(), retiredFile)
    const admin = await client(
      registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'retired-reader' }).token,
    )
    answer = 'once'
    await expect(admin.sendRequest('token.retired')).resolves.toEqual([
      { name: 'ostia-ceo', retiredAt: expect.any(String) },
    ])
  })
})

describe('token.update', () => {
  let admin: MessageConnection

  beforeEach(async () => {
    answer = 'once'
    listing = baseListing()
    admin = await client(
      registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: `token-admin-${seq}` }).token,
    )
  })

  afterEach(() => {
    setUserPresenceCheck(async () => true)
  })

  async function refused(token: string): Promise<void> {
    const socket = createConnection(socketPath)
    const conn = createMessageConnection(
      new StreamMessageReader(socket),
      new StreamMessageWriter(socket),
    )
    conn.listen()
    clients.push(conn)
    await expect(conn.sendRequest('hello', { token })).rejects.toThrow('invalid or missing token')
  }

  it.each<[string, Record<string, unknown>]>([
    ['permissions', { caps: ['type-other-pane'] }],
    ['scope', { scope: { kind: 'limited', groups: ['Work'] } }],
    ['expiry', { expires: '30d' }],
  ])('changing %s regenerates the value and cuts the old one off', async (_what, change) => {
    const created = createScriptToken(storeFile, 'ceo', ['read-board'], {
      scope: limited([], ['wsA']),
    })
    const script = await client(created.token)
    await script.sendRequest('test.scriptsOpen')

    const updated = await admin.sendRequest<{ id: string; token?: string }>('token.update', {
      id: 'ceo',
      ...change,
    })
    expect(updated.id).toBe(created.id)
    expect(updated.token).toMatch(/^ostia_/)
    expect(updated.token).not.toBe(created.token)
    await expect(script.sendRequest('test.scriptsOpen')).rejects.toThrow('unknown identity')
    await refused(created.token)
    const fresh = await client(updated.token as string)
    await expect(fresh.sendRequest('whoami')).resolves.toMatchObject({ kind: 'script' })
    await expect(script.sendRequest('whoami')).rejects.toThrow('unknown identity')
  })

  it('applies the new permissions and scope', async () => {
    const created = createScriptToken(storeFile, 'ceo', ['read-board'], {
      scope: limited([], ['wsA']),
    })
    const updated = await admin.sendRequest<{ token: string }>('token.update', {
      id: created.id,
      caps: ['type-other-pane'],
      scope: { kind: 'limited', groups: ['Work'], ownWorkspaces: true },
      expires: 'never',
    })
    expect(listScriptTokens(storeFile)[0]).toMatchObject({
      caps: ['type-other-pane'],
      scope: limited([WORK], [], true),
      expiresAt: null,
    })
    const fresh = await client(updated.token)
    await expect(fresh.sendRequest('test.scriptsWrite')).resolves.toEqual({ ok: true })
    await expect(fresh.sendRequest('test.scriptsOpen')).rejects.toThrow(
      'needs-elevation: read-board',
    )
  })

  it('renaming keeps the value and the connection', async () => {
    const created = createScriptToken(storeFile, 'ceo', ['read-board'])
    const script = await client(created.token)
    const renamed = await admin.sendRequest<{ name: string; token?: string }>('token.update', {
      id: created.id,
      name: 'ostia-ceo',
    })
    expect(renamed.name).toBe('ostia-ceo')
    expect(renamed.token).toBeUndefined()
    await expect(script.sendRequest('test.scriptsOpen')).resolves.toEqual({ kind: 'script' })
    const again = await client(created.token)
    await expect(again.sendRequest('test.scriptsOpen')).resolves.toEqual({ kind: 'script' })
    expect(verifyScriptToken(storeFile, created.token)?.name).toBe('ostia-ceo')
  })

  it('asks the human with the new capabilities before regenerating', async () => {
    const created = createScriptToken(storeFile, 'ceo', ['read-board'])
    answer = 'deny'
    await expect(
      admin.sendRequest('token.update', { id: created.id, caps: ['type-other-pane'], scope: ALL }),
    ).rejects.toThrow('denied: settings-write, type-other-pane, all-workspaces')
    expect(verifyScriptToken(storeFile, created.token)?.caps).toEqual(['read-board'])
  })

  it('creates and regenerates nothing when the user presence check fails, and renaming skips it', async () => {
    const check = vi.fn(async () => false)
    setUserPresenceCheck(check)
    await expect(
      admin.sendRequest('token.create', { name: 'x', caps: ['read-board'], scope: ALL }),
    ).rejects.toThrow('cancelled: generate the script token "x"')
    expect(listScriptTokens(storeFile)).toEqual([])
    const created = createScriptToken(storeFile, 'ceo', ['read-board'])
    await expect(
      admin.sendRequest('token.update', { id: created.id, expires: '7d' }),
    ).rejects.toThrow('cancelled: regenerate the script token "ceo"')
    expect(verifyScriptToken(storeFile, created.token)).toBeDefined()
    expect(check).toHaveBeenCalledTimes(2)
    await admin.sendRequest('token.update', { id: created.id, name: 'renamed' })
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('refuses an update with nothing to change, or a name two tokens share', async () => {
    createScriptToken(storeFile, 'twin', ['read-board'])
    createScriptToken(storeFile, 'twin', ['read-board'])
    await expect(admin.sendRequest('token.update', { id: 'twin', expires: '7d' })).rejects.toThrow(
      'ambiguous-token: twin',
    )
    await expect(admin.sendRequest('token.update', { id: 'twin' })).rejects.toThrow(
      'nothing to change',
    )
    await expect(admin.sendRequest('token.revoke', { id: 'twin' })).rejects.toThrow(
      'ambiguous-token: twin',
    )
  })

  it('revokes by a unique name', async () => {
    const created = createScriptToken(storeFile, 'cron', ['read-board'])
    await expect(admin.sendRequest('token.revoke', { id: 'cron' })).resolves.toEqual({
      ok: true,
      id: created.id,
    })
    expect(listScriptTokens(storeFile)).toEqual([])
  })
})

describe('token.create scope and expiry', () => {
  let admin: MessageConnection

  beforeEach(async () => {
    answer = 'once'
    listing = baseListing()
    listing.groups.push({ groupId: 'g-dup-1', name: 'Dup' }, { groupId: 'g-dup-2', name: 'Dup' })
    admin = await client(
      registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: `token-maker-${seq}` }).token,
    )
  })

  it('stores group and workspace names as ids', async () => {
    const created = await admin.sendRequest<{ scope: ScriptTokenScope; expiresAt: string }>(
      'token.create',
      {
        name: 'board',
        caps: ['read-board'],
        scope: { kind: 'limited', groups: ['Work'], workspaces: ['gamma', 'wsD'] },
        expires: '7d',
      },
    )
    expect(created.scope).toEqual(limited([WORK], ['wsC', 'wsD']))
    expect(Date.parse(created.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86_400_000)
  })

  it.each<[Record<string, unknown>, string]>([
    [{ scope: { kind: 'limited', groups: ['Nope'] } }, 'unknown-group: Nope'],
    [{ scope: { kind: 'limited', groups: ['Dup'] } }, 'ambiguous-group: Dup'],
    [{ scope: { kind: 'limited', workspaces: ['nope'] } }, 'unknown-workspace: nope'],
    [{ scope: { kind: 'limited' } }, 'bad-request: scope'],
    [{}, 'bad-request: scope'],
    [
      { caps: ['all-workspaces'], scope: { kind: 'limited', groups: ['Work'] } },
      'needs the scope all',
    ],
    [{ scope: ALL, expires: 'soon' }, 'bad-request: expires'],
    [{ scope: ALL, expires: '2020-01-01' }, 'in the past'],
  ])('refuses %j', async (extra, message) => {
    await expect(
      admin.sendRequest('token.create', { name: 'x', caps: ['read-board'], ...extra }),
    ).rejects.toThrow(message)
    expect(listScriptTokens(storeFile)).toEqual([])
  })
})
