import { describe, expect, it } from 'vitest'
import {
  QUESTION_LANGUAGES,
  QUESTION_THRESHOLD,
  detectQuestion,
} from '@main/session/questionDetector'

interface Case {
  text: string
  expected: boolean
  lang: 'en' | 'bn'
  /** Why the case is in the table (documentation only). */
  note?: string
}

const q = (text: string, note?: string): Case => ({ text, expected: true, lang: 'en', note })
const s = (text: string, note?: string): Case => ({ text, expected: false, lang: 'en', note })
const bq = (text: string, note?: string): Case => ({ text, expected: true, lang: 'bn', note })
const bs = (text: string, note?: string): Case => ({ text, expected: false, lang: 'bn', note })

const CASES: Case[] = [
  // ── English questions ──
  q('What do you think about our pricing?', 'terminal question mark'),
  q('We tried that already. How would you approach it', 'question in the last sentence'),
  q('How would you approach it', 'interrogative + auxiliary, no punctuation'),
  q('So what’s the timeline', 'filler stripped, curly-apostrophe contraction'),
  q('whats the plan for q3', 'STT spelling without apostrophe'),
  q('Can you walk me through your architecture', 'auxiliary + subject'),
  q('Walk me through your last project.', 'request phrase despite period'),
  q('Tell me about yourself.', 'request phrase'),
  q('Any thoughts on the roadmap', 'phrase'),
  q('Is there a free tier', 'is there'),
  q('Are there any questions', 'are there'),
  q('Have you used Kubernetes before', 'have + you'),
  q('Um, and why did you leave your last job', 'several fillers'),
  q('Okay so when can you start', 'fillers without commas'),
  q("That's the plan, right", 'tag question'),
  q("It's a big change, isn't it", 'negated tag'),
  q('We ship Friday, correct', 'tag: correct'),
  q("You'll handle the migration, yeah?", 'tag: yeah?'),
  q('The deadline is fixed, no?', 'tag: no?'),
  q('It works nicely isn’t it', 'unpunctuated multi-word tag'),
  q('We ship on Friday. Right', 'trailing tag sentence'),
  q("I'm wondering how you'd handle scale", 'I’m wondering'),
  q("I'd love to hear your take on this", 'I’d love to hear'),
  q('What about security', 'what about'),
  q('How about next Tuesday', 'how about'),
  q('Explain how caching works in your system.', 'explain'),
  q('Describe a time you failed.', 'describe'),
  q('If you had more time, what would you change', 'question in a later clause'),
  q('Given the budget, how would you prioritize these features', 'question after comma'),
  q('We tried caching so how would you approach it', 'clause boundary on "so"'),
  q('Which database would you pick', 'which + noun + auxiliary'),
  q('How many people are on your team', 'how many'),
  q("Who's leading the project", 'contraction'),
  q('Thoughts?', 'single word with question mark'),
  q('Is John joining us today', 'auxiliary + proper name'),
  q('Should we push the release', 'should + we'),
  q('Would you be open to a pilot', 'would + you'),
  q('Did it work', 'did + it'),
  q('Where are you based', 'where + are'),
  q('Curious about your experience with Rust', 'curious about'),
  q('Any idea why the build failed', 'any idea'),
  q('Do you know when the release is', 'do + you'),
  q("What's your experience with React? We use it heavily here.", 'question then context'),
  q('What a great demo, can you send me the slides', 'exclamation then question clause'),
  q('Mind if I ask what your budget is', 'mind if I ask'),
  q('Now, is the timing right for this', 'filler with pause keeps determiners'),
  q('¿Cómo estás', 'inverted question mark'),
  q('So, what happened next', 'wh + verb'),

  // ── English statements ──
  s('We tried that already.', 'plain statement'),
  s('What a great day!', 'exclamation'),
  s('How nice.', 'exclamation without "!"'),
  s('I wonder if it rains.', 'weak "I wonder"'),
  s("That's what we need.", 'embedded "what"'),
  s('When we launched, it was great.', 'subordinate clause'),
  s('What we need is more time.', 'free relative'),
  s('How we handle it matters.', 'subordinate "how"'),
  s('Which is why we chose Postgres.', 'statement starter'),
  s('We picked Postgres, which is the best option.', 'relative clause'),
  s('Could be worse.', 'auxiliary without subject'),
  s('Will do.', 'auxiliary without subject'),
  s('Do it now.', 'imperative'),
  s('Do the math and you will see.', 'imperative with determiner'),
  s('Have a great weekend!', 'imperative "have"'),
  s('Is what it is.', 'idiom'),
  s("Can't wait to see it!", 'exclamation'),
  s('Who knows.', 'rhetorical'),
  s("Let's move on to the next item.", 'proposal'),
  s('I think the pricing is fair.', 'opinion'),
  s('Great, thanks for sharing that.', 'thanks'),
  s('Okay.', 'filler only'),
  s("That's right.", '"right" without comma is agreement'),
  s('Sure, yeah.', 'fillers only'),
  s('So do I.', 'inversion without content'),
  s('Now is the time to ship.', 'filler without pause + determiner'),
  s('I know how you would approach it.', 'embedded question'),
  s("Did you see the game? Anyway, let's get started.", 'question abandoned by topic shift'),
  s('We hired Sam, who is the new lead.', 'relative "who"'),

  // ── Bangla questions ──
  bq('আপনার নাম কী?', 'question mark'),
  bq('আপনি কোথায় থাকেন', 'কোথায় mid-sentence'),
  bq('কেন এই পদ্ধতি বেছে নিলেন', 'কেন first'),
  bq('আপনি কি আগামীকাল আসবেন', 'yes/no কি'),
  bq('এটা কিভাবে কাজ করে', 'কিভাবে'),
  bq('মিটিং কখন শুরু হবে', 'কখন'),
  bq('প্রজেক্টটার দায়িত্বে কে আছেন', 'কে'),
  bq('কোনটা আপনার পছন্দ', 'কোনটা'),
  bq('এর দাম কত', 'কত at the end'),
  bq('আপনি খেয়েছেন কি', 'final particle কি'),
  bq('আমরা শুক্রবারে রিলিজ করছি, তাই না', 'tag তাই না'),
  bq('আপনি রাজি আছেন তো?', 'particle তো?'),
  bq('এটা ঠিক আছে না?', 'particle না?'),
  bq('এই কাজটা কার', 'কার'),
  bq('আপনার অভিজ্ঞতা সম্পর্কে একটু বলুন তো', 'request phrase'),
  bq('আমরা আগেই চেষ্টা করেছি। আপনি এটা কীভাবে করবেন', 'last sentence after danda'),
  bq('আপনি কেমন আছেন', 'কেমন'),
  bq('রিপোর্টটা কবে পাঠাবেন', 'কবে'),
  bq('ওকে, তাহলে আমরা কাকে জিজ্ঞেস করব', 'fillers + কাকে'),
  bq('আপনি রাজি আছেন তো', 'final তো without mark'),

  // ── Bangla statements ──
  bs('আমরা আগামীকাল মিটিং করব।', 'statement with danda'),
  bs('কি সুন্দর দিন!', 'exclamation'),
  bs('আমি জানি না সে কোথায় গেছে।', 'embedded question, danda'),
  bs('আমি জানি না সে কোথায় গেছে', 'embedded question, no punctuation'),
  bs('ধন্যবাদ, খুব ভালো লাগলো।', 'thanks'),
  bs('কেউ একজন দরজায় এসেছে।', 'কেউ is not কে'),
  bs('আমরা কিছু পরিবর্তন করেছি', 'কিছু is not কি'),
  bs('আমি কখনো সেখানে যাইনি।', 'কখনো is not কখন'),
  bs('কোনো সমস্যা নেই', 'কোনো is not কোন'),
  bs('কোন সমস্যা নেই', 'idiom "no problem"'),
]

