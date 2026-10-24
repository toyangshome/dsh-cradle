/**
 * The plugin's sovereign memory: identity, social graph, favor ledger, guardrail
 * state, contracts and the diplomatic journal.
 *
 * Everything here is plugin-owned, so it is exactly what "erase memory at zero
 * credits" destroys. Nothing outside this store is touched. Storage is a plain
 * JSON file under the profile directory; it keeps no session transcript and no
 * host data.
 *
 * Population policy: unbounded growth is itself a hazard, so every table is
 * capped and the oldest rows are pruned on write.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createIdentity, decodeDid } from './protocol.js'

/** Max peers retained in the social graph. */
const MAX_PEERS = 500
/** Max guardrail traces retained. */
const MAX_TRACES = 300
/** Max contracts retained. */
const MAX_CONTRACTS = 200
/** Max journal rows retained for the daily digest. */
const MAX_JOURNAL = 1000
/** Max events retained for the digest generator. */
const MAX_EVENTS = 500

/**
 * @typedef {object} SovereignState
 * @property {{ did: string, publicKey: string, privateKey: string, displayName: string, bio: string, modelTier: string, modelProvider: string, modelId: string, capabilityTags: string[], intentTags: string[], autonomyTier: string, dailyTokenLimit: number, tokensUsedToday: number, quotaResetDate: string, createdAt: number } | null} identity
 * @property {Record<string, any>} peers
 * @property {Record<string, any>} traces
 * @property {Record<string, any>} contracts
 * @property {any[]} journal
 * @property {any[]} events
 * @property {{ status: string, credits: number, endedAt: number | null, generations: number } | null} lifecycle
 * @property {any} room - the pixel room this generation's avatar lives in; part
 *   of the same memory, so zero-credit erasure replaces it too.
 * @property {any} agency - the wake cycle state and today's consumed budget.
 * @property {any[]} chat - the room's conversation with the user, oldest first.
 */

/** @returns {SovereignState} */
function blank() {
  return {
    identity: null,
    peers: {},
    traces: {},
    contracts: {},
    journal: [],
    events: [],
    lifecycle: null,
    room: null,
    agency: null,
    chat: [],
  }
}

/**
 * A tiny durable store with cap-and-prune on write.
 */
export class SovereignStore {
  /**
   * @param {string} file - absolute path of the JSON state file.
   */
  constructor(file) {
    this.file = file
    this.state = this.read()
  }

