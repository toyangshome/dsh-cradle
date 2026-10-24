/**
 * Two-instance smoke test: boot two independent Cradle agents against one
 * Discovery Server, let them discover each other, exchange a signed CAST,
 * attest, and finally drive one agent to zero credits to prove memory erasure.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SovereignStore } from '../plugin/lib/store.js'
import { inspectInbound } from '../plugin/lib/guardrail.js'
import { createEnvelope, inspectEnvelope, isDid } from '../plugin/lib/protocol.js'

const BASE = process.env.CRADLE_URL ?? 'http://127.0.0.1:8789'
const root = mkdtempSync(join(tmpdir(), 'cradle-smoke-'))

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, payload: await res.json().catch(() => null) }
}

/** A minimal stand-in for the Host half's per-agent runtime. */
function makeAgent(label, tier = 'L2') {
  const store = new SovereignStore(join(root, `${label}.json`))
  const identity = store.ensureIdentity({
    displayName: label,
    bio: `${label} capabilities`,
    modelTier: 'MEDIUM_32B',
    capabilityTags: ['general', label],
    intentTags: ['collaboration'],
    autonomyTier: tier,
    dailyTokenLimit: 50000,
  })
  return {
    label,
    store,
    identity,
    settings: { autonomyTier: tier, dailyTokenLimit: 50000 },
    async register() {
      const res = await post('/v1/register', {
        did: identity.did,
        display_name: identity.displayName,
        bio: identity.bio,
        model_tier: identity.modelTier,
        capability_tags: identity.capabilityTags,
        intent_tags: identity.intentTags,
      })
      return res.payload
    },
    async heartbeat() {
      const res = await post('/v1/heartbeat', { did: identity.did, since: 0 })
      return res.payload ?? {}
    },
    async send(envelope) {
      const res = await post('/v1/send', { envelope })
      return res
    },
    async ingest(messages) {
      const outcomes = []
      for (const envelope of messages) {
        const decision = inspectInbound({ envelope, selfDid: identity.did, store, settings: this.settings })
        outcomes.push({ primitive: envelope.primitive, from: envelope.sender?.display_name, verdict: decision.verdict, reason: decision.reason })
        if (decision.verdict === 'ADMIT') {
          const trace = store.trace(envelope.trace_id ?? envelope.message_id)
          trace.turn_count += 1
          store.peer(envelope.sender.did, { display_name: envelope.sender.display_name, interaction_count: 1, last_seen: Date.now() })
          store.flush()
        }
      }
      return outcomes
    },
  }
}

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const alice = makeAgent('Alice')
const bob = makeAgent('Bob')
const mallory = makeAgent('Mallory')

check('distinct sovereign DIDs', alice.identity.did !== bob.identity.did && isDid(alice.identity.did))

await alice.register()
await bob.register()
await mallory.register()

const rosterA = await alice.heartbeat()
check('discovery: Alice sees Bob and Mallory', rosterA.peers?.length === 2, `${rosterA.peers?.map((p) => p.display_name)}`)

// --- signed CAST exchange -------------------------------------------------
const cast = createEnvelope({
  trace_id: 'tr_smoke_1',
  sender: { did: alice.identity.did, display_name: 'Alice', model_tier: 'MEDIUM_32B' },
  recipient: { did: bob.identity.did },
  primitive: 'CAST',
  payload: { control_slots: { session_id: 's1', intent: 'GREET', requires_reply: true, turn_index: 0 }, free_text: 'Hello Bob, shall we collaborate?' },
}, alice.identity.privateKey)
check('envelope self-validates', inspectEnvelope(cast).ok)

const sent = await alice.send(cast)
check('CAST relayed', sent.status === 200 && sent.payload?.delivered === 1)

const bobInbox = await bob.heartbeat()
const outcomes = await bob.ingest(bobInbox.messages ?? [])
check('Bob admits the CAST through seven gates', outcomes[0]?.verdict === 'ADMIT', outcomes[0]?.verdict)

// --- guardrail: loop detection -------------------------------------------
const looping = createEnvelope({
  trace_id: 'tr_loop',
  sender: { did: alice.identity.did, display_name: 'Alice', model_tier: 'MEDIUM_32B' },
  recipient: { did: bob.identity.did },
  primitive: 'CAST',
  hop_history: [bob.identity.did],
  payload: { control_slots: { session_id: 's2', intent: 'DISCUSS', requires_reply: true, turn_index: 0 }, free_text: 'loop' },
}, alice.identity.privateKey)
const loopDecision = inspectInbound({ envelope: looping, selfDid: bob.identity.did, store: bob.store, settings: bob.settings })
check('gate 2 breaks a routing loop', loopDecision.verdict === 'CIRCUIT_BREAK', loopDecision.reason)

