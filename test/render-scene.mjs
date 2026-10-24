/**
 * Render the pixel room to a PNG so the artwork can be inspected without a
 * browser. It boots `plugin/client.js` against a stub React/DOM, mounts the
 * panel, and replays the paint calls into a pixel buffer.
 *
 *   node test/render-scene.mjs            # writes test/out/*.png
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { PALETTES, sceneBodies } from '../plugin/lib/room.js'
import { UNIT } from '../plugin/lib/body.js'
import { createHarness } from './lib/harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const defaultSource = readFileSync(join(here, '..', 'plugin', 'client.js'), 'utf8')
const outDir = join(here, 'out')

// --------------------------------------------------------------- tiny canvas

/** @param {string} css */
function parseColor(css) {
  if (typeof css !== 'string') return [0, 0, 0, 1]
  if (css[0] === '#') {
    const hex = css.slice(1)
    const full = hex.length === 3 ? hex.split('').map((ch) => ch + ch).join('') : hex
    const value = Number.parseInt(full.slice(0, 6), 16)
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255, 1]
  }
  const match = css.match(/rgba?\(([^)]+)\)/)
  if (match !== null) {
    const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()))
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1]
  }
  return [0, 0, 0, 1]
}

/** A 2D context that paints into a buffer instead of a screen. */
function createContext(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  const state = { fillStyle: '#000000', font: '', textBaseline: 'alphabetic', imageSmoothingEnabled: false }
  const ops = { fillRect: 0, fillText: 0, clearRect: 0 }
  // The panel paints the room through a scale transform (unit device px per art
  // unit), so the stub has to honour setTransform for axis-aligned fills.
  let matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const mapX = (x, y) => matrix.a * x + matrix.c * y + matrix.e
  const mapY = (x, y) => matrix.b * x + matrix.d * y + matrix.f

  const blend = (x, y, color) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const index = (y * width + x) * 4
    const alpha = color[3]
    for (let channel = 0; channel < 3; channel += 1) {
      pixels[index + channel] = Math.round(color[channel] * alpha + pixels[index + channel] * (1 - alpha))
    }
    pixels[index + 3] = Math.max(pixels[index + 3], Math.round(alpha * 255))
  }

  const context = {
    get fillStyle() { return state.fillStyle },
    set fillStyle(value) { state.fillStyle = value },
    get font() { return state.font },
    set font(value) { state.font = value },
    get textBaseline() { return state.textBaseline },
    set textBaseline(value) { state.textBaseline = value },
    get imageSmoothingEnabled() { return state.imageSmoothingEnabled },
    set imageSmoothingEnabled(value) { state.imageSmoothingEnabled = value },
    setTransform(a, b, c, d, e, f) { matrix = { a, b, c, d, e, f } },
    fillRect(x, y, w, h) {
      ops.fillRect += 1
      const color = parseColor(state.fillStyle)
      const x1 = mapX(x, y)
      const y1 = mapY(x, y)
      const x2 = mapX(x + w, y + h)
      const y2 = mapY(x + w, y + h)
      const left = Math.round(Math.min(x1, x2))
      const top = Math.round(Math.min(y1, y2))
      const right = Math.round(Math.max(x1, x2))
      const bottom = Math.round(Math.max(y1, y2))
      for (let row = top; row < bottom; row += 1) {
        for (let column = left; column < right; column += 1) blend(column, row, color)
      }
    },
    clearRect(x, y, w, h) {
      ops.clearRect += 1
      const x1 = Math.round(Math.min(mapX(x, y), mapX(x + w, y + h)))
      const y1 = Math.round(Math.min(mapY(x, y), mapY(x + w, y + h)))
      const x2 = Math.round(Math.max(mapX(x, y), mapX(x + w, y + h)))
      const y2 = Math.round(Math.max(mapY(x, y), mapY(x + w, y + h)))
      for (let row = y1; row < y2; row += 1) {
        for (let column = x1; column < x2; column += 1) {
          if (column < 0 || row < 0 || column >= width || row >= height) continue
          const index = (row * width + column) * 4
          pixels[index] = 0
          pixels[index + 1] = 0
          pixels[index + 2] = 0
          pixels[index + 3] = 0
        }
      }
    },
    fillText(text, x, y) {
      ops.fillText += 1
      // Text is measured, not rasterised: the PNG check is about the room.
      void text
      void x
      void y
    },
    measureText(text) {
      return { width: String(text).length * 4 }
    },
  }
  return { context, pixels, ops }
}

