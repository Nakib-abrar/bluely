import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(message: string, extra?: unknown): void
  info(message: string, extra?: unknown): void
  warn(message: string, extra?: unknown): void
  error(message: string, extra?: unknown): void
  child(scope: string): Logger
  setDebug(enabled: boolean): void
}

const MAX_LOG_BYTES = 2 * 1024 * 1024

/** Redacts anything that looks like an OpenRouter key or bearer token. */
export function redact(text: string): string {
  return text
    .replace(/sk-or-[A-Za-z0-9_-]{8,}/g, 'sk-or-[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]')
}

function format(extra: unknown): string {
  if (extra === undefined) return ''
  if (extra instanceof Error) return ` ${extra.name}: ${extra.message}`
  try {
    return ` ${JSON.stringify(extra)}`
  } catch {
    return ` ${String(extra)}`
  }
}

export function createLogger(logsDir: string | null, scope = 'main'): Logger {
  const state = { debug: false }
  const file = logsDir ? join(logsDir, 'bluely.log') : null
  if (logsDir) {
    try {
      mkdirSync(logsDir, { recursive: true })
    } catch {
      /* ignore */
    }
  }

  const write = (level: LogLevel, sc: string, message: string, extra?: unknown) => {
    if (level === 'debug' && !state.debug) return
    const line = redact(`${new Date().toISOString()} [${level}] [${sc}] ${message}${format(extra)}`)
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else if (process.env['BLUELY_VERBOSE'] === '1' || state.debug) console.info(line)
    if (!file) return
    try {
      try {
        if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`)
      } catch {
        /* file may not exist yet */
      }
      appendFileSync(file, `${line}\n`)
    } catch {
      /* logging must never crash the app */
    }
  }

  const make = (sc: string): Logger => ({
    debug: (m, e) => write('debug', sc, m, e),
    info: (m, e) => write('info', sc, m, e),
    warn: (m, e) => write('warn', sc, m, e),
    error: (m, e) => write('error', sc, m, e),
    child: (s) => make(`${sc}:${s}`),
    setDebug: (enabled) => {
      state.debug = enabled
    },
  })
  return make(scope)
}
