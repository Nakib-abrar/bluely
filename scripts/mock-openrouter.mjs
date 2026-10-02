#!/usr/bin/env node
/**
 * Local mock of the OpenRouter API used for development and automated tests.
 *
 *   pnpm mock:openrouter            # listens on 127.0.0.1:4010
 *   BLUELY_OPENROUTER_BASE_URL=http://127.0.0.1:4010/api/v1 pnpm dev
 *
 * Endpoints: GET /models, GET /key, GET /credits, POST /chat/completions (SSE + JSON),
 * POST /audio/transcriptions, GET /generation, plus GET /__mock/requests for assertions.
 *
 * Keys: any "sk-or-…" key works. "sk-or-bad…" → 401, "sk-or-nocredits…" → 402.
 * Prompt triggers (anywhere in the last user message):
 *   __error_429__  → 429 with Retry-After: 2
 *   __error_500__  → 500
 *   __midstream_error__ → a few tokens, then an SSE error event
 *   __slow__       → 2 s before the first token
 * Env: MOCK_TTFT_MS (default 180), MOCK_TOKEN_MS (default 12), MOCK_STT_MS (default 250).
 *
 * Exported as startMockOpenRouter() for tests.
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const MODELS = [
  model(
    'meta-llama/llama-3.3-70b-instruct',
    'Meta: Llama 3.3 70B Instruct',
    131072,
    0.00000013,
    0.0000004,
    ['text'],
  ),
  model('openai/gpt-oss-120b', 'OpenAI: gpt-oss-120b', 131072, 0.00000005, 0.00000025, ['text']),
  model(
    'google/gemini-2.5-flash-lite',
    'Google: Gemini 2.5 Flash Lite',
    1048576,
    0.0000001,
    0.0000004,
    ['text', 'image'],
  ),
  model('google/gemini-2.5-flash', 'Google: Gemini 2.5 Flash', 1048576, 0.0000003, 0.0000025, [
    'text',
    'image',
    'audio',
  ]),
  model('openai/gpt-4o-mini', 'OpenAI: GPT-4o-mini', 128000, 0.00000015, 0.0000006, [
    'text',
    'image',
  ]),
  model(
    'anthropic/claude-sonnet-4.5',
    'Anthropic: Claude Sonnet 4.5',
    1000000,
    0.000003,
    0.000015,
    ['text', 'image'],
  ),
  model('anthropic/claude-haiku-4.5', 'Anthropic: Claude Haiku 4.5', 200000, 0.000001, 0.000005, [
    'text',
    'image',
  ]),
  model(
    'openai/whisper-large-v3-turbo',
    'OpenAI: Whisper Large V3 Turbo',
    null,
    0,
    0,
    ['audio'],
    ['text'],
    0.00000011,
  ),
  model(
    'openai/whisper-large-v3',
    'OpenAI: Whisper Large V3',
    null,
    0,
    0,
    ['audio'],
    ['text'],
    0.00000031,
  ),
]

function model(id, name, ctx, prompt, completion, input, output = ['text'], audio = null) {
  return {
    id,
    canonical_slug: id,
    name,
    created: 1730000000,
    description: `${name} (mock)`,
    context_length: ctx,
    architecture: {
      modality: `${input.join('+')}->${output.join('+')}`,
      input_modalities: input,
      output_modalities: output,
      tokenizer: 'Other',
    },
    pricing: {
      prompt: String(prompt),
      completion: String(completion),
      request: '0',
      image: '0',
      audio: audio == null ? '0' : String(audio),
    },
    top_provider: { context_length: ctx, max_completion_tokens: 8192, is_moderated: false },
    supported_parameters: ['max_tokens', 'temperature', 'response_format', 'stream'],
  }
}

const PROVIDERS = {
  'meta-llama': 'Groq',
  openai: 'OpenAI',
  google: 'Google',
  anthropic: 'Anthropic',
}

const STT_SCRIPT = [
  'Thanks for joining. What does the enterprise plan cost per seat?',
  'We currently track everything in spreadsheets, which takes hours every week.',
  'Could you walk me through how the onboarding works?',
  'Our budget for this quarter is around fifty thousand dollars.',
  'Who else on your team would be involved in the decision?',
]

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function lastUserText(messages) {
  const users = (messages ?? []).filter((m) => m.role === 'user')
  const last = users[users.length - 1]
  if (!last) return ''
  if (typeof last.content === 'string') return last.content
  return (last.content ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

function allText(messages) {
  return (messages ?? [])
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : (m.content ?? []).map((p) => p.text ?? '').join(' '),
    )
    .join('\n')
}

function hasImage(messages) {
  return (messages ?? []).some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
  )
}

/** Picks a canned answer that fits the request so the UI shows realistic content. */
function cannedAnswer(body) {
  const text = allText(body.messages).toLowerCase()
  const json =
    body.response_format?.type === 'json_object' ||
    /respond with (only )?(valid )?json|return json|json object/.test(text)
  if (json) {
    if (text.includes('action item')) {
      return JSON.stringify({
        items: [
          { text: 'Send the enterprise pricing sheet', owner: 'Me', due: 'Friday' },
          { text: 'Schedule onboarding walkthrough with the ops team', owner: 'Them', due: null },
        ],
      })
    }
    if (text.includes('email')) {
      return JSON.stringify({
        subject: 'Great speaking today: next steps',
        body: 'Hi Sam,\n\nThanks for the time today. As promised, I will send over the enterprise pricing sheet by Friday and set up an onboarding walkthrough for your ops team.\n\nBest,\nAlex',
      })
    }
    if (text.includes('summary') || text.includes('notes') || text.includes('title')) {
      return JSON.stringify({
        title: 'Enterprise plan pricing discussion',
        summary:
          'Walked through enterprise pricing, current spreadsheet workflow pain and onboarding.',
        keyPoints: [
          'Enterprise plan is priced per seat',
          'Team loses hours weekly to spreadsheets',
          'Budget is about $50k this quarter',
        ],
        decisions: ['Move forward with a pilot for the ops team'],
      })
    }
    return JSON.stringify({ ok: true })
  }
  if (text.includes('follow-up question')) {
    return '1. Which manual process takes your team the most time today?\n2. Who else needs to sign off before you can start a pilot?\n3. What would success look like after the first 90 days?'
  }
  if (text.includes('fact check') || text.includes('fact-check')) {
    return '- ✅ **"Enterprise is priced per seat"**: consistent with your pricing notes.\n- ⚠️ **"Onboarding takes one day"**: can\'t verify offline; your docs mention a 1–2 week rollout.'
  }
  if (text.includes('recap')) {
    return '- Discussed enterprise pricing per seat\n- Their team spends hours weekly in spreadsheets\n- Budget around $50k this quarter\n- **Open:** who else signs off on the decision'
  }
  if (text.includes('who am i talking to')) {
    return '**Inferred from the conversation only**\n\n- **Sam**: likely an operations lead\n- Priorities: cutting manual reporting time\n- Concerns: privacy, rollout effort'
  }
  if (hasImage(body.messages)) {
    return 'I can see your screen. "Once we have addressed your privacy concerns, which manual process is taking the most time for your team?"'
  }
  if (text.includes('summarize') && text.includes('running summary')) {
    return 'Earlier: introductions, pricing questions about the enterprise plan, and current spreadsheet workflow.'
  }
  return '"Great question. The enterprise plan starts at a per-seat price, and I can send you the exact sheet after this call. How many seats are you thinking about?"'
}

