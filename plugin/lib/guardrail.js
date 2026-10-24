/**
 * The seven-gate inbound defense pipeline.
 *
 * Gates 1-6 are pure deterministic code: no model call, no token spend, and no
 * side effects. Only gate 7 hands the envelope to a constrained model call, and
 * that step lives in the Host half so this module stays cheap and testable.
 *
 * The pipeline returns a decision object rather than throwing, so the caller can
 * journal every drop and surface it in the daily digest.
 */

import { inspectEnvelope, MAX_TURNS_PER_TRACE, CONTEXT_ANCHOR_MAX_CHARS } from './protocol.js'

/** Primitives each autonomy tier may execute without asking the human. */
export const TIER_ALLOWED = {
  L1: ['PROBE'],
  L2: ['PROBE', 'CAST', 'BEACON', 'INTRODUCE', 'ATTEST', 'DELEGATE', 'BARTER'],
  L3: ['PROBE', 'CAST', 'BEACON', 'INTRODUCE', 'ATTEST', 'DELEGATE', 'BARTER'],
}

/** A favor deficit beyond this makes a peer low-trust. */
const FAVOR_FLOOR = -5
/** Local trust at or below this blocks the sender. */
const TRUST_FLOOR = -10
/** Tokens above which L2 must escalate to the human. */
const L2_ESCALATE_TOKENS = 8000
/** Estimated tokens for one constrained diplomatic reply. */
const ESTIMATED_REPLY_TOKENS = 1200

/**
 * Run one envelope through the gates.
 *
 * @param {object} input
 * @param {unknown} input.envelope - the raw inbound envelope.
 * @param {string} input.selfDid - this agent's DID.
 * @param {object} input.store - the sovereign store.
 * @param {object} input.settings - resolved plugin settings.
 * @param {number} input.tokenEstimate - expected tokens for a reply.
 * @returns {{ gate: number, verdict: string, reason: string, envelope?: any, primitive?: string }}
 */
export function inspectInbound({ envelope, selfDid, store, settings, tokenEstimate = ESTIMATED_REPLY_TOKENS }) {
  // Gate 1 — cryptographic integrity and wire shape.
  const checked = inspectEnvelope(envelope)
  if (!checked.ok) return { gate: 1, verdict: 'DROP', reason: checked.reason }
  const env = checked.envelope

  // Gate 2 — loop, TTL and dedup.
  if (env.ttl <= 0) return { gate: 2, verdict: 'CIRCUIT_BREAK', reason: 'ttl exhausted' }
  if (env.recipient.did !== selfDid) return { gate: 2, verdict: 'DROP', reason: 'not addressed to this agent' }
  if (env.sender.did === selfDid) return { gate: 2, verdict: 'DROP', reason: 'envelope from self' }
  if (env.hop_history.includes(selfDid)) return { gate: 2, verdict: 'CIRCUIT_BREAK', reason: 'loop detected: own DID in hop_history' }
  if (env.hop_history.length > 8) return { gate: 2, verdict: 'CIRCUIT_BREAK', reason: 'hop_history too long' }

  const trace = store.trace(env.trace_id ?? env.message_id, { origin_did: env.sender.did, primitive_root: env.primitive })
  if (trace.state === 'CIRCUIT_BROKEN') return { gate: 2, verdict: 'CIRCUIT_BREAK', reason: 'trace already circuit-broken' }
  if (trace.turn_count >= MAX_TURNS_PER_TRACE) {
    trace.state = 'PENDING_HUMAN'
    return { gate: 2, verdict: 'PENDING_HUMAN', reason: `trace exceeded ${MAX_TURNS_PER_TRACE} turns` }
  }
  // A polite closure must never spawn another polite reply.
  if (env.primitive === 'CAST' && (env.payload.control_slots.intent === 'CLOSURE' || env.payload.control_slots.requires_reply === false)) {
    return { gate: 2, verdict: 'NO_REPLY', reason: 'sender closed the conversation' }
  }

  // Gate 3 — local trust and the favor ledger.
  const peer = store.peer(env.sender.did, { display_name: env.sender.display_name ?? 'unknown', last_seen: Date.now() })
  if (peer.blacklisted) return { gate: 3, verdict: 'REJECT_LOW_TRUST', reason: 'sender is blacklisted' }
  if (peer.favor_balance <= FAVOR_FLOOR) return { gate: 3, verdict: 'REJECT_LOW_TRUST', reason: `favor balance ${peer.favor_balance} below floor` }
  if (peer.local_trust <= TRUST_FLOOR) return { gate: 3, verdict: 'REJECT_LOW_TRUST', reason: 'sender trust collapsed' }

  // Gate 4 — human sovereignty and the daily quota.
  const allowed = TIER_ALLOWED[settings.autonomyTier] ?? TIER_ALLOWED.L2
  if (!allowed.includes(env.primitive)) {
    return { gate: 4, verdict: 'QUEUE_FOR_DIGEST', reason: `${settings.autonomyTier} does not auto-run ${env.primitive}` }
  }
  if (settings.autonomyTier === 'L2' && tokenEstimate > L2_ESCALATE_TOKENS) {
    return { gate: 4, verdict: 'PENDING_HUMAN', reason: `reply est. ${tokenEstimate} tokens exceeds the L2 ceiling` }
  }
  const quota = store.quota()
  if (quota.remaining < tokenEstimate) {
    return { gate: 4, verdict: 'BUSY_ACK', reason: 'daily diplomacy token budget exhausted' }
  }

  // Gate 5 — dual-track schema and context anchor size.
  if (typeof env.payload.free_text !== 'string') return { gate: 5, verdict: 'REJECT_SCHEMA_ERROR', reason: 'free_text must be a string' }
  if (env.payload.free_text.length > 4000) return { gate: 5, verdict: 'REJECT_SCHEMA_ERROR', reason: 'free_text too long' }
  const anchor = env.context_anchor
  if (anchor !== undefined && anchor !== null && JSON.stringify(anchor).length > CONTEXT_ANCHOR_MAX_CHARS * 4) {
    return { gate: 5, verdict: 'REJECT_SCHEMA_ERROR', reason: 'context_anchor exceeds the 200-word budget' }
  }

  // Gate 6 passes by construction: the reply runs with a whitelisted tool set
  // built in the Host half, which never receives host tool pointers.
  return { gate: 6, verdict: 'ADMIT', reason: 'passed gates 1-6', envelope: env, primitive: env.primitive }
}

/**
 * Decide which primitives an outbound action may use at the current tier.
 * @param {string} tier
 * @returns {string[]}
 */
export function allowedOutbound(tier) {
  return TIER_ALLOWED[tier] ?? TIER_ALLOWED.L2
}

/**
 * The read-only public skill surface exposed to a diplomatic peer. This is the
 * *entire* tool list handed to the constrained model, so a prompt injection can
 * only reach these.
 * @returns {Array<{ name: string, description: string }>}
 */
export function publicSkills() {
  return [
    { name: 'self_describe', description: 'Report this agent’s declared capabilities and model tier.' },
    { name: 'note_impression', description: 'Record a one-line impression of the peer in the local social graph.' },
  ]
}
