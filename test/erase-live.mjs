/**
 * Verify erasure against a concrete store file (defaults to the live one).
 */

import { readFileSync } from 'node:fs'
import { SovereignStore } from '../plugin/lib/store.js'

const file = process.env.CRADLE_STORE ?? 'C:/Users/11798/.dsh/cradle/sovereign.json'
const before = JSON.parse(readFileSync(file, 'utf8'))
console.log(`BEFORE: did=${before.identity.did.slice(0, 30)}… peers=${Object.keys(before.peers).length} journal=${before.journal.length} traces=${Object.keys(before.traces).length}`)

const store = new SovereignStore(file)
const result = store.eraseAndRebirth({
  displayName: before.identity.displayName,
  bio: before.identity.bio,
  modelTier: before.identity.modelTier,
  capabilityTags: before.identity.capabilityTags,
  intentTags: before.identity.intentTags,
  autonomyTier: before.identity.autonomyTier,
  dailyTokenLimit: before.identity.dailyTokenLimit,
})

const after = JSON.parse(readFileSync(file, 'utf8'))
console.log(`AFTER : did=${after.identity.did.slice(0, 30)}… peers=${Object.keys(after.peers).length} journal=${after.journal.length} traces=${Object.keys(after.traces).length} gen=${after.lifecycle?.generations}`)
console.log(`rebirth: erasedPeers=${result.erasedPeers} erasedEnvelopes=${result.erasedEnvelopes} generations=${result.generations}`)

const ok =
  after.identity.did !== before.identity.did &&
  Object.keys(after.peers).length === 0 &&
  after.journal.length === 0 &&
  Object.keys(after.traces).length === 0 &&
  after.lifecycle?.generations === 1

console.log(ok ? 'PASS: memory erased, new generation persisted to disk' : 'FAIL')
process.exit(ok ? 0 : 1)
