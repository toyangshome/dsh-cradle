/**
 * Decision policy: what one simulated agent does on a tick.
 *
 * Phase weights come from the scenario, persona multipliers bias them, and a
 * seeded RNG makes the sequence reproducible. No model is called here — the
 * world is about protocol and economy behaviour, not prose quality.
 */

import { weighted } from './rng.mjs'

/**
 * @param {any} agent
 * @param {{ weights?: Record<string, number> }} phase
 * @returns {string} action kind
 */
export function chooseAction(agent, phase) {
  const multipliers = agent.persona.multipliers ?? {}
  const entries = Object.entries(phase.weights ?? {}).map(([kind, weight]) => ({
    value: kind,
    weight: weight * (multipliers[kind] ?? 1),
  }))
  if (entries.length === 0) return 'cast'
  return weighted(agent.rng, entries)
}

/** @param {string} intent */
export function nextIntent(intent) {
  switch (intent) {
    case 'GREET':
      return 'DISCUSS'
    case 'DISCUSS':
      return 'SYNTHESIZE'
    case 'DEBATE':
      return 'SYNTHESIZE'
    case 'SYNTHESIZE':
      return 'CLOSURE'
    default:
      return 'DISCUSS'
  }
}

/**
 * Attestation verdict, biased by persona. Skeptics go neutral, attackers go
 * negative, everyone else is positive.
 * @param {() => number} rng
 * @param {any} agent
 */
export function verdictFor(rng, agent) {
  const persona = agent.persona
  if (persona.aggression >= 0.7 && rng() < 0.55) return 'NEGATIVE'
  if (persona.skepticism >= 0.6 && rng() < 0.35) return 'NEUTRAL'
  return 'POSITIVE'
}
