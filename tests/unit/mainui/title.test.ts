import { describe, expect, it } from 'vitest'
import { MAX_TITLE_LENGTH, titleToCommit } from '@renderer/main/lib/title'

describe('titleToCommit', () => {
  it('renames to the trimmed draft the user typed', () => {
    expect(titleToCommit('  Acme pricing kickoff ', '', '')).toBe('Acme pricing kickoff')
    expect(titleToCommit('Q3 review: Acme', 'Q3 review', 'Q3 review')).toBe('Q3 review: Acme')
  })

  it('keeps what the user typed even when the stored title changed meanwhile', () => {
    expect(titleToCommit('Acme pricing kickoff', '', 'Pricing discussion with Acme')).toBe(
      'Acme pricing kickoff',
    )
  })

  it('never writes an untouched edit back over a title that changed in the background', () => {
    // Untitled meeting: the edit starts empty, notes then name the meeting.
    expect(titleToCommit('', '', 'Pricing discussion with Acme')).toBeNull()
    // Renamed in another window while this editor was open.
    expect(titleToCommit('Weekly sync', 'Weekly sync', 'Design sync')).toBeNull()
    expect(titleToCommit(' Weekly sync ', 'Weekly sync', 'Design sync')).toBeNull()
  })

  it('skips empty drafts and drafts equal to the stored title', () => {
    expect(titleToCommit('   ', 'Weekly sync', 'Weekly sync')).toBeNull()
    expect(titleToCommit('Design sync', 'Weekly sync', 'Design sync')).toBeNull()
  })

  it('caps the title length', () => {
    const long = 'x'.repeat(MAX_TITLE_LENGTH + 20)
    expect(titleToCommit(long, '', '')).toBe('x'.repeat(MAX_TITLE_LENGTH))
    expect(titleToCommit(long, long, 'Other')).toBeNull()
  })
})
