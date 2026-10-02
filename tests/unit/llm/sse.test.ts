import { describe, expect, it } from 'vitest'
import { readSse, SseParser, SSE_DONE, type SseEvent } from '@main/providers/llm/sse'
import { collect, fakeStream } from './helpers'

function parseAll(text: string): SseEvent[] {
  const p = new SseParser()
  return [...p.push(text), ...p.end()]
}

const ev = (data: string, event: string | null = null, id: string | null = null): SseEvent => ({
  event,
  data,
  id,
})

/** A recorded-style OpenRouter stream with comments, CRLF, multi-byte text and [DONE]. */
const RECORDED =
  ': OPENROUTER PROCESSING\r\n\r\n' +
  'data: {"id":"gen-1","provider":"Groq","model":"meta-llama/llama-3.3-70b-instruct","choices":[{"delta":{"role":"assistant","content":""}}]}\n\n' +
  'data: {"id":"gen-1","choices":[{"delta":{"content":"Héllo – "}}]}\r\n\r\n' +
  ': OPENROUTER PROCESSING\n\n' +
  'data: {"id":"gen-1","choices":[{"delta":{"content":"কেমন আছেন? 👋🏽"}}]}\n\n' +
  'event: ping\nid: 7\ndata: line one\ndata: line two\n\n' +
  'data: {"id":"gen-1","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":4,"cost":0.00001}}\r\n\r\n' +
  'data: [DONE]\n\n'

describe('SseParser', () => {
  it('parses simple events and surfaces [DONE]', () => {
    const events = parseAll('data: {"a":1}\n\ndata: [DONE]\n\n')
    expect(events).toEqual([ev('{"a":1}'), ev(SSE_DONE)])
  })

  it('handles CRLF and lone CR line endings', () => {
    expect(parseAll('data: a\r\n\r\ndata: b\r\rdata: c\n\n')).toEqual([ev('a'), ev('b'), ev('c')])
  })

  it('handles a CRLF split across two pushes without creating an empty line', () => {
    const p = new SseParser()
    // "\r" ends the data line; the "\n" in the next chunk must not count as a blank line.
    expect(p.push('data: one\r')).toEqual([])
    expect(p.push('\ndata: two\r\n')).toEqual([])
    expect(p.push('\r\n')).toEqual([ev('one\ntwo')])
  })

  it('ignores comment lines (OpenRouter keep-alives)', () => {
    expect(parseAll(': OPENROUTER PROCESSING\n\n:another\ndata: x\n\n')).toEqual([ev('x')])
  })

  it('joins multi-line data with \\n and strips only one leading space', () => {
    expect(parseAll('data: first\ndata:second\ndata:  third\n\n')).toEqual([
      ev('first\nsecond\n third'),
    ])
  })

  it('tracks event type and id (id persists, type does not)', () => {
    const events = parseAll('event: ping\nid: 42\ndata: a\n\ndata: b\n\nid\ndata: c\n\n')
    expect(events).toEqual([ev('a', 'ping', '42'), ev('b', null, '42'), ev('c', null, '')])
  })

  it('does not dispatch events without data and resets their type', () => {
    expect(parseAll('event: lonely\n\ndata: x\n\n')).toEqual([ev('x')])
  })

  it('dispatches an empty `data:` field as an event with empty data', () => {
    expect(parseAll('data:\n\n')).toEqual([ev('')])
  })

  it('treats a line without colon as a field name with empty value', () => {
    expect(parseAll('data\n\n')).toEqual([ev('')])
    expect(parseAll('bogus\ndata: y\n\n')).toEqual([ev('y')])
  })

  it('flushes a final event without a trailing blank line on end()', () => {
    const p = new SseParser()
    expect(p.push('data: {"x":1}\n\ndata: [DONE]')).toEqual([ev('{"x":1}')])
    expect(p.end()).toEqual([ev(SSE_DONE)])
    expect(p.end()).toEqual([])
    expect(p.push('data: late\n\n')).toEqual([])
  })

  it('strips a leading BOM and records retry', () => {
    const p = new SseParser()
    expect(p.push('﻿retry: 1500\ndata: a\n\n')).toEqual([ev('a')])
    expect(p.retryMs).toBe(1500)
  })

  it('handles a very long line pushed one character at a time', () => {
    const long = 'x'.repeat(20_000)
    const p = new SseParser()
    const out: SseEvent[] = []
    for (const ch of `data: ${long}\n\n`) out.push(...p.push(ch))
    expect(out).toEqual([ev(long)])
  })
})

