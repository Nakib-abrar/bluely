import { beforeEach, describe, expect, it } from 'vitest'
import { BUILTIN_MODES, DEFAULT_MODE_ID } from '@shared/builtinModes'
import type { Mode } from '@shared/types'
import { openDatabase, type Db } from '@main/db/database'
import { AppError } from '@main/errors'
import { ModesRepo, type ModeInput } from '@main/modes/modesRepo'

let db: Db
let emitted: Mode[][]
let repo: ModesRepo
let clock: number

const input = (over: Partial<ModeInput> = {}): ModeInput => ({
  name: 'Board meeting',
  icon: '🏛️',
  instructions: 'Keep it crisp.',
  tone: 'formal',
  autoSuggest: true,
  modelOverrides: {},
  ...over,
})

function codeOf(fn: () => unknown): string | null {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(AppError)
    return (err as AppError).code
  }
  return null
}

beforeEach(() => {
  db = openDatabase(':memory:')
  emitted = []
  clock = 100
  repo = new ModesRepo({
    db,
    now: () => ++clock,
    events: {
      broadcast: (event, payload) => {
        expect(event).toBe('modes:changed')
        emitted.push(structuredClone(payload as Mode[]))
      },
    },
  })
})

describe('ModesRepo.ensureBuiltins', () => {
  it('seeds the built-in Modes once, in order, and is idempotent', () => {
    expect(repo.ensureBuiltins()).toBe(BUILTIN_MODES.length)
    expect(repo.list()).toEqual(BUILTIN_MODES)
    expect(emitted).toEqual([BUILTIN_MODES])

    expect(repo.ensureBuiltins()).toBe(0)
    expect(emitted).toHaveLength(1)
    expect(repo.list()).toHaveLength(BUILTIN_MODES.length)
  })

  it('never overwrites user edits to a built-in', () => {
    repo.ensureBuiltins()
    repo.update('builtin-sales', { name: 'My sales', instructions: 'Mine.' })
    repo.ensureBuiltins()
    expect(repo.get('builtin-sales')).toMatchObject({ name: 'My sales', instructions: 'Mine.' })
  })

  it('re-inserts a built-in that went missing without touching the others', () => {
    repo.ensureBuiltins()
    repo.update('builtin-general', { name: 'Edited' })
    db.prepare("DELETE FROM modes WHERE id = 'builtin-standup'").run()
    expect(repo.ensureBuiltins()).toBe(1)
    expect(repo.get('builtin-standup')?.name).toBe('Team standup')
    expect(repo.get('builtin-general')?.name).toBe('Edited')
  })
})

