import type { Statement } from 'better-sqlite3'
import type { ActionItem } from '@shared/types'
import { ht } from '../../data/messages'
import { AppError } from '../../errors'
import { newId, type Db } from '../database'

/** Raw `action_items` row. */
export interface ActionItemRow {
  id: string
  session_id: string
  text: string
  owner: string | null
  due: string | null
  done: number
  sort: number
}

export interface ActionItemInput {
  text: string
  owner: string | null
  due: string | null
  /** Omitted: keeps the checkbox state of an existing item with the same text (regenerate). */
  done?: boolean
}

const COLUMNS = 'id, session_id, text, owner, due, done, sort'

export function mapActionItemRow(row: ActionItemRow): ActionItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    text: row.text,
    owner: row.owner,
    due: row.due,
    done: row.done === 1,
  }
}

function optionalText(v: string | null | undefined): string | null {
  const trimmed = v?.trim()
  return trimmed ? trimmed : null
}

/** Case/whitespace-insensitive identity used to carry checkbox state across regenerations. */
function textKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

export class ActionItemsRepo {
  private readonly stmt: {
    insert: Statement
    deleteForSession: Statement
    listBySession: Statement
    get: Statement
    setDone: Statement
    updateText: Statement
  }

  constructor(private readonly db: Db) {
    this.stmt = {
      insert: db.prepare(
        `INSERT INTO action_items(id, session_id, text, owner, due, done, sort)
         VALUES (@id, @sessionId, @text, @owner, @due, @done, @sort)`,
      ),
      deleteForSession: db.prepare('DELETE FROM action_items WHERE session_id = ?'),
      listBySession: db.prepare(
        `SELECT ${COLUMNS} FROM action_items WHERE session_id = ? ORDER BY sort, rowid`,
      ),
      get: db.prepare(`SELECT ${COLUMNS} FROM action_items WHERE id = ?`),
      setDone: db.prepare('UPDATE action_items SET done = ? WHERE id = ?'),
      updateText: db.prepare('UPDATE action_items SET text = ? WHERE id = ?'),
    }
  }

  /**
   * Replaces all action items of a session atomically, keeping the given order. Items with
   * empty text are skipped; empty owner/due become null.
   */
  replaceForSession(sessionId: string, items: ActionItemInput[]): ActionItem[] {
    const tx = this.db.transaction(() => {
      const previousDone = new Map<string, boolean>()
      for (const old of this.listBySession(sessionId)) {
        if (old.done) previousDone.set(textKey(old.text), true)
      }
      this.stmt.deleteForSession.run(sessionId)
      let sort = 0
      for (const item of items) {
        const text = item.text.trim()
        if (!text) continue
        const done = item.done ?? previousDone.get(textKey(text)) ?? false
        this.stmt.insert.run({
          id: newId(),
          sessionId,
          text,
          owner: optionalText(item.owner),
          due: optionalText(item.due),
          done: done ? 1 : 0,
          sort: sort++,
        })
      }
      return this.listBySession(sessionId)
    })
    return tx()
  }

  listBySession(sessionId: string): ActionItem[] {
    return (this.stmt.listBySession.all(sessionId) as ActionItemRow[]).map(mapActionItemRow)
  }

  get(id: string): ActionItem | null {
    const row = this.stmt.get.get(id) as ActionItemRow | undefined
    return row ? mapActionItemRow(row) : null
  }

  /** Persists a checkbox. Throws AppError('not_found') for unknown ids. */
  setDone(id: string, done: boolean): ActionItem {
    if (this.stmt.setDone.run(done ? 1 : 0, id).changes === 0) {
      throw new AppError('not_found', ht('errActionItemNotFound'))
    }
    return this.mustGet(id)
  }

  /** Throws AppError('not_found') for unknown ids and 'invalid_payload' for empty text. */
  updateText(id: string, text: string): ActionItem {
    const clean = text.trim()
    if (!clean) throw new AppError('invalid_payload', ht('errEmptyActionItem'))
    if (this.stmt.updateText.run(clean, id).changes === 0) {
      throw new AppError('not_found', ht('errActionItemNotFound'))
    }
    return this.mustGet(id)
  }

  private mustGet(id: string): ActionItem {
    const item = this.get(id)
    if (!item) throw new AppError('not_found', ht('errActionItemNotFound'))
    return item
  }
}
