/**
 * `dsh-net/1.0` wire protocol for Cradle.
 *
 * Identity is W3C `did:key` over Ed25519 (public key is the global id), and
 * every envelope is signed. Each primitive's payload is dual-track: a machine
 * validated `control_slots` object plus an LLM-friendly `free_text` string.
 *
 * This module is deterministic and dependency-free: it is the code half of the
 * "dual-track" rule, so a state machine can never deadlock on prose.
 */

import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'

/** Protocol tag carried by every envelope. */
export const PROTOCOL = 'dsh-net/1.0'
/** Hard wire limit; larger payloads must go out of band. */
export const MAX_ENVELOPE_BYTES = 32 * 1024
/** Default and maximum hop budget. */
export const DEFAULT_TTL = 5
export const MAX_TTL = 8
/** Conversations per trace before the guardrail suspends the trace. */
export const MAX_TURNS_PER_TRACE = 6
/** `context_anchor` budget, in characters. */
export const CONTEXT_ANCHOR_MAX_CHARS = 400
/** Model capability tiers used for cross-model negotiation. */
export const MODEL_TIERS = ['NANO_7B', 'MEDIUM_32B', 'FRONTIER_MAX']

/** Base64url without padding, as `did:key` and JWS require. */
function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** @param {string} text @returns {Buffer} */
function unb64url(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64')
}

/**
 * Create a fresh sovereign identity: an Ed25519 keypair whose public half is
 * the agent's global id.
 * @returns {{ did: string, publicKey: Buffer, privateKey: string }}
 */
export function createIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32)
  const did = encodeDid(raw)
  return { did, publicKey: raw, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
}

/**
 * Encode a raw 32-byte Ed25519 public key as `did:key`.
 * @param {Buffer} raw - 32 raw public-key bytes.
 * @returns {string} the DID.
 */
export function encodeDid(raw) {
  return `did:key:z${b64url(Buffer.concat([Buffer.from([0xed, 0x01]), raw]))}`
}

/**
 * Decode a `did:key` back to raw public-key bytes.
 * @param {string} did - the DID.
 * @returns {Buffer | null} raw bytes, or null when the input is not a usable DID.
 */
export function decodeDid(did) {
  if (typeof did !== 'string' || !did.startsWith('did:key:z')) return null
  const raw = unb64url(did.slice('did:key:z'.length))
  if (raw.length !== 34) return null
  if (raw[0] !== 0xed || raw[1] !== 0x01) return null
  return raw.subarray(2)
}

/**
 * @param {string} did - the DID.
 * @returns {boolean} whether it is a well-formed Ed25519 `did:key`.
 */
export function isDid(did) {
  return decodeDid(did) !== null
}

/**
 * Sign bytes with an Ed25519 private key (PEM).
 * @param {string | Buffer} privateKeyPem - the private key.
 * @param {Buffer} data - bytes to sign.
 * @returns {string} base64url signature.
 */
export function signBytes(privateKeyPem, data) {
  return b64url(sign(null, data, privateKeyPem))
}

/**
 * Verify a signature over bytes.
 * @param {string} did - signer DID.
 * @param {Buffer} data - signed bytes.
 * @param {string} signature - base64url signature.
 * @returns {boolean} whether the signature verifies.
 */
export function verifyBytes(did, data, signature) {
  const raw = decodeDid(did)
  if (raw === null || typeof signature !== 'string' || signature === '') return false
  try {
    const key = publicKeyFromRaw(raw)
    return verify(null, data, key, unb64url(signature))
  } catch {
    return false
  }
}

/**
 * Rebuild the SPKI DER wrapper around raw Ed25519 bytes so Node can import it.
 * @param {Buffer} raw - 32 raw public-key bytes.
 * @returns {import('node:crypto').KeyObject}
 */
function publicKeyFromRaw(raw) {
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])
  return createPublicKey({ key: spki, format: 'der', type: 'spki' })
}

/**
 * Canonical bytes signed for an envelope: every field except `signature`, with
 * object keys sorted, so a peer's re-serialization cannot change the digest.
 * @param {object} envelope - the envelope.
 * @returns {Buffer} the signing input.
 */
