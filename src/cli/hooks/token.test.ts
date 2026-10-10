import { describe, expect, it } from 'vitest'
import { parseTokenArgs } from './token'

describe('parseTokenArgs', () => {
  it('creates a token with a name and one or more capabilities', () => {
    expect(
      parseTokenArgs(['create', 'cron', '--cap', 'read-board', '--cap', 'type-other-pane']),
    ).toEqual({
      method: 'token.create',
      params: { name: 'cron', caps: ['read-board', 'type-other-pane'] },
    })
  })

  it('passes the scope, the expiry and the workspaces the token creates', () => {
    expect(
      parseTokenArgs([
        'create',
        'ceo',
        '--cap',
        'read-board',
        '--scope',
        'group:AurigaX',
        '--scope',
        'workspace:ws-1',
        '--scope',
        'group:Work: Ops',
        '--own-workspaces',
        '--expires',
        '30d',
      ]),
    ).toEqual({
      method: 'token.create',
      params: {
        name: 'ceo',
        caps: ['read-board'],
        scope: {
          kind: 'limited',
          groups: ['AurigaX', 'Work: Ops'],
          workspaces: ['ws-1'],
          ownWorkspaces: true,
        },
        expires: '30d',
      },
    })
    expect(parseTokenArgs(['create', 'a', '--cap', 'notify', '--scope', 'all']).params).toEqual({
      name: 'a',
      caps: ['notify'],
      scope: { kind: 'all' },
    })
  })

  it('expands a preset and adds the extra capabilities', () => {
    expect(
      parseTokenArgs(['create', 'm', '--preset', 'readonly', '--cap', 'notify', '--scope', 'all'])
        .params,
    ).toMatchObject({ caps: ['read-board', 'read-other-pane', 'notify'] })
    expect(
      parseTokenArgs(['create', 'c', '--preset', 'coordinator', '--scope', 'all']).params,
    ).toMatchObject({
      caps: [
        'read-board',
        'read-other-pane',
        'send-other-pane',
        'type-other-pane',
        'process',
        'notify',
      ],
    })
    expect(() => parseTokenArgs(['create', 'x', '--preset', 'admin'])).toThrow('--preset admin')
  })

  it('needs a confirmation for a token that never expires', () => {
    expect(() =>
      parseTokenArgs(['create', 'x', '--cap', 'notify', '--scope', 'all', '--expires', 'never']),
    ).toThrow('--yes-never-expires')
    expect(
      parseTokenArgs([
        'create',
        'x',
        '--cap',
        'notify',
        '--scope',
        'all',
        '--expires',
        'never',
        '--yes-never-expires',
      ]).params,
    ).toMatchObject({ expires: 'never' })
  })

  it('refuses a scope it cannot read', () => {
    expect(() => parseTokenArgs(['create', 'x', '--cap', 'notify', '--scope', 'team:a'])).toThrow(
      '--scope team:a',
    )
    expect(() => parseTokenArgs(['create', 'x', '--cap', 'notify', '--scope', 'group:'])).toThrow(
      '--scope group:',
    )
    expect(() =>
      parseTokenArgs(['create', 'x', '--cap', 'notify', '--scope', 'all', '--scope', 'group:a']),
    ).toThrow('--scope all stands alone')
    expect(() => parseTokenArgs(['create', 'x', '--cap', 'notify', '--own-workspaces'])).toThrow(
      '--own-workspaces needs',
    )
  })

  it('updates the name alone, or the settings that regenerate the token', () => {
    expect(parseTokenArgs(['update', 'ceo', '--name', 'ostia-ceo'])).toEqual({
      method: 'token.update',
      params: { id: 'ceo', name: 'ostia-ceo' },
    })
    expect(parseTokenArgs(['update', 'ceo', '--cap', 'notify', '--expires', '1y'])).toEqual({
      method: 'token.update',
      params: { id: 'ceo', caps: ['notify'], expires: '1y' },
    })
    expect(() => parseTokenArgs(['update', 'ceo'])).toThrow('usage: ostia token')
    expect(() => parseTokenArgs(['update', '--name', 'x'])).toThrow('usage: ostia token')
    expect(() => parseTokenArgs(['create', 'x', '--cap', 'notify', '--name', 'y'])).toThrow(
      'usage: ostia token',
    )
  })

  it('lists, shows and revokes', () => {
    expect(parseTokenArgs(['list', '--json'])).toEqual({
      method: 'token.list',
      params: {},
      json: true,
    })
    expect(parseTokenArgs(['show', 'ceo'])).toEqual({
      method: 'token.list',
      params: {},
      json: false,
      show: 'ceo',
    })
    expect(parseTokenArgs(['revoke', 'script_1'])).toEqual({
      method: 'token.revoke',
      params: { id: 'script_1' },
    })
  })

  it('refuses a token without capabilities, a missing id and unknown subcommands', () => {
    expect(() => parseTokenArgs(['create', 'cron'])).toThrow('usage: ostia token')
    expect(() => parseTokenArgs(['create', '--cap', 'read-board'])).toThrow('usage: ostia token')
    expect(() => parseTokenArgs(['revoke'])).toThrow('usage: ostia token')
    expect(() => parseTokenArgs(['show'])).toThrow('usage: ostia token')
    expect(() => parseTokenArgs(['rotate', 'x'])).toThrow('usage: ostia token')
  })
})
