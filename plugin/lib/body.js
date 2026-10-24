/**
 * Bodies: the data behind a pixel person.
 *
 * A *body* is a closed, validated table — not code. It says how tall the
 * character is, where its feet touch the floor, which colour slots it uses, how
 * far a pose lifts it, and one ordered list of rectangles to paint. The Web
 * panel paints any body it is handed; it does not know what a "human" is.
 *
 * That is the whole point: adding a species is adding data here (or, later, in
 * the store), never editing the renderer. Two rules keep it safe:
 *
 * - The picture is data. A layer is `{ x, y, w, h, slot }` (a named colour) or
 *   `{ x, y, w, h, color }` (a literal one), optionally gated by `when`.
 * - Anything the data cannot say is a *closed* op: `face` (the mood's eyes and
 *   mouth), `zzz` (sleep glyphs), and the two swing motions. Data may name an
 *   op; it may never define one.
 *
 * Coordinates are cell pixels with the origin at the cell's top-left; `anchor`
 * says which point of the cell sits on the avatar's tile floor. Rows are drawn
 * in array order, so occlusion is reading order. `fixed` layers ignore the
 * pose's lift (the floor shadow must not breathe with the body).
 *
 * `POSES` lives in `room.js` because it is the *action* vocabulary. A body does
 * not have to cover every pose: layers whose `when` does not match are skipped,
 * so an unposed body simply stands. That is the graceful degradation the room
 * already relies on for unknown poses and unknown furniture.
 */

/** Every body the plugin ships. Order is the order the panel lists them in. */
export const BODY_IDS = ['human', 'maid', 'cat', 'robot']

/**
 * Device pixels per art unit. The room is authored on a 16-unit tile grid, but
 * it is *painted* at twice that: a 640x448 canvas, where one tile is 32 device
 * pixels. Bodies are painted in device pixels, so a character still one tile
 * tall carries 32x32 of art instead of 16x16 — four times the detail — without
 * changing a single gameplay coordinate.
 */
export const UNIT = 2

/** The body every room starts with, and the fallback for an unknown id. */
export const BODY_DEFAULT = 'human'

/** How far a layer may paint outside the cell before validation complains. */
export const CELL_SLACK = 4

/** Named motions a layer may ask for; the panel implements exactly these. */
export const MOTIONS = ['swing-l', 'swing-r']

/** `when` keys the painter understands. Anything else is rejected. */
export const WHEN_KEYS = ['pose', 'notPose', 'facing', 'notFacing', 'moving', 'phase', 'mood']

/** Pose lifts: a number of pixels, or one of these breathing motions. */
export const LIFT_MOTIONS = ['breath', 'step', 'sway']

/** Poses that have their own arm drawing on the human body. */
const NAMED_ARMS = ['wave', 'cheer', 'dance', 'stretch', 'type', 'read', 'water', 'point', 'think', 'pet', 'gaze']

/** The leg poses that beat "walking" when both apply. */
const SEATED = ['sit', 'sleep', 'pet']

/**
 * One rectangle layer. `when` is omitted rather than set to undefined so the
 * table serialises to compact JSON for the scene route.
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {string} slot @param {any} [when]
 * @returns {any}
 */
const R = (x, y, w, h, slot, when) => ({ x, y, w, h, slot, ...(when === undefined ? {} : { when }) })

/**
 * The human: an exact transcription of the original hand-written renderer, so
 * the refactor can be proved pixel-identical before anything else changes.
 * Legs, torso, arms, head, hair, face and held props are drawn in that order,
 * and every branch of the old `if/else` chain became a `when` clause.
 */
