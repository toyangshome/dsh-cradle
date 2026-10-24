/**
 * Bodies: the species catalog, the room wiring behind it, and the panel's two
 * fallbacks (unknown id, missing table). The pixel-for-pixel equivalence with
 * the pre-refactor renderer is proved separately by `test/body-parity.mjs`,
 * which needs an old copy of the bundle; this file runs anywhere.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BODIES, BODY_DEFAULT, BODY_IDS, bodiesFor, bodyFor, normalizeBodyId, validateBody, validateBodies,
} from '../plugin/lib/body.js'
import { POSES, createRoom, describeRoom, normalizeRoom, sceneView, setBody } from '../plugin/lib/room.js'
import { renderScene, scenePayload } from './render-scene.mjs'

test('every shipped body validates against the pose vocabulary', () => {
  const result = validateBodies(POSES)
  assert.deepEqual(result.errors, [], 'the catalog is internally consistent')
  assert.equal(result.ok, true)

  for (const id of BODY_IDS) {
    const body = BODIES[id]
    assert.equal(body.id, id)
    assert.ok(body.layers.length > 10, `${id} has enough layers to be a body`)
    assert.ok(body.cell.w >= 8 && body.cell.h >= 8)
    assert.ok(body.anchor.x >= 0 && body.anchor.x <= body.cell.w)
    assert.ok(body.anchor.y >= 0 && body.anchor.y <= body.cell.h)
    // A look mapping must name a slot that exists, or seeded colours go nowhere.
    for (const slot of Object.keys(body.look ?? {})) assert.ok(body.slots[slot] !== undefined, `${id}.${slot}`)
  }
})

test('the human covers every pose the action vocabulary allows', () => {
  const human = BODIES.human
  /** @type {Set<string>} */
  const posed = new Set()
  /** @type {Set<string>} */
  const excluded = new Set()
  for (const layer of human.layers) {
    const clauses = layer.when === undefined ? [] : Array.isArray(layer.when) ? layer.when : [layer.when]
    for (const clause of clauses) {
      for (const pose of clause.pose ?? []) posed.add(pose)
      for (const pose of clause.notPose ?? []) excluded.add(pose)
    }
  }
  for (const pose of POSES) {
    assert.ok(posed.has(pose) || !excluded.has(pose), `pose "${pose}" is either drawn or left to the default branch`)
  }
  // The generic legs/arms are the default branch: they must not exclude every pose.
  assert.ok(excluded.size < POSES.length)
})

test('an unknown body id degrades to the default instead of failing', () => {
  assert.equal(BODY_DEFAULT, 'human')
  assert.equal(normalizeBodyId('kraken'), 'human')
  assert.equal(normalizeBodyId(undefined), 'human')
  assert.equal(normalizeBodyId('cat'), 'cat')
  assert.equal(bodyFor('kraken').id, 'human')
  assert.equal(bodyFor('robot').id, 'robot')
  assert.deepEqual(Object.keys(bodiesFor(['cat'])).sort(), ['cat', 'human'])
  assert.deepEqual(Object.keys(bodiesFor(['kraken', 'robot'])).sort(), ['human', 'robot'])
})

test('a body table is rejected when it would paint outside its cell', () => {
  const broken = {
    id: 'broken', label: 'Broken', cell: { w: 16, h: 16 }, anchor: { x: 8, y: 15 },
    slots: { fur: '#c79a6c' },
    layers: [{ x: 14, y: 2, w: 8, h: 4, slot: 'fur' }, { x: 1, y: 1, w: 1, h: 1, slot: 'missing' }],
  }
  const result = validateBody(broken, { poses: POSES })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((line) => line.includes('outside the 16x16 cell')))
  assert.ok(result.errors.some((line) => line.includes('"missing" is not declared')))
})

test('the room carries a body and ships its table with the scene', () => {
  const room = createRoom({ seed: 'unit', body: 'cat' })
  assert.equal(room.avatar.body, 'cat')

  const scene = sceneView(room, {
    visitors: [{ id: 'did:key:p', body: 'robot', x: 15, y: 5, facing: 'down' }],
  })
  assert.equal(scene.avatar.body, 'cat')
  assert.deepEqual(Object.keys(scene.bodies).sort(), ['cat', 'human', 'robot'], 'every body in use is shipped')
  assert.equal(scene.bodies.cat.id, 'cat')
  assert.equal(scene.bodies.human.id, 'human', 'the default body always travels, as the fallback')
  // A visitor without a body is a human, and adds nothing to the payload.
  const plain = sceneView(room, { visitors: [{ id: 'did:key:q', x: 15, y: 5 }] })
  assert.deepEqual(Object.keys(plain.bodies).sort(), ['cat', 'human'])
})

test('setBody validates, bumps the version and survives a normalize', () => {
  const room = createRoom({ seed: 'unit' })
  assert.equal(room.avatar.body, 'human')
  const version = room.version

  assert.deepEqual(setBody(room, 'dragon'), { ok: false, error: 'body must be one of: human, maid, cat, robot' })
  assert.equal(room.avatar.body, 'human')
  assert.equal(room.version, version)

  assert.deepEqual(setBody(room, 'robot'), { ok: true, body: 'robot' })
  assert.equal(room.version, version + 1)
  assert.equal(normalizeRoom(room).avatar.body, 'robot', 'a valid body survives a reload')
  assert.equal(normalizeRoom({ ...room, avatar: { ...room.avatar, body: 'dragon' } }).avatar.body, 'human', 'an unknown one is repaired')
  assert.match(describeRoom(room), /Avatar body: Robot \(robot\)/)
})

test('the panel paints the body it is handed, and never blanks an unknown one', async () => {
  const base = scenePayload()
  const cat = {
    ...base,
    bodies: bodiesFor(['cat']),
    avatar: { ...base.avatar, body: 'cat', pose: 'dance', mood: 'happy', poseLeftMs: 5000 },
  }
  const paintedCat = await renderScene(cat, { time: 4000 }).mount()
  assert.ok(paintedCat.ops.fillRect > 900, 'the room paints with a non-human body')

  const missing = { ...cat, avatar: { ...cat.avatar, body: 'kraken' } }
  delete missing.bodies
  const paintedFallback = await renderScene(missing, { time: 4000 }).mount()
  assert.ok(paintedFallback.ops.fillRect > 900, 'a scene with no body tables still paints')

  let different = 0
  for (let index = 0; index < paintedCat.pixels.length; index += 1) {
    if (paintedCat.pixels[index] !== paintedFallback.pixels[index]) different += 1
  }
  assert.ok(different > 200, 'the body table changes what is drawn, not just the call count')
})
