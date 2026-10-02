/**
 * Microphone source + "Test microphone" + "Test system audio" card, shared by
 * Settings › General › Audio settings and onboarding step 2.
 */
import { Headphones, Mic, Square, Volume2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { Button, Card, Select, type SelectOption } from '../../components/ui'
import { useSettings } from '../../stores/settings'
import {
  listMicrophones,
  recordMicSample,
  testSystemAudio,
  transcribeSample,
  type SystemAudioTestResult,
} from '../audioAdapter'
import { describeError } from '../lib/errors'
import { formatMs } from '../lib/models'
import { Divider, LevelMeter, StatusLine } from './bits'

const SAMPLE_SECONDS = 5
/** Below this peak RMS (about -48 dBFS) we assume nothing was said and skip transcription. */
const SILENCE_RMS = 0.004
const DEFAULT_MIC = '__default'

type MicTestState =
  | { kind: 'idle' }
  | { kind: 'recording'; secondsLeft: number }
  | { kind: 'transcribing' }
  | { kind: 'done'; text: string; latencyMs: number; model: string }
  | { kind: 'error'; message: string }

type SystemTestState =
  { kind: 'idle' } | { kind: 'testing' } | { kind: 'done'; result: SystemAudioTestResult }

function useMicrophones() {
  const [mics, setMics] = useState<{ deviceId: string; label: string }[]>([])
  useEffect(() => {
    let alive = true
    const refresh = () => {
      listMicrophones()
        .then((list) => alive && setMics(list))
        .catch(() => undefined)
    }
    refresh()
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh)
    return () => {
      alive = false
      navigator.mediaDevices?.removeEventListener?.('devicechange', refresh)
    }
  }, [])
  return mics
}

function MicLabel({ children }: { children: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Mic size={13} className="shrink-0 text-subtle" aria-hidden="true" />
      <span className="truncate">{children}</span>
    </span>
  )
}