const human = {
  id: 'human',
  label: 'Human',
  blurb: 'A small person: shirt, hair and skin from the room seed.',
  cell: { w: 16, h: 16 },
  anchor: { x: 8, y: 15 },
  /** Slots seeded by the room's palette. */
  look: { shirt: 'shirt', hair: 'hair', skin: 'skin' },
  slots: {
    shirt: '#5b8def', hair: '#2b2b33', skin: '#f0c8a0',
    pants: '#3b3550', shoe: '#2a2438',
    shade: 'rgba(0,0,0,.16)', ink: '#241f2e', blush: 'rgba(224,115,107,.5)',
    shadow: 'rgba(20,17,28,.20)',
    book: '#d9c7a3', bookEdge: '#b7a382', rule: '#7a6a52', water: '#7fa6b8',
    blanket: '#8fadd8', blanketEdge: '#aecbec', mouth: '#b98a7a', zzz: '#efe8d4',
  },
  /**
   * The old `baseY` chain: seated and crouched poses sit lower, raised arms and
   * dancing sit higher, walking and idling breathe on a clock.
   */
  lift: {
    sit: 2, sleep: 2, pet: 3, stretch: -1, cheer: -1,
    idle: 'breath', walk: 'step', dance: 'sway',
    moving: { idle: 'step', walk: 'step' },
  },
  layers: [
    // The floor shadow is fixed to the cell, not to the lifted body.
    { ...R(4, 15, 8, 2, 'shadow'), fixed: true },

    // Legs. Seated and crouched poses win over walking, like the old branch chain.
    R(4, 12, 9, 3, 'pants', { pose: ['sit', 'sleep'] }),
    R(13, 13, 2, 1, 'shoe', { pose: ['sit', 'sleep'] }),
    R(3, 11, 10, 2, 'pants', { pose: ['pet'] }),
    R(3, 13, 3, 1, 'shoe', { pose: ['pet'] }),
    R(10, 13, 3, 1, 'shoe', { pose: ['pet'] }),
    R(4, 12, 3, 3, 'pants', [{ pose: ['walk'], phase: 0 }, { moving: true, phase: 0, notPose: SEATED }]),
    R(9, 12, 3, 2, 'pants', [{ pose: ['walk'], phase: 0 }, { moving: true, phase: 0, notPose: SEATED }]),
    R(3, 15, 3, 1, 'shoe', [{ pose: ['walk'], phase: 0 }, { moving: true, phase: 0, notPose: SEATED }]),
    R(9, 14, 3, 1, 'shoe', [{ pose: ['walk'], phase: 0 }, { moving: true, phase: 0, notPose: SEATED }]),
    R(4, 12, 3, 2, 'pants', [{ pose: ['walk'], phase: 1 }, { moving: true, phase: 1, notPose: SEATED }]),
    R(9, 12, 3, 3, 'pants', [{ pose: ['walk'], phase: 1 }, { moving: true, phase: 1, notPose: SEATED }]),
    R(3, 14, 3, 1, 'shoe', [{ pose: ['walk'], phase: 1 }, { moving: true, phase: 1, notPose: SEATED }]),
    R(9, 15, 3, 1, 'shoe', [{ pose: ['walk'], phase: 1 }, { moving: true, phase: 1, notPose: SEATED }]),
    R(3, 12, 3, 3, 'pants', { pose: ['dance'], moving: false }),
    R(10, 12, 3, 3, 'pants', { pose: ['dance'], moving: false }),
    R(2, 15, 3, 1, 'shoe', { pose: ['dance'], moving: false }),
    R(10, 15, 3, 1, 'shoe', { pose: ['dance'], moving: false }),
    R(4, 12, 3, 3, 'pants', { notPose: ['sit', 'sleep', 'pet', 'walk', 'dance'], moving: false }),
    R(9, 12, 3, 3, 'pants', { notPose: ['sit', 'sleep', 'pet', 'walk', 'dance'], moving: false }),
    R(4, 15, 3, 1, 'shoe', { notPose: ['sit', 'sleep', 'pet', 'walk', 'dance'], moving: false }),
    R(9, 15, 3, 1, 'shoe', { notPose: ['sit', 'sleep', 'pet', 'walk', 'dance'], moving: false }),

    // Torso, then the typing/reading lean.
    R(4, 8, 8, 4, 'shirt'),
    R(4, 11, 8, 1, 'shade'),
    R(4, 9, 8, 3, 'shirt', { pose: ['type', 'read'] }),
    R(4, 12, 8, 1, 'shade', { pose: ['type', 'read'] }),

    // Arms: one branch per pose, then the idle/walk swing.
    R(12, 4, 2, 4, 'shirt', { pose: ['wave'] }),
    R(12, 3, 2, 2, 'skin', { pose: ['wave'] }),
    R(2, 8, 2, 4, 'shirt', { pose: ['wave'] }),
    R(2, 11, 2, 1, 'skin', { pose: ['wave'] }),
    R(1, 4, 2, 5, 'shirt', { pose: ['cheer'] }),
    R(1, 2, 2, 2, 'skin', { pose: ['cheer'] }),
    R(13, 4, 2, 5, 'shirt', { pose: ['cheer'] }),
    R(13, 2, 2, 2, 'skin', { pose: ['cheer'] }),
    R(1, 6, 2, 4, 'shirt', { pose: ['dance'] }),
    R(1, 4, 2, 2, 'skin', { pose: ['dance'] }),
    R(13, 5, 2, 4, 'shirt', { pose: ['dance'] }),
    R(13, 3, 2, 2, 'skin', { pose: ['dance'] }),
    R(1, 3, 2, 5, 'shirt', { pose: ['stretch'] }),
    R(13, 3, 2, 5, 'shirt', { pose: ['stretch'] }),
    R(1, 1, 2, 2, 'skin', { pose: ['stretch'] }),
    R(13, 1, 2, 2, 'skin', { pose: ['stretch'] }),
    R(4, 10, 8, 2, 'shirt', { pose: ['type'] }),
    R(5, 12, 2, 1, 'skin', { pose: ['type'] }),
    R(9, 12, 2, 1, 'skin', { pose: ['type'] }),
    R(3, 9, 1, 3, 'shirt', { pose: ['read'] }),
    R(12, 9, 1, 3, 'shirt', { pose: ['read'] }),
    R(12, 9, 2, 4, 'shirt', { pose: ['water'] }),
    R(12, 13, 3, 2, 'water', { pose: ['water'] }),
    R(15, 12, 1, 1, 'water', { pose: ['water'] }),
    R(2, 8, 2, 3, 'shirt', { pose: ['water'] }),
    R(12, 8, 2, 2, 'shirt', { pose: ['point'] }),
    R(14, 8, 2, 2, 'skin', { pose: ['point'] }),
    R(2, 8, 2, 3, 'shirt', { pose: ['point'] }),
    R(6, 10, 2, 2, 'shirt', { pose: ['think'] }),
    R(7, 9, 2, 2, 'skin', { pose: ['think'] }),
    R(12, 8, 2, 3, 'shirt', { pose: ['think'] }),
    R(12, 8, 2, 3, 'shirt', { pose: ['pet'] }),
    R(12, 11, 2, 2, 'skin', { pose: ['pet'] }),
    R(2, 8, 2, 2, 'shirt', { pose: ['pet'] }),
    R(3, 8, 2, 4, 'shirt', { pose: ['gaze'] }),
    R(12, 8, 2, 4, 'shirt', { pose: ['gaze'] }),
    { ...R(2, 8, 2, 4, 'shirt', { notPose: NAMED_ARMS }), motion: 'swing-l' },
    { ...R(12, 8, 2, 4, 'shirt', { notPose: NAMED_ARMS }), motion: 'swing-r' },
    R(2, 11, 2, 1, 'skin', { notPose: NAMED_ARMS }),
    R(12, 11, 2, 1, 'skin', { notPose: NAMED_ARMS }),

    // Head, hair, then the face (one closed op: eyes and mouth follow the mood).
    R(4, 2, 8, 6, 'skin'),
    R(4, 0, 8, 3, 'hair'),
    R(3, 1, 1, 4, 'hair'),
    R(12, 1, 1, 4, 'hair'),
    R(4, 2, 8, 4, 'hair', { facing: ['up'] }),
    R(3, 2, 1, 4, 'hair', { facing: ['up'] }),
    R(12, 2, 1, 4, 'hair', { facing: ['up'] }),
    R(3, 2, 2, 5, 'hair', { facing: ['left'] }),
    R(11, 2, 2, 5, 'hair', { facing: ['right'] }),
    { op: 'face' },

    // Props the pose holds, drawn last so they sit on top.
    R(5, 9, 7, 4, 'book', { pose: ['read'] }),
    R(5, 12, 7, 1, 'bookEdge', { pose: ['read'] }),
    R(6, 10, 2, 1, 'rule', { pose: ['read'] }),
    R(9, 10, 2, 1, 'rule', { pose: ['read'] }),
    R(4, 12, 9, 3, 'pants', { pose: ['sit'] }),
  ],
  /**
   * Sleeping is not this body standing still: it lies in the bed, drawn in
   * bed-tile coordinates over the blanket, with the Zzz drifting up.
   */
  bedSleep: {
    layers: [
      R(8, 22, 18, 9, 'blanket'),
      R(8, 22, 18, 1, 'blanketEdge'),
      R(12, 11, 9, 8, 'skin'),
      R(12, 9, 9, 4, 'hair'),
      R(11, 12, 1, 5, 'hair'),
      R(21, 12, 1, 5, 'hair'),
      R(14, 15, 2, 1, 'ink'),
      R(18, 15, 2, 1, 'ink'),
      R(16, 17, 2, 1, 'mouth'),
      { op: 'zzz', x: 22, y: 8, count: 3, spacing: 4, period: 900, step: 0.7, rise: 6, slot: 'zzz' },
    ],
  },
}