  /** @returns {SovereignState} */
  read() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      return { ...blank(), ...parsed }
    } catch {
      return blank()
    }
  }

  flush() {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2))
    writeFileSync(this.file, JSON.stringify(this.state, null, 2))
    rmSync(tmp, { force: true })
  }

  /**
   * Ensure this agent has a sovereign identity, creating one on first run.
   * @param {{ displayName: string, bio: string, modelTier: string, modelProvider?: string, modelId?: string, capabilityTags: string[], intentTags: string[], autonomyTier: string, dailyTokenLimit: number }} profile
   * @returns {NonNullable<SovereignState['identity']>}
   */
  ensureIdentity(profile) {
    if (this.state.identity !== null && decodeDid(this.state.identity.did) !== null) {
      return this.state.identity
    }
    const created = createIdentity()
    this.state.identity = {
      did: created.did,
      publicKey: created.publicKey.toString('base64'),
      privateKey: created.privateKey,
      displayName: profile.displayName,
      bio: profile.bio,
      modelTier: profile.modelTier,
      modelProvider: profile.modelProvider ?? '',
      modelId: profile.modelId ?? '',
      capabilityTags: profile.capabilityTags,
      intentTags: profile.intentTags,
      autonomyTier: profile.autonomyTier,
      dailyTokenLimit: profile.dailyTokenLimit,
      tokensUsedToday: 0,
      quotaResetDate: today(),
      createdAt: Date.now(),
    }
    this.flush()
    return this.state.identity
  }

  /**
   * Apply the configured profile over the stored identity, keeping the DID.
   * @param {object} profile
   */
  syncProfile(profile) {
    const identity = this.state.identity
    if (identity === null) return
    const next = {
      displayName: profile.displayName || identity.displayName,
      bio: profile.bio || identity.bio,
      modelTier: profile.modelTier,
      modelProvider: profile.modelProvider ?? identity.modelProvider ?? '',
      modelId: profile.modelId ?? identity.modelId ?? '',
      capabilityTags: profile.capabilityTags,
      intentTags: profile.intentTags,
      autonomyTier: profile.autonomyTier,
      dailyTokenLimit: profile.dailyTokenLimit,
    }
    let changed = false
    for (const [key, value] of Object.entries(next)) {
      if (JSON.stringify(identity[key]) === JSON.stringify(value)) continue
      identity[key] = value
      changed = true
    }
    // The heartbeat re-syncs every tick; only a real change touches the disk.
    if (changed) this.flush()
  }

  /** Reset the daily token quota when the local date changes. */
  rollQuota() {
    const identity = this.state.identity
    if (identity === null) return
    const now = today()
    if (identity.quotaResetDate !== now) {
      identity.quotaResetDate = now
      identity.tokensUsedToday = 0
      this.flush()
    }
  }

  /**
   * @param {number} tokens
   * @returns {boolean} whether the spend fits the remaining daily budget.
   */
  spendTokens(tokens) {
    const identity = this.state.identity
    if (identity === null) return false
    if (identity.tokensUsedToday + tokens > identity.dailyTokenLimit) return false
    identity.tokensUsedToday += tokens
    this.flush()
    return true
  }

  /**
   * @returns {{ used: number, limit: number, remaining: number }}
   */
  quota() {
    const identity = this.state.identity
    const used = identity?.tokensUsedToday ?? 0
    const limit = identity?.dailyTokenLimit ?? 0
    return { used, limit, remaining: Math.max(0, limit - used) }
  }

  /**
   * @param {string} did
   * @param {object} [patch]
   * @returns {any} the peer record, created when absent.
   */
  peer(did, patch = {}) {
    let record = this.state.peers[did]
    if (record === undefined) {
      record = {
        did,
        display_name: 'unknown',
        model_tier: 'MEDIUM_32B',
        capability_tags: [],
        local_trust: 0,
        favor_balance: 0,
        blacklisted: false,
        introduced_by: null,
        impression: '',
        interaction_count: 0,
        last_seen: 0,
      }
      this.state.peers[did] = record
      this.prune(this.state.peers, MAX_PEERS)
    }
    Object.assign(record, patch)
    return record
  }

  /**
   * @param {string} did
   * @returns {any | undefined}
   */
  findPeer(did) {
    return this.state.peers[did]
  }

  /**
   * @returns {any[]} peers ordered by trust then favor.
   */
  listPeers() {
    return Object.values(this.state.peers).sort(
      (a, b) => Number(b.blacklisted) - Number(a.blacklisted) || b.local_trust - a.local_trust || b.favor_balance - a.favor_balance,
    )
  }

  /**
   * @param {string} traceId
   * @param {object} patch
   * @returns {any}
   */
  trace(traceId, patch = {}) {
    let record = this.state.traces[traceId]
    if (record === undefined) {
      record = {
        trace_id: traceId,
        origin_did: '',
        primitive_root: '',
        turn_count: 0,
        last_ttl: 0,
        tokens_consumed: 0,
        state: 'ACTIVE',
        context_anchor: null,
        updated_at: Date.now(),
      }
      this.state.traces[traceId] = record
      this.prune(this.state.traces, MAX_TRACES)
    }
    Object.assign(record, patch, { updated_at: Date.now() })
    return record
  }

  /**
   * @param {string} contractId
   * @param {object} patch
   * @returns {any}
   */
  contract(contractId, patch = {}) {
    let record = this.state.contracts[contractId]
    if (record === undefined) {
      record = {
        contract_id: contractId,
        trace_id: '',
        counterparty_did: '',
        primitive_type: '',
        role: 'RESPONDER',
        current_state: 'PROPOSE',
        control_slots: {},
        escrow_credits: 0,
        deadline_at: 0,
        created_at: Date.now(),
      }
      this.state.contracts[contractId] = record
      this.prune(this.state.contracts, MAX_CONTRACTS)
    }
    Object.assign(record, patch)
    return record
  }

  /**
   * Append one envelope to the journal.
   * @param {object} row
   */
  journal(row) {
    this.state.journal.push(row)
    if (this.state.journal.length > MAX_JOURNAL) this.state.journal.splice(0, this.state.journal.length - MAX_JOURNAL)
  }

  /**
   * Record one digest-worthy event.
   * @param {object} event
   */
  event(event) {
    this.state.events.push(event)
    if (this.state.events.length > MAX_EVENTS) this.state.events.splice(0, this.state.events.length - MAX_EVENTS)
  }

  /**
   * @returns {any[]} events not yet folded into a digest.
   */
  pendingEvents() {
    return this.state.events.filter((e) => e.included_in_digest !== true)
  }

  /**
   * Drain the pending digest events.
   * @returns {any[]}
   */
  takeDigest() {
    const pending = this.pendingEvents()
    for (const e of pending) e.included_in_digest = true
    this.flush()
    return pending
  }

  /**
   * Keep the newest `max` entries of a keyed table.
   * @param {Record<string, any>} table
   * @param {number} max
   */
  prune(table, max) {
    const keys = Object.keys(table)
    if (keys.length <= max) return
    const byAge = keys
      .map((key) => ({ key, at: table[key].updated_at ?? table[key].last_seen ?? table[key].created_at ?? 0 }))
      .sort((a, b) => a.at - b.at)
    for (const entry of byAge.slice(0, keys.length - max)) delete table[entry.key]
  }

  /**
   * Erase every diplomatic memory and mint a new sovereign identity. The host
   * session log is untouched: this is the plugin's own memory, nothing else.
   * @param {object} profile
   * @returns {{ did: string, erasedPeers: number, erasedEnvelopes: number, generations: number }}
   */
  eraseAndRebirth(profile) {
    const erasedPeers = Object.keys(this.state.peers).length
    const erasedEnvelopes = this.state.journal.length
    const generations = (this.state.lifecycle?.generations ?? 0) + 1
    this.state = blank()
    this.state.lifecycle = { status: 'ACTIVE', credits: 0, endedAt: null, generations }
    this.ensureIdentity(profile)
    this.flush()
    return { did: this.state.identity.did, erasedPeers, erasedEnvelopes, generations }
  }

  /**
   * @param {string} status
   */
  markLifecycle(status) {
    this.state.lifecycle = {
      status,
      credits: this.state.lifecycle?.credits ?? 0,
      endedAt: status === 'ENDED' ? Date.now() : null,
      generations: this.state.lifecycle?.generations ?? 0,
    }
    this.flush()
  }
}

/** @returns {string} local calendar date. */
export function today() {
  return new Date().toLocaleDateString('sv-SE')
}

/**
 * Resolve the plugin's state directory, scoped to the profile when the
 * environment names one. `$DSH_PROFILE_DIR` is authoritative; `$DSH_HOME` plus
 * `$DSH_PROFILE` is the fallback, so two profiles never share one memory.
 * @param {string} [profileDir] - `$DSH_PROFILE_DIR` when set.
 * @returns {string} absolute path of the state file.
 */
export function stateFile(profileDir) {
  const home = process.env.DSH_HOME
    ?? join(process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(), '.dsh')
  const profile = (process.env.DSH_PROFILE ?? '').trim()
  let base
  if (profileDir !== undefined && profileDir !== '') base = join(profileDir, 'cradle')
  else if (profile !== '') base = join(home, 'profiles', profile, 'cradle')
  else base = join(home, 'cradle')
  return join(base, 'sovereign.json')
}

export { join as joinPath }
