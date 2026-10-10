import { createHash } from 'node:crypto'
import { chmodSync, rmSync } from 'node:fs'
import { type Server, type Socket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import {
  ErrorCodes,
  type MessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import { type Capability, DEFAULT_CAPABILITIES } from '../../shared/capabilities'
import { TARGET_PANE_PARAM } from '../../shared/extensions'
import { PRODUCT_NAME } from '../../shared/product'
import type {
  CommandDescriptor,
  CommandResult,
  CommandTarget,
  TerminalStateSnapshot,
} from '../../shared/types'
import { ensureCaps, needsElevation } from '../approvals/controlElevation'
import type { Reach, ScriptReach } from '../approvals/reach'
import { privateTmpDir, socketPath } from '../platform/privateTmp'
import { SANDBOXED_REFUSAL } from '../sandbox/sandboxedCaller'
import { SCRIPT_COMMANDS, externalPaneMessage, internalPaneArgs } from './commandArgs'
import { type AuthedConn, authenticate, connHasCap, scriptExpired } from './controlAuth'
import { type PaneIdentity, resolveExternal } from './idRegistry'

export function controlSocketPath(): string {
  return socketPath(process.env.XDG_RUNTIME_DIR || tmpdir(), `${PRODUCT_NAME}-${process.pid}.sock`)
}

export function keptControlSocketPath(userData: string): string {
  const digest = createHash('sha256').update(userData).digest('hex').slice(0, 16)
  return socketPath(privateTmpDir(`${PRODUCT_NAME}-kept`), `${digest}.sock`)
}

function unauthenticatedError(message: string): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidRequest, message)
}

export type ControlCallers = 'panes' | 'extensions' | 'manager' | 'all'

export interface ControlMethodContext {
  identity: PaneIdentity
  authed: AuthedConn
  conn: MessageConnection
}

export interface ControlMethod {
  cap?: Capability
  callers?: ControlCallers
  scripts?: boolean
  targetable?: boolean
  handler: (params: unknown, ctx: ControlMethodContext) => unknown | Promise<unknown>
}

const DETAIL_HIDDEN_PREFIXES = ['vault.', 'secret.']

function describeParams(method: string, params: unknown): string {
  if (DETAIL_HIDDEN_PREFIXES.some((p) => method.startsWith(p))) return ''
  if (params === undefined) return ''
  try {
    return JSON.stringify(params)
  } catch {
    return ''
  }
}

function callerAllowed(identity: PaneIdentity, callers: ControlCallers, scripts = false): boolean {
  if (identity.kind === 'script') return scripts
  if (callers === 'all') return true
  if (callers === 'manager') return identity.kind === 'pane' && identity.manager === true
  return callers === 'extensions' ? identity.kind === 'extension' : identity.kind === 'pane'
}

const methods = new Map<string, ControlMethod>()

export function registerControlMethod(name: string, method: ControlMethod): void {
  if (methods.has(name)) throw new Error(`control method already registered: ${name}`)
  methods.set(name, method)
}

export function registerTargetableMethod(name: string, method: ControlMethod): void {
  registerControlMethod(name, { ...method, targetable: true })
}

const GROUP_COMMANDS: ReadonlySet<string> = new Set([
  'workspace.hibernateGroupAgents',
  'workspace.resumeGroupAgents',
])

function groupArg(args: unknown): unknown {
  return typeof args === 'object' && args !== null ? (args as { group?: unknown }).group : undefined
}

function scriptTargetInScope(
  scoped: ScriptReach | null,
  id: string,
  target: CommandTarget,
  args: unknown,
): boolean {
  if (!scoped) return false
  if (target.workspaceId) {
    if (!scoped.covers(target.workspaceId)) return false
    return (
      !GROUP_COMMANDS.has(id) || scoped.hasGroup(scoped.confirmedGroup(target.workspaceId) ?? '')
    )
  }
  const group = scoped.groupNamed(groupArg(args))
  if (id === 'workspace.new') return scoped.ownWorkspaces && scoped.hasGroup(group ?? '')
  return id === 'workspace.groupColor' && scoped.hasGroup(group ?? '')
}

function actingPane(
  authed: AuthedConn,
  params: unknown,
): { identity: PaneIdentity; params: Record<string, unknown> } {
  if (!connHasCap(authed, 'all-workspaces')) throw needsElevation('all-workspaces')
  const raw = (typeof params === 'object' && params !== null ? params : {}) as Record<
    string,
    unknown
  >
  const { [TARGET_PANE_PARAM]: targetId, ...rest } = raw
  const target = typeof targetId === 'string' ? resolveExternal(targetId) : undefined
  if (!targetId) {
    throw new ResponseError(ErrorCodes.InvalidParams, `needs-target: ${TARGET_PANE_PARAM}`)
  }
  if (target?.kind !== 'pane') {
    throw new ResponseError(ErrorCodes.InvalidParams, `unknown-target: ${String(targetId)}`)
  }
  return { identity: target, params: rest }
}