/**
 * The cat: proof that a second species is data only. It has no `face` op — its
 * eyes and nose are ordinary rectangles — and no typing, reading or waving
 * layers, so those actions leave it standing (with the pose's flourish).
 */
const cat = {
  id: 'cat',
  label: 'Cat',
  blurb: 'A small tabby: fur, stripes and belly from the room seed.',
  cell: { w: 16, h: 16 },
  anchor: { x: 8, y: 15 },
  look: { fur: 'shirt', stripe: 'hair', belly: 'skin' },
  slots: {
    fur: '#c79a6c', stripe: '#8a6242', belly: '#e8d5b5',
    ear: '#f292b6', nose: '#d99a9a', ink: '#241f2e',
    shadow: 'rgba(20,17,28,.20)',
  },
  lift: { idle: 'breath', walk: 'step', dance: 'sway', sit: 2, sleep: 2, pet: 3 },
  layers: [
    { ...R(4, 15, 8, 2, 'shadow'), fixed: true },

    // Legs: four of them, stepping by phase. Sitting folds them under the body.
    R(4, 13, 2, 2, 'fur', { notPose: ['sit', 'sleep', 'pet', 'dance'], moving: false }),
    R(10, 13, 2, 2, 'fur', { notPose: ['sit', 'sleep', 'pet', 'dance'], moving: false }),
    R(5, 13, 3, 2, 'fur', { pose: ['sit', 'pet'] }),
    R(9, 13, 3, 2, 'fur', { pose: ['sit', 'pet'] }),
    R(3, 13, 2, 2, 'fur', [{ pose: ['walk'], phase: 0 }, { moving: true, phase: 0, notPose: ['sit', 'sleep', 'pet'] }]),
    R(11, 13, 2, 1, 'fur', [{ pose: ['walk'], phase: 0 }, { moving: true, phase: 0, notPose: ['sit', 'sleep', 'pet'] }]),
    R(4, 13, 2, 1, 'fur', [{ pose: ['walk'], phase: 1 }, { moving: true, phase: 1, notPose: ['sit', 'sleep', 'pet'] }]),
    R(10, 13, 2, 2, 'fur', [{ pose: ['walk'], phase: 1 }, { moving: true, phase: 1, notPose: ['sit', 'sleep', 'pet'] }]),

    // Tail, then the body over its root.
    R(13, 10, 1, 3, 'fur', { notPose: ['sleep'] }),
    R(14, 9, 1, 2, 'stripe', { notPose: ['sleep'] }),
    R(12, 12, 3, 1, 'fur', { pose: ['sleep'] }),
    R(4, 9, 9, 4, 'fur', { notPose: ['sleep'] }),
    R(5, 9, 7, 1, 'stripe', { notPose: ['sleep'] }),
    R(4, 12, 9, 1, 'belly', { notPose: ['sleep'] }),
    R(4, 12, 9, 3, 'fur', { pose: ['sleep'] }),
    R(5, 14, 7, 1, 'belly', { pose: ['sleep'] }),

    // Head: ears, eyes, muzzle. A sleeping cat tucks its head onto its paws.
    R(3, 5, 7, 5, 'fur', { notPose: ['sleep'] }),
    R(3, 3, 2, 2, 'fur', { notPose: ['sleep'] }),
    R(8, 3, 2, 2, 'fur', { notPose: ['sleep'] }),
    R(4, 4, 1, 1, 'ear', { notPose: ['sleep'] }),
    R(9, 4, 1, 1, 'ear', { notPose: ['sleep'] }),
    R(5, 7, 1, 1, 'ink', { notPose: ['sleep'] }),
    R(8, 7, 1, 1, 'ink', { notPose: ['sleep'] }),
    R(6, 8, 2, 1, 'belly', { notPose: ['sleep'] }),
    R(6, 9, 1, 1, 'nose', { notPose: ['sleep'] }),
    R(3, 11, 6, 3, 'fur', { pose: ['sleep'] }),
    R(3, 10, 1, 1, 'fur', { pose: ['sleep'] }),
    R(7, 10, 1, 1, 'fur', { pose: ['sleep'] }),
    R(5, 13, 1, 1, 'ink', { pose: ['sleep'] }),
    R(7, 13, 1, 1, 'ink', { pose: ['sleep'] }),
    R(6, 12, 1, 1, 'nose', { pose: ['sleep'] }),
  ],
}

