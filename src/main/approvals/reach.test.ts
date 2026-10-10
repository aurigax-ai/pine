import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalOutcome } from '../../shared/permissions/approvals'
import type { AgentGroupPlacement, ReachMode } from '../../shared/permissions/reach'
import type { ScriptTokenScope } from '../../shared/permissions/scriptTokens'
import { emptyWorkspaceSandbox } from '../../shared/sandbox/sandbox'
import type { ApprovalAsk } from './approvals'

const request = vi.fn(async (_ask: ApprovalAsk): Promise<ApprovalOutcome> => 'deny')

vi.mock('./approvals', () => ({ approvals: () => ({ request }) }))

const { grant, initCaps, setCaps } = await import('./capabilityStore')
const { setCapFilter } = await import('../control/controlAuth')
const { registerPane, registerScript } = await import('../control/idRegistry')
const { createReach } = await import('./reach')

const home = realpathSync(mkdtempSync(join(tmpdir(), 'reach-runtime-')))
const repoA = join(home, 'a')
const repoB = join(home, 'b')
mkdirSync(join(repoA, '.git'), { recursive: true })
mkdirSync(join(repoB, '.git'), { recursive: true })

const workDirs: Record<string, string> = {
  coord: repoA,
  workers: repoA,
  elsewhere: repoB,
  scratch: repoA,
}

let mode: ReachMode = 'project'
let groupOf: Record<string, string | undefined> = {}
const listing = () => ({
  workspaces: Object.entries(workDirs).map(([workspaceId, workDir]) => ({
    workspaceId,
    name: workspaceId,
    workDir,
    ...(groupOf[workspaceId] ? { groupId: groupOf[workspaceId] } : {}),
  })),
  groups: [{ groupId: 'g1', name: 'terminal' }],
})
const ask = vi.fn((a: ApprovalAsk) => request(a))

const reach = createReach({
  mode: () => mode,
  home,
  workDir: (id) => workDirs[id],
  isScratch: (id) => id === 'scratch',
  hasManager: () => false,
  sandbox: () => emptyWorkspaceSandbox(),
  workspaces: async () => listing(),
  ask,
  agentGroupsChanged: () => {},
})

let seq = 0
function caller(workspaceId = 'coord') {
  const paneId = `reach-caller-${++seq}`
  const identity = registerPane({ windowId: 'w1', workspaceId, paneId })
  initCaps(identity.externalId)
  return {
    identity,
    authed: { externalId: identity.externalId, paneId, workspaceId },
  }
}

beforeEach(() => {
  mode = 'project'
  groupOf = {}
  request.mockReset()
  request.mockResolvedValue('deny')
  ask.mockClear()
  setCapFilter(() => true)
})