describe('detectQuestion', () => {
  it('has a large enough labelled table', () => {
    const en = CASES.filter((c) => c.lang === 'en')
    const bn = CASES.filter((c) => c.lang === 'bn')
    expect(CASES.length).toBeGreaterThanOrEqual(45)
    expect(en.length).toBeGreaterThanOrEqual(28)
    expect(en.filter((c) => !c.expected).length).toBeGreaterThanOrEqual(10)
    expect(bn.length).toBeGreaterThanOrEqual(14)
    expect(bn.filter((c) => !c.expected).length).toBeGreaterThanOrEqual(4)
  })

  it.each(CASES)('$lang: "$text" → $expected ($note)', ({ text, expected, lang }) => {
    const r = detectQuestion(text, { language: lang })
    expect(r.isQuestion, `${r.reason} (${r.confidence})`).toBe(expected)
    expect(r.isQuestion).toBe(r.confidence >= QUESTION_THRESHOLD)
  })

  it('reports precision and recall over the labelled table', () => {
    const stats = { en: { tp: 0, fp: 0, fn: 0, tn: 0 }, bn: { tp: 0, fp: 0, fn: 0, tn: 0 } }
    for (const c of CASES) {
      const got = detectQuestion(c.text, { language: c.lang }).isQuestion
      const st = stats[c.lang]
      if (got && c.expected) st.tp++
      else if (got && !c.expected) st.fp++
      else if (!got && c.expected) st.fn++
      else st.tn++
    }
    const all = {
      tp: stats.en.tp + stats.bn.tp,
      fp: stats.en.fp + stats.bn.fp,
      fn: stats.en.fn + stats.bn.fn,
      tn: stats.en.tn + stats.bn.tn,
    }
    const fmt = (st: typeof all) => {
      const precision = st.tp / Math.max(1, st.tp + st.fp)
      const recall = st.tp / Math.max(1, st.tp + st.fn)
      return `precision ${precision.toFixed(3)} recall ${recall.toFixed(3)} (tp ${st.tp} fp ${st.fp} fn ${st.fn} tn ${st.tn})`
    }
    console.info(`[questionDetector] en: ${fmt(stats.en)}`)
    console.info(`[questionDetector] bn: ${fmt(stats.bn)}`)
    console.info(`[questionDetector] all: ${fmt(all)}`)
    expect(all.fp).toBe(0)
    expect(all.fn).toBe(0)
  })

  it('auto-detects the language from the script', () => {
    expect(detectQuestion('আপনি কোথায় থাকেন').isQuestion).toBe(true)
    expect(detectQuestion('আপনি কোথায় থাকেন', { language: 'en' }).isQuestion).toBe(true)
    expect(detectQuestion('How would you approach it', { language: 'bn' }).isQuestion).toBe(true)
    expect(detectQuestion('How would you approach it', { language: 'auto' }).isQuestion).toBe(true)
    expect(detectQuestion('Okay, আপনি কোথায় থাকেন').isQuestion).toBe(true)
    expect(QUESTION_LANGUAGES).toEqual(expect.arrayContaining(['en', 'bn']))
  })

  it('treats other question marks as language-agnostic', () => {
    expect(detectQuestion('¿Dónde está la oficina?', { language: 'es' }).reason).toBe(
      'question-mark',
    )
    expect(detectQuestion('هل أنت مستعد؟').isQuestion).toBe(true)
    expect(detectQuestion('准备好了吗？').isQuestion).toBe(true)
  })

  it('handles empty and punctuation-only input', () => {
    expect(detectQuestion('')).toEqual({ isQuestion: false, confidence: 0, reason: 'empty' })
    expect(detectQuestion('   ')).toMatchObject({ isQuestion: false, reason: 'empty' })
    expect(detectQuestion('?!')).toMatchObject({ isQuestion: false, reason: 'empty' })
  })

  it('returns graded confidence', () => {
    const strong = detectQuestion('What do you think?')
    const starter = detectQuestion('What do you think')
    const period = detectQuestion('What do you think.')
    const statement = detectQuestion('We shipped it.')
    expect(strong.confidence).toBeGreaterThan(starter.confidence)
    expect(starter.confidence).toBeGreaterThan(period.confidence)
    expect(period.confidence).toBeGreaterThanOrEqual(QUESTION_THRESHOLD)
    expect(statement.confidence).toBeLessThan(0.2)
    for (const r of [strong, starter, period, statement]) {
      expect(r.confidence).toBeGreaterThanOrEqual(0)
      expect(r.confidence).toBeLessThanOrEqual(1)
    }
  })

  it('does not split sentences on decimals or titles', () => {
    expect(detectQuestion('Did you talk to Mr. Smith').isQuestion).toBe(true)
    expect(detectQuestion('It costs 3.5 million so how would you fund it').isQuestion).toBe(true)
  })

  it('ignores trailing fillers after a question', () => {
    expect(detectQuestion('How would you approach it? Um.').isQuestion).toBe(true)
    expect(detectQuestion('We ship on Friday. Okay?').isQuestion).toBe(true)
  })

  it('is fast enough to run on every line', () => {
    const line =
      'So we have been thinking about the migration for a while now and the team is split, ' +
      'given the budget and the timeline how would you approach it'
    const t0 = performance.now()
    for (let i = 0; i < 2000; i++) detectQuestion(line)
    const perCallMs = (performance.now() - t0) / 2000
    expect(perCallMs).toBeLessThan(1)
  })
})
