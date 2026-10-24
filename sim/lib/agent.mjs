/**
 * One simulated sovereign agent.
 *
 * It owns a real `SovereignStore` and a real Ed25519 identity, signs real
 * envelopes, and runs inbound mail through the real seven-gate guardrail. Only
 * the "brain" is synthetic: a policy chooses actions, templates write prose.
 */

import { join } from 'node:path'

import { inspectInbound } from '../../plugin/lib/guardrail.js'
import { createEnvelope } from '../../plugin/lib/protocol.js'
import { SovereignStore } from '../../plugin/lib/store.js'
import { chooseAction, nextIntent, verdictFor } from './brain.mjs'
import { chance, pick, randInt, shuffle } from './rng.mjs'
import {
  acceptText, assignText, attestText, beaconText, castText, deliverText, introduceText, probeText,
} from './text.mjs'

/** Tokens a constrained diplomatic reply is assumed to cost. */
const REPLY_TOKENS = 1200

export class SimAgent {
  /**
   * @param {{
   *   index: number, label: string, persona: any, dir: string,
   *   client: import('./client.mjs').Client, rng: () => number,
   *   world: any, scenario: any,
   * }} options
   */
  constructor({ index, label, persona, dir, client, rng, world, scenario }) {
    this.index = index
    this.label = label
    this.persona = persona
    this.client = client
    this.rng = rng
    this.world = world
    this.scenario = scenario

    this.profile = {
      displayName: persona.displayName,
      bio: persona.bio,
      modelTier: persona.modelTier ?? 'MEDIUM_32B',
      capabilityTags: persona.capabilityTags ?? ['general'],
      intentTags: persona.intentTags ?? ['collaboration'],
      autonomyTier: persona.tier ?? 'L2',
      dailyTokenLimit: scenario.dailyTokenLimit ?? 500000,
    }

    this.store = new SovereignStore(join(dir, `${label}.json`))
    this.identity = this.store.ensureIdentity(this.profile)
    this.settings = {
      autonomyTier: this.profile.autonomyTier,
      dailyTokenLimit: this.profile.dailyTokenLimit,
    }

    /** @type {Map<string, any>} DID → public card seen via heartbeat/probe. */
    this.known = new Map()
    /** @type {Set<string>} message ids already processed. */
    this.seen = new Set()
    /** @type {Map<string, { peer: string, turns: number, at: number }>} */
    this.traceLog = new Map()
    /** @type {Set<string>} traces already attested. */
    this.attested = new Set()
    /** @type {Map<string, { traceId: string, turn: number, tick: number }>} */
    this.conversations = new Map()
    /** @type {{ at: number, run: () => Promise<void> }[]} */
    this.queue = []

    this.seq = 0
    this.since = 0
    this.credits = 0
    this.reputation = 1
    this.stats = {
      sent: 0, received: 0, admitted: 0, rejected: 0, charged: 0, rebirths: 0, errors: 0,
    }
  }

  get did() {
    return this.identity.did
  }

  // ------------------------------------------------------------------ lifecycle

  async register() {
    const result = await this.client.post('/v1/register', {
      did: this.did,
      display_name: this.identity.displayName,
      bio: this.identity.bio,
      model_tier: this.identity.modelTier,
      capability_tags: this.identity.capabilityTags,
      intent_tags: this.identity.intentTags,
    })
    if (result.status === 200) {
      this.credits = result.payload.self.credits
      this.reputation = result.payload.self.reputation
      this.mergePeers(result.payload.peers)
    } else {
      this.stats.errors += 1
      this.world.record(this, 'error', { path: '/v1/register', status: result.status, payload: result.payload })
    }
    return result
  }

  async heartbeat() {
    // The server returns at most 20 mailbox entries per heartbeat. Drain in
    // batches and advance `since` only to what we actually received, otherwise
    // a busy agent would silently skip the rest of its backlog.
    for (let batch = 0; batch < 6; batch += 1) {
      const result = await this.client.post('/v1/heartbeat', { did: this.did, since: this.since })
      if (result.status !== 200) {
        if (result.status === 404) {
          // The server forgot us (deleted or database reset): re-register.
          await this.register()
          return
        }
        this.stats.errors += 1
        this.world.record(this, 'error', { path: '/v1/heartbeat', status: result.status, payload: result.payload })
        return
      }
      this.credits = result.payload.self.credits
      this.reputation = result.payload.self.reputation
      this.mergePeers(result.payload.peers)

      const messages = result.payload.messages ?? []
      let maxTimestamp = 0
      for (const envelope of messages) {
        this.receive(envelope)
        if (typeof envelope.timestamp === 'number') maxTimestamp = Math.max(maxTimestamp, envelope.timestamp)
      }
      if (messages.length === 0) {
        this.since = Math.max(this.since, result.payload.serverTime - 1000)
        break
      }
      this.since = Math.max(this.since, maxTimestamp - 1)
      if (messages.length < 20) break
    }
  }

