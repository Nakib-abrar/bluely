import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

/** Vite's dev server needs inline scripts (React refresh) and a websocket; production keeps the strict CSP. */
function devCsp(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws://localhost:* http://localhost:* blob: data:",
    "media-src 'self' blob: mediastream:",
    "worker-src 'self' blob:",
    "object-src 'none'",
  ].join('; ')
  return {
    name: 'bluely-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
        `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      )
    },
  }
}

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@main': resolve(__dirname, 'src/main'),
  '@renderer': resolve(__dirname, 'src/renderer'),
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      // Sandboxed preloads cannot require() third-party modules, so bundle everything.
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    publicDir: resolve(__dirname, 'src/renderer/public'),
    resolve: { alias },
    plugins: [react(), tailwindcss(), devCsp()],
    worker: { format: 'es' },
    build: {
      target: 'chrome140',
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/renderer/main/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
          // Dev-only audio test page (tests/e2e/audio.spec.ts); never part of a normal build.
          ...(process.env['BLUELY_HARNESS'] === '1'
            ? { harness: resolve(__dirname, 'src/renderer/harness/index.html') }
            : {}),
        },
      },
    },
  },
})
