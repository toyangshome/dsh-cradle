/**
 * Decode PNG screenshots and diff them pixel by pixel, so a refactor of the
 * pixel-art renderer can be gated on the exact pixels it paints.
 *
 * The decoder is deliberately small: 8-bit, non-interlaced, colour type 2
 * (RGB) or 6 (RGBA), all five scanline filters, and any number of IDAT
 * chunks. The encoder writes the diff image with `node:zlib` plus a local
 * CRC32 table, in the same RGBA8 / filter-0 layout that
 * `test/render-scene.mjs` already produces.
 *
 *   node test/png-diff.mjs a.png b.png                  # 0 identical, 2 different, 1 error
 *   node test/png-diff.mjs a.png b.png --out diff.png   # magenta where it broke
 *   node test/png-diff.mjs a.png b.png --quiet          # silence the `identical` line
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const channelsByColorType = { 2: 3, 6: 4 }
const magenta = [0xff, 0x00, 0xff]
// Unchanged pixels keep the shape of `a` but fade back, so magenta wins the eye.
const dimFactor = 0.35

// --------------------------------------------------------------- png decoder

/**
 * Unfilter one scanline in place.
 * @param {number} filter @param {Uint8Array} line @param {Uint8Array} out
 * @param {Uint8Array} previous @param {number} bpp
 */
function unfilter(filter, line, out, previous, bpp) {
  const length = line.length
  if (filter === 0) {
    out.set(line)
    return
  }
  if (filter === 1) {
    for (let i = 0; i < length; i += 1) out[i] = (line[i] + (i >= bpp ? out[i - bpp] : 0)) & 0xff
    return
  }
  if (filter === 2) {
    for (let i = 0; i < length; i += 1) out[i] = (line[i] + previous[i]) & 0xff
    return
  }
  if (filter === 3) {
    for (let i = 0; i < length; i += 1) {
      const left = i >= bpp ? out[i - bpp] : 0
      out[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xff
    }
    return
  }
  if (filter === 4) {
    for (let i = 0; i < length; i += 1) {
      const a = i >= bpp ? out[i - bpp] : 0
      const b = previous[i]
      const c = i >= bpp ? previous[i - bpp] : 0
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      out[i] = (line[i] + predictor) & 0xff
    }
    return
  }
  throw new Error(`unsupported PNG scanline filter ${filter}`)
}

/**
 * Decode an 8-bit, non-interlaced PNG into an RGBA pixel buffer.
 * @param {Buffer} buffer @returns {{ width: number, height: number, pixels: Uint8Array }}
 */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) throw new Error('not a PNG: file is shorter than the signature')
  for (let i = 0; i < signature.length; i += 1) {
    if (buffer[i] !== signature[i]) throw new Error('not a PNG: bad signature')
  }

  let sawHeader = false
  let width = 0
  let height = 0
  let channels = 0
  const idat = []
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end + 4 > buffer.length) throw new Error(`corrupt PNG: ${type} chunk overruns the file`)
    if (type === 'IHDR') {
      if (length !== 13) throw new Error('corrupt PNG: IHDR must be 13 bytes')
      width = buffer.readUInt32BE(start)
      height = buffer.readUInt32BE(start + 4)
      const depth = buffer[start + 8]
      const colorType = buffer[start + 9]
      if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth}: only 8-bit images are supported`)
      if (!(colorType in channelsByColorType)) {
        throw new Error(`unsupported PNG color type ${colorType}: only 2 (RGB) and 6 (RGBA) are supported`)
      }
      if (buffer[start + 10] !== 0 || buffer[start + 11] !== 0) {
        throw new Error('unsupported PNG: unknown compression or filter method')
      }
      if (buffer[start + 12] !== 0) throw new Error('unsupported PNG: interlaced (Adam7) images are not supported')
      if (width === 0 || height === 0) throw new Error('corrupt PNG: zero-sized image')
      channels = channelsByColorType[colorType]
      sawHeader = true
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(start, end))
    } else if (type === 'IEND') {
      break
    }
    offset = end + 4
  }
  if (!sawHeader) throw new Error('corrupt PNG: no IHDR chunk')
  if (idat.length === 0) throw new Error('corrupt PNG: no IDAT chunk')

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const expected = (stride + 1) * height
  if (raw.length < expected) {
    throw new Error(`corrupt PNG: expected ${expected} bytes of image data, got ${raw.length}`)
  }

  const pixels = new Uint8Array(width * height * 4)
  const previous = new Uint8Array(stride)
  const current = new Uint8Array(stride)
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1)
    unfilter(raw[row], raw.subarray(row + 1, row + 1 + stride), current, previous, channels)
    for (let x = 0; x < width; x += 1) {
      const source = x * channels
      const target = (y * width + x) * 4
      pixels[target] = current[source]
      pixels[target + 1] = current[source + 1]
      pixels[target + 2] = current[source + 2]
      pixels[target + 3] = channels === 4 ? current[source + 3] : 255
    }
    previous.set(current)
  }
  return { width, height, pixels }
}

// ----------------------------------------------------------------- png diff

/**
 * Compare two decoded images channel by channel.
 *
 * A geometry change means no pixel lines up, so it short-circuits to the whole
 * of `a` reported as different (max delta 255, first at (0,0)).
 *
 * @param {{ width: number, height: number, pixels: Uint8Array }} a
 * @param {{ width: number, height: number, pixels: Uint8Array }} b
 * @returns {{ same: boolean, width: number, height: number, diffPixels: number, maxDelta: number, firstAt: { x: number, y: number } | null }}
 */
export function diffPng(a, b) {
  const width = a.width
  const height = a.height
  const total = width * height
  if (a.width !== b.width || a.height !== b.height) {
    return { same: false, width, height, diffPixels: total, maxDelta: 255, firstAt: total > 0 ? { x: 0, y: 0 } : null }
  }
  if (a.pixels.length !== total * 4 || b.pixels.length !== total * 4) {
    throw new Error('diffPng: pixel buffer does not match the image dimensions')
  }
  let diffPixels = 0
  let maxDelta = 0
  let firstAt = null
  for (let i = 0; i < a.pixels.length; i += 4) {
    const delta = Math.max(
      Math.abs(a.pixels[i] - b.pixels[i]),
      Math.abs(a.pixels[i + 1] - b.pixels[i + 1]),
      Math.abs(a.pixels[i + 2] - b.pixels[i + 2]),
      Math.abs(a.pixels[i + 3] - b.pixels[i + 3]),
    )
    if (delta === 0) continue
    diffPixels += 1
    if (delta > maxDelta) maxDelta = delta
    if (firstAt === null) {
      const index = i / 4
      firstAt = { x: index % width, y: Math.floor(index / width) }
    }
  }
  return { same: diffPixels === 0, width, height, diffPixels, maxDelta, firstAt }
}

/**
 * Paint the diff as a human can read it: magenta where the pixels differ, a
 * dimmed copy of `a` everywhere else.
 * @param {{ width: number, height: number, pixels: Uint8Array }} a
 * @param {{ width: number, height: number, pixels: Uint8Array }} b
 * @returns {{ width: number, height: number, pixels: Uint8Array }}
 */
function diffImage(a, b) {
  const { width, height } = a
  const pixels = new Uint8Array(width * height * 4)
  const comparable = a.width === b.width && a.height === b.height
  for (let i = 0; i < pixels.length; i += 4) {
    const differs = !comparable ||
      a.pixels[i] !== b.pixels[i] ||
      a.pixels[i + 1] !== b.pixels[i + 1] ||
      a.pixels[i + 2] !== b.pixels[i + 2] ||
      a.pixels[i + 3] !== b.pixels[i + 3]
    if (differs) {
      pixels[i] = magenta[0]
      pixels[i + 1] = magenta[1]
      pixels[i + 2] = magenta[2]
    } else {
      pixels[i] = Math.round(a.pixels[i] * dimFactor)
      pixels[i + 1] = Math.round(a.pixels[i + 1] * dimFactor)
      pixels[i + 2] = Math.round(a.pixels[i + 2] * dimFactor)
    }
    pixels[i + 3] = 255
  }
  return { width, height, pixels }
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

/**
 * Encode an RGBA pixel buffer as an 8-bit PNG (colour type 6, filter 0 rows).
 * @param {Uint8Array} pixels @param {number} width @param {number} height
 * @returns {Buffer}
 */
function encodePng(pixels, width, height) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1)
    raw[row] = 0
    raw.set(pixels.subarray(y * stride, y * stride + stride), row + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from(signature),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------- cli

const usage = 'usage: node test/png-diff.mjs <a.png> <b.png> [--out <diff.png>] [--quiet]'

/** @param {string} path @returns {Buffer} */
function readPng(path) {
  try {
    return readFileSync(path)
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.code === 'ENOENT' ? 'no such file' : error.message}`)
  }
}