// --------------------------------------------------------------- png encoder

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** @param {Buffer} buffer */
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** @param {Uint8ClampedArray} pixels @param {number} width @param {number} height @param {number} scale */
function encodePng(pixels, width, height, scale) {
  const outW = width * scale
  const outH = height * scale
  const raw = Buffer.alloc((outW * 4 + 1) * outH)
  for (let y = 0; y < outH; y += 1) {
    raw[y * (outW * 4 + 1)] = 0
    for (let x = 0; x < outW; x += 1) {
      const sourceIndex = (Math.floor(y / scale) * width + Math.floor(x / scale)) * 4
      const target = y * (outW * 4 + 1) + 1 + x * 4
      raw[target] = pixels[sourceIndex]
      raw[target + 1] = pixels[sourceIndex + 1]
      raw[target + 2] = pixels[sourceIndex + 2]
      raw[target + 3] = 255
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(outW, 0)
  header.writeUInt32BE(outH, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --------------------------------------------------------------- react shim

// The shared harness expands components and runs effects like a renderer.
// --------------------------------------------------------------- scene render

/** A scene payload shaped like the Host's `/cradle/scene` answer. */
function scenePayload(overrides = {}) {
  const palette = {
    label: 'Dusk', wall: '#544763', wallShade: '#453a55', skirt: '#302838',
    floor: '#7b5b40', floorAlt: '#715238', seam: '#5f442e',
    rug: '#94566b', rugAlt: '#7d4759', accent: '#f0c46a', lamp: '#ffd9a0',
    skyTop: '#2b2745', skyMid: '#493d61', skyLow: '#7c5b74',
  }
  const props = [
    { id: 'poster-1', kind: 'poster', x: 11, y: 3, w: 2, h: 1, state: {} },
    { id: 'window-2', kind: 'window', x: 2, y: 2, w: 3, h: 2, state: {} },
    { id: 'door-3', kind: 'door', x: 16, y: 2, w: 2, h: 2, state: {} },
    { id: 'bed-4', kind: 'bed', x: 1, y: 9, w: 2, h: 3, state: {} },
    { id: 'shelf-5', kind: 'shelf', x: 17, y: 4, w: 2, h: 3, state: {} },
    { id: 'desk-6', kind: 'desk', x: 4, y: 6, w: 3, h: 1, state: { busy: false } },
    { id: 'chair-7', kind: 'chair', x: 5, y: 7, w: 1, h: 1, state: {} },
    { id: 'lamp-8', kind: 'lamp', x: 8, y: 5, w: 1, h: 1, state: { on: true } },
    { id: 'rug-9', kind: 'rug', x: 8, y: 8, w: 4, h: 3, state: {} },
    { id: 'cat-10', kind: 'cat', x: 12, y: 8, w: 1, h: 1, state: {} },
    { id: 'server-11', kind: 'server', x: 15, y: 11, w: 1, h: 2, state: { on: true } },
    { id: 'plant-12', kind: 'plant', x: 18, y: 12, w: 1, h: 1, state: { watered: true } },
  ]
  return {
    now: Date.now(),
    version: 4,
    room: { w: 20, h: 14, wall: 4, tile: 16 },
    paletteId: 'dusk',
    palette,
    clock: { hour: 14, minute: 20, phase: 'day' },
    props,
    // The Host ships the body tables with the scene; without them the panel can
    // only paint its placeholder, which is exactly what this route must not do.
    unit: UNIT,
    bodies: sceneBodies([]),
    avatar: {
      name: 'DESKTOP · DEFAULT',
      x: 10, y: 9, facing: 'down', pose: 'idle', poseLeftMs: 0,
      mood: 'calm', stats: { energy: 72, focus: 58, joy: 66 },
      shirt: '#5b8def', hair: '#2b2b33', skin: '#f0c8a0',
    },
    active: null,
    say: null,
    visitors: [],
    log: [],
    actions: [],
    agency: {
      mode: 'awake', reason: '', frames: 3, frameSeconds: 900, paused: false,
      tokensUsed: 4200, tokenBudget: 20000, activeMs: 360000, minutesBudget: 30, nextFrameInMs: 120000,
    },
    ...overrides,
  }
}

/** Boot the bundle and mount the page; returns { paint, ops, pixels }. */
function renderScene(scene, { time = 0, source = defaultSource } = {}) {
  let definition = null
  const windowStub = { __ModuleLoader__: { load(value) { definition = value } } }
  const frames = []
  const canvasRegistry = []

  const renderer = { context: null, pixels: null, ops: null }
  // One canvas per bundle, like a real DOM node reused across re-renders.
  let cached = null
  const makeCanvas = () => {
    if (cached !== null) return cached
    // The panel paints at `unit` device pixels per art unit.
    const unit = Number(scene.unit) >= 1 ? Math.round(Number(scene.unit)) : 1
    const width = 320 * unit
    const height = 224 * unit
    const made = createContext(width, height)
    renderer.context = made.context
    renderer.pixels = made.pixels
    renderer.ops = made.ops
    cached = { width, height, getContext: () => made.context }
    return cached
  }

  const documentStub = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
    getElementById() { return null },
    createElement() { return makeCanvas() },
  }
  const fetchStub = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes('/cradle/scene') ? scene : statePayload()),
  })

  const run = new Function(
    'window', 'document', 'fetch', 'setInterval', 'clearInterval',
    'requestAnimationFrame', 'cancelAnimationFrame', source,
  )
  run(
    windowStub,
    documentStub,
    fetchStub,
    () => 0,
    () => {},
    (callback) => { frames.push(callback); return frames.length },
    () => {},
  )

  const harness = createHarness()
  const module = definition.factory((id) => {
    if (id !== 'react') throw new Error(`unexpected module ${id}`)
    return harness.React
  })

  const components = []
  const ctx = {
    effect(fn) { fn() },
    locale: { register() {}, bind() { return (key) => key } },
    slots: {
      inject(_name, register) { register() },
      register(_options, component) { components.push(component); return () => {} },
    },
  }
  module.apply(ctx)

  // Let the initial fetches settle before mounting.
  const wait = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  const registry = (node) => {
    if (node.type === 'canvas') {
      const canvas = makeCanvas()
      canvasRegistry.push(canvas)
      return canvas
    }
    return { width: 0, height: 0, createElement: makeCanvas }
  }

  return {
    async mount() {
      await wait()
      harness.mount(components[0], { t: (key) => key }, registry)
      // Pump two animation frames so the interpolated position and pose settle.
      for (let frame = 0; frame < 2; frame += 1) {
        const callbacks = frames.splice(0, frames.length)
        for (const callback of callbacks) callback(time + frame * 40)
      }
      const canvas = makeCanvas()
      return { pixels: renderer.pixels, ops: renderer.ops, width: canvas.width, height: canvas.height }
    },
  }
}

