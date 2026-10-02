// Runs Vitest inside Electron's bundled Node (ELECTRON_RUN_AS_NODE=1) so native
// modules such as better-sqlite3 load with the same ABI the app uses.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const vitestBin = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')

const child = spawn(electronPath, [vitestBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
