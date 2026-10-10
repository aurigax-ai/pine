import { randomUUID } from 'node:crypto'
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import { type BusDelivery, busContext, busPreview } from '../../shared/agents/busMessages'
import { ensureCaps } from '../approvals/controlElevation'
import type { Reach } from '../approvals/reach'
import { registerControlMethod } from '../control/controlServer'
import { type PaneIdentity, resolveExternal } from '../control/idRegistry'
import { loadJson, saveJson, storePath } from '../platform/jsonStore'

export interface Message {
  id: string
  from: string
  to: string
  text: string
  ts: string
  seenAt?: string
  quiet?: true
}

export interface SentMessage {
  id: string
  from: string
  to: string
  preview: string
  ts: string
  seenAt?: string
}

export type HandoffState = 'submitted' | 'claimed' | 'completed' | 'failed'

export interface HandoffContext {
  artifacts?: string[]
  workDir?: string
}

export interface Handoff {
  id: string
  from: string
  to: string
  task: string
  summary: string
  state: HandoffState
  context?: HandoffContext
  ts: string
  updatedAt: string
}

interface BusData {
  inboxes: Record<string, Message[]>
  handoffs: Handoff[]
  sent: SentMessage[]
}

const MAX_INBOX_MESSAGES = 200
const MAX_HANDOFFS = 500
const MAX_SENT = 500
const MAX_SENT_LISTED = 50

const MIN_WAIT_MS = 1000
const MAX_WAIT_MS = 120000
const DEFAULT_WAIT_MS = 30000

function busPath(): string {
  return storePath('bus', 'global')
}

function loadBus(): BusData {
  const stored = loadJson<Partial<BusData>>(busPath(), {})
  return {
    inboxes: stored.inboxes ?? {},
    handoffs: stored.handoffs ?? [],
    sent: stored.sent ?? [],
  }
}

function saveBus(data: BusData): void {
  saveJson(busPath(), data)
}

const NOT_FOUND = { ok: false, error: 'not-found' as const }
const UNKNOWN_PANE = {
  ok: false,
  error: 'unknown-pane' as const,
  message: 'no open pane has that id (see: ostia pane.list)',
}

type WaitResult = { messages: Message[]; timedOut: boolean }
type Waiter = (result: WaitResult) => void

const waiters = new Map<string, Waiter[]>()

function hasWaiter(externalId: string): boolean {
  return (waiters.get(externalId)?.length ?? 0) > 0
}

function wake(to: string, messages: Message[]): void {
  const pending = waiters.get(to)
  if (!pending || pending.length === 0) return
  waiters.delete(to)
  for (const resolve of pending) resolve({ messages, timedOut: false })
}

function addWaiter(externalId: string, resolve: Waiter): () => void {
  const list = waiters.get(externalId) ?? []
  list.push(resolve)
  waiters.set(externalId, list)
  return () => {
    const cur = waiters.get(externalId)
    if (!cur) return
    const idx = cur.indexOf(resolve)
    if (idx !== -1) cur.splice(idx, 1)
    if (cur.length === 0) waiters.delete(externalId)
  }
}

function clampTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs)) return DEFAULT_WAIT_MS
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, timeoutMs))
}

function markSeen(data: BusData, messages: readonly Message[], at: string): boolean {
  const fresh = messages.filter((message) => !message.seenAt)
  if (fresh.length === 0) return false
  const ids = new Set(fresh.map((message) => message.id))
  for (const message of fresh) message.seenAt = at
  for (const record of data.sent) {
    if (ids.has(record.id) && !record.seenAt) record.seenAt = at
  }
  return true
}

function remember(data: BusData, msg: Message): void {
  data.sent.push({
    id: msg.id,
    from: msg.from,
    to: msg.to,
    preview: busPreview(msg.text),
    ts: msg.ts,
  })
  if (data.sent.length > MAX_SENT) data.sent.splice(0, data.sent.length - MAX_SENT)
}

