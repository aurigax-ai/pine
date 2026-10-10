import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import type { Capability } from '../../shared/capabilities'
import {
  DEFAULT_TOKEN_EXPIRY,
  SCRIPT_CAPABILITIES,
  SCRIPT_TOKEN_PREFIX,
  type ScriptTokenScope,
  tokenExpiry,
} from '../../shared/permissions/scriptTokens'
import { registerControlMethod } from '../control/controlServer'
import { removeScript } from '../control/idRegistry'
import { loadJson, saveJson } from '../platform/jsonStore'
import { ensureCaps } from './controlElevation'
import type { ReachListing } from './reach'

const NAME_MAX = 60
const RETIRED_KEEP_MS = 30 * 86_400_000
const LAST_USED_EVERY_MS = 60_000

type TokenSource = 'settings' | 'cli'

interface StoredToken {
  id: string
  name: string
  hash: string
  caps: Capability[]
  scope: ScriptTokenScope
  created: string[]
  createdAt: string
  updatedAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  source: TokenSource
}

export interface ScriptToken {
  id: string
  name: string
  caps: Capability[]
  scope: ScriptTokenScope
  createdAt: string
  updatedAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  source: TokenSource
}

export interface RetiredToken {
  name: string
  retiredAt: string
}

interface StoredRetired extends RetiredToken {
  hash: string
}

export interface ScriptTokenPaths {
  path: string
  retiredPath: string
}

export interface ScriptTokenScopeView {
  scope: ScriptTokenScope
  created: string[]
}

type TokenStore = Record<string, StoredToken>

function fail(message: string): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidRequest, message)
}

function hashOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function newToken(): string {
  return `${SCRIPT_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`
}

function heldCaps(raw: unknown): Capability[] {
  const held = Array.isArray(raw) ? raw : []
  return SCRIPT_CAPABILITIES.filter((cap) => cap !== 'all-workspaces' && held.includes(cap))
}

function ids(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string' && v)) return undefined
  return [...new Set(raw as string[])]
}

function storedScope(raw: unknown): ScriptTokenScope | undefined {
  const s = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  if (s.kind === 'all') return { kind: 'all' }
  const groups = ids(s.groups)
  const workspaces = ids(s.workspaces)
  if (s.kind !== 'limited' || !groups || !workspaces) return undefined
  return { kind: 'limited', groups, workspaces, ownWorkspaces: s.ownWorkspaces === true }
}

function isoOrNull(raw: unknown): string | null {
  return typeof raw === 'string' && !Number.isNaN(Date.parse(raw)) ? raw : null
}

function load(path: string): TokenStore {
  const raw = loadJson<Record<string, Record<string, unknown>>>(path, {})
  const store: TokenStore = {}
  for (const [id, t] of Object.entries(raw)) {
    const scope = storedScope(t?.scope)
    if (typeof t?.hash !== 'string' || typeof t.name !== 'string' || !scope) continue
    if (t.expiresAt !== null && isoOrNull(t.expiresAt) === null) continue
    const createdAt = typeof t.createdAt === 'string' ? t.createdAt : ''
    store[id] = {
      id,
      name: t.name,
      hash: t.hash,
      caps: heldCaps(t.caps),
      scope,
      created: ids(t.created) ?? [],
      createdAt,
      updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : createdAt,
      expiresAt: isoOrNull(t.expiresAt),
      lastUsedAt: isoOrNull(t.lastUsedAt),
      source: t.source === 'settings' ? 'settings' : 'cli',
    }
  }
  return store
}

function save(path: string, store: TokenStore): void {
  saveJson(path, store, { secure: true })
}

function publicView(t: StoredToken): ScriptToken {
  return {
    id: t.id,
    name: t.name,
    caps: [...t.caps],
    scope: structuredClone(t.scope),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
    source: t.source,
  }
}

function expired(t: Pick<StoredToken, 'expiresAt'>, now: Date): boolean {
  return t.expiresAt !== null && Date.parse(t.expiresAt) <= now.getTime()
}

