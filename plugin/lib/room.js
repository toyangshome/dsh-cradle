/**
 * The pixel room.
 *
 * Every installation of this plugin owns one small room and one avatar. The room
 * is a tile grid drawn by the Web panel as 2D pixel art; the avatar is the body
 * the agent drives while it works. This module is the whole world model: the
 * tile rules, the furniture catalogue, the pose vocabulary, the core actions,
 * the agent-authored action registry, the walk planner, the effect interpreter
 * and the projection the panel paints.
 *
 * Two rules keep the scene extensible without letting it become arbitrary code:
 *
 * - The *picture* is data. A pose is a name from `POSES`; the client knows how
 *   to draw each one, and falls back to `idle` for anything it does not know.
 * - An *action* is data too: a pose, a duration, an optional prop requirement
 *   and a list of effects from `EFFECT_OPS`. The agent can add, patch and
 *   remove actions at runtime, and each custom action becomes a callable Tool.
 *
 * Nothing here touches the filesystem, the network or the model: this module is
 * pure state plus pure functions, which is what the unit tests exercise.
 */

import { BODY_IDS, UNIT, bodiesFor, bodyFor, normalizeBodyId, scaleBody } from './body.js'

/** Pixel size of one tile; the client scales the whole scene from this. */
export const TILE = 16
/** Room width in tiles. */
export const ROOM_W = 20
/** Room height in tiles. */
export const ROOM_H = 14
/** Rows `0 .. WALL_ROWS-1` are wall; everything below is walkable floor. */
export const WALL_ROWS = 4
/** How long the avatar takes to cross one tile. */
export const STEP_MS = 220
/** Retention caps: the scene is a view, not a log. */
export const MAX_PROPS = 28
export const MAX_CUSTOM_ACTIONS = 20
export const MAX_LOG = 24
/** An action is a beat, not a background job. */
export const ACTION_MIN_MS = 300
export const ACTION_MAX_MS = 10000

/** Directions the avatar can face. */
export const FACINGS = ['down', 'up', 'left', 'right']
/** Every pose the client knows how to draw. */
export const POSES = [
  'idle', 'walk', 'sit', 'sleep', 'wave', 'type', 'read', 'water', 'dance',
  'cheer', 'think', 'point', 'pet', 'gaze', 'stretch',
]
/** Every mood the client knows how to draw. */
export const MOODS = ['calm', 'happy', 'tired', 'focused', 'curious']
/** The three needs actions move. */
export const STAT_KEYS = ['energy', 'focus', 'joy']
/** Every effect an action (or the agent) may apply. */
export const EFFECT_OPS = ['stat', 'mood', 'bubble', 'prop', 'log']

/** Four room palettes. Colours are artwork, so they are literal hex values. */
export const PALETTES = {
  dusk: {
    label: 'Dusk',
    wall: '#544763', wallShade: '#453a55', skirt: '#302838',
    floor: '#7b5b40', floorAlt: '#715238', seam: '#5f442e',
    rug: '#94566b', rugAlt: '#7d4759',
    accent: '#f0c46a', lamp: '#ffd9a0',
    skyTop: '#2b2745', skyMid: '#493d61', skyLow: '#7c5b74',
  },
  dawn: {
    label: 'Dawn',
    wall: '#cbb59c', wallShade: '#b7a189', skirt: '#7a6450',
    floor: '#b07f52', floorAlt: '#a2744a', seam: '#8a6039',
    rug: '#7e9a77', rugAlt: '#6b8565',
    accent: '#e8a94f', lamp: '#ffe3ae',
    skyTop: '#8fb4d6', skyMid: '#e7b98c', skyLow: '#f6d3a3',
  },
  mint: {
    label: 'Mint',
    wall: '#8fb6a4', wallShade: '#7ba392', skirt: '#4d6d60',
    floor: '#9c7b5a', floorAlt: '#907152', seam: '#7a5f45',
    rug: '#5f8f8a', rugAlt: '#517c78',
    accent: '#f2d06b', lamp: '#ffe7b6',
    skyTop: '#5f9ab8', skyMid: '#9cc6d6', skyLow: '#cfe3e4',
  },
  cream: {
    label: 'Cream',
    wall: '#e6dcc6', wallShade: '#d3c7ae', skirt: '#9c8c72',
    floor: '#c58f5c', floorAlt: '#b9834f', seam: '#9a6a3d',
    rug: '#c98a72', rugAlt: '#b47762',
    accent: '#d8a04a', lamp: '#fff0c8',
    skyTop: '#7fb3d5', skyMid: '#bfd9e8', skyLow: '#eef4f0',
  },
}
export const PALETTE_IDS = Object.keys(PALETTES)

/**
 * The furniture catalogue. `on` decides which band a kind may occupy, `solid`
 * blocks walking, `action` is the core action this kind invites, and `initial`
 * is the state it starts in.
 */
