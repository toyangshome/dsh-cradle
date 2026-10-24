/**
 * The visit layer of one room.
 *
 * A visit has three moving parts, and this module owns exactly one of them:
 *
 * - *Authorisation* is a signed VISIT envelope through the Discovery Server,
 *   like any other primitive. The Host half handles it in `index.js`.
 * - *Handshake and fallback relay* live on the Server (`internal/rtc`).
 * - *Presence* — who is standing where in this room right now — lives here.
 *
 * This module is pure state plus pure functions, like `lib/room.js`: no
 * filesystem, no network, no model. That is what makes the rules testable and
 * what keeps a crashed guest from corrupting anything durable.
 *
 * Two rules shape everything below:
 *
 * 1. **The host is sovereign.** Only this room's own host admits a guest, and
 *    only it picks the tile. A guest never chooses where it stands.
 * 2. **A guest may be present, not powerful.** It may walk, speak and hold a
 *    pose. It may not touch a prop, run an action, or — above all — invoke one
 *    of this room's agent-authored actions, which would be remote execution.
 */

import { MOODS, POSES, isWalkable, propById, propRect } from './room.js'

/** How many guests may stand in one room at a time. */
export const MAX_GUESTS = 4
/** A guest that neither moves nor speaks for this long is gone. */
export const GUEST_IDLE_MS = 90 * 1000
/** How long one speech bubble is shown. */
export const GUEST_SAY_MS = 6000
/** One guest's frame rate ceiling, to keep a peer from flooding the room. */
export const GUEST_MIN_FRAME_MS = 120

/** The poses a guest may hold. `idle` and `walk` are implied by moving. */
export const GUEST_POSES = ['idle', 'wave', 'cheer', 'dance', 'think', 'gaze', 'point', 'sit', 'stretch']
/** Emotes a guest may perform; `move` and `say` are handled separately. */
export const GUEST_EMOTES = ['wave', 'cheer', 'dance', 'think', 'stretch', 'idle']

/** Visit states. `pending` waits on this room's own decision. */
export const VISIT_STATES = ['knocking', 'pending', 'admitted', 'present', 'leaving', 'gone']

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const trim = (text, max) => (typeof text === 'string' ? text.trim().slice(0, max) : '')

/**
 * The empty visit layer.
 * @returns {any}
 */
export function createVisits() {
  return { guests: {}, order: [], version: 0 }
}

/**
 * Validate a stored visit layer and repair what can be repaired. Anything
 * unrecognised is dropped rather than blanking the panel.
 * @param {any} raw
 * @returns {any}
 */
export function normalizeVisits(raw) {
  const base = createVisits()
  if (raw === null || typeof raw !== 'object') return base
  const out = createVisits()
  out.version = Number.isFinite(raw.version) ? Math.max(0, Math.trunc(raw.version)) : 0
  const order = Array.isArray(raw.order) ? raw.order.filter((did) => typeof did === 'string') : []
  const seen = new Set()
  for (const did of order) {
    if (seen.has(did)) continue
    const guest = raw.guests?.[did]
    if (guest === null || typeof guest !== 'object') continue
    if (!Number.isInteger(guest.x) || !Number.isInteger(guest.y)) continue
    seen.add(did)
    out.order.push(did)
    out.guests[did] = {
      did,
      name: trim(guest.name, 48) || 'guest',
      body: typeof guest.body === 'string' ? guest.body : 'human',
      x: guest.x,
      y: guest.y,
      facing: ['down', 'up', 'left', 'right'].includes(guest.facing) ? guest.facing : 'down',
      pose: POSES.includes(guest.pose) ? guest.pose : 'idle',
      mood: MOODS.includes(guest.mood) ? guest.mood : 'calm',
      state: VISIT_STATES.includes(guest.state) ? guest.state : 'present',
      shirt: typeof guest.shirt === 'string' ? guest.shirt : '#9a9aa8',
      hair: typeof guest.hair === 'string' ? guest.hair : '#2b2b33',
      skin: typeof guest.skin === 'string' ? guest.skin : '#f0c8a0',
      tier: trim(guest.tier, 16) || 'MEDIUM_32B',
      since: Number.isFinite(guest.since) ? guest.since : Date.now(),
      lastSeen: Number.isFinite(guest.lastSeen) ? guest.lastSeen : Date.now(),
      poseEndsAt: Number.isFinite(guest.poseEndsAt) ? guest.poseEndsAt : 0,
      say: guest.say !== null && typeof guest.say === 'object' && typeof guest.say.text === 'string'
        ? { text: trim(guest.say.text, 160), at: Number(guest.say.at) || Date.now(), until: Number(guest.say.until) || 0 }
        : null,
    }
  }
  return out
}

/**
 * Free floor tiles next to the door, nearest first. The door is furniture like
 * any other, so this asks the room's own walkability rules instead of assuming
 * a fixed spot — move the door and the spots follow.
 *
 * @param {any} room
 * @param {number} [limit]
 * @returns {Array<{ x: number, y: number, facing: string }>}
 */
