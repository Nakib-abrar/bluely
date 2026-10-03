import { shell } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '@main/log'
import {
  isAllowedExternalUrl,
  normalizeExternalUrl,
  openExternalSafe,
} from '@main/windows/security'

describe('normalizeExternalUrl', () => {
  it.each([
    'https://openrouter.ai/',
    'https://openrouter.ai/settings/keys',
    'https://openrouter.ai/settings/credits',
    'https://github.com/nakib-abrar/bluely',
    'https://github.com/nakib-abrar/bluely/',
    'https://github.com/nakib-abrar/bluely/releases/latest',
    'https://github.com/nakib-abrar/bluely/issues/new?title=x#top',
    'https://github.com/Nakib-Abrar/Bluely/releases', // owner and repo are case-insensitive
    'https://GITHUB.com/nakib-abrar/bluely',
  ])('allows %s', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(true)
  })

  it.each([
    // Dot-segments and backslashes resolve outside the repository.
    'https://github.com/nakib-abrar/bluely/../../evil-user/malware/releases/download/v1/Bluely-Setup.exe',
    'https://github.com/nakib-abrar/bluely/..',
    'https://github.com/nakib-abrar/bluely/%2e%2e/%2e%2e/evil/x',
    'https://github.com/nakib-abrar/bluely\\..\\..\\evil/x',
    'https://github.com/nakib-abrar/bluely%2f..%2f..%2fevil',
    // Sibling repositories that share the prefix.
    'https://github.com/nakib-abrar/bluely-evil',
    'https://github.com/nakib-abrar/bluely.evil/x',
    'https://github.com/nakib-abrar/bluelyx',
    'https://github.com/nakib-abrar',
    'https://github.com/evil/bluely',
    // Other schemes and hosts.
    'mailto:attacker@example.com?body=meeting%20notes',
    'javascript:alert(1)',
    'http://openrouter.ai/',
    'http://github.com/nakib-abrar/bluely',
    'file:///C:/Windows/System32/calc.exe',
    'https://openrouter.ai.evil.com/',
    'https://evil.com/https://openrouter.ai/',
    'https://openrouter.ai@evil.com/',
    'https://user:pass@openrouter.ai/',
    'https://openrouter.ai:8443/',
    'https://sub.openrouter.ai/',
    'not a url',
    '',
  ])('blocks %s', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(false)
    expect(normalizeExternalUrl(url)).toBeNull()
  })

  it('returns the normalized href', () => {
    expect(normalizeExternalUrl('https://github.com/nakib-abrar/bluely/./releases')).toBe(
      'https://github.com/nakib-abrar/bluely/releases',
    )
    expect(normalizeExternalUrl('HTTPS://OpenRouter.ai/settings/keys')).toBe(
      'https://openrouter.ai/settings/keys',
    )
  })
})

describe('openExternalSafe', () => {
  afterEach(() => vi.restoreAllMocks())

  it('opens the normalized URL, never the raw string', async () => {
    const open = vi.spyOn(shell, 'openExternal').mockResolvedValue(undefined)
    const log = createLogger(null)
    expect(await openExternalSafe('https://github.com/nakib-abrar/bluely/a/../releases', log)).toBe(
      true,
    )
    expect(open).toHaveBeenCalledWith('https://github.com/nakib-abrar/bluely/releases')
  })

  it('blocks and does not open anything else', async () => {
    const open = vi.spyOn(shell, 'openExternal').mockResolvedValue(undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const log = createLogger(null)
    for (const url of [
      'https://github.com/nakib-abrar/bluely/../../evil/x',
      'mailto:a@b.c',
      'javascript:alert(1)',
    ]) {
      expect(await openExternalSafe(url, log)).toBe(false)
    }
    expect(open).not.toHaveBeenCalled()
  })
})
