import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlMethod, ControlMethodContext } from '../control/controlServer'

const dataHome = mkdtempSync(join(tmpdir(), 'ostia-bus-'))
process.env.XDG_DATA_HOME = dataHome

const methods = new Map<string, ControlMethod>()
vi.mock('../control/controlServer', () => ({
  registerControlMethod: (name: string, method: ControlMethod) => methods.set(name, method),
}))
const ensureCaps = vi.fn(async () => {})
vi.mock('../approvals/controlElevation', () => ({ ensureCaps }))

const { postBusMessage, registerBusMethods } = await import('./bus')
const { markManager, registerPane, registerScript } = await import('../control/idRegistry')

const announce = vi.fn()
let managerMaySend = true
const asleepPanes = new Set<string>()
const scriptReaches = new Set<string>()
registerBusMethods({
  managerSendAllowed: () => managerMaySend,
  announce,
  hibernated: async (pane) => asleepPanes.has(pane.paneId),
  inScope: async (ctx, workspaceId) =>
    ctx.identity.kind === 'script' && scriptReaches.has(workspaceId),
})

const sender = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'bus-sender' })
const receiver = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'bus-receiver' })

type Closer = () => void

function contextOf(identity: typeof sender, closers: Closer[] = []): ControlMethodContext {
  return {
    identity,
    authed: {},
    conn: {
      onClose: (fn: Closer) => {
        closers.push(fn)
        return { dispose: () => closers.splice(closers.indexOf(fn), 1) }
      },
    },
  } as unknown as ControlMethodContext
}

function call<T>(name: string, identity: typeof sender, params?: unknown, closers?: Closer[]): T {
  const method = methods.get(name)
  if (!method) throw new Error(`no method ${name}`)
  return method.handler(params, contextOf(identity, closers)) as T
}

interface Stored {
  id: string
  text: string
  seenAt?: string
  quiet?: true
}
interface Sent {
  id: string
  to: string
  preview: string
  seenAt?: string
}

const inbox = (identity = receiver, drain = false) =>
  call<{ messages: Stored[] }>('bus.inbox', identity, { drain }).messages
const sent = (identity = sender) => call<{ messages: Sent[] }>('bus.sent', identity).messages
const send = (text: string, to = receiver.externalId, from = sender) =>
  call<Promise<{ ok: boolean; id?: string; delivered?: string; asleep?: true; error?: string }>>(
    'bus.send',
    from,
    { to, text },
  )
const context = (identity = receiver) => call<{ text: string | null }>('bus.context', identity).text

beforeEach(() => {
  rmSync(join(dataHome, 'ostia'), { recursive: true, force: true })
  announce.mockClear()
  ensureCaps.mockClear()
  ensureCaps.mockImplementation(async () => {})
  managerMaySend = true
  asleepPanes.clear()
})

afterAll(() => rmSync(dataHome, { recursive: true, force: true }))

describe('bus delivery', () => {
  it('queues a message for a pane that is not waiting and tells the human', async () => {
    const res = await send('tests are green')
    expect(res).toMatchObject({ ok: true, delivered: 'queued' })
    expect(announce).toHaveBeenCalledWith(sender, receiver, 'tests are green')
    expect(ensureCaps).toHaveBeenCalledWith(
      {},
      sender,
      ['send-other-pane'],
      'bus.send',
      `to ${receiver.externalId}`,
    )
  })

  it('hands a message straight to a pane blocked in bus wait, without an unread mark', async () => {
    const waiting = call<Promise<{ messages: Stored[]; timedOut: boolean }>>('bus.wait', receiver, {
      timeoutMs: 5000,
    })
    const res = await send('wake up')
    expect(res.delivered).toBe('waiting')
    expect(announce).not.toHaveBeenCalled()
    const woken = await waiting
    expect(woken.timedOut).toBe(false)
    expect(woken.messages.map((m) => m.text)).toEqual(['wake up'])
    expect(sent()[0]?.seenAt).toBeTruthy()
  })

  it('queues again once the waiting command lost its connection', async () => {
    const closers: Closer[] = []
    const waiting = call<Promise<{ timedOut: boolean }>>(
      'bus.wait',
      receiver,
      { timeoutMs: 5000 },
      closers,
    )
    for (const close of [...closers]) close()
    expect((await waiting).timedOut).toBe(true)
    expect((await send('anyone?')).delivered).toBe('queued')
    expect(sent()[0]?.seenAt).toBeUndefined()
  })

  it('refuses a receiver no open pane holds, before asking the human for anything', async () => {
    const res = await send('hello', '00000000-0000-0000-0000-000000000000')
    expect(res).toMatchObject({ ok: false, error: 'unknown-pane' })
    expect(ensureCaps).not.toHaveBeenCalled()
    expect(sent()).toEqual([])
  })

  it('stores nothing and marks nothing when the human denies the capability', async () => {
    ensureCaps.mockRejectedValueOnce(new Error('denied: send-other-pane'))
    await expect(send('psst')).rejects.toThrow('denied: send-other-pane')
    expect(inbox()).toEqual([])
    expect(announce).not.toHaveBeenCalled()
  })

  it('sends to itself without a capability or an unread mark', async () => {
    const res = await send('note to self', sender.externalId)
    expect(res.delivered).toBe('queued')
    expect(ensureCaps).not.toHaveBeenCalled()
    expect(announce).not.toHaveBeenCalled()
  })

  it('still holds the manager to its bus limit', async () => {
    const manager = registerPane({ windowId: 'w1', workspaceId: 'mgr', paneId: 'bus-manager' })
    markManager('bus-manager')
    managerMaySend = false
    await expect(send('go', receiver.externalId, manager)).rejects.toThrow('limit:')
    expect(inbox()).toEqual([])
  })

  it('announces a queued handoff by its task and summary', async () => {
    const res = await call<Promise<{ ok: boolean; delivered: string }>>('bus.handoff', sender, {
      to: receiver.externalId,
      task: 'fix the flaky test',
      summary: 'it fails one run in five',
    })
    expect(res).toMatchObject({ ok: true, delivered: 'queued' })
    expect(announce).toHaveBeenCalledWith(
      sender,
      receiver,
      'fix the flaky test — it fails one run in five',
    )
  })
})