function deliver(data: BusData, msg: Message): BusDelivery {
  const inbox = data.inboxes[msg.to] ?? []
  inbox.push(msg)
  while (inbox.length > MAX_INBOX_MESSAGES) inbox.shift()
  data.inboxes[msg.to] = inbox
  if (!msg.quiet) remember(data, msg)
  const delivery: BusDelivery = hasWaiter(msg.to) ? 'waiting' : 'queued'
  if (delivery === 'waiting') markSeen(data, [msg], msg.ts)
  saveBus(data)
  wake(msg.to, [msg])
  return delivery
}

function unseen(messages: readonly Message[]): Message[] {
  return messages.filter((message) => !message.seenAt && !message.quiet)
}

function enforceHandoffCap(data: BusData): void {
  while (data.handoffs.length > MAX_HANDOFFS) {
    const idx = data.handoffs.findIndex((h) => h.state === 'completed' || h.state === 'failed')
    data.handoffs.splice(idx === -1 ? 0 : idx, 1)
  }
}

export function postBusMessage(from: string, to: string, text: string): string {
  const id = randomUUID()
  deliver(loadBus(), { id, from, to, text, ts: new Date().toISOString(), quiet: true })
  return id
}

export interface BusDeps {
  managerSendAllowed: () => boolean
  sent?: () => void
  announce: (from: PaneIdentity, to: PaneIdentity, text: string) => void
  hibernated: (pane: PaneIdentity) => Promise<boolean>
  inScope?: Reach['inScope']
}

function receiverOf(to: unknown): PaneIdentity | undefined {
  const target = typeof to === 'string' ? resolveExternal(to) : undefined
  return target?.kind === 'pane' ? target : undefined
}