describe('createReach', () => {
  it('project: reaches a workspace of the same repository without asking', async () => {
    await expect(reach.ensure(caller(), 'workers', 'process.run', 'x')).resolves.toBeUndefined()
    expect(request).not.toHaveBeenCalled()
  })

  it('project: a different repository asks for all-workspaces exactly as before', async () => {
    await expect(reach.ensure(caller(), 'elsewhere', 'process.run', 'x')).rejects.toThrow(
      'denied: all-workspaces',
    )
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ caps: ['all-workspaces'] }))
  })

  it('project: a scratch workspace in the same folder is never in scope', async () => {
    expect(await reach.inScope(caller(), 'scratch')).toBe(false)
  })

  it('workspace: only the caller’s own workspace', async () => {
    mode = 'workspace'
    expect(await reach.inScope(caller(), 'coord')).toBe(true)
    expect(await reach.inScope(caller(), 'workers')).toBe(false)
  })

  it('a script with no workspace of its own has no scope', async () => {
    const script = caller('')
    expect(await reach.inScope(script, 'workers')).toBe(false)
  })

  it('visible: lists only workspaces in scope, every workspace with all-workspaces', async () => {
    const plain = caller()
    const sees = await reach.visible(plain)
    expect(['coord', 'workers', 'elsewhere'].filter(sees)).toEqual(['coord', 'workers'])
    grant(plain.identity.externalId, 'all-workspaces')
    expect((await reach.visible(plain))('elsewhere')).toBe(true)
  })

  it('group: a membership the human made is one scope', async () => {
    mode = 'group'
    groupOf = { coord: 'g1', elsewhere: 'g1' }
    expect(await reach.inScope(caller(), 'elsewhere')).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('group: a workspace an agent moved into the group asks the human to confirm it first', async () => {
    mode = 'group'
    groupOf = { coord: 'g1', elsewhere: undefined }
    await reach.byAgent(async () => {
      groupOf = { coord: 'g1', elsewhere: 'g1' }
    })

    expect(await reach.inScope(caller(), 'elsewhere')).toBe(false)
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'reach-group', subject: 'elsewhere', caps: [] }),
    )

    request.mockResolvedValue('workspace')
    expect(await reach.inScope(caller(), 'elsewhere')).toBe(true)
    ask.mockClear()
    expect(await reach.inScope(caller(), 'elsewhere')).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('group: a caller holding all-workspaces is never shown the confirm card', async () => {
    mode = 'group'
    groupOf = { coord: 'g1', workers: undefined }
    await reach.byAgent(async () => {
      groupOf = { coord: 'g1', workers: 'g1' }
    })
    const strong = caller()
    grant(strong.identity.externalId, 'all-workspaces')
    expect(await reach.inScope(strong, 'workers')).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it('group: an agent that put its own workspace in a group gains nothing from it', async () => {
    mode = 'group'
    groupOf = { coord: undefined, workers: 'g1' }
    await reach.byAgent(async () => {
      groupOf = { coord: 'g1', workers: 'g1' }
    })
    expect(await reach.inScope(caller(), 'workers')).toBe(false)
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ subject: 'coord' }))
  })

  it('project: an agent that points its own workspace at another repository gains no reach without the card', async () => {
    workDirs.rogue = repoB
    await reach.byAgent(async () => {
      workDirs.rogue = repoA
    })

    expect(await reach.inScope(caller('rogue'), 'workers')).toBe(false)
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'reach-project', subject: repoA, caps: [] }),
    )
    expect((await reach.visible(caller('rogue')))('workers')).toBe(false)
    await expect(reach.ensure(caller('rogue'), 'workers', 'process.run', 'x')).rejects.toThrow(
      'denied: all-workspaces',
    )

    request.mockResolvedValue('workspace')
    expect(await reach.inScope(caller('rogue'), 'workers')).toBe(true)
    ask.mockClear()
    expect(await reach.inScope(caller('rogue'), 'workers')).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('project: a workspace whose folder an agent set is not reached without the card either', async () => {
    workDirs.moved = repoB
    await reach.byAgent(async () => {
      workDirs.moved = repoA
    })
    expect(await reach.inScope(caller(), 'moved')).toBe(false)
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'reach-project', detail: 'workspace moved' }),
    )
  })

  it('project: the human setting the folder afterwards clears the agent’s mark', async () => {
    workDirs.handed = repoB
    await reach.byAgent(async () => {
      workDirs.handed = repoA
    })
    workDirs.handed = join(repoA, 'src')
    expect(await reach.inScope(caller('handed'), 'workers')).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('project: a workspace an agent created in its own project needs no card', async () => {
    await reach.byAgent(async () => {
      workDirs.fresh = repoA
    })
    expect(await reach.inScope(caller(), 'fresh')).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('group: a group listing that fails gives no group reach', async () => {
    mode = 'group'
    const failing = createReach({
      mode: () => 'group',
      home,
      workDir: (id) => workDirs[id],
      isScratch: () => false,
      hasManager: () => false,
      sandbox: () => emptyWorkspaceSandbox(),
      workspaces: async () => {
        throw new Error('window gone')
      },
      ask,
      agentGroupsChanged: () => {},
    })
    expect(await failing.inScope(caller(), 'workers')).toBe(false)
  })

  it('reports the group memberships agents set until the human confirms them or the workspace closes', async () => {
    mode = 'group'
    const published: AgentGroupPlacement[][] = []
    const own = createReach({
      mode: () => mode,
      home,
      workDir: (id) => workDirs[id],
      isScratch: () => false,
      hasManager: () => false,
      sandbox: () => emptyWorkspaceSandbox(),
      workspaces: async () => listing(),
      ask,
      agentGroupsChanged: (placements) => published.push(placements),
    })
    groupOf = { coord: 'g1' }
    expect(own.agentGroups()).toEqual([])

    await own.byAgent(async () => {})
    expect(published).toEqual([])

    await own.byAgent(async () => {
      groupOf = { coord: 'g1', elsewhere: 'g1', workers: 'g1' }
    })
    const placed = [
      { workspaceId: 'workers', groupId: 'g1' },
      { workspaceId: 'elsewhere', groupId: 'g1' },
    ]
    expect(own.agentGroups()).toEqual(placed)
    expect(published).toEqual([placed])

    request.mockResolvedValue('workspace')
    expect(await own.inScope(caller(), 'elsewhere')).toBe(true)
    expect(own.agentGroups()).toEqual([placed[0]])
    expect(published).toEqual([placed, [placed[0]]])

    own.forget('workers')
    expect(own.agentGroups()).toEqual([])
    expect(published).toEqual([placed, [placed[0]], []])
  })
})

describe('createReach for script tokens', () => {
  const scopes: Record<string, { scope: ScriptTokenScope; created: string[] }> = {}
  const created: [string, string][] = []
  const scripted = createReach({
    mode: () => mode,
    home,
    workDir: (id) => workDirs[id],
    isScratch: () => false,
    hasManager: () => false,
    sandbox: () => emptyWorkspaceSandbox(),
    workspaces: async () => listing(),
    ask,
    agentGroupsChanged: () => {},
    scriptScope: (id) => scopes[id],
    scriptCreated: (id, workspaceId) => created.push([id, workspaceId]),
  })

  function script(scope: ScriptTokenScope, made: string[] = []) {
    const id = `script_reach_${++seq}`
    scopes[id] = { scope, created: made }
    const identity = registerScript(id)
    setCaps(id, scope.kind === 'all' ? ['all-workspaces'] : [])
    return { identity, authed: { externalId: id, paneId: '', workspaceId: '' } }
  }

  it('reaches the groups of a limited scope even in project mode', async () => {
    groupOf = { workers: 'g1', elsewhere: 'g1' }
    const s = script({ kind: 'limited', groups: ['g1'], workspaces: [], ownWorkspaces: false })
    expect(await scripted.inScope(s, 'workers')).toBe(true)
    expect(await scripted.inScope(s, 'elsewhere')).toBe(true)
    expect(await scripted.inScope(s, 'coord')).toBe(false)
    const sees = await scripted.visible(s)
    expect(['coord', 'workers', 'elsewhere'].filter(sees)).toEqual(['workers', 'elsewhere'])
    expect(ask).not.toHaveBeenCalled()
  })

  it('reaches only the workspaces a limited scope names', async () => {
    const s = script({ kind: 'limited', groups: [], workspaces: ['coord'], ownWorkspaces: false })
    expect(await scripted.inScope(s, 'coord')).toBe(true)
    expect(await scripted.inScope(s, 'workers')).toBe(false)
    expect(await scripted.inScope(s, '')).toBe(false)
  })

  it('leaves out a workspace an agent moved into a group of the scope', async () => {
    groupOf = {}
    await scripted.byAgent(async () => {
      groupOf = { workers: 'g1' }
    })
    const s = script({ kind: 'limited', groups: ['g1'], workspaces: [], ownWorkspaces: false })
    expect(await scripted.inScope(s, 'workers')).toBe(false)
    await expect(scripted.ensure(s, 'workers', 'x', 'y')).rejects.toThrow(
      'needs-elevation: all-workspaces',
    )
    expect(ask).not.toHaveBeenCalled()
  })

  it('reaches the workspaces the token created only when its scope says so', async () => {
    const own = script({ kind: 'limited', groups: ['g1'], workspaces: [], ownWorkspaces: true }, [
      'elsewhere',
    ])
    expect(await scripted.inScope(own, 'elsewhere')).toBe(true)
    const not = script({ kind: 'limited', groups: ['g1'], workspaces: [], ownWorkspaces: false }, [
      'elsewhere',
    ])
    expect(await scripted.inScope(not, 'elsewhere')).toBe(false)
    scripted.recordCreated(own, 'fresh')
    expect(created).toContainEqual([own.identity.externalId, 'fresh'])
    scripted.recordCreated(caller(), 'fresh')
    expect(created).toHaveLength(1)
  })

  it('leaves a token whose scope is all to all-workspaces, and gives a pane no script scope', async () => {
    const all = script({ kind: 'all' })
    expect(await scripted.scriptReach(all)).toBeNull()
    expect(await scripted.inScope(all, 'elsewhere')).toBe(false)
    expect((await scripted.visible(all))('elsewhere')).toBe(true)
    expect(await scripted.scriptReach(caller())).toBeNull()
  })

  it('fails closed when the token is gone', async () => {
    const gone = script({ kind: 'limited', groups: ['g1'], workspaces: [], ownWorkspaces: false })
    delete scopes[gone.identity.externalId]
    groupOf = { workers: 'g1' }
    expect(await scripted.inScope(gone, 'workers')).toBe(false)
    expect((await scripted.visible(gone))('workers')).toBe(false)
  })
})
