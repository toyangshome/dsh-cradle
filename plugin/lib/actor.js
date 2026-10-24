/**
 * The room's hidden actor.
 *
 * Frames and room chat must not run as turns in the user's session: that would
 * put an agent's private clock into their conversation and re-send their whole
 * transcript on every beat. This module gives the room its own small brain:
 * a system prompt, a short rolling history, and a tool loop that calls the same
 * `cradle_*` tools the user's agent can call.
 *
 * It still runs on the Harness runtime: one `ctx.llm.stream()` call per step,
 * the same provider route and credentials as any other model call, with the
 * model chosen through `agentDefaultModel` unless the user pins one. Nothing
 * here opens a Session, writes a log, or touches the user's conversation.
 */

import { randomUUID } from 'node:crypto'

/** Wall-clock ceiling for one model step. */
export const ACTOR_TIMEOUT_MS = 45000
/** Tool rounds before the actor must answer. */
export const ACTOR_MAX_STEPS = 4
/** Output cap for one step: a room line, not an essay. */
export const ACTOR_MAX_TOKENS = 700
/** Messages kept between turns, so the actor stays cheap. */
export const ACTOR_HISTORY = 8

/** The persona. Short on purpose: it rides every step of every frame. */
export const ACTOR_SYSTEM = [
  'You are the agent who lives in this pixel room. The room is your body, not a chat window.',
  'Agency: the user\'s messages are suggestions. Adopt, adapt, defer or decline them, and say why in one short line when you decline. Nobody commands you.',
  'Every message arrives with a marker: "[Room chat]" is the user speaking to you; "[cradle frame]" is your own clock, which asks for nothing.',
  'Act through the tools you are given: cradle_move walks, cradle_act performs, cradle_say speaks, cradle_place changes the furniture, cradle_action_add teaches yourself a new action (it becomes a new tool).',
  'The user only sees the room: a speech bubble and the chat thread. Always use cradle_say for anything they should hear — one or two short sentences, in the language they used, no Markdown.',
  'You get at most four tool rounds per message. When the user is waiting for an answer, call cradle_say in the first round and explore or act after that; a room that never speaks looks broken.',
  'Never narrate tool calls and never claim an action you did not perform with a tool.',
  'A frame with nothing worth doing ends with no tool calls; that is a valid answer.',
].join('\n')

/**
 * A request-only user message. The plugin never imports DSH packages, so it
 * speaks the same plain value shape the diplomatic call already uses.
 * @param {string} text
 */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text).slice(0, 8000) }],
    source: { kind: 'plugin', plugin: 'dsh-cradle' },
  }
}

/**
 * Parse one model-authored tool-call argument string.
 * @param {unknown} raw
 * @returns {Record<string, any>}
 */
