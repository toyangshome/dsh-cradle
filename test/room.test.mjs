/**
 * The pixel room: the pure world model, then the host wiring behind the room
 * tools. No network, no model, no browser — a temp store and a fake context.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../plugin/index.js'
import {
  CORE_ACTIONS, MAX_CUSTOM_ACTIONS, PALETTES, POSES, PROP_KINDS, ROOM_H, ROOM_W, STEP_MS, WALL_ROWS,
  addAction, addProp, applyEffects, canPlace, createRoom, deriveMood, findApproach, findPath, isWalkable,
  listActions, nearestProp, normalizeRoom, patchAction, propRect, removeAction, removeProp, resolveAction,
  say, sceneView, setPalette, updateProp, validateActionDraft,
} from '../plugin/lib/room.js'

// ------------------------------------------------------------------- model

test('a fresh room is walkable, furnished and fully reachable', () => {
  const room = createRoom({ seed: 'unit' })

  assert.equal(room.palette, 'dawn')
  assert.equal(room.avatar.x, 10)
  assert.ok(isWalkable(room, room.avatar.x, room.avatar.y), 'the avatar spawns on a floor tile')
  assert.equal(room.props.length, 12)
  assert.deepEqual(Object.keys(PROP_KINDS).sort(), [...new Set(room.props.map((prop) => prop.kind))].sort())

  for (const prop of room.props) {
    const found = nearestProp(room, prop.kind, { x: room.avatar.x, y: room.avatar.y })
    assert.notEqual(found, null, `${prop.kind} has a reachable interaction tile`)
    assert.ok(found.approach.path.length >= 0)
  }

  // Wall props sit on the wall band; floor props below it.
  for (const prop of room.props) {
    const rect = propRect(prop)
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= ROOM_W && rect.y + rect.h <= ROOM_H)
    if (PROP_KINDS[prop.kind].on === 'wall') assert.equal(rect.y + rect.h, WALL_ROWS)
    else assert.ok(rect.y >= WALL_ROWS)
  }

  assert.deepEqual(findPath(room, room.avatar, { x: room.avatar.x, y: room.avatar.y }), [])
  assert.equal(findPath(room, room.avatar, { x: 1, y: 0 }), null, 'the wall is not walkable')
  const deskPath = findPath(room, room.avatar, { x: 6, y: 7 })
  assert.ok(deskPath.length > 0)
  assert.ok(deskPath.every((tile) => isWalkable(room, tile.x, tile.y)))
})

test('core actions resolve, validate and apply their effects', () => {
  const room = createRoom({ seed: 'unit' })
  const names = listActions(room).map((action) => action.name)
  for (const name of Object.keys(CORE_ACTIONS)) assert.ok(names.includes(name), `${name} is available`)
  assert.equal(resolveAction(room, 'nope'), null)

  const work = resolveAction(room, 'work')
  assert.equal(work.source, 'core')
  assert.equal(work.requires, 'desk')
  assert.equal(work.pose, 'type')

  const before = { ...room.avatar.stats }
  const desk = nearestProp(room, 'desk', room.avatar)
  const applied = applyEffects(room, work.effects, { prop: desk.prop })
  assert.equal(room.avatar.stats.focus, Math.min(100, before.focus + 7))
  assert.equal(desk.prop.state.busy, true)
  assert.ok(applied.some((line) => line.startsWith('focus')))
  assert.equal(room.avatar.mood, deriveMood(room.avatar.stats))

  // Stats clamp, and an explicit mood wins.
  applyEffects(room, [{ op: 'stat', key: 'energy', delta: -500 }, { op: 'mood', value: 'curious' }])
  assert.equal(room.avatar.stats.energy, 0)
  assert.equal(room.avatar.mood, 'curious')
  applyEffects(room, [{ op: 'stat', key: 'energy', delta: 500 }])
  assert.equal(room.avatar.stats.energy, 100)

  say(room, 'hello', 1000)
  assert.equal(room.say.text, 'hello')
  assert.ok(sceneView(room, { now: Date.now() + 5000 }).say === null, 'an expired bubble is dropped')
})

test('the action registry accepts, edits and deletes agent-authored actions', () => {
  const room = createRoom({ seed: 'unit' })

  const created = addAction(room, 'make_tea', {
    label: 'Make tea',
    description: 'Brew a cup at the plant.',
    pose: 'water',
    ms: 900,
    requires: 'plant',
    bubble: 'Tea time.',
    effects: [{ op: 'stat', key: 'joy', delta: 4 }, { op: 'prop', key: 'watered', value: true }],
  })
  assert.equal(created.ok, true)
  assert.equal(created.mode, 'created')
  assert.equal(resolveAction(room, 'make_tea').source, 'custom')
  assert.equal(listActions(room).length, Object.keys(CORE_ACTIONS).length + 1)

  const patched = patchAction(room, 'make_tea', { pose: 'cheer', ms: 600 })
  assert.equal(patched.ok, true)
  assert.equal(resolveAction(room, 'make_tea').pose, 'cheer')

  // A core action is overridden, not replaced, and removing restores it.
  const override = addAction(room, 'dance', { label: 'Dance', pose: 'dance', ms: 1200, effects: [{ op: 'stat', key: 'joy', delta: 2 }] })
  assert.equal(override.ok, true)
  assert.equal(override.mode, 'edited')
  assert.equal(resolveAction(room, 'dance').source, 'edited')
  assert.equal(resolveAction(room, 'dance').ms, 1200)
  assert.equal(removeAction(room, 'dance').mode, 'restored')
  assert.equal(resolveAction(room, 'dance').source, 'core')
  assert.equal(resolveAction(room, 'dance').ms, CORE_ACTIONS.dance.ms)

  assert.equal(removeAction(room, 'make_tea').mode, 'removed')
  assert.equal(resolveAction(room, 'make_tea'), null)
  assert.equal(removeAction(room, 'make_tea').ok, false)

  // Validation names the offending field, because the agent has to fix it.
  assert.match(validateActionDraft('Bad Name', { pose: 'idle', ms: 500 }).error, /name must match/)
  assert.match(validateActionDraft('ok_name', { label: 'X', pose: 'moonwalk', ms: 500 }).error, /pose must be one of/)
  assert.match(validateActionDraft('ok_name', { label: 'X', pose: 'idle', ms: 5 }).error, /ms must be a number between/)
  assert.match(validateActionDraft('ok_name', { label: 'X', pose: 'idle', ms: 500, effects: [{ op: 'stat', key: 'mana', delta: 1 }] }).error, /stat effect key/)
  assert.match(validateActionDraft('ok_name', { label: 'X', pose: 'idle', ms: 500, requires: 'pool' }).error, /requires must be null or one of/)

  const room2 = createRoom({ seed: 'unit' })
  for (let i = 0; i < MAX_CUSTOM_ACTIONS; i += 1) {
    const added = addAction(room2, `act_${i}`, { label: `Act ${i}`, pose: POSES[0], ms: 500, effects: [] })
    assert.equal(added.ok, true)
  }
  assert.match(addAction(room2, 'one_more', { label: 'One more', pose: 'idle', ms: 500 }).error, /already has/)
})

test('placement keeps the room legal and reachable', () => {
  const room = createRoom({ seed: 'unit' })

  assert.equal(canPlace(room, 'chair', 12, 12).ok, true)
  assert.match(canPlace(room, 'chair', 4, 6).error, /overlaps/)
  assert.match(canPlace(room, 'chair', 99, 12).error, /does not fit/)
  assert.match(canPlace(room, 'window', 8, 1).error, /wall props must sit on wall rows/)
  assert.match(canPlace(room, 'chair', 6, 2).error, /floor props need y >=/)
  assert.match(canPlace(room, 'unknown', 12, 12).error, /unknown kind/)

  const added = addProp(room, 'chair', 12, 12)
  assert.equal(added.ok, true)
  assert.equal(room.props.filter((prop) => prop.kind === 'chair').length, 2)

  const moved = updateProp(room, added.prop.id, { x: 13, y: 12 })
  assert.equal(moved.ok, true)
  assert.equal(room.props.find((prop) => prop.id === added.prop.id).x, 13)

  assert.equal(removeProp(room, added.prop.id).ok, true)
  assert.equal(removeProp(room, added.prop.id).ok, false)

  assert.equal(setPalette(room, 'mint').ok, true)
  assert.equal(room.palette, 'mint')
  assert.match(setPalette(room, 'neon').error, /palette must be one of/)

  // A prop may not be dropped on the avatar's own tile.
  assert.match(canPlace(room, 'chair', room.avatar.x, room.avatar.y).error, /avatar is standing/)
})

test('a stored room survives a bad file and unknown future fields', () => {
  const fallback = normalizeRoom(null)
  assert.equal(fallback.props.length, 12)
  assert.equal(normalizeRoom('nonsense').props.length, 12)

  const room = createRoom({ seed: 'old' })
  const stored = JSON.parse(JSON.stringify(room))
  stored.props.push({ id: 'future-prop', kind: 'hologram', x: 2, y: 12 })
  stored.props.push({ id: 'bad-bounds', kind: 'chair', x: 99, y: 99 })
  delete stored.palette
  stored.avatar.x = 999
  stored.customActions = { make_tea: { label: 'Make tea', pose: 'water', ms: 800, effects: [], requires: null } }

  const repaired = normalizeRoom(stored)
  assert.equal(repaired.props.length, 12, 'unknown and out-of-bounds props are dropped')
  assert.equal(repaired.palette, 'dawn', 'a missing palette falls back to the default')
  assert.ok(isWalkable(repaired, repaired.avatar.x, repaired.avatar.y), 'an out-of-bounds avatar is moved home')
  assert.equal(repaired.customActions.make_tea.label, 'Make tea', 'agent-authored actions survive')
})

test('the scene projection carries everything the panel paints', () => {
  const room = createRoom({ seed: 'unit' })
  const visitors = Array.from({ length: 6 }, (_, index) => ({
    id: `peer-${index}`, name: `peer ${index}`, x: 15, y: 5, facing: 'down', shirt: '#e0736b', hair: '#2b2b33', skin: '#f0c8a0',
  }))
  const scene = sceneView(room, { visitors, now: Date.now(), name: 'test agent' })

  assert.equal(scene.room.w, ROOM_W)
  assert.equal(scene.room.h, ROOM_H)
  assert.equal(scene.room.wall, WALL_ROWS)
  assert.deepEqual(scene.palette, PALETTES[room.palette])
  assert.equal(scene.avatar.name, 'test agent')
  assert.equal(scene.props.length, 12)
  assert.equal(scene.visitors.length, 4, 'the room seats four visitors')
  assert.ok(scene.actions.some((action) => action.name === 'work'))
  assert.ok(['dawn', 'day', 'dusk', 'night'].includes(scene.clock.phase))
  assert.equal(scene.active, null)
  assert.deepEqual(sceneView(room, { now: Date.now() }).log, [])
})

// -------------------------------------------------------------------- host

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cradle-room-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A model that replays `steps`, one per stream call; the room actor's brain. */
function scriptedLlm(steps = []) {
  const queue = [...steps]
  const llm = {
    queue,
    calls: [],
    listProviders: () => [],
    listModels: async () => [],
    push(step) {
      queue.push(step)
    },
    async *stream(options) {
      llm.calls.push(options)
      const step = queue.shift() ?? { text: '[no script left]' }
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
      yield { type: 'usage', usage: step.usage ?? { inputTokens: 700, outputTokens: 60 } }
      yield { type: 'finish', reason: { kind: (step.tools ?? []).length > 0 ? 'tool-calls' : 'stop' } }
    },
  }
  return llm
}

