# Changelog

All notable changes to Bluely are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Bluely uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - Unreleased

Initial release: an open-source AI meeting copilot for Windows, powered by OpenRouter.

### Added

- Live two-channel transcript: microphone ("Me") and Windows desktop loopback audio ("Them"),
  segmented locally with Silero VAD and transcribed through OpenRouter
  (`openai/whisper-large-v3-turbo` by default).
- Always-on-top overlay with auto-suggest when the other person asks a question, typed questions,
  and one-click actions: Assist, What should I say?, Follow-up questions, Fact check, Who am I
  talking to?, Recap. Assist / Include screen sends a screenshot to the vision model.
- Fast and Smart model tiers with OpenRouter provider routing (fast: Llama 3.3 70B on Groq or
  Cerebras sorted by latency; smart: Gemini 2.5 Flash), validated against the live model list at
  startup with automatic fallbacks.
- Speed readout on every answer (time to first word, total time, tokens/s, provider, model) and a
  latency test in Settings › AI Models.
- Modes with instructions, tone, auto-suggest and model overrides, six starter Modes, and
  knowledge files (PDF, DOCX, TXT, Markdown) with local full-text retrieval.
- After-call notes, action items and follow-up email; Markdown export and mail draft.
- Meeting history with full-text and typo-tolerant search, and "ask across meetings" with
  citations.
- Three-step onboarding, configurable global keybinds with conflict detection and an
  Alt+Enter preset, tray icon, consent reminder with one-click disclosure message.
- Local-first storage in `%APPDATA%\Bluely` with retention, export all and delete all; API key
  encrypted with Windows DPAPI.
- Windows NSIS installer (per-user) and portable exe, built and published by GitHub Actions with
  SHA-256 checksums; auto-update from GitHub Releases for installed builds.
- Loopback verifier (`scripts/verify-loopback/`) to check desktop audio capture for any
  Electron version.

[Unreleased]: https://github.com/nakib-abrar/bluely/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nakib-abrar/bluely/releases/tag/v0.1.0
