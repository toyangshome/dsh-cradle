/**
 * One body, every pose: the review sheet for a species that has to support the
 * whole action vocabulary.
 *
 *   node test/render-poses.mjs [bodyId] [out.png]
 *
 * Defaults to the human and `test/out/poses-<id>.png`. Bodies live in their own
 * cell, so the crop is a 24x24 box around it (slack for tails and shadows).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BODIES, BODY_DEFAULT, UNIT, scaleBody } from '../plugin/lib/body.js'
import { FACINGS, POSES, sceneBodies } from '../plugin/lib/room.js'
import { encodePng, renderScene, scenePayload } from './render-scene.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const id = process.argv[2] ?? BODY_DEFAULT
const outFile = process.argv[3] ?? join(here, 'out', `poses-${id}.png`)

if (BODIES[id] === undefined) {
  console.error(`unknown body "${id}"; known ids: ${Object.keys(BODIES).join(', ')}`)
  process.exit(1)
}

const FACING = 'down'
if (FACINGS.includes(FACING) === false) throw new Error('unreachable')

const COLUMNS = 8
// The panel paints at UNIT device pixels per art unit: the crop box is 24 art
// units wide and each sheet pixel is 8 / UNIT scene pixels.
const BOX = 24 * UNIT
const SCALE = 8 / UNIT
const STRIDE = 320 * UNIT
const GAP = 6
const BACKDROP = [34, 30, 48, 255]
const CELL_BACK = [58, 52, 84, 255]

const rows = Math.ceil(POSES.length / COLUMNS)
const width = COLUMNS * BOX * SCALE + (COLUMNS + 1) * GAP
const height = rows * BOX * SCALE + (rows + 1) * GAP
const sheet = new Uint8ClampedArray(width * height * 4)
for (let index = 0; index < sheet.length; index += 4) sheet.set(BACKDROP, index)

/** @param {number} x @param {number} y @param {number} w @param {number} h @param {number[]} color */
function fill(x, y, w, h, color) {
  for (let row = y; row < y + h; row += 1) {
    if (row < 0 || row >= height) continue
    for (let column = x; column < x + w; column += 1) {
      if (column < 0 || column >= width) continue
      sheet.set(color, (row * width + column) * 4)
    }
  }
}

const base = scenePayload()
for (const [index, pose] of POSES.entries()) {
  // A body with `bedSleep` is painted in the bed, not in its cell, so the sheet
  // drops that variant and shows the in-cell fallback instead.
  const table = scaleBody({ ...BODIES[id], bedSleep: undefined }, UNIT)
  const scene = {
    ...base,
    props: [],
    bodies: sceneBodies([id]),
    avatar: { ...base.avatar, body: id, pose, facing: FACING, poseLeftMs: 5000, mood: 'calm' },
  }
  if (pose === 'sleep') scene.bodies = { ...scene.bodies, [id]: table }
  const { pixels } = await renderScene(scene, { time: 4000 }).mount()
  const column = index % COLUMNS
  const row = Math.floor(index / COLUMNS)
  const left = GAP + column * (BOX * SCALE + GAP)
  const top = GAP + row * (BOX * SCALE + GAP)
  fill(left - 4, top - 4, BOX * SCALE + 8, BOX * SCALE + 8, CELL_BACK)
  const sourceX = (base.avatar.x * 16 - 4) * UNIT
  const sourceY = (base.avatar.y * 16 - 2) * UNIT
  for (let y = 0; y < BOX; y += 1) {
    for (let x = 0; x < BOX; x += 1) {
      const source = ((sourceY + y) * STRIDE + (sourceX + x)) * 4
      fill(left + x * SCALE, top + y * SCALE, SCALE, SCALE, [pixels[source], pixels[source + 1], pixels[source + 2], 255])
    }
  }
}

mkdirSync(join(here, 'out'), { recursive: true })
writeFileSync(outFile, encodePng(sheet, width, height, 1))
console.log(`${outFile}  ${width}x${height}  body=${id}  poses=${POSES.join(',')}`)
