import type { z } from 'zod'
import { BUILTIN_MODES, DEFAULT_MODE_ID } from '@shared/builtinModes'
import { modeInputSchema } from '@shared/ipc'
import type { Mode, ModelRole, Tone } from '@shared/types'
import { newId, type Db } from '../db/database'
import { AppError } from '../errors'
import type { EventBus } from '../ipc/events'
import { fmt, knowledgeMessages } from '../knowledge/messages'

/** What the renderer sends to create a Mode (validated by `modeInputSchema`). */
export type ModeInput = z.infer<typeof modeInputSchema>

export interface ModesRepoDeps {
  db: Db
  events: Pick<EventBus, 'broadcast'>
  now?: () => number
}

interface ModeRow {
  id: string
  name: string
  icon: string
  instructions: string
  tone: Tone
  auto_suggest: number
  model_overrides_json: string
  is_builtin: number
  sort: number
}

const MODEL_ROLES: readonly ModelRole[] = ['fast', 'smart', 'notes']
const SELECT_MODE = `SELECT id, name, icon, instructions, tone, auto_suggest, model_overrides_json,
  is_builtin, sort FROM modes`
const patchSchema = modeInputSchema.partial()
const messages = knowledgeMessages.modes

/**
 * Stores Modes (built-in starters + the user's own). Built-ins can be edited and reset, never
 * deleted. Every mutation broadcasts 'modes:changed' with the full, sorted list.
 */
export class ModesRepo {
  private readonly db: Db
  private readonly events: Pick<EventBus, 'broadcast'>
  private readonly now: () => number

  constructor(deps: ModesRepoDeps) {
    this.db = deps.db
    this.events = deps.events
    this.now = deps.now ?? Date.now
  }

