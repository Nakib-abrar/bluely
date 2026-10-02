import type { AiErrorInfo } from '@shared/types'

/** Error with a stable code that crosses the IPC boundary intact. */
export class AppError extends Error {
  readonly code: string
  readonly ai: AiErrorInfo | undefined

  constructor(code: string, message: string, ai?: AiErrorInfo) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.ai = ai
  }
}

export const notImplemented = (what: string) =>
  new AppError('not_implemented', `${what} is not implemented yet`)