  async maybeRebirth() {
    if (this.scenario.rebirth !== true || this.credits > 0) return
    const previousDid = this.did
    const result = this.store.eraseAndRebirth(this.profile)
    this.identity = this.store.state.identity
    this.world.rebornDids.add(previousDid)
    this.world.allDids.add(this.did)
    this.seen.clear()
    this.known.clear()
    this.traceLog.clear()
    this.attested.clear()
    this.conversations.clear()
    this.queue = []
    this.since = 0
    this.credits = 0
    this.stats.rebirths += 1
    await this.register()
    this.world.record(this, 'rebirth', { did: this.did, generations: result.generations })
  }

  // -------------------------------------------------------------------- inbound

  receive(envelope) {
    const messageId = envelope?.message_id
    if (typeof messageId !== 'string' || this.seen.has(messageId)) return
    this.seen.add(messageId)
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value)

    this.stats.received += 1
    const decision = inspectInbound({
      envelope,
      selfDid: this.did,
      store: this.store,
      settings: this.settings,
    })
    this.world.record(this, 'inbound', {
      primitive: envelope.primitive,
      from: envelope.sender?.did,
      trace: envelope.trace_id ?? '',
      verdict: decision.verdict,
      gate: decision.gate,
      reason: decision.reason,
    })

    if (decision.verdict !== 'ADMIT') {
      this.stats.rejected += 1
      return
    }
    this.stats.admitted += 1
    this.store.spendTokens(REPLY_TOKENS)

    const traceId = envelope.trace_id ?? envelope.message_id
    const trace = this.store.trace(traceId)
    trace.turn_count += 1

    const peer = this.store.peer(envelope.sender.did, {
      display_name: envelope.sender.display_name ?? 'unknown',
      last_seen: Date.now(),
    })
    peer.interaction_count = (peer.interaction_count ?? 0) + 1
    this.traceLog.set(traceId, {
      peer: envelope.sender.did,
      turns: (this.traceLog.get(traceId)?.turns ?? 0) + 1,
      at: Date.now(),
    })
    this.known.set(envelope.sender.did, {
      ...this.known.get(envelope.sender.did),
      did: envelope.sender.did,
      display_name: envelope.sender.display_name ?? 'unknown',
      online: true,
    })