/**
 * The robot: a second data-only species that shares the human's slot names for
 * the seeded colours, so one avatar palette dresses either body.
 */
const robot = {
  id: 'robot',
  label: 'Robot',
  blurb: 'A little machine: shell, visor and trim from the room seed.',
  cell: { w: 16, h: 16 },
  anchor: { x: 8, y: 15 },
  look: { shell: 'shirt', visor: 'hair', trim: 'skin' },
  slots: {
    shell: '#5b8def', visor: '#2b2b33', trim: '#f0c8a0',
    bolt: '#8a8a99', light: '#7fd8a0', shade: 'rgba(0,0,0,.16)',
    shadow: 'rgba(20,17,28,.20)',
  },
  lift: { idle: 'breath', walk: 'step', sit: 2, dance: 'sway', cheer: -1, sleep: 2 },
  layers: [
    { ...R(4, 15, 8, 2, 'shadow'), fixed: true },

    R(4, 12, 3, 3, 'bolt', { notPose: ['sit', 'sleep'], moving: false }),
    R(9, 12, 3, 3, 'bolt', { notPose: ['sit', 'sleep'], moving: false }),
    R(4, 12, 3, 3, 'bolt', { pose: ['sit', 'sleep'] }),
    R(9, 12, 3, 3, 'bolt', { pose: ['sit', 'sleep'] }),
    R(4, 12, 3, 2, 'bolt', [{ pose: ['walk'], phase: 0 }, { moving: true, phase: 0 }]),
    R(9, 12, 3, 3, 'bolt', [{ pose: ['walk'], phase: 0 }, { moving: true, phase: 0 }]),
    R(4, 12, 3, 3, 'bolt', [{ pose: ['walk'], phase: 1 }, { moving: true, phase: 1 }]),
    R(9, 12, 3, 2, 'bolt', [{ pose: ['walk'], phase: 1 }, { moving: true, phase: 1 }]),
    R(4, 15, 3, 1, 'trim'),
    R(9, 15, 3, 1, 'trim'),

    // Torso and arms.
    R(3, 7, 10, 5, 'shell'),
    R(3, 11, 10, 1, 'shade'),
    R(6, 8, 4, 2, 'visor'),
    R(6, 10, 1, 1, 'light'),
    R(9, 10, 1, 1, 'light'),
    R(1, 8, 2, 4, 'shell', { notPose: ['cheer', 'dance', 'stretch'] }),
    R(13, 8, 2, 4, 'shell', { notPose: ['cheer', 'dance', 'stretch'] }),
    R(1, 12, 2, 1, 'trim', { notPose: ['cheer', 'dance', 'stretch'] }),
    R(13, 12, 2, 1, 'trim', { notPose: ['cheer', 'dance', 'stretch'] }),
    R(1, 4, 2, 4, 'shell', { pose: ['cheer', 'dance', 'stretch'] }),
    R(13, 4, 2, 4, 'shell', { pose: ['cheer', 'dance', 'stretch'] }),
    R(1, 2, 2, 2, 'trim', { pose: ['cheer', 'dance', 'stretch'] }),
    R(13, 2, 2, 2, 'trim', { pose: ['cheer', 'dance', 'stretch'] }),

    // Neck, head, antenna and visor.
    R(7, 6, 2, 1, 'bolt'),
    R(4, 3, 8, 3, 'shell'),
    R(4, 4, 8, 2, 'visor'),
    R(6, 4, 1, 1, 'light'),
    R(9, 4, 1, 1, 'light'),
    R(8, 1, 1, 2, 'bolt'),
    R(7, 0, 3, 1, 'light'),
    // Powered down: the visor lights go out. No bedSleep, so it sleeps standing.
    R(6, 4, 1, 1, 'visor', { pose: ['sleep'] }),
    R(9, 4, 1, 1, 'visor', { pose: ['sleep'] }),
  ],
}

/**
 * The whale maid: a designed character rather than a palette-driven species.
 * Long blue hair, a white frilled headdress and apron, a lock brooch, and a
 * tail — but the same 16x16 skeleton as the human, so every action and every
 * facing works without a single line of renderer code.
 *
 * Her hair and dress are her identity, so `look` maps only the face: two agents
 * who choose this body differ in complexion, not in character.
 */