  /**
   * Inserts any missing built-in Mode. Existing rows are left alone, so user edits survive app
   * updates. Idempotent. Returns how many were inserted.
   */
  ensureBuiltins(): number {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO modes(id, name, icon, instructions, tone, auto_suggest,
         model_overrides_json, is_builtin, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    const at = this.now()
    let inserted = 0
    this.db.transaction(() => {
      for (const m of BUILTIN_MODES) {
        inserted += insert.run(
          m.id,
          m.name,
          m.icon,
          m.instructions,
          m.tone,
          m.autoSuggest ? 1 : 0,
          JSON.stringify(cleanOverrides(m.modelOverrides)),
          m.sort,
          at,
          at,
        ).changes
      }
    })()
    if (inserted > 0) this.emit()
    return inserted
  }

  /** All Modes ordered by `sort`, then name. */
  list(): Mode[] {
    return this.db
      .prepare<[], ModeRow>(`${SELECT_MODE} ORDER BY sort, name COLLATE NOCASE, id`)
      .all()
      .map(toMode)
  }

  get(id: string): Mode | null {
    const row = this.db.prepare<[string], ModeRow>(`${SELECT_MODE} WHERE id = ?`).get(id)
    return row ? toMode(row) : null
  }

  /**
   * The Mode with this id, falling back to the General built-in (then the first Mode) when it is
   * missing, e.g. a stale `activeModeId`. Null only if the table is empty.
   */
  resolve(id: string | null | undefined): Mode | null {
    return (id ? this.get(id) : null) ?? this.get(DEFAULT_MODE_ID) ?? this.list()[0] ?? null
  }

  create(input: ModeInput): Mode {
    const data = parse(modeInputSchema, input)
    const id = `mode-${newId()}`
    const at = this.now()
    this.db.transaction(() => {
      const { next } = this.db
        .prepare<[], { next: number }>('SELECT COALESCE(MAX(sort), -1) + 1 AS next FROM modes')
        .get() ?? { next: 0 }
      this.db
        .prepare(
          `INSERT INTO modes(id, name, icon, instructions, tone, auto_suggest, model_overrides_json,
             is_builtin, sort, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(
          id,
          data.name,
          data.icon,
          data.instructions,
          data.tone,
          data.autoSuggest ? 1 : 0,
          JSON.stringify(cleanOverrides(data.modelOverrides)),
          next,
          at,
          at,
        )
    })()
    this.emit()
    return this.require(id)
  }

  /**
   * Applies a partial edit (built-ins included). `modelOverrides`, when present, replaces the
   * whole override map; empty strings mean "no override".
   */
  update(id: string, patch: Partial<ModeInput>): Mode {
    const data = parse(patchSchema, patch)
    const current = this.require(id)
    const next = {
      name: data.name ?? current.name,
      icon: data.icon ?? current.icon,
      instructions: data.instructions ?? current.instructions,
      tone: data.tone ?? current.tone,
      autoSuggest: data.autoSuggest ?? current.autoSuggest,
      modelOverrides: data.modelOverrides
        ? cleanOverrides(data.modelOverrides)
        : current.modelOverrides,
    }
    this.db
      .prepare(
        `UPDATE modes SET name = ?, icon = ?, instructions = ?, tone = ?, auto_suggest = ?,
           model_overrides_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.icon,
        next.instructions,
        next.tone,
        next.autoSuggest ? 1 : 0,
        JSON.stringify(next.modelOverrides),
        this.now(),
        id,
      )
    this.emit()
    return this.require(id)
  }

  /**
   * Throws unless the Mode exists and is user-created. Lets callers clean up related data
   * (knowledge files, active Mode) before the delete without risking a built-in.
   */
  assertDeletable(id: string): Mode {
    const mode = this.require(id)
    if (mode.isBuiltin) throw new AppError('builtin_mode', messages.builtinDelete)
    return mode
  }

  /** Deletes a user-created Mode (its knowledge rows cascade). Built-ins throw 'builtin_mode'. */
  delete(id: string): void {
    this.assertDeletable(id)
    this.db.prepare('DELETE FROM modes WHERE id = ? AND is_builtin = 0').run(id)
    this.emit()
  }

  /** Restores a built-in Mode's shipped definition (name, icon, instructions, …, sort). */
  resetBuiltin(id: string): Mode {
    const def = BUILTIN_MODES.find((m) => m.id === id)
    if (!def) {
      if (this.get(id)) throw new AppError('not_builtin', messages.notBuiltin)
      throw new AppError('not_found', messages.notFound)
    }
    const at = this.now()
    this.db
      .prepare(
        `INSERT INTO modes(id, name, icon, instructions, tone, auto_suggest, model_overrides_json,
           is_builtin, sort, created_at, updated_at)
         VALUES (@id, @name, @icon, @instructions, @tone, @autoSuggest, @overrides, 1, @sort, @at, @at)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon,
           instructions = excluded.instructions, tone = excluded.tone,
           auto_suggest = excluded.auto_suggest, model_overrides_json = excluded.model_overrides_json,
           is_builtin = 1, sort = excluded.sort, updated_at = excluded.updated_at`,
      )
      .run({
        id: def.id,
        name: def.name,
        icon: def.icon,
        instructions: def.instructions,
        tone: def.tone,
        autoSuggest: def.autoSuggest ? 1 : 0,
        overrides: JSON.stringify(cleanOverrides(def.modelOverrides)),
        sort: def.sort,
        at,
      })
    this.emit()
    return this.require(id)
  }

  private require(id: string): Mode {
    const mode = this.get(id)
    if (!mode) throw new AppError('not_found', messages.notFound)
    return mode
  }

  private emit(): void {
    this.events.broadcast('modes:changed', this.list())
  }
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const detail = issue ? `${issue.path.join('.') || 'input'}: ${issue.message}` : 'unknown'
  throw new AppError('invalid_mode', fmt(messages.invalid, { detail }))
}

/** Keeps only known roles with a non-empty model id. */
function cleanOverrides(raw: unknown): Partial<Record<ModelRole, string>> {
  const out: Partial<Record<ModelRole, string>> = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const role of MODEL_ROLES) {
    const value = (raw as Record<string, unknown>)[role]
    if (typeof value === 'string' && value.trim()) out[role] = value.trim()
  }
  return out
}

function parseOverrides(json: string): Partial<Record<ModelRole, string>> {
  try {
    return cleanOverrides(JSON.parse(json))
  } catch {
    return {}
  }
}

function toMode(row: ModeRow): Mode {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    instructions: row.instructions,
    tone: row.tone,
    autoSuggest: row.auto_suggest === 1,
    modelOverrides: parseOverrides(row.model_overrides_json),
    isBuiltin: row.is_builtin === 1,
    sort: row.sort,
  }
}
