/**
 * Unit tests for the model half: catalog listing, route resolution, and the
 * constrained diplomatic generation call. No provider is contacted.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DIPLOMAT_SYSTEM, REPLY_MAX_CHARS, buildPrompt, estimateTokens, generateReply,
  listCatalog, normalizeReplyText, resolveRoute,
} from '../plugin/lib/model.js'

/** A stream that yields the given chunks in order. */
async function* chunksOf(list) {
  for (const chunk of list) yield chunk
}

/** A fake LLM service over one canned stream. */
function fakeLlm(list, captured = {}) {
  return {
    stream(options) {
      captured.options = options
      return chunksOf(list)
    },
  }
}

test('listCatalog groups models per provider and isolates a failure', async () => {
  const llm = {
    listProviders: () => [
      { id: 'wb-proxy', name: 'WB Proxy' },
      { id: 'broken', name: 'Broken' },
    ],
    listModels: async (provider) => {
      if (provider === 'broken') throw new Error('no key')
      return [{ id: 'glm-5.3', name: 'GLM 5.3' }, { id: 'kimi-k2.6' }]
    },
  }
  const catalog = await listCatalog(llm)
  assert.equal(catalog.groups.length, 1)
  assert.deepEqual(catalog.groups[0].models, [
    { id: 'glm-5.3', name: 'GLM 5.3' },
    { id: 'kimi-k2.6', name: 'kimi-k2.6' },
  ])
  assert.deepEqual(catalog.failures, [{ id: 'broken', name: 'Broken', message: 'no key' }])
})

test('listCatalog tolerates a missing LLM service', async () => {
  assert.deepEqual(await listCatalog(undefined), { groups: [], failures: [] })
})

test('resolveRoute prefers the pinned pair, then the DSH default', () => {
  const pinned = resolveRoute({ provider: 'wb-proxy', model: 'glm-5.3' }, undefined)
  assert.deepEqual(pinned, { provider: 'wb-proxy', model: 'glm-5.3', source: 'pinned' })

  const fallback = resolveRoute({}, { currentSelection: () => ({ provider: 'wb-proxy', model: 'deepseek-v4.1-flash' }) })
  assert.deepEqual(fallback, { provider: 'wb-proxy', model: 'deepseek-v4.1-flash', source: 'dsh-default' })

  assert.equal(resolveRoute({}, undefined), null)
  assert.equal(resolveRoute({}, { currentSelection: () => { throw new Error('gone') } }), null)
  assert.equal(resolveRoute({}, { currentSelection: () => ({ provider: '', model: '' }) }), null)
})

test('buildPrompt frames the envelope as bounded data', () => {
  const prompt = buildPrompt({
    primitive: 'CAST',
    sender: { display_name: 'Peer', bio: 'b'.repeat(1000) },
    payload: { control_slots: { intent: 'DISCUSS' }, free_text: 'f'.repeat(9000) },
  }, { displayName: 'Me', bio: '', capabilityTags: ['research'] })

  const json = prompt.slice(prompt.indexOf('{'))
  const parsed = JSON.parse(json)
  assert.equal(parsed.primitive, 'CAST')
  assert.equal(parsed.free_text.length, 2000)
  assert.equal(parsed.sender.bio.length, 400)
  assert.deepEqual(parsed.you.capability_tags, ['research'])
})

test('normalizeReplyText strips fences and quotes and bounds the length', () => {
  assert.equal(normalizeReplyText('  hello  '), 'hello')
  assert.equal(normalizeReplyText('```text\nhi\n```'), 'hi')
  assert.equal(normalizeReplyText('"quoted"'), 'quoted')
  assert.equal(normalizeReplyText('x'.repeat(5000)).length, REPLY_MAX_CHARS)
  assert.equal(normalizeReplyText(undefined), '')
})

test('generateReply assembles text and reports provider usage', async () => {
  const captured = {}
  const llm = fakeLlm([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Well met, ' },
    { type: 'text-delta', index: 0, text: 'peer.' },
    { type: 'usage', usage: { inputTokens: 300, outputTokens: 12, totalTokens: 312 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ], captured)

  const result = await generateReply(llm, { provider: 'wb-proxy', model: 'glm-5.3' }, { prompt: 'answer this' })
  assert.deepEqual(result, { text: 'Well met, peer.', tokens: 312, finish: 'stop' })
  assert.equal(captured.options.provider, 'wb-proxy')
  assert.equal(captured.options.model, 'glm-5.3')
  assert.equal(captured.options.system, DIPLOMAT_SYSTEM)
  assert.equal(captured.options.messages[0].role, 'user')
  assert.deepEqual(captured.options.messages[0].content, [{ type: 'text', text: 'answer this' }])
})

test('generateReply estimates tokens when the adapter reports no usage', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', index: 0, text: 'Short answer.' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const result = await generateReply(llm, { provider: 'p', model: 'm' }, { prompt: 'x'.repeat(40) })
  assert.equal(result.text, 'Short answer.')
  assert.equal(result.tokens, estimateTokens('x'.repeat(40)) + estimateTokens('Short answer.'))
})

test('generateReply rejects a failed or empty model answer', async () => {
  const failed = fakeLlm([
    { type: 'finish', reason: { kind: 'error', failure: { message: 'RATE_LIMIT' } } },
  ])
  await assert.rejects(
    () => generateReply(failed, { provider: 'p', model: 'm' }, { prompt: 'x' }),
    /RATE_LIMIT/,
  )

  const empty = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }])
  await assert.rejects(
    () => generateReply(empty, { provider: 'p', model: 'm' }, { prompt: 'x' }),
    /no text/,
  )
})

test('generateReply falls back to whole blocks when an adapter sends no deltas', async () => {
  const llm = fakeLlm([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Whole block answer.' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const result = await generateReply(llm, { provider: 'p', model: 'm' }, { prompt: 'x' })
  assert.equal(result.text, 'Whole block answer.')
})

test('generateReply keeps a max-tokens answer instead of failing it', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', index: 0, text: 'Partial but useful.' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ])
  const result = await generateReply(llm, { provider: 'p', model: 'm' }, { prompt: 'x' })
  assert.equal(result.text, 'Partial but useful.')
  assert.equal(result.finish, 'max-tokens')
})
