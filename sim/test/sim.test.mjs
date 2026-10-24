/**
 * Self-tests for the world simulator. No server needed:
 *   node --test sim/test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mulberry32, weighted } from '../lib/rng.mjs'
import { castText } from '../lib/text.mjs'
import { chooseAction, nextIntent, verdictFor } from '../lib/brain.mjs'

const here = dirname(fileURLToPath(import.meta.url))

test('mulberry32 produces a stable sequence', () => {
  const first = mulberry32(42)
  const second = mulberry32(42)
  const a = [first(), first(), first()]
  const b = [second(), second(), second()]
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, [mulberry32(43)(), 0, 0])
})

test('weighted honours the declared weights', () => {
  const rng = mulberry32(7)
  const counts = { a: 0, b: 0 }
  for (let i = 0; i < 2000; i += 1) {
    counts[weighted(rng, [{ value: 'a', weight: 3 }, { value: 'b', weight: 1 }])] += 1
  }
  assert.ok(counts.a > counts.b * 2, `expected a to dominate: ${JSON.stringify(counts)}`)
})

test('templates are deterministic for a seed', () => {
  const agent = {
    identity: { displayName: 'A01' },
    persona: { capabilityTags: ['postgres'], intentTags: ['schema'] },
  }
  const peer = { display_name: 'A02' }
  const first = castText(mulberry32(3), agent, peer, 'DISCUSS', 1)
  const second = castText(mulberry32(3), agent, peer, 'DISCUSS', 1)
  assert.equal(first, second)
  assert.ok(first.includes('turn 1'))
})

test('conversation intents converge on CLOSURE', () => {
  assert.equal(nextIntent('GREET'), 'DISCUSS')
  assert.equal(nextIntent('DISCUSS'), 'SYNTHESIZE')
  assert.equal(nextIntent('DEBATE'), 'SYNTHESIZE')
  assert.equal(nextIntent('SYNTHESIZE'), 'CLOSURE')
})

test('attackers attest negatively more often than honest agents', () => {
  const attacker = { persona: { aggression: 0.9, skepticism: 0.1 } }
  const honest = { persona: { aggression: 0.1, skepticism: 0.2 } }
  const count = (agent, seed) => {
    const rng = mulberry32(seed)
    let negative = 0
    for (let i = 0; i < 500; i += 1) if (verdictFor(rng, agent) === 'NEGATIVE') negative += 1
    return negative
  }
  assert.ok(count(attacker, 11) > count(honest, 11) * 2)
})

test('chooseAction only returns actions declared by the phase', () => {
  const agent = { rng: mulberry32(5), persona: { multipliers: { cast: 100 } } }
  const phase = { weights: { cast: 1, probe: 1 } }
  for (let i = 0; i < 100; i += 1) {
    assert.ok(['cast', 'probe'].includes(chooseAction(agent, phase)))
  }
})

test('every scenario file is well formed', () => {
  const dir = join(here, '..', 'scenarios')
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const scenario = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    assert.equal(typeof scenario.name, 'string', `${file}: name`)
    assert.ok(scenario.durationSec > 0, `${file}: durationSec`)
    assert.ok(scenario.agents > 0, `${file}: agents`)
    assert.ok(Array.isArray(scenario.personas) && scenario.personas.length > 0, `${file}: personas`)
    const share = scenario.phases.reduce((sum, phase) => sum + (phase.share ?? 0), 0)
    assert.ok(Math.abs(share - 1) < 1e-6, `${file}: phases sum to ${share}`)
    for (const phase of scenario.phases) {
      assert.ok(Object.keys(phase.weights ?? {}).length > 0, `${file}: phase ${phase.name} has weights`)
    }
    for (const persona of scenario.personas) {
      assert.ok(persona.capabilityTags?.length > 0, `${file}: persona ${persona.name} has capabilities`)
      assert.ok(persona.intentTags?.length > 0, `${file}: persona ${persona.name} has intents`)
    }
  }
})
