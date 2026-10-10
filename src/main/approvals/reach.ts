import type { ApprovalOutcome } from '../../shared/permissions/approvals'
import type { AgentGroupPlacement, ReachMode } from '../../shared/permissions/reach'
import type { ScriptTokenScope } from '../../shared/permissions/scriptTokens'
import type { WorkspaceSandbox } from '../../shared/sandbox/sandbox'
import { normalizeGroupName } from '../../shared/workspaces/workspaceGroups'
import { connHasCap } from '../control/controlAuth'
import type { ControlMethodContext } from '../control/controlServer'
import type { ApprovalAsk } from './approvals'
import { ensureCaps } from './controlElevation'
import {
  AgentProvenance,
  type ScopeWorkspace,
  projectKey,
  sameReachScope,
  unconfirmedMembers,
} from './reachScope'

export type ReachCaller = Pick<ControlMethodContext, 'identity' | 'authed'>

export interface ReachListing {
  workspaces: { workspaceId: string; name: string; workDir: string; groupId?: string }[]
  groups: { groupId: string; name: string }[]
}

export interface ReachDeps {
  mode: () => ReachMode
  home: string
  workDir: (workspaceId: string) => string | undefined
  isScratch: (workspaceId: string) => boolean
  hasManager: (workspaceId: string) => boolean
  sandbox: (workspaceId: string) => WorkspaceSandbox
  workspaces: () => Promise<ReachListing>
  ask: (ask: ApprovalAsk) => Promise<ApprovalOutcome> | null
  agentGroupsChanged: (placements: AgentGroupPlacement[]) => void
  scriptScope?: (tokenId: string) => { scope: ScriptTokenScope; created: string[] } | undefined
  scriptCreated?: (tokenId: string, workspaceId: string) => void
}

export interface ScriptReach {
  covers: (workspaceId: string) => boolean
  hasGroup: (groupId: string) => boolean
  confirmedGroup: (workspaceId: string) => string | undefined
  groupNamed: (name: unknown) => string | undefined
  ownWorkspaces: boolean
}

export interface Reach {
  inScope: (ctx: ReachCaller, workspaceId: string) => Promise<boolean>
  ensure: (ctx: ReachCaller, workspaceId: string, action: string, detail: string) => Promise<void>
  visible: (ctx: ReachCaller) => Promise<(workspaceId: string) => boolean>
  scriptReach: (ctx: ReachCaller) => Promise<ScriptReach | null>
  recordCreated: (ctx: ReachCaller, workspaceId: string) => void
  byAgent: <T>(run: () => Promise<T>) => Promise<T>
  agentGroups: () => AgentGroupPlacement[]
  forget: (workspaceId: string) => void
}

const NO_WORKSPACES: ReachListing = { workspaces: [], groups: [] }