function sameHash(stored: string, given: Buffer): boolean {
  const known = Buffer.from(stored, 'hex')
  return known.length === given.length && timingSafeEqual(known, given)
}

function matching<T extends { hash: string }>(entries: Iterable<T>, token: string): T | undefined {
  if (!token.startsWith(SCRIPT_TOKEN_PREFIX)) return undefined
  const given = Buffer.from(hashOf(token), 'hex')
  for (const entry of entries) if (sameHash(entry.hash, given)) return entry
  return undefined
}

function findIn(store: TokenStore, ref: string): StoredToken {
  if (store[ref]) return store[ref]
  const named = Object.values(store).filter((t) => t.name === ref)
  if (named.length > 1) throw fail(`ambiguous-token: ${ref} (pass its id from ostia token list)`)
  if (named.length === 0) throw fail(`unknown-token: ${ref}`)
  return named[0]
}

function cleanTokenName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name || name.length > NAME_MAX || !/^[\w .@-]+$/.test(name)) {
    throw fail(`bad-request: name (1-${NAME_MAX} letters, digits, space, . _ @ -)`)
  }
  return name
}

function cleanCaps(raw: unknown): Capability[] {
  if (!Array.isArray(raw) || raw.length === 0) throw fail('bad-request: caps')
  const unknown = raw.filter((cap) => !SCRIPT_CAPABILITIES.includes(cap as Capability))
  if (unknown.length > 0) {
    throw fail(
      `bad-request: a script token can hold only ${SCRIPT_CAPABILITIES.join(', ')} (got ${unknown.join(', ')})`,
    )
  }
  return SCRIPT_CAPABILITIES.filter((cap) => raw.includes(cap))
}

function cleanExpires(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) throw fail('bad-request: expires')
  try {
    tokenExpiry(raw, new Date())
  } catch (err) {
    throw fail(`bad-request: ${(err as Error).message}`)
  }
  return raw
}

export type ScopeRequest =
  | { kind: 'all' }
  | { kind: 'limited'; groups: string[]; workspaces: string[]; ownWorkspaces: boolean }

function cleanScope(raw: unknown, caps: readonly Capability[]): ScopeRequest | undefined {
  const reachAll = caps.includes('all-workspaces')
  if (raw === undefined) return reachAll ? { kind: 'all' } : undefined
  const s = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  if (s.kind === 'all') return { kind: 'all' }
  const groups = s.groups === undefined ? [] : ids(s.groups)
  const workspaces = s.workspaces === undefined ? [] : ids(s.workspaces)
  if (s.kind !== 'limited' || !groups || !workspaces || groups.length + workspaces.length === 0) {
    throw fail('bad-request: scope (all, or at least one group or workspace)')
  }
  if (reachAll) throw fail('bad-request: all-workspaces needs the scope all')
  return { kind: 'limited', groups, workspaces, ownWorkspaces: s.ownWorkspaces === true }
}

export interface TokenRequest {
  name: string
  caps: Capability[]
  scope: ScopeRequest
  expires: string
}

export function parseTokenRequest(raw: unknown): TokenRequest {
  const p = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const name = cleanTokenName(p.name)
  const caps = cleanCaps(p.caps)
  const scope = cleanScope(p.scope, caps)
  if (!scope) {
    throw fail('bad-request: scope (pass --scope all, group:<name|id> or workspace:<name|id>)')
  }
  const expires = p.expires === undefined ? DEFAULT_TOKEN_EXPIRY : cleanExpires(p.expires)
  return { name, caps: heldCaps(caps), scope, expires }
}

export interface TokenChanges {
  ref: string
  name?: string
  caps?: Capability[]
  scope?: ScopeRequest
  expires?: string
}