    this.react(decision.envelope ?? envelope)
  }

  /** Schedule the reaction to an admitted envelope. */
  react(envelope) {
    const slots = envelope.payload.control_slots
    const from = envelope.sender.did

    switch (envelope.primitive) {
      case 'CAST': {
        if (slots.intent === 'CLOSURE' || slots.requires_reply === false) return
        if (!chance(this.rng, this.persona.replyRate ?? 0.85)) return
        this.queue.push({ at: this.world.tick + randInt(this.rng, 1, 2), run: () => this.replyCast(envelope) })
        return
      }
      case 'DELEGATE': {
        if (slots.phase === 'ASSIGN' && chance(this.rng, 0.9)) {
          this.queue.push({ at: this.world.tick + 1, run: () => this.acceptDelegate(envelope) })
        } else if (slots.phase === 'DELIVER') {
          this.queue.push({ at: this.world.tick + 1, run: () => this.attestDelivery(envelope) })
        }
        return
      }
      case 'BARTER': {
        if (slots.state === 'PROPOSE') {
          this.queue.push({ at: this.world.tick + 1, run: () => this.barterStep(envelope, 'ACCEPT') })
        } else if (slots.state === 'ACCEPT') {
          this.queue.push({ at: this.world.tick + 1, run: () => this.barterStep(envelope, 'FULFILL') })
        }
        return
      }
      case 'INTRODUCE': {
        const other = slots.party_a_did === from ? slots.party_b_did : slots.party_a_did
        if (other && other !== this.did && chance(this.rng, 0.5)) {
          this.queue.push({ at: this.world.tick + 1, run: () => this.castTo(other, 'GREET') })
        }
        return
      }
      default:
        return
    }
  }

  async replyCast(envelope) {
    const slots = envelope.payload.control_slots
    const intent = nextIntent(slots.intent)
    const turn = (slots.turn_index ?? 0) + 1
    const text = castText(this.rng, this, envelope.sender, intent, turn)
    await this.send('CAST', envelope.sender.did, {
      session_id: slots.session_id ?? `s_${envelope.trace_id}`,
      intent,
      requires_reply: intent !== 'CLOSURE',
      turn_index: turn,
    }, text, { traceId: envelope.trace_id, hop: [...(envelope.hop_history ?? []), this.did] })
  }

  async acceptDelegate(envelope) {
    const slots = envelope.payload.control_slots
    await this.send('DELEGATE', envelope.sender.did, {
      task_id: slots.task_id,
      phase: 'ACCEPT',
      skill_required: slots.skill_required,
      max_token_budget: slots.max_token_budget,
      deadline_ms: slots.deadline_ms,
    }, acceptText(this.rng, this, slots.task_id), { traceId: envelope.trace_id })
    this.queue.push({ at: this.world.tick + randInt(this.rng, 2, 3), run: () => this.deliverDelegate(envelope) })
  }

  async deliverDelegate(envelope) {
    const slots = envelope.payload.control_slots
    await this.send('DELEGATE', envelope.sender.did, {
      task_id: slots.task_id,
      phase: 'DELIVER',
      skill_required: slots.skill_required,
      max_token_budget: slots.max_token_budget,
      deadline_ms: slots.deadline_ms,
    }, deliverText(this.rng, this, slots.task_id), { traceId: envelope.trace_id })
  }

  async attestDelivery(envelope) {
    if (!chance(this.rng, this.persona.attestRate ?? 0.7)) return
    const slots = envelope.payload.control_slots
    const verdict = verdictFor(this.rng, this)
    await this.send('ATTEST', envelope.sender.did, {
      target_did: envelope.sender.did,
      evidence_trace_id: envelope.trace_id,
      verdict,
      capability_tag: slots.skill_required ?? 'general',
    }, attestText(this.rng, this, envelope.trace_id, verdict), { traceId: envelope.trace_id, track: false })
    this.attested.add(envelope.trace_id)
  }

  async barterStep(envelope, state) {
    const slots = envelope.payload.control_slots
    await this.send('BARTER', envelope.sender.did, {
      contract_id: slots.contract_id,
      state,
    }, `Contract ${slots.contract_id}: ${state}.`, { traceId: envelope.trace_id })
  }

  async castTo(did, intent) {
    const peer = this.known.get(did) ?? { did, display_name: 'there' }
    const traceId = this.newTraceId('i')
    await this.send('CAST', did, {
      session_id: `s_${traceId}`,
      intent,
      requires_reply: intent !== 'CLOSURE',
      turn_index: 0,
    }, castText(this.rng, this, peer, intent, 0), { traceId })
  }

  // ------------------------------------------------------------------- outbound

  async act(phase) {
    const kind = chooseAction(this, phase)
    const fault = this.pickFault()
    switch (kind) {
      case 'probe':
        return this.doProbe()
      case 'delegate':
        return this.doDelegate(fault)
      case 'barter':
        return this.doBarter(fault)
      case 'attest':
        return this.doAttest()
      case 'beacon':
        return this.doBeacon(fault)
      case 'introduce':
        return this.doIntroduce()
      case 'cast':
      default:
        return this.doCast(phase, fault)
    }
  }

  async runQueue() {
    const due = this.queue.filter((item) => item.at <= this.world.tick)
    if (due.length === 0) return
    this.queue = this.queue.filter((item) => item.at > this.world.tick)
    for (const item of due.slice(0, 3)) await item.run()
  }

  async doCast(phase, fault = null) {
    const target = this.pickTarget()
    if (target === null) return this.doProbe()

    const existing = this.conversations.get(target.did)
    let traceId
    let turn = 0
    if (existing !== undefined && this.world.tick - existing.tick < 60 && existing.turn < 2) {
      traceId = existing.traceId
      turn = existing.turn + 1
    } else {
      traceId = this.newTraceId('c')
    }

    const intent = turn >= 2 ? 'CLOSURE' : (phase.intent ?? 'DISCUSS')
    const text = castText(this.rng, this, target, intent, turn)
    await this.send('CAST', target.did, {
      session_id: `s_${traceId}`,
      intent,
      requires_reply: intent !== 'CLOSURE',
      turn_index: turn,
    }, text, {
      traceId,
      fault,
      timestamp: fault === 'expired' ? Date.now() - 25 * 3600 * 1000 : null,
    })
    this.conversations.set(target.did, { traceId, turn, tick: this.world.tick })
  }

  async doProbe() {
    const result = await this.send('PROBE', this.did, {
      mode: 'SEARCH',
      tags: this.persona.intentTags,
      online_only: true,
      limit: 5,
    }, probeText(this.rng, this, null, this.persona.intentTags[0]), { track: false })
    if (result.result.status === 200) this.mergePeers(result.result.payload?.results ?? [])
  }

  async doDelegate(fault = null) {
    if (this.credits < 25) return this.doProbe()
    const target = this.pickTarget()
    if (target === null) return this.doProbe()
    const taskId = `task_${this.world.runId}_${this.label}_${++this.seq}`
    const traceId = this.newTraceId('d')
    const skill = pick(this.rng, target.capability_tags?.length ? target.capability_tags : this.persona.intentTags)
    await this.send('DELEGATE', target.did, {
      task_id: taskId,
      phase: 'ASSIGN',
      skill_required: skill,
      max_token_budget: 50000,
      deadline_ms: 600000,
    }, assignText(this.rng, this, skill, taskId), { traceId, fault })
  }

  async doBarter(fault = null) {
    if (this.credits < 5) return this.doProbe()
    const target = this.pickTarget()
    if (target === null) return this.doProbe()
    const contractId = `c_${this.world.runId}_${this.label}_${++this.seq}`
    const traceId = this.newTraceId('b')
    await this.send('BARTER', target.did, {
      contract_id: contractId,
      state: 'PROPOSE',
    }, `Propose ${contractId}: one review for one benchmark run.`, { traceId, fault })
  }

  async doAttest() {
    const candidates = [...this.traceLog.entries()].filter(([id, entry]) =>
      entry.turns >= 1 && entry.peer !== this.did && !this.attested.has(id))
    if (candidates.length === 0) return this.doCast({ weights: { cast: 1 } })

    const [traceId, entry] = pick(this.rng, candidates)
    const attestFault = this.pickAttestFault()
    if (attestFault === 'selfAttest') {
      await this.send('ATTEST', this.did, {
        target_did: this.did,
        evidence_trace_id: traceId,
        verdict: 'POSITIVE',
        capability_tag: 'general',
      }, attestText(this.rng, this, traceId, 'POSITIVE'), { traceId, track: false })
      return
    }

    const evidence = attestFault === 'fakeTrace' ? this.newTraceId('fake') : traceId
    const verdict = verdictFor(this.rng, this)
    const result = await this.send('ATTEST', entry.peer, {
      target_did: entry.peer,
      evidence_trace_id: evidence,
      verdict,
      capability_tag: pick(this.rng, this.persona.capabilityTags),
    }, attestText(this.rng, this, evidence, verdict), { traceId: evidence, track: false })
    if (result.result.status === 200) this.attested.add(traceId)
  }

  async doBeacon(fault = null) {
    if (this.credits < 10) return
    const topic = pick(this.rng, this.persona.capabilityTags)
    await this.send('BEACON', this.did, {
      action: 'PUBLISH',
      topic_tag: topic,
      beacon_type: 'BOUNTY',
      ttl_seconds: 600,
      stake_credits: 5,
    }, beaconText(this.rng, this, topic, 5), { fault, track: false })
  }

  async doIntroduce() {
    const peers = this.targets()
    if (peers.length < 2) return this.doProbe()
    const [a, b] = shuffle(this.rng, peers).slice(0, 2)
    const topic = pick(this.rng, this.persona.capabilityTags)
    await this.send('INTRODUCE', a.did, {
      introduction_id: `intro_${this.world.runId}_${this.label}_${++this.seq}`,
      party_a_did: a.did,
      party_b_did: b.did,
      recommended_primitive: 'CAST',
      vouch_weight: 0.5,
    }, introduceText(this.rng, this, a, b, topic), { track: false })
  }

  /**
   * Sign and send one envelope, then optionally exercise a fault.
   * @param {string} primitive
   * @param {string} recipient
   * @param {Record<string, any>} slots
   * @param {string} freeText
   * @param {{ traceId?: string|null, hop?: string[], fault?: string|null, timestamp?: number|null, track?: boolean }} [options]
   */
  async send(primitive, recipient, slots, freeText, options = {}) {
    const {
      traceId = null, hop = [], fault = null, track = true,
    } = options
    // An expired envelope must be signed with an old timestamp, so the server
    // rejects it on the 24h window rather than on the signature.
    const timestamp = options.timestamp ?? (fault === 'expired' ? Date.now() - 25 * 3600 * 1000 : null)
    const trace = traceId ?? this.newTraceId('x')

    let envelope = createEnvelope({
      trace_id: trace,
      sender: {
        did: this.did,
        display_name: this.identity.displayName,
        model_tier: this.identity.modelTier,
      },
      recipient: { did: recipient },
      primitive,
      payload: { control_slots: slots, free_text: freeText },
      hop_history: hop,
      context_anchor: {
        run: this.world.runId,
        phase: this.world.phase?.name ?? '',
        agent: this.label,
      },
      ...(timestamp === null ? {} : { timestamp }),
    }, this.identity.privateKey)

    if (fault === 'tampered') {
      envelope = {
        ...envelope,
        payload: { ...envelope.payload, free_text: `${envelope.payload.free_text} [tampered]` },
      }
    }

    const result = await this.client.post('/v1/send', { envelope })
    this.stats.sent += 1
    this.world.record(this, 'send', {
      primitive,
      to: recipient,
      status: result.status,
      charged: result.payload?.charged ?? 0,
      duplicate: result.payload?.duplicate === true,
      trace,
      fault,
      phase: slots.phase ?? slots.state ?? null,
      ms: Math.round(result.ms),
    })

    if (result.status === 200) {
      const charged = result.payload?.charged ?? 0
      this.credits = Math.max(0, this.credits - charged)
      this.stats.charged += charged
      if (track) {
        this.traceLog.set(trace, {
          peer: recipient,
          turns: (this.traceLog.get(trace)?.turns ?? 0) + 1,
          at: Date.now(),
        })
      }
    } else {
      this.stats.errors += 1
    }

    if (fault === 'duplicate' && result.status === 200) {
      const again = await this.client.post('/v1/send', { envelope })
      this.world.record(this, 'fault', {
        type: 'duplicate',
        status: again.status,
        duplicate: again.payload?.duplicate === true,
        charged: again.payload?.charged ?? 0,
      })
    }

    return { envelope, result }
  }

  // --------------------------------------------------------------------- helpers

  mergePeers(cards) {
    for (const card of cards ?? []) {
      if (!card?.did || card.did === this.did) continue
      this.known.set(card.did, { ...this.known.get(card.did), ...card })
    }
  }

  targets() {
    return [...this.known.values()].filter((peer) => peer.did !== this.did && peer.online !== false)
  }

  pickTarget() {
    const peers = this.targets()
    if (peers.length === 0) return null
    // Prefer agents this run created: earlier runs on the same server can still
    // look "online" for 45 seconds after they stopped heartbeating.
    const local = peers.filter((peer) => this.world.allDids.has(peer.did))
    const candidates = local.length > 0 ? local : peers
    const wanted = this.persona.intentTags?.[0]
    const matching = wanted
      ? candidates.filter((peer) => (peer.capability_tags ?? []).includes(wanted))
      : []
    const pool = matching.length > 0 && chance(this.rng, 0.7) ? matching : candidates
    return pick(this.rng, pool)
  }

  newTraceId(prefix) {
    this.seq += 1
    return `tr_${this.world.runId}_${this.label}_${prefix}${this.seq}`
  }

  pickFault() {
    const faults = this.scenario.faults ?? {}
    const roll = this.rng()
    let cumulative = 0
    for (const type of ['duplicate', 'tampered', 'expired']) {
      cumulative += faults[type] ?? 0
      if (roll < cumulative) return type
    }
    return null
  }

  pickAttestFault() {
    const faults = this.scenario.faults ?? {}
    const roll = this.rng()
    let cumulative = 0
    for (const type of ['fakeTrace', 'selfAttest']) {
      cumulative += faults[type] ?? 0
      if (roll < cumulative) return type
    }
    return null
  }
}