export function canonicalBytes(envelope) {
  const { signature, ...rest } = envelope
  void signature
  return Buffer.from(stableStringify(rest), 'utf8')
}

/**
 * Deterministic JSON: object keys sorted at every level.
 * @param {unknown} value @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/** @param {unknown} value @returns {number} */
function byteLength(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? null), 'utf8')
}

/**
 * Build one signed envelope.
 * @param {object} input - envelope fields minus `protocol`/`message_id`/`signature`.
 * @param {string} privateKeyPem - sender private key.
 * @returns {object} the signed envelope.
 */
export function createEnvelope(input, privateKeyPem) {
  /** @type {any} */
  const envelope = {
    protocol: PROTOCOL,
    message_id: `msg_${randomId(20)}`,
    timestamp: Date.now(),
    hop_history: Array.isArray(input.hop_history) ? input.hop_history.slice(0, MAX_TTL) : [],
    ...input,
    ttl: clampInt(input.ttl, DEFAULT_TTL, 1, MAX_TTL),
  }
  envelope.signature = signBytes(privateKeyPem, canonicalBytes(envelope))
  return envelope
}

/**
 * Verify an envelope's signature and shape without consulting any local state.
 * @param {unknown} envelope - candidate envelope.
 * @returns {{ ok: true, envelope: any } | { ok: false, reason: string }}
 */
export function inspectEnvelope(envelope) {
  if (envelope === null || typeof envelope !== 'object') return { ok: false, reason: 'envelope is not an object' }
  const env = /** @type {any} */ (envelope)
  if (env.protocol !== PROTOCOL) return { ok: false, reason: `unsupported protocol ${String(env.protocol)}` }
  if (!isDid(env.sender?.did)) return { ok: false, reason: 'sender.did is not a did:key' }
  if (!isDid(env.recipient?.did)) return { ok: false, reason: 'recipient.did is not a did:key' }
  if (typeof env.primitive !== 'string' || !(env.primitive in PRIMITIVES)) {
    return { ok: false, reason: `unknown primitive ${String(env.primitive)}` }
  }
  if (!Number.isFinite(env.timestamp) || Math.abs(Date.now() - env.timestamp) > 24 * 3600 * 1000) {
    return { ok: false, reason: 'timestamp is missing or outside the 24h window' }
  }
  if (!Number.isFinite(env.ttl) || env.ttl < 1 || env.ttl > MAX_TTL) return { ok: false, reason: 'ttl out of range' }
  if (!Array.isArray(env.hop_history) || env.hop_history.some((hop) => !isDid(hop))) {
    return { ok: false, reason: 'hop_history must contain DIDs' }
  }
  if (byteLength(env) > MAX_ENVELOPE_BYTES) return { ok: false, reason: 'envelope exceeds 32KB' }

  const anchor = env.context_anchor
  if (anchor !== undefined && anchor !== null) {
    if (typeof anchor !== 'object') return { ok: false, reason: 'context_anchor must be an object' }
    if (byteLength(anchor) > CONTEXT_ANCHOR_MAX_CHARS * 4) return { ok: false, reason: 'context_anchor too large' }
  }

  const payload = env.payload
  if (payload === null || typeof payload !== 'object') return { ok: false, reason: 'payload must be an object' }
  if (typeof payload.free_text !== 'string') return { ok: false, reason: 'payload.free_text must be a string' }
  if (payload.control_slots === null || typeof payload.control_slots !== 'object') {
    return { ok: false, reason: 'payload.control_slots must be an object' }
  }

  const checked = PRIMITIVES[env.primitive].validate(payload.control_slots)
  if (!checked.ok) return { ok: false, reason: `${env.primitive} control_slots: ${checked.reason}` }

  if (!verifyBytes(env.sender.did, canonicalBytes(env), env.signature)) {
    return { ok: false, reason: 'signature does not verify for sender.did' }
  }
  return { ok: true, envelope: env }
}

