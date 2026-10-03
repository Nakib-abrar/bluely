import { describe, expect, it } from 'vitest'
import { parsePostCallError } from '@renderer/main/lib/postCallError'

describe('parsePostCallError', () => {
  it('splits a partial failure into its parts', () => {
    expect(parsePostCallError('notes: The model timed out. · email: Rate limited (429).')).toEqual([
      { part: 'notes', message: 'The model timed out.' },
      { part: 'email', message: 'Rate limited (429).' },
    ])
  })

  it('keeps a message that itself contains the separator whole', () => {
    expect(parsePostCallError('actions: Bad JSON · try again later')).toEqual([
      { part: 'actions', message: 'Bad JSON · try again later' },
    ])
  })

  it('returns null for errors that are not per-part (shown as is)', () => {
    expect(parsePostCallError(null)).toBeNull()
    expect(parsePostCallError('')).toBeNull()
    expect(parsePostCallError('Nothing was transcribed in this session.')).toBeNull()
    expect(parsePostCallError('The notes model timed out. Your transcript is safe.')).toBeNull()
    expect(parsePostCallError('notes: ok · summary: unknown part')).toEqual([
      { part: 'notes', message: 'ok · summary: unknown part' },
    ])
  })
})