export interface ControlServerDeps {
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  listCommandsFor: (windowId: string) => CommandDescriptor[]
  getTerminalState: (paneId: string) => TerminalStateSnapshot | undefined
  isSandboxed: (workspaceId: string) => boolean
  windowOfWorkspace?: (workspaceId: string) => string | undefined
  primaryWindow?: () => string | undefined
  byAgent?: <T>(run: () => Promise<T>) => Promise<T>
  reach?: Pick<Reach, 'scriptReach' | 'recordCreated'>
}

let server: Server | null = null
let keptServer: Server | null = null
let keptPath: string | null = null
let handleConnection: ((socket: Socket) => void) | null = null

export function registerControlServer(deps: ControlServerDeps, socketPathOverride?: string): void {
  const path = socketPathOverride ?? controlSocketPath()
  try {
    rmSync(path, { force: true })
  } catch {}

  handleConnection = (socket) => {
    const conn = createMessageConnection(
      new StreamMessageReader(socket),
      new StreamMessageWriter(socket),
    )
    let authed: AuthedConn | null = null

    const requireIdentity = (callers: ControlCallers, scripts = false): PaneIdentity => {
      if (!authed) throw unauthenticatedError('call hello first')
      const me = resolveExternal(authed.externalId)
      if (!me || (me.kind === 'script' && me.token !== authed.scriptSession)) {
        throw unauthenticatedError('unknown identity')
      }
      if (me.kind === 'script' && scriptExpired(me.externalId)) {
        throw unauthenticatedError('token-expired: this script token has expired')
      }
      if (!callerAllowed(me, callers, scripts)) {
        throw new ResponseError(ErrorCodes.InvalidRequest, `not-available-to-${me.kind}`)
      }
      return me
    }

    conn.onRequest('hello', (params: { token?: string } | undefined) => {
      authed = authenticate(params ?? {})
      if (!authed) throw unauthenticatedError('invalid or missing token')
      return { externalId: authed.externalId }
    })

    conn.onRequest('whoami', (): Record<string, string | undefined> => {
      const me = requireIdentity('all', true)
      if (me.kind === 'extension') return { externalId: me.externalId, extensionId: me.extId }
      if (me.kind === 'script') return { externalId: me.externalId, kind: 'script' }
      return { externalId: me.externalId, paneId: me.paneId, workspaceId: me.workspaceId }
    })

    conn.onRequest('command.list', (): CommandDescriptor[] => {
      const me = requireIdentity('panes', true)
      if (me.kind !== 'script') return deps.listCommandsFor(me.windowId)
      const windowId = deps.primaryWindow?.()
      return windowId ? deps.listCommandsFor(windowId).filter((d) => SCRIPT_COMMANDS.has(d.id)) : []
    })

    conn.onRequest(
      'command.exec',
      async (params: {
        id: string
        args?: unknown
        target?: CommandTarget
      }): Promise<CommandResult> => {
        const me = requireIdentity('panes', true)
        if (!authed) throw unauthenticatedError('call hello first')
        const script = me.kind === 'script'
        if (script && !SCRIPT_COMMANDS.has(params.id)) {
          throw new ResponseError(ErrorCodes.InvalidRequest, 'not-available-to-script')
        }

        const translated = internalPaneArgs(params.args)
        if (!translated.ok) throw new ResponseError(ErrorCodes.InvalidParams, translated.error)
        const { args, pane } = translated

        const selfTarget: CommandTarget = script
          ? { windowId: deps.primaryWindow?.(), workspaceId: '', paneId: null }
          : { windowId: me.windowId, workspaceId: me.workspaceId, paneId: me.paneId }
        const given = params.target
        let target: CommandTarget = given
          ? {
              ...given,
              windowId: given.windowId ?? deps.windowOfWorkspace?.(given.workspaceId),
            }
          : selfTarget
        if (pane?.workspaceId && pane.workspaceId !== target.workspaceId) {
          if (given) {
            throw new ResponseError(
              ErrorCodes.InvalidParams,
              `bad-request: pane ${pane.externalId} is in workspace ${pane.workspaceId}, not ${given.workspaceId}`,
            )
          }
          target = { windowId: pane.windowId, workspaceId: pane.workspaceId, paneId: null }
        }
        if (script && params.id === 'pane.close' && !target.workspaceId) {
          throw new ResponseError(
            ErrorCodes.InvalidParams,
            'bad-request: pane.close from a script token needs {"paneId": <id from ostia pane list>}',
          )
        }
        if (!script && target.workspaceId !== me.workspaceId && deps.isSandboxed(me.workspaceId)) {
          throw new ResponseError(ErrorCodes.InvalidRequest, SANDBOXED_REFUSAL)
        }
        const scoped = script
          ? ((await deps.reach?.scriptReach({ identity: me, authed })) ?? null)
          : null
        const crossTarget = script
          ? !scriptTargetInScope(scoped, params.id, target, args)
          : target.paneId !== me.paneId ||
            target.windowId !== me.windowId ||
            target.workspaceId !== me.workspaceId

        const desc = deps
          .listCommandsFor(target.windowId ?? me.windowId)
          .find((d) => d.id === params.id)
        if (!desc) {
          if (crossTarget && !connHasCap(authed, 'all-workspaces')) {
            throw needsElevation('all-workspaces')
          }
          return {
            ok: false,
            error: { code: 'unknown-command', message: `unknown command '${params.id}'` },
          }
        }
        if (script && desc.target !== 'none' && !target.workspaceId) {
          throw new ResponseError(
            ErrorCodes.InvalidParams,
            `bad-request: ${params.id} from a script token needs a workspace: pass --workspace <id> (ostia workspace list)`,
          )
        }
        const caps: Capability[] = [
          ...(crossTarget ? (['all-workspaces'] as const) : []),
          ...(script
            ? desc.capabilities.filter((cap) => !DEFAULT_CAPABILITIES.includes(cap))
            : desc.capabilities),
        ]
        await ensureCaps(
          authed,
          me,
          caps,
          desc.title,
          describeParams(params.id, { command: params.id, args: params.args }),
        )

        if (given?.workspaceId && deps.windowOfWorkspace && !target.windowId) {
          throw new ResponseError(
            ErrorCodes.InvalidParams,
            `unknown-workspace: ${given.workspaceId}`,
          )
        }
        const exec = (): Promise<CommandResult> => deps.execCommand(target, params.id, args)
        const result = await (deps.byAgent ? deps.byAgent(exec) : exec())
        const createdId = (result.ok ? (result.result as { workspaceId?: unknown }) : undefined)
          ?.workspaceId
        if (scoped && params.id === 'workspace.new' && typeof createdId === 'string') {
          deps.reach?.recordCreated({ identity: me, authed }, createdId)
        }
        if (result.ok || !pane) return result
        return {
          ...result,
          error: { ...result.error, message: externalPaneMessage(result.error.message, pane) },
        }
      },
    )

    conn.onRequest(
      'pane.info',
      async (params?: { paneId?: string }): Promise<TerminalStateSnapshot | null> => {
        const me = requireIdentity('panes', true)
        if (!authed) throw unauthenticatedError('call hello first')
        if (!connHasCap(authed, 'read-board')) throw needsElevation('read-board')
        const script = me.kind === 'script'
        if (!params?.paneId) {
          if (script) throw new ResponseError(ErrorCodes.InvalidParams, 'bad-request: paneId')
          return deps.getTerminalState(me.paneId) ?? null
        }
        const other = resolveExternal(params.paneId)
        if (other?.kind !== 'pane' || (script && other.manager)) return null
        const scoped = script ? await deps.reach?.scriptReach({ identity: me, authed }) : null
        if (scoped && !scoped.covers(other.workspaceId)) return null
        return deps.getTerminalState(other.paneId) ?? null
      },
    )

    conn.onRequest('cwd.get', (): { cwd: string | null } => {
      const me = requireIdentity('panes')
      if (authed && !connHasCap(authed, 'read-board')) throw needsElevation('read-board')
      return { cwd: deps.getTerminalState(me.paneId)?.cwd ?? null }
    })

    for (const [name, m] of methods) {
      conn.onRequest(name, async (params: unknown) => {
        const caller = requireIdentity(m.targetable ? 'all' : (m.callers ?? 'panes'), m.scripts)
        if (!authed) throw unauthenticatedError('call hello first')
        if (m.cap) await ensureCaps(authed, caller, [m.cap], name, describeParams(name, params))
        if (caller.kind === 'extension' && m.targetable) {
          const acting = actingPane(authed, params)
          return m.handler(acting.params, { identity: acting.identity, authed, conn })
        }
        return m.handler(params, { identity: caller, authed, conn })
      })
    }

    socket.on('error', () => conn.dispose())
    conn.onClose(() => socket.destroy())
    conn.listen()
  }
  server = createServer(handleConnection)

  server.on('error', (err) => console.error('[control] socket server error:', err))
  server.listen(path, () => {
    try {
      chmodSync(path, 0o600)
    } catch {}
  })
}

export function listenKeptControlSocket(path: string): void {
  if (!handleConnection || keptServer) return
  try {
    rmSync(path, { force: true })
  } catch {}
  keptPath = path
  keptServer = createServer(handleConnection)
  keptServer.on('error', (err) => console.error('[control] kept socket error:', err))
  keptServer.listen(path, () => {
    try {
      chmodSync(path, 0o600)
    } catch {}
  })
}

export function stopControlServer(): void {
  server?.close()
  server = null
  keptServer?.close()
  keptServer = null
  try {
    rmSync(controlSocketPath(), { force: true })
    if (keptPath) rmSync(keptPath, { force: true })
  } catch {}
}
