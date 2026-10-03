# Bluely architecture

This document explains how Bluely is put together and why. It describes the intended design of
v1; file paths point at where each part lives.

```
 ┌──────────────── Overlay renderer (sandboxed) ────────────────┐   ┌── Main window renderer ──┐
 │ mic (getUserMedia) ─┐                                         │   │ home, history, search,   │
 │ desktop loopback ───┼─► 16 kHz mono ─► Silero VAD ─► WAV seg. │   │ session detail, settings │
 │ (getDisplayMedia)   ┘                                         │   │ onboarding               │
 │ cards · transcript · actions · Ask box                        │   └────────────┬─────────────┘
 └───────────────┬──────────────────────────────────────────────┘                │
                 │  window.bluely.invoke / on  (typed contract, zod-validated)   │
 ┌───────────────▼──────────────────────────────────────────────────────────────▼─────────────┐
 │ Main process                                                                                │
 │  IPC registry ─ session engine ─ STT queue ─ context builder ─ LLM client ─ post-call jobs   │
 │  SQLite (better-sqlite3, FTS5) · settings · encrypted key · windows · tray · shortcuts      │
 │  updater (GitHub Releases)                         OpenRouterHttp (undici keep-alive)       │
 └───────────────────────────────────────────────────────────────┬──────────────────────────────┘
                                                                 ▼
                                                     openrouter.ai/api/v1
```

## Process model and security

- **Main process** (`src/main/`): owns every privileged resource: the SQLite database, the
  encrypted API key, network access, windows, tray, global shortcuts and the updater.
  `src/main/index.ts` builds a `CoreContext` (`src/main/context.ts`: env, paths, log, db,
  settings, secrets, event bus, windows, overlay) and hands it to the composition root
  (`src/main/features.ts`), where each feature's `wire*()` function registers its IPC handlers.
- **Two renderers**, both `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`:
  - the **main window** (`src/renderer/main/`): frameless, always in the taskbar; home, history,
    search, session details, settings and onboarding;
  - the **overlay** (`src/renderer/overlay/`): a small transparent, frameless, always-on-top
    window (level `screen-saver` so it stays above full-screen meeting apps). It skips the taskbar
    only because the main window is always there. It never uses content protection or capture
    exclusion; a lint rule forbids those APIs.
- **Preload** (`src/preload/index.ts`) exposes `window.bluely` with `invoke(channel, payload)` and
  `on(event, cb)` for channels listed in the contract only, plus `getPathForFile` for drag and
  drop.
- **Pages** are served from the privileged `bluely://app/` scheme (`src/main/windows/security.ts`)
  with a strict CSP (`script-src 'self' 'wasm-unsafe-eval'`, no inline scripts, `object-src`,
  `frame-src`, `base-uri` and `form-action` all `'none'`).
- **Session hardening** (same file): a request filter cancels all renderer network requests
  except the app's own files (and the Vite dev server in development); permission handlers grant
  only microphone (audio only) and display capture, only to Bluely's pages; navigation, new
  windows and `<webview>` are blocked, and `window.open` goes to an allowlist
  (`EXTERNAL_URL_ALLOWLIST`) opened in the user's browser.
- **Dev overrides** (`src/main/env.ts`): `BLUELY_OPENROUTER_BASE_URL`, `BLUELY_TEST_OPENROUTER_KEY`,
  `BLUELY_USER_DATA_DIR` and the Vite URL are honoured only when `app.isPackaged` is false.

## IPC contract

`src/shared/ipc.ts` is the single source of truth for renderer ↔ main communication:

- **Invoke channels** (`invokeContract`): each has a zod request schema and a response type.
  `handle(channel, fn)` in `src/main/ipc/registry.ts` rejects senders that are not Bluely pages,
  validates the payload, runs the handler and returns an envelope `{ ok: true, data }` or
  `{ ok: false, error: { code, message, ai? } }`. Handlers throw `AppError(code, message)`
  (`src/main/errors.ts`); provider errors carry a friendly `AiErrorInfo`. Channels nobody
  registered get a typed `not_implemented` stub.
- **Events** (`EventContract`): main → renderer pushes such as `transcript:line`, `ai:delta`,
  `session:state`, `updater:status`. `EventBus` (`src/main/ipc/events.ts`) broadcasts to all
  windows or one window kind, and lets main-side services subscribe to the same events.
- The renderer side (`src/renderer/lib/ipc.ts`) unwraps envelopes into typed results or
  `IpcError`.

Large binary payloads (WAV segments, screenshots) travel as `Uint8Array` with size limits in the
schema.

## Audio pipeline

Capture runs in the overlay renderer, which exists for the whole session.

- **Me**: `getUserMedia` on the selected microphone.
- **Them**: `getDisplayMedia({ video, audio })`. Main's `setDisplayMediaRequestHandler` answers
  with the primary screen and `audio: 'loopback'`, which makes Chromium capture the Windows
  desktop audio mix (WASAPI loopback) without a picker or a virtual driver. The video track is
  not used. The string `'loopback'` matters: Electron 33.2+ throws if `audio` is a boolean.
  Chromium enables echo cancellation, noise suppression and automatic gain control on this track
  by default; they should be turned off for loopback (the AGC can even change the OS capture
  volume). See [VERIFY_LOOPBACK.md](VERIFY_LOOPBACK.md).