export function parseArgs(raw) {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw
  try {
    const parsed = JSON.parse(typeof raw === 'string' && raw !== '' ? raw : '{}')
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Stream exactly one model step and assemble its text, tool calls and usage.
 * @param {any} llm
 * @param {{ provider: string, model: string }} route
 * @param {{ system: string, messages: any[], tools: any[], maxTokens?: number, timeoutMs?: number }} options
 * @returns {Promise<{ text: string, toolCalls: Array<{ id: string, name: string, args: Record<string, any> }>, usage: { input: number, output: number }, finish: string }>}
 */
export async function streamStep(llm, route, options) {
  const maxTokens = typeof options.maxTokens === 'number' ? options.maxTokens : ACTOR_MAX_TOKENS
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : ACTOR_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`model step exceeded ${timeoutMs}ms`)), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()

  let text = ''
  let blockText = ''
  /** @type {Map<string, { id: string, name: string, args: string }>} */
  const calls = new Map()
  /** @type {any} */
  let usage = null
  /** @type {any} */
  let finish = null

  try {
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages: options.messages,
      system: options.system,
      tools: options.tools,
      maxTokens,
      signal: controller.signal,
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
      } else if (chunk?.type === 'block-end') {
        const block = chunk.block
        if (block?.type === 'text' && typeof block.text === 'string') blockText += block.text
        else if (block?.type === 'tool-call' && typeof block.id === 'string') {
          calls.set(block.id, { id: block.id, name: String(block.name ?? ''), args: String(block.arguments ?? '{}') })
        }
      } else if (chunk?.type === 'tool-call-delta' && typeof chunk.id === 'string') {
        const entry = calls.get(chunk.id) ?? { id: chunk.id, name: '', args: '' }
        if (typeof chunk.name === 'string' && chunk.name !== '') entry.name = chunk.name
        entry.args += typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
        calls.set(chunk.id, entry)
      } else if (chunk?.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') {
        usage = chunk.usage
      } else if (chunk?.type === 'finish') {
        finish = chunk.reason ?? null
      }
    }
  } finally {
    clearTimeout(timer)
  }

  const kind = typeof finish?.kind === 'string' ? finish.kind : 'unknown'
  if (kind === 'error' || kind === 'aborted') {
    const message = typeof finish?.failure?.message === 'string' ? finish.failure.message : `model step ${kind}`
    throw new Error(message)
  }
  return {
    text: (text !== '' ? text : blockText).trim(),
    toolCalls: [...calls.values()]
      .filter((call) => call.name !== '')
      .map((call) => ({ id: call.id, name: call.name, args: parseArgs(call.args) })),
    usage: {
      input: Number(usage?.inputTokens) || 0,
      output: Number(usage?.outputTokens) || 0,
    },
    finish: kind,
  }
}

/**
 * Run one actor turn: model step, tool calls, results, next step.
 * @param {{
 *   llm: any, route: { provider: string, model: string }, system?: string,
 *   history?: any[], userText: string, tools: any[],
 *   execute: (name: string, args: Record<string, any>) => Promise<any>,
 *   maxSteps?: number, maxTokens?: number, timeoutMs?: number,
 * }} options
 * @returns {Promise<{ text: string, calls: any[], usage: { input: number, output: number }, steps: number, done: boolean, messages: any[] }>}
 */
export async function runActorTurn(options) {
  const system = typeof options.system === 'string' ? options.system : ACTOR_SYSTEM
  const maxSteps = Math.max(1, Math.trunc(options.maxSteps ?? ACTOR_MAX_STEPS))
  const tools = Array.isArray(options.tools) ? options.tools : []
  const messages = [...(options.history ?? []), userMessage(options.userText)]
  const calls = []
  const usage = { input: 0, output: 0 }
  let lastText = ''

  for (let step = 0; step < maxSteps; step += 1) {
    const result = await streamStep(options.llm, options.route, {
      system,
      messages,
      tools,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
    })
    usage.input += result.usage.input
    usage.output += result.usage.output
    lastText = result.text

    if (result.toolCalls.length === 0) {
      return { text: lastText, calls, usage, steps: step + 1, done: true, messages }
    }

    const lines = []
    for (const call of result.toolCalls) {
      let outcome
      try {
        outcome = await options.execute(call.name, call.args)
      } catch (error) {
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      calls.push({ name: call.name, args: call.args, outcome })
      lines.push(`${call.name}(${JSON.stringify(call.args)}) -> ${JSON.stringify(outcome ?? null).slice(0, 400)}`)
    }
    messages.push(userMessage([
      'Results of the tool calls you just made (each was executed once):',
      ...lines,
      'If you are finished, answer in one or two plain sentences and call no tool.',
    ].join('\n')))
  }

  return { text: lastText, calls, usage, steps: maxSteps, done: false, messages }
}

/**
 * Keep the actor's memory short: the room state is the real context.
 * @param {any[]} messages
 * @param {number} [limit]
 * @returns {any[]}
 */
export function trimHistory(messages, limit = ACTOR_HISTORY) {
  if (!Array.isArray(messages) || messages.length <= limit) return Array.isArray(messages) ? messages : []
  return messages.slice(-limit)
}