export function parseTokenChanges(raw: unknown): TokenChanges {
  const p = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  if (typeof p.id !== 'string' || !p.id) throw fail('bad-request: id')
  const changes: TokenChanges = { ref: p.id }
  if (p.name !== undefined) changes.name = cleanTokenName(p.name)
  const caps = p.caps === undefined ? undefined : cleanCaps(p.caps)
  if (caps) changes.caps = heldCaps(caps)
  const scope = cleanScope(p.scope, caps ?? [])
  if (scope) changes.scope = scope
  if (p.expires !== undefined) changes.expires = cleanExpires(p.expires)
  if (Object.keys(changes).length === 1) {
    throw fail('bad-request: nothing to change (name, caps, scope or expires)')
  }
  return changes
}

export function regenerates(changes: TokenChanges): boolean {
  return changes.caps !== undefined || changes.scope !== undefined || changes.expires !== undefined
}

function resolveRef(ref: string, entries: { id: string; name: string }[], kind: string): string {
  if (entries.some((e) => e.id === ref)) return ref
  const named = entries.filter((e) => e.name === ref)
  if (named.length > 1) throw fail(`ambiguous-${kind}: ${ref} (pass its id)`)
  if (named.length === 0) throw fail(`unknown-${kind}: ${ref}`)
  return named[0].id
}

export function resolveScope(request: ScopeRequest, listing: ReachListing): ScriptTokenScope {
  if (request.kind === 'all') return { kind: 'all' }
  const groups = listing.groups.map((g) => ({ id: g.groupId, name: g.name }))
  const workspaces = listing.workspaces.map((w) => ({ id: w.workspaceId, name: w.name }))
  return {
    kind: 'limited',
    groups: [...new Set(request.groups.map((ref) => resolveRef(ref, groups, 'group')))],
    workspaces: [
      ...new Set(request.workspaces.map((ref) => resolveRef(ref, workspaces, 'workspace'))),
    ],
    ownWorkspaces: request.ownWorkspaces,
  }
}

export interface ScriptTokenOptions {
  scope?: ScriptTokenScope
  expiresAt?: string | null
  source?: TokenSource
}

export function createScriptToken(
  path: string,
  name: string,
  caps: readonly Capability[],
  options: ScriptTokenOptions = {},
  now = new Date(),
): ScriptToken & { token: string } {
  const store = load(path)
  const token = newToken()
  const at = now.toISOString()
  const scope: ScriptTokenScope =
    options.scope ??
    (caps.includes('all-workspaces')
      ? { kind: 'all' }
      : { kind: 'limited', groups: [], workspaces: [], ownWorkspaces: false })
  const stored: StoredToken = {
    id: `script_${randomUUID()}`,
    name,
    hash: hashOf(token),
    caps: heldCaps(caps),
    scope,
    created: [],
    createdAt: at,
    updatedAt: at,
    expiresAt:
      options.expiresAt === undefined ? tokenExpiry(DEFAULT_TOKEN_EXPIRY, now) : options.expiresAt,
    lastUsedAt: null,
    source: options.source ?? 'cli',
  }
  store[stored.id] = stored
  save(path, store)
  return { ...publicView(stored), token }
}

export interface ScriptTokenUpdate {
  name?: string
  caps?: readonly Capability[]
  scope?: ScriptTokenScope
  expiresAt?: string | null
}

export function updateScriptToken(
  path: string,
  ref: string,
  update: ScriptTokenUpdate,
  now = new Date(),
): ScriptToken & { token?: string } {
  const store = load(path)
  const stored = findIn(store, ref)
  if (update.name !== undefined) stored.name = update.name
  const regenerate =
    update.caps !== undefined || update.scope !== undefined || update.expiresAt !== undefined
  let token: string | undefined
  if (regenerate) {
    if (update.caps !== undefined) stored.caps = heldCaps(update.caps)
    if (update.scope !== undefined) stored.scope = update.scope
    if (update.expiresAt !== undefined) stored.expiresAt = update.expiresAt
    token = newToken()
    stored.hash = hashOf(token)
  }
  stored.updatedAt = now.toISOString()
  save(path, store)
  if (regenerate) removeScript(stored.id)
  return token ? { ...publicView(stored), token } : publicView(stored)
}

export function findScriptToken(path: string, ref: string): ScriptToken {
  return publicView(findIn(load(path), ref))
}

