/**
 * Minimal stand-in for the 'electron' module in unit tests (aliased in vitest.config.ts).
 * Tests that need specific behaviour can vi.mock() individual members.
 */
const noop = () => undefined

export const app = {
  isPackaged: false,
  getPath: (_name: string) => '/tmp/bluely-test',
  getAppPath: () => process.cwd(),
  getVersion: () => '0.0.0-test',
  getName: () => 'Bluely',
  on: noop,
  quit: noop,
}

export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
}

export const ipcMain = {
  handle: noop,
  removeHandler: noop,
  on: noop,
}

export const shell = { openExternal: async () => undefined, openPath: async () => '' }
export const clipboard = { writeText: noop, readText: () => '' }
export const nativeTheme = { shouldUseDarkColors: true, on: noop }
export const screen = {
  getPrimaryDisplay: () => ({
    id: 1,
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    workAreaSize: { width: 1920, height: 1040 },
    scaleFactor: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  }),
  getAllDisplays: () => [],
  getDisplayMatching: () => screen.getPrimaryDisplay(),
  getDisplayNearestPoint: () => screen.getPrimaryDisplay(),
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
}
export const desktopCapturer = { getSources: async () => [] }
export const globalShortcut = {
  register: () => true,
  unregister: noop,
  unregisterAll: noop,
  isRegistered: () => false,
}
export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
}
export const nativeImage = { createFromPath: () => ({}), createFromBuffer: () => ({}) }
export const net = { fetch: async () => new Response('') }
export const protocol = { registerSchemesAsPrivileged: noop, handle: noop }
export const session = { defaultSession: {} }
export class BrowserWindow {}
export class Tray {}
export const Menu = { setApplicationMenu: noop, buildFromTemplate: () => ({}) }

export default {
  app,
  safeStorage,
  ipcMain,
  shell,
  clipboard,
  nativeTheme,
  screen,
  desktopCapturer,
  globalShortcut,
  dialog,
  nativeImage,
  net,
  protocol,
  session,
  BrowserWindow,
  Tray,
  Menu,
}
