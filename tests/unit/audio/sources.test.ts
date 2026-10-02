import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AudioSourceError,
  LoopbackSource,
  MicSource,
  micConstraints,
  toAudioSourceError,
} from '@renderer/audio/sources'

class FakeTrack {
  stopped = false
  settings: MediaTrackSettings = {}
  applied: MediaTrackConstraints[] = []
  constructor(readonly kind: 'audio' | 'video') {}
  stop() {
    this.stopped = true
  }
  getSettings() {
    return this.settings
  }
  async applyConstraints(c: MediaTrackConstraints) {
    this.applied.push(c)
    this.settings = { ...this.settings, ...(c as MediaTrackSettings) }
  }
}

class FakeStream {
  constructor(public tracks: FakeTrack[]) {}
  getTracks() {
    return [...this.tracks]
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio')
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video')
  }
  removeTrack(track: FakeTrack) {
    this.tracks = this.tracks.filter((t) => t !== track)
  }
}

function stubMediaDevices(devices: Partial<MediaDevices>) {
  vi.stubGlobal('navigator', { mediaDevices: devices })
}

const domError = (name: string) => new DOMException(`${name} happened`, name)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('toAudioSourceError', () => {
  it('maps getUserMedia errors to codes', () => {
    expect(toAudioSourceError(domError('NotFoundError'), 'mic').code).toBe('mic_not_found')
    expect(toAudioSourceError(domError('OverconstrainedError'), 'mic').code).toBe('mic_not_found')
    expect(toAudioSourceError(domError('NotAllowedError'), 'mic').code).toBe('mic_denied')
    expect(toAudioSourceError(domError('SecurityError'), 'mic').code).toBe('mic_denied')
    expect(toAudioSourceError(domError('NotReadableError'), 'mic').code).toBe('unknown')
    expect(toAudioSourceError('weird', 'mic').code).toBe('unknown')
    expect(toAudioSourceError(domError('NotAllowedError'), 'loopback').code).toBe(
      'loopback_unavailable',
    )
    const original = new AudioSourceError('mic_muted', 'muted')
    expect(toAudioSourceError(original, 'loopback')).toBe(original)
    const mapped = toAudioSourceError(domError('NotFoundError'), 'mic')
    expect(mapped).toBeInstanceOf(Error)
    expect(mapped.name).toBe('AudioSourceError')
    expect(mapped.cause).toBeInstanceOf(DOMException)
  })
})

describe('MicSource', () => {
  it('requests AEC/NS/AGC and an exact device when one is chosen', () => {
    expect(micConstraints(null)).toEqual({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    })
    expect(micConstraints('abc')).toEqual({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        deviceId: { exact: 'abc' },
      },
      video: false,
    })
  })

  it('opens the mic and stops its tracks', async () => {
    const track = new FakeTrack('audio')
    const getUserMedia = vi.fn(async () => new FakeStream([track]) as unknown as MediaStream)
    stubMediaDevices({ getUserMedia })
    const source = new MicSource('dev-1')
    expect(source.kind).toBe('mic')
    const stream = await source.start()
    expect(stream.getAudioTracks()).toHaveLength(1)
    expect(getUserMedia).toHaveBeenCalledWith(micConstraints('dev-1'))
    source.stop()
    expect(track.stopped).toBe(true)
    source.stop() // idempotent
  })

  it('throws typed errors', async () => {
    stubMediaDevices({
      getUserMedia: vi.fn(async () => {
        throw domError('OverconstrainedError')
      }),
    })
    await expect(new MicSource('gone').start()).rejects.toMatchObject({ code: 'mic_not_found' })

    stubMediaDevices({
      getUserMedia: vi.fn(async () => new FakeStream([]) as unknown as MediaStream),
    })
    await expect(new MicSource(null).start()).rejects.toMatchObject({ code: 'mic_not_found' })
  })
})

describe('LoopbackSource', () => {
  it('keeps only the audio track and stops the screen video immediately', async () => {
    const audio = new FakeTrack('audio')
    const video = new FakeTrack('video')
    const getDisplayMedia = vi.fn(
      async () => new FakeStream([video, audio]) as unknown as MediaStream,
    )
    stubMediaDevices({ getDisplayMedia })
    const source = new LoopbackSource()
    expect(source.kind).toBe('loopback')
    const stream = await source.start()
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
    expect(video.stopped).toBe(true)
    expect(stream.getVideoTracks()).toHaveLength(0)
    expect(stream.getAudioTracks()).toEqual([audio])
    source.stop()
    expect(audio.stopped).toBe(true)
  })

  it('switches voice processing off on the track if Chromium ignored the constraints', async () => {
    const audio = new FakeTrack('audio')
    audio.settings = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    stubMediaDevices({
      getDisplayMedia: vi.fn(async () => new FakeStream([audio]) as unknown as MediaStream),
    })
    await new LoopbackSource().start()
    expect(audio.applied).toEqual([
      { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    ])

    const clean = new FakeTrack('audio')
    clean.settings = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    stubMediaDevices({
      getDisplayMedia: vi.fn(async () => new FakeStream([clean]) as unknown as MediaStream),
    })
    await new LoopbackSource().start()
    expect(clean.applied).toEqual([])
  })

  it('reports loopback_unavailable without an audio track or on failure', async () => {
    const video = new FakeTrack('video')
    stubMediaDevices({
      getDisplayMedia: vi.fn(async () => new FakeStream([video]) as unknown as MediaStream),
    })
    await expect(new LoopbackSource().start()).rejects.toMatchObject({
      code: 'loopback_unavailable',
    })
    expect(video.stopped).toBe(true)

    stubMediaDevices({
      getDisplayMedia: vi.fn(async () => {
        throw domError('NotAllowedError')
      }),
    })
    await expect(new LoopbackSource().start()).rejects.toBeInstanceOf(AudioSourceError)
  })
})