- Both streams are downmixed and resampled to **16 kHz mono**, then run through **Silero VAD v5**
  (`@ricky0123/vad-web`, ONNX in WASM, 512-sample / 32 ms frames, model files bundled locally).
  Sensitivity is configurable.
- Speech is cut into **segments** at pauses, or forcibly at the max length (12 s by default), and
  sent to main as 16-bit PCM WAV via `audio:segment` with capture and VAD timestamps for latency
  tracing.
- Health checks: "no system audio" after 20 s of silence on Them while Me is speaking, muted or
  missing microphone, loopback unavailable, and a headphones tip. Me lines that repeat what Them
  just said within 3 s (speaker echo into the mic) are dropped as duplicates.
- Audio is never written to disk.

Desktop loopback depends on Chromium/Electron behaviour, so the Electron version is pinned
(43.7.7) and checked with `scripts/verify-loopback/`. If a future version breaks it, the fallback
is a small native WASAPI sidecar behind the same `AudioSource` interface (roadmap).

## STT queue

Main receives segments and transcribes them through an `STTProvider`
(`src/main/providers/stt/STTProvider.ts`); v1 uses OpenRouter's `/audio/transcriptions` with
`openai/whisper-large-v3-turbo`.

- A small queue runs up to `advanced.sttConcurrency` requests at once (default 2); lines are
  ordered by capture time, not by when their transcription finished.
- Rate limits and server errors are retried with backoff (honouring `Retry-After`); a session
  warning shows while retries are happening.
- Each result becomes a `transcript_lines` row and a `transcript:line` event; cost and audio
  seconds go to `usage_log`. Lines have stable ids, so streaming providers can send partial →
  final updates later without UI changes.

## LLM client, routing and speed stats

- `OpenRouterHttp` (`src/main/providers/openrouterHttp.ts`) is the only HTTP client for
  OpenRouter: one undici keep-alive agent (no TLS handshake on the hot path), attribution headers
  (`HTTP-Referer`, `X-Title`), timeouts, and error mapping to `ProviderError` codes (`auth`,
  `credits`, `rate_limit`, `timeout`, …) in `src/main/providers/errors.ts`. The connection is
  pre-warmed when a session starts. Only main ever sees the key.
- The `LLMProvider` (`src/main/providers/llm/LLMProvider.ts`) streams chat completions over SSE as
  `meta` → `delta`… → `done` events. Renderers receive `ai:card`, `ai:delta`, `ai:done`,
  `ai:error` and can cancel.
- **Model roles** (`src/shared/defaultModels.json`): _fast_ for live suggestions
  (`meta-llama/llama-3.3-70b-instruct`, provider order Groq → Cerebras, `sort: latency`), _smart_
  for Assist and vision (`google/gemini-2.5-flash`), _notes_ for post-call work
  (`anthropic/claude-sonnet-4.5`, `sort: price`). Each role maps to OpenRouter's `provider`
  routing object (`sort`, `order`, `allow_fallbacks`). At startup the defaults are validated
  against `GET /models`; retired models are replaced from a curated fallback list.
- **Speed stats**: the client measures time to first token, total time and tokens/s for every
  request, then refines them from `GET /generation` (`ai:stats`). Per model/provider p50/p90
  values are kept in `model_stats` and drive the latency test and the speed readout. The
  latency dev panel (Ctrl+Shift+D) shows the full trace: VAD end → STT done → prompt built →
  request sent → first token → done.

## Context builder

Every live request is built from, in order of priority:

1. a system prompt: the active Mode's instructions and tone, the user's profile, the answer
   language setting, and Bluely's base instructions;
2. the **recent transcript window** (last `advanced.contextMinutes`, default 6 minutes) with Me /
   Them labels;
3. a **running summary** of everything older, refreshed every `advanced.summaryIntervalMin`
   (default 3 minutes) by a model call and stored with the session;
4. **knowledge snippets**: the Mode's files are split into ~800-token chunks (100-token overlap)
   at upload time; the query is matched against `knowledge_chunks_fts` (BM25) and the best chunks
   are included;
5. for Assist / Include screen, a **screenshot** (max 1600 px wide, JPEG quality 80). The overlay
   hides for ~120 ms while the screenshot is taken so it does not cover what you want to ask
   about; Bluely is still fully visible to screen sharing at all other times.

**Auto-suggest** watches final Them lines; when one looks like a question it waits for a short
debounce (700 ms, in case they keep talking), respects a cooldown (8 s) and then runs a _fast_
request labelled "Auto · they asked a question".

After the call, post-call jobs on the _notes_ model produce notes (title, summary, key points,
decisions), action items and a follow-up email. Failures are recorded so they can be
regenerated, and sessions interrupted by a crash are marked `recovered`.