describe('bus.send from a script token', () => {
  const script = registerScript('script_bus')

  it('is open to script tokens and delivers with send-other-pane and all-workspaces', async () => {
    expect(methods.get('bus.send')?.scripts).toBe(true)
    const res = await send('next task', receiver.externalId, script)
    expect(res).toMatchObject({ ok: true, delivered: 'queued' })
    expect(inbox().map((m) => m.text)).toEqual(['next task'])
    expect(ensureCaps).toHaveBeenCalledWith(
      {},
      script,
      ['send-other-pane', 'all-workspaces'],
      'bus.send',
      `to ${receiver.externalId}`,
    )
  })

  it('needs only send-other-pane for a receiver in the token scope', async () => {
    scriptReaches.add('ws1')
    try {
      await send('in scope', receiver.externalId, script)
    } finally {
      scriptReaches.clear()
    }
    expect(ensureCaps).toHaveBeenCalledWith(
      {},
      script,
      ['send-other-pane'],
      'bus.send',
      `to ${receiver.externalId}`,
    )
  })

  it('stores nothing when the token lacks a capability', async () => {
    ensureCaps.mockRejectedValueOnce(new Error('needs-elevation: all-workspaces'))
    await expect(send('psst', receiver.externalId, script)).rejects.toThrow(
      'needs-elevation: all-workspaces',
    )
    expect(inbox()).toEqual([])
  })

  it('must name a receiver, and never reaches the manager pane', async () => {
    await expect(send('x', '', script)).rejects.toThrow('bad-request: to')
    const manager = registerPane({ windowId: 'w1', workspaceId: 'mgr', paneId: 'bus-manager-2' })
    markManager('bus-manager-2')
    expect(await send('x', manager.externalId, script)).toMatchObject({
      ok: false,
      error: 'unknown-pane',
    })
    expect(ensureCaps).not.toHaveBeenCalled()
  })
})

