import { describe, expect, it } from 'vitest'
import { MAX_TITLE_LENGTH, titleToCommit } from '@renderer/main/lib/title'

describe('titleToCommit', () => {
  it('renames to the trimmed draft the user typed', () => {
    expect(titleToCommit('  Acme pricing kickoff ', '', true)).toBe('Acme pricing kickoff')
    expect(titleToCommit('Q3 review: Acme', 'Q3 review', true)).toBe('Q3 review: Acme')
  })

  it('keeps what the user typed even when the stored title changed meanwhile', () => {
    expect(titleToCommit('Acme pricing kickoff', 'Pricing discussion with Acme', true)).toBe(
      'Acme pricing kickoff',
    )
  })

  it('never writes an untouched edit back over a title that changed in the background', () => {
    // Untitled meeting: the edit starts empty, notes then name the meeting.
    expect(titleToCommit('', 'Pricing discussion with Acme', false)).toBeNull()
    // Renamed in another window while this editor was open.
    expect(titleToCommit('Weekly sync', 'Design sync', false)).toBeNull()
    expect(titleToCommit(' Weekly sync ', 'Design sync', false)).toBeNull()
  })

  it('saves a typed edit that ends on its start value when the title changed meanwhile', () => {
    // Opened on 'Weekly sync', typed, another window renamed it to 'Design sync', then the user
    // typed back to exactly 'Weekly sync': the input shows 'Weekly sync', so that is stored.
    expect(titleToCommit('Weekly sync', 'Design sync', true)).toBe('Weekly sync')
  })

  it('skips empty drafts and drafts equal to the stored title', () => {
    expect(titleToCommit('   ', 'Weekly sync', true)).toBeNull()
    expect(titleToCommit('', 'Pricing discussion with Acme', true)).toBeNull()
    expect(titleToCommit('Design sync', 'Design sync', true)).toBeNull()
    expect(titleToCommit(' Design sync ', 'Design sync', true)).toBeNull()
  })

  it('caps the title length', () => {
    const long = 'x'.repeat(MAX_TITLE_LENGTH + 20)
    expect(titleToCommit(long, '', true)).toBe('x'.repeat(MAX_TITLE_LENGTH))
    expect(titleToCommit(long, 'x'.repeat(MAX_TITLE_LENGTH), true)).toBeNull()
    expect(titleToCommit(long, 'Other', false)).toBeNull()
  })
})
