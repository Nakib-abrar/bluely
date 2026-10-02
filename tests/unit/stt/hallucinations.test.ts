import { describe, expect, it } from 'vitest'
import {
  cleanTranscript,
  hasSpeechContent,
  isLikelyHallucination,
  QUIET_RMS,
} from '@main/providers/stt/hallucinations'

const NORMAL = 0.05 // typical speech level (≈ -26 dBFS)
const QUIET = 0.002 // near-silent background

describe('isLikelyHallucination: drops invented text', () => {
  it.each<[string, number, number]>([
    // [text, durationSec, rms]
    ['Thank you.', 1.2, QUIET],
    ['Thank you.', 10, NORMAL],
    ['Thank you. Thank you.', 2, QUIET],
    ['Thanks for watching!', 2, NORMAL],
    ['Thank you for watching. Please subscribe!', 3, NORMAL],
    ['Thanks for watching, see you in the next video!', 4, NORMAL],
    ['Please subscribe', 1.5, NORMAL],
    ["Don't forget to like and subscribe.", 2, NORMAL],
    ['you', 1, QUIET],
    [' you', 12, NORMAL],
    ['Bye.', 1.5, QUIET],
    ['So.', 0.8, QUIET],
    ['Um... uh...', 1, QUIET],
    ['Hmm.', 9, NORMAL],
    ['[Music]', 3, NORMAL],
    ['(upbeat music)', 5, NORMAL],
    ['[BLANK_AUDIO]', 2, QUIET],
    ['*applause*', 2, NORMAL],
    ['♪', 2, NORMAL],
    ['♪ ♪ ♪', 2, NORMAL],
    ['♪ la la la ♪', 3, NORMAL],
    ['...', 1, NORMAL],
    ['Subtitles by the Amara.org community', 3, NORMAL],
    ['Amara.org', 1, NORMAL],
    ['Untertitel der Amara.org-Community', 3, NORMAL],
    ['Untertitel im Auftrag des ZDF, 2021', 3, NORMAL],
    ['Sous-titrage ST’ 501', 2, NORMAL],
    ['ご視聴ありがとうございました', 2, NORMAL],
    ['Продолжение следует...', 2, NORMAL],
    ['a a a a a', 2, NORMAL],
    ['the the the the the the', 3, NORMAL],
    ['I want to go. I want to go. I want to go. I want to go.', 3, NORMAL],
    ['Aaaaaaaa', 1, NORMAL],
    ['Ooooooooh', 1, NORMAL],
    ['We should finalize the quarterly budget before the board meeting next week.', 0.4, NORMAL],
    [
      'これは非常に長い文章で短い音声からは決して生まれないはずの内容が延々と続いています',
      0.5,
      NORMAL,
    ],
  ])('%j (%ss, rms %s)', (text, durationSec, rms) => {
    expect(isLikelyHallucination(text, { durationSec, rms })).toBe(true)
  })
})

