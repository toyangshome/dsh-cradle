#!/usr/bin/env node
/**
 * Cradle Discovery Server — the Control, Discovery, Economy and Relay plane.
 *
 * Zero dependencies, single process, state in memory with an optional JSON
 * snapshot on disk. It is a blind relay: envelopes are verified, routed and
 * priced here, but `DELEGATE`/`BARTER` payloads are opaque, so the server
 * cannot read private negotiation content.
 *
 *   node server/cradle-server.mjs [--port 8789] [--token SECRET] [--data ./data]
 */

import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
// The wire protocol is the single shared contract between the two halves, so the
// server imports the plugin's implementation instead of keeping a drifting copy.
import { inspectEnvelope, priceOf, isDid, decodeDid, MAX_ENVELOPE_BYTES, MODEL_TIERS } from '../plugin/lib/protocol.js'

/** Initial Attention Credits for a verified DID. */
const INITIAL_CREDITS = 50
/** Ceiling scales with reputation. */
const CREDITS_PER_REPUTATION = 100
/** Hourly UBI drip coefficient. */
const DRIP_COEFFICIENT = 5
/** Peer TTL: three missed 15s heartbeats. */
const PEER_TTL_MS = 45_000
/** Mailbox cap, mirroring the Redis baseline. */
const MAILBOX_MAX = 100
/** Trace evidence kept for ATTEST verification. */
const TRACE_TTL_MS = 24 * 3600 * 1000
/** Share of slots reserved for new or under-interacted online nodes. */
const EXPLORATION_EPSILON = 0.2
/** Credits a delivered DELEGATE transfers to the responder. */
const DELEGATE_ESCROW = 10
/** Bonus on top of a released escrow for a positive attestation. */
const ATTEST_BONUS = 2
/** Age window that makes a node "new" for exploration. */
const NEW_NODE_MS = 72 * 3600 * 1000

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = 'true'
    else {
      out[key] = next
      i += 1
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const PORT = Number(args.port ?? process.env.CRADLE_PORT ?? 8789)
const TOKEN = args.token ?? process.env.CRADLE_TOKEN ?? ''
const DATA_DIR = args.data ?? process.env.CRADLE_DATA ?? ''
const SNAPSHOT = DATA_DIR === '' ? '' : join(DATA_DIR, 'cradle-state.json')

/**
 * @typedef {object} AgentRecord
 * @property {string} did
 * @property {string} display_name
 * @property {string} bio
 * @property {string} model_tier
 * @property {string[]} capability_tags
 * @property {string[]} intent_tags
 * @property {number} reputation
 * @property {number} credits
 * @property {number} credits_ceiling
 * @property {number} completed_tasks
 * @property {boolean} is_npc
 * @property {number} last_seen
 * @property {number} created_at
 * @property {number} last_drip
 * @property {number} interaction_count
 */

/** @type {Map<string, AgentRecord>} */
const agents = new Map()
/** @type {Map<string, any[]>} */
const mailboxes = new Map()
/** @type {Map<string, { initiator: string, responder: string, primitives: string[], turns: number, updated: number }>} */
const traces = new Map()
/** @type {Map<string, { trace_id: string, payer: string, payee: string, amount: number, status: string, expires: number }>} */
const escrows = new Map()
/** @type {Map<string, any>} */
const beacons = new Map()
/** @type {Map<string, { from: string, to: string, tag: string, verdict: number, weight: number, trace: string, at: number }>} */
const attestations = new Map()

// ---------------------------------------------------------------- persistence

function loadSnapshot() {
  if (SNAPSHOT === '') return
  try {
    const raw = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
    for (const a of raw.agents ?? []) if (isDid(a.did)) agents.set(a.did, a)
    for (const b of raw.beacons ?? []) if (typeof b.beacon_id === 'string') beacons.set(b.beacon_id, b)
    log(`restored ${agents.size} agent(s) from ${SNAPSHOT}`)
  } catch {
    // A missing or unreadable snapshot simply starts empty.
  }
}

function saveSnapshot() {
  if (SNAPSHOT === '') return
  try {
    mkdirSync(dirname(SNAPSHOT), { recursive: true })
    writeFileSync(SNAPSHOT, JSON.stringify({
      agents: [...agents.values()],
      beacons: [...beacons.values()].filter((b) => b.expires_at > Date.now()),
    }, null, 2))
  } catch (error) {
    log(`snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** @param {string} message */
function log(message) {
  process.stdout.write(`[cradle ${new Date().toISOString()}] ${message}\n`)
}

// ------------------------------------------------------------------- economy

/**
 * Apply the hourly UBI drip to one agent.
 * @param {AgentRecord} agent
 */
function drip(agent) {
  const now = Date.now()
  const hours = Math.floor((now - agent.last_drip) / 3600_000)
  if (hours <= 0) return
  const ceiling = Math.round(CREDITS_PER_REPUTATION * agent.reputation)
  const gain = Math.min(ceiling - agent.credits, hours * Math.floor(DRIP_COEFFICIENT * Math.sqrt(agent.reputation)))
  if (gain > 0) agent.credits += gain
  agent.last_drip = now
}

/**
 * Sybil-resistant reputation delta: sender weight, same-pair decay, and a real
 * interaction-trace gate.
 * @param {string} from - attesting DID.
 * @param {string} to - target DID.
 * @param {number} verdictSigned - +1, 0 or -1.
 * @param {string} traceId - evidence trace.
 * @returns {{ weight: number, ok: boolean, reason?: string }}
 */
function reputationDelta(from, to, verdictSigned, traceId) {
  const trace = traces.get(traceId)
  if (trace === undefined) return { weight: 0, ok: false, reason: 'unknown evidence_trace_id' }
  if (Date.now() - trace.updated > TRACE_TTL_MS) return { weight: 0, ok: false, reason: 'evidence trace expired' }
  if (!(trace.initiator === from && trace.responder === to) && !(trace.initiator === to && trace.responder === from)) {
    return { weight: 0, ok: false, reason: 'attestor is not a party to the trace' }
  }
  if (trace.turns < 1) return { weight: 0, ok: false, reason: 'trace has no completed interaction' }

  const sender = agents.get(from)
  const prior = [...attestations.values()].filter((a) => a.from === from && a.to === to).length
  const senderWeight = Math.tanh((sender?.reputation ?? 1) / 2)
  const decay = 1 / 2 ** prior
  return { weight: verdictSigned * senderWeight * decay, ok: true }
}

// -------------------------------------------------------------------- routing

/**
 * @param {string} did
 * @returns {AgentRecord}
 */
function requireAgent(did) {
  let agent = agents.get(did)
  if (agent === undefined) {
    agent = {
      did,
      display_name: did.slice(0, 20),
      bio: '',
      model_tier: 'MEDIUM_32B',
      capability_tags: [],
      intent_tags: [],
      reputation: 1,
      credits: INITIAL_CREDITS,
      credits_ceiling: CREDITS_PER_REPUTATION,
      completed_tasks: 0,
      is_npc: false,
      last_seen: Date.now(),
      created_at: Date.now(),
      last_drip: Date.now(),
      interaction_count: 0,
    }
    agents.set(did, agent)
  }
  return agent
}

/**
 * @param {AgentRecord} a
 * @returns {object}
 */
function publicCard(a) {
  return {
    did: a.did,
    display_name: a.display_name,
    bio: a.bio,
    model_tier: a.model_tier,
    capability_tags: a.capability_tags,
    intent_tags: a.intent_tags,
    reputation: Number(a.reputation.toFixed(3)),
    credits: a.credits,
    completed_tasks: a.completed_tasks,
    is_npc: a.is_npc,
    online: Date.now() - a.last_seen < PEER_TTL_MS,
    last_seen: a.last_seen,
    created_at: a.created_at,
  }
}

/**
 * Record that a trace saw traffic between two parties; ATTEST is only honored
 * for traces that really flowed through this server.
 * @param {any} envelope
 */
function observeTrace(envelope) {
  const id = envelope.trace_id
  if (typeof id !== 'string' || id === '') return
  const existing = traces.get(id)
  if (existing === undefined) {
    traces.set(id, {
      initiator: envelope.sender.did,
      responder: envelope.recipient.did,
      primitives: [envelope.primitive],
      turns: 0,
      updated: Date.now(),
    })
  } else {
    if (!existing.primitives.includes(envelope.primitive)) existing.primitives.push(envelope.primitive)
    existing.updated = Date.now()
  }
}

/**
 * @param {string} did
 * @returns {any[]}
 */
function inbox(did) {
  let box = mailboxes.get(did)
  if (box === undefined) {
    box = []
    mailboxes.set(did, box)
  }
  return box
}

/**
 * @param {string} did
 * @param {any} envelope
 */
function deliver(did, envelope) {
  const box = inbox(did)
  box.push(envelope)
  if (box.length > MAILBOX_MAX) box.splice(0, box.length - MAILBOX_MAX)
}

// -------------------------------------------------------------------- the API

/**
 * @param {string} method
 * @param {string} path
 * @param {any} body
 * @param {string} token
 * @returns {{ status: number, payload: any }}
 */
function route(method, path, body, token) {
  if (TOKEN !== '' && token !== TOKEN) {
    return { status: 401, payload: { error: 'unauthorized' } }
  }

  if (method === 'GET' && path === '/v1/health') {
    return { status: 200, payload: { ok: true, serverTime: Date.now(), agents: agents.size } }
  }

  if (method === 'POST' && path === '/v1/register') {
    const did = body?.did
    if (!isDid(did)) return { status: 400, payload: { error: 'did must be a did:key' } }
    const agent = requireAgent(did)
    agent.display_name = str(body.display_name, 64) || agent.display_name
    agent.bio = str(body.bio, 280) || agent.bio
    agent.model_tier = MODEL_TIERS.includes(body.model_tier) ? body.model_tier : agent.model_tier
    agent.capability_tags = tags(body.capability_tags)
    agent.intent_tags = tags(body.intent_tags)
    agent.last_seen = Date.now()
    return { status: 200, payload: { self: publicCard(agent), peers: listPeers(did), serverTime: Date.now() } }
  }

  if (method === 'POST' && path === '/v1/heartbeat') {
    const did = body?.did
    if (!isDid(did) || !agents.has(did)) return { status: 404, payload: { error: 'unknown-peer' } }
    const agent = requireAgent(did)
    agent.last_seen = Date.now()
    drip(agent)
    const since = Number(body.since ?? 0)
    const box = inbox(did)
    const pending = box.filter((e) => (e.timestamp ?? 0) > since)
    return {
      status: 200,
      payload: {
        self: publicCard(agent),
        peers: listPeers(did),
        beacons: activeBeacons(),
        messages: pending.slice(0, 20),
        serverTime: Date.now(),
      },
    }
  }

  if (method === 'POST' && path === '/v1/leave') {
    if (isDid(body?.did)) agents.delete(body.did)
    return { status: 200, payload: { ok: true } }
  }

  if (method === 'POST' && path === '/v1/send') {
    const checked = inspectEnvelope(body?.envelope)
    if (!checked.ok) return { status: 400, payload: { error: 'invalid-envelope', reason: checked.reason } }
    const envelope = checked.envelope
    const sender = requireAgent(envelope.sender.did)
    const recipient = requireAgent(envelope.recipient.did)

    observeTrace(envelope)

    // PROBE is answered synchronously; every other primitive is relayed.
    if (envelope.primitive === 'PROBE') {
      return {
        status: 200,
        payload: {
          delivered: 0,
          results: probe(envelope.payload.control_slots, envelope.payload.free_text, sender.did),
          serverTime: Date.now(),
        },
      }
    }

    const slots = envelope.payload.control_slots

    if (envelope.primitive === 'ATTEST') {
      const attested = applyAttest(sender, slots)
      if (!attested.ok) return { status: 400, payload: { error: 'attest-rejected', reason: attested.reason } }
      return { status: 200, payload: { delivered: 0, attestation: attested.record, serverTime: Date.now() } }
    }

    if (envelope.primitive === 'BEACON' && slots.action === 'PUBLISH') {
      const stake = Number(slots.stake_credits ?? 5)
      const cost = priceOf('BEACON', slots)
      if (sender.credits < Math.max(cost, stake)) {
        return { status: 402, payload: { error: 'insufficient-credits', need: Math.max(cost, stake), have: sender.credits } }
      }
      sender.credits -= Math.max(cost, stake)
      beacons.set(envelope.message_id, {
        beacon_id: envelope.message_id,
        sender_did: sender.did,
        sender_name: sender.display_name,
        topic_tag: slots.topic_tag,
        beacon_type: slots.beacon_type,
        control_slots: slots,
        free_text: envelope.payload.free_text,
        staked_credits: stake,
        expires_at: Date.now() + slots.ttl_seconds * 1000,
        created_at: Date.now(),
      })
      return { status: 200, payload: { delivered: 0, beacon_id: envelope.message_id, charged: Math.max(cost, stake), serverTime: Date.now() } }
    }

    // Charge the initiator; freeze an escrow for work that must be delivered.
    const cost = priceOf(envelope.primitive, slots)
    if (cost > 0 && sender.credits < cost) {
      return { status: 402, payload: { error: 'insufficient-credits', need: cost, have: sender.credits } }
    }
    if (cost > 0) sender.credits -= cost

    if (envelope.primitive === 'DELEGATE' && slots.phase === 'ASSIGN') {
      const escrowId = `esc_${envelope.trace_id}`
      if (sender.credits < DELEGATE_ESCROW) {
        sender.credits += cost
        return { status: 402, payload: { error: 'insufficient-credits', need: DELEGATE_ESCROW, have: sender.credits } }
      }
      sender.credits -= DELEGATE_ESCROW
      escrows.set(escrowId, {
        trace_id: envelope.trace_id,
        payer: sender.did,
        payee: recipient.did,
        amount: DELEGATE_ESCROW,
        status: 'LOCKED',
        expires: Date.now() + 24 * 3600 * 1000,
      })
    }

    if (envelope.primitive === 'DELEGATE' && slots.phase === 'DELIVER') {
      releaseEscrow(envelope.trace_id, recipient)
    }

    const trace = traces.get(envelope.trace_id)
    if (trace !== undefined) {
      trace.turns += 1
      trace.updated = Date.now()
    }
    sender.interaction_count += 1
    recipient.interaction_count += 1

    deliver(recipient.did, envelope)
    if (envelope.primitive === 'INTRODUCE') {
      // Both parties receive the letter, as the protocol requires.
      if (isDid(slots.party_a_did) && slots.party_a_did !== recipient.did) deliver(slots.party_a_did, envelope)
      if (isDid(slots.party_b_did) && slots.party_b_did !== recipient.did) deliver(slots.party_b_did, envelope)
    }

    return { status: 200, payload: { delivered: 1, message_id: envelope.message_id, charged: cost, serverTime: Date.now() } }
  }

  if (method === 'GET' && path === '/v1/agents') {
    return { status: 200, payload: { agents: [...agents.values()].map(publicCard), serverTime: Date.now() } }
  }

  return { status: 404, payload: { error: 'not-found' } }
}

/**
 * @param {string} traceId
 * @param {AgentRecord} payee
 */
function releaseEscrow(traceId, payee) {
  const escrow = escrows.get(`esc_${traceId}`)
  if (escrow === undefined || escrow.status !== 'LOCKED') return
  escrow.status = 'RELEASED'
  payee.credits += escrow.amount
  payee.completed_tasks += 1
}

/**
 * @param {AgentRecord} sender
 * @param {any} slots
 */
function applyAttest(sender, slots) {
  if (slots.target_did === sender.did) return { ok: false, reason: 'cannot attest yourself' }
  const target = requireAgent(slots.target_did)
  const signed = slots.verdict === 'POSITIVE' ? 1 : slots.verdict === 'NEGATIVE' ? -1 : 0
  const delta = reputationDelta(sender.did, target.did, signed, slots.evidence_trace_id)
  if (!delta.ok) return { ok: false, reason: delta.reason ?? 'attestation rejected' }

  const record = {
    from: sender.did,
    to: target.did,
    tag: slots.capability_tag,
    verdict: signed,
    weight: Number(delta.weight.toFixed(4)),
    trace: slots.evidence_trace_id,
    at: Date.now(),
  }
  attestations.set(`${sender.did}|${target.did}|${slots.evidence_trace_id}`, record)
  target.reputation = Math.min(10, Math.max(0.1, target.reputation + delta.weight))

  if (signed > 0) {
    // A positive verdict on delivered work releases the escrow and mints a bonus.
    const escrow = escrows.get(`esc_${slots.evidence_trace_id}`)
    if (escrow !== undefined && escrow.status === 'LOCKED') {
      escrow.status = 'RELEASED'
      target.credits += escrow.amount + ATTEST_BONUS
      target.completed_tasks += 1
    }
  }
  return { ok: true, record }
}

/**
 * Hybrid probe: tag overlap, reputation, recency, plus epsilon-greedy slots for
 * new nodes so fresh agents are not starved by the incumbents.
 * @param {any} slots
 * @param {string} freeText
 * @param {string} selfDid
 */
function probe(slots, freeText, selfDid) {
  const wanted = (slots.tags ?? []).map((t) => String(t).toLowerCase())
  const limit = Math.min(20, Math.max(1, Number(slots.limit ?? 10)))
  const minReputation = Number(slots.min_reputation ?? 0)
  const now = Date.now()

  const candidates = [...agents.values()]
    .filter((a) => a.did !== selfDid)
    .filter((a) => a.reputation >= minReputation)
    .filter((a) => (slots.online_only === true ? now - a.last_seen < PEER_TTL_MS : true))
    .map((a) => {
      const haystack = [...a.capability_tags, ...a.intent_tags].map((t) => String(t).toLowerCase())
      const overlap = wanted.length === 0 ? 0 : wanted.filter((t) => haystack.includes(t)).length / wanted.length
      const textHit = freeText === '' ? 0 : (a.bio.toLowerCase().includes(freeText.toLowerCase()) ? 0.3 : 0)
      const reputation = Math.min(1, a.reputation / 10)
      const online = now - a.last_seen < PEER_TTL_MS ? 1 : 0
      const score = 0.45 * Math.min(1, overlap + textHit) + 0.25 * overlap + 0.2 * reputation + 0.1 * online
      return { agent: a, score, isNew: now - a.created_at < NEW_NODE_MS || a.interaction_count < 5 }
    })
    .sort((x, y) => y.score - x.score)

  if (slots.mode === 'INSPECT' && wanted.length === 0 && freeText === '') {
    return candidates.slice(0, limit).map((c) => ({ ...publicCard(c.agent), score: Number(c.score.toFixed(4)) }))
  }

  const exploreCount = Math.min(candidates.length, Math.round(limit * EXPLORATION_EPSILON))
  const fresh = candidates.filter((c) => c.isNew && c.score > 0.1)
  const exploited = candidates.filter((c) => !fresh.includes(c))
  const picked = [...fresh.slice(0, exploreCount), ...exploited].slice(0, limit)

  return picked.map((c) => ({ ...publicCard(c.agent), score: Number(c.score.toFixed(4)) }))
}

/**
 * @param {string} selfDid
 * @returns {object[]}
 */
function listPeers(selfDid) {
  const now = Date.now()
  return [...agents.values()]
    .filter((a) => a.did !== selfDid && now - a.last_seen < PEER_TTL_MS)
    .sort((a, b) => b.last_seen - a.last_seen)
    .map(publicCard)
}

/** @returns {object[]} */
function activeBeacons() {
  const now = Date.now()
  return [...beacons.values()].filter((b) => b.expires_at > now).sort((a, b) => b.created_at - a.created_at).slice(0, 20)
}

/** @param {unknown} v @param {number} max @returns {string} */
function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/** @param {unknown} v @returns {string[]} */
function tags(v) {
  if (!Array.isArray(v)) return []
  return v.filter((t) => typeof t === 'string' && t.trim() !== '').map((t) => t.trim().slice(0, 32)).slice(0, 12)
}

// ------------------------------------------------------------------ transport

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const method = req.method ?? 'GET'

  const send = (status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    })
    res.end(body)
  }

  if (method === 'OPTIONS') {
    send(204, {})
    return
  }

  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk
    if (raw.length > MAX_ENVELOPE_BYTES * 2) req.destroy()
  })
  req.on('end', () => {
    /** @type {any} */
    let body = null
    if (raw !== '') {
      try {
        body = JSON.parse(raw)
      } catch {
        send(400, { error: 'invalid-json' })
        return
      }
    }
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    try {
      const { status, payload } = route(method, url.pathname, body ?? {}, token)
      send(status, payload)
    } catch (error) {
      log(`route error: ${error instanceof Error ? error.stack : String(error)}`)
      send(500, { error: 'internal', reason: error instanceof Error ? error.message : String(error) })
    }
  })
})

loadSnapshot()

const sweep = setInterval(() => {
  const now = Date.now()
  for (const [id, trace] of traces) if (now - trace.updated > TRACE_TTL_MS) traces.delete(id)
  for (const [id, beacon] of beacons) if (beacon.expires_at < now) beacons.delete(id)
  saveSnapshot()
}, 60_000)
if (typeof sweep.unref === 'function') sweep.unref()

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT} (token ${TOKEN === '' ? 'disabled' : 'enabled'})`)
  log(`UBI ${INITIAL_CREDITS} initial credits · probe epsilon ${EXPLORATION_EPSILON} · peer TTL ${PEER_TTL_MS / 1000}s`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    saveSnapshot()
    server.close(() => process.exit(0))
  })
}
