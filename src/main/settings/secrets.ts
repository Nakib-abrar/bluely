import { safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { AppError } from '../errors'
import type { KeyStatus } from '@shared/types'

/**
 * Stores the OpenRouter API key encrypted with Electron safeStorage (DPAPI on Windows).
 * The key is only ever read inside the main process; renderers see a masked form.
 */
export class SecretStore {
  private cache: string | null | undefined

  constructor(
    private readonly file: string,
    /** Unpackaged test runs may inject a key via BLUELY_TEST_OPENROUTER_KEY. */
    private readonly testKey: string | null = null,
  ) {}

  isEncryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  getKey(): string | null {
    if (this.testKey) return this.testKey
    if (this.cache !== undefined) return this.cache
    if (!existsSync(this.file)) {
      this.cache = null
      return null
    }
    try {
      const buf = readFileSync(this.file)
      this.cache = safeStorage.decryptString(buf)
    } catch {
      this.cache = null
    }
    return this.cache
  }

  setKey(key: string): void {
    const trimmed = key.trim()
    if (!/^[\x21-\x7e]{10,400}$/.test(trimmed)) {
      throw new AppError('invalid_key', 'That does not look like an OpenRouter API key.')
    }
    if (!this.isEncryptionAvailable()) {
      throw new AppError(
        'encryption_unavailable',
        'Secure storage is not available on this system, so the key cannot be saved safely.',
      )
    }
    writeFileSync(this.file, safeStorage.encryptString(trimmed), { mode: 0o600 })
    this.cache = trimmed
  }

  clear(): void {
    rmSync(this.file, { force: true })
    this.cache = null
  }

  status(): KeyStatus {
    const key = this.getKey()
    return {
      hasKey: !!key,
      masked: key ? maskKey(key) : null,
      encryptionAvailable: this.isEncryptionAvailable(),
    }
  }
}

export function maskKey(key: string): string {
  const tail = key.slice(-4)
  const head = key.startsWith('sk-or-') ? 'sk-or-' : key.slice(0, 3)
  return `${head}…${tail}`
}