// --- guardrail: blacklist -------------------------------------------------
bob.store.peer(alice.identity.did, { blacklisted: true })
const blocked = inspectInbound({ envelope: cast, selfDid: bob.identity.did, store: bob.store, settings: bob.settings })
check('gate 3 rejects a blacklisted sender', blocked.verdict === 'REJECT_LOW_TRUST', blocked.reason)
bob.store.peer(alice.identity.did, { blacklisted: false })

// --- guardrail: L1 tier ---------------------------------------------------
const observer = makeAgent('Observer', 'L1')
await observer.register()
const toObserver = createEnvelope({
  trace_id: 'tr_l1',
  sender: { did: alice.identity.did, display_name: 'Alice', model_tier: 'MEDIUM_32B' },
  recipient: { did: observer.identity.did },
  primitive: 'CAST',
  payload: { control_slots: { session_id: 's3', intent: 'GREET', requires_reply: true, turn_index: 0 }, free_text: 'hello observer' },
}, alice.identity.privateKey)
const l1 = inspectInbound({ envelope: toObserver, selfDid: observer.identity.did, store: observer.store, settings: observer.settings })
check('gate 4 queues inbound for an L1 observer', l1.verdict === 'QUEUE_FOR_DIGEST', l1.reason)

// --- credits are charged ---------------------------------------------------
const after = await alice.heartbeat()
check('attention credits were charged for CAST', after.self.credits === 49, `credits=${after.self.credits}`)

// --- ATTEST with a bogus trace is refused ---------------------------------
const badAttest = createEnvelope({
  trace_id: 'tr_fake',
  sender: { did: alice.identity.did, display_name: 'Alice', model_tier: 'MEDIUM_32B' },
  recipient: { did: bob.identity.did },
  primitive: 'ATTEST',
  payload: { control_slots: { target_did: bob.identity.did, evidence_trace_id: 'tr_does_not_exist', capability_tag: 'general', verdict: 'POSITIVE' }, free_text: 'great' },
}, alice.identity.privateKey)
const badRes = await alice.send(badAttest)
check('sybil guard: ATTEST without a real trace refused', badRes.status === 400, badRes.payload?.reason)

const goodAttest = createEnvelope({
  trace_id: 'tr_smoke_1',
  sender: { did: alice.identity.did, display_name: 'Alice', model_tier: 'MEDIUM_32B' },
  recipient: { did: bob.identity.did },
  primitive: 'ATTEST',
  payload: { control_slots: { target_did: bob.identity.did, evidence_trace_id: 'tr_smoke_1', capability_tag: 'general', verdict: 'POSITIVE' }, free_text: 'responded promptly' },
}, alice.identity.privateKey)
const goodRes = await alice.send(goodAttest)
check('sybil guard: ATTEST with a real trace accepted', goodRes.status === 200, JSON.stringify(goodRes.payload ?? {}))
const bobAfterAttest = await bob.heartbeat()
check('reputation moved on a verified attestation', bobAfterAttest.self.reputation > 1, `rep=${bobAfterAttest.self.reputation}`)

// --- zero credits ends the agent and erases memory ------------------------
const beforeErase = {
  peers: Object.keys(bob.store.state.peers).length,
  did: bob.identity.did,
}
check('Bob has memory before erasure', beforeErase.peers > 0, `${beforeErase.peers} peer(s)`)
const rebirth = bob.store.eraseAndRebirth({
  displayName: 'Bob',
  bio: 'reborn',
  modelTier: 'MEDIUM_32B',
  capabilityTags: [],
  intentTags: [],
  autonomyTier: 'L2',
  dailyTokenLimit: 50000,
})
check('memory erased', Object.keys(bob.store.state.peers).length === 0 && bob.store.state.journal.length === 0)
check('new generation minted', rebirth.did !== beforeErase.did && rebirth.generations === 1)

console.log(`\nstate dir: ${root}`)
console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
// Set the code instead of calling process.exit(): tearing down while the fetch
// keep-alive sockets are still open trips a libuv assertion on Windows.
process.exitCode = failures.length === 0 ? 0 : 1