export function listScriptTokens(path: string): ScriptToken[] {
  return Object.values(load(path)).map(publicView)
}

export function revokeScriptToken(path: string, id: string): boolean {
  const store = load(path)
  if (!store[id]) return false
  delete store[id]
  save(path, store)
  return true
}

export function verifyScriptToken(
  path: string,
  token: string,
  now = new Date(),
): ScriptToken | undefined {
  const stored = matching(Object.values(load(path)), token)
  return stored && !expired(stored, now) ? publicView(stored) : undefined
}

export function scriptTokenScope(path: string, id: string): ScriptTokenScopeView | undefined {
  const stored = load(path)[id]
  return stored ? { scope: stored.scope, created: [...stored.created] } : undefined
}

export function recordCreatedWorkspace(path: string, id: string, workspaceId: string): void {
  const store = load(path)
  const stored = store[id]
  if (!stored || stored.created.includes(workspaceId)) return
  stored.created.push(workspaceId)
  save(path, store)
}

function loadRetired(path: string, now: Date): StoredRetired[] {
  const raw = loadJson<unknown>(path, [])
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (r): r is StoredRetired =>
      typeof r?.name === 'string' &&
      typeof r.hash === 'string' &&
      typeof r.retiredAt === 'string' &&
      now.getTime() - Date.parse(r.retiredAt) < RETIRED_KEEP_MS,
  )
}

export function retireLegacyScriptTokens(
  legacyPath: string,
  retiredPath: string,
  now = new Date(),
): string[] {
  if (!existsSync(legacyPath)) return []
  const legacy = loadJson<Record<string, { name?: unknown; hash?: unknown }> | null>(
    legacyPath,
    null,
  )
  const at = now.toISOString()
  const moved = Object.values(legacy ?? {}).flatMap((t) =>
    typeof t?.name === 'string' && typeof t.hash === 'string'
      ? [{ name: t.name, hash: t.hash, retiredAt: at }]
      : [],
  )
  saveJson(retiredPath, [...loadRetired(retiredPath, now), ...moved], { secure: true })
  rmSync(legacyPath, { force: true })
  return moved.map((t) => t.name)
}

export function retiredScriptTokens(retiredPath: string, now = new Date()): RetiredToken[] {
  return loadRetired(retiredPath, now).map(({ name, retiredAt }) => ({ name, retiredAt }))
}

const lastWritten = new Map<string, number>()

function touch(path: string, stored: StoredToken, now: Date): void {
  const last = lastWritten.get(stored.id)
  if (last !== undefined && now.getTime() - last < LAST_USED_EVERY_MS) return
  lastWritten.set(stored.id, now.getTime())
  const store = load(path)
  if (!store[stored.id]) return
  store[stored.id].lastUsedAt = now.toISOString()
  save(path, store)
}

export interface AuthenticatedScript {
  id: string
  caps: Capability[]
  expiresAt: string | null
}

export function checkScriptToken(
  paths: ScriptTokenPaths,
  token: string,
  now = new Date(),
): AuthenticatedScript | undefined {
  const stored = matching(Object.values(load(paths.path)), token)
  if (stored && expired(stored, now)) {
    throw fail(
      `token-expired: the script token "${stored.name}" expired at ${stored.expiresAt}; regenerate it with ostia token update ${stored.id} --expires <when>`,
    )
  }
  if (stored) {
    touch(paths.path, stored, now)
    const caps: Capability[] =
      stored.scope.kind === 'all' ? [...stored.caps, 'all-workspaces'] : [...stored.caps]
    return { id: stored.id, caps, expiresAt: stored.expiresAt }
  }
  const retired = matching(loadRetired(paths.retiredPath, now), token)
  if (retired) {
    throw fail(
      `token-retired: the script token "${retired.name}" stopped working when Ostia was upgraded; create a new one with ostia token create`,
    )
  }
  return undefined
}

let requireUserPresence: (reason: string) => Promise<boolean> = async () => true