describe('isLikelyHallucination: keeps real speech', () => {
  it.each<[string, number, number | null]>([
    ["Thank you, that's very helpful for us", 1, NORMAL],
    ["Thank you, that's very helpful for us", 0.8, NORMAL],
    ['Yes.', 1, NORMAL],
    ['Yes.', 0.4, QUIET],
    ['Thank you.', 1.2, NORMAL],
    ['Thank you.', 1.2, null],
    ['You.', 0.9, NORMAL],
    ['Bye everyone, talk soon!', 1.5, QUIET],
    ['Okay.', 1, QUIET],
    ["No no no, that's not what I meant.", 2.5, NORMAL],
    ['Yeah, yeah, yeah.', 1.5, NORMAL],
    ["(laughs) That's a great point.", 2, NORMAL],
    ['[inaudible] the second option, I think.', 2.5, NORMAL],
    ['Thanks for watching the demo, any questions?', 3, NORMAL],
    ['Like and subscribe to the newsletter, it covers pricing changes.', 4, NORMAL],
    ['We need to subscribe to the enterprise plan.', 2.5, NORMAL],
    ['Music licensing is our biggest cost this year.', 3, NORMAL],
    [
      'Subtitles by default are off in the player settings, which confuses everyone on the team.',
      6,
      NORMAL,
    ],
    ['111', 1, NORMAL],
    ['Our budget is 1000000 dollars.', 2, NORMAL],
    ['ধন্যবাদ, আপনার সাহায্যের জন্য অনেক কৃতজ্ঞ।', 3, NORMAL],
    ['ありがとうございます。それでは始めましょう。', 2.5, NORMAL],
    [
      'So the plan is to roll this out to the operations team first, then sales in March, and finance once the reporting integration is ready.',
      12,
      NORMAL,
    ],
  ])('%j (%ss, rms %s)', (text, durationSec, rms) => {
    expect(isLikelyHallucination(text, { durationSec, rms })).toBe(false)
  })

  it('treats empty text as "no speech", not a hallucination', () => {
    expect(isLikelyHallucination('', { durationSec: 1, rms: QUIET })).toBe(false)
    expect(isLikelyHallucination('   ', { durationSec: 1, rms: QUIET })).toBe(false)
  })

  it('uses the quiet threshold only for filler phrases', () => {
    const justAbove = QUIET_RMS * 1.01
    const justBelow = QUIET_RMS * 0.99
    expect(isLikelyHallucination('Thank you.', { durationSec: 1, rms: justAbove })).toBe(false)
    expect(isLikelyHallucination('Thank you.', { durationSec: 1, rms: justBelow })).toBe(true)
    expect(
      isLikelyHallucination('Can you send the slides?', { durationSec: 1.5, rms: justBelow }),
    ).toBe(false)
  })

  it('ignores an unknown or zero duration for the rate check', () => {
    const long = 'We should finalize the quarterly budget before the board meeting next week.'
    expect(isLikelyHallucination(long, { durationSec: 0, rms: NORMAL })).toBe(false)
    expect(isLikelyHallucination(long, { durationSec: Number.NaN, rms: NORMAL })).toBe(false)
  })
})

describe('cleanTranscript', () => {
  it('trims and collapses whitespace', () => {
    expect(cleanTranscript('  Hello   world \n\t again  ')).toBe('Hello world again')
    expect(cleanTranscript('')).toBe('')
    expect(cleanTranscript(' \n ')).toBe('')
  })

  it('strips leading subtitle speaker markers', () => {
    expect(cleanTranscript('- Hello there')).toBe('Hello there')
    expect(cleanTranscript('>> Hello there')).toBe('Hello there')
    expect(cleanTranscript('>>Hello there')).toBe('Hello there')
    expect(cleanTranscript(' >> - Hello there')).toBe('Hello there')
    expect(cleanTranscript('— Hello there')).toBe('Hello there')
  })

  it('keeps dashes that are part of the text', () => {
    expect(cleanTranscript('-5 degrees outside')).toBe('-5 degrees outside')
    expect(cleanTranscript('Well - maybe')).toBe('Well - maybe')
    expect(cleanTranscript('Q3 >> Q2')).toBe('Q3 >> Q2')
  })

  it('removes zero-width characters', () => {
    const zw = String.fromCharCode(0x200b)
    const bom = String.fromCharCode(0xfeff)
    expect(cleanTranscript(`${bom}Hel${zw}lo`)).toBe('Hello')
  })
})

describe('hasSpeechContent', () => {
  it('needs a letter or digit', () => {
    expect(hasSpeechContent('...')).toBe(false)
    expect(hasSpeechContent('♪ ♪')).toBe(false)
    expect(hasSpeechContent('')).toBe(false)
    expect(hasSpeechContent('ok')).toBe(true)
    expect(hasSpeechContent('42')).toBe(true)
    expect(hasSpeechContent('হ্যাঁ')).toBe(true)
  })
})
