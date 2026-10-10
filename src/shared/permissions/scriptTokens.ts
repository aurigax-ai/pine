import type { Capability } from '../capabilities'

export const SCRIPT_TOKEN_PREFIX = 'ostia_'

export const SCRIPT_CAPABILITIES: readonly Capability[] = [
  'read-board',
  'read-other-pane',
  'type-other-pane',
  'all-workspaces',
  'process',
  'send-other-pane',
  'kill-pane',
  'notify',
]

export type ScriptTokenScope =
  | { kind: 'all' }
  | { kind: 'limited'; groups: string[]; workspaces: string[]; ownWorkspaces: boolean }

export const SCRIPT_TOKEN_PRESETS = {
  readonly: ['read-board', 'read-other-pane'],
  coordinator: [
    'read-board',
    'read-other-pane',
    'send-other-pane',
    'type-other-pane',
    'process',
    'notify',
  ],
} as const satisfies Record<string, readonly Capability[]>

export type ScriptTokenPreset = keyof typeof SCRIPT_TOKEN_PRESETS

export function isScriptTokenPreset(raw: unknown): raw is ScriptTokenPreset {
  return typeof raw === 'string' && Object.hasOwn(SCRIPT_TOKEN_PRESETS, raw)
}

export const DEFAULT_TOKEN_EXPIRY = '90d'
export const NEVER_EXPIRES = 'never'

const DAY_MS = 86_400_000
const RELATIVE = /^([1-9]\d{0,3})([dy])$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export function tokenExpiry(raw: string, now: Date): string | null {
  if (raw === NEVER_EXPIRES) return null
  const relative = RELATIVE.exec(raw)
  if (relative) {
    const n = Number(relative[1])
    if (relative[2] === 'd') return new Date(now.getTime() + n * DAY_MS).toISOString()
    const at = new Date(now)
    at.setFullYear(at.getFullYear() + n)
    return at.toISOString()
  }
  const date = DATE.exec(raw)
  if (date) {
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])]
    const at = new Date(year, month - 1, day, 23, 59, 59, 999)
    if (at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === day) {
      if (at.getTime() <= now.getTime()) throw new Error(`expires: ${raw} is in the past`)
      return at.toISOString()
    }
  }
  throw new Error(`expires: ${raw} (use 7d, 30d, 90d, 1y, YYYY-MM-DD or never)`)
}
