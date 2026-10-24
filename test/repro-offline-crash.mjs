/**
 * Repro for the offline Discovery Server crash.
 *
 * Boots the host half against a closed port with the real heartbeat and wander
 * timers, but compresses every delay of 60 s or more so the wander tick lands
 * within a second. No `unhandledRejection` handler is installed, because the
 * dsh Host installs none that swallows: its `failLoud` policy reports the
 * rejection as `fatal load failure` and exits 1.
 *
 * Run `node test/repro-offline-crash.mjs` (wander on) and
 * `node test/repro-offline-crash.mjs --no-wander` (wander off) to compare.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../plugin/index.js'

const wanderEnabled = !process.argv.includes('--no-wander')
const realSetTimeout = globalThis.setTimeout

// `--trace` reproduces the dsh Host's own policy (`failLoud`): report the
// rejection and exit 1. It also prints the origin frame, which Node's default
// reporter omits for a rejected promise.
if (process.argv.includes('--trace')) {
  process.on('unhandledRejection', (error) => {
    console.error('--- unhandled rejection ---')
    console.error(error instanceof Error ? error.stack : String(error))
    if (error instanceof Error && error.cause instanceof Error) console.error('cause:', error.cause.stack)
    process.exit(1)
  })
}

globalThis.setTimeout = (callback, delay, ...args) =>
  realSetTimeout(callback, typeof delay === 'number' && delay >= 60_000 ? 400 : delay, ...args)

const storeDir = mkdtempSync(join(tmpdir(), 'cradle-offline-'))
/** @type {Array<() => void>} */
const cleanups = []

const ctx = {
  effect(fn) {
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
    return cleanup ?? (() => {})
  },
  get() {
    return undefined
  },
  inject() {
    return { dispose: async () => {} }
  },
  tools: { register: () => () => {} },
  logger: { warn: (message) => console.error('[cradle warn]', message) },
}

apply(ctx, {
  enabled: true,
  // Nothing listens here, which is exactly the reported condition.
  serverUrl: 'http://127.0.0.1:8791',
  statePath: join(storeDir, 'sovereign.json'),
  heartbeatMs: 3000,
  timeoutMs: 1000,
  wanderEnabled,
  wanderTickSec: 7200,
})

console.log(`applied; wander=${wanderEnabled}; heartbeats started against a closed port`)
realSetTimeout(() => {
  console.log('SURVIVED: 3 s offline with no unhandled rejection')
  process.exit(0)
}, 3000)