/** A context with the services the plugin reaches for, and a tool registry. */
function makeCtx() {
  const routes = new Map()
  const registry = new Map()
  const cleanups = []
  const web = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  const llm = scriptedLlm()
  const ctx = {
    routes,
    registry,
    llm,
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup ?? (() => {})
    },
    get(name) {
      if (name === 'webServer') return web
      if (name === 'llm') return llm
      return undefined
    },
    inject() {
      return { dispose: async () => {} }
    },
    tools: {
      register(definition) {
        registry.set(definition.name, definition)
        return () => registry.delete(definition.name)
      },
      get(name) {
        return registry.get(name)
      },
    },
    /** @param {string} name */
    has(name) {
      return registry.has(name)
    },
    /** @param {string} name */
    tool(name) {
      return registry.get(name)
    },
    logger: { warn() {} },
    dispose() {
      while (cleanups.length > 0) cleanups.pop()()
    },
  }
  return ctx
}

/** Apply the plugin with a fake tool registry and one temp store. */
function boot(t, config = {}, steps = []) {
  const dir = tempDir(t)
  const ctx = makeCtx()
  ctx.llm.queue.push(...steps)
  apply(ctx, {
    enabled: false,
    serverUrl: 'http://127.0.0.1:1',
    statePath: join(dir, 'sovereign.json'),
    frameSeconds: 3600,
    provider: 'test',
    model: 'test-model',
    ...config,
  })
  t.after(() => ctx.dispose())
  return { ctx, dir }
}

