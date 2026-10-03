# Contributing to Bluely

Thanks for helping. Bluely is a small, volunteer-run project; focused pull requests with tests are
the easiest to review. For anything larger than a bug fix, open an issue first so we can agree on
the approach.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues go
through [SECURITY.md](SECURITY.md), not public issues.

## Setup

Requirements: **Node.js 22.12+**, **pnpm 10** (`corepack enable` picks the version pinned in
`package.json`), Git. Windows 10/11 is the target platform. Linux works for development and
tests; macOS is untested.

```bash
git clone https://github.com/nakib-abrar/bluely.git
cd bluely
pnpm install
pnpm dev
```

`pnpm install` uses `node-linker=hoisted` (see `.npmrc`) and its `postinstall` copies the Silero
VAD model and the onnxruntime-web WASM files into `src/renderer/public/vad/` so they are served
locally (no CDN).

You do not need an OpenRouter key to work on most of the app. Start the local mock API and point
an unpackaged build at it:

```bash
pnpm mock:openrouter                                   # http://127.0.0.1:4010
BLUELY_OPENROUTER_BASE_URL=http://127.0.0.1:4010/api/v1 pnpm dev
```

Any `sk-or-…` key is accepted by the mock (`sk-or-bad…` returns 401, `sk-or-nocredits…` 402).
Prompt triggers such as `__error_429__` or `__slow__` simulate failures; see the header of
`scripts/mock-openrouter.mjs`. Development-only environment variables (all ignored in installed
builds):

| Variable                     | Effect                                                        |
| ---------------------------- | ------------------------------------------------------------- |
| `BLUELY_OPENROUTER_BASE_URL` | Use another OpenRouter-compatible API (the mock)              |
| `BLUELY_TEST_OPENROUTER_KEY` | Inject an API key without storing it                          |
| `BLUELY_USER_DATA_DIR`       | Use another data folder instead of `%APPDATA%\Bluely`         |
| `BLUELY_VERBOSE=1`           | Also print info-level logs to the console                     |

## Scripts

