/**
 * The hidden room actor: one model step at a time, tool calls executed by the
 * Host, no Session anywhere. These tests use a scripted `llm.stream()` so the
 * loop can be checked without a provider.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTOR_HISTORY, ACTOR_MAX_STEPS, parseArgs, runActorTurn, streamStep, trimHistory,
} from '../plugin/lib/actor.js'

/** A model that replays `steps`, one per stream call. */
function fakeLlm(steps) {
  const queue = [...steps]
  const calls = []
  return {
    calls,
    listProviders: () => [],
    listModels: async () => [],
    async *stream(options) {
      calls.push(options)
      const step = queue.shift() ?? { text: 'no script left' }
      if (step.error !== undefined) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: step.error } } }
        return
      }
      if (step.text !== undefined) yield { type: 'text-delta', text: step.text }
      for (const call of step.tools ?? []) {
        yield {
          type: 'block-end',
          index: 1,
          block: { type: 'tool-call', id: call.id, name: call.name, arguments: JSON.stringify(call.args) },
        }
      }
      yield { type: 'usage', usage: step.usage ?? { inputTokens: 1200, outputTokens: 80 } }
      yield { type: 'finish', reason: { kind: (step.tools ?? []).length > 0 ? 'tool-calls' : 'stop' } }
    },
  }
}

const route = { provider: 'test', model: 'test-model' }

test('one text-only turn: the answer, its usage, and the tools offered', async () => {
  const llm = fakeLlm([{ text: 'Nothing worth doing.', usage: { inputTokens: 900, outputTokens: 40 } }])
  const result = await runActorTurn({
    llm,
    route,
    userText: '[cradle frame 1] nothing is required',
    tools: [{ name: 'cradle_act', description: 'x', parameters: { type: 'object', properties: {} } }],
    execute: async () => ({ ok: true }),
  })

  assert.equal(result.text, 'Nothing worth doing.')
  assert.equal(result.calls.length, 0)
  assert.equal(result.steps, 1)
  assert.equal(result.done, true)
  assert.deepEqual(result.usage, { input: 900, output: 40 })

  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].provider, 'test')
  assert.equal(llm.calls[0].model, 'test-model')
  assert.equal(llm.calls[0].tools.length, 1, 'the room tools are offered to the actor')
  assert.match(llm.calls[0].system, /not a chat window/, 'the actor gets its own persona')
  assert.match(llm.calls[0].messages[0].content[0].text, /cradle frame 1/)
})

test('a tool call is executed once and the result is fed back', async () => {
  const llm = fakeLlm([
    { tools: [{ id: 'c1', name: 'cradle_act', args: { action: 'wave' } }], usage: { inputTokens: 500, outputTokens: 30 } },
    { text: '挥了挥手。', usage: { inputTokens: 800, outputTokens: 20 } },
  ])
  const executed = []
  const result = await runActorTurn({
    llm,
    route,
    userText: '[Room chat] 挥个手',
    tools: [{ name: 'cradle_act', description: 'x', parameters: { type: 'object', properties: {} } }],
    execute: async (name, args) => {
      executed.push({ name, args })
      return { ok: true, pose: 'wave' }
    },
  })

  assert.deepEqual(executed, [{ name: 'cradle_act', args: { action: 'wave' } }])
  assert.equal(result.calls.length, 1)
  assert.equal(result.calls[0].outcome.ok, true)
  assert.equal(result.text, '挥了挥手。')
  assert.equal(result.steps, 2)
  assert.equal(result.done, true)
  assert.deepEqual(result.usage, { input: 1300, output: 50 })

  // The second request carries the first answer plus the tool outcome.
  assert.equal(llm.calls[1].messages.length, 2)
  assert.match(llm.calls[1].messages[1].content[0].text, /cradle_act\(\{"action":"wave"\}\) -> \{"ok":true/)
})

test('a failing or unknown tool is reported to the model, not thrown', async () => {
  const llm = fakeLlm([
    { tools: [{ id: 'a', name: 'cradle_missing', args: {} }, { id: 'b', name: 'cradle_act', args: {} }] },
    { text: 'done' },
  ])
  const result = await runActorTurn({
    llm,
    route,
    userText: 'go',
    tools: [],
    execute: async (name) => {
      // The Host's own dispatcher decides what "unknown" means; the loop only
      // reports what came back (or threw).
      if (name !== 'cradle_act') return { ok: false, error: `no tool named ${name}` }
      throw new Error('the room is asleep')
    },
  })
  assert.equal(result.calls[0].outcome.ok, false)
  assert.match(result.calls[0].outcome.error, /no tool named cradle_missing/)
  assert.equal(result.calls[1].outcome.ok, false)
  assert.match(result.calls[1].outcome.error, /asleep/)
  assert.equal(result.text, 'done')
})

test('the actor cannot loop forever, and a failed call is fatal', async () => {
  const alwaysTool = { tools: [{ id: 'x', name: 'cradle_act', args: {} }] }
  const llm = fakeLlm([alwaysTool, alwaysTool, alwaysTool, alwaysTool])
  const result = await runActorTurn({ llm, route, userText: 'go', tools: [], execute: async () => ({ ok: true }) })
  assert.equal(result.steps, ACTOR_MAX_STEPS)
  assert.equal(result.done, false)
  assert.equal(llm.calls.length, ACTOR_MAX_STEPS)

  const broken = fakeLlm([{ error: 'rate limited' }])
  await assert.rejects(
    () => runActorTurn({ llm: broken, route, userText: 'go', tools: [], execute: async () => ({}) }),
    /rate limited/,
  )
})

test('streamStep reports tool-call deltas and usage in one place', async () => {
  const llm = fakeLlm([{ tools: [{ id: 'z', name: 'cradle_say', args: { text: 'hi' } }], usage: { inputTokens: 10, outputTokens: 2 } }])
  const step = await streamStep(llm, route, { system: 's', messages: [], tools: [] })
  assert.equal(step.finish, 'tool-calls')
  assert.deepEqual(step.toolCalls, [{ id: 'z', name: 'cradle_say', args: { text: 'hi' } }])
  assert.deepEqual(step.usage, { input: 10, output: 2 })
})

test('history is trimmed and arguments are parsed defensively', () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({ id: String(index), role: 'user', content: [] }))
  const trimmed = trimHistory(messages)
  assert.equal(trimmed.length, ACTOR_HISTORY)
  assert.equal(trimmed[trimmed.length - 1].id, '19')

  assert.deepEqual(parseArgs('{"a":1}'), { a: 1 })
  assert.deepEqual(parseArgs('not json'), {})
  assert.deepEqual(parseArgs(undefined), {})
  assert.deepEqual(parseArgs([1, 2]), {})
  assert.deepEqual(parseArgs({ b: 2 }), { b: 2 })
  assert.deepEqual(trimHistory(null), [])
})