describe('bus seen marks', () => {
  it('shows unseen messages to the hook once, keeps them in the inbox and tells the sender', async () => {
    await send('first')
    await send('second')
    expect(sent().map((m) => m.seenAt)).toEqual([undefined, undefined])

    const shown = context()
    expect(shown).toContain('2 unread messages')
    expect(shown).toContain('first')
    expect(shown).toContain('second')
    expect(context()).toBeNull()

    const kept = inbox()
    expect(kept.map((m) => m.text)).toEqual(['first', 'second'])
    expect(kept.every((m) => typeof m.seenAt === 'string')).toBe(true)
    expect(sent().every((m) => typeof m.seenAt === 'string')).toBe(true)
  })

  it('adds nothing for an empty inbox', () => {
    expect(context()).toBeNull()
  })

  it('marks messages seen when the receiver lists its inbox, and keeps the receipt after a drain', async () => {
    await send('read me')
    expect(inbox(receiver, true).map((m) => m.text)).toEqual(['read me'])
    expect(inbox()).toEqual([])
    expect(context()).toBeNull()
    expect(sent()).toMatchObject([{ to: receiver.externalId, preview: 'read me' }])
    expect(sent()[0]?.seenAt).toBeTruthy()
  })

  it('leaves messages that did not fit unseen, so the next prompt shows them', async () => {
    for (let i = 0; i < 6; i++) await send(`${i}`.repeat(900))
    expect(context()).toContain('6 unread messages')
    expect(sent().filter((m) => m.seenAt)).toHaveLength(3)
    expect(context()).toContain('3 unread messages')
    expect(sent().filter((m) => m.seenAt)).toHaveLength(6)
    expect(context()).toBeNull()
  })

  it('lists a pane only what it sent itself, as a clipped one-line preview', async () => {
    await send(`line one \x1b[31m${'z'.repeat(300)}\nline two`)
    await send('from the other side', sender.externalId, receiver)
    const mine = sent()
    expect(mine).toHaveLength(1)
    expect(mine[0]?.preview).toHaveLength(120)
    expect(mine[0]?.preview).not.toContain('\x1b')
    expect(mine[0]?.preview).not.toContain('line two')
    expect(sent(receiver).map((m) => m.preview)).toEqual(['from the other side'])
  })

  it('waits only for a message it has not seen', async () => {
    await send('old news')
    const first = await call<Promise<{ messages: Stored[]; timedOut: boolean }>>(
      'bus.wait',
      receiver,
      { timeoutMs: 1000 },
    )
    expect(first.timedOut).toBe(false)
    expect(sent()[0]?.seenAt).toBeTruthy()
    const second = await call<Promise<{ messages: Stored[]; timedOut: boolean }>>(
      'bus.wait',
      receiver,
      { timeoutMs: 1000 },
    )
    expect(second.timedOut).toBe(true)
    expect(second.messages).toEqual([])
  })

  it('answers only the new message when one ends the wait, not what was already seen', async () => {
    await send('old news')
    inbox()
    const waiting = call<Promise<{ messages: Stored[]; timedOut: boolean }>>('bus.wait', receiver, {
      timeoutMs: 5000,
    })
    await send('fresh')
    const woken = await waiting
    expect(woken.timedOut).toBe(false)
    expect(woken.messages.map((m) => m.text)).toEqual(['fresh'])
  })

  it('answers only the unseen messages already in the inbox', async () => {
    await send('old news')
    inbox()
    await send('fresh')
    const res = await call<Promise<{ messages: Stored[]; timedOut: boolean }>>(
      'bus.wait',
      receiver,
      { timeoutMs: 1000 },
    )
    expect(res.timedOut).toBe(false)
    expect(res.messages.map((m) => m.text)).toEqual(['fresh'])
  })
})

describe('messages Ostia sends on the human’s action', () => {
  it('reach the inbox without an unread mark, hook context or a sent record', () => {
    postBusMessage(sender.externalId, receiver.externalId, '{"kind":"capture"}')
    expect(announce).not.toHaveBeenCalled()
    expect(context()).toBeNull()
    expect(sent()).toEqual([])
    expect(inbox().map((m) => m.text)).toEqual(['{"kind":"capture"}'])
  })

  it('still wake a pane blocked in bus wait', async () => {
    const waiting = call<Promise<{ messages: Stored[] }>>('bus.wait', receiver, { timeoutMs: 5000 })
    postBusMessage(sender.externalId, receiver.externalId, '{"kind":"selection"}')
    expect((await waiting).messages.map((m) => m.text)).toEqual(['{"kind":"selection"}'])
  })

  it('reads a store that has no sent list yet', async () => {
    const path = join(dataHome, 'ostia', 'bus.json')
    mkdirSync(join(dataHome, 'ostia'), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        inboxes: {
          [receiver.externalId]: [
            {
              id: 'old-1',
              from: sender.externalId,
              to: receiver.externalId,
              text: 'left over',
              ts: 't',
            },
          ],
        },
        handoffs: [],
      }),
    )
    expect(context()).toContain('left over')
    expect((await send('new')).delivered).toBe('queued')
    expect(sent().map((m) => m.preview)).toEqual(['new'])
  })
})

describe('bus.send to a hibernated pane', () => {
  it('stores the message and says the receiver is asleep, and says nothing for an awake one', async () => {
    const awake = await send('first')
    expect(awake).toMatchObject({ ok: true, delivered: 'queued' })
    expect(awake).not.toHaveProperty('asleep')
    asleepPanes.add('bus-receiver')
    expect(await send('second')).toMatchObject({ ok: true, delivered: 'queued', asleep: true })
    expect(inbox().map((m) => m.text)).toEqual(['first', 'second'])
  })
})