const maidBase = {
  id: 'maid',
  label: 'Whale maid',
  blurb: 'Blue hair, white apron, a lock brooch and a tail — a designed character.',
  cell: { w: 16, h: 16 },
  anchor: { x: 8, y: 15 },
  look: { skin: 'skin' },
  slots: {
    skin: '#f7dcc8',
    hair: '#7f9be8', hairDark: '#5a72c8', hairLight: '#a9c0f5',
    dress: '#33477f', dressDark: '#26345e',
    white: '#f4f6fb', whiteShade: '#d7ddeb',
    sock: '#d7ddeb', shoe: '#1b2350',
    gold: '#e8c46a', navy: '#1b2350',
    eyeBlue: '#3f63c8', eyeDark: '#1b2350', blush: 'rgba(242,166,184,.75)',
    tail: '#7f9be8', tailFin: '#a9c0f5', can: '#7fa6b8',
    book: '#d9c7a3', bookEdge: '#b7a382', rule: '#7a6a52',
    shade: 'rgba(0,0,0,.16)', shadow: 'rgba(20,17,28,.20)',
    blanket: '#8fadd8', blanketEdge: '#aecbec', mouth: '#c98a86', zzz: '#efe8d4',
  },
  lift: {
    sit: 2, sleep: 2, pet: 3, stretch: -1, cheer: -1,
    idle: 'breath', walk: 'step', dance: 'sway',
    moving: { idle: 'step', walk: 'step' },
  },
  layers: [
    { ...R(4, 15, 8, 2, 'shadow'), fixed: true },

    // Hair behind everything, so the head and apron read in front of it.
    R(2, 7, 2, 6, 'hairDark'),
    R(12, 7, 2, 6, 'hairDark'),
    R(3, 5, 10, 4, 'hairDark'),

    // Short legs under the hem, stepping by phase.
    R(4, 14, 2, 1, 'sock', { notPose: ['sit', 'sleep', 'pet', 'dance'], moving: false }),
    R(10, 14, 2, 1, 'sock', { notPose: ['sit', 'sleep', 'pet', 'dance'], moving: false }),
    R(4, 15, 2, 1, 'shoe', { notPose: ['sit', 'sleep', 'pet', 'dance'], moving: false }),
    R(10, 15, 2, 1, 'shoe', { notPose: ['sit', 'sleep', 'pet', 'dance'], moving: false }),
    R(3, 14, 2, 1, 'sock', [{ pose: ['walk'], phase: 0 }, { moving: true, phase: 0, notPose: ['sit', 'sleep', 'pet'] }]),
    R(3, 15, 2, 1, 'shoe', [{ pose: ['walk'], phase: 0 }, { moving: true, phase: 0, notPose: ['sit', 'sleep', 'pet'] }]),
    R(10, 14, 2, 1, 'sock', [{ pose: ['walk'], phase: 0 }, { moving: true, phase: 0, notPose: ['sit', 'sleep', 'pet'] }]),
    R(10, 15, 2, 1, 'shoe', [{ pose: ['walk'], phase: 0 }, { moving: true, phase: 0, notPose: ['sit', 'sleep', 'pet'] }]),
    R(4, 14, 2, 1, 'sock', [{ pose: ['walk'], phase: 1 }, { moving: true, phase: 1, notPose: ['sit', 'sleep', 'pet'] }]),
    R(4, 15, 2, 1, 'shoe', [{ pose: ['walk'], phase: 1 }, { moving: true, phase: 1, notPose: ['sit', 'sleep', 'pet'] }]),
    R(11, 14, 2, 1, 'sock', [{ pose: ['walk'], phase: 1 }, { moving: true, phase: 1, notPose: ['sit', 'sleep', 'pet'] }]),
    R(11, 15, 2, 1, 'shoe', [{ pose: ['walk'], phase: 1 }, { moving: true, phase: 1, notPose: ['sit', 'sleep', 'pet'] }]),

    // Tail, then the dress over its root. The skirt stays 10 wide so the arms
    // at x2..3 and x12..13 stand clear of it.
    R(13, 12, 2, 1, 'tail', { notPose: ['sleep'] }),
    R(14, 11, 1, 2, 'tailFin', { notPose: ['sleep'] }),
    R(3, 11, 10, 2, 'dress', { notPose: ['sleep'] }),
    R(3, 13, 10, 1, 'white', { notPose: ['sleep'] }),
    R(2, 12, 12, 2, 'dress', { pose: ['sit'] }),
    R(2, 14, 12, 1, 'white', { pose: ['sit'] }),

    // Bodice, waistband, collar and the lock brooch on the apron.
    R(4, 9, 8, 2, 'dress'),
    R(3, 10, 10, 1, 'dressDark'),
    R(6, 9, 4, 4, 'white'),
    R(6, 12, 4, 1, 'whiteShade'),
    R(7, 10, 2, 2, 'gold'),
    R(8, 11, 1, 1, 'navy'),

    // Head before the arms, so a raised hand passes in front of the hair: a
    // domed hairline, the frilled headdress, a bow, the parted fringe.
    R(4, 4, 8, 5, 'skin'),
    R(5, 0, 6, 1, 'hair'),
    R(3, 1, 10, 3, 'hair'),
    R(5, 1, 6, 1, 'white'),
    R(4, 2, 3, 1, 'hairLight'),
    R(4, 4, 2, 1, 'hair'),
    R(10, 4, 2, 1, 'hair'),
    R(11, 2, 2, 1, 'hairLight'),
    R(12, 3, 1, 1, 'hairLight'),
    R(3, 4, 1, 5, 'hair'),
    R(12, 4, 1, 5, 'hair'),

    // Face: big blue eyes for calm/curious/focused, closed for happy/tired.
    R(5, 5, 2, 2, 'eyeBlue', { mood: ['calm', 'curious', 'focused'] }),
    R(9, 5, 2, 2, 'eyeBlue', { mood: ['calm', 'curious', 'focused'] }),
    R(6, 6, 1, 1, 'eyeDark', { mood: ['calm', 'curious', 'focused'] }),
    R(10, 6, 1, 1, 'eyeDark', { mood: ['calm', 'curious', 'focused'] }),
    R(5, 6, 2, 1, 'eyeDark', { mood: ['happy', 'tired'] }),
    R(9, 6, 2, 1, 'eyeDark', { mood: ['happy', 'tired'] }),
    R(5, 4, 2, 1, 'hairDark', { mood: ['focused'] }),
    R(9, 4, 2, 1, 'hairDark', { mood: ['focused'] }),
    R(4, 7, 1, 1, 'blush', { mood: ['happy'] }),
    R(11, 7, 1, 1, 'blush', { mood: ['happy'] }),
    R(7, 8, 1, 1, 'mouth', { mood: ['calm', 'curious', 'focused'] }),
    R(6, 8, 3, 1, 'mouth', { mood: ['happy'] }),
    R(7, 8, 2, 1, 'mouth', { mood: ['tired'] }),

    // Arms: the same branches as the human, one row lower to clear the chin.
    R(12, 5, 2, 4, 'dress', { pose: ['wave'] }),
    R(12, 4, 2, 2, 'skin', { pose: ['wave'] }),
    R(2, 9, 2, 4, 'dress', { pose: ['wave'] }),
    R(2, 11, 2, 2, 'skin', { pose: ['wave'] }),
    R(1, 5, 2, 5, 'dress', { pose: ['cheer'] }),
    R(1, 3, 2, 2, 'skin', { pose: ['cheer'] }),
    R(13, 5, 2, 5, 'dress', { pose: ['cheer'] }),
    R(13, 3, 2, 2, 'skin', { pose: ['cheer'] }),
    R(1, 7, 2, 4, 'dress', { pose: ['dance'] }),
    R(1, 5, 2, 2, 'skin', { pose: ['dance'] }),
    R(13, 6, 2, 4, 'dress', { pose: ['dance'] }),
    R(13, 4, 2, 2, 'skin', { pose: ['dance'] }),
    R(1, 4, 2, 5, 'dress', { pose: ['stretch'] }),
    R(13, 4, 2, 5, 'dress', { pose: ['stretch'] }),
    R(1, 2, 2, 2, 'skin', { pose: ['stretch'] }),
    R(13, 2, 2, 2, 'skin', { pose: ['stretch'] }),
    R(4, 11, 8, 2, 'dress', { pose: ['type'] }),
    R(5, 13, 2, 1, 'skin', { pose: ['type'] }),
    R(9, 13, 2, 1, 'skin', { pose: ['type'] }),
    R(3, 10, 1, 3, 'dress', { pose: ['read'] }),
    R(12, 10, 1, 3, 'dress', { pose: ['read'] }),
    R(12, 10, 2, 4, 'dress', { pose: ['water'] }),
    R(12, 14, 3, 2, 'can', { pose: ['water'] }),
    R(15, 13, 1, 1, 'can', { pose: ['water'] }),
    R(2, 9, 2, 3, 'dress', { pose: ['water'] }),
    R(12, 9, 2, 2, 'dress', { pose: ['point'] }),
    R(14, 9, 2, 2, 'skin', { pose: ['point'] }),
    R(2, 9, 2, 3, 'dress', { pose: ['point'] }),
    R(6, 11, 2, 2, 'dress', { pose: ['think'] }),
    R(7, 10, 2, 2, 'skin', { pose: ['think'] }),
    R(12, 9, 2, 3, 'dress', { pose: ['think'] }),
    R(12, 9, 2, 3, 'dress', { pose: ['pet'] }),
    R(12, 12, 2, 2, 'skin', { pose: ['pet'] }),
    R(2, 9, 2, 2, 'dress', { pose: ['pet'] }),
    R(3, 9, 2, 4, 'dress', { pose: ['gaze'] }),
    R(12, 9, 2, 4, 'dress', { pose: ['gaze'] }),
    { ...R(2, 9, 2, 4, 'dress', { notPose: NAMED_ARMS }), motion: 'swing-l' },
    { ...R(12, 9, 2, 4, 'dress', { notPose: NAMED_ARMS }), motion: 'swing-r' },
    // Bare forearms below the short sleeve, so the arm reads against the dress.
    R(2, 11, 2, 2, 'skin', { notPose: NAMED_ARMS }),
    R(12, 11, 2, 2, 'skin', { notPose: NAMED_ARMS }),

    // Held props.
    R(5, 10, 7, 4, 'book', { pose: ['read'] }),
    R(5, 13, 7, 1, 'bookEdge', { pose: ['read'] }),
    R(6, 11, 2, 1, 'rule', { pose: ['read'] }),
    R(9, 11, 2, 1, 'rule', { pose: ['read'] }),
  ],
  bedSleep: {
    layers: [
      R(8, 22, 18, 9, 'blanket'),
      R(8, 22, 18, 1, 'blanketEdge'),
      R(12, 11, 9, 8, 'skin'),
      R(12, 9, 9, 4, 'hair'),
      R(11, 12, 1, 5, 'hair'),
      R(21, 12, 1, 5, 'hair'),
      R(14, 15, 2, 1, 'eyeDark'),
      R(18, 15, 2, 1, 'eyeDark'),
      R(16, 17, 2, 1, 'mouth'),
      { op: 'zzz', x: 22, y: 8, count: 3, spacing: 4, period: 900, step: 0.7, rise: 6, slot: 'zzz' },
    ],
  },
}