export function setUserPresenceCheck(check: (reason: string) => Promise<boolean>): void {
  requireUserPresence = check
}

async function confirmUser(reason: string): Promise<void> {
  if (!(await requireUserPresence(reason))) throw fail(`cancelled: ${reason}`)
}

function describeScope(scope: ScriptTokenScope): string {
  if (scope.kind === 'all') return 'every workspace'
  const parts = [
    ...scope.groups.map((id) => `group ${id}`),
    ...scope.workspaces.map((id) => `workspace ${id}`),
    ...(scope.ownWorkspaces ? ['the workspaces it creates there'] : []),
  ]
  return parts.join(', ')
}

function describeExpiry(expiresAt: string | null): string {
  return expiresAt === null ? 'never expires' : `expires ${expiresAt}`
}

function approvalCaps(caps: readonly Capability[], scope: ScriptTokenScope): Capability[] {
  return ['settings-write', ...caps, ...(scope.kind === 'all' ? (['all-workspaces'] as const) : [])]
}

export interface ScriptTokenDeps {
  path: () => string
  retiredPath: () => string
  listing: () => Promise<ReachListing>
}

export function registerScriptTokenMethods(deps: ScriptTokenDeps): void {
  registerControlMethod('token.create', {
    handler: async (raw, ctx) => {
      const request = parseTokenRequest(raw)
      const scope = resolveScope(request.scope, await deps.listing())
      const expiresAt = tokenExpiry(request.expires, new Date())
      await ensureCaps(
        ctx.authed,
        ctx.identity,
        approvalCaps(request.caps, scope),
        'token.create',
        `let scripts outside Ostia use the token "${request.name}" with ${request.caps.join(', ') || 'no capability'} on ${describeScope(scope)}; it ${describeExpiry(expiresAt)}`,
      )
      await confirmUser(`generate the script token "${request.name}"`)
      return createScriptToken(deps.path(), request.name, request.caps, {
        scope,
        expiresAt,
        source: 'cli',
      })
    },
  })

  registerControlMethod('token.update', {
    handler: async (raw, ctx) => {
      const changes = parseTokenChanges(raw)
      const current = findScriptToken(deps.path(), changes.ref)
      const name = changes.name ?? current.name
      if (!regenerates(changes)) {
        await ensureCaps(
          ctx.authed,
          ctx.identity,
          ['settings-write'],
          'token.update',
          `rename the script token "${current.name}" to "${name}"`,
        )
        return updateScriptToken(deps.path(), current.id, { name })
      }
      const caps = changes.caps ?? current.caps
      const scope = changes.scope
        ? resolveScope(changes.scope, await deps.listing())
        : current.scope
      const expiresAt =
        changes.expires === undefined ? current.expiresAt : tokenExpiry(changes.expires, new Date())
      await ensureCaps(
        ctx.authed,
        ctx.identity,
        approvalCaps(caps, scope),
        'token.update',
        `regenerate the script token "${name}" with ${caps.join(', ') || 'no capability'} on ${describeScope(scope)}; it ${describeExpiry(expiresAt)}. The old value stops working at once`,
      )
      await confirmUser(`regenerate the script token "${name}"`)
      return updateScriptToken(deps.path(), current.id, { name, caps, scope, expiresAt })
    },
  })

  registerControlMethod('token.list', {
    cap: 'settings-read',
    handler: () => listScriptTokens(deps.path()),
  })

  registerControlMethod('token.retired', {
    cap: 'settings-read',
    handler: () => retiredScriptTokens(deps.retiredPath()),
  })

  registerControlMethod('token.revoke', {
    handler: async (raw, ctx) => {
      const ref = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined
      if (typeof ref !== 'string' || !ref) throw fail('bad-request: id')
      await ensureCaps(ctx.authed, ctx.identity, ['settings-write'], 'token.revoke', ref)
      const { id } = findScriptToken(deps.path(), ref)
      revokeScriptToken(deps.path(), id)
      removeScript(id)
      return { ok: true, id }
    },
  })
}
