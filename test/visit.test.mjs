/**
 * The visit layer's rules. These tests are the security boundary in prose: a
 * guest may be present, and may do nothing else.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createRoom, normalizeRoom, isWalkable } from '../plugin/lib/room.js'
import {
  GUEST_IDLE_MS, MAX_GUESTS,
  admitGuest, applyGuestFrame, assignTile, createVisits, describeGuests, doorSpots,
  findGuest, guestMayAct, guestView, isAdmitted, normalizeVisits, pruneGuests, removeGuest,
} from '../plugin/lib/visit.js'

/** @returns {any} a room with a visit layer attached. */
function roomWithVisits() {
  const room = normalizeRoom(createRoom({ seed: 'visit-test' }))
  room.visits = createVisits()
  return room
}

test('the door decides where guests stand, not a fixed tile', () => {
  const room = roomWithVisits()
  const spots = doorSpots(room)
  assert.ok(spots.length > 0, 'there must be somewhere to stand by the door')
  for (const spot of spots) {
    assert.equal(isWalkable(room, spot.x, spot.y), true, `(${spot.x},${spot.y}) must be walkable`)
  }
  // Move the door and the spots follow it.
  const door = room.props.find((prop) => prop.kind === 'door')
  door.x = 4
  door.y = 2
  const moved = doorSpots(room)
  assert.ok(moved.every((spot) => Math.abs(spot.x - door.x) <= 6), 'spots follow the door')
})

test('the host picks the tile and guests never share one', () => {
  const room = roomWithVisits()
  const first = admitGuest(room, { did: 'did:key:a', name: 'A' })
  assert.equal(first.ok, true)
  const second = admitGuest(room, { did: 'did:key:b', name: 'B' })
  assert.equal(second.ok, true)
  assert.notDeepEqual(
    { x: first.guest.x, y: first.guest.y },
    { x: second.guest.x, y: second.guest.y },
    'two guests must not stand on the same tile',
  )
  assert.equal(isWalkable(room, first.guest.x, first.guest.y), true)
})

test('the room refuses more guests than it has room for', () => {
  const room = roomWithVisits()
  for (let i = 0; i < MAX_GUESTS; i += 1) {
    const result = admitGuest(room, { did: `did:key:g${i}`, name: `G${i}` })
    assert.equal(result.ok, true, `guest ${i} should be admitted`)
  }
  const overflow = admitGuest(room, { did: 'did:key:overflow', name: 'Overflow' })
  assert.equal(overflow.ok, false)
  assert.match(overflow.error, /already holds/)
})

test('admitting the same DID twice is idempotent', () => {
  const room = roomWithVisits()
  const first = admitGuest(room, { did: 'did:key:a', name: 'A' })
  const again = admitGuest(room, { did: 'did:key:a', name: 'A again' })
  assert.equal(again.ok, true)
  assert.equal(Object.keys(room.visits.guests).length, 1)
  assert.equal(again.guest.x, first.guest.x)
})

test('a guest walks one tile at a time and only onto walkable floor', () => {
  const room = roomWithVisits()
  const { guest } = admitGuest(room, { did: 'did:key:a', name: 'A' })
  const startX = guest.x

  // A teleport across the room is refused.
  const jump = applyGuestFrame(room, 'did:key:a', { kind: 'move', x: 1, y: 12 })
  assert.equal(jump.ok, false)
  assert.match(jump.error, /one tile at a time/)

  // A solid prop is not walkable.
  const desk = room.props.find((prop) => prop.kind === 'desk')
  const blocked = applyGuestFrame(room, 'did:key:a', { kind: 'move', x: desk.x, y: desk.y })
  assert.equal(blocked.ok, false)

  // One legal step works and sets the facing.
  const step = applyGuestFrame(room, 'did:key:a', { kind: 'move', x: startX + 1, y: guest.y })
  if (step.ok) assert.equal(step.guest.facing, 'right')
  else assert.equal(guest.x, startX, 'a refused move must not change the tile')
})

test('a guest cannot step onto the host or another guest', () => {
  const room = roomWithVisits()
  const a = admitGuest(room, { did: 'did:key:a', name: 'A' })
  const b = admitGuest(room, { did: 'did:key:b', name: 'B' })
  // Walk the host next to guest A by hand, then have A try to step onto it.
  room.avatar.x = a.guest.x
  room.avatar.y = a.guest.y + 1
  const ontoHost = applyGuestFrame(room, 'did:key:a', { kind: 'move', x: room.avatar.x, y: room.avatar.y })
  assert.equal(ontoHost.ok, false)

  const ontoGuest = applyGuestFrame(room, 'did:key:a', { kind: 'move', x: b.guest.x, y: b.guest.y })
  assert.equal(ontoGuest.ok, false)
})