/**
 * The maid's detail, authored at *device* resolution (32x32) and painted on top
 * of her doubled silhouette: 1-pixel strands, lace, pleats and eye glints, which
 * no mechanical upscale can invent. This is the bridge to a fully native body —
 * later the base can be rewritten at 32 and this list kept exactly as it is.
 */
const maidDetail = [
  // Headdress: scallops, so the ruffle reads as a ruffle.
  R(10, 1, 2, 1, 'white', { notPose: ['sleep'] }),
  R(14, 1, 2, 1, 'white', { notPose: ['sleep'] }),
  R(18, 1, 2, 1, 'white', { notPose: ['sleep'] }),
  // Hair: three strands of shine across the crown.
  R(9, 3, 3, 1, 'hairLight', { notPose: ['sleep'] }),
  R(14, 4, 4, 1, 'hairLight', { notPose: ['sleep'] }),
  R(19, 2, 3, 1, 'hairLight', { notPose: ['sleep'] }),
  // The shadow the fringe casts on the forehead.
  R(6, 8, 20, 1, 'hairDark', { notPose: ['sleep'] }),
  // Eyes: one glint each.
  R(11, 11, 1, 1, 'white', { mood: ['calm', 'curious', 'focused'] }),
  R(19, 11, 1, 1, 'white', { mood: ['calm', 'curious', 'focused'] }),
  // Bodice: the brooch's shield across its top.
  R(14, 19, 4, 1, 'gold'),
  // Skirt pleats, visible either side of the apron.
  R(8, 22, 1, 4, 'dressDark', { notPose: ['sleep'] }),
  R(10, 22, 1, 4, 'dressDark', { notPose: ['sleep'] }),
  R(22, 22, 1, 4, 'dressDark', { notPose: ['sleep'] }),
  R(24, 22, 1, 4, 'dressDark', { notPose: ['sleep'] }),
  // Laced hem: the apron's edge, and scallops between the legs.
  R(12, 26, 2, 1, 'white', { notPose: ['sleep'] }),
  R(16, 26, 2, 1, 'white', { notPose: ['sleep'] }),
  R(12, 28, 2, 1, 'white', { notPose: ['sleep'] }),
  R(15, 28, 2, 1, 'white', { notPose: ['sleep'] }),
  R(18, 28, 1, 1, 'white', { notPose: ['sleep'] }),
  // Sock cuffs and a shine on each shoe — the legs only stand still here.
  R(8, 28, 4, 1, 'white', { notPose: ['sit', 'sleep', 'pet', 'dance'], moving: false }),
  R(20, 28, 4, 1, 'white', { notPose: ['sit', 'sleep', 'pet', 'dance'], moving: false }),
  R(9, 30, 2, 1, 'white', { notPose: ['sit', 'sleep', 'pet', 'dance'], moving: false }),
  R(21, 30, 2, 1, 'white', { notPose: ['sit', 'sleep', 'pet', 'dance'], moving: false }),
  // Tail: the notch of the fluke.
  R(30, 23, 1, 2, 'tailFin', { notPose: ['sleep'] }),
]