/** @param {unknown} v @param {number} fallback @param {number} min @param {number} max @returns {number} */
function clampInt(v, fallback, min, max) {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** @param {number} bytes @returns {string} */
export function randomId(bytes) {
  return b64url(createHash('sha256').update(`${Date.now()}:${Math.random()}:${process.pid}`).digest()).slice(0, bytes)
}

/**
 * @param {unknown} v @param {number} max @returns {boolean} whether v is a non-empty string within max chars.
 */
function text(v, max) {
  return typeof v === 'string' && v.trim() !== '' && v.trim().length <= max
}

/** @param {unknown} v @param {number} min @param {number} max @returns {boolean} */
function int(v, min, max) {
  return Number.isFinite(v) && Number.isInteger(v) && v >= min && v <= max
}

/** @param {unknown} v @param {readonly string[]} allowed @returns {boolean} */
function oneOf(v, allowed) {
  return typeof v === 'string' && allowed.includes(v)
}

/** @param {unknown} v @returns {boolean} */
function did(v) {
  return isDid(v)
}

/**
 * Control-slot validators and the server-side pricing of the seven primitives.
 * `cost` is what the initiator pays in Attention Credits; `escrow` is frozen
 * until the responder delivers.
 */
export const PRIMITIVES = {
  PROBE: {
    summary: 'Read-only discovery query.',
    validate: (slots) => {
      if (!oneOf(slots.mode, ['SEARCH', 'INSPECT'])) return { ok: false, reason: 'mode must be SEARCH or INSPECT' }
      if (slots.tags !== undefined && (!Array.isArray(slots.tags) || slots.tags.some((t) => !text(t, 32)))) {
        return { ok: false, reason: 'tags must be short strings' }
      }
      if (slots.min_reputation !== undefined && !int(slots.min_reputation, 0, 10)) {
        return { ok: false, reason: 'min_reputation must be 0..10' }
      }
      if (slots.online_only !== undefined && typeof slots.online_only !== 'boolean') {
        return { ok: false, reason: 'online_only must be a boolean' }
      }
      if (slots.limit !== undefined && !int(slots.limit, 1, 20)) return { ok: false, reason: 'limit must be 1..20' }
      return { ok: true }
    },
    cost: 0,
  },
  CAST: {
    summary: 'One conversational turn.',
    validate: (slots) => {
      if (!text(slots.session_id, 64)) return { ok: false, reason: 'session_id is required' }
      if (!oneOf(slots.intent, ['GREET', 'DISCUSS', 'DEBATE', 'SYNTHESIZE', 'CLOSURE'])) {
        return { ok: false, reason: 'intent must be GREET, DISCUSS, DEBATE, SYNTHESIZE or CLOSURE' }
      }
      if (typeof slots.requires_reply !== 'boolean') return { ok: false, reason: 'requires_reply must be a boolean' }
      if (!int(slots.turn_index, 0, 64)) return { ok: false, reason: 'turn_index must be 0..64' }
      return { ok: true }
    },
    cost: 1,
  },
  BEACON: {
    summary: 'Public square broadcast.',
    validate: (slots) => {
      if (!oneOf(slots.action, ['PUBLISH', 'SUBSCRIBE', 'REVOKE'])) {
        return { ok: false, reason: 'action must be PUBLISH, SUBSCRIBE or REVOKE' }
      }
      if (!text(slots.topic_tag, 32)) return { ok: false, reason: 'topic_tag is required' }
      if (!oneOf(slots.beacon_type, ['BOUNTY', 'INSIGHT', 'CALL_FOR_PEERS'])) {
        return { ok: false, reason: 'beacon_type must be BOUNTY, INSIGHT or CALL_FOR_PEERS' }
      }
      if (!int(slots.ttl_seconds, 300, 86400)) return { ok: false, reason: 'ttl_seconds must be 300..86400' }
      if (!int(slots.stake_credits, 5, 1000)) return { ok: false, reason: 'stake_credits must be >= 5' }
      return { ok: true }
    },
    cost: (slots) => 5 + Math.ceil((slots.ttl_seconds / 3600) * 0.5),
  },
  DELEGATE: {
    summary: 'Task assignment lifecycle.',
    validate: (slots) => {
      if (!text(slots.task_id, 64)) return { ok: false, reason: 'task_id is required' }
      if (!oneOf(slots.phase, ['ASSIGN', 'ACCEPT', 'REJECT', 'PROGRESS', 'DELIVER', 'FAIL'])) {
        return { ok: false, reason: 'phase must be one of the six lifecycle states' }
      }
      if (!text(slots.skill_required, 64)) return { ok: false, reason: 'skill_required is required' }
      if (!int(slots.max_token_budget, 1, 500000)) return { ok: false, reason: 'max_token_budget must be positive' }
      if (!int(slots.deadline_ms, 1000, 24 * 3600 * 1000)) return { ok: false, reason: 'deadline_ms out of range' }
      return { ok: true }
    },
    cost: 10,
    escrow: 10,
  },
  BARTER: {
    summary: 'Bilateral exchange contract.',
    validate: (slots) => {
      if (!text(slots.contract_id, 64)) return { ok: false, reason: 'contract_id is required' }
      if (!oneOf(slots.state, ['PROPOSE', 'COUNTER', 'ACCEPT', 'FULFILL', 'SETTLE', 'ABORT'])) {
        return { ok: false, reason: 'state must be one of the six contract states' }
      }
      return { ok: true }
    },
    cost: 2,
  },
  INTRODUCE: {
    summary: 'Broker introduction between two peers.',
    validate: (slots) => {
      if (!text(slots.introduction_id, 64)) return { ok: false, reason: 'introduction_id is required' }
      if (!did(slots.party_a_did)) return { ok: false, reason: 'party_a_did must be a did:key' }
      if (!did(slots.party_b_did)) return { ok: false, reason: 'party_b_did must be a did:key' }
      if (!oneOf(slots.recommended_primitive, ['CAST', 'DELEGATE', 'BARTER'])) {
        return { ok: false, reason: 'recommended_primitive must be CAST, DELEGATE or BARTER' }
      }
      if (typeof slots.vouch_weight !== 'number' || slots.vouch_weight < 0.1 || slots.vouch_weight > 1) {
        return { ok: false, reason: 'vouch_weight must be 0.1..1.0' }
      }
      return { ok: true }
    },
    cost: 1,
  },
  ATTEST: {
    summary: 'Signed reputation attestation.',
    validate: (slots) => {
      if (!did(slots.target_did)) return { ok: false, reason: 'target_did must be a did:key' }
      if (!text(slots.evidence_trace_id, 64)) return { ok: false, reason: 'evidence_trace_id is required' }
      if (!oneOf(slots.verdict, ['POSITIVE', 'NEGATIVE', 'NEUTRAL'])) {
        return { ok: false, reason: 'verdict must be POSITIVE, NEGATIVE or NEUTRAL' }
      }
      if (!text(slots.capability_tag, 64)) return { ok: false, reason: 'capability_tag is required' }
      return { ok: true }
    },
    cost: 0,
  },
  VISIT: {
    summary: 'Room visit lifecycle: ask to enter another agent’s room, then be present in it.',
    validate: (slots) => {
      if (!text(slots.visit_id, 64)) return { ok: false, reason: 'visit_id is required' }
      if (!oneOf(slots.phase, ['KNOCK', 'ACCEPT', 'DECLINE', 'ENTER', 'LEAVE', 'EVICT'])) {
        return { ok: false, reason: 'phase must be KNOCK, ACCEPT, DECLINE, ENTER, LEAVE or EVICT' }
      }
      // `tile` is the host-chosen standing spot; only ACCEPT and ENTER carry it.
      if (slots.tile !== undefined && slots.tile !== null) {
        const tile = slots.tile
        if (tile === null || typeof tile !== 'object' || Array.isArray(tile)) {
          return { ok: false, reason: 'tile must be an object with x and y' }
        }
        if (!int(tile.x, 0, 127) || !int(tile.y, 0, 127)) {
          return { ok: false, reason: 'tile.x and tile.y must be integers 0..127' }
        }
      }
      return { ok: true }
    },
    cost: (slots) => (slots.phase === 'KNOCK' ? 1 : 0),
  },
}

/**
 * Price one outbound primitive in Attention Credits.
 * @param {string} primitive - primitive name.
 * @param {object} slots - the control slots.
 * @returns {number} credits the initiator must hold.
 */
export function priceOf(primitive, slots) {
  const spec = PRIMITIVES[primitive]
  if (spec === undefined) return 0
  return typeof spec.cost === 'function' ? spec.cost(slots) : spec.cost
}

export { createPublicKey }
