import type { Capability } from '../../shared/capabilities'
import { hasCap, initCaps, setCaps } from '../approvals/capabilityStore'
import { registerScript, resolveToken } from './idRegistry'

export interface AuthedConn {
  externalId: string
  paneId: string
  workspaceId: string
  scriptSession?: string
}

export type ScriptTokenCheck = (
  token: string,
) => { id: string; caps: Capability[]; expiresAt?: string | null } | undefined

let checkScriptToken: ScriptTokenCheck = () => undefined
const scriptExpiry = new Map<string, number>()

export function setScriptTokenCheck(check: ScriptTokenCheck): void {
  checkScriptToken = check
}

export function authenticate(hello: { token?: unknown }): AuthedConn | null {
  if (typeof hello?.token !== 'string') return null
  const id = resolveToken(hello.token)
  if (id && id.kind !== 'script') {
    initCaps(id.externalId)
    return { externalId: id.externalId, paneId: id.paneId, workspaceId: id.workspaceId }
  }
  const script = checkScriptToken(hello.token)
  if (!script) return null
  const identity = registerScript(script.id)
  setCaps(identity.externalId, script.caps)
  if (typeof script.expiresAt === 'string') {
    scriptExpiry.set(identity.externalId, Date.parse(script.expiresAt))
  } else scriptExpiry.delete(identity.externalId)
  return {
    externalId: identity.externalId,
    paneId: '',
    workspaceId: '',
    scriptSession: identity.token,
  }
}

export function scriptExpired(externalId: string, now = Date.now()): boolean {
  const at = scriptExpiry.get(externalId)
  return at !== undefined && at <= now
}

export type CapFilter = (conn: AuthedConn, cap: Capability) => boolean

let capFilter: CapFilter = () => true

export function setCapFilter(filter: CapFilter): void {
  capFilter = filter
}

export function capAllowedHere(conn: AuthedConn, cap: Capability): boolean {
  return capFilter(conn, cap)
}

export function connHasCap(conn: AuthedConn, cap: Capability): boolean {
  return capFilter(conn, cap) && hasCap(conn.externalId, cap)
}