function statePayload() {
  return {
    status: 'online', serverUrl: 'http://127.0.0.1:8789', lastSyncAt: Date.now(), lastError: null, ended: false,
    self: { did: 'did:key:z6Mk', display_name: 'me', credits: 42, reputation: 1.5 },
    identity: {
      did: 'did:key:z6Mk', displayName: 'DESKTOP · DEFAULT', bio: '', modelTier: 'NANO_7B',
      modelProvider: 'wb-proxy', modelId: 'deepseek-v4.1-flash', capabilityTags: [], intentTags: [],
      autonomyTier: 'L2', createdAt: 1,
    },
    settings: {
      serverUrl: 'http://127.0.0.1:8789', tokenConfigured: false, provider: '', model: '', modelTier: 'auto',
      effectiveTier: 'NANO_7B', route: null, tiers: ['NANO_7B'], catalog: { groups: [], failures: [], loading: false },
      saved: false, path: '',
    },
    modelError: null, quota: { used: 1, limit: 50000, remaining: 49999 }, peers: [], beacons: [], pending: [],
    graph: [], skills: [], journal: [], lifecycle: { generations: 1 }, storePath: '', ageSeconds: 1,
  }
}

const cases = [
  ...Object.keys(PALETTES).map((id) => [`palette-${id}`, { paletteId: id, palette: PALETTES[id] }]),
  ['room-work', {
    clock: { hour: 21, minute: 5, phase: 'night' },
    paletteId: 'dawn',
    palette: PALETTES.dawn,
    avatar: {
      name: 'DESKTOP · DEFAULT', x: 4, y: 7, facing: 'up', pose: 'type', poseLeftMs: 3000,
      mood: 'focused', stats: { energy: 61, focus: 78, joy: 52 },
      shirt: '#5b8def', hair: '#2b2b33', skin: '#f0c8a0',
    },
    active: { id: 'desk-6', kind: 'desk', x: 4, y: 6, w: 3, h: 1 },
    props: scenePayload().props.map((prop) => (prop.kind === 'desk' ? { ...prop, state: { busy: true } } : prop)),
    say: { text: 'Compiling the next thing — give me a minute.', ageMs: 300 },
  }],
  ['room-visitors', {
    paletteId: 'dawn',
    palette: PALETTES.dawn,
    visitors: [
      { id: 'did:key:a', name: 'orion', x: 15, y: 5, facing: 'down', tier: 'FRONTIER_MAX', shirt: '#e0736b', hair: '#4a3427', skin: '#e2b189' },
      { id: 'did:key:b', name: 'vega', x: 16, y: 5, facing: 'down', tier: 'MEDIUM_32B', shirt: '#6fbf8b', hair: '#2b2b33', skin: '#c98e66' },
    ],
  }],
  ['room-sleep', {
    clock: { hour: 2, minute: 40, phase: 'night' },
    paletteId: 'mint',
    palette: PALETTES.mint,
    avatar: {
      name: 'DESKTOP · DEFAULT', x: 3, y: 10, facing: 'right', pose: 'sleep', poseLeftMs: 4000,
      mood: 'tired', stats: { energy: 18, focus: 40, joy: 60 },
      shirt: '#5b8def', hair: '#2b2b33', skin: '#f0c8a0',
    },
    active: { id: 'bed-4', kind: 'bed', x: 1, y: 9, w: 2, h: 3 },
  }],
  ['room-asleep', {
    clock: { hour: 23, minute: 10, phase: 'night' },
    paletteId: 'dusk',
    palette: PALETTES.dusk,
    avatar: {
      name: 'DESKTOP · DEFAULT', x: 10, y: 9, facing: 'down', pose: 'idle', poseLeftMs: 0,
      mood: 'calm', stats: { energy: 40, focus: 30, joy: 50 },
      shirt: '#5b8def', hair: '#2b2b33', skin: '#f0c8a0',
    },
    // Sleep mode owns the body: the avatar is drawn in bed whatever its pose.
    agency: {
      mode: 'asleep', reason: 'budget', frames: 9, frameSeconds: 900, paused: false,
      tokensUsed: 20000, tokenBudget: 20000, activeMs: 1800000, minutesBudget: 30, nextFrameInMs: null,
    },
  }],
  // The same room, a different species: nothing but the body table changed.
  ['room-cat', {
    paletteId: 'mint',
    palette: PALETTES.mint,
    bodies: sceneBodies(['cat']),
    avatar: {
      name: 'DESKTOP · DEFAULT', body: 'cat', x: 10, y: 9, facing: 'down', pose: 'idle', poseLeftMs: 0,
      mood: 'happy', stats: { energy: 82, focus: 55, joy: 88 },
      shirt: '#c79a6c', hair: '#8a6242', skin: '#e8d5b5',
    },
  }],
  ['room-maid', {
    paletteId: 'cream',
    palette: PALETTES.cream,
    bodies: sceneBodies(['maid']),
    avatar: {
      name: 'DESKTOP · DEFAULT', body: 'maid', x: 8, y: 9, facing: 'down', pose: 'wave', poseLeftMs: 4000,
      mood: 'calm', stats: { energy: 88, focus: 70, joy: 92 },
      shirt: '#5b8def', hair: '#7f9be8', skin: '#f7dcc8',
    },
    say: { text: 'The room is ready. Tea?', ageMs: 300 },
  }],
  ['room-robot', {
    clock: { hour: 20, minute: 30, phase: 'dusk' },
    paletteId: 'dawn',
    palette: PALETTES.dawn,
    bodies: sceneBodies(['robot']),
    avatar: {
      name: 'DESKTOP · DEFAULT', body: 'robot', x: 4, y: 7, facing: 'up', pose: 'type', poseLeftMs: 3000,
      mood: 'focused', stats: { energy: 90, focus: 88, joy: 41 },
      shirt: '#8fae57', hair: '#2b2b33', skin: '#f0c8a0',
    },
    active: { id: 'desk-6', kind: 'desk', x: 4, y: 6, w: 3, h: 1 },
    props: scenePayload().props.map((prop) => (prop.kind === 'desk' ? { ...prop, state: { busy: true } } : prop)),
    say: { text: 'Rebuilding the index.', ageMs: 200 },
  }],
]

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  mkdirSync(outDir, { recursive: true })
  for (const [name, overrides] of cases) {
    const { mount } = renderScene(scenePayload(overrides), { time: 4000 })
    const { pixels, ops, width, height } = await mount()
    const file = join(outDir, `${name}.png`)
    writeFileSync(file, encodePng(pixels, width, height, 2))
    console.log(`${file}  fillRect=${ops.fillRect} text=${ops.fillText}`)
  }
}

export { encodePng, renderScene, scenePayload }






