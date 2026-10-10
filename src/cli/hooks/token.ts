import type { MessageConnection } from 'vscode-jsonrpc/node'
import {
  NEVER_EXPIRES,
  SCRIPT_CAPABILITIES,
  SCRIPT_TOKEN_PRESETS,
  type ScriptTokenScope,
  isScriptTokenPreset,
} from '../../shared/permissions/scriptTokens'
import { parseArgs } from '../common/args'

type ScopeParam =
  | { kind: 'all' }
  | { kind: 'limited'; groups: string[]; workspaces: string[]; ownWorkspaces: boolean }

interface TokenSettings {
  caps?: string[]
  scope?: ScopeParam
  expires?: string
}

type TokenCall =
  | { method: 'token.create'; params: { name: string; caps: string[] } & TokenSettings }
  | { method: 'token.update'; params: { id: string; name?: string } & TokenSettings }
  | { method: 'token.list'; params: Record<string, never>; json: boolean; show?: string }
  | { method: 'token.revoke'; params: { id: string } }

const TOKEN_USAGE = [
  'usage: ostia token create <name> (--cap <capability>… | --preset readonly|coordinator)',
  '         [--scope all | --scope group:<name|id> | --scope workspace:<name|id>]… [--own-workspaces]',
  '         [--expires 7d|30d|90d|1y|YYYY-MM-DD|never [--yes-never-expires]]',
  '       ostia token update <id|name> [--name <name>] [--cap …] [--preset …] [--scope …]… [--own-workspaces] [--expires …]',
  '       ostia token show <id|name> [--json]',
  '       ostia token list [--json]',
  '       ostia token revoke <id|name>',
  `capabilities: ${SCRIPT_CAPABILITIES.join(' ')}`,
].join('\n')

function scopeOf(refs: string[], ownWorkspaces: boolean): ScopeParam | undefined {
  if (refs.length === 0) {
    if (ownWorkspaces) throw new Error('--own-workspaces needs a --scope group:<name|id>')
    return undefined
  }
  if (refs.includes('all')) {
    if (refs.length > 1 || ownWorkspaces) throw new Error('--scope all stands alone')
    return { kind: 'all' }
  }
  const groups: string[] = []
  const workspaces: string[] = []
  for (const ref of refs) {
    const [kind, ...rest] = ref.split(':')
    const value = rest.join(':')
    if (!value || (kind !== 'group' && kind !== 'workspace')) {
      throw new Error(`--scope ${ref} (use all, group:<name|id> or workspace:<name|id>)`)
    }
    ;(kind === 'group' ? groups : workspaces).push(value)
  }
  return { kind: 'limited', groups, workspaces, ownWorkspaces }
}

function capsOf(caps: string[], preset: string | undefined): string[] | undefined {
  if (preset === undefined) return caps.length > 0 ? caps : undefined
  if (!isScriptTokenPreset(preset)) throw new Error(`--preset ${preset} (readonly or coordinator)`)
  return [...new Set([...SCRIPT_TOKEN_PRESETS[preset], ...caps])]
}

function settingsOf(rest: string[], create: boolean) {
  const { positional, values, lists, booleans } = parseArgs(rest, {
    values: { preset: '--preset', expires: '--expires', name: '--name' },
    lists: { caps: '--cap', scopes: '--scope' },
    booleans: { own: '--own-workspaces', never: '--yes-never-expires' },
  })
  const settings: TokenSettings = {}
  const caps = capsOf(lists.caps, values.preset)
  if (caps) settings.caps = caps
  const scope = scopeOf(lists.scopes, booleans.own)
  if (scope) settings.scope = scope
  if (values.expires === NEVER_EXPIRES && !booleans.never) {
    throw new Error(
      '--expires never keeps the token valid until you revoke it; add --yes-never-expires to confirm',
    )
  }
  if (values.expires !== undefined) settings.expires = values.expires
  if (create && values.name !== undefined) throw new Error(TOKEN_USAGE)
  return { positional, settings, name: values.name }
}

