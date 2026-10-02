import { app } from 'electron'
import { join } from 'node:path'

/** Absolute path of a file in /resources (copied next to the app as extraResources when packaged). */
export function resourcePath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', name)
    : join(app.getAppPath(), 'resources', name)
}