function tokenize(text) {
  return text.match(/\s*\S+/g) ?? [text]
}

function json(res, status, obj, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function wavDurationSec(buf) {
  if (
    buf.length < 44 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  )
    return null
  const byteRate = buf.readUInt32LE(28)
  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'data') return byteRate ? size / byteRate : null
    offset += 8 + size
  }
  return null
}

export async function startMockOpenRouter({
  port = 0,
  host = '127.0.0.1',
  ttftMs,
  tokenMs,
  sttMs,
  quiet = true,
} = {}) {
  const cfg = {
    ttftMs: ttftMs ?? Number(process.env.MOCK_TTFT_MS ?? 180),
    tokenMs: tokenMs ?? Number(process.env.MOCK_TOKEN_MS ?? 12),
    sttMs: sttMs ?? Number(process.env.MOCK_STT_MS ?? 250),
  }
  const requests = []
  const generations = new Map()
  let sttIndex = 0
  let genCounter = 0

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const path = url.pathname.replace(/^\/api\/v1/, '')
    const raw = req.method === 'POST' ? await readBody(req) : ''
    let body = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      return json(res, 400, { error: { code: 400, message: 'Invalid JSON' } })
    }
    const auth = req.headers.authorization ?? ''
    const record = {
      method: req.method,
      path,
      query: Object.fromEntries(url.searchParams),
      headers: {
        referer: req.headers['http-referer'] ?? null,
        title: req.headers['x-title'] ?? null,
        authorization: auth ? auth.slice(0, 13) + '…' : null,
      },
      body:
        body && path === '/audio/transcriptions'
          ? {
              ...body,
              input_audio: {
                format: body.input_audio?.format,
                bytes: body.input_audio?.data?.length ?? 0,
              },
            }
          : body,
      at: Date.now(),
    }
    if (path !== '/__mock/requests') requests.push(record)
    if (!quiet) console.log(`[mock] ${req.method} ${path}`)

    if (path === '/__mock/requests') return json(res, 200, { requests })
    if (path === '/__mock/reset') {
      requests.length = 0
      return json(res, 200, { ok: true })
    }
    if (path === '/models' && req.method === 'GET') return json(res, 200, { data: MODELS })

    const key = auth.replace(/^Bearer\s+/i, '')
    if (!key.startsWith('sk-or-'))
      return json(res, 401, { error: { code: 401, message: 'No auth credentials found' } })
    if (key.startsWith('sk-or-bad'))
      return json(res, 401, { error: { code: 401, message: 'User not found.' } })
    if (key.startsWith('sk-or-nocredits'))
      return json(res, 402, { error: { code: 402, message: 'Insufficient credits' } })

    if (path === '/key' && req.method === 'GET') {
      return json(res, 200, {
        data: {
          label: 'sk-or-v1-mock…',
          limit: 20,
          usage: 3.21,
          limit_remaining: 16.79,
          is_free_tier: false,
          rate_limit: { requests: 100, interval: '10s' },
        },
      })
    }
    if (path === '/credits' && req.method === 'GET') {
      return json(res, 200, { data: { total_credits: 20, total_usage: 3.21 } })
    }
    if (path === '/generation' && req.method === 'GET') {
      const g = generations.get(url.searchParams.get('id'))
      if (!g) return json(res, 404, { error: { code: 404, message: 'Generation not found' } })
      return json(res, 200, { data: g })
    }
    if (path === '/audio/transcriptions' && req.method === 'POST') {
      const audio = body?.input_audio
      if (!body?.model || !audio?.data || !audio?.format) {
        return json(res, 400, {
          error: { code: 400, message: 'model and input_audio {data, format} are required' },
        })
      }
      const buf = Buffer.from(audio.data, 'base64')
      const seconds = audio.format === 'wav' ? wavDurationSec(buf) : null
      if (audio.format === 'wav' && seconds == null)
        return json(res, 400, { error: { code: 400, message: 'Invalid WAV' } })
      await sleep(cfg.sttMs)
      const forced = process.env.MOCK_STT_TEXT
      const text =
        forced ??
        (seconds != null && seconds < 0.3 ? '' : STT_SCRIPT[sttIndex++ % STT_SCRIPT.length])
      return json(res, 200, {
        text,
        usage: {
          seconds: Math.ceil(seconds ?? 0),
          cost: Number(((seconds ?? 0) * 0.00011).toFixed(6)),
        },
      })
    }
    if (path === '/chat/completions' && req.method === 'POST') {
      if (!body?.model || !Array.isArray(body.messages)) {
        return json(res, 400, { error: { code: 400, message: 'model and messages are required' } })
      }
      if (!MODELS.some((m) => m.id === body.model)) {
        return json(res, 404, {
          error: { code: 404, message: `No endpoints found for ${body.model}` },
        })
      }
      const userText = lastUserText(body.messages)
      if (userText.includes('__error_429__'))
        return json(
          res,
          429,
          { error: { code: 429, message: 'Rate limit exceeded' } },
          { 'Retry-After': '2' },
        )
      if (userText.includes('__error_500__'))
        return json(res, 500, { error: { code: 500, message: 'Internal error' } })

      const id = `gen-mock-${++genCounter}-${Date.now()}`
      const provider = PROVIDERS[body.model.split('/')[0]] ?? 'MockProvider'
      const answer = cannedAnswer(body)
      const promptTokens =
        Math.ceil(allText(body.messages).length / 4) + (hasImage(body.messages) ? 800 : 0)
      const pieces = tokenize(answer)
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: pieces.length,
        total_tokens: promptTokens + pieces.length,
        cost: Number((promptTokens * 1e-7 + pieces.length * 4e-7).toFixed(7)),
      }
      const started = Date.now()
      const ttft = userText.includes('__slow__') ? 2000 : cfg.ttftMs

      if (!body.stream) {
        await sleep(ttft + pieces.length * cfg.tokenMs)
        generations.set(id, genStats(id, body.model, provider, started, ttft, usage))
        return json(res, 200, {
          id,
          provider,
          model: body.model,
          object: 'chat.completion',
          created: Math.floor(started / 1000),
          choices: [
            { index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' },
          ],
          usage,
        })
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      let closed = false
      res.on('close', () => {
        closed = true
      })
      res.write(': OPENROUTER PROCESSING\n\n')
      await sleep(ttft)
      const chunk = (delta, finish = null, extra = {}) =>
        `data: ${JSON.stringify({ id, provider, model: body.model, object: 'chat.completion.chunk', created: Math.floor(started / 1000), choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`
      res.write(chunk({ role: 'assistant', content: '' }))
      for (let i = 0; i < pieces.length; i++) {
        if (closed) return
        if (userText.includes('__midstream_error__') && i === 3) {
          res.write(
            `data: ${JSON.stringify({ id, error: { code: 502, message: 'Provider disconnected' }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] })}\n\n`,
          )
          res.end()
          return
        }
        res.write(chunk({ content: pieces[i] }))
        if (cfg.tokenMs > 0) await sleep(cfg.tokenMs)
      }
      res.write(chunk({}, 'stop'))
      res.write(
        `data: ${JSON.stringify({ id, provider, model: body.model, object: 'chat.completion.chunk', choices: [], usage })}\n\n`,
      )
      res.write('data: [DONE]\n\n')
      res.end()
      generations.set(id, genStats(id, body.model, provider, started, ttft, usage))
      return
    }
    return json(res, 404, {
      error: { code: 404, message: `Unknown endpoint ${req.method} ${path}` },
    })
  })

  await new Promise((resolve) => server.listen(port, host, resolve))
  const address = server.address()
  const baseUrl = `http://${host}:${address.port}/api/v1`
  return {
    baseUrl,
    port: address.port,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

function genStats(id, model, provider, started, ttft, usage) {
  return {
    id,
    model,
    provider_name: provider,
    created_at: new Date(started).toISOString(),
    latency: ttft,
    generation_time: Date.now() - started,
    tokens_prompt: usage.prompt_tokens,
    tokens_completion: usage.completion_tokens,
    native_tokens_prompt: usage.prompt_tokens,
    native_tokens_completion: usage.completion_tokens,
    total_cost: usage.cost,
    streamed: true,
    finish_reason: 'stop',
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
if (isMain) {
  const port = Number(process.argv[2] ?? process.env.MOCK_OPENROUTER_PORT ?? 4010)
  const mock = await startMockOpenRouter({ port, quiet: false })
  console.log(`Mock OpenRouter listening. Use BLUELY_OPENROUTER_BASE_URL=${mock.baseUrl}`)
}