## Data model and search

SQLite via better-sqlite3 in `%APPDATA%\Bluely\bluely.db`, opened with WAL,
`synchronous=NORMAL` (every committed transcript line survives a crash), foreign keys and
`auto_vacuum=INCREMENTAL`. Schema and migrations: `src/main/db/migrations.ts` (versioned with
`PRAGMA user_version`).

| Table                                    | Holds                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `sessions`                               | title, Mode, start/end, status, `summary_json` (notes, email, running summary) |
| `transcript_lines`                       | channel (`me`/`them`), start/end ms, text, `is_final`                    |
| `ai_messages`                            | every AI request: kind, prompt, response, model, provider, timings, tokens, cost, `used_screen` |
| `action_items`                           | text, owner, due, done                                                   |
| `modes`, `knowledge_files`, `knowledge_chunks` (+ `knowledge_chunks_fts`) | Modes and their extracted knowledge text |
| `settings`                               | settings JSON (schema in `src/shared/settings.ts`)                       |
| `model_stats`, `usage_log`               | latency percentiles; per-request cost for the monthly spend view         |

**Search** uses two FTS5 indexes kept in sync by triggers: `search_fts` (unicode61, diacritics
removed, prefix indexes) for normal queries and `search_trigram` for typo-tolerant matches. Each
row's rowid encodes its source (`source.rowid * 8 + tag`) so updates and deletes are cheap; titles,
final transcript lines, notes, action items and emails are indexed. "Ask across meetings" runs a
search, sends the best excerpts to the model and returns an answer with citations to the
sessions used. Never run a plain `VACUUM` (it can renumber rowids); use
`PRAGMA incremental_vacuum`, and `rebuildSearchIndex()` if the index ever drifts.

## Packaging and updates

- **electron-vite** builds main, preload and renderers into `out/`. **electron-builder**
  (`electron-builder.yml`) packages `out/**` and production dependencies into `app.asar`.
  `better-sqlite3`'s native module is unpacked (`asarUnpack`) because native addons cannot load
  from inside an archive. better-sqlite3 13 ships N-API prebuilds, so there is no rebuild step
  (`npmRebuild: false`) and non-Windows prebuilds are excluded. `resources/` (tray icons) is
  copied next to the app as `extraResources`.
- Targets: an **NSIS installer** and a **portable exe**. Builds are not code-signed. The
  installer is assisted (`oneClick: false`, `perMachine: false`): an install-mode page offers
  "only for me" (default; per-user in `%LOCALAPPDATA%\Programs\Bluely`, no admin) or "anyone who
  uses this computer" (elevates, `Program Files`); the folder can be changed and shortcuts are
  created. Uninstalling keeps `%APPDATA%\Bluely`; `build/installer.nsh` (`customUnInstall`)
  removes the launch-at-startup `Run` value, except during an update.
- **Launch at startup** (`src/main/platform/win32`): `app.setLoginItemSettings` writes
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (plus `StartupApproved\Run`) under the
  value name `io.github.nakib-abrar.bluely` (the AppUserModelId = `appId`) with `--hidden`. The
  portable build registers its launcher (`PORTABLE_EXECUTABLE_FILE`), never the copy it extracts
  to `%TEMP%` and deletes on exit; `canLaunchAtStartup()` is false if that path is unknown.
- **Releases**: `.github/workflows/release.yml` runs on `v*` tags on `windows-latest`:
  typecheck, lint, unit tests, build, then `electron-builder --publish never` and
  `SHA256SUMS.txt` (also printed in the job summary). The publish step uploads with `gh`: a new
  release is created as a **draft**, then the Setup exe, its blockmap, the portable exe,
  `latest.yml` and finally `SHA256SUMS.txt` are attached one by one, and only then is the release
  published, so the auto-updater never sees a half-uploaded release. Re-running on an existing
  release replaces all of its files from the new build; a failed upload fails the job.
  (electron-builder's own publisher silently skips releases published more than 2 hours ago,
  which is why it is not used.) Manual runs are dry runs that upload workflow artifacts unless
  _publish_ is checked on a `v*` tag.
- **Auto-update** (`src/main/updater.ts`): electron-updater with the GitHub provider, installed
  (NSIS) builds only. It checks ~10 s after start and every 6 h, never downloads without the user
  clicking _Download_, verifies the installer's SHA-512 from `latest.yml`, and installs on
  _Restart to update_ or when Bluely quits. Development and portable builds report
  "unsupported" and never contact GitHub. State is pushed to the UI as `updater:status`.
- **Electron pin**: `electron` is pinned to an exact version (43.7.7). Desktop loopback has
  regressed between Electron versions before, so any upgrade must pass
  [the loopback verifier](VERIFY_LOOPBACK.md) on Windows. 43.7.7 passes it in Windows CI
  (`loopback-windows.yml`, Windows Server 2022 and 2025 with a virtual sound card) but has not yet
  been verified on a physical Windows 10/11 PC; see the results table there.
