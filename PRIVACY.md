# Privacy

Bluely is local-first. There is no Bluely server, no account and no telemetry. This page lists
exactly what Bluely stores on your computer, what it sends over the network, and to whom.

## What is stored, and where

Everything lives in your Windows user profile at **`%APPDATA%\Bluely`** (usually
`C:\Users\<you>\AppData\Roaming\Bluely`), for both the installed and the portable build. Bluely's
Settings can open this folder for you.

| File / folder         | Contents                                                                                                                                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bluely.db`           | SQLite database: sessions (title, Mode, start/end time), **transcript text**, **AI messages including the prompts sent and the responses received**, notes, action items, follow-up emails, Modes, **extracted text of knowledge files** plus file metadata (name, size; the original files are not copied), settings, model latency statistics, and a usage log with the cost of each request. |
| `openrouter-key.bin`  | Your OpenRouter API key, encrypted with Windows DPAPI through Electron `safeStorage`. Only your Windows user account can decrypt it.                                                                                                                                                                                       |
| `models-cache.json`   | A cached copy of OpenRouter's public model list (names, prices, capabilities).                                                                                                                                                                                                                                             |
| `logs/bluely.log`     | Diagnostic log, rotated at about 2 MB (one previous file is kept as `bluely.log.1`). API keys and bearer tokens are redacted before anything is written.                                                                                                                                                                     |
| `screenshots/`        | Only if you turn on _Save screenshots with sessions_ (Settings › Privacy, **off by default**). Otherwise screenshots exist only in memory while a request is sent.                                                                                                                                                        |

**Audio is never stored.** Microphone and desktop audio are processed in memory: speech segments
are sent for transcription and then discarded. Only the resulting text is saved.

The database file is not encrypted. Anyone who can sign in to your Windows account (or read your
disk) can read it, just like your other documents. Use Windows device encryption (BitLocker) if
that matters to you.

## What is sent over the network

Bluely talks to exactly two services. Renderer windows cannot make network requests at all; every
call is made by Bluely's main process.

### OpenRouter (`openrouter.ai`), using your API key

- **Speech segments** (16 kHz mono WAV, at most 12 seconds each by default) for transcription,
  for both your microphone ("Me") and desktop audio ("Them") while a session is running. Silence
  is not sent: voice activity detection runs locally.
- **Prompts** for suggestions, actions, questions, notes and emails. Depending on the request a
  prompt contains: recent transcript excerpts, the running summary of the meeting, your profile
  (name, role, company, about), the active Mode's instructions, and relevant snippets from that
  Mode's knowledge files. Post-call notes, action items and the follow-up email are generated
  from the meeting's transcript. "Ask across meetings" includes excerpts from the matching past
  meetings.
- **A screenshot of your screen**, only when you use _Assist_ or turn on _Include screen_ for a
  question. Bluely never captures your screen in the background.
- **Latency test prompts** when you run the latency test in Settings › AI Models.
- **Key info and credits requests** (`/key`, `/credits`) when you test your key or view spend, the
  public model list (`/models`), and per-request generation stats (`/generation`).

Requests carry the attribution headers `HTTP-Referer: https://github.com/nakib-abrar/bluely` and
`X-Title: Bluely`, which identify the app (not you) to OpenRouter.

OpenRouter forwards each request to the model provider that serves it (for example Groq, Google,
Anthropic or OpenAI). What OpenRouter and those providers log or retain is governed by
[OpenRouter's privacy policy](https://openrouter.ai/privacy) and by the data settings in your
OpenRouter account, where you can control whether providers that log or train on prompts may be
used.

### GitHub (`github.com`), installed builds only

- **Update checks**: Bluely downloads release metadata (`latest.yml`) from this repository's
  GitHub Releases about 10 seconds after start and then every 6 hours, and downloads an installer
  only when you click _Download_. Portable and development builds never check. GitHub sees your IP
  address, as with any download.

### Nothing else

No telemetry, no analytics, no crash reporting, no accounts, no Bluely server. Links you click
(for example to openrouter.ai or this repository) open in your own browser.

## Your controls

- **Retention** (Settings › Privacy): keep sessions forever (default), or delete them
  automatically after 30, 90 or 365 days.
- **Export all**: writes your sessions to a file you choose.
- **Delete all**: permanently deletes your stored meeting data after you confirm.
- **Remove the API key**: Settings › AI Models.
- Deleting a single session removes its transcript, AI messages, notes and action items.
- Uninstalling Bluely keeps `%APPDATA%\Bluely`; delete that folder to remove everything.

## Other people on your calls

Bluely transcribes what other participants say. Tell them you are using it (the consent reminder
and its one-click disclosure message are on by default), and follow the laws and policies that
apply to you.

Questions about privacy: open an issue at https://github.com/nakib-abrar/bluely/issues.