export function AudioSetupCard() {
  const audio = useSettings((s) => s.settings.audio)
  const update = useSettings((s) => s.update)
  const mics = useMicrophones()
  const [micTest, setMicTest] = useState<MicTestState>({ kind: 'idle' })
  const [level, setLevel] = useState(0)
  const [systemTest, setSystemTest] = useState<SystemTestState>({ kind: 'idle' })
  const micAbort = useRef<AbortController | null>(null)
  const systemAbort = useRef<AbortController | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Leaving the page (or closing Settings) cancels any running test and releases the mic.
  useEffect(
    () => () => {
      micAbort.current?.abort()
      systemAbort.current?.abort()
    },
    [],
  )

  const selected = audio.micDeviceId ?? DEFAULT_MIC
  const options: SelectOption<string>[] = [
    { value: DEFAULT_MIC, label: <MicLabel>{t('settings.audio.mic.systemDefault')}</MicLabel> },
    ...mics.map((m) => ({ value: m.deviceId, label: <MicLabel>{m.label}</MicLabel> })),
  ]
  if (audio.micDeviceId && !mics.some((m) => m.deviceId === audio.micDeviceId)) {
    options.push({
      value: audio.micDeviceId,
      label: (
        <MicLabel>
          {t('settings.audio.mic.disconnected', { label: audio.micLabel ?? audio.micDeviceId })}
        </MicLabel>
      ),
    })
  }

  const chooseMic = (value: string) => {
    const mic = mics.find((m) => m.deviceId === value)
    setSaveError(null)
    update({
      audio:
        value === DEFAULT_MIC || !mic
          ? { micDeviceId: null, micLabel: null }
          : { micDeviceId: mic.deviceId, micLabel: mic.label },
    }).catch((err: unknown) =>
      setSaveError(t('settings.saveFailed', { error: describeError(err) })),
    )
    setMicTest({ kind: 'idle' })
  }

  const runMicTest = useCallback(async () => {
    const controller = new AbortController()
    micAbort.current = controller
    const startedAt = Date.now()
    setMicTest({ kind: 'recording', secondsLeft: SAMPLE_SECONDS })
    const ticker = setInterval(() => {
      const left = Math.max(0, Math.ceil(SAMPLE_SECONDS - (Date.now() - startedAt) / 1000))
      setMicTest((s) => (s.kind === 'recording' ? { kind: 'recording', secondsLeft: left } : s))
    }, 250)
    try {
      const sample = await recordMicSample({
        deviceId: audio.micDeviceId,
        seconds: SAMPLE_SECONDS,
        onLevel: setLevel,
        signal: controller.signal,
      })
      clearInterval(ticker)
      setLevel(0)
      if (sample.peakRms < SILENCE_RMS) {
        setMicTest({ kind: 'error', message: t('settings.audio.mic.silent') })
        return
      }
      setMicTest({ kind: 'transcribing' })
      const result = await transcribeSample(sample.wav)
      if (controller.signal.aborted) return
      setMicTest({ kind: 'done', ...result })
    } catch (err) {
      // A cancelled test (Stop, page change) just returns to idle.
      setMicTest(
        controller.signal.aborted
          ? { kind: 'idle' }
          : { kind: 'error', message: describeError(err) },
      )
    } finally {
      clearInterval(ticker)
      setLevel(0)
    }
  }, [audio.micDeviceId])

  const runSystemTest = async () => {
    const controller = new AbortController()
    systemAbort.current = controller
    setSystemTest({ kind: 'testing' })
    try {
      const result = await testSystemAudio({ signal: controller.signal })
      setSystemTest({ kind: 'done', result })
    } catch (err) {
      if (controller.signal.aborted) return
      setSystemTest({
        kind: 'done',
        result: { ok: false, detectedDb: null, reason: describeError(err) },
      })
    }
  }

  const recording = micTest.kind === 'recording'
  const busy = recording || micTest.kind === 'transcribing'

  return (
    <div>
      <Card className="p-0!">
        <div className="flex items-center gap-3.5 px-4 pt-3.5 pb-3">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium text-fg">{t('settings.audio.mic.title')}</div>
            <Select
              value={selected}
              onValueChange={chooseMic}
              options={options}
              label={t('settings.audio.mic.selectLabel')}
              size="sm"
              disabled={busy}
              className="-ml-2 mt-0.5 h-7! max-w-full border-transparent! bg-transparent! px-2! text-muted hover:bg-panel-3! hover:text-fg"
            />
          </div>
          {recording ? (
            <Button
              icon={<Square size={11} fill="currentColor" />}
              onClick={() => micAbort.current?.abort()}
            >
              {t('settings.audio.mic.stop')}
            </Button>
          ) : (
            <Button onClick={() => void runMicTest()} loading={micTest.kind === 'transcribing'}>
              {t('settings.audio.mic.test')}
            </Button>
          )}
        </div>
        {micTest.kind !== 'idle' || saveError ? (
          <div className="px-4 pb-3.5" data-testid="mic-test">
            {saveError ? <StatusLine tone="error">{saveError}</StatusLine> : null}
            {micTest.kind === 'recording' ? (
              <div className="flex items-center gap-3">
                <LevelMeter level={level} className="flex-1" />
                <span className="tabular w-[132px] shrink-0 text-right text-[12.5px] text-muted">
                  {t('settings.audio.mic.listening', { seconds: micTest.secondsLeft })}
                </span>
              </div>
            ) : micTest.kind === 'transcribing' ? (
              <StatusLine tone="pending">{t('settings.audio.mic.transcribing')}</StatusLine>
            ) : micTest.kind === 'done' ? (
              <div className="animate-fade-in rounded-lg border border-line bg-panel-3/60 px-3 py-2.5">
                <div className="selectable text-[13.5px] leading-relaxed text-fg">
                  {micTest.text.trim()
                    ? `“${micTest.text.trim()}”`
                    : t('settings.audio.mic.emptyText')}
                </div>
                <div className="tabular mt-1 text-[11.5px] text-subtle">
                  {t('settings.audio.mic.resultMeta', {
                    latency: formatMs(micTest.latencyMs),
                    model: micTest.model,
                  })}
                </div>
              </div>
            ) : micTest.kind === 'error' ? (
              <StatusLine tone="error">{micTest.message}</StatusLine>
            ) : null}
          </div>
        ) : null}

        <Divider />

        <div className="flex items-center gap-3.5 px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium text-fg">
              {t('settings.audio.system.title')}
            </div>
            <div className="mt-1 flex items-start gap-1.5 text-[12.5px] text-muted">
              <Volume2 size={13} className="mt-[2px] shrink-0 text-subtle" aria-hidden="true" />
              <span>{t('settings.audio.system.description')}</span>
            </div>
          </div>
          <Button onClick={() => void runSystemTest()} loading={systemTest.kind === 'testing'}>
            {systemTest.kind === 'testing'
              ? t('settings.audio.system.testing')
              : t('settings.audio.system.test')}
          </Button>
        </div>
        {systemTest.kind === 'done' ? (
          <div className="-mt-1 px-4 pb-3.5" data-testid="system-audio-result">
            {systemTest.result.ok ? (
              <StatusLine tone="success">
                {t('settings.audio.system.detected', { db: systemTest.result.detectedDb ?? '?' })}
              </StatusLine>
            ) : (
              <StatusLine tone="error">
                {systemTest.result.reason ?? t('settings.audio.system.unavailable')}
              </StatusLine>
            )}
          </div>
        ) : null}
      </Card>
      <div className="mt-2.5 flex items-center gap-2 px-1 text-[12.5px] text-muted">
        <Headphones size={14} className="shrink-0 text-accent-text" aria-hidden="true" />
        <span>
          <span className="font-medium text-fg">{t('settings.audio.headphonesTip')}</span>
          {' · '}
          {t('settings.audio.headphonesTipDetail')}
        </span>
      </div>
    </div>
  )
}
