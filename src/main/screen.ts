import { desktopCapturer, type Display } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OVERLAY, SCREEN_CAPTURE } from '@shared/constants'
import { AppError } from './errors'
import type { OverlayController } from './windows/overlayWindow'

export interface Screenshot {
  /** "data:image/jpeg;base64,…" — kept in memory only unless the user opted in to saving. */
  dataUrl: string
  width: number
  height: number
  bytes: number
  capturedAt: number
}

/**
 * Captures the display the overlay is on. The overlay is hidden for ~120 ms first so it never
 * appears in its own screenshot. Downscaled to ≤ 1600 px wide, JPEG q=80.
 */
export async function captureScreen(overlay: OverlayController): Promise<Screenshot> {
  const display: Display = overlay.currentDisplay()
  const scale = display.scaleFactor || 1
  const fullWidth = Math.round(display.size.width * scale)
  const fullHeight = Math.round(display.size.height * scale)
  const targetWidth = Math.min(SCREEN_CAPTURE.maxWidth, fullWidth)
  const targetHeight = Math.round((fullHeight * targetWidth) / fullWidth)

  const sources = await overlay.withHidden(
    () =>
      desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: targetWidth, height: targetHeight },
      }),
    OVERLAY.hideForCaptureMs,
  )
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!source || source.thumbnail.isEmpty()) {
    throw new AppError('screen_unavailable', 'Could not capture the screen.')
  }
  let image = source.thumbnail
  const size = image.getSize()
  if (size.width > SCREEN_CAPTURE.maxWidth) {
    image = image.resize({ width: SCREEN_CAPTURE.maxWidth, quality: 'good' })
  }
  const jpeg = image.toJPEG(SCREEN_CAPTURE.jpegQuality)
  const finalSize = image.getSize()
  return {
    dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    width: finalSize.width,
    height: finalSize.height,
    bytes: jpeg.byteLength,
    capturedAt: Date.now(),
  }
}

/** Only called when Settings › Privacy › "Save screenshots with sessions" is on (default off). */
export function saveScreenshot(
  dir: string,
  sessionId: string | null,
  id: string,
  shot: Screenshot,
): string {
  const folder = join(dir, sessionId ?? 'no-session')
  mkdirSync(folder, { recursive: true })
  const file = join(folder, `${id}.jpg`)
  const base64 = shot.dataUrl.slice(shot.dataUrl.indexOf(',') + 1)
  writeFileSync(file, Buffer.from(base64, 'base64'))
  return file
}
