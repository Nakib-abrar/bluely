import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SCREENSHOTS_NO_SESSION_DIR } from '@shared/constants'
import type { Logger } from '../log'

/*
 * Saved Assist screenshots (Settings › Privacy › "Save screenshots", off by default) live in
 * <screenshotsDir>/<sessionId>/<cardId>.jpg, or in <screenshotsDir>/no-session/ when nothing was
 * recording (see saveScreenshot in screen.ts). Nothing in the database points at them, so every
 * path that deletes meetings must delete the matching folders too.
 */

/** Session ids are UUIDs made in main; anything else never becomes a path (no `..`, `C:`, `/`). */
const SESSION_FOLDER_RE = /^[A-Za-z0-9_-]{1,128}$/

function isSessionFolderName(name: string): boolean {
  return SESSION_FOLDER_RE.test(name) && name !== SCREENSHOTS_NO_SESSION_DIR
}

/**
 * Deletes the screenshot folders of the given (already deleted) sessions. Never throws: a file
 * that cannot be removed is logged and retried by the next orphan sweep. Returns how many
 * folders were removed or already absent.
 */
export function deleteSessionScreenshots(
  screenshotsDir: string,
  sessionIds: Iterable<string>,
  log?: Logger,
): number {
  let removed = 0
  for (const id of sessionIds) {
    if (!isSessionFolderName(id)) continue
    try {
      rmSync(join(screenshotsDir, id), { recursive: true, force: true })
      removed++
    } catch (err) {
      log?.warn('Could not delete saved screenshots of a deleted meeting', err)
    }
  }
  return removed
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return [] // no screenshots saved yet
  }
}

/**
 * Deletes session folders whose meeting no longer exists, e.g. left behind by versions that
 * did not clean up on delete, or by a crash between the database delete and the folder delete.
 * A recording session always has its row before its first screenshot, so it is never swept.
 */
export function sweepOrphanScreenshots(
  screenshotsDir: string,
  sessionExists: (id: string) => boolean,
  log?: Logger,
): number {
  const orphans = listDir(screenshotsDir).filter(
    (name) => isSessionFolderName(name) && !sessionExists(name),
  )
  return deleteSessionScreenshots(screenshotsDir, orphans, log)
}

/**
 * Applies retention to screenshots taken outside a session: files in no-session/ last written
 * before `cutoffMs` are deleted. Returns the number of files deleted.
 */
export function pruneUnattachedScreenshots(
  screenshotsDir: string,
  cutoffMs: number,
  log?: Logger,
): number {
  const dir = join(screenshotsDir, SCREENSHOTS_NO_SESSION_DIR)
  let removed = 0
  for (const name of listDir(dir)) {
    const file = join(dir, name)
    try {
      const st = statSync(file)
      if (!st.isFile() || st.mtimeMs >= cutoffMs) continue
      rmSync(file, { force: true })
      removed++
    } catch (err) {
      log?.warn('Could not delete an old saved screenshot', err)
    }
  }
  return removed
}