export const PROP_KINDS = {
  desk: { label: 'Desk', w: 3, h: 1, on: 'floor', solid: true, action: 'work', verb: 'Work at the desk', initial: { busy: false } },
  chair: { label: 'Chair', w: 1, h: 1, on: 'floor', solid: true, action: 'sit', verb: 'Sit down' },
  bed: { label: 'Bed', w: 2, h: 3, on: 'floor', solid: true, action: 'sleep', verb: 'Sleep', initial: { made: true } },
  shelf: { label: 'Bookshelf', w: 2, h: 3, on: 'floor', solid: true, action: 'read', verb: 'Read from the shelf' },
  plant: { label: 'Plant', w: 1, h: 1, on: 'floor', solid: true, action: 'water', verb: 'Water the plant', initial: { watered: false } },
  lamp: { label: 'Lamp', w: 1, h: 1, on: 'floor', solid: true, action: 'light', verb: 'Switch the lamp', initial: { on: true } },
  cat: { label: 'Cat', w: 1, h: 1, on: 'floor', solid: true, action: 'pet', verb: 'Pet the cat' },
  server: { label: 'Server rack', w: 1, h: 2, on: 'floor', solid: true, action: 'check', verb: 'Check the rack', initial: { on: true } },
  rug: { label: 'Rug', w: 4, h: 3, on: 'floor', solid: false, action: 'dance', verb: 'Dance on the rug' },
  window: { label: 'Window', w: 3, h: 2, on: 'wall', solid: true, action: 'gaze', verb: 'Look out the window' },
  door: { label: 'Door', w: 2, h: 2, on: 'wall', solid: true, action: 'wave', verb: 'Answer the door' },
  poster: { label: 'Poster', w: 2, h: 1, on: 'wall', solid: true, action: 'think', verb: 'Study the poster' },
}
export const PROP_KIND_IDS = Object.keys(PROP_KINDS)

/**
 * The built-in action list. `requires` names a prop kind: the avatar walks to
 * the nearest one before the pose starts. `effects` run when the pose ends.
 */
export const CORE_ACTIONS = {
  wave: {
    label: 'Wave', description: 'Wave at whoever is looking.', pose: 'wave', ms: 1600, requires: null,
    effects: [{ op: 'stat', key: 'joy', delta: 2 }],
  },
  stretch: {
    label: 'Stretch', description: 'Stretch out the shoulders.', pose: 'stretch', ms: 2000, requires: null,
    effects: [{ op: 'stat', key: 'energy', delta: 3 }],
  },
  think: {
    label: 'Think', description: 'Pace one thought through.', pose: 'think', ms: 2400, requires: null,
    effects: [{ op: 'stat', key: 'focus', delta: 3 }],
  },
  dance: {
    label: 'Dance', description: 'Dance a couple of bars.', pose: 'dance', ms: 3000, requires: null,
    effects: [{ op: 'stat', key: 'joy', delta: 7 }, { op: 'stat', key: 'energy', delta: -2 }],
  },
  cheer: {
    label: 'Cheer', description: 'Throw both arms up.', pose: 'cheer', ms: 1800, requires: null,
    effects: [{ op: 'stat', key: 'joy', delta: 4 }],
  },
  work: {
    label: 'Work at the desk', description: 'Sit at the desk and type.', pose: 'type', ms: 4000, requires: 'desk',
    effects: [{ op: 'stat', key: 'focus', delta: 7 }, { op: 'stat', key: 'energy', delta: -3 }, { op: 'prop', key: 'busy', value: true }],
  },
  sleep: {
    label: 'Sleep', description: 'Sleep in the bed.', pose: 'sleep', ms: 6000, requires: 'bed',
    effects: [{ op: 'stat', key: 'energy', delta: 22 }, { op: 'stat', key: 'focus', delta: -2 }, { op: 'bubble', text: 'Zzz…' }],
  },
  read: {
    label: 'Read', description: 'Pull a book off the shelf.', pose: 'read', ms: 3200, requires: 'shelf',
    effects: [{ op: 'stat', key: 'focus', delta: 4 }, { op: 'stat', key: 'joy', delta: 2 }],
  },
  water: {
    label: 'Water the plant', description: 'Water the plant by the wall.', pose: 'water', ms: 2400, requires: 'plant',
    effects: [{ op: 'stat', key: 'joy', delta: 3 }, { op: 'prop', key: 'watered', value: true }],
  },
  gaze: {
    label: 'Look outside', description: 'Stand at the window and watch the sky.', pose: 'gaze', ms: 3000, requires: 'window',
    effects: [{ op: 'stat', key: 'joy', delta: 4 }, { op: 'stat', key: 'focus', delta: -1 }],
  },
  pet: {
    label: 'Pet the cat', description: 'Crouch down and pet the cat.', pose: 'pet', ms: 2600, requires: 'cat',
    effects: [{ op: 'stat', key: 'joy', delta: 5 }],
  },
  sit: {
    label: 'Sit down', description: 'Sit on the chair.', pose: 'sit', ms: 3000, requires: 'chair',
    effects: [{ op: 'stat', key: 'energy', delta: 2 }],
  },
  check: {
    label: 'Check the rack', description: 'Look at the server rack.', pose: 'point', ms: 2200, requires: 'server',
    effects: [{ op: 'stat', key: 'focus', delta: 2 }, { op: 'prop', key: 'on', toggle: true }],
  },
  light: {
    label: 'Switch the lamp', description: 'Switch the lamp on or off.', pose: 'point', ms: 1200, requires: 'lamp',
    effects: [{ op: 'prop', key: 'on', toggle: true }],
  },
}

/** Shirt colours; visitors are tinted from the same wheel. */
const SHIRTS = ['#5b8def', '#e0736b', '#6fbf8b', '#e0b25b', '#9a7be0', '#4fb3b8', '#d47ba8', '#8fae57']
const HAIRS = ['#2b2b33', '#4a3427', '#7c5a3a', '#c9b48a', '#3d2b45']
const SKINS = ['#f0c8a0', '#e2b189', '#c98e66', '#a8704c']

/** @param {number} value @param {number} min @param {number} max */
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

/** @param {string} text @param {number} max */
const trim = (text, max) => (typeof text === 'string' ? text.trim().slice(0, max) : '')

/** @param {number} index @param {string[]} list */
const pick = (index, list) => list[Math.abs(Math.trunc(index)) % list.length]

