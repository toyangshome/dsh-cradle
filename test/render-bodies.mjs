/**
 * A contact sheet of the species the plugin ships: one row per body, one column
 * per pose, painted by the real panel. It is the fastest way to eyeball a new
 * body table without opening the Web UI.
 *
 *   node test/render-bodies.mjs        # writes test/out/bodies.png
 *
 * Sleeping is left out on purpose: a body with `bedSleep` lies in the bed, not in
 * its own cell, so that pose belongs in a room render (see render-scene.mjs).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BODIES, BODY_IDS, UNIT } from '../plugin/lib/body.js'
import { sceneBodies } from '../plugin/lib/room.js'
import { encodePng, renderScene, scenePayload } from './render-scene.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const outFile = join(here, 'out', 'bodies.png')

/** Poses that every body paints inside its own cell. */
const COLUMNS = ['idle', 'walk', 'sit', 'wave', 'dance']
// The panel paints at UNIT device pixels per art unit, so the crop box is 24 art
// units wide and each sheet pixel is 6 / UNIT scene pixels.
const BOX = 24 * UNIT
const SCALE = 6 / UNIT
const STRIDE = 320 * UNIT
const GAP = 8
const BACKDROP = [43, 39, 64, 255]
const CELL_BACK = [58, 52, 84, 255]

const sheetW = COLUMNS.length * BOX * SCALE + (COLUMNS.length + 1) * GAP
const sheetH = BODY_IDS.length * BOX * SCALE + (BODY_IDS.length + 1) * GAP
const sheet = new Uint8ClampedArray(sheetW * sheetH * 4)

for (let index = 0; index < sheet.length; index += 4) sheet.set(BACKDROP, index)

/** @param {number} x @param {number} y @param {number} w @param {number} h @param {number[]} color */
function fill(x, y, w, h, color) {
  for (let row = y; row < y + h; row += 1) {
    if (row < 0 || row >= sheetH) continue
    for (let column = x; column < x + w; column += 1) {
      if (column < 0 || column >= sheetW) continue
      sheet.set(color, (row * sheetW + column) * 4)
    }
  }
}

const base = scenePayload()
const avatarX = base.avatar.x
const avatarY = base.avatar.y

for (const [row, id] of BODY_IDS.entries()) {
  const body = BODIES[id]
  const seeded = { shirt: '#5b8def', hair: '#2b2b33', skin: '#f0c8a0' }
  for (const [column, pose] of COLUMNS.entries()) {
    const scene = {
      ...base,
      props: [],
      bodies: sceneBodies([id]),
      avatar: { ...base.avatar, body: id, pose, poseLeftMs: 5000, mood: 'calm', ...seeded },
    }
    const { pixels } = await renderScene(scene, { time: 4000 }).mount()
    const left = GAP + column * (BOX * SCALE + GAP)
    const top = GAP + row * (BOX * SCALE + GAP)
    fill(left - 4, top - 4, BOX * SCALE + 8, BOX * SCALE + 8, CELL_BACK)
    // Crop the avatar's cell (with a little slack for tails and shadows).
    const sourceX = (avatarX * 16 - 4) * UNIT
    const sourceY = (avatarY * 16 - 2) * UNIT
    for (let y = 0; y < BOX; y += 1) {
      for (let x = 0; x < BOX; x += 1) {
        const source = ((sourceY + y) * STRIDE + (sourceX + x)) * 4
        const color = [pixels[source], pixels[source + 1], pixels[source + 2], 255]
        fill(left + x * SCALE, top + y * SCALE, SCALE, SCALE, color)
      }
    }
  }
}

mkdirSync(join(here, 'out'), { recursive: true })
writeFileSync(outFile, encodePng(sheet, sheetW, sheetH, 1))
console.log(`${outFile}  ${sheetW}x${sheetH}  rows=${BODY_IDS.join(',')}  columns=${COLUMNS.join(',')}`)