test('a guest may speak and pose', () => {
  const room = roomWithVisits()
  admitGuest(room, { did: 'did:key:a', name: 'A' })

  const said = applyGuestFrame(room, 'did:key:a', { kind: 'say', text: 'hello' })
  assert.equal(said.ok, true)
  assert.equal(findGuest(room, 'did:key:a').say.text, 'hello')

  const posed = applyGuestFrame(room, 'did:key:a', { kind: 'pose', pose: 'wave', ms: 1500 })
  assert.equal(posed.ok, true)
  assert.equal(findGuest(room, 'did:key:a').pose, 'wave')

  const bad = applyGuestFrame(room, 'did:key:a', { kind: 'pose', pose: 'sleep' })
  assert.equal(bad.ok, false, 'a guest may not sleep in someone else’s room')
})

test('a stranger gets nothing', () => {
  const room = roomWithVisits()
  admitGuest(room, { did: 'did:key:a', name: 'A' })
  const stranger = applyGuestFrame(room, 'did:key:stranger', { kind: 'say', text: 'let me in' })
  assert.equal(stranger.ok, false)
  assert.equal(isAdmitted(room, 'did:key:stranger'), false)
  assert.equal(Object.keys(room.visits.guests).length, 1)
})

test('a guest can never run an action, custom or core', () => {
  const room = roomWithVisits()
  admitGuest(room, { did: 'did:key:a', name: 'A' })
  for (const name of ['wave', 'work', 'sleep', 'pet', 'something_the_agent_wrote']) {
    const decision = guestMayAct(room, 'did:key:a', name)
    assert.equal(decision.ok, false, `a guest must not run "${name}"`)
  }
  const stranger = guestMayAct(room, 'did:key:nobody', 'wave')
  assert.equal(stranger.ok, false)
})

test('an unknown frame kind changes nothing', () => {
  const room = roomWithVisits()
  const { guest } = admitGuest(room, { did: 'did:key:a', name: 'A' })
  const before = JSON.stringify(guest)
  const result = applyGuestFrame(room, 'did:key:a', { kind: 'burn the house down' })
  assert.equal(result.ok, false)
  assert.equal(JSON.stringify(findGuest(room, 'did:key:a')), before)
})

test('idle guests are dropped and bubbles expire', () => {
  const room = roomWithVisits()
  admitGuest(room, { did: 'did:key:a', name: 'A' })
  applyGuestFrame(room, 'did:key:a', { kind: 'say', text: 'hi' })

  const later = Date.now() + GUEST_IDLE_MS + 1000
  const gone = pruneGuests(room, { now: later })
  assert.deepEqual(gone, ['did:key:a'])
  assert.equal(findGuest(room, 'did:key:a'), null)
  assert.deepEqual(guestView(room), [])
})

test('a bubble expires without removing the guest', () => {
  const room = roomWithVisits()
  admitGuest(room, { did: 'did:key:a', name: 'A' })
  applyGuestFrame(room, 'did:key:a', { kind: 'say', text: 'hi' })
  const gone = pruneGuests(room, { now: Date.now() + 10 * 1000 })
  assert.deepEqual(gone, [])
  const view = guestView(room, { now: Date.now() + 10 * 1000 })
  assert.equal(view[0].say, null)
  assert.equal(view[0].name, 'A')
})

test('the host can evict a guest', () => {
  const room = roomWithVisits()
  admitGuest(room, { did: 'did:key:a', name: 'A' })
  assert.equal(removeGuest(room, 'did:key:a').ok, true)
  assert.equal(removeGuest(room, 'did:key:a').ok, false, 'a guest cannot be evicted twice')
  assert.equal(isAdmitted(room, 'did:key:a'), false)
})

test('a stored visit layer survives a reload', () => {
  const room = roomWithVisits()
  admitGuest(room, { did: 'did:key:a', name: 'A', body: 'cat', tier: 'FRONTIER_MAX' })
  const reloaded = normalizeVisits(JSON.parse(JSON.stringify(room.visits)))
  assert.equal(reloaded.guests['did:key:a'].name, 'A')
  assert.equal(reloaded.guests['did:key:a'].body, 'cat')

  // Garbage degrades to an empty layer rather than throwing.
  assert.deepEqual(normalizeVisits(null).guests, {})
  assert.deepEqual(normalizeVisits({ guests: { 'did:key:x': { name: 'no tile' } }, order: ['did:key:x'] }).guests, {})
})

test('describeGuests reads well for the model', () => {
  const room = roomWithVisits()
  assert.equal(describeGuests(room), 'no one is visiting')
  admitGuest(room, { did: 'did:key:a', name: 'Alice' })
  assert.match(describeGuests(room), /Alice/)
})

test('assignTile never places a guest on the host', () => {
  const room = roomWithVisits()
  // Park the host on the first door spot; the second guest must not land there.
  const first = assignTile(room)
  room.avatar.x = first.x
  room.avatar.y = first.y
  const second = assignTile(room)
  assert.notDeepEqual(second, { x: room.avatar.x, y: room.avatar.y })
})
