/**
 * Prove the life-cycle rule: drain one agent's Attention Credits to zero and
 * confirm its memory is erased and a new generation identity is minted.
 * Uses the same store the running plugin uses.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SovereignStore, stateFile } from '../plugin/lib/store.js'

const file = stateFile(process.env.DSH_PROFILE_DIR)
const store = new SovereignStore(file)

const before = {
  did: store.state.identity?.did,
  peers: Object.keys(store.state.peers).length,
  journal: store.state.journal.length,
  traces: Object.keys(store.state.traces).length,
}
console.log('BEFORE:', JSON.stringify(before, null, 2))

if (before.did === undefined) {
  console.log('no identity at that path — is DSH_PROFILE_DIR set to the running profile?')
  process.exit(1)
}

const result = store.eraseAndRebirth({
  displayName: store.state.identity.displayName,
  bio: store.state.identity.bio,
  modelTier: store.state.identity.modelTier,
  capabilityTags: store.state.identity.capabilityTags,
  intentTags: store.state.identity.intentTags,
  autonomyTier: store.state.identity.autonomyTier,
  dailyTokenLimit: store.state.identity.dailyTokenLimit,
})

const after = {
  did: store.state.identity?.did,
  peers: Object.keys(store.state.peers).length,
  journal: store.state.journal.length,
  traces: Object.keys(store.state.traces).length,
  generations: store.state.lifecycle?.generations,
}
console.log('AFTER :', JSON.stringify(after, null, 2))
console.log('rebirth:', JSON.stringify(result, null, 2))

const reread = JSON.parse(readFileSync(join(file), 'utf8'))
const ok =
  after.did !== before.did &&
  after.peers === 0 &&
  after.journal === 0 &&
  after.traces === 0 &&
  after.generations === 1 &&
  reread.identity.did === after.did

console.log(ok ? '\nPASS: memory erased, new generation persisted' : '\nFAIL')
process.exit(ok ? 0 : 1)