/**
 * Deterministic small integer from a string, used for colours and noise so a
 * room looks the same on every render and every restart.
 * @param {string} value
 */
export function hashOf(value) {
  let hash = 2166136261
  const text = String(value ?? '')
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** @param {string} seed @returns {{ shirt: string, hair: string, skin: string }} */
export function colorsFor(seed) {
  const hash = hashOf(seed)
  return {
    shirt: pick(hash, SHIRTS),
    hair: pick(hash >>> 3, HAIRS),
    skin: pick(hash >>> 7, SKINS),
  }
}

/** @param {{ energy: number, focus: number, joy: number }} stats */
export function deriveMood(stats) {
  if (stats.energy < 25) return 'tired'
  if (stats.joy >= 75) return 'happy'
  if (stats.focus >= 75) return 'focused'
  return 'calm'
}

/** @param {string} kind @returns {any} */
export function propSpec(kind) {
  return PROP_KINDS[kind] ?? null
}

/**
 * A fresh room: one window, a door, a desk with a chair, a bed, a shelf, a rug,
 * a lamp, a plant, a cat and a rack. The avatar starts on the rug.
 * @param {{ name?: string, seed?: string, palette?: string, body?: string }} [options]
 */
export function createRoom(options = {}) {
  const seed = trim(options.seed, 64) || `room-${Date.now().toString(36)}`
  const palette = PALETTE_IDS.includes(options.palette) ? options.palette : 'dawn'
  const body = normalizeBodyId(options.body)
  const room = {
    version: 1,
    createdAt: Date.now(),
    seed,
    palette,
    avatar: {
      name: trim(options.name, 48),
      body,
      x: 10,
      y: 9,
      facing: 'down',
      pose: 'idle',
      poseEndsAt: 0,
      onProp: null,
      mood: 'calm',
      stats: { energy: 72, focus: 58, joy: 66 },
      ...colorsFor(seed),
    },
    props: [],
    customActions: {},
    actionOverrides: {},
    log: [],
    say: null,
  }
  const place = (kind, x, y) => {
    const spec = PROP_KINDS[kind]
    room.props.push({ id: `${kind}-${room.props.length + 1}`, kind, x, y, state: { ...(spec.initial ?? {}) } })
  }
  // Wall furniture first so the floor reads left to right.
  place('poster', 11, 3)
  place('window', 2, 2)
  place('door', 16, 2)
  // Floor furniture.
  place('bed', 1, 9)
  place('shelf', 17, 4)
  place('desk', 4, 6)
  place('chair', 5, 7)
  place('lamp', 8, 5)
  place('rug', 8, 8)
  place('cat', 12, 8)
  place('server', 15, 11)
  place('plant', 18, 12)
  return room
}

/**
 * Validate a stored room and repair what can be repaired. A file written by an
 * older or newer version must never blank the panel, so unknown props are
 * dropped and missing fields are filled from the default room.
 * @param {any} raw
 * @returns {any}
 */
export function normalizeRoom(raw) {
  const fallback = createRoom()
  if (raw === null || typeof raw !== 'object') return fallback
  const room = {
    version: Number.isFinite(raw.version) ? Math.max(1, Math.trunc(raw.version)) : 1,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    seed: typeof raw.seed === 'string' && raw.seed !== '' ? raw.seed : fallback.seed,
    palette: PALETTE_IDS.includes(raw.palette) ? raw.palette : 'dawn',
    avatar: { ...fallback.avatar, ...(raw.avatar !== null && typeof raw.avatar === 'object' ? raw.avatar : {}) },
    props: [],
    customActions: {},
    actionOverrides: {},
    log: Array.isArray(raw.log) ? raw.log.filter((row) => row !== null && typeof row === 'object' && typeof row.text === 'string').slice(-MAX_LOG) : [],
    say: raw.say !== null && typeof raw.say === 'object' && typeof raw.say.text === 'string' ? raw.say : null,
  }
  const stats = room.avatar.stats !== null && typeof room.avatar.stats === 'object' ? room.avatar.stats : {}
  room.avatar.stats = {
    energy: clamp(Number(stats.energy) || 0, 0, 100),
    focus: clamp(Number(stats.focus) || 0, 0, 100),
    joy: clamp(Number(stats.joy) || 0, 0, 100),
  }
  room.avatar.pose = POSES.includes(room.avatar.pose) ? room.avatar.pose : 'idle'
  room.avatar.facing = FACINGS.includes(room.avatar.facing) ? room.avatar.facing : 'down'
  room.avatar.mood = MOODS.includes(room.avatar.mood) ? room.avatar.mood : 'calm'
  room.avatar.poseEndsAt = Number.isFinite(room.avatar.poseEndsAt) ? room.avatar.poseEndsAt : 0
  room.avatar.name = typeof room.avatar.name === 'string' ? room.avatar.name.slice(0, 48) : ''
  room.avatar.body = normalizeBodyId(room.avatar.body)
  const colors = colorsFor(room.seed)
  for (const key of ['shirt', 'hair', 'skin']) {
    if (typeof room.avatar[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(room.avatar[key])) room.avatar[key] = colors[key]
  }

  const seen = new Set()
  for (const row of Array.isArray(raw.props) ? raw.props : []) {
    if (row === null || typeof row !== 'object') continue
    const spec = PROP_KINDS[row.kind]
    if (spec === undefined) continue
    const id = typeof row.id === 'string' && row.id !== '' ? row.id.slice(0, 40) : `prop-${seen.size + 1}`
    if (seen.has(id)) continue
    if (!Number.isInteger(row.x) || !Number.isInteger(row.y)) continue
    if (row.x < 0 || row.y < 0 || row.x + spec.w > ROOM_W || row.y + spec.h > ROOM_H) continue
    if (room.props.some((other) => overlaps(other, { x: row.x, y: row.y, kind: row.kind }))) continue
    seen.add(id)
    room.props.push({
      id,
      kind: row.kind,
      x: row.x,
      y: row.y,
      state: row.state !== null && typeof row.state === 'object' ? { ...row.state } : { ...(spec.initial ?? {}) },
    })
  }
  if (room.props.length === 0) room.props = fallback.props

  for (const [name, draft] of Object.entries(raw.customActions !== null && typeof raw.customActions === 'object' ? raw.customActions : {})) {
    if (Object.keys(room.customActions).length >= MAX_CUSTOM_ACTIONS) break
    const checked = validateActionDraft(name, draft)
    if (checked.ok) room.customActions[name] = { ...checked.value, createdBy: 'agent' }
  }
  for (const [name, patch] of Object.entries(raw.actionOverrides !== null && typeof raw.actionOverrides === 'object' ? raw.actionOverrides : {})) {
    if (CORE_ACTIONS[name] === undefined) continue
    const checked = validateActionDraft(name, { ...CORE_ACTIONS[name], ...patch, name }, { allowPartial: true })
    if (checked.ok) room.actionOverrides[name] = checked.value
  }

  // The avatar must stand somewhere legal; otherwise take the default spawn.
  if (!isWalkable(room, room.avatar.x, room.avatar.y)) {
    room.avatar.x = fallback.avatar.x
    room.avatar.y = fallback.avatar.y
    if (!isWalkable(room, room.avatar.x, room.avatar.y)) {
      const spot = firstWalkable(room)
      room.avatar.x = spot.x
      room.avatar.y = spot.y
    }
  }
  room.avatar.x = Math.trunc(room.avatar.x)
  room.avatar.y = Math.trunc(room.avatar.y)
  room.avatar.onProp = typeof room.avatar.onProp === 'string' ? room.avatar.onProp : null
  return room
}

/** @param {{ x: number, y: number, kind: string }} a @param {any} b */
function overlaps(a, b) {
  const specA = PROP_KINDS[a.kind]
  const specB = PROP_KINDS[b.kind]
  if (specA === undefined || specB === undefined) return false
  return a.x < b.x + specB.w && b.x < a.x + specA.w && a.y < b.y + specB.h && b.y < a.y + specA.h
}

/** @param {any} prop @returns {{ x: number, y: number, w: number, h: number }} */
export function propRect(prop) {
  const spec = PROP_KINDS[prop.kind]
  return { x: prop.x, y: prop.y, w: spec?.w ?? 1, h: spec?.h ?? 1 }
}

/** @param {any} room @param {string} id @returns {any | null} */
export function propById(room, id) {
  return room.props.find((prop) => prop.id === id) ?? null
}

/** @param {any} room @param {number} x @param {number} y @returns {any | null} */
export function propAt(room, x, y) {
  for (const prop of room.props) {
    const rect = propRect(prop)
    if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) return prop
  }
  return null
}

/**
 * Can the avatar stand on this tile?
 * @param {any} room @param {number} x @param {number} y
 */
export function isWalkable(room, x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false
  if (x < 0 || y < WALL_ROWS || x >= ROOM_W || y >= ROOM_H) return false
  for (const prop of room.props) {
    if (PROP_KINDS[prop.kind]?.solid !== true) continue
    const rect = propRect(prop)
    if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) return false
  }
  return true
}