export function parseTokenArgs(argv: string[]): TokenCall {
  const [sub, ...rest] = argv
  if (sub === 'create') {
    const { positional, settings } = settingsOf(rest, true)
    const name = positional.join(' ').trim()
    if (!name || !settings.caps) throw new Error(TOKEN_USAGE)
    return { method: 'token.create', params: { name, ...settings, caps: settings.caps } }
  }
  if (sub === 'update') {
    const { positional, settings, name } = settingsOf(rest, false)
    if (positional.length !== 1 || !positional[0]) throw new Error(TOKEN_USAGE)
    if (name === undefined && Object.keys(settings).length === 0) throw new Error(TOKEN_USAGE)
    return {
      method: 'token.update',
      params: { id: positional[0], ...(name !== undefined ? { name } : {}), ...settings },
    }
  }
  if (sub === 'list' || sub === 'show') {
    const { positional, booleans } = parseArgs(rest, { booleans: { json: '--json' } })
    if (sub === 'list') {
      if (positional.length > 0) throw new Error(TOKEN_USAGE)
      return { method: 'token.list', params: {}, json: booleans.json }
    }
    if (positional.length !== 1 || !positional[0]) throw new Error(TOKEN_USAGE)
    return { method: 'token.list', params: {}, json: booleans.json, show: positional[0] }
  }
  if (sub === 'revoke') {
    if (rest.length !== 1 || !rest[0]) throw new Error(TOKEN_USAGE)
    return { method: 'token.revoke', params: { id: rest[0] } }
  }
  throw new Error(TOKEN_USAGE)
}

interface ListedToken {
  id: string
  name: string
  caps: string[]
  scope: ScriptTokenScope
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
}

function scopeText(scope: ScriptTokenScope): string {
  if (scope.kind === 'all') return 'all'
  return [
    ...scope.groups.map((id) => `group:${id}`),
    ...scope.workspaces.map((id) => `workspace:${id}`),
    ...(scope.ownWorkspaces ? ['own-workspaces'] : []),
  ].join(',')
}

function settingsText(t: ListedToken): string {
  return `scope ${scopeText(t.scope)}, ${t.expiresAt === null ? 'never expires' : `expires ${t.expiresAt}`}`
}

function shownToken(t: ListedToken): string[] {
  return [
    `id         ${t.id}`,
    `name       ${t.name}`,
    `caps       ${t.caps.join(',') || '-'}`,
    `scope      ${scopeText(t.scope)}`,
    `expires    ${t.expiresAt ?? 'never'}`,
    `last used  ${t.lastUsedAt ?? 'never'}`,
    `created    ${t.createdAt}`,
  ]
}

async function retiredNotice(conn: MessageConnection): Promise<void> {
  const retired = await conn.sendRequest<{ name: string }[]>('token.retired', {})
  if (retired.length === 0) return
  console.error(
    `ostia token: ${retired.length} old token(s) stopped working after the upgrade: ${retired.map((t) => t.name).join(', ')}. Create new ones with ostia token create.`,
  )
}

function pick(tokens: ListedToken[], ref: string): ListedToken {
  const byId = tokens.find((t) => t.id === ref)
  if (byId) return byId
  const named = tokens.filter((t) => t.name === ref)
  if (named.length === 1) return named[0]
  throw new Error(
    named.length > 1 ? `ambiguous-token: ${ref} (pass its id)` : `unknown-token: ${ref}`,
  )
}

export async function runTokenVerb(conn: MessageConnection, argv: string[]): Promise<number> {
  let call: TokenCall
  try {
    call = parseTokenArgs(argv)
  } catch (err) {
    console.error(`ostia token: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  if (call.method === 'token.list') {
    const tokens = await conn.sendRequest<ListedToken[]>(call.method, call.params)
    if (call.show !== undefined) {
      let token: ListedToken
      try {
        token = pick(tokens, call.show)
      } catch (err) {
        console.error(`ostia token: ${(err as Error).message}`)
        return 1
      }
      console.log(call.json ? JSON.stringify(token, null, 2) : shownToken(token).join('\n'))
      return 0
    }
    if (call.json) {
      console.log(JSON.stringify(tokens, null, 2))
      return 0
    }
    await retiredNotice(conn)
    console.log(['ID', 'NAME', 'CAPS', 'SCOPE', 'EXPIRES', 'LAST USED'].join('  '))
    for (const t of tokens) {
      console.log(
        [
          t.id,
          t.name,
          t.caps.join(',') || '-',
          scopeText(t.scope),
          t.expiresAt ?? 'never',
          t.lastUsedAt ?? 'never',
        ].join('  '),
      )
    }
    return 0
  }
  const result = await conn.sendRequest<unknown>(call.method, call.params)
  if (call.method === 'token.create' || call.method === 'token.update') {
    const done = result as ListedToken & { token?: string }
    if (done.token) {
      console.log(done.token)
      console.error(
        `ostia token: ${call.method === 'token.create' ? 'created' : 'regenerated'} ${done.id} (${settingsText(done)}). This is the only time the token is shown; scripts outside Ostia set OSTIA_TOKEN to it.${call.method === 'token.update' ? ' The old value no longer works.' : ''}`,
      )
    } else {
      console.error(`ostia token: renamed ${done.id} to "${done.name}"; the token is unchanged.`)
    }
  } else {
    console.log('ok')
  }
  return 0
}