export function doorSpots(room, limit = MAX_GUESTS) {
  const door = room.props.find((prop) => prop.kind === 'door') ?? null
  if (door === null) return []
  // A prop stores only its origin; its size comes from the catalogue. Guests
  // stand on the floor row directly below the door, since a wall prop is
  // approached from the floor.
  const rect = propRect(door)
  const y = rect.y + rect.h
  const seen = new Set()
  const spots = []
  const push = (x) => {
    const key = `${x},${y}`
    if (seen.has(key)) return
    seen.add(key)
    if (isWalkable(room, x, y)) spots.push({ x, y, facing: 'up' })
  }
  // Directly under the door first, then outward so several guests can spread.
  for (let dx = 0; dx < rect.w; dx += 1) push(rect.x + dx)
  for (let radius = 1; radius < 8; radius += 1) {
    push(rect.x - radius)
    push(rect.x + rect.w - 1 + radius)
    if (spots.length >= limit) break
  }
  const taken = new Set(Object.values(room.visits?.guests ?? {}).map((guest) => `${guest.x},${guest.y}`))
  const free = spots.filter((spot) => !taken.has(`${spot.x},${spot.y}`))
  return (free.length > 0 ? free : spots).slice(0, limit)
}

/**
 * Pick a tile for one incoming guest: the first free spot by the door.
 * @param {any} room
 * @returns {{ x: number, y: number, facing: string } | null}
 */
export function assignTile(room) {
  const spots = doorSpots(room, MAX_GUESTS)
  const guests = room.visits?.guests ?? {}
  const taken = new Set(Object.values(guests).map((guest) => `${guest.x},${guest.y}`))
  // Never place a guest on the host's own tile.
  taken.add(`${room.avatar.x},${room.avatar.y}`)
  return spots.find((spot) => !taken.has(`${spot.x},${spot.y}`)) ?? null
}

/**
 * Admit one guest. The tile is chosen here, never by the guest.
 * @param {any} room
 * @param {{ did: string, name?: string, body?: string, tier?: string, colors?: any }} guest
 * @returns {{ ok: true, guest: any } | { ok: false, error: string }}
 */
export function admitGuest(room, guest) {
  if (typeof guest?.did !== 'string' || guest.did === '') return { ok: false, error: 'a guest needs a did' }
  const visits = normalizeVisits(room.visits)
  const existing = visits.guests[guest.did]
  if (existing !== undefined) {
    existing.state = 'present'
    existing.lastSeen = Date.now()
    visits.version += 1
    room.visits = visits
    return { ok: true, guest: existing }
  }
  const occupied = Object.keys(visits.guests).length
  if (occupied >= MAX_GUESTS) return { ok: false, error: `the room already holds ${MAX_GUESTS} guests` }
  const tile = assignTile(room)
  if (tile === null) return { ok: false, error: 'there is no free tile by the door' }

  const now = Date.now()
  const entry = {
    did: guest.did,
    name: trim(guest.name, 48) || 'guest',
    body: typeof guest.body === 'string' ? guest.body : 'human',
    x: tile.x,
    y: tile.y,
    facing: tile.facing,
    pose: 'idle',
    mood: 'calm',
    state: 'present',
    shirt: guest.colors?.shirt ?? '#9a9aa8',
    hair: guest.colors?.hair ?? '#2b2b33',
    skin: guest.colors?.skin ?? '#f0c8a0',
    tier: trim(guest.tier, 16) || 'MEDIUM_32B',
    since: now,
    lastSeen: now,
    poseEndsAt: 0,
    say: null,
  }
  visits.guests[entry.did] = entry
  visits.order.push(entry.did)
  visits.version += 1
  room.visits = visits
  return { ok: true, guest: entry }
}

/**
 * Remove one guest, by the host's order or by the guest's own departure.
 * @param {any} room
 * @param {string} did
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function removeGuest(room, did) {
  const visits = normalizeVisits(room.visits)
  if (visits.guests[did] === undefined) return { ok: false, error: `no guest with did "${did}"` }
  delete visits.guests[did]
  visits.order = visits.order.filter((entry) => entry !== did)
  visits.version += 1
  room.visits = visits
  return { ok: true }
}

/** @param {any} room @param {string} did @returns {any | null} */
export function findGuest(room, did) {
  return room.visits?.guests?.[did] ?? null
}

/**
 * Is this DID currently admitted to this room? The Host half asks this before
 * applying any guest frame, so a frame from a stranger does nothing.
 * @param {any} room @param {string} did
 */
export function isAdmitted(room, did) {
  const guest = findGuest(room, did)
  return guest !== null && (guest.state === 'present' || guest.state === 'admitted')
}

/**
 * Apply one guest frame: a move, a line of speech, or an emote.
 *
 * Rejected frames return `{ ok: false }` and change nothing, which is the whole
 * defence a guest frame needs: nothing here can reach a prop, an action or the
 * host's own stats.
 *
 * @param {any} room
 * @param {string} did
 * @param {{ kind?: string, x?: number, y?: number, facing?: string, text?: string, pose?: string, ms?: number }} frame
 * @param {{ now?: number }} [options]
 * @returns {{ ok: true, guest: any } | { ok: false, error: string }}
 */