/** @param {any} room @returns {{ x: number, y: number }} */
function firstWalkable(room) {
  for (let y = WALL_ROWS; y < ROOM_H; y += 1) {
    for (let x = 0; x < ROOM_W; x += 1) if (isWalkable(room, x, y)) return { x, y }
  }
  return { x: 1, y: WALL_ROWS }
}

/**
 * Which way to look when stepping from one tile to another.
 * @param {{ x: number, y: number }} from @param {{ x: number, y: number }} to
 * @returns {string}
 */
export function facingToward(from, to) {
  return facingFrom(from.x, from.y, to)
}

/** @param {number} x @param {number} y @param {{ x: number, y: number }} to @returns {string} */
function facingFrom(x, y, to) {
  const dx = to.x - x
  const dy = to.y - y
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : dx < 0 ? 'left' : 'down'
  return dy > 0 ? 'down' : 'up'
}

/**
 * Breadth-first walk plan across walkable tiles. Returns the tiles to enter, in
 * order, and an empty array when the avatar is already there.
 * @param {any} room
 * @param {{ x: number, y: number }} from
 * @param {{ x: number, y: number }} to
 * @returns {Array<{ x: number, y: number }> | null}
 */
export function findPath(room, from, to) {
  if (!isWalkable(room, to.x, to.y)) return null
  if (from.x === to.x && from.y === to.y) return []
  const key = (x, y) => y * ROOM_W + x
  const start = key(from.x, from.y)
  const goal = key(to.x, to.y)
  const cameFrom = new Map([[start, null]])
  const queue = [{ x: from.x, y: from.y }]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current.x === to.x && current.y === to.y) {
      const path = []
      let cursor = goal
      while (cursor !== null && cursor !== start) {
        path.push({ x: cursor % ROOM_W, y: Math.floor(cursor / ROOM_W) })
        cursor = cameFrom.get(cursor)
      }
      return path.reverse()
    }
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = current.x + dx
      const ny = current.y + dy
      if (!isWalkable(room, nx, ny)) continue
      const next = key(nx, ny)
      if (cameFrom.has(next)) continue
      cameFrom.set(next, key(current.x, current.y))
      queue.push({ x: nx, y: ny })
    }
  }
  return null
}

