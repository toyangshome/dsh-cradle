#!/usr/bin/env node
/**
 * Migration proof for the body-data refactor (plan A + B, then the 2x move).
 *
 * It paints the same avatar twice — once with a pre-refactor client bundle and
 * once with the current one — over the full pose x facing x mood grid. The old
 * bundle paints a 320 x 224 canvas; the current one paints the same room at
 * `unit` device pixels per art unit, so a frame counts as identical when the
 * fine canvas is an exact 2 x 2 supersample of the coarse one.
 *
 *   node test/body-parity.mjs [path/to/old/client.js]
 *
 * The old bundle is not shipped with the plugin, so pass a copy (the v1.4.0 file
 * lives in `.backup/`). Exit 0 when every frame matches; 1 on any mismatch.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FACINGS, MOODS, POSES, sceneBodies } from '../plugin/lib/room.js'
import { UNIT } from '../plugin/lib/body.js'
import { renderScene, scenePayload } from './render-scene.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const oldPath = process.argv[2] ?? join(here, '..', '.backup', 'v1.4.0', 'client.js')

if (existsSync(oldPath) === false) {
  console.error(`No old bundle at ${oldPath}.`)
  console.error('Pass a pre-refactor plugin/client.js as the first argument.')
  process.exit(1)
}

const oldSource = readFileSync(oldPath, 'utf8')
const base = scenePayload()
// The old bundle knows nothing about `unit` or body tables: it paints 320x224.
const oldScene = { ...base, unit: 1 }
const newScene = { ...base, unit: UNIT, bodies: sceneBodies(['human']) }
const time = 4000
const WIDTH = 320
const HEIGHT = 224

/**
 * @param {Uint8ClampedArray} coarse a 320 x 224 buffer
 * @param {Uint8ClampedArray} fine a (320 * unit) x (224 * unit) buffer
 * @param {number} unit device pixels per art unit
 */
function firstDifference(coarse, fine, unit) {
  if (coarse.length !== WIDTH * HEIGHT * 4) return { x: -1, y: -1, a: 'coarse size', b: 'coarse size' }
  if (fine.length !== WIDTH * unit * HEIGHT * unit * 4) return { x: -1, y: -1, a: 'fine size', b: 'fine size' }
  const fineWidth = WIDTH * unit
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const at = (y * WIDTH + x) * 4
      for (let dy = 0; dy < unit; dy += 1) {
        for (let dx = 0; dx < unit; dx += 1) {
          const fineAt = ((y * unit + dy) * fineWidth + (x * unit + dx)) * 4
          for (let channel = 0; channel < 4; channel += 1) {
            if (coarse[at + channel] !== fine[fineAt + channel]) {
              return {
                x,
                y,
                a: `${coarse[at]},${coarse[at + 1]},${coarse[at + 2]},${coarse[at + 3]}`,
                b: `${fine[fineAt]},${fine[fineAt + 1]},${fine[fineAt + 2]},${fine[fineAt + 3]}`,
              }
            }
          }
        }
      }
    }
  }
  return null
}

let frames = 0
let mismatches = 0

for (const pose of POSES) {
  for (const facing of FACINGS) {
    for (const mood of MOODS) {
      const avatar = { ...newScene.avatar, pose, facing, mood, poseLeftMs: 5000 }
      const before = await renderScene({ ...oldScene, avatar }, { time, source: oldSource }).mount()
      const after = await renderScene({ ...newScene, avatar }, { time }).mount()
      frames += 1
      const diff = firstDifference(before.pixels, after.pixels, UNIT)
      if (diff !== null) {
        mismatches += 1
        console.log(`MISMATCH pose=${pose} facing=${facing} mood=${mood} at (${diff.x},${diff.y}) ${diff.a} vs ${diff.b}`)
      }
      if (frames % 60 === 0) console.log(`… ${frames} frames compared`)
    }
  }
}

console.log(`${frames} frames compared, ${mismatches} mismatch(es), ${POSES.length} poses x ${FACINGS.length} facings x ${MOODS.length} moods @ ${UNIT}x`)
process.exit(mismatches === 0 ? 0 : 1)
