import { describe, expect, it } from 'vitest'
import { SNIPPET_MARK_END as E, SNIPPET_MARK_START as S } from '@shared/constants'
import { highlightText, splitSnippet } from '@renderer/main/lib/snippet'

describe('splitSnippet', () => {
  it('returns one plain run without markers', () => {
    expect(splitSnippet('just text')).toEqual([{ text: 'just text', mark: false }])
  })

  it('splits marked runs', () => {
    expect(splitSnippet(`a ${S}b${E} c ${S}d${E}`)).toEqual([
      { text: 'a ', mark: false },
      { text: 'b', mark: true },
      { text: ' c ', mark: false },
      { text: 'd', mark: true },
    ])
  })

  it('treats a missing end marker as marking the rest, and ignores stray ends', () => {
    expect(splitSnippet(`x ${S}y z`)).toEqual([
      { text: 'x ', mark: false },
      { text: 'y z', mark: true },
    ])
    expect(splitSnippet(`x${E} y`)).toEqual([{ text: 'x y', mark: false }])
  })

  it('merges adjacent runs and drops empty ones', () => {
    expect(splitSnippet(`${S}${E}${S}ab${E}${S}c${E}`)).toEqual([{ text: 'abc', mark: true }])
    expect(splitSnippet('')).toEqual([])
  })

  it('keeps HTML-looking content as plain text', () => {
    expect(splitSnippet(`<img src=x onerror=alert(1)> ${S}hi${E}`)).toEqual([
      { text: '<img src=x onerror=alert(1)> ', mark: false },
      { text: 'hi', mark: true },
    ])
  })
})

describe('highlightText', () => {
  it('marks every case-insensitive occurrence', () => {
    expect(highlightText('SSO and sso', 'sso')).toEqual([
      { text: 'SSO', mark: true },
      { text: ' and ', mark: false },
      { text: 'sso', mark: true },
    ])
  })

  it('returns the text unmarked for an empty query', () => {
    expect(highlightText('hello', '  ')).toEqual([{ text: 'hello', mark: false }])
  })
})
