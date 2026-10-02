/**
 * Incremental Server-Sent Events parser (WHATWG "event stream interpretation"), used for
 * OpenRouter's streamed chat completions.
 *
 * Deliberately tolerant: it accepts \n, \r\n and lone \r line endings (even when a \r\n pair
 * is split across two network chunks), ignores comment lines such as OpenRouter's
 * ": OPENROUTER PROCESSING" keep-alives, joins multi-line `data:` fields with "\n" and, unlike
 * a browser EventSource, also surfaces a final event that is missing its trailing blank line.
 */

export interface SseEvent {
  /** The `event:` field, or null for the default ("message") type. */
  event: string | null
  /** All `data:` lines of the event joined with "\n". */
  data: string
  /** Last event id seen on the stream (per the SSE spec it carries over to later events). */
  id: string | null
}

/** OpenAI-compatible APIs end a stream with `data: [DONE]`. */
export const SSE_DONE = '[DONE]'

const LINE_BREAK = /[\r\n]/g

export class SseParser {
  private buffer = ''
  /** Offset in `buffer` from which no line break has been seen yet (avoids rescanning). */
  private scanFrom = 0
  /** A chunk ended in "\r": swallow a "\n" at the start of the next chunk (split CRLF). */
  private skipLeadingLf = false
  private seenFirstChunk = false
  private dataLines: string[] = []
  private eventType: string | null = null
  private lastEventId: string | null = null
  private ended = false
  private retry: number | null = null

  /** Reconnection delay from the most recent `retry:` field (informational). */
  get retryMs(): number | null {
    return this.retry
  }

  /** Feeds decoded text and returns every event completed by it. */
  push(text: string): SseEvent[] {
    if (this.ended || text.length === 0) return []
    if (!this.seenFirstChunk) {
      this.seenFirstChunk = true
      // A UTF-8 BOM may precede the first field (allowed by the spec).
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    }
    if (this.skipLeadingLf) {
      this.skipLeadingLf = false
      if (text.charCodeAt(0) === 10) text = text.slice(1)
    }
    const out: SseEvent[] = []
    this.buffer += text
    let lineStart = 0
    LINE_BREAK.lastIndex = this.scanFrom
    let match: RegExpExecArray | null
    while ((match = LINE_BREAK.exec(this.buffer)) !== null) {
      const at = match.index
      const line = this.buffer.slice(lineStart, at)
      let next = at + 1
      if (this.buffer.charCodeAt(at) === 13) {
        if (next < this.buffer.length) {
          if (this.buffer.charCodeAt(next) === 10) next++
        } else {
          this.skipLeadingLf = true
        }
      }
      lineStart = next
      LINE_BREAK.lastIndex = next
      this.processLine(line, out)
    }
    this.buffer = this.buffer.slice(lineStart)
    this.scanFrom = this.buffer.length
    return out
  }

  /**
   * Signals the end of the stream. Flushes an unterminated last line and dispatches a pending
   * event even without the closing blank line. Further pushes are ignored.
   */
  end(): SseEvent[] {
    if (this.ended) return []
    const out: SseEvent[] = []
    if (this.buffer.length > 0) {
      const line = this.buffer
      this.buffer = ''
      this.scanFrom = 0
      this.processLine(line, out)
    }
    this.dispatch(out)
    this.ended = true
    return out
  }

  private processLine(line: string, out: SseEvent[]): void {
    if (line.length === 0) {
      this.dispatch(out)
      return
    }
    // Comment line, e.g. ": OPENROUTER PROCESSING" (keep-alive while the model is queued).
    if (line.charCodeAt(0) === 58) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.charCodeAt(0) === 32) value = value.slice(1)
    switch (field) {
      case 'data':
        this.dataLines.push(value)
        break
      case 'event':
        this.eventType = value
        break
      case 'id':
        if (!value.includes('\u0000')) this.lastEventId = value
        break
      case 'retry':
        if (/^\d+$/.test(value)) this.retry = Number(value)
        break
      default:
        // Unknown fields are ignored per the spec.
        break
    }
  }

  private dispatch(out: SseEvent[]): void {
    if (this.dataLines.length === 0) {
      // An event without data is not dispatched; its type does not leak into the next one.
      this.eventType = null
      return
    }
    out.push({
      event: this.eventType ? this.eventType : null,
      data: this.dataLines.join('\n'),
      id: this.lastEventId,
    })
    this.dataLines = []
    this.eventType = null
  }
}

export interface ReadSseOptions {
  /** Called for every received network chunk (byte length); used for idle timeouts. */
  onChunk?: (byteLength: number) => void
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error
    ? reason
    : new DOMException('This operation was aborted', 'AbortError')
}

const noop = (): void => undefined

/**
 * Reads an SSE byte stream and yields parsed events.
 *
 * - UTF-8 is decoded with `stream: true`, so a multi-byte character split across chunks is safe.
 * - When `signal` aborts, the pending read is cancelled and the generator throws the abort reason.
 * - When the consumer stops early (break/return) or anything throws, the body reader is
 *   cancelled so the underlying connection is not leaked.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  opts: ReadSseOptions = {},
): AsyncGenerator<SseEvent, void, undefined> {
  if (signal?.aborted) {
    body.cancel(signal.reason).catch(noop)
    throw abortError(signal)
  }
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  const parser = new SseParser()
  let eof = false
  // Cancelling resolves a pending read() with done=true, which unblocks the loop below.
  const onAbort = () => {
    reader.cancel(signal?.reason).catch(noop)
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (signal?.aborted) throw abortError(signal)
      if (done) {
        eof = true
        break
      }
      if (!value || value.byteLength === 0) continue
      opts.onChunk?.(value.byteLength)
      for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
        if (signal?.aborted) throw abortError(signal)
        yield ev
      }
    }
    const rest = [...parser.push(decoder.decode()), ...parser.end()]
    for (const ev of rest) {
      if (signal?.aborted) throw abortError(signal)
      yield ev
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (!eof) reader.cancel().catch(noop)
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }
}