export function registerBusMethods(deps: BusDeps): void {
  const announceQueued = (
    delivery: BusDelivery,
    from: PaneIdentity,
    to: PaneIdentity,
    text: string,
  ): void => {
    if (delivery === 'queued' && to.externalId !== from.externalId) deps.announce(from, to, text)
  }

  registerControlMethod('bus.send', {
    scripts: true,
    handler: async (params, ctx) => {
      const { to, text } = (params ?? {}) as { to: string; text: string }
      const from = ctx.identity.externalId
      const script = ctx.identity.kind === 'script'
      if (ctx.identity.manager && !deps.managerSendAllowed()) {
        throw new ResponseError(
          ErrorCodes.InvalidRequest,
          'limit: the manager sent too many bus messages this minute',
        )
      }
      if (script && (typeof to !== 'string' || !to)) {
        throw new ResponseError(ErrorCodes.InvalidParams, 'bad-request: to')
      }
      const receiver = receiverOf(to)
      if (!receiver || (script && receiver.manager)) return UNKNOWN_PANE
      if (to !== from) {
        await ensureCaps(
          ctx.authed,
          ctx.identity,
          script && !(await deps.inScope?.(ctx, receiver.workspaceId))
            ? ['send-other-pane', 'all-workspaces']
            : ['send-other-pane'],
          'bus.send',
          `to ${to}`,
        )
      }
      const data = loadBus()
      const id = randomUUID()
      const delivered = deliver(data, { id, from, to, text, ts: new Date().toISOString() })
      announceQueued(delivered, ctx.identity, receiver, text)
      deps.sent?.()
      const asleep = await deps.hibernated(receiver)
      return { ok: true, id, delivered, ...(asleep ? { asleep: true } : {}) }
    },
  })

  registerControlMethod('bus.inbox', {
    handler: (params, ctx) => {
      const { drain } = (params ?? {}) as { drain?: boolean }
      const data = loadBus()
      const me = ctx.identity.externalId
      const messages = data.inboxes[me] ?? []
      const marked = markSeen(data, messages, new Date().toISOString())
      const drained = drain === true && messages.length > 0
      if (drained) data.inboxes[me] = []
      if (marked || drained) saveBus(data)
      return { messages }
    },
  })

  registerControlMethod('bus.context', {
    handler: (_params, ctx) => {
      const data = loadBus()
      const fresh = unseen(data.inboxes[ctx.identity.externalId] ?? [])
      const context = busContext(fresh)
      if (!context) return { text: null }
      const shown = fresh.filter((message) => context.shown.includes(message.id))
      if (markSeen(data, shown, new Date().toISOString())) saveBus(data)
      return { text: context.text }
    },
  })

  registerControlMethod('bus.sent', {
    handler: (_params, ctx) => {
      const me = ctx.identity.externalId
      const mine = loadBus().sent.filter((record) => record.from === me)
      return { messages: mine.slice(-MAX_SENT_LISTED) }
    },
  })

  registerControlMethod('bus.wait', {
    handler(params, ctx) {
      const { timeoutMs } = (params ?? {}) as { timeoutMs?: number }
      const me = ctx.identity.externalId
      const clamped = clampTimeout(timeoutMs)

      const data = loadBus()
      const fresh = (data.inboxes[me] ?? []).filter((message) => !message.seenAt)
      if (fresh.length > 0) {
        markSeen(data, fresh, new Date().toISOString())
        saveBus(data)
        return Promise.resolve({ messages: fresh, timedOut: false })
      }

      return new Promise<WaitResult>((resolve) => {
        let settled = false
        const timer = setTimeout(() => {
          finish({ messages: [], timedOut: true })
        }, clamped)
        const finish = (result: WaitResult): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          unregister()
          closed.dispose()
          resolve(result)
        }
        const unregister = addWaiter(me, finish)
        const closed = ctx.conn.onClose(() => finish({ messages: [], timedOut: true }))
      })
    },
  })

  registerControlMethod('bus.handoff', {
    handler: async (params, ctx) => {
      const { to, task, summary, context } = (params ?? {}) as {
        to: string
        task: string
        summary: string
        context?: HandoffContext
      }
      const from = ctx.identity.externalId
      const receiver = receiverOf(to)
      if (!receiver) return UNKNOWN_PANE
      if (to !== from) {
        await ensureCaps(ctx.authed, ctx.identity, ['send-other-pane'], 'bus.handoff', `to ${to}`)
      }
      if (!summary?.trim()) {
        return {
          ok: false,
          error: 'summary-required',
          message: 'a handoff must carry a non-empty summary for the receiving agent',
        }
      }
      const now = new Date().toISOString()
      const id = randomUUID()
      const data = loadBus()
      const handoff: Handoff = {
        id,
        from,
        to,
        task,
        summary,
        state: 'submitted',
        context,
        ts: now,
        updatedAt: now,
      }
      data.handoffs.push(handoff)
      enforceHandoffCap(data)
      const delivered = deliver(data, {
        id: randomUUID(),
        from,
        to,
        text: `handoff ${id}: ${task} — ${summary}`,
        ts: now,
      })
      announceQueued(delivered, ctx.identity, receiver, `${task} — ${summary}`)
      return { ok: true, id, delivered }
    },
  })

  registerControlMethod('bus.claim', {
    handler: (params, ctx) => {
      const { id } = (params ?? {}) as { id: string }
      const data = loadBus()
      const handoff = data.handoffs.find((h) => h.id === id)
      if (!handoff || handoff.to !== ctx.identity.externalId) return NOT_FOUND
      handoff.state = 'claimed'
      handoff.updatedAt = new Date().toISOString()
      saveBus(data)
      return { ok: true }
    },
  })

  registerControlMethod('bus.handoffs', {
    handler: async (params, ctx) => {
      const { all } = (params ?? {}) as { all?: boolean }
      const me = ctx.identity.externalId
      if (all) {
        await ensureCaps(ctx.authed, ctx.identity, ['all-workspaces'], 'bus.handoffs --all', '')
        return { handoffs: loadBus().handoffs }
      }
      const data = loadBus()
      const handoffs = data.handoffs.filter((h) => h.to === me || h.from === me)
      return { handoffs }
    },
  })

  registerControlMethod('bus.update', {
    handler: (params, ctx) => {
      const { id, state } = (params ?? {}) as { id: string; state: HandoffState }
      const data = loadBus()
      const me = ctx.identity.externalId
      const handoff = data.handoffs.find((h) => h.id === id)
      if (!handoff || (handoff.to !== me && handoff.from !== me)) return NOT_FOUND
      handoff.state = state
      handoff.updatedAt = new Date().toISOString()
      saveBus(data)
      return { ok: true }
    },
  })
}
