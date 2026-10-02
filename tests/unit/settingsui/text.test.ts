import { describe, expect, it } from 'vitest'
import type { AppInfo, KeyTestResult } from '@shared/types'
import { IpcError } from '@renderer/lib/ipc'
import { describeError, isAbort, isNotImplemented } from '@renderer/settings/lib/errors'
import { TRANSCRIPTION_LANGUAGES } from '@renderer/settings/lib/languages'
import {
  describeKeyTest,
  describeSpend,
  formatAppInfo,
  graphemeCount,
  isValidModeIcon,
} from '@renderer/settings/lib/text'
import { RELEASE_NOTES } from '@renderer/settings/releaseNotes'

const okResult: KeyTestResult = {
  ok: true,
  label: 'k',
  limit: 20,
  usage: 3.21,
  remaining: 16.79,
  isFreeTier: false,
  latencyMs: 210,
  error: null,
}

describe('describeKeyTest', () => {
  it('shows remaining credits of the limit', () => {
    expect(describeKeyTest(okResult)).toBe('Connected · $16.79 remaining of $20.00 · 210 ms')
  })
  it('shows usage when there is no limit, and the free tier', () => {
    expect(describeKeyTest({ ...okResult, limit: null, remaining: null, isFreeTier: true })).toBe(
      'Connected · $3.21 used · no credit limit · Free tier · 210 ms',
    )
    expect(
      describeKeyTest({ ...okResult, limit: null, remaining: null, usage: null, latencyMs: null }),
    ).toBe('Connected')
  })
})

describe('describeSpend', () => {
  it('formats the month total and breakdown', () => {
    expect(
      describeSpend({ sinceMs: 0, totalUsd: 0.42, llmUsd: 0.31, sttUsd: 0.11, requests: 1280 }),
    ).toEqual({
      total: '$0.42 this month',
      detail: 'LLM $0.31 · Transcription $0.11 · 1,280 requests',
    })
  })
})

describe('Mode icon validation', () => {
  it('accepts one or two visible characters, including composed emoji', () => {
    expect(isValidModeIcon('💬')).toBe(true)
    expect(isValidModeIcon('👩‍💻')).toBe(true)
    expect(isValidModeIcon('🇧🇩')).toBe(true)
    expect(isValidModeIcon('AB')).toBe(true)
    expect(graphemeCount('👩‍💻🚀')).toBe(2)
  })
  it('rejects empty or longer icons', () => {
    expect(isValidModeIcon('')).toBe(false)
    expect(isValidModeIcon('   ')).toBe(false)
    expect(isValidModeIcon('abc')).toBe(false)
  })
})

describe('formatAppInfo', () => {
  it('produces a copyable block', () => {
    const info: AppInfo = {
      name: 'Bluely',
      version: '0.1.0',
      electron: '43.7.7',
      chrome: '140.0.1',
      platform: 'win32',
      arch: 'x64',
      isPackaged: true,
      isPortable: true,
      dataDir: 'C:\\x',
      devMode: false,
    }
    expect(formatAppInfo(info)).toBe(
      'Bluely 0.1.0 (portable)\nElectron 43.7.7 · Chrome 140.0.1\nPlatform win32 x64',
    )
    expect(formatAppInfo({ ...info, isPortable: false, isPackaged: false })).toContain(
      'Bluely 0.1.0 (dev)',
    )
  })
})

describe('describeError', () => {
  it('prefers friendly provider messages and explains missing handlers', () => {
    const ai = new IpcError({
      code: 'provider',
      message: 'raw',
      ai: { code: 'credits', message: 'Out of credits.', retryable: false },
    })
    expect(describeError(ai)).toBe('Out of credits.')
    expect(describeError(new IpcError({ code: 'not_implemented', message: 'x' }))).toBe(
      'Not available in this build yet.',
    )
    expect(describeError(new IpcError({ code: 'no_key', message: 'x' }))).toContain(
      'Add your OpenRouter API key',
    )
    expect(isNotImplemented(new IpcError({ code: 'not_implemented', message: 'x' }))).toBe(true)
  })
  it('explains microphone failures', () => {
    expect(describeError(new DOMException('no', 'NotAllowedError'))).toContain(
      'Bluely can’t use the microphone',
    )
    expect(describeError(new DOMException('no', 'NotFoundError'))).toBe(
      'No microphone found. Plug one in and try again.',
    )
    expect(isAbort(new DOMException('Aborted', 'AbortError'))).toBe(true)
    expect(isAbort(new Error('x'))).toBe(false)
  })
})

describe('static content', () => {
  it('lists unique ISO-639-1 transcription languages with English and Bangla first', () => {
    const codes = TRANSCRIPTION_LANGUAGES.map((l) => l.code)
    expect(codes.slice(0, 2)).toEqual(['en', 'bn'])
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes.every((c) => /^[a-z]{2}$/.test(c))).toBe(true)
    expect(codes.length).toBeGreaterThanOrEqual(40)
  })
  it('has release notes for the current version', () => {
    expect(RELEASE_NOTES[0]?.version).toBe('0.1.0')
    expect(RELEASE_NOTES[0]?.highlights.length).toBeGreaterThan(3)
  })
})
