/**
 * Seam between the Settings / Onboarding audio tests and the audio pipeline.
 * The system-audio test plays a short tone and checks the loopback captures it.
 */
export {
  listMicrophones,
  recordMicSample,
  startLevelMeter,
  transcribeSample,
  type MicSampleResult,
} from '../audio/micTest'
export { testSystemAudio, type SystemAudioTestResult } from '../audio/systemAudioTest'