describe('ModesRepo CRUD', () => {
  beforeEach(() => {
    repo.ensureBuiltins()
    emitted = []
  })

  it('creates user Modes after the built-ins', () => {
    const a = repo.create(input({ name: '  Board meeting  ' }))
    expect(a).toEqual({
      id: a.id,
      name: 'Board meeting',
      icon: '🏛️',
      instructions: 'Keep it crisp.',
      tone: 'formal',
      autoSuggest: true,
      modelOverrides: {},
      isBuiltin: false,
      sort: BUILTIN_MODES.length,
    })
    expect(a.id).toMatch(/^mode-[0-9a-f-]{36}$/)
    const b = repo.create(input({ name: 'Another', modelOverrides: { fast: 'x/y', smart: ' ' } }))
    expect(b.sort).toBe(a.sort + 1)
    expect(b.modelOverrides).toEqual({ fast: 'x/y' })
    expect(
      repo
        .list()
        .map((m) => m.id)
        .slice(-2),
    ).toEqual([a.id, b.id])
    expect(emitted).toHaveLength(2)
    expect(emitted[1]).toEqual(repo.list())
    expect(repo.get(a.id)).toEqual(a)
  })

  it('sorts by sort order, then name', () => {
    const z = repo.create(input({ name: 'zeta' }))
    const a = repo.create(input({ name: 'Alpha' }))
    db.prepare('UPDATE modes SET sort = ? WHERE id IN (?, ?)').run(50, z.id, a.id)
    expect(
      repo
        .list()
        .slice(-2)
        .map((m) => m.name),
    ).toEqual(['Alpha', 'zeta'])
  })

  it('validates input', () => {
    expect(codeOf(() => repo.create(input({ name: '   ' })))).toBe('invalid_mode')
    expect(codeOf(() => repo.create({ ...input(), tone: 'rude' } as unknown as ModeInput))).toBe(
      'invalid_mode',
    )
    expect(codeOf(() => repo.update('builtin-general', { name: 'x'.repeat(81) }))).toBe(
      'invalid_mode',
    )
    expect(emitted).toEqual([])
  })

  it('updates part of a Mode, including built-ins', () => {
    const m = repo.create(input({ modelOverrides: { fast: 'a/b', notes: 'c/d' } }))
    const updated = repo.update(m.id, { tone: 'friendly', autoSuggest: false })
    expect(updated).toEqual({ ...m, tone: 'friendly', autoSuggest: false })

    // modelOverrides replaces the whole map; empty strings clear a role.
    expect(
      repo.update(m.id, { modelOverrides: { smart: 'e/f', fast: '' } }).modelOverrides,
    ).toEqual({ smart: 'e/f' })

    const general = repo.update('builtin-general', { instructions: 'Custom.' })
    expect(general).toMatchObject({
      isBuiltin: true,
      instructions: 'Custom.',
      name: 'General meeting',
    })
    expect(emitted).toHaveLength(4)
  })

  it('throws not_found for unknown ids', () => {
    expect(codeOf(() => repo.update('mode-x', { name: 'A' }))).toBe('not_found')
    expect(codeOf(() => repo.delete('mode-x'))).toBe('not_found')
    expect(repo.get('mode-x')).toBeNull()
  })

  it('deletes user Modes (and their knowledge rows) but protects built-ins', () => {
    const m = repo.create(input())
    db.prepare(
      "INSERT INTO knowledge_files(id, mode_id, filename, size, added_at) VALUES ('f1', ?, 'a.txt', 1, 0)",
    ).run(m.id)
    emitted = []
    repo.delete(m.id)
    expect(repo.get(m.id)).toBeNull()
    expect(db.prepare('SELECT count(*) c FROM knowledge_files').get()).toEqual({ c: 0 })
    expect(emitted).toEqual([repo.list()])

    expect(codeOf(() => repo.delete('builtin-sales'))).toBe('builtin_mode')
    expect(codeOf(() => repo.assertDeletable('builtin-sales'))).toBe('builtin_mode')
    expect(repo.get('builtin-sales')).not.toBeNull()
    expect(emitted).toHaveLength(1)
  })

  it('resets a built-in to its shipped definition', () => {
    repo.update('builtin-interview', {
      name: 'Practice',
      icon: 'x',
      instructions: 'Nope',
      tone: 'concise',
      autoSuggest: true,
      modelOverrides: { smart: 'a/b' },
    })
    db.prepare("UPDATE modes SET sort = 99 WHERE id = 'builtin-interview'").run()
    emitted = []
    const reset = repo.resetBuiltin('builtin-interview')
    expect(reset).toEqual(BUILTIN_MODES.find((m) => m.id === 'builtin-interview'))
    expect(emitted).toEqual([repo.list()])
    expect(repo.list()).toEqual(BUILTIN_MODES)
  })

  it('reset recreates a missing built-in and rejects other ids', () => {
    db.prepare("DELETE FROM modes WHERE id = 'builtin-investor'").run()
    expect(repo.resetBuiltin('builtin-investor').name).toBe('Investor pitch')
    const m = repo.create(input())
    expect(codeOf(() => repo.resetBuiltin(m.id))).toBe('not_builtin')
    expect(codeOf(() => repo.resetBuiltin('mode-unknown'))).toBe('not_found')
  })

  it('resolve() falls back to the General Mode', () => {
    const m = repo.create(input())
    expect(repo.resolve(m.id)?.id).toBe(m.id)
    expect(repo.resolve('mode-gone')?.id).toBe(DEFAULT_MODE_ID)
    expect(repo.resolve(null)?.id).toBe(DEFAULT_MODE_ID)
    db.prepare("DELETE FROM modes WHERE id = 'builtin-general'").run()
    expect(repo.resolve(undefined)?.id).toBe('builtin-sales')
    db.prepare('DELETE FROM modes').run()
    expect(repo.resolve('x')).toBeNull()
  })

  it('tolerates a corrupt model_overrides_json', () => {
    db.prepare(
      "UPDATE modes SET model_overrides_json = '{not json' WHERE id = 'builtin-general'",
    ).run()
    db.prepare(
      'UPDATE modes SET model_overrides_json = \'{"fast": 3, "smart": "ok/model", "bogus": "x"}\' WHERE id = \'builtin-sales\'',
    ).run()
    expect(repo.get('builtin-general')?.modelOverrides).toEqual({})
    expect(repo.get('builtin-sales')?.modelOverrides).toEqual({ smart: 'ok/model' })
  })
})
