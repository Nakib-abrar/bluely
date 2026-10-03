# Troubleshooting

If none of this helps, [open a bug report](https://github.com/nakib-abrar/bluely/issues/new/choose)
with your Bluely version, Windows version, audio setup and the relevant part of the log.

## Where the logs are

`%APPDATA%\Bluely\logs\bluely.log` (paste that into File Explorer's address bar). When the file
reaches about 2 MB it is renamed to `bluely.log.1` and a new one starts. API keys and bearer
tokens are redacted automatically. Turn on developer logging (advanced settings) for more detail,
reproduce the problem, then attach the relevant lines. Transcripts are not written to the log, but
error messages can mention model names and settings.

## "No system audio detected" / the Them side stays empty

Bluely hears the other people through Windows **desktop loopback**: it captures whatever plays on
your **default playback device**. It shows this warning when you have been speaking for about 20
seconds and nothing has come from that device.

1. **Play something** (a YouTube video) while a session runs. If Them lines appear, capture works
   and the meeting app is playing somewhere else.
2. **Make the meeting app use the default output.** In _Windows Settings › System › Sound_, check
   the _Output_ device. In Teams/Zoom/Meet, set the speaker to "Default" or to that same device. If
   the meeting app plays to a different device (for example a headset that is not the Windows
   default), switch the Windows default to it.
3. **Volume and mute.** Make sure the call is audible: the meeting app is not muted in the
   _Volume mixer_ and the output device is not muted.
4. **Bluetooth headsets** switch to a low-quality "Hands-Free" device during calls. Check that the
   Windows default output follows it (it usually appears as a separate "Headset" device).
5. **Exclusive mode / enhancements.** In _Sound › More sound settings › Playback › your device ›
   Properties › Advanced_, try turning off _Allow applications to take exclusive control_ and
   _Audio enhancements_.
6. **Remote desktop / VMs** often have no real playback device. Loopback needs one.
7. **Check that loopback works with Bluely's Electron version** using the
   [loopback verifier](VERIFY_LOOPBACK.md). If it reports `LOOPBACK FAIL` on a normal Windows
   setup, please open an issue with its output.

## Microphone muted or not found ("Me" stays empty)

- **Windows privacy:** _Windows Settings › Privacy & security › Microphone_: turn on _Microphone access_
  and _Let desktop apps access your microphone_.
- **Pick the right microphone** in Bluely's audio settings (or onboarding) and use the test to
  see a live transcription. If you plug in a headset after starting Bluely, select it again.
- **Hardware mute:** many headsets and laptops have a mute switch or key; Windows may show the
  mic as working while it sends silence. Bluely warns when the mic signal is completely silent.
- **Another app using it exclusively:** close apps that might lock the microphone (some DAWs or
  recorders), or turn off exclusive mode for the recording device as above.
- **Your own voice shows up as "Them"**: your speakers are leaking into the call or the call is
  echoing you. Use headphones.

## Windows SmartScreen: "Windows protected your PC"

Bluely's builds are not code-signed, so SmartScreen does not recognise the publisher. If you
downloaded the file from the official
[Releases page](https://github.com/nakib-abrar/bluely/releases), click **More info → Run anyway**.
You can check that the file is untouched by comparing its SHA-256 with `SHA256SUMS.txt` from the
same release:

```powershell
Get-FileHash .\Bluely-Setup-0.1.0.exe -Algorithm SHA256
```

Some antivirus products also flag unsigned Electron apps. If yours quarantines Bluely, restore it
and add an exception, and please report it to the antivirus vendor as a false positive.

## OpenRouter errors

| What you see                                    | Meaning                                         | What to do                                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **401**: "OpenRouter rejected the API key"       | The key is wrong, revoked or was pasted partly. | Create a new key at [openrouter.ai/keys](https://openrouter.ai/keys), paste it in Settings › AI Models and click _Test connection_.               |
| **402**: "out of credits"                        | Your OpenRouter balance (or the key's credit limit) is used up. | Add credits at [openrouter.ai/settings/credits](https://openrouter.ai/settings/credits), or raise the key's limit on the keys page. |
| **429**: "rate limiting requests"                | Too many requests for your account, key or the chosen provider. Free models have low limits. | Bluely retries automatically. If it keeps happening, avoid `:free` models, add credits, or pick another model or provider order in Settings › AI Models. |
| "That model is not available right now"          | The model was retired or has no provider available. | Pick another model in Settings › AI Models. Bluely also replaces retired defaults at startup.                                                 |
| "Could not reach OpenRouter" / timeouts          | Network, proxy or firewall problem.             | Check your connection. Corporate networks may block `openrouter.ai`.                                                                               |
| "The provider flagged this request"              | The provider's moderation refused the prompt.  | Rephrase, or choose a model from another provider.                                                                                                 |

Run the latency test in Settings › AI Models to see which models answer fastest from where you are.

## Ctrl+Enter sends my chat message instead of asking Bluely

Slack, Teams and others can use <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to send. Bluely registers it as a
global shortcut, so the two compete. In **Settings › Keybinds**, apply the **Alt+Enter preset**
(one click), or record any other combination. Settings › Keybinds also shows when another app
already owns a shortcut and Bluely could not register it.

## Updates

- "Updates are checked in installed builds": you are running from source (`pnpm dev`). Use
  `git pull` instead.
- "Portable builds don't auto-update": download the latest `Bluely-<version>-portable.exe` from
  the Releases page and replace the old file. Your data in `%APPDATA%\Bluely` is kept.
- "Could not reach GitHub": update checks need access to `github.com`; Bluely keeps working
  without them.

## Start fresh

Quit Bluely (tray icon › Quit Bluely), then rename `%APPDATA%\Bluely` to keep a backup. Bluely
creates a new, empty data folder on the next start, and you can move the old one back later.
