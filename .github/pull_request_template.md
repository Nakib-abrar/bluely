## What and why

<!-- What does this change, and why? Link the issue: "Fixes #123". -->

## How it was tested

<!-- Unit/E2E tests added or run, manual steps. Say whether you tested on Windows. -->

## Checklist

- [ ] `pnpm format`, `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` pass
- [ ] Tests added or updated for new behaviour
- [ ] User-facing strings go through `t()` (keys in `src/shared/i18n/en/`)
- [ ] IPC changes are in `src/shared/ipc.ts` with zod schemas
- [ ] No new network destinations, or [PRIVACY.md](../PRIVACY.md) is updated
- [ ] No stealth features; sandbox, CSP and IPC validation untouched
- [ ] Docs and `CHANGELOG.md` ("Unreleased") updated if behaviour changed
- [ ] Tested on Windows (required for audio, window, shortcut, tray or packaging changes)

<!-- Screenshots or a short GIF for UI changes. -->