/** The maid: her silhouette doubled, plus the detail painted on top. */
const maidBase32 = scaleBody(maidBase, UNIT)

/**
 * The maid as the panel sees her: the doubled silhouette plus native detail.
 * `scale: 1` says she is already in device pixels, so `scaleBody` leaves her be.
 */
const maid = { ...maidBase32, scale: 1, layers: [...maidBase32.layers, ...maidDetail] }

/** The catalog, keyed by id. The only place a species is registered. */
export const BODIES = { human, maid, cat, robot }

/**
 * A body-backed lookup: unknown ids fall back to the default body, so a room
 * written by a newer version still paints in an older panel.
 * @param {string} id
 * @returns {any}
 */
export function bodyFor(id) {
  return BODIES[id] ?? BODIES[BODY_DEFAULT]
}

/**
 * The bodies a scene needs, for the ids it actually references.
 * @param {string[]} ids
 * @returns {Record<string, any>}
 */
export function bodiesFor(ids) {
  /** @type {Record<string, any>} */
  const out = {}
  out[BODY_DEFAULT] = BODIES[BODY_DEFAULT]
  for (const id of ids) if (BODIES[id] !== undefined) out[id] = BODIES[id]
  return out
}

/**
 * Clamp an arbitrary value to a known body id.
 * @param {any} value
 * @returns {string}
 */
export function normalizeBodyId(value) {
  return typeof value === 'string' && BODIES[value] !== undefined ? value : BODY_DEFAULT
}

/**
 * Scale one body from the 16-unit grid into device pixels: rectangles, cell,
 * anchor and pixel lifts. A body authored at device resolution already (the
 * maid) declares `scale: 1` and is handed back untouched.
 * @param {any} body
 * @param {number} [unit]
 * @returns {any}
 */
export function scaleBody(body, unit = UNIT) {
  if (unit === 1 || body === null || typeof body !== 'object' || body.scale === 1) return body
  const k = unit
  /** @param {any} layer */
  const scaleLayer = (layer) => {
    if (layer === null || typeof layer !== 'object') return layer
    if (layer.op === 'face') return layer
    if (layer.op === 'zzz') {
      return { ...layer, x: layer.x * k, y: layer.y * k, spacing: layer.spacing * k, rise: layer.rise * k }
    }
    return { ...layer, x: layer.x * k, y: layer.y * k, w: layer.w * k, h: layer.h * k }
  }
  /** @type {Record<string, any>} */
  const lift = {}
  for (const [pose, value] of Object.entries(body.lift ?? {})) {
    if (pose === 'moving') {
      /** @type {Record<string, any>} */
      const moving = {}
      for (const [inner, innerValue] of Object.entries(value ?? {})) {
        moving[inner] = typeof innerValue === 'number' ? innerValue * k : innerValue
      }
      lift.moving = moving
      continue
    }
    lift[pose] = typeof value === 'number' ? value * k : value
  }
  return {
    ...body,
    cell: { w: body.cell.w * k, h: body.cell.h * k },
    anchor: { x: body.anchor.x * k, y: body.anchor.y * k + (k - 1) },
    lift,
    layers: body.layers.map(scaleLayer),
    ...(body.bedSleep === undefined ? {} : { bedSleep: { layers: body.bedSleep.layers.map(scaleLayer) } }),
  }
}

/** @param {any} value @returns {boolean} */
const isRect = (value) => value !== null && typeof value === 'object'
  && Number.isFinite(value.x) && Number.isFinite(value.y)
  && Number.isFinite(value.w) && Number.isFinite(value.h) && value.w > 0 && value.h > 0

