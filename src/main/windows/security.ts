import {
  app,
  desktopCapturer,
  net,
  protocol,
  session,
  shell,
  type Session,
  type WebContents,
} from 'electron'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EXTERNAL_URL_ALLOWLIST } from '@shared/constants'
import type { Env } from '../env'
import type { Logger } from '../log'
import { loopbackAudioOption } from '../platform'

export const APP_SCHEME = 'bluely'
export const APP_ORIGIN = `${APP_SCHEME}://app`

/** Must run before app 'ready'. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        codeCache: true,
      },
    },
  ])
}

/** Serves the built renderer from out/renderer over bluely://app/ (fetch() cannot read file://). */
export function serveRendererFiles(rendererDir: string): void {
  const root = resolve(rendererDir)
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.host !== 'app') return new Response('Not found', { status: 404 })
    const decoded = decodeURIComponent(url.pathname)
    const target = normalize(join(root, decoded))
    const rel = relative(root, target)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return new Response('Forbidden', { status: 403 })
    }
    try {
      return await net.fetch(pathToFileURL(target).toString())
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

export function rendererUrl(env: Env, page: 'main' | 'overlay'): string {
  if (env.rendererUrl) return `${env.rendererUrl.replace(/\/$/, '')}/${page}/index.html`
  return `${APP_ORIGIN}/${page}/index.html`
}

export function makeTrustedUrlCheck(env: Env): (url: string) => boolean {
  const devOrigin = env.rendererUrl ? new URL(env.rendererUrl).origin : null
  return (url: string) => {
    if (!url) return false
    try {
      const u = new URL(url)
      if (`${u.protocol}//${u.host}` === APP_ORIGIN) return true
      if (devOrigin && u.origin === devOrigin) return true
      return false
    } catch {
      return false
    }
  }
}

export function isAllowedExternalUrl(url: string): boolean {
  return EXTERNAL_URL_ALLOWLIST.some((prefix) => url.startsWith(prefix))
}

export async function openExternalSafe(url: string, log: Logger): Promise<boolean> {
  if (!isAllowedExternalUrl(url)) {
    log.warn('Blocked openExternal for non-allowlisted URL', { url })
    return false
  }
  await shell.openExternal(url)
  return true
}

/**
 * Hardens the default session:
 * - renderer network requests are limited to the app itself (and the dev server in dev),
 * - only microphone + display capture permissions are granted, and only to Bluely's pages,
 * - getDisplayMedia() returns the screen plus desktop loopback audio (the "Them" channel).
 */
export function hardenSession(env: Env, log: Logger, isTrusted: (url: string) => boolean): void {
  const ses: Session = session.defaultSession
  const devOrigin = env.rendererUrl ? new URL(env.rendererUrl).origin : null

  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const url = details.url
    if (
      url.startsWith(`${APP_ORIGIN}/`) ||
      url.startsWith('devtools://') ||
      url.startsWith('chrome-extension://') ||
      url.startsWith('data:') ||
      url.startsWith('blob:') ||
      url.startsWith('file:') ||
      (devOrigin && (url.startsWith(devOrigin) || url.startsWith(devOrigin.replace(/^http/, 'ws'))))
    ) {
      callback({})
      return
    }
    log.warn('Blocked renderer request', { url })
    callback({ cancel: true })
  })

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = details.requestingUrl || wc.getURL()
    if (!isTrusted(origin)) return callback(false)
    if (permission === 'media') {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? []
      // Audio only. Empty lists are sent for display-capture consent on newer Electron.
      return callback(types.every((t) => t === 'audio'))
    }
    if (permission === 'display-capture') return callback(true)
    if (permission === 'clipboard-sanitized-write') return callback(true)
    return callback(false)
  })

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (!isTrusted(requestingOrigin)) return false
    return permission === 'media' || permission === 'clipboard-sanitized-write'
  })

  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      const frameUrl = request.frame?.url ?? ''
      if (!isTrusted(frameUrl)) {
        log.warn('Rejected display media request from untrusted frame', { frameUrl })
        callback({})
        return
      }
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const source = sources[0]
          if (!source) {
            callback({})
            return
          }
          const audio = request.audioRequested ? loopbackAudioOption() : null
          // Pass the string 'loopback' (not a boolean: Electron 33.2+ throws on booleans).
          callback(audio ? { video: source, audio } : { video: source })
        })
        .catch((err: unknown) => {
          log.error('desktopCapturer.getSources failed', err)
          callback({})
        })
    },
    { useSystemPicker: false },
  )
}

/** Blocks navigation away from Bluely and routes window.open to the external allowlist. */
export function guardWebContents(
  contents: WebContents,
  isTrusted: (url: string) => boolean,
  log: Logger,
): void {
  contents.on('will-navigate', (event, url) => {
    if (!isTrusted(url)) {
      event.preventDefault()
      log.warn('Blocked navigation', { url })
    }
  })
  contents.on('will-redirect', (event, url) => {
    if (!isTrusted(url)) event.preventDefault()
  })
  contents.setWindowOpenHandler(({ url }) => {
    void openExternalSafe(url, log)
    return { action: 'deny' }
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

export function rendererDir(): string {
  return join(app.getAppPath(), 'out', 'renderer')
}
