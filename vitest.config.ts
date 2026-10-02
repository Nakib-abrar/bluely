import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer'),
      // Unit tests never touch real Electron APIs; main-process modules that import
      // 'electron' get a small stub instead.
      electron: resolve(__dirname, 'tests/stubs/electron.ts'),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['**/node_modules/**', '.claude/**'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 15000,
    restoreMocks: true,
  },
})