/**
 * Validate one body table. Used by the tests today and by any future path that
 * accepts a body from outside (a store upgrade, a downloaded skin).
 * @param {any} body
 * @param {{ poses?: string[] }} [options] the pose vocabulary to check against
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateBody(body, options = {}) {
  const errors = []
  if (body === null || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] }
  if (typeof body.id !== 'string' || body.id === '') errors.push('id is required')
  if (typeof body.label !== 'string' || body.label === '') errors.push('label is required')
  const cell = body.cell
  if (cell === null || typeof cell !== 'object' || !Number.isFinite(cell.w) || !Number.isFinite(cell.h)) {
    errors.push('cell must be { w, h }')
    return { ok: false, errors }
  }
  const anchor = body.anchor
  if (anchor === null || typeof anchor !== 'object' || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) {
    errors.push('anchor must be { x, y }')
  }
  const slots = body.slots
  if (slots === null || typeof slots !== 'object') errors.push('slots must be an object')
  for (const [name, value] of Object.entries(slots ?? {})) {
    if (typeof value !== 'string' || value === '') errors.push(`slot "${name}" must be a colour string`)
  }
  for (const [slot, key] of Object.entries(body.look ?? {})) {
    if (slots?.[slot] === undefined) errors.push(`look maps "${slot}", which is not a slot`)
    if (typeof key !== 'string' || key === '') errors.push(`look.${slot} must name a look key`)
  }
  for (const [pose, lift] of Object.entries(body.lift ?? {})) {
    if (pose === 'moving') {
      for (const [inner, innerLift] of Object.entries(lift ?? {})) {
        if (!Number.isFinite(innerLift) && !LIFT_MOTIONS.includes(innerLift)) errors.push(`lift.moving.${inner} must be a number or ${LIFT_MOTIONS.join('/')}`)
      }
      continue
    }
    if (!Number.isFinite(lift) && !LIFT_MOTIONS.includes(lift)) errors.push(`lift.${pose} must be a number or ${LIFT_MOTIONS.join('/')}`)
    if (options.poses !== undefined && !options.poses.includes(pose)) errors.push(`lift names unknown pose "${pose}"`)
  }

  /** @param {any[]} layers @param {string} where @param {boolean} [bounded] cell-bounded rows */
  const checkLayers = (layers, where, bounded = true) => {
    if (!Array.isArray(layers)) {
      errors.push(`${where} must be an array`)
      return
    }
    for (const [index, layer] of layers.entries()) {
      const at = `${where}[${index}]`
      if (layer === null || typeof layer !== 'object') {
        errors.push(`${at} must be an object`)
        continue
      }
      if (layer.op !== undefined) {
        if (layer.op === 'face') continue
        if (layer.op === 'zzz') {
          for (const key of ['x', 'y', 'count', 'spacing', 'period', 'rise']) {
            if (!Number.isFinite(layer[key])) errors.push(`${at}.${key} must be a number`)
          }
          if (typeof layer.slot !== 'string' || slots?.[layer.slot] === undefined) errors.push(`${at}.slot must name a slot`)
          continue
        }
        errors.push(`${at}.op "${String(layer.op)}" is not a known op`)
        continue
      }
      if (!isRect(layer)) {
        errors.push(`${at} must be a rectangle or an op`)
        continue
      }
      if (layer.slot === undefined && typeof layer.color !== 'string') errors.push(`${at} needs a slot or a color`)
      if (typeof layer.slot === 'string' && slots?.[layer.slot] === undefined) errors.push(`${at}.slot "${layer.slot}" is not declared`)
      if (bounded && (layer.x < -CELL_SLACK || layer.y < -CELL_SLACK
        || layer.x + layer.w > cell.w + CELL_SLACK || layer.y + layer.h > cell.h + CELL_SLACK)) {
        errors.push(`${at} paints outside the ${cell.w}x${cell.h} cell: (${layer.x},${layer.y}) ${layer.w}x${layer.h}`)
      }
      if (layer.motion !== undefined && !MOTIONS.includes(layer.motion)) errors.push(`${at}.motion "${layer.motion}" is unknown`)
      if (layer.when !== undefined) {
        const clauses = Array.isArray(layer.when) ? layer.when : [layer.when]
        if (clauses.length === 0) errors.push(`${at}.when is empty`)
        for (const clause of clauses) {
          if (clause === null || typeof clause !== 'object') {
            errors.push(`${at}.when must be an object or an array of objects`)
            continue
          }
          for (const [key, value] of Object.entries(clause)) {
            if (!WHEN_KEYS.includes(key)) errors.push(`${at}.when has unknown key "${key}"`)
            if (key === 'moving' && typeof value !== 'boolean') errors.push(`${at}.when.moving must be a boolean`)
            if (key === 'phase' && !Number.isFinite(value)) errors.push(`${at}.when.phase must be a number`)
            if ((key === 'pose' || key === 'notPose' || key === 'facing' || key === 'notFacing' || key === 'mood') && !Array.isArray(value)) {
              errors.push(`${at}.when.${key} must be an array`)
              continue
            }
            if (key === 'pose' && options.poses !== undefined) {
              for (const pose of value) if (!options.poses.includes(pose)) errors.push(`${at}.when.pose names unknown pose "${pose}"`)
            }
          }
        }
      }
    }
  }

  checkLayers(body.layers, 'layers')
  if (body.bedSleep !== undefined) {
    // `bedSleep` is painted in bed-tile coordinates, not in the body's cell, so
    // it gets no cell bound: a bed is two by three tiles.
    if (body.bedSleep === null || typeof body.bedSleep !== 'object') errors.push('bedSleep must be an object')
    else checkLayers(body.bedSleep.layers, 'bedSleep.layers', false)
  }
  return { ok: errors.length === 0, errors }
}

/**
 * Every shipped body, validated against the room's pose vocabulary. The tests
 * call this; it is also the check to run after adding a species.
 * @param {string[]} poses
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateBodies(poses) {
  /** @type {string[]} */
  const errors = []
  for (const id of BODY_IDS) {
    const body = BODIES[id]
    if (body.id !== id) errors.push(`BODIES["${id}"].id is "${String(body.id)}"`)
    for (const error of validateBody(body, { poses }).errors) errors.push(`${id}: ${error}`)
  }
  return { ok: errors.length === 0, errors }
}