describe('readSse', () => {
  const expected = (() => {
    const p = new SseParser()
    return [...p.push(RECORDED), ...p.end()]
  })()

  it('the recorded fixture parses to the expected events', () => {
    expect(expected.map((e) => e.data)).toEqual([
      '{"id":"gen-1","provider":"Groq","model":"meta-llama/llama-3.3-70b-instruct","choices":[{"delta":{"role":"assistant","content":""}}]}',
      '{"id":"gen-1","choices":[{"delta":{"content":"Héllo – "}}]}',
      '{"id":"gen-1","choices":[{"delta":{"content":"কেমন আছেন? 👋🏽"}}]}',
      'line one\nline two',
      '{"id":"gen-1","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":4,"cost":0.00001}}',
      SSE_DONE,
    ])
    expect(expected[3]).toEqual(ev('line one\nline two', 'ping', '7'))
  })

  it('fuzz: splitting the recorded stream at every byte offset gives identical events', async () => {
    const bytes = new TextEncoder().encode(RECORDED)
    for (let cut = 0; cut <= bytes.length; cut++) {
      const { stream } = fakeStream([bytes.slice(0, cut), bytes.slice(cut)])
      const got = await collect(readSse(stream))
      expect(got, `split at byte ${cut}`).toEqual(expected)
    }
  })

  it('fuzz: one byte per chunk (every multi-byte UTF-8 character split)', async () => {
    const bytes = new TextEncoder().encode(RECORDED)
    const chunks = Array.from(bytes, (b) => new Uint8Array([b]))
    expect(await collect(readSse(fakeStream(chunks).stream))).toEqual(expected)
  })

  it('fuzz: random three-way splits', async () => {
    const bytes = new TextEncoder().encode(RECORDED)
    let seed = 12345
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    for (let i = 0; i < 200; i++) {
      const a = rand(bytes.length)
      const b = a + rand(bytes.length - a)
      const { stream } = fakeStream([bytes.slice(0, a), bytes.slice(a, b), bytes.slice(b)])
      expect(await collect(readSse(stream))).toEqual(expected)
    }
  })

  it('surfaces a final event without trailing newline at end of stream', async () => {
    const { stream } = fakeStream(['data: a\n\n', 'data: [DONE]'])
    expect(await collect(readSse(stream))).toEqual([ev('a'), ev(SSE_DONE)])
  })

  it('reports chunk sizes through onChunk', async () => {
    const sizes: number[] = []
    const { stream } = fakeStream(['data: a\n\n', 'data: bb\n\n'])
    await collect(readSse(stream, undefined, { onChunk: (n) => sizes.push(n) }))
    expect(sizes).toEqual([9, 10])
  })

  it('aborting cancels the reader and throws the abort reason', async () => {
    const fs = fakeStream(['data: a\n\n'], { hang: true })
    const ac = new AbortController()
    const it = readSse(fs.stream, ac.signal)[Symbol.asyncIterator]()
    expect((await it.next()).value).toEqual(ev('a'))
    const pending = it.next()
    ac.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await fs.cancelled
    expect(fs.cancelSpy).toHaveBeenCalledTimes(1)
  })

  it('an already-aborted signal cancels the body immediately', async () => {
    const fs = fakeStream(['data: a\n\n'], { hang: true })
    const ac = new AbortController()
    ac.abort()
    await expect(collect(readSse(fs.stream, ac.signal))).rejects.toMatchObject({
      name: 'AbortError',
    })
    await fs.cancelled
    expect(fs.cancelSpy).toHaveBeenCalled()
  })

  it('breaking out early cancels the reader (no leaked stream)', async () => {
    const fs = fakeStream(['data: a\n\ndata: b\n\n'], { hang: true })
    for await (const e of readSse(fs.stream)) {
      expect(e.data).toBe('a')
      break
    }
    await fs.cancelled
    expect(fs.cancelSpy).toHaveBeenCalledTimes(1)
  })

  it('does not cancel a stream that ended normally', async () => {
    const fs = fakeStream(['data: a\n\n'])
    await collect(readSse(fs.stream))
    expect(fs.cancelSpy).not.toHaveBeenCalled()
  })
})
