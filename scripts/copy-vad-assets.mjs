// Copies the Silero VAD model and the onnxruntime-web WASM runtime into the
// renderer's public folder so they are served locally (no CDN, CSP-safe).
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'src', 'renderer', 'public', 'vad')
mkdirSync(outDir, { recursive: true })

const vadDir = join(root, 'node_modules', '@ricky0123', 'vad-web')
const ortDir = join(root, 'node_modules', 'onnxruntime-web')

const files = [
  [join(vadDir, 'dist', 'silero_vad_v5.onnx'), 'silero_vad_v5.onnx'],
  [join(ortDir, 'dist', 'ort-wasm-simd-threaded.wasm'), 'ort-wasm-simd-threaded.wasm'],
  [join(ortDir, 'dist', 'ort-wasm-simd-threaded.mjs'), 'ort-wasm-simd-threaded.mjs'],
]

for (const [from, name] of files) {
  if (!existsSync(from)) {
    console.error(`[copy-vad-assets] missing ${from}`)
    process.exit(1)
  }
  copyFileSync(from, join(outDir, name))
}
console.log(`[copy-vad-assets] copied ${files.length} files to ${outDir}`)
