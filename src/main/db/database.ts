import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { runMigrations } from './migrations'

export type Db = Database.Database

/**
 * Opens (or creates) the SQLite database and brings the schema up to date.
 * WAL + synchronous=NORMAL keeps every committed transcript line durable across app crashes.
 */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  runMigrations(db)
  return db
}

export function newId(): string {
  return globalThis.crypto.randomUUID()
}