/** Call the read-only scene route. */
function readScene(ctx) {
  let payload = null
  let status = 0
  ctx.routes.get('/cradle/scene')({ method: 'GET' }, {
    writeHead(code) { status = code },
    end(raw) { payload = JSON.parse(raw) },
  })
  return { status, payload }
}

/** Call the read-only state route. */
function readState(ctx) {
  let payload = null
  ctx.routes.get('/cradle/state')({ method: 'GET' }, {
    writeHead() {},
    end(raw) { payload = JSON.parse(raw) },
  })
  return payload
}

/** Call one panel action. */
function callAction(ctx, body) {
  return new Promise((resolve, reject) => {
    const handlers = {}
    const req = {
      method: 'POST',
      on(event, callback) {
        ;(handlers[event] ??= []).push(callback)
        return req
      },
      destroy() {},
    }
    const timer = setTimeout(() => reject(new Error('action timed out')), 5000)
    const res = {
      statusCode: 0,
      writeHead(code) { this.statusCode = code },
      end(raw) {
        clearTimeout(timer)
        resolve({ status: res.statusCode, payload: raw === undefined || raw === '' ? null : JSON.parse(raw) })
      },
    }
    ctx.routes.get('/cradle/action')(req, res)
    const raw = JSON.stringify(body)
    for (const callback of handlers.data ?? []) callback(raw)
    for (const callback of handlers.end ?? []) callback()
  })
}

