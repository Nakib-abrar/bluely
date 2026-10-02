// Bluely loopback verifier: checks whether an Electron version can capture desktop (loopback)
// audio the way Bluely does for the "Them" channel.
//
// Standalone and dependency-free, so it runs with any Electron version:
//   npx electron@43.7.7 scripts/verify-loopback/main.cjs
//   pnpm verify:loopback                       (the Electron version pinned by Bluely)
//
// It plays a 1 kHz tone through the default output device, captures desktop audio with
// getDisplayMedia() + setDisplayMediaRequestHandler({ audio: 'loopback' }), and prints
//   LOOPBACK PASS|FAIL electron=<v> chrome=<v> platform=<p> tone=<dB> floor=<dB>
// Exit code 0 = PASS, 1 = FAIL. Flags: --verbose (page logs), --timeout=<ms> (default 20000).
// See docs/VERIFY_LOOPBACK.md.
'use strict'

const { app, BrowserWindow, desktopCapturer, session } = require('electron')
const os = require('node:os')
const path = require('node:path')

const args = process.argv.slice(1)
const verbose = args.includes('--verbose')
const timeoutArg = args.find((a) => a.startsWith('--timeout='))
const TIMEOUT_MS = timeoutArg ? Number(timeoutArg.split('=')[1]) || 20000 : 20000

// Pass criteria: the tone must be clearly audible in the capture and stand well above the
// level at an unrelated frequency (3.3 kHz is not a harmonic of 1 kHz).
const MIN_TONE_DB = -60
const MIN_MARGIN_DB = 20

if (process.platform === 'linux') {
  // Chromium gates PulseAudio loopback for screen share behind this feature (off by default in
  // some versions).
  const existing = app.commandLine.getSwitchValue('enable-features')
  const features = new Set(existing ? existing.split(',').filter(Boolean) : [])
  features.add('PulseaudioLoopbackForScreenShare')
  app.commandLine.appendSwitch('enable-features', [...features].join(','))
}

let finished = false

function fmtDb(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : 'n/a'
}

function finish(pass, result, reason) {
  if (finished) return
  finished = true
  const r = result || {}
  const lines = []
  if (reason) lines.push(`reason: ${reason}`)
  lines.push(
    `details: os=${os.type()} ${os.release()} audioTracks=${r.audioTracks ?? 'n/a'}` +
      ` track="${r.trackLabel ?? ''}" sampleRate=${r.sampleRate ?? 'n/a'}` +
      ` rms=${fmtDb(r.rmsDb)} margin=${fmtDb(r.toneDb - r.floorDb)}`,
  )
  lines.push(
    `LOOPBACK ${pass ? 'PASS' : 'FAIL'} electron=${process.versions.electron}` +
      ` chrome=${process.versions.chrome} platform=${process.platform}-${process.arch}` +
      ` tone=${fmtDb(r.toneDb)} floor=${fmtDb(r.floorDb)}`,
  )
  const code = pass ? 0 : 1
  // Exit only after stdout is flushed (TTY writes are asynchronous on Windows).
  process.stdout.write(`${lines.join('\n')}\n`, () => app.exit(code))
  setTimeout(() => app.exit(code), 2000).unref()
}

const timer = setTimeout(() => {
  finish(false, null, `timed out after ${TIMEOUT_MS} ms`)
}, TIMEOUT_MS)

process.on('uncaughtException', (err) => {
  finish(false, null, `main process error: ${err && err.message ? err.message : String(err)}`)
})

app
  .whenReady()
  .then(async () => {
    const ses = session.defaultSession
    if (typeof ses.setDisplayMediaRequestHandler !== 'function') {
      finish(false, null, 'session.setDisplayMediaRequestHandler is not available (Electron < 22)')
      return
    }

    // Same shape as Bluely's handler (src/main/windows/security.ts): the primary screen plus
    // desktop loopback audio. 'loopback' must be a string: Electron 33.2+ throws on booleans.
    ses.setDisplayMediaRequestHandler(
      (_request, callback) => {
        desktopCapturer
          .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
          .then((sources) => {
            if (!sources.length) {
              if (verbose) console.log('[main] desktopCapturer returned no screens')
              callback({})
              return
            }
            if (verbose) console.log(`[main] capturing ${sources[0].id} with audio: 'loopback'`)
            callback({ video: sources[0], audio: 'loopback' })
          })
          .catch((err) => {
            if (verbose) console.log(`[main] desktopCapturer failed: ${err.message}`)
            callback({})
          })
      },
      { useSystemPicker: false },
    )

    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    })

    // Newer Electron versions put the message on the event; older ones pass (event, level, msg).
    // A one-parameter listener avoids the deprecation warning newer versions print otherwise.
    win.webContents.on('console-message', (event, ...legacy) => {
      const text = event && typeof event.message === 'string' ? event.message : legacy[1]
      if (verbose && text) console.log(`[page] ${text}`)
    })
    win.webContents.on('render-process-gone', (_e, details) => {
      finish(false, null, `renderer process gone: ${details ? details.reason : 'unknown'}`)
    })

    await win.loadFile(path.join(__dirname, 'index.html'))
    // userGesture=true: getDisplayMedia() and AudioContext may require user activation.
    const result = await win.webContents.executeJavaScript('window.runLoopbackTest()', true)
    clearTimeout(timer)

    if (!result || result.error) {
      finish(false, result, result ? result.error : 'no result from the test page')
      return
    }
    const margin = result.toneDb - result.floorDb
    const pass = result.toneDb >= MIN_TONE_DB && margin >= MIN_MARGIN_DB
    const reason = pass
      ? null
      : result.toneDb < MIN_TONE_DB
        ? `the 1 kHz tone was not captured (tone ${fmtDb(result.toneDb)} dBFS < ${MIN_TONE_DB})`
        : `the tone is not clearly above the floor (margin ${fmtDb(margin)} dB < ${MIN_MARGIN_DB})`
    finish(pass, result, reason)
  })
  .catch((err) => {
    finish(false, null, `error: ${err && err.message ? err.message : String(err)}`)
  })