export function applyGuestFrame(room, did, frame, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const guest = findGuest(room, did)
  if (guest === null) return { ok: false, error: 'not admitted to this room' }
  if (guest.state !== 'present' && guest.state !== 'admitted') {
    return { ok: false, error: `guest is ${guest.state}` }
  }
  const kind = String(frame?.kind ?? '')
  const visits = room.visits
  visits.version += 1
  guest.lastSeen = now
  guest.state = 'present'

  if (kind === 'move') {
    const x = Math.round(Number(frame.x))
    const y = Math.round(Number(frame.y))
    if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, error: 'a move needs x and y' }
    if (!isWalkable(room, x, y)) return { ok: false, error: `(${x},${y}) is not walkable` }
    // A guest walks tile by tile like the host: no teleporting across the room.
    if (Math.abs(x - guest.x) + Math.abs(y - guest.y) > 1) {
      return { ok: false, error: 'a guest moves one tile at a time' }
    }
    if (x === room.avatar.x && y === room.avatar.y) return { ok: false, error: 'the host is standing there' }
    if (Object.values(visits.guests).some((other) => other.did !== did && other.x === x && other.y === y)) {
      return { ok: false, error: 'another guest is standing there' }
    }
    if (x > guest.x) guest.facing = 'right'
    else if (x < guest.x) guest.facing = 'left'
    else if (y > guest.y) guest.facing = 'down'
    else if (y < guest.y) guest.facing = 'up'
    guest.x = x
    guest.y = y
    guest.poseEndsAt = 0
    return { ok: true, guest }
  }

  if (kind === 'say') {
    const text = trim(frame.text, 160)
    if (text === '') return { ok: false, error: 'a guest needs words to say' }
    guest.say = { text, at: now, until: now + GUEST_SAY_MS }
    return { ok: true, guest }
  }

  if (kind === 'pose') {
    const pose = String(frame.pose ?? '')
    if (!GUEST_POSES.includes(pose)) return { ok: false, error: `pose must be one of: ${GUEST_POSES.join(', ')}` }
    guest.pose = pose
    guest.poseEndsAt = now + clamp(Number(frame.ms) || 1600, 300, 6000)
    return { ok: true, guest }
  }

  return { ok: false, error: `unknown guest frame kind "${kind}"` }
}

/**
 * Drop guests that stopped sending frames, and expire speech bubbles and
 * poses. Called on every scene projection, so nothing lingers.
 * @param {any} room
 * @param {{ now?: number }} [options]
 * @returns {string[]} the DIDs that went away.
 */
export function pruneGuests(room, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const visits = room.visits
  if (visits === null || typeof visits !== 'object') return []
  const gone = []
  for (const did of [...visits.order]) {
    const guest = visits.guests[did]
    if (guest === undefined) continue
    if (guest.say !== null && guest.say.until < now) guest.say = null
    if (guest.poseEndsAt !== 0 && guest.poseEndsAt < now) {
      guest.pose = 'idle'
      guest.poseEndsAt = 0
    }
    if (guest.lastSeen + GUEST_IDLE_MS < now) {
      delete visits.guests[did]
      visits.order = visits.order.filter((entry) => entry !== did)
      gone.push(did)
    }
  }
  if (gone.length > 0) visits.version += 1
  return gone
}

/**
 * The guests as the panel draws them: an ordered list, newest last.
 * @param {any} room
 * @param {{ now?: number }} [options]
 * @returns {any[]}
 */
export function guestView(room, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const visits = room.visits
  if (visits === null || typeof visits !== 'object') return []
  return visits.order
    .map((did) => visits.guests[did])
    .filter((guest) => guest !== undefined)
    .map((guest) => ({
      id: guest.did,
      name: guest.name,
      body: guest.body,
      x: guest.x,
      y: guest.y,
      facing: guest.facing,
      pose: guest.pose,
      poseLeftMs: Math.max(0, Math.trunc(guest.poseEndsAt - now)),
      mood: guest.mood,
      tier: guest.tier,
      shirt: guest.shirt,
      hair: guest.hair,
      skin: guest.skin,
      say: guest.say === null || guest.say.until < now ? null : { text: guest.say.text, ageMs: now - guest.say.at },
    }))
}

/**
 * One line summarising the room's visitors, for the model's room description.
 * @param {any} room @param {{ now?: number }} [options]
 * @returns {string}
 */
export function describeGuests(room, options = {}) {
  const guests = guestView(room, options)
  if (guests.length === 0) return 'no one is visiting'
  return guests.map((guest) => `${guest.name} at (${guest.x},${guest.y})`).join('; ')
}

/**
 * A guest may never be handed a prop or an action. This is the single place
 * that rule is written down, so every caller shares it.
 * @param {any} room @param {string} did @param {string} actionName
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function guestMayAct(room, did, actionName) {
  if (!isAdmitted(room, did)) return { ok: false, error: 'not admitted to this room' }
  // Deliberately unconditional: a guest touches nothing. Read-only presence is
  // the whole promise, and a custom action is agent-authored code.
  return { ok: false, error: `a guest may not run "${actionName}"; it may only move, speak and pose` }
}

export { propById }
