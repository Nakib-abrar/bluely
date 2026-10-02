# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/nakib-abrar/bluely/security/advisories/new)**
(repository → _Security_ tab → _Report a vulnerability_).

Include the Bluely version (Settings › General), your Windows version, what an attacker can do,
and steps to reproduce. Do not include your OpenRouter API key or real meeting data; if a log is
useful, check it first (keys are redacted, but transcripts can be sensitive).

What to expect: an acknowledgement within 7 days, an assessment and a fix plan as soon as the
issue is understood, and credit in the release notes if you want it. Bluely is maintained by
volunteers, so please allow reasonable time before public disclosure; we will coordinate a date
with you.

## Supported versions

Only the **latest release** receives security fixes. Installed builds update themselves from
GitHub Releases; portable builds must be replaced by hand.

| Version         | Supported |
| --------------- | --------- |
| Latest release  | Yes       |
| Older releases  | No        |

## Security model

Bluely handles meeting transcripts, screenshots and an API key that can spend money, so it is
built to keep those inside the main process and to treat everything else as untrusted.

- **Isolated, sandboxed renderers.** The main window and the overlay run with `contextIsolation`,
  `sandbox` and no Node integration. The preload exposes a small allowlisted bridge
  (`window.bluely`: invoke / on for contract channels only, plus a file-path helper for drag and
  drop).
- **Strict Content Security Policy.** Scripts only from the app itself (`script-src 'self'`, plus
  `'wasm-unsafe-eval'` for the local VAD model), no `eval`, no inline scripts, no frames, no
  plugins, `base-uri 'none'`, `form-action 'none'`.
- **Custom `bluely://` protocol.** Built pages are served from `bluely://app/` by a handler that
  only serves files inside the app's renderer folder (path traversal is rejected), instead of
  `file://`.
- **Renderer network blocked.** The session's request filter cancels every renderer request to
  the network (`http:`, `https:`, `ws:`); only the app's own `bluely://app/` files and local
  `data:`/`blob:` URLs load (plus the Vite dev server in development). All network access
  (OpenRouter, GitHub) happens in the main process.
- **Validated IPC from trusted frames only.** Every IPC request is checked against a zod schema
  from the single contract in `src/shared/ipc.ts`; requests from any frame that is not one of
  Bluely's own pages are rejected. Errors cross the boundary as typed codes, not stack traces.
- **The API key never reaches a renderer.** It is encrypted at rest with Electron `safeStorage`
  (Windows DPAPI), decrypted only in main, and shown to the UI only in masked form. Logs redact
  anything that looks like a key or bearer token.
- **Narrow permissions.** Only Bluely's own pages may request the microphone (audio only) and
  display capture (used for desktop loopback audio). All other permission requests are denied.
- **External links are allowlisted.** `window.open` and links open in your browser only for
  `https://openrouter.ai/`, this repository and `mailto:`. Navigation away from the app and
  `<webview>` are blocked.
- **No remote content.** The UI never loads remote pages, scripts, fonts or images.
- **Development overrides are disabled in installed builds.** `BLUELY_OPENROUTER_BASE_URL`,
  `BLUELY_TEST_OPENROUTER_KEY` and `BLUELY_USER_DATA_DIR` are honoured only when the app runs
  unpackaged, so an installed Bluely cannot be redirected to another API host.
- **Updates** come only from this repository's GitHub Releases over HTTPS, and electron-updater
  checks each installer's SHA-512 against `latest.yml` before running it. Builds are not
  code-signed yet, so there is no publisher signature check; see the README for verifying
  downloads with `SHA256SUMS.txt`.
- **No stealth.** Bluely never hides itself from screen capture (enforced by a lint rule), so it
  cannot be used to secretly assist someone during a screen-shared call.

## Out of scope

- Attacks that require an attacker to already control your Windows account or run code as you
  (they can read `%APPDATA%\Bluely` and decrypt DPAPI-protected data like any of your apps).
- What OpenRouter or model providers do with requests you send them (see
  [PRIVACY.md](PRIVACY.md)).
- SmartScreen warnings caused by unsigned builds.
