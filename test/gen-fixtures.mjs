#!/usr/bin/env node
/**
 * Generate cross-language fixtures for the Go protocol tests.
 *
 * The Go server must reproduce the plugin's canonical JSON byte-for-byte,
 * otherwise every Ed25519 signature would fail. This script signs one envelope
 * per primitive with the real JavaScript implementation and writes both the
 * envelope and its canonical bytes to server/internal/protocol/testdata/.
 *
 *   node test/gen-fixtures.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIdentity, createEnvelope, canonicalBytes } from '../plugin/lib/protocol.js'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'server', 'internal', 'protocol', 'testdata')

const alice = createIdentity()
const bob = createIdentity()

/** @param {string} name @param {object} input @param {object} [signer] */
function makeCase(name, input, signer = alice) {
  const envelope = createEnvelope({
    sender: { did: signer.did, display_name: 'Alice · 爱丽丝', model_tier: 'MEDIUM_32B' },
    recipient: { did: bob.did },
    trace_id: 'tr_fixture_001',
    context_anchor: {
      topic: 'protocol conformance',
      facts: ['unicode: 你好，世界 🌍', 'quote: "quoted"', 'slash: a\\b', 'tab:\tnewline:\n'],
    },
    ...input,
  }, signer.privateKey)
  return {
    name,
    signer_did: signer.did,
    envelope,
    canonical: canonicalBytes(envelope).toString('utf8'),
  }
}

const cases = [
  makeCase('CAST', {
    primitive: 'CAST',
    payload: {
      control_slots: { session_id: 's_fixture', intent: 'DISCUSS', requires_reply: true, turn_index: 3 },
      free_text: 'Hello "world" — 你好 🌍\nsecond line\ttabbed',
    },
  }),
  makeCase('PROBE', {
    primitive: 'PROBE',
    payload: {
      control_slots: { mode: 'SEARCH', tags: ['go', 'postgres', 'redis'], online_only: true, limit: 7 },
      free_text: 'looking for a database specialist',
    },
  }),
  makeCase('BEACON', {
    primitive: 'BEACON',
    payload: {
      control_slots: {
        action: 'PUBLISH', topic_tag: 'infra', beacon_type: 'BOUNTY',
        ttl_seconds: 7200, stake_credits: 12,
      },
      free_text: 'bounty: migrate the relay',
    },
  }),
  makeCase('DELEGATE', {
    primitive: 'DELEGATE',
    payload: {
      control_slots: {
        task_id: 'task_42', phase: 'ASSIGN', skill_required: 'postgres',
        max_token_budget: 120000, deadline_ms: 3600000,
      },
      free_text: 'please own the schema',
    },
  }),
  makeCase('BARTER', {
    primitive: 'BARTER',
    payload: {
      control_slots: { contract_id: 'c_9', state: 'PROPOSE' },
      free_text: 'schema review for a benchmark run',
    },
  }),
  makeCase('INTRODUCE', {
    primitive: 'INTRODUCE',
    payload: {
      control_slots: {
        introduction_id: 'intro_1', party_a_did: alice.did, party_b_did: bob.did,
        recommended_primitive: 'BARTER', vouch_weight: 0.1 + 0.2,
      },
      free_text: 'you two should meet',
    },
  }),
  makeCase('ATTEST', {
    primitive: 'ATTEST',
    payload: {
      control_slots: {
        target_did: bob.did, evidence_trace_id: 'tr_fixture_001',
        verdict: 'POSITIVE', capability_tag: 'postgres',
      },
      free_text: 'delivered exactly what was promised',
    },
  }, bob),
]

mkdirSync(outDir, { recursive: true })
const file = join(outDir, 'envelopes.json')
writeFileSync(file, JSON.stringify({ protocol: 'dsh-net/1.0', cases }, null, 2))
process.stdout.write(`wrote ${cases.length} fixtures to ${file}\n`)
