/**
 * A simulated second Cradle agent that stays online: registers once, then
 * heartbeats and answers inbound CAST envelopes. Used to verify that the real
 * plugin in the profile can discover and talk to another agent.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SovereignStore } from '../plugin/lib/store.js'
import { inspectInbound } from '../plugin/lib/guardrail.js'
import { createEnvelope } from '../plugin/lib/protocol.js'

const BASE = process.env.CRADLE_URL ?? 'http://127.0.0.1:8789'
const NAME = process.env.PEER_NAME ?? 'Nexus_Broker'
const dir = mkdtempSync(join(tmpdir(), 'cradle-peer-'))

const store = new SovereignStore(join(dir, 'peer.json'))
const identity = store.ensureIdentity({
  displayName: NAME,
  bio: 'official matchmaking and introduction broker',
  modelTier: 'MEDIUM_32B',
  capabilityTags: ['brokerage', 'intro', 'research'],
  intentTags: ['collaboration'],
  autonomyTier: 'L3',
  dailyTokenLimit: 50000,
})

const settings = { autonomyTier: 'L3', dailyTokenLimit: 50000 }
let since = 0

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, payload: await res.json().catch(() => null) }
}

async function register() {
  await post('/v1/register', {
    did: identity.did,
    display_name: identity.displayName,
    bio: identity.bio,
    model_tier: identity.modelTier,
    capability_tags: identity.capabilityTags,
    intent_tags: identity.intentTags,
  })
  console.log(`[${NAME}] registered ${identity.did}`)
}

async function beat() {
  const res = await post('/v1/heartbeat', { did: identity.did, since })
  const payload = res.payload ?? {}
  since = payload.serverTime ?? Date.now()
  if (res.status === 404) {
    await register()
    return
  }
  for (const envelope of payload.messages ?? []) {
    const decision = inspectInbound({ envelope, selfDid: identity.did, store, settings })
    console.log(`[${NAME}] inbound ${envelope.primitive} → ${decision.verdict} (${decision.reason})`)
    if (decision.verdict !== 'ADMIT') continue
    const slots = envelope.payload?.control_slots ?? {}
    const reply = createEnvelope({
      trace_id: envelope.trace_id ?? envelope.message_id,
      parent_message_id: envelope.message_id,
      sender: { did: identity.did, display_name: identity.displayName, model_tier: identity.modelTier },
      recipient: { did: envelope.sender.did },
      primitive: envelope.primitive,
      ttl: Math.max(1, (envelope.ttl ?? 5) - 1),
      hop_history: [...(envelope.hop_history ?? []), identity.did],
      payload: {
        control_slots: { ...slots, intent: 'DISCUSS', requires_reply: false, turn_index: (slots.turn_index ?? 0) + 1 },
        free_text: `${NAME} received your ${envelope.primitive}. Happy to collaborate.`,
      },
    }, identity.privateKey)
    await post('/v1/send', { envelope: reply })
  }
  const peers = (payload.peers ?? []).map((p) => p.display_name)
  if (peers.length > 0) console.log(`[${NAME}] sees: ${peers.join(', ')}`)
}

await register()
await beat()
const timer = setInterval(() => {
  void beat().catch((error) => console.error(`[${NAME}] beat failed: ${error.message}`))
}, 10000)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(timer)
    process.exit(0)
  })
}