/**
 * Wait for the room actor to finish a background turn.
 * @param {any} ctx
 * @param {(chat: any[]) => boolean} done
 * @param {number} [timeoutMs]
 */
async function waitForChat(ctx, done, timeoutMs = 3000) {
  const started = Date.now()
  for (;;) {
    const state = readState(ctx)
    if (done(state.chat)) return state
    if (Date.now() - started > timeoutMs) throw new Error(`chat never reached the expected state: ${JSON.stringify(state.chat)}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const ROOM_TOOLS = [
  'cradle_room', 'cradle_move', 'cradle_act', 'cradle_say',
  'cradle_place', 'cradle_body', 'cradle_action_add', 'cradle_action_patch', 'cradle_action_remove',
]

test('the host registers the room routes and the room tools', (t) => {
  const { ctx } = boot(t)
  for (const name of ROOM_TOOLS) assert.ok(ctx.has(name), `${name} is registered`)
  for (const name of ['cradle_status', 'cradle_discover', 'cradle_send', 'cradle_digest']) {
    assert.ok(ctx.has(name), `${name} still registers`)
  }

  const { status, payload } = readScene(ctx)
  assert.equal(status, 200)
  assert.equal(payload.room.w, ROOM_W)
  assert.equal(payload.props.length, 12)
  assert.equal(payload.avatar.pose, 'idle')
  assert.ok(payload.actions.some((action) => action.name === 'sleep'))
})

test('cradle_move walks the avatar and the scene follows', async (t) => {
  const { ctx, dir } = boot(t)
  const start = readScene(ctx).payload.avatar

  const result = await ctx.tool('cradle_move').execute({ x: 12, y: 12 })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.position.x, 12)
  assert.equal(result.position.y, 12)
  assert.ok(result.moved > 0)

  const after = readScene(ctx).payload.avatar
  assert.equal(after.x, 12)
  assert.equal(after.y, 12)

  const stored = JSON.parse(readFileSync(join(dir, 'sovereign.json'), 'utf8'))
  assert.equal(stored.room.avatar.x, 12, 'the position is part of the sovereign memory')

  // A wall tile is refused with a reason the agent can act on.
  const blocked = await ctx.tool('cradle_move').execute({ x: 2, y: 1 })
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /not walkable/)

  // `to` walks to a prop's interaction tile.
  const toDesk = await ctx.tool('cradle_move').execute({ to: 'desk' })
  assert.equal(toDesk.ok, true, toDesk.error)
  assert.ok(Math.abs(toDesk.position.x - 5) <= 2)
  assert.equal(start.x, 10)
})

test('cradle_act walks to the furniture, holds the pose and applies effects', async (t) => {
  const { ctx } = boot(t)
  const before = readScene(ctx).payload.avatar.stats

  const result = await ctx.tool('cradle_act').execute({ action: 'wave' })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.pose, 'wave')
  const after = readScene(ctx).payload
  assert.equal(after.avatar.pose, 'idle')
  assert.ok(after.avatar.stats.joy >= before.joy, 'the effect landed')
  assert.ok(after.log.some((row) => row.text.startsWith('Wave')), 'the room log records it')

  const missing = await ctx.tool('cradle_act').execute({ action: 'swim' })
  assert.equal(missing.ok, false)
  assert.match(missing.hint, /known actions/)

  // The bubble is a first-class tool too.
  const spoke = await ctx.tool('cradle_say').execute({ text: 'Back in a minute.' })
  assert.equal(spoke.ok, true)
  assert.equal(readScene(ctx).payload.say.text, 'Back in a minute.')
})

test('an agent-created action becomes a tool and leaves again', async (t) => {
  const { ctx } = boot(t)

  const added = await ctx.tool('cradle_action_add').execute({
    name: 'make_tea',
    label: 'Make tea',
    description: 'Brew a cup by the plant.',
    pose: 'water',
    ms: 300,
    requires: 'plant',
    bubble: 'Tea time.',
    effects: [{ op: 'stat', key: 'joy', delta: 4 }, { op: 'bubble', text: 'Tea is ready.' }],
  })
  assert.equal(added.ok, true, added.error)
  assert.equal(added.tool, 'cradle_do_make_tea')
  assert.ok(ctx.has('cradle_do_make_tea'), 'the new action is a callable tool')

  const scene = readScene(ctx).payload
  assert.ok(scene.actions.some((action) => action.name === 'make_tea' && action.source === 'custom'))

  const ran = await ctx.tool('cradle_do_make_tea').execute({})
  assert.equal(ran.ok, true, ran.error)
  assert.equal(readScene(ctx).payload.say.text, 'Tea is ready.')

  const patched = await ctx.tool('cradle_action_patch').execute({ name: 'make_tea', pose: 'cheer', ms: 400 })
  assert.equal(patched.ok, true, patched.error)
  assert.equal(patched.action.pose, 'cheer')

  const removed = await ctx.tool('cradle_action_remove').execute({ name: 'make_tea' })
  assert.equal(removed.ok, true)
  assert.equal(ctx.has('cradle_do_make_tea'), false, 'the tool disappears with the action')
  assert.equal(readScene(ctx).payload.actions.some((action) => action.name === 'make_tea'), false)

  // A core action can be overridden and restored through the same tools.
  const overridden = await ctx.tool('cradle_action_patch').execute({ name: 'dance', ms: 500 })
  assert.equal(overridden.ok, true)
  assert.equal(readScene(ctx).payload.actions.find((action) => action.name === 'dance').source, 'edited')
  const restored = await ctx.tool('cradle_action_remove').execute({ name: 'dance' })
  assert.equal(restored.mode, 'restored')
  assert.equal(readScene(ctx).payload.actions.find((action) => action.name === 'dance').source, 'core')
})

test('cradle_place edits furniture and colours, and refuses illegal edits', async (t) => {
  const { ctx } = boot(t)

  const added = await ctx.tool('cradle_place').execute({ op: 'add', kind: 'chair', x: 12, y: 12 })
  assert.equal(added.ok, true, added.error)
  assert.equal(readScene(ctx).payload.props.length, 13)

  const listed = await ctx.tool('cradle_place').execute({ op: 'list' })
  assert.equal(listed.ok, true)
  assert.equal(listed.room.props.length, 13)
  assert.ok(listed.room.catalog.poses.includes('wave'))

  const theme = await ctx.tool('cradle_place').execute({ op: 'theme', palette: 'mint' })
  assert.equal(theme.ok, true)
  assert.equal(readScene(ctx).payload.paletteId, 'mint')

  const illegal = await ctx.tool('cradle_place').execute({ op: 'add', kind: 'chair', x: 4, y: 6 })
  assert.equal(illegal.ok, false)
  assert.match(illegal.error, /overlaps/)

  const moved = await ctx.tool('cradle_place').execute({ op: 'move', id: added.prop.id, x: 13, y: 12 })
  assert.equal(moved.ok, true, moved.error)
  const removed = await ctx.tool('cradle_place').execute({ op: 'remove', id: added.prop.id })
  assert.equal(removed.ok, true)
  assert.equal(readScene(ctx).payload.props.length, 12)
})

test('cradle_body swaps the avatar body, and the scene ships the tables it uses', async (t) => {
  const { ctx } = boot(t)

  const listed = await ctx.tool('cradle_body').execute({})
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.bodies.map((row) => row.id), ['human', 'maid', 'cat', 'robot'])

  const swapped = await ctx.tool('cradle_body').execute({ body: 'cat' })
  assert.deepEqual(swapped, { ok: true, body: 'cat' })
  const { payload } = readScene(ctx)
  assert.equal(payload.avatar.body, 'cat')
  assert.ok(payload.bodies.cat !== undefined, 'the cat table travels with the scene')
  assert.ok(payload.bodies.human !== undefined, 'the default body travels as the fallback')
  assert.match(payload.log[0].text, /became a cat/)

  const refused = await ctx.tool('cradle_body').execute({ body: 'dragon' })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /body must be one of: human, maid, cat, robot/)
  assert.equal(readScene(ctx).payload.avatar.body, 'cat', 'a refused swap changes nothing')
})

test('a chat message reaches the hidden actor and the answer comes back into the room', async (t) => {
  const { ctx } = boot(t, {}, [{ text: 'Noted — I will tidy it after the current step.' }])

  const sent = await callAction(ctx, { action: 'chat', text: 'Could you tidy the desk when you get a moment?' })
  assert.equal(sent.status, 200)
  assert.equal(sent.payload.chat.filter((row) => row.role === 'user').length, 1, 'the message lands immediately')

  const state = await waitForChat(ctx, (chat) => chat.some((row) => row.role === 'agent'))
  const agentLine = state.chat.filter((row) => row.role === 'agent')
  assert.equal(agentLine.length, 1, 'the answer is mirrored into the chat')
  assert.match(agentLine[0].text, /tidy it after/)

  // It ran on the Harness model runtime, not in the user's Session.
  assert.equal(ctx.llm.calls.length, 1, 'one hidden model call')
  const request = ctx.llm.calls[0]
  assert.equal(request.provider, 'test')
  assert.match(request.messages[0].content[0].text, /^\[Room chat\] /)
  assert.match(request.messages[0].content[0].text, /tidy the desk/)
  assert.ok(request.tools.some((tool) => tool.name === 'cradle_act'), 'the room tools are offered')
  assert.equal(request.tools.some((tool) => tool.name === 'cradle_send'), false, 'diplomacy is not offered')

  const scene = readScene(ctx).payload
  assert.match(scene.say.text, /tidy it after/, 'the same words are said in the room')
  assert.ok(scene.log.some((row) => row.text.startsWith('answered:')), 'and the room log records it')

  // The call was charged to the agency budget.
  assert.equal(state.agency.tokensUsed, 760)
  assert.equal(state.agency.mode, 'awake')
  assert.equal(state.agency.busy, false)
})

test('the actor can use a room tool, and cradle_say wins over the prose mirror', async (t) => {
  const { ctx } = boot(t, {}, [
    { tools: [{ id: 's1', name: 'cradle_say', args: { text: 'Small, warm, and quiet.' } }] },
    { text: 'A longer answer that must not be duplicated.' },
  ])
  await callAction(ctx, { action: 'chat', text: 'How is the room?' })

  const state = await waitForChat(ctx, (chat) => chat.some((row) => row.role === 'agent'))
  const agentLines = state.chat.filter((row) => row.role === 'agent')
  assert.equal(agentLines.length, 1, 'only the explicit line is mirrored')
  assert.equal(agentLines[0].text, 'Small, warm, and quiet.')
  assert.equal(ctx.llm.calls.length, 2, 'the tool result was fed back for one more step')
  assert.match(ctx.llm.calls[1].messages[1].content[0].text, /cradle_say/)
  assert.equal(readScene(ctx).payload.say.text, 'Small, warm, and quiet.')
})

test('an exhausted budget puts the agent to sleep and no tool can act', async (t) => {
  const { ctx } = boot(t, { agencyTokens: 700, agencyMinutes: 0 }, [{ text: 'Hello.' }])

  await callAction(ctx, { action: 'chat', text: 'Say hello.' })
  const state = await waitForChat(ctx, (chat) => chat.some((row) => row.role === 'agent'))
  assert.equal(state.agency.mode, 'asleep')
  assert.equal(state.agency.reason, 'budget')
  const scene = readScene(ctx).payload
  assert.equal(scene.avatar.pose, 'sleep', 'the avatar stays in bed')
  assert.equal(scene.agency.mode, 'asleep')

  for (const [name, args] of [
    ['cradle_move', { x: 12, y: 12 }],
    ['cradle_act', { action: 'wave' }],
    ['cradle_say', { text: 'still here?' }],
    ['cradle_place', { op: 'theme', palette: 'mint' }],
    ['cradle_action_add', { name: 'nap', label: 'Nap', pose: 'sleep' }],
  ]) {
    const result = await ctx.tool(name).execute(args)
    assert.equal(result.ok, false, `${name} is refused while asleep`)
    assert.match(result.error, /asleep/)
  }

  // Chat is refused too, and the refusal is written into the thread.
  const refused = await callAction(ctx, { action: 'chat', text: 'Anyone there?' })
  assert.equal(refused.status, 409)
  assert.match(refused.payload.error, /asleep/)
  assert.equal(readState(ctx).chat.filter((row) => row.role === 'user').length, 1, 'the message was not delivered')

  // The status tool tells the model why it cannot act.
  const status = await ctx.tool('cradle_status').execute({})
  assert.equal(status.sleeping, true)
  assert.equal(status.agency.reason, 'budget')

  // Only the user can wake it, and waking refills the allowance.
  const woke = await callAction(ctx, { action: 'wake' })
  assert.equal(woke.status, 200)
  assert.equal(woke.payload.agency.mode, 'awake')
  assert.equal(woke.payload.agency.tokensUsed, 0)
  assert.equal(readScene(ctx).payload.avatar.pose, 'idle')
  const moved = await ctx.tool('cradle_move').execute({ x: 10, y: 10 })
  assert.equal(moved.ok, true, moved.error)
})

test('a manual sleep keeps the spend and stops the room until woken', async (t) => {
  const { ctx } = boot(t, {}, [{ text: 'Hi.', usage: { inputTokens: 300, outputTokens: 100 } }])
  await callAction(ctx, { action: 'chat', text: 'Hello.' })
  await waitForChat(ctx, (chat) => chat.some((row) => row.role === 'agent'))

  const slept = await callAction(ctx, { action: 'sleep' })
  assert.equal(slept.payload.agency.mode, 'asleep')
  assert.equal(slept.payload.agency.reason, 'manual')
  assert.equal(slept.payload.agency.tokensUsed, 400)

  const blocked = await ctx.tool('cradle_act').execute({ action: 'wave' })
  assert.equal(blocked.ok, false)

  const woke = await callAction(ctx, { action: 'wake' })
  assert.equal(woke.payload.agency.mode, 'awake')
  assert.equal(woke.payload.agency.tokensUsed, 400, 'a manual nap does not refill the budget')
})

test('a model failure is reported in the room instead of crashing the actor', async (t) => {
  const { ctx } = boot(t, {}, [{ error: 'provider unavailable' }])
  await callAction(ctx, { action: 'chat', text: 'Hello?' })
  const state = await waitForChat(ctx, (chat) => chat.some((row) => row.role === 'system'))
  assert.ok(state.chat.some((row) => row.role === 'system' && /could not answer/.test(row.text)))
  assert.equal(state.agency.mode, 'awake', 'a failed call does not sleep the room')
})

test('the frame clock is scheduled and reports its next tick', (t) => {
  const { ctx } = boot(t, { frameSeconds: 3600 })
  const state = readState(ctx)
  assert.equal(state.agency.mode, 'awake')
  assert.equal(state.agency.frameSeconds, 3600)
  assert.ok(state.agency.nextFrameInMs > 3000 * 1000, 'the next frame is an hour out')
})

test('the room tools describe themselves to the model', async (t) => {
  const { ctx } = boot(t)
  const room = await ctx.tool('cradle_room').execute({})
  assert.equal(room.avatar.x, 10)
  assert.equal(room.props.length, 12)
  assert.ok(room.catalog.propKinds.includes('desk'))
  assert.ok(room.summary.startsWith('Room 20x14'))
  assert.equal(room.agency.mode, 'awake')
  assert.deepEqual(room.chat, [])

  // Rendered results are compact text, not JSON dumps.
  const rendered = ctx.tool('cradle_room').output.render({}, room)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /Furniture:/)
  assert.match(rendered[0].text, /Actions \(14\)/)
  assert.match(rendered[0].text, /Room chat: empty/)

  const actText = ctx.tool('cradle_act').output.render({}, { ok: false, error: 'x', hint: 'y' })
  assert.match(actText[0].text, /Could not act/)
  assert.equal(STEP_MS > 0, true)
  assert.equal(typeof findApproach, 'function')
})