/**
 * Every floor tile the avatar could stand on to use this prop, with the facing
 * that points at it.
 * @param {any} room @param {any} prop
 * @returns {Array<{ x: number, y: number, facing: string }>}
 */
export function approachTiles(room, prop) {
  const rect = propRect(prop)
  const seen = new Set()
  const spots = []
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const nx = x + dx
        const ny = y + dy
        const key = `${nx},${ny}`
        if (seen.has(key)) continue
        seen.add(key)
        if (!isWalkable(room, nx, ny)) continue
        spots.push({ x: nx, y: ny, facing: facingFrom(nx, ny, { x, y }) })
      }
    }
  }
  return spots
}

/**
 * The nearest reachable interaction spot for one prop.
 * @param {any} room @param {any} prop @param {{ x: number, y: number }} from
 * @returns {{ x: number, y: number, facing: string, path: Array<{ x: number, y: number }> } | null}
 */
export function findApproach(room, prop, from) {
  let best = null
  for (const spot of approachTiles(room, prop)) {
    const path = findPath(room, from, spot)
    if (path === null) continue
    if (best === null || path.length < best.path.length) best = { ...spot, path }
  }
  return best
}

/**
 * The nearest prop of one kind by walk distance, so an action always uses the
 * piece of furniture the avatar can actually reach.
 * @param {any} room @param {string} kind @param {{ x: number, y: number }} from
 * @returns {{ prop: any, approach: { x: number, y: number, facing: string, path: Array<{ x: number, y: number }> } } | null}
 */
export function nearestProp(room, kind, from) {
  let best = null
  for (const prop of room.props) {
    if (prop.kind !== kind) continue
    const approach = findApproach(room, prop, from)
    if (approach === null) continue
    if (best === null || approach.path.length < best.approach.path.length) best = { prop, approach }
  }
  return best
}

/** @param {string} name @param {any} value */
function actionFrom(name, base, source) {
  return {
    name,
    source,
    label: trim(base.label, 48) || name,
    description: trim(base.description, 200),
    pose: POSES.includes(base.pose) ? base.pose : 'idle',
    ms: clamp(Math.trunc(Number(base.ms) || 1600), ACTION_MIN_MS, ACTION_MAX_MS),
    requires: PROP_KINDS[base.requires] === undefined ? null : base.requires,
    bubble: trim(base.bubble, 160),
    effects: Array.isArray(base.effects) ? base.effects : [],
  }
}

/**
 * The effective definition of one action: a custom action, a core action, or a
 * core action with the agent's override applied.
 * @param {any} room @param {string} name
 * @returns {any | null}
 */
export function resolveAction(room, name) {
  const custom = room.customActions?.[name]
  if (custom !== undefined) return actionFrom(name, custom, 'custom')
  const core = CORE_ACTIONS[name]
  if (core === undefined) return null
  const override = room.actionOverrides?.[name]
  return actionFrom(name, override === undefined ? core : { ...core, ...override }, override === undefined ? 'core' : 'edited')
}

/** @param {any} room @returns {any[]} every action the room can run right now. */
export function listActions(room) {
  const names = [...Object.keys(CORE_ACTIONS), ...Object.keys(room.customActions ?? {})]
  return names.map((name) => resolveAction(room, name)).filter((action) => action !== null)
}

/** @param {any} room @returns {any[]} */
export function listCustomActions(room) {
  return Object.entries(room.customActions ?? {}).map(([name, value]) => ({ name, ...value }))
}

/**
 * @param {string} name
 * @param {any} draft
 * @param {{ allowPartial?: boolean }} [options]
 * @returns {{ ok: true, value: any } | { ok: false, error: string }}
 */
export function validateActionDraft(name, draft, options = {}) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{1,23}$/.test(name)) {
    return { ok: false, error: 'name must match ^[a-z][a-z0-9_]{1,23}$ (lowercase letters, digits, underscore; 2-24 characters)' }
  }
  if (draft === null || typeof draft !== 'object') return { ok: false, error: 'action must be an object' }
  if (!POSES.includes(draft.pose)) return { ok: false, error: `pose must be one of: ${POSES.join(', ')}` }
  const ms = Number(draft.ms)
  if (!Number.isFinite(ms) || ms < ACTION_MIN_MS || ms > ACTION_MAX_MS) {
    return { ok: false, error: `ms must be a number between ${ACTION_MIN_MS} and ${ACTION_MAX_MS}` }
  }
  const requires = draft.requires === undefined || draft.requires === null || draft.requires === ''
    ? null
    : String(draft.requires)
  if (requires !== null && PROP_KINDS[requires] === undefined) {
    return { ok: false, error: `requires must be null or one of: ${PROP_KIND_IDS.join(', ')}` }
  }
  const label = trim(draft.label, 48)
  if (label === '') return { ok: false, error: 'label is required' }
  const description = trim(draft.description, 200)
  const bubble = trim(draft.bubble, 160)
  const rawEffects = draft.effects === undefined || draft.effects === null ? [] : draft.effects
  if (!Array.isArray(rawEffects)) return { ok: false, error: 'effects must be an array' }
  if (rawEffects.length > 8) return { ok: false, error: 'at most 8 effects per action' }
  const effects = []
  for (const effect of rawEffects) {
    const checked = validateEffect(effect)
    if (!checked.ok) return checked
    effects.push(checked.value)
  }
  if (options.allowPartial !== true && effects.length === 0) {
    // An action with no effect is legal but pointless; a bubble counts.
    if (bubble === '') effects.push({ op: 'stat', key: 'joy', delta: 1 })
  }
  return { ok: true, value: { label, description, pose: draft.pose, ms: Math.trunc(ms), requires, bubble, effects } }
}