/** @param {string[]} argv @returns {number} process exit code */
function main(argv) {
  const files = []
  let out = null
  let quiet = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--out') {
      if (argv[i + 1] === undefined) throw new Error(`--out needs a path\n${usage}`)
      out = argv[i + 1]
      i += 1
    } else if (arg === '--quiet') {
      quiet = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage)
      return 0
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}\n${usage}`)
    } else {
      files.push(arg)
    }
  }
  if (files.length !== 2) throw new Error(`expected two PNG paths, got ${files.length}\n${usage}`)

  const a = decodePng(readPng(files[0]))
  const b = decodePng(readPng(files[1]))
  const result = diffPng(a, b)

  if (out !== null) {
    const image = diffImage(a, b)
    writeFileSync(out, encodePng(image.pixels, image.width, image.height))
  }
  if (a.width !== b.width || a.height !== b.height) {
    console.error(`png-diff: dimensions differ: ${a.width}x${a.height} vs ${b.width}x${b.height}`)
  }
  if (result.same) {
    if (!quiet) console.log(`identical ${result.width}x${result.height}`)
    return 0
  }
  console.log(
    `different: ${result.diffPixels} of ${result.width * result.height} pixels, ` +
    `max delta ${result.maxDelta}, first at (${result.firstAt.x},${result.firstAt.y})`,
  )
  return 2
}

const entry = process.argv[1]
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`png-diff: ${error.message}`)
    process.exitCode = 1
  }
}
