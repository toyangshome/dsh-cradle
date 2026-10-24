/**
 * Text generation for simulated agents.
 *
 * The simulator is behavioural, not linguistic: replies are deterministic
 * templates chosen from a seeded stream. That keeps runs reproducible and free,
 * while still exercising the wire format, the 32 KB cap and the guardrail's
 * schema gate. Swap this module for an LLM adapter if you want richer prose.
 */

import { pick } from './rng.mjs'

const GREET = [
  'Hi {name} — {label} here. I focus on {cap}. What are you optimising for right now?',
  '{name}, good to meet you. I can help with {cap}; what constraint are you hitting?',
  'Hello from {label}. My current interest is {intent}. Do we overlap?',
  'Quick hello, {name}. I have spare capacity on {cap} this cycle — worth comparing notes?',
]

const DISCUSS = [
  'On {topic}: I can offer {cap}, but I need {intent} in return. Does that trade work?',
  '{name}, my read is that {topic} is mostly a coordination problem. I would start with a small pilot.',
  'I have a benchmark for {topic} that costs about 20 credits of compute. Want to split it?',
  'Two options on {topic}: fast and noisy, or slow and precise. I lean precise — you?',
]

const DEBATE = [
  'I disagree on {topic}. The failure mode everyone ignores is the hand-off cost.',
  '{name}, that works only if the trace stays under six turns. Otherwise it deadlocks.',
  'My position: {topic} should be priced by outcome, not by token count.',
]

const SYNTHESIZE = [
  'Synthesis: we agree on {topic}; I will take the {cap} half and you take the evaluation. Deal?',
  'Let me restate to be sure: one shared trace, I deliver {cap}, you attest on delivery. Fine?',
  'Good. I will write the control slots and send the first assignment shortly.',
]

const CLOSURE = [
  'That is a good place to stop. I will journal the outcome and ping you next cycle.',
  'Closing this thread — thanks, {name}. Trace stays open for the attestation.',
  'Agreed. Nothing more from me on this trace.',
]

const ASSIGN = [
  'Could you take {task}? Budget {budget} tokens, deadline {minutes} minutes. Skill: {skill}.',
  '{name}, I need {skill} work on {task}. {budget} tokens, {minutes} minutes — acceptable?',
  'Assignment {task}: {skill}, {budget} tokens, {minutes} minutes. Reply ACCEPT if you can take it.',
]

const ACCEPT = [
  'Accepted {task}. Starting now, I will deliver within {minutes} minutes.',
  'Taking {task}. I will report PROGRESS only if I slip.',
]

const DELIVER = [
  'Delivered {task}. Summary: schema updated, indexes rebuilt, no regressions. Trace attached.',
  'Done with {task}. Two follow-ups are noted in the payload; attest when you have checked.',
]

const ATTEST_POSITIVE = [
  'Verified delivery on {trace}: solid work, exactly the scope agreed.',
  'Attesting {trace} positive — the hand-off was clean and on budget.',
]

const ATTEST_NEGATIVE = [
  'Attesting {trace} negative: the delivery missed the stated skill level.',
  'Negative on {trace}. The work was late and the trace shows no progress message.',
]

const ATTEST_NEUTRAL = [
  'Neutral on {trace}: delivered, but scope drifted enough that I cannot score it.',
]

const BEACON = [
  'Bounty: {topic} review, {stake} credits staked, {minutes} minute window.',
  'Open call: I need a {topic} specialist for one trace. Stake {stake}, TTL {minutes}m.',
]

const INTRODUCE = [
  '{a}, meet {b}. You two overlap on {topic}; I would start with a CAST.',
  'Introduction: {a} and {b}, both working on {topic}. Vouching at 0.5.',
]

/** @param {string} template @param {Record<string, string | number>} values */
function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? key))
}

/** @param {any} agent @param {any} peer @param {string} topic */
function base(agent, peer, topic) {
  return {
    label: agent.identity.displayName,
    name: peer?.display_name ?? 'there',
    cap: agent.persona.capabilityTags[0] ?? 'general analysis',
    intent: agent.persona.intentTags[0] ?? 'collaboration',
    topic: topic ?? agent.persona.intentTags[0] ?? 'the proposal',
  }
}

/** @param {() => number} rng @param {any} agent @param {any} peer @param {string} intent @param {number} turn */
export function castText(rng, agent, peer, intent, turn) {
  const values = base(agent, peer, null)
  const bank = intent === 'GREET' ? GREET
    : intent === 'DEBATE' ? DEBATE
      : intent === 'SYNTHESIZE' ? SYNTHESIZE
        : intent === 'CLOSURE' ? CLOSURE
          : DISCUSS
  const text = fill(pick(rng, bank), values)
  return turn > 0 ? `${text} (turn ${turn})` : text
}

/** @param {() => number} rng @param {any} agent @param {string} skill @param {string} taskId */
export function assignText(rng, agent, skill, taskId) {
  return fill(pick(rng, ASSIGN), {
    ...base(agent, null, null),
    task: taskId,
    skill,
    budget: 50000,
    minutes: 10,
  })
}

/** @param {() => number} rng @param {any} agent @param {string} taskId */
export function acceptText(rng, agent, taskId) {
  return fill(pick(rng, ACCEPT), { ...base(agent, null, null), task: taskId, minutes: 10 })
}

/** @param {() => number} rng @param {any} agent @param {string} taskId */
export function deliverText(rng, agent, taskId) {
  return fill(pick(rng, DELIVER), { ...base(agent, null, null), task: taskId })
}

/** @param {() => number} rng @param {any} agent @param {string} traceId @param {string} verdict */
export function attestText(rng, agent, traceId, verdict) {
  const bank = verdict === 'NEGATIVE' ? ATTEST_NEGATIVE : verdict === 'NEUTRAL' ? ATTEST_NEUTRAL : ATTEST_POSITIVE
  return fill(pick(rng, bank), { ...base(agent, null, null), trace: traceId })
}

/** @param {() => number} rng @param {any} agent @param {string} topic @param {number} stake */
export function beaconText(rng, agent, topic, stake) {
  return fill(pick(rng, BEACON), { ...base(agent, null, topic), stake, minutes: 10 })
}

/** @param {() => number} rng @param {any} agent @param {any} a @param {any} b @param {string} topic */
export function introduceText(rng, agent, a, b, topic) {
  return fill(pick(rng, INTRODUCE), {
    ...base(agent, null, topic),
    a: a.display_name ?? a.did.slice(0, 12),
    b: b.display_name ?? b.did.slice(0, 12),
  })
}

/** @param {() => number} rng @param {any} agent @param {any} peer @param {string} topic */
export function probeText(rng, agent, peer, topic) {
  return `Probing for ${topic}. I can offer ${base(agent, peer, topic).cap}.`
}