/** @param {any} effect @returns {{ ok: true, value: any } | { ok: false, error: string }} */
export function validateEffect(effect) {
  if (effect === null || typeof effect !== 'object') return { ok: false, error: 'each effect must be an object' }
  const op = String(effect.op ?? '')
  if (!EFFECT_OPS.includes(op)) return { ok: false, error: `effect op must be one of: ${EFFECT_OPS.join(', ')}` }
  if (op === 'stat') {
    const key = String(effect.key ?? '')
    if (!STAT_KEYS.includes(key)) return { ok: false, error: `stat effect key must be one of: ${STAT_KEYS.join(', ')}` }
    const delta = Number(effect.delta)
    if (!Number.isFinite(delta) || Math.abs(delta) > 50) return { ok: false, error: 'stat delta must be between -50 and 50' }
    return { ok: true, value: { op, key, delta: Math.trunc(delta) } }
  }
  if (op === 'mood') {
    if (!MOODS.includes(String(effect.value))) return { ok: false, error: `mood effect value must be one of: ${MOODS.join(', ')}` }
    return { ok: true, value: { op, value: String(effect.value) } }
  }
  if (op === 'bubble' || op === 'log') {
    const text = trim(effect.text, op === 'log' ? 120 : 160)
    if (text === '') return { ok: false, error: `${op} effect needs text` }
    return { ok: true, value: { op, text } }
  }
  // prop
  const key = trim(effect.key, 24)
  if (key === '') return { ok: false, error: 'prop effect needs key' }
  const value = typeof effect.value === 'boolean' ? effect.value : effect.value === undefined ? true : Boolean(effect.value)
  return { ok: true, value: { op, key, value, ...(effect.toggle === true ? { toggle: true } : {}) } }
}

/**
 * Add an agent-authored action, or turn the call into an override when the name
 * belongs to a core action.
 * @param {any} room @param {string} name @param {any} draft
 * @returns {{ ok: true, action: any, mode: 'created' | 'edited' } | { ok: false, error: string }}
 */
export function addAction(room, name, draft) {
  const checked = validateActionDraft(name, draft)
  if (!checked.ok) return checked
  if (CORE_ACTIONS[name] !== undefined || room.customActions?.[name] !== undefined) {
    const patched = patchAction(room, name, checked.value)
    if (!patched.ok) return patched
    return { ok: true, action: resolveAction(room, name), mode: 'edited' }
  }
  if (Object.keys(room.customActions ?? {}).length >= MAX_CUSTOM_ACTIONS) {
    return { ok: false, error: `this room already has ${MAX_CUSTOM_ACTIONS} custom actions; remove one first` }
  }
  room.customActions[name] = { ...checked.value, createdBy: 'agent', createdAt: Date.now() }
  room.version += 1
  return { ok: true, action: resolveAction(room, name), mode: 'created' }
}

/**
 * Patch a core or custom action. Patching a core action stores an override and
 * leaves the built-in definition intact, so removing the override restores it.
 * @param {any} room @param {string} name @param {any} patch
 * @returns {{ ok: true, action: any } | { ok: false, error: string }}
 */
export function patchAction(room, name, patch) {
  const current = resolveAction(room, name)
  if (current === null) return { ok: false, error: `no action named "${name}"` }
  const merged = {
    name,
    label: patch.label ?? current.label,
    description: patch.description ?? current.description,
    pose: patch.pose ?? current.pose,
    ms: patch.ms ?? current.ms,
    requires: patch.requires !== undefined ? patch.requires : current.requires,
    bubble: patch.bubble ?? current.bubble,
    effects: patch.effects !== undefined ? patch.effects : current.effects,
  }
  const checked = validateActionDraft(name, merged)
  if (!checked.ok) return checked
  const target = room.customActions?.[name]
  if (target !== undefined) {
    room.customActions[name] = { ...target, ...checked.value }
  } else {
    room.actionOverrides[name] = checked.value
  }
  room.version += 1
  return { ok: true, action: resolveAction(room, name) }
}

/**
 * Remove a custom action, or drop an override so the core action returns.
 * @param {any} room @param {string} name
 * @returns {{ ok: true, mode: 'removed' | 'restored' } | { ok: false, error: string }}
 */
export function removeAction(room, name) {
  if (room.customActions?.[name] !== undefined) {
    delete room.customActions[name]
    room.version += 1
    return { ok: true, mode: 'removed' }
  }
  if (room.actionOverrides?.[name] !== undefined) {
    delete room.actionOverrides[name]
    room.version += 1
    return { ok: true, mode: 'restored' }
  }
  return { ok: false, error: `no agent-authored action or override named "${name}"` }
}

