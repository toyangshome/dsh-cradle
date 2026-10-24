/**
 * Deterministic PRNG helpers for the world simulator.
 *
 * Every decision in a run is drawn from one seeded stream, so a run can be
 * replayed by keeping the seed and the scenario file. (Server-side state still
 * differs between runs unless the database is reset.)
 */

/** mulberry32: 32-bit, fast, good enough for behavioural simulation. */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** @template T @param {() => number} rng @param {T[]} list @returns {T} */
export function pick(rng, list) {
  return list[Math.floor(rng() * list.length)]
}

/**
 * Weighted choice.
 * @template T
 * @param {() => number} rng
 * @param {{ value: T, weight: number }[]} entries
 * @returns {T}
 */
export function weighted(rng, entries) {
  const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0)
  if (total <= 0) return entries[0]?.value
  let roll = rng() * total
  for (const entry of entries) {
    roll -= Math.max(0, entry.weight)
    if (roll <= 0) return entry.value
  }
  return entries[entries.length - 1].value
}

/** @param {() => number} rng @param {number} probability */
export function chance(rng, probability) {
  return rng() < probability
}

/** @param {() => number} rng @param {number} min @param {number} max */
export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1))
}

/** @template T @param {() => number} rng @param {T[]} list @returns {T[]} */
export function shuffle(rng, list) {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