export function createReach(deps: ReachDeps): Reach {
  const groupsByAgent = new AgentProvenance()
  const foldersByAgent = new AgentProvenance()
  let publishedGroups = '[]'

  const agentGroups = (): AgentGroupPlacement[] =>
    groupsByAgent.entries().map(([workspaceId, groupId]) => ({ workspaceId, groupId }))

  const publishAgentGroups = (): void => {
    const placements = agentGroups()
    const next = JSON.stringify(placements)
    if (next === publishedGroups) return
    publishedGroups = next
    deps.agentGroupsChanged(placements)
  }

  const listing = async (mode: ReachMode): Promise<ReachListing> =>
    mode === 'group' ? await deps.workspaces().catch(() => NO_WORKSPACES) : NO_WORKSPACES

  const factsOf = (workspaceId: string, groups: ReachListing): ScopeWorkspace => {
    const workDir = deps.workDir(workspaceId)
    const groupId = groups.workspaces.find((w) => w.workspaceId === workspaceId)?.groupId
    return {
      id: workspaceId,
      shareable:
        workDir !== undefined && !deps.isScratch(workspaceId) && !deps.hasManager(workspaceId),
      project: workDir === undefined ? null : projectKey(workDir, deps.home),
      folderByAgent: workDir !== undefined && foldersByAgent.byAgent(workspaceId, workDir),
      sandbox: deps.sandbox(workspaceId),
      group: groupId ? { id: groupId, byAgent: groupsByAgent.byAgent(workspaceId, groupId) } : null,
    }
  }

  const confirmCard = (
    mode: ReachMode,
    workspaceId: string,
    groups: ReachListing,
  ): Pick<ApprovalAsk, 'kind' | 'subject' | 'detail'> => {
    if (mode === 'project') {
      return {
        kind: 'reach-project',
        subject: deps.workDir(workspaceId) ?? workspaceId,
        detail: `workspace ${workspaceId}`,
      }
    }
    const entry = groups.workspaces.find((w) => w.workspaceId === workspaceId)
    const group = groups.groups.find((g) => g.groupId === entry?.groupId)
    return {
      kind: 'reach-group',
      subject: entry?.name ?? workspaceId,
      detail: `workspace ${workspaceId} in group ${JSON.stringify(group?.name ?? '')}`,
    }
  }

  const confirmMember = async (
    ctx: ReachCaller,
    mode: ReachMode,
    workspaceId: string,
    groups: ReachListing,
  ): Promise<boolean> => {
    const me = ctx.identity
    if (me.kind !== 'pane' || me.externalId !== ctx.authed.externalId) return false
    const pending = deps.ask({
      externalId: ctx.authed.externalId,
      windowId: me.windowId,
      paneId: me.paneId,
      workspaceId: me.workspaceId,
      caps: [],
      action: 'reach',
      ...confirmCard(mode, workspaceId, groups),
    })
    if (!pending || (await pending) !== 'workspace') return false
    ;(mode === 'project' ? foldersByAgent : groupsByAgent).confirm(workspaceId)
    publishAgentGroups()
    return true
  }

  const scriptReach = async (ctx: ReachCaller): Promise<ScriptReach | null> => {
    if (ctx.identity.kind !== 'script') return null
    const view = deps.scriptScope?.(ctx.identity.externalId)
    if (view?.scope.kind !== 'limited') return null
    const { groups, workspaces, ownWorkspaces } = view.scope
    const listed = await deps.workspaces().catch(() => NO_WORKSPACES)
    const confirmedGroup = (workspaceId: string): string | undefined => {
      const groupId = listed.workspaces.find((w) => w.workspaceId === workspaceId)?.groupId
      return groupId && !groupsByAgent.byAgent(workspaceId, groupId) ? groupId : undefined
    }
    const hasGroup = (groupId: string): boolean => groups.includes(groupId)
    return {
      covers: (workspaceId) => {
        if (!workspaceId) return false
        if (workspaces.includes(workspaceId)) return true
        if (ownWorkspaces && view.created.includes(workspaceId)) return true
        const groupId = confirmedGroup(workspaceId)
        return groupId !== undefined && hasGroup(groupId)
      },
      hasGroup,
      confirmedGroup,
      groupNamed: (raw) => {
        const name = normalizeGroupName(raw)
        return name ? listed.groups.find((g) => g.name === name)?.groupId : undefined
      },
      ownWorkspaces,
    }
  }

  const inScope = async (ctx: ReachCaller, workspaceId: string): Promise<boolean> => {
    if (ctx.identity.kind === 'script') {
      return (await scriptReach(ctx))?.covers(workspaceId) ?? false
    }
    const callerId = ctx.identity.workspaceId
    if (!callerId || !workspaceId) return false
    if (callerId === workspaceId) return true
    const mode = deps.mode()
    const groups = await listing(mode)
    const caller = factsOf(callerId, groups)
    const target = factsOf(workspaceId, groups)
    if (sameReachScope(caller, target, mode)) return true
    if (connHasCap(ctx.authed, 'all-workspaces')) return false
    for (const id of unconfirmedMembers(caller, target, mode)) {
      if (!(await confirmMember(ctx, mode, id, groups))) return false
    }
    return sameReachScope(factsOf(callerId, groups), factsOf(workspaceId, groups), mode)
  }

  const ensure = async (
    ctx: ReachCaller,
    workspaceId: string,
    action: string,
    detail: string,
  ): Promise<void> => {
    if (await inScope(ctx, workspaceId)) return
    await ensureCaps(ctx.authed, ctx.identity, ['all-workspaces'], action, detail)
  }

  const visible = async (ctx: ReachCaller): Promise<(workspaceId: string) => boolean> => {
    if (connHasCap(ctx.authed, 'all-workspaces')) return () => true
    if (ctx.identity.kind === 'script') {
      const scoped = await scriptReach(ctx)
      return scoped ? scoped.covers : () => false
    }
    const callerId = ctx.identity.workspaceId
    const mode = deps.mode()
    const groups = await listing(mode)
    const caller = callerId ? factsOf(callerId, groups) : null
    return (workspaceId) =>
      caller !== null && sameReachScope(caller, factsOf(workspaceId, groups), mode)
  }

  const byAgent = async <T>(run: () => Promise<T>): Promise<T> => {
    const before = await deps.workspaces().catch(() => null)
    try {
      return await run()
    } finally {
      const after = await deps.workspaces().catch(() => null)
      for (const w of after?.workspaces ?? []) {
        const was = before?.workspaces.find((b) => b.workspaceId === w.workspaceId)
        if (w.groupId && (!before || was?.groupId !== w.groupId)) {
          groupsByAgent.setByAgent(w.workspaceId, w.groupId)
        }
        if (!before || (was && was.workDir !== w.workDir)) {
          foldersByAgent.setByAgent(w.workspaceId, w.workDir)
        }
      }
      publishAgentGroups()
    }
  }

  return {
    inScope,
    ensure,
    visible,
    scriptReach,
    recordCreated: (ctx, workspaceId) => {
      if (ctx.identity.kind === 'script') deps.scriptCreated?.(ctx.identity.externalId, workspaceId)
    },
    byAgent,
    agentGroups,
    forget: (workspaceId) => {
      groupsByAgent.forget(workspaceId)
      foldersByAgent.forget(workspaceId)
      publishAgentGroups()
    },
  }
}