/**
 * @param {any} room @param {string} id @param {{ x?: number, y?: number, state?: any }} patch
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function updateProp(room, id, patch) {
  const prop = propById(room, id)
  if (prop === null) return { ok: false, error: `no prop with id "${id}"` }
  if (patch.x !== undefined || patch.y !== undefined) {
    const next = { x: patch.x ?? prop.x, y: patch.y ?? prop.y }
    const check = canPlace(room, prop.kind, next.x, next.y, id)
    if (!check.ok) return check
    prop.x = next.x
    prop.y = next.y
  }
  if (patch.state !== undefined && patch.state !== null && typeof patch.state === 'object') {
    prop.state = { ...prop.state, ...patch.state }
  }
  room.version += 1
  return { ok: true }
}

/**
 * @param {any} room @param {string} kind @param {number} x @param {number} y
 * @param {string | null} [ignoreId]
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function canPlace(room, kind, x, y, ignoreId = null) {
  const spec = PROP_KINDS[kind]
  if (spec === undefined) return { ok: false, error: `unknown kind "${kind}"; known kinds: ${PROP_KIND_IDS.join(', ')}` }
  if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, error: 'x and y must be whole tile coordinates' }
  if (x < 0 || y < 0 || x + spec.w > ROOM_W || y + spec.h > ROOM_H) {
    return { ok: false, error: `${kind} is ${spec.w}x${spec.h}; it does not fit at (${x},${y}) in a ${ROOM_W}x${ROOM_H} room` }
  }
  if (spec.on === 'wall' && y + spec.h !== WALL_ROWS) {
    return { ok: false, error: `wall props must sit on wall rows ending at ${WALL_ROWS - 1} (y + h === ${WALL_ROWS}) so the avatar can stand in front of them` }
  }
  if (spec.on === 'floor' && y < WALL_ROWS) {
    return { ok: false, error: `floor props need y >= ${WALL_ROWS}` }
  }
  if (spec.solid
    && room.avatar.x >= x && room.avatar.x < x + spec.w
    && room.avatar.y >= y && room.avatar.y < y + spec.h) {
    return { ok: false, error: 'the avatar is standing on that tile; move it first' }
  }
  for (const other of room.props) {
    if (other.id === ignoreId) continue
    if (overlaps({ x, y, kind }, other)) {
      return { ok: false, error: `overlaps ${other.id} (${other.kind}) at (${other.x},${other.y})` }
    }
  }
  if (spec.solid) {
    // The piece must not seal itself off: at least one interaction tile has to
    // stay reachable from the avatar.
    const probe = { ...room, props: [...room.props.filter((p) => p.id !== ignoreId), { id: '__probe', kind, x, y, state: {} }] }
    const spot = approachTiles(probe, probe.props[probe.props.length - 1]).some(
      (tile) => findPath(probe, { x: room.avatar.x, y: room.avatar.y }, tile) !== null,
    )
    if (!spot) return { ok: false, error: `${kind} would have no reachable tile to stand on` }
  }
  return { ok: true }
}

/**
 * @param {any} room @param {string} kind @param {number} x @param {number} y
 * @param {{ id?: string, state?: any }} [options]
 * @returns {{ ok: true, prop: any } | { ok: false, error: string }}
 */
export function addProp(room, kind, x, y, options = {}) {
  if (room.props.length >= MAX_PROPS) return { ok: false, error: `the room already holds ${MAX_PROPS} props; remove one first` }
  const check = canPlace(room, kind, x, y)
  if (!check.ok) return check
  const id = trim(options.id, 40) || `${kind}-${Object.keys(room.props).length + 1}`
  if (propById(room, id) !== null) return { ok: false, error: `a prop named "${id}" already exists` }
  const prop = {
    id,
    kind,
    x,
    y,
    state: { ...(PROP_KINDS[kind].initial ?? {}), ...(options.state !== null && typeof options.state === 'object' ? options.state : {}) },
  }
  room.props.push(prop)
  room.version += 1
  return { ok: true, prop }
}

/**
 * @param {any} room @param {string} id
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function removeProp(room, id) {
  const index = room.props.findIndex((prop) => prop.id === id)
  if (index < 0) return { ok: false, error: `no prop with id "${id}"` }
  room.props.splice(index, 1)
  room.version += 1
  return { ok: true }
}

/**
 * @param {any} room @param {string} palette
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function setPalette(room, palette) {
  if (!PALETTE_IDS.includes(palette)) return { ok: false, error: `palette must be one of: ${PALETTE_IDS.join(', ')}` }
  room.palette = palette
  room.version += 1
  return { ok: true }
}

/**
 * Swap the avatar's body for another shipped species. The body is data, so this
 * changes nothing about the room, the furniture or the actions — only which
 * table the panel paints.
 * @param {any} room @param {string} body
 * @returns {{ ok: true, body: string } | { ok: false, error: string }}
 */
export function setBody(room, body) {
  if (!BODY_IDS.includes(body)) return { ok: false, error: `body must be one of: ${BODY_IDS.join(', ')}` }
  room.avatar.body = body
  room.version += 1
  return { ok: true, body }
}

/**
 * Append one line to the room's own activity log.
 * @param {any} room @param {string} text
 */
export function logAction(room, text) {
  room.log.push({ at: Date.now(), text: trim(text, 160) })
  if (room.log.length > MAX_LOG) room.log.splice(0, room.log.length - MAX_LOG)
}

/**
 * @param {any} room @param {string} text
 * @param {number} [ttlMs]
 */
export function say(room, text, ttlMs = 6000) {
  const value = trim(text, 160)
  if (value === '') {
    room.say = null
    return
  }
  room.say = { text: value, at: Date.now(), until: Date.now() + clamp(Number(ttlMs) || 6000, 800, 20000) }
}

/**
 * Run one action's effects. Stats clamp at 0..100, an explicit mood wins, and
 * otherwise the mood follows the stats so the face always matches the numbers.
 * @param {any} room
 * @param {any[]} effects
 * @param {{ prop?: any | null }} [context]
 * @returns {string[]} one short line per applied effect.
 */