| Command                | What it does                                                                     |
| ---------------------- | -------------------------------------------------------------------------------- |
| `pnpm dev`             | Electron + Vite dev server with hot reload (F12 toggles DevTools in dev builds)  |
| `pnpm build`           | Production build into `out/`                                                     |
| `pnpm start`           | Runs the production build                                                        |
| `pnpm typecheck`       | `tsc` for main/preload, renderer and tests                                       |
| `pnpm lint`            | ESLint, zero warnings allowed                                                    |
| `pnpm format`          | Prettier write (`pnpm format:check` to verify)                                   |
| `pnpm test`            | Unit tests (Vitest inside Electron's Node)                                       |
| `pnpm test:e2e`        | Builds, then runs the Playwright end-to-end tests against Electron               |
| `pnpm mock:openrouter` | Local mock of the OpenRouter API                                                 |
| `pnpm verify:loopback` | Checks desktop audio capture with the pinned Electron ([docs](docs/VERIFY_LOOPBACK.md)) |
| `pnpm dist`            | Windows NSIS installer + portable exe into `release/`                            |
| `pnpm dist:dir`        | Unpacked Windows app in `release/win-unpacked/` (quick packaging check)          |

### Opt-in end-to-end checks

Some Playwright specs skip unless you switch them on, because they play sound, need a packaged
build or take a minute to measure:

| Spec                               | Switch                                         | What it checks                                                                                              |
| ---------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `tests/e2e/audio.spec.ts`          | `BLUELY_HARNESS=1 pnpm build` first            | The capture pipeline (worklet, Silero VAD, WAV) on Chromium's fake mic; PulseAudio loopback on Linux       |
| `tests/e2e/liveaudio.spec.ts`      | Linux: PulseAudio installed; Windows: `BLUELY_E2E_AUDIO=1` | Speech played on the speakers → "Them" line → automatic suggestion → notes (plays sound out loud on Windows) |
| `tests/e2e/perf.spec.ts`           | `BLUELY_PERF=1`                                | CPU and memory of every Bluely process, app idle and during a live session                                 |
| `tests/e2e/packaged.spec.ts`       | `BLUELY_PACKAGED_EXE=release\win-unpacked\Bluely.exe` (after `pnpm dist:dir`) | The packaged app: data folder, native SQLite module, bundled VAD files, a session that starts capture |

`.github/workflows/loopback-windows.yml` runs all four on Windows Server 2022 and 2025 runners
with a virtual sound card (VB-CABLE), plus the loopback verifier for the pinned Electron and its
neighbours.

## Project structure

```
src/
  shared/      Code shared by every process: domain types (types.ts), THE typed IPC contract
               (ipc.ts), settings schema/defaults (settings.ts), constants, keybinds, built-in
               Modes, default models, i18n catalogs (i18n/en/*.ts)
  main/        Main process: composition root (features.ts), CoreContext (context.ts), IPC
               registry + event bus (ipc/), SQLite + migrations + FTS search (db/), settings and
               encrypted key (settings/), windows + security (windows/), OpenRouter HTTP layer and
               provider interfaces (providers/), Windows-specific code (platform/win32/),
               auto-updater (updater.ts)
  preload/     The sandboxed bridge (window.bluely: invoke/on for contract channels only)
  renderer/    React UI: main window (main/), overlay (overlay/), design system
               (components/ui/), stores, hooks, styles
scripts/       Dev tooling: mock OpenRouter, Vitest-in-Electron runner, VAD asset copy,
               loopback verifier (verify-loopback/)
tests/         unit/ (Vitest), e2e/ (Playwright), fixtures/ (speech WAVs), stubs/
build/         Packaging resources (installer/app icon)
resources/     Runtime assets shipped next to the app (tray icons)
docs/          Architecture, troubleshooting, loopback verification
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before larger changes.

## Coding standards

- **TypeScript strict.** No `any` (lint enforces `@typescript-eslint/no-explicit-any`) and no
  casts that bypass the IPC contract.
- **Prettier**: no semicolons, single quotes, print width 100, trailing commas. Run
  `pnpm format`.
- **Comments explain why**, not what. Exported APIs get a short doc comment.
- **All user-facing text goes through `t('namespace.key', vars)`** with the English string in
  `src/shared/i18n/en/<namespace>.ts`.
- **IPC changes go through `src/shared/ipc.ts`.** Add the channel with a zod request schema and
  a response type, then register the handler with `handle()` in main. Never call `ipcMain` or
  `ipcRenderer` directly.
- **Network calls only in the main process.** Renderers are blocked from the network on purpose.
  Adding a new network destination is a privacy change: update [PRIVACY.md](PRIVACY.md) in the
  same pull request.
- **Never weaken security**: no disabling `sandbox`, `contextIsolation` or the CSP, no remote
  content, no new external URLs outside the allowlist without discussion.
- No new runtime dependencies without discussing them in an issue first (installer size and
  supply-chain risk matter).

## Tests

- **Unit tests** live in `tests/unit/**/*.test.ts`. `pnpm test` runs Vitest **inside Electron's
  bundled Node** (`ELECTRON_RUN_AS_NODE=1`, see `scripts/run-vitest.mjs`) so native modules such as
  better-sqlite3 load with the same ABI as the app. Imports of `electron` are aliased to
  `tests/stubs/electron.ts`; use `vi.mock()` for anything more specific. Tests must never call
  the real OpenRouter API: inject a fake `fetchImpl` or start the mock with
  `startMockOpenRouter()` from `scripts/mock-openrouter.mjs`.
- **End-to-end tests** live in `tests/e2e/*.spec.ts` and drive the built app with Playwright's
  `_electron` (see `tests/e2e/helpers.ts`, which gives every run an isolated data folder).
  Run `pnpm build` first. On Linux use Xvfb:

  ```bash
  pnpm build
  xvfb-run -a -s "-screen 0 1600x1000x24" pnpm exec playwright test
  ```

  As root (containers), Electron needs `--no-sandbox`; the helper adds it automatically.
- Speech fixtures: `tests/fixtures/speech-en-16k.wav` and `speech-en-48k.wav`.

## Adding an AI provider

OpenRouter is the only provider in v1, but the code is written against two interfaces so others
can be added without touching the UI.

**Chat (`LLMProvider`, `src/main/providers/llm/LLMProvider.ts`)**

1. Create `src/main/providers/llm/<Name>Provider.ts` implementing `streamChat`, `complete`,
   `listModels`, `prewarm` (and optionally `getGenerationStats`).
2. `streamChat` yields one `meta` event (when known), `delta` events, then exactly one `done`
   with `SpeedStats` (time to first token, total time, tokens/s). Measure from your side when the
   provider does not report timings.
3. Throw `ProviderError` from `src/main/providers/errors.ts` with the right code (`auth`,
   `credits`, `rate_limit`, `timeout`, `network`, `aborted`, …) so the UI shows the right message
   and retry behaviour. Honour `signal` (code `aborted`).
4. Make HTTP calls from main only, with an injectable fetch for tests, and store any API key with
   Electron `safeStorage` (see `src/main/settings/secrets.ts`).
5. Wire it in the composition root (`src/main/features.ts`), add settings to
   `src/shared/settings.ts` if needed, and update [PRIVACY.md](PRIVACY.md) and the external URL
   allowlist in `src/shared/constants.ts`.

**Speech-to-text (`STTProvider`, `src/main/providers/stt/STTProvider.ts`)**

- Segment-based providers implement `transcribe(segment, opts)`: input is a 16 kHz mono 16-bit WAV
  cut by the VAD; return the text plus latency and cost.
- Streaming providers set `supportsStreaming = true` and implement `openStream()`, emitting
  partial results that are replaced by a final result with the same `id` (the transcript UI
  already updates lines in place).

Add unit tests with recorded or fake responses for both success and error paths.

## No stealth features

Bluely is a visible assistant. We do not accept changes that hide Bluely from screen sharing or
recording (`setContentProtection`, `SetWindowDisplayAffinity`/`WDA_EXCLUDEFROMCAPTURE` and
similar; a lint rule blocks them), hide it from the taskbar or tray, disguise its windows or
process, remove or disable the consent reminder by default, or otherwise help users deceive the
people they talk to. The same applies to features whose main purpose is cheating in interviews or
exams.

## Pull request checklist

- [ ] The change is focused, and larger changes were discussed in an issue first.
- [ ] `pnpm format`, `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` pass.
- [ ] New behaviour has unit tests; UI flows have an E2E test where practical.
- [ ] User-facing strings use `t()` with keys in `src/shared/i18n/en/`.
- [ ] IPC changes are in `src/shared/ipc.ts` with zod schemas.
- [ ] No new network destinations, or PRIVACY.md is updated.
- [ ] No stealth features; no weakening of sandbox, CSP or IPC validation.
- [ ] Docs (README, docs/, CHANGELOG "Unreleased") updated if behaviour changed.
- [ ] Tested on Windows if the change touches audio, windows, shortcuts, tray or packaging (say
      so in the PR if you could not).

## Releasing (maintainers)

1. Update `version` in `package.json` and move the "Unreleased" notes in `CHANGELOG.md` under the
   new version.
2. Check desktop audio on real Windows 10 and 11 PCs with a dry-run build (see
   [Before a release: check real Windows hardware](docs/VERIFY_LOOPBACK.md#before-a-release-check-real-windows-hardware))
   and record the result.
3. Commit, then tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
4. `.github/workflows/release.yml` checks, tests and builds on Windows, creates the GitHub Release
   as a draft, attaches `Bluely-Setup-<version>.exe`, its `.blockmap`,
   `Bluely-<version>-portable.exe`, `latest.yml` (used by the auto-updater) and finally
   `SHA256SUMS.txt`, and only then publishes it. If an upload fails, the job fails before
   `SHA256SUMS.txt` is attached and before anything is published; re-run the job. The tag must
   equal `v` + the `package.json` version.
5. Edit the release notes on GitHub (paste the changelog section).

To rebuild and replace the files of an existing release, run _Actions → Release → Run workflow_
on its `v*` tag with _publish_ checked: every file, including `SHA256SUMS.txt`, is replaced from
the new build. For a dry run, leave _publish_ unchecked; the artifacts are attached to the
workflow run instead. Before upgrading Electron, run the
[loopback verifier](docs/VERIFY_LOOPBACK.md) with the new version on Windows.