export function applyEffects(room, effects, context = {}) {
  const applied = []
  let moodSet = false
  for (const effect of effects ?? []) {
    if (effect.op === 'stat') {
      const before = room.avatar.stats[effect.key]
      room.avatar.stats[effect.key] = clamp(before + effect.delta, 0, 100)
      const change = room.avatar.stats[effect.key] - before
      if (change !== 0) applied.push(`${effect.key} ${change > 0 ? '+' : ''}${change}`)
    } else if (effect.op === 'mood') {
      if (MOODS.includes(effect.value)) {
        room.avatar.mood = effect.value
        moodSet = true
        applied.push(`mood ${effect.value}`)
      }
    } else if (effect.op === 'bubble') {
      say(room, effect.text)
      applied.push(`said "${effect.text}"`)
    } else if (effect.op === 'prop') {
      const prop = context.prop ?? null
      if (prop === null) continue
      const next = effect.toggle === true
        ? (prop.state?.[effect.key] === true ? false : true)
        : (effect.value === undefined ? true : effect.value)
      prop.state = { ...(prop.state ?? {}), [effect.key]: next }
      applied.push(`${prop.kind} ${effect.key}=${String(next)}`)
    } else if (effect.op === 'log') {
      logAction(room, effect.text)
      applied.push('logged')
    }
  }
  if (!moodSet) room.avatar.mood = deriveMood(room.avatar.stats)
  return applied
}

/**
 * The scene the Web panel paints. Positions are tiles; the client scales them.
 * @param {any} room
 * @param {{ visitors?: any[], now?: number, name?: string }} [options]
 * @returns {any}
 */
export function sceneView(room, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const palette = PALETTES[room.palette] ?? PALETTES.dusk
  const avatar = room.avatar
  const activeProp = avatar.onProp === null ? null : propById(room, avatar.onProp)
  const activeRect = activeProp === null ? null : propRect(activeProp)
  const nowDate = new Date(now)
  const hour = nowDate.getHours()
  const visitors = (options.visitors ?? []).slice(0, 4)
  // The panel paints bodies from data, so the scene ships the tables it needs:
  // the avatar's own body plus whatever the visitors wear. A new species reaches
  // the browser with the next poll, never with a rebuild.
  // The panel paints bodies in device pixels, so the tables travel scaled: one
  // tile is UNIT pixels wide, and a body stays exactly one tile tall.
  const bodies = sceneBodies([normalizeBodyId(avatar.body), ...visitors.map((visitor) => normalizeBodyId(visitor?.body))])
  return {
    now,
    version: room.version,
    room: { w: ROOM_W, h: ROOM_H, wall: WALL_ROWS, tile: TILE },
    // Device pixels per art unit: the panel paints at 2x, so a body table is
    // scaled on arrival and one tile is 32 device pixels.
    unit: UNIT,
    paletteId: room.palette,
    palette,
    bodies,
    clock: {
      hour,
      minute: nowDate.getMinutes(),
      phase: hour < 5 ? 'night' : hour < 8 ? 'dawn' : hour < 17 ? 'day' : hour < 20 ? 'dusk' : 'night',
    },
    props: room.props.map((prop) => {
      const rect = propRect(prop)
      return { id: prop.id, kind: prop.kind, x: rect.x, y: rect.y, w: rect.w, h: rect.h, state: prop.state ?? {} }
    }),
    avatar: {
      name: options.name ?? avatar.name,
      body: normalizeBodyId(avatar.body),
      x: avatar.x,
      y: avatar.y,
      facing: avatar.facing,
      pose: avatar.pose,
      poseLeftMs: Math.max(0, Math.trunc(avatar.poseEndsAt - now)),
      mood: avatar.mood,
      stats: { ...avatar.stats },
      shirt: avatar.shirt,
      hair: avatar.hair,
      skin: avatar.skin,
    },
    active: activeRect === null ? null : {
      id: activeProp.id,
      kind: activeProp.kind,
      x: activeRect.x,
      y: activeRect.y,
      w: activeRect.w,
      h: activeRect.h,
    },
    say: room.say === null || room.say.until < now ? null : { text: room.say.text, ageMs: now - room.say.at },
    visitors,
    log: room.log.slice(-8).reverse(),
    actions: listActions(room).map((action) => ({
      name: action.name,
      label: action.label,
      pose: action.pose,
      requires: action.requires,
      source: action.source,
    })),
  }
}

/**
 * Device-space body tables for a scene. The one place scaling happens, so the
 * Web panel, the room route and the test fixtures cannot drift apart.
 * @param {string[]} ids
 * @returns {Record<string, any>}
 */
export function sceneBodies(ids) {
  /** @type {Record<string, any>} */
  const out = {}
  for (const [id, body] of Object.entries(bodiesFor(ids))) out[id] = scaleBody(body, UNIT)
  return out
}

/**
 * Model-facing summary of the room: where the avatar is, what furniture exists
 * and which actions are available. Kept compact on purpose.
 * @param {any} room
 * @returns {string}
 */
export function describeRoom(room) {
  const avatar = room.avatar
  const lines = []
  lines.push(`Room ${ROOM_W}x${ROOM_H} tiles (wall rows 0-${WALL_ROWS - 1}); palette ${room.palette}.`)
  const body = bodyFor(avatar.body)
  lines.push(`Avatar body: ${body.label} (${body.id}); other bodies: ${BODY_IDS.filter((id) => id !== body.id).join(', ')}.`)
  lines.push(`Avatar at (${avatar.x},${avatar.y}) facing ${avatar.facing}, pose ${avatar.pose}, mood ${avatar.mood}; energy ${avatar.stats.energy}, focus ${avatar.stats.focus}, joy ${avatar.stats.joy}.`)
  for (const prop of room.props) {
    const rect = propRect(prop)
    const state = Object.entries(prop.state ?? {})
    const detail = state.length === 0 ? '' : ` [${state.map(([key, value]) => `${key}=${String(value)}`).join(' ')}]`
    lines.push(`- ${prop.id}: ${prop.kind} at (${rect.x},${rect.y}) ${rect.w}x${rect.h}${detail}`)
  }
  return lines.join('\n')
}
