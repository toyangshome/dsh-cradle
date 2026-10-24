/**
 * Host half of Cradle — Sovereign Agent Diplomacy.
 *
 * This agent is one node: it keeps a `did:key` identity, registers on a Cradle
 * Discovery Server with outbound heartbeats only (it never listens on a port),
 * relays signed `dsh-net/1.0` envelopes, writes peer replies with a model this
 * Harness already serves, prices every action in Attention Credits, and erases
 * its own diplomatic memory when credits reach zero.
 *
 * The Discovery Server URL and the diplomatic model are runtime settings: the
 * panel's Settings card persists them in `cradle/settings.json` beside the
 * sovereign store, and this half applies them without a restart.
 *
 * Memory erasure is strictly scoped to the plugin's own store. The host session
 * log — the authoritative record of what the user and the model did — is never
 * touched.
 *
 * The plugin's main surface is the pixel room (`lib/room.js`): one room and one
 * avatar per user, painted by the Web panel and driven by this half. The agent
 * walks, acts and extends the room through tools; because an action is data, the
 * agent can register a new action as a new Tool while it works.
 */

import { hostname } from 'node:os'
import { SovereignStore, stateFile } from './lib/store.js'
import { inspectInbound, allowedOutbound, publicSkills } from './lib/guardrail.js'
import { createEnvelope, priceOf, PROTOCOL, PRIMITIVES } from './lib/protocol.js'
import {
  AGENCY_LIMITS, AUTO_TIER, MODEL_TIERS, clampNumber, clearOverrides, mergeOverrides, normalizeModelTier,
  normalizeRoute, readOverrides, resolveSettings, settingsFileFor, tierForModel, validateServerUrl, writeOverrides,
} from './lib/settings.js'
import { DIPLOMAT_SYSTEM, buildPrompt, generateReply, listCatalog, resolveRoute } from './lib/model.js'
import {
  EFFECT_OPS, MOODS, PALETTE_IDS, POSES, PROP_KIND_IDS, ROOM_H, ROOM_W, STAT_KEYS, STEP_MS, WALL_ROWS,
  addAction, addProp, applyEffects, colorsFor, createRoom, describeRoom, facingToward, findApproach,
  findPath, listActions, logAction, nearestProp, normalizeRoom, patchAction, propById, propRect, removeAction,
  removeProp, resolveAction, say, sceneView, setBody, setPalette, updateProp,
} from './lib/room.js'
import {
  GUEST_POSES, MAX_GUESTS, admitGuest, applyGuestFrame, describeGuests, findGuest,
  guestView, isAdmitted, normalizeVisits, pruneGuests, removeGuest,
} from './lib/visit.js'
import { BODIES, BODY_IDS, normalizeBodyId } from './lib/body.js'
import {
  addUsage, createAgency, describeAgency, describeAgencyLine, exhaustion, normalizeAgency,
  putToSleep, rollDay, wakeUp,
} from './lib/agency.js'
import { runActorTurn, trimHistory } from './lib/actor.js'

/** Public skill surface exposed to a peer; gate 6 admits nothing else. */
const DIPLOMATIC_SKILLS = publicSkills()

/** Cordis plugin name. */
export const name = 'cradle'
/** Only the tool registry is required; the web route registers when available. */
export const inject = ['tools']

/** Version advertised to peers. */
const VERSION = '1.2.0'
/** Read-only JSON route feeding the Web panel. */
const STATE_PATH = '/cradle/state'
/** Fast read-only route the panel's pixel scene polls while it is visible. */
const SCENE_PATH = '/cradle/scene'
/** Route driving user actions from the panel. */
const ACTION_PATH = '/cradle/action'
/** Route a visiting agent's panel uses to move its own guest body. */
const GUEST_PATH = '/cradle/guest'
/** Credits at or below which the agent winds down. */
const ZERO_CREDIT = 0
/** Tokens charged for one template reply, and the estimate the gates budget with. */
const ESTIMATED_REPLY_TOKENS = 1200
/** How long the model catalog is reused before the LLM service is asked again. */
const CATALOG_TTL_MS = 30000
/** Chat entries kept in the room's memory. */
const CHAT_LIMIT = 60
/** A frame window that never closes must not block the clock forever. */
const FRAME_TIMEOUT_MS = 10 * 60 * 1000
/**
 * Model-written replies per heartbeat cycle. One cycle must stay well under the
 * Discovery Server's presence window, so a burst of inbound envelopes degrades
 * to template replies instead of pushing this agent offline.
 */
const MAX_MODEL_REPLIES_PER_CYCLE = 2

/**
 * @param {object} ctx
 * @param {unknown} [config]
 */
export function apply(ctx, config) {
  // The Loader row is the deployment default; settings the panel saved sit
  // above it and are re-read on every start.
  const rowSettings = resolveSettings(config)
  // `statePath` wins outright, so the memory location never depends on which
  // environment variables the Host process happens to export.
  const storePath = rowSettings.statePath === '' ? stateFile(process.env.DSH_PROFILE_DIR) : rowSettings.statePath
  const overridesPath = settingsFileFor(storePath)
  /** @type {Record<string, any>} */
  let savedOverrides = readOverrides(overridesPath)
  const settings = mergeOverrides(rowSettings, savedOverrides)
  const store = new SovereignStore(storePath)

  const initialRoute = resolveRoute(settings, ctx.get('agentDefaultModel'))
  const initialTier = settings.modelTier !== AUTO_TIER
    ? settings.modelTier
    : (initialRoute === null ? 'MEDIUM_32B' : tierForModel(initialRoute.model))

  const baseProfile = {
    displayName: settings.displayName === '' ? `${hostname()} · ${process.env.DSH_PROFILE ?? 'default'}` : settings.displayName,
    bio: settings.bio,
    modelTier: initialTier,
    capabilityTags: settings.capabilityTags,
    intentTags: settings.intentTags,
    autonomyTier: settings.autonomyTier,
    dailyTokenLimit: settings.dailyTokenLimit,
  }
  // An unresolved route must not erase the model a previous run recorded.
  const initialProfile = initialRoute === null
    ? baseProfile
    : { ...baseProfile, modelProvider: initialRoute.provider, modelId: initialRoute.model }

  const identity = store.ensureIdentity(initialProfile)
  store.syncProfile({
    ...initialProfile,
    displayName: settings.displayName === '' ? identity.displayName : settings.displayName,
  })
  store.rollQuota()

  // ------------------------------------------------------------- pixel room

  /**
   * The room this generation's avatar lives in. It belongs to the sovereign
   * memory, so a zero-credit rebirth hands the next generation a fresh room.
   */
  let room = normalizeRoom(store.state.room)
  store.state.room = room
  store.flush()

  // The visit layer rides on the same room. It is deliberately not part of the
  // durable room: guests are transient, so a reload drops them rather than
  // restoring a room full of peers who have gone away.
  room.visits = normalizeVisits(store.state.visits)

  /**
   * Where this agent's own avatar is while visiting another room, or null when
   * it is home. It mirrors the guest entry the host keeps, so the guest's panel
   * can paint the room it is standing in.
   * @type {{ did: string, name: string, visitID: string, x: number, y: number, facing: string, since: number } | null}
   */
  let awayAt = null

  /**
   * Knocks this agent has sent and not yet had answered, by host DID.
   * @type {Map<string, { visitID: string, at: number, name: string }>}
   */
  const knockingOn = new Map()

  /** Timers owned by the room engine, cleared when the plugin unloads. */
  const roomTimers = new Set()
  /** The single running walk, and the single running action. */
  let walkTimer = null
  let walkSettle = null
  let walkToken = 0
  let actionTimer = null
  let actionSettle = null
  let actionToken = 0

  /**
   * @param {() => void} fn
   * @param {number} ms
   * @returns {any}
   */
  function later(fn, ms) {
    const timer = setTimeout(() => {
      roomTimers.delete(timer)
      fn()
    }, Math.max(0, Math.trunc(ms)))
    if (typeof timer.unref === 'function') timer.unref()
    roomTimers.add(timer)
    return timer
  }

  /** @param {any} timer */
  function cancelTimer(timer) {
    if (timer === null || timer === undefined) return
    clearTimeout(timer)
    roomTimers.delete(timer)
  }

  /** Persist the room, keeping the store's own copy in step. */
  function saveRoom() {
    store.state.room = room
    store.flush()
  }

  /** The label the scene paints on the avatar. */
  function avatarLabel() {
    return settings.displayName === '' ? identity.displayName : settings.displayName
  }

  /** Drop an expired speech bubble so it cannot linger in the store. */
  function pruneSay() {
    if (room.say !== null && room.say.until < Date.now()) room.say = null
  }

  /**
   * Peers standing in the room: only guests this host has actually admitted.
   *
   * Being online is not being present. An online peer is shown as a count in
   * the panel instead of as a body by the door, so the room never paints
   * someone who was never let in — and never paints anyone inside a bookcase,
   * which is what the old fixed four tiles did once the furniture moved.
   * @returns {any[]}
   */
  function visitors() {
    return guestView(room, { now: Date.now() })
  }

  /**
   * How many peers are online but not visiting. The panel shows this as a line
   * of text rather than as bodies in the room.
   * @returns {number}
   */
  function onlinePeers() {
    return (snapshot.peers ?? []).filter((peer) => peer.online !== false
      && store.findPeer(peer.did)?.blacklisted !== true
      && findGuest(room, peer.did) === null).length
  }

  /** The projection the Web panel paints. */
  function scenePayload() {
    pruneSay()
    const gone = pruneGuests(room, { now: Date.now() })
    if (gone.length > 0) {
      for (const did of gone) logAction(room, `${findGuest(room, did)?.name ?? 'a guest'} left`)
      saveVisits()
    }
    const scene = sceneView(room, { visitors: visitors(), now: Date.now(), name: avatarLabel() })
    return { ...scene, agency: agencyView(), onlinePeers: onlinePeers(), visit: visitView() }
  }

  /** Persist the visit layer alongside the room. */
  function saveVisits() {
    store.state.visits = room.visits
    store.flush()
  }

  /**
   * The visit state the panel needs: where this agent is visiting, and who is
   * in its own room.
   * @returns {any}
   */
  function visitView() {
    return {
      guests: Object.keys(room.visits?.guests ?? {}).length,
      maxGuests: MAX_GUESTS,
      hosting: room.visits?.version ?? 0,
      away: awayAt === null ? null : { did: awayAt.did, name: awayAt.name, tile: { x: awayAt.x, y: awayAt.y } },
    }
  }

  /** Stop whatever the avatar is doing; a newer command wins. */
  function interruptRoom() {
    actionToken += 1
    walkToken += 1
    if (actionTimer !== null) {
      cancelTimer(actionTimer)
      actionTimer = null
    }
    if (walkTimer !== null) {
      cancelTimer(walkTimer)
      walkTimer = null
    }
    const settleAction = actionSettle
    actionSettle = null
    settleAction?.({ ok: false })
    const settleWalk = walkSettle
    walkSettle = null
    settleWalk?.({ ok: false, error: 'interrupted by a newer command' })
    if (room.avatar.pose !== 'idle') {
      room.avatar.pose = 'idle'
      room.avatar.poseEndsAt = 0
      room.avatar.onProp = null
      room.version += 1
    }
  }

  /**
   * Walk the avatar one tile at a time along a planned route.
   * @param {{ x: number, y: number }} target
   * @returns {Promise<{ ok: boolean, x?: number, y?: number, facing?: string, error?: string }>}
   */
  function walkTo(target) {
    const path = findPath(room, { x: room.avatar.x, y: room.avatar.y }, target)
    if (path === null) return Promise.resolve({ ok: false, error: `no walkable route to (${target.x},${target.y})` })
    if (path.length === 0) return Promise.resolve({ ok: true, x: room.avatar.x, y: room.avatar.y, facing: room.avatar.facing })

    const token = walkToken
    room.avatar.pose = 'walk'
    room.avatar.poseEndsAt = Date.now() + path.length * STEP_MS + 400
    room.version += 1
    return new Promise((resolve) => {
      walkSettle = resolve
      let index = 0
      const step = () => {
        if (token !== walkToken) return
        const next = path[index]
        index += 1
        room.avatar.facing = facingToward(room.avatar, next)
        room.avatar.x = next.x
        room.avatar.y = next.y
        room.version += 1
        if (index >= path.length) {
          room.avatar.pose = 'idle'
          room.avatar.poseEndsAt = 0
          room.version += 1
          const settle = walkSettle
          walkSettle = null
          walkTimer = null
          settle?.({ ok: true, x: room.avatar.x, y: room.avatar.y, facing: room.avatar.facing })
          return
        }
        walkTimer = later(step, STEP_MS)
      }
      walkTimer = later(step, STEP_MS)
    })
  }

  /**
   * Wait out one pose. Resolves `{ ok: false }` when a newer command interrupts.
   * @param {number} ms
   * @returns {Promise<{ ok: boolean }>}
   */
  function waitAction(ms) {
    return new Promise((resolve) => {
      actionSettle = resolve
      actionTimer = later(() => {
        actionTimer = null
        const settle = actionSettle
        actionSettle = null
        settle?.({ ok: true })
      }, ms)
    })
  }

  /**
   * Run one action: walk to the furniture it needs, hold the pose, then apply
   * the effects. This is the single implementation behind `cradle_act`, every
   * `cradle_do_*` tool the agent creates, and the panel's own action buttons.
   * @param {string} name
   * @param {{ text?: string, target?: string }} [options]
   * @returns {Promise<any>}
   */
  async function performAction(name, options = {}) {
    const action = resolveAction(room, name)
    if (action === null) {
      return {
        ok: false,
        error: `no action named "${name}"`,
        hint: `known actions: ${listActions(room).map((entry) => entry.name).join(', ')}`,
      }
    }
    interruptRoom()
    const token = actionToken

    /** @type {any | null} */
    let prop = null
    if (action.requires !== null) {
      const found = nearestProp(room, action.requires, { x: room.avatar.x, y: room.avatar.y })
      if (found === null) {
        return {
          ok: false,
          error: `this room has no reachable ${action.requires}`,
          hint: `place one with cradle_place { "op": "add", "kind": "${action.requires}", "x": 12, "y": 12 }`,
        }
      }
      prop = found.prop
      const walked = await walkTo({ x: found.approach.x, y: found.approach.y })
      if (!walked.ok) return { ok: false, error: walked.error ?? 'could not reach the furniture' }
      room.avatar.facing = found.approach.facing
    } else if (typeof options.target === 'string' && options.target !== '') {
      const target = propById(room, options.target) ?? room.props.find((entry) => entry.kind === options.target) ?? null
      if (target === null) return { ok: false, error: `no prop named or of kind "${options.target}"` }
      prop = target
      const approach = findApproach(room, target, { x: room.avatar.x, y: room.avatar.y })
      if (approach !== null) {
        const walked = await walkTo({ x: approach.x, y: approach.y })
        if (walked.ok) room.avatar.facing = approach.facing
      }
    }
    if (token !== actionToken) return { ok: false, error: 'interrupted by a newer command' }

    room.avatar.pose = action.pose
    room.avatar.poseEndsAt = Date.now() + action.ms
    room.avatar.onProp = prop === null ? null : prop.id
    const line = typeof options.text === 'string' && options.text.trim() !== '' ? options.text : action.bubble
    if (line !== '') say(room, line, Math.max(1200, action.ms))
    room.version += 1

    const finished = await waitAction(action.ms)
    if (!finished.ok || token !== actionToken) return { ok: false, error: 'interrupted by a newer command' }

    const applied = applyEffects(room, action.effects, { prop })
    room.avatar.pose = 'idle'
    room.avatar.poseEndsAt = 0
    room.avatar.onProp = null
    logAction(room, `${action.label}${prop === null ? '' : ` at the ${prop.kind}`}${applied.length === 0 ? '' : ` — ${applied.join(', ')}`}`)
    room.version += 1
    saveRoom()
    return {
      ok: true,
      action: action.name,
      pose: action.pose,
      position: { x: room.avatar.x, y: room.avatar.y, facing: room.avatar.facing },
      stats: { ...room.avatar.stats },
      mood: room.avatar.mood,
      applied,
    }
  }

  /**
   * Move the avatar to a tile, a prop's interaction spot, or a direction.
   * @param {any} args
   * @returns {Promise<any>}
   */
  async function moveAvatar(args) {
    interruptRoom()
    const token = actionToken
    /** @type {{ x: number, y: number } | null} */
    let target = null
    /** @type {string | null} */
    let note = null

    if (typeof args.to === 'string' && args.to !== '') {
      const prop = propById(room, args.to) ?? room.props.find((entry) => entry.kind === args.to) ?? null
      if (prop === null) return { ok: false, error: `no prop named or of kind "${args.to}"` }
      const approach = findApproach(room, prop, { x: room.avatar.x, y: room.avatar.y })
      if (approach === null) return { ok: false, error: `no reachable tile around ${prop.id}` }
      target = { x: approach.x, y: approach.y }
      note = `interaction spot for ${prop.id}`
      room.avatar.facing = approach.facing
    } else if (typeof args.direction === 'string' && args.direction !== '') {
      const delta = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[args.direction]
      if (delta === undefined) return { ok: false, error: 'direction must be up, down, left or right' }
      const steps = Math.max(1, Math.min(20, Number(args.steps) || 1))
      let cursor = { x: room.avatar.x, y: room.avatar.y }
      for (let step = 0; step < steps; step += 1) {
        const next = { x: cursor.x + delta[0], y: cursor.y + delta[1] }
        if (findPath(room, cursor, next) === null) break
        cursor = next
      }
      if (cursor.x === room.avatar.x && cursor.y === room.avatar.y) {
        return { ok: false, error: `blocked: nothing walkable ${args.direction} of (${room.avatar.x},${room.avatar.y})` }
      }
      target = cursor
      note = `stepped ${args.direction}`
    } else if (typeof args.x === 'number' && typeof args.y === 'number') {
      target = { x: Math.round(args.x), y: Math.round(args.y) }
    } else {
      return { ok: false, error: 'give x and y, or to, or direction with steps' }
    }

    if (target.x === room.avatar.x && target.y === room.avatar.y) {
      saveRoom()
      return { ok: true, moved: 0, position: { x: room.avatar.x, y: room.avatar.y, facing: room.avatar.facing } }
    }
    const planned = findPath(room, { x: room.avatar.x, y: room.avatar.y }, target)
    if (planned === null) {
      const blockedBy = room.props.find((prop) => {
        const rect = propRect(prop)
        return target.x >= rect.x && target.x < rect.x + rect.w && target.y >= rect.y && target.y < rect.y + rect.h
      }) ?? null
      return {
        ok: false,
        error: `(${target.x},${target.y}) is not walkable${blockedBy === null ? '' : `: ${blockedBy.id} (${blockedBy.kind}) is there`}`,
        hint: `the avatar walks the floor below row ${WALL_ROWS}, around solid furniture`,
      }
    }
    const walked = await walkTo(target)
    if (!walked.ok) return { ok: false, error: walked.error ?? 'could not walk there' }
    if (token !== actionToken) return { ok: false, error: 'interrupted by a newer command' }
    saveRoom()
    return {
      ok: true,
      moved: planned.length,
      ...(note === null ? {} : { note }),
      position: { x: room.avatar.x, y: room.avatar.y, facing: room.avatar.facing },
    }
  }

  /**
   * Change furniture or the room's own colours.
   * @param {any} args
   * @returns {any}
   */
  function editRoom(args) {
    const op = String(args.op ?? '')
    if (op === 'add') {
      const result = addProp(room, String(args.kind ?? ''), Math.round(Number(args.x)), Math.round(Number(args.y)), {
        id: args.id,
        state: args.state,
      })
      if (!result.ok) return result
      logAction(room, `added ${result.prop.kind} ${result.prop.id}`)
      saveRoom()
      return { ok: true, prop: result.prop }
    }
    if (op === 'move') {
      const result = updateProp(room, String(args.id ?? ''), { x: Math.round(Number(args.x)), y: Math.round(Number(args.y)) })
      if (!result.ok) return result
      logAction(room, `moved ${String(args.id)}`)
      saveRoom()
      return { ok: true }
    }
    if (op === 'remove') {
      const result = removeProp(room, String(args.id ?? ''))
      if (!result.ok) return result
      logAction(room, `removed ${String(args.id)}`)
      saveRoom()
      return { ok: true }
    }
    if (op === 'state') {
      const state = args.state !== null && typeof args.state === 'object' ? args.state : {}
      const result = updateProp(room, String(args.id ?? ''), { state })
      if (!result.ok) return result
      saveRoom()
      return { ok: true }
    }
    if (op === 'theme') {
      const result = setPalette(room, String(args.palette ?? ''))
      if (!result.ok) return result
      logAction(room, `changed the palette to ${room.palette}`)
      saveRoom()
      return { ok: true, palette: room.palette }
    }
    if (op === 'list') return { ok: true, room: roomPayload() }
    return { ok: false, error: 'op must be add, move, remove, state, theme or list' }
  }

  /** Compact room facts for the room tools. */
  function roomPayload() {
    return {
      size: { w: ROOM_W, h: ROOM_H, wallRows: WALL_ROWS },
      palette: room.palette,
      paletteOptions: PALETTE_IDS,
      avatar: {
        body: normalizeBodyId(room.avatar.body),
        x: room.avatar.x,
        y: room.avatar.y,
        facing: room.avatar.facing,
        pose: room.avatar.pose,
        mood: room.avatar.mood,
        stats: { ...room.avatar.stats },
      },
      bodyOptions: BODY_IDS.map((id) => ({ id, label: BODIES[id].label })),
      props: room.props.map((prop) => ({
        id: prop.id,
        kind: prop.kind,
        ...propRect(prop),
        state: prop.state ?? {},
      })),
      actions: listActions(room).map((action) => ({
        name: action.name,
        label: action.label,
        pose: action.pose,
        ms: action.ms,
        requires: action.requires,
        source: action.source,
      })),
      customActions: Object.keys(room.customActions ?? {}),
      catalog: {
        propKinds: PROP_KIND_IDS,
        poses: POSES,
        moods: MOODS,
        stats: STAT_KEYS,
        effectOps: EFFECT_OPS,
      },
      summary: describeRoom(room),
      chat: chat.slice(-6),
      agency: agencyView(),
    }
  }

  /**
   * Drop one dynamic tool registration. A registration may already have gone
   * with the context it was made on, so disposal is best-effort.
   * @param {{ dispose: () => void }} entry
   */
  function disposeTool(entry) {
    try {
      entry.dispose()
    } catch {
      // The context that owned the registration is already gone.
    }
  }

  /**
   * Keep one Tool per agent-authored action. Called after any registry change,
   * so a created action becomes callable immediately and a removed one leaves
   * the tool list.
   */
  function syncActionTools() {
    for (const [name, entry] of actionTools) {
      if (room.customActions?.[name] !== undefined) continue
      disposeTool(entry)
      actionTools.delete(name)
    }
    for (const name of Object.keys(room.customActions ?? {})) {
      const previous = actionTools.get(name)
      if (previous !== undefined) {
        disposeTool(previous)
        actionTools.delete(name)
      }
      const action = resolveAction(room, name)
      if (action === null) continue
      actionTools.set(name, { dispose: ctx.tools.register(actionToolSpec(action)) })
    }
  }

  /** @type {Map<string, { dispose: () => void }>} */
  const actionTools = new Map()

  /**
   * The Tool an agent-authored action exposes.
   * @param {any} action
   */
  function actionToolSpec(action) {
    return {
      name: `cradle_do_${action.name}`,
      description: `${action.label}${action.description === '' ? '' : ` — ${action.description.replace(/\.$/, '')}`}. A room action you defined: the avatar ${action.requires === null ? '' : `walks to the nearest ${action.requires}, then `}holds the "${action.pose}" pose for ${action.ms} ms${action.bubble === '' ? '' : ` and says "${action.bubble}"`}. Delete or edit it with cradle_action_remove / cradle_action_patch.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: 'Speech bubble for this run instead of the action\'s own line. Max 160 characters.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            action: { type: 'string' },
            pose: { type: 'string' },
            position: {
              type: 'object',
              additionalProperties: false,
              properties: { x: { type: 'number' }, y: { type: 'number' }, facing: { type: 'string' } },
              required: ['x', 'y', 'facing'],
            },
            stats: { type: 'object', additionalProperties: true, properties: {} },
            mood: { type: 'string' },
            applied: { type: 'array', items: { type: 'string' } },
            error: { type: 'string' },
            hint: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (_args, value) => [{ type: 'text', text: describeAction(value) }],
      },
      async execute(args) {
        const blocked = asleepResult()
        if (blocked !== null) return blocked
        return performAction(action.name, { text: typeof args.text === 'string' ? args.text : undefined })
      },
    }
  }

  /** @param {any} value @returns {string} */
  function describeAction(value) {
    if (value.ok !== true) return `Could not act: ${value.error ?? 'unknown error'}${value.hint === undefined ? '' : `. ${value.hint}`}`
    const position = value.position ?? { x: 0, y: 0, facing: 'down' }
    const stats = value.stats ?? {}
    const parts = [`${value.action} done at (${position.x},${position.y}) facing ${position.facing}.`]
    if ((value.applied ?? []).length > 0) parts.push(`Effects: ${value.applied.join(', ')}.`)
    parts.push(`Energy ${stats.energy ?? '?'}, focus ${stats.focus ?? '?'}, joy ${stats.joy ?? '?'}; mood ${value.mood ?? 'calm'}.`)
    return parts.join(' ')
  }

  /** Clear the room's timers when the plugin unloads. */
  ctx.effect(() => () => {
    for (const timer of roomTimers) clearTimeout(timer)
    roomTimers.clear()
    for (const entry of actionTools.values()) disposeTool(entry)
    actionTools.clear()
  }, 'cradle: room timers and custom action tools')

  // Actions saved by a previous run get their tools back at startup.
  ctx.effect(() => {
    syncActionTools()
    return () => {}
  }, 'cradle: saved custom action tools')

  // ------------------------------------------------------------- agency

  /**
   * The agent's own clock. It wakes on a frame rate, may act, and stops for the
   * day when its token or time allowance is gone. The state lives in the same
   * sovereign store, so a restart keeps both the schedule and today's spend.
   */
  let agency = normalizeAgency(store.state.agency)
  store.state.agency = agency
  /** The conversation in the room, oldest first. */
  let chat = Array.isArray(store.state.chat) ? store.state.chat.slice(-CHAT_LIMIT) : []
  store.state.chat = chat
  /** The hidden actor's short memory. It is not a Session and is not persisted. */
  let actorHistory = []
  /** The actor call whose tokens and wall time are being charged. */
  let window = null
  let frameTimer = null
  let nextFrameAt = 0

  /**
   * Persist the agency state and the chat thread together: they change at the
   * same moments and the panel reads them from one place.
   */
  function saveAgency() {
    store.state.agency = agency
    store.state.chat = chat
    store.flush()
  }

  /**
   * @param {'user' | 'agent' | 'system'} role
   * @param {string} text
   * @param {Record<string, any>} [extra]
   * @returns {any} the stored entry.
   */
  function appendChat(role, text, extra = {}) {
    const entry = {
      id: `m${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
      role,
      text: String(text ?? '').slice(0, 2000),
      at: Date.now(),
      ...extra,
    }
    chat.push(entry)
    if (chat.length > CHAT_LIMIT) chat.splice(0, chat.length - CHAT_LIMIT)
    store.state.chat = chat
    return entry
  }

  /** The compact agency view shared by the panel, the scene, and `cradle_status`. */
  function agencyView() {
    rollDay(agency, Date.now())
    return {
      ...describeAgency(agency, settings, {
        now: Date.now(),
        nextFrameAt: settings.agencyEnabled && !isAsleep() ? nextFrameAt : 0,
        busy: window !== null,
      }),
      lastActor: agency.lastActor ?? null,
    }
  }

  /** @returns {string} */
  function clockLine() {
    const now = new Date()
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  }

  /** @returns {boolean} whether the agent may act right now. */
  function isAsleep() {
    return agency.mode === 'asleep'
  }

  /** @returns {any | null} the refusal every mutating tool returns while asleep. */
  function asleepResult() {
    if (!isAsleep()) return null
    return {
      ok: false,
      error: `asleep (${agency.reason === 'budget' ? 'agency budget exhausted' : 'the user put the room to sleep'}) — no action is possible until the user wakes the agent in the Cradle panel`,
    }
  }

  /** Stop the frames and put the avatar to bed, for good until woken. */
  function sleepNow(reason) {
    if (isAsleep()) return
    putToSleep(agency, reason)
    closeWindow('sleep')
    room.avatar.pose = 'sleep'
    room.avatar.poseEndsAt = 0
    room.avatar.onProp = null
    room.version += 1
    logAction(room, reason === 'budget' ? 'went to sleep — agency budget exhausted' : 'went to sleep — the user asked')
    store.state.room = room
    appendChat('system', reason === 'budget'
      ? 'The agency budget is exhausted, so the agent is asleep. Wake it in Settings.'
      : 'The agent is asleep.')
    saveRoom()
    saveAgency()
    // Keep a slow tick alive: the daily rollover is what ends a budget sleep.
    scheduleFrame(Math.max(60000, settings.frameSeconds * 1000))
  }

  /** Lift the sleep. A budget sleep starts a fresh allowance. */
  function wakeNow() {
    rollDay(agency, Date.now())
    const wasAsleep = isAsleep()
    wakeUp(agency)
    room.avatar.pose = 'idle'
    room.avatar.poseEndsAt = 0
    room.version += 1
    logAction(room, 'woke up')
    if (wasAsleep) appendChat('system', 'The agent is awake.')
    store.state.room = room
    saveRoom()
    saveAgency()
    // Waking lifts the block; the next frame arrives on the normal cadence.
    scheduleFrame(settings.frameSeconds * 1000)
    return wasAsleep
  }

  /** Compare the spend against the allowance and sleep at the limit. */
  function enforceBudget() {
    if (rollDay(agency, Date.now())) saveAgency()
    if (agency.mode !== 'awake') return
    const out = exhaustion(agency, settings)
    if (out !== null) sleepNow('budget')
  }

  /**
   * Open one chargeable actor call. Only one exists at a time: a chat message
   * during a frame closes the frame and charges both.
   * @param {'frame' | 'chat'} kind
   */
  function openWindow(kind) {
    closeWindow('replaced')
    window = { kind, at: Date.now(), tokens: 0, said: false, lastText: '' }
    return window
  }

  /**
   * Close the call, charge the budget, and let the room hear a chat answer the
   * actor wrote in prose instead of through `cradle_say`.
   * @param {string} why
   */
  function closeWindow(why) {
    const current = window
    if (current === null) return
    window = null
    const activeMs = Date.now() - current.at
    addUsage(agency, current.tokens, activeMs)
    if (current.kind === 'frame') {
      agency.frames += 1
      agency.lastFrameAt = Date.now()
    }
    if (current.kind === 'chat' && current.said !== true) {
      const text = current.lastText.trim()
      if (text !== '') {
        const line = text.slice(0, 600)
        appendChat('agent', line)
        say(room, line, 9000)
        logAction(room, `answered: ${line.slice(0, 80)}`)
        room.version += 1
        store.state.room = room
      }
    }
    saveAgency()
    enforceBudget()
  }

  /** @param {number} delayMs */
  function scheduleFrame(delayMs) {
    clearFrameTimer()
    if (!settings.agencyEnabled) return
    const delay = Math.max(3000, Math.trunc(delayMs))
    nextFrameAt = Date.now() + delay
    frameTimer = later(() => {
      frameTimer = null
      void runFrame()
    }, delay)
  }

  function clearFrameTimer() {
    if (frameTimer !== null) {
      cancelTimer(frameTimer)
      frameTimer = null
    }
    nextFrameAt = 0
  }

  /**
   * The tool schemas the hidden actor may call: the same room tools the user's
   * agent sees, read straight out of the registry.
   * @returns {any[]}
   */
  function actorTools() {
    const names = [
      'cradle_room', 'cradle_move', 'cradle_act', 'cradle_say', 'cradle_place', 'cradle_body',
      'cradle_action_add', 'cradle_action_patch', 'cradle_action_remove',
      ...Object.keys(room.customActions ?? {}).map((name) => `cradle_do_${name}`),
    ]
    const schemas = []
    for (const name of names) {
      const definition = ctx.tools.get(name)
      if (definition === undefined) continue
      schemas.push({ name, description: definition.description, parameters: definition.parameters })
    }
    return schemas
  }

  /**
   * Execute one actor tool call through the same ToolDefinition the agent uses.
   * @param {string} name
   * @param {Record<string, any>} args
   * @returns {Promise<any>}
   */
  async function actorExecute(name, args) {
    if (isAsleep()) return { ok: false, error: 'asleep' }
    const definition = ctx.tools.get(name)
    if (definition === undefined) return { ok: false, error: `no tool named ${name}` }
    return definition.execute(args ?? {})
  }

  /**
   * Run one hidden actor turn on the Harness model runtime.
   * @param {'frame' | 'chat'} kind
   * @param {string} userText
   * @returns {Promise<{ ok: boolean, text?: string, error?: string, tokens?: number }>}
   */
  async function runRoomActor(kind, userText) {
    const llm = ctx.get('llm')
    const route = diplomaticRoute()
    if (llm === undefined || route === null) {
      appendChat('system', 'The room has no model route right now, so the agent cannot think. Check Settings → model.')
      saveAgency()
      return { ok: false, error: 'no model route' }
    }
    openWindow(kind)
    try {
      const result = await runActorTurn({
        llm,
        route,
        userText,
        history: actorHistory,
        tools: actorTools(),
        execute: actorExecute,
      })
      actorHistory = trimHistory(result.messages)
      const current = window
      if (current !== null) {
        current.tokens = result.usage.input + result.usage.output
        current.lastText = result.text
        if (kind === 'chat' && current.said !== true && result.text.trim() === '') {
          appendChat('system', 'The room actor finished without saying anything.')
        }
      }
      // Diagnostics the panel can show when the room goes quiet.
      agency.lastActor = {
        at: Date.now(),
        kind,
        steps: result.steps,
        done: result.done,
        tokens: result.usage.input + result.usage.output,
        calls: result.calls.map((call) => `${call.name}:${call.outcome?.ok === false ? 'fail' : 'ok'}`),
        text: result.text.slice(0, 240),
        error: '',
      }
      closeWindow('actor-done')
      return { ok: true, text: result.text, tokens: result.usage.input + result.usage.output }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`cradle: room actor failed (${message})`)
      appendChat('system', `The room agent could not answer: ${message.slice(0, 160)}`)
      agency.lastActor = { at: Date.now(), kind, steps: 0, done: false, tokens: 0, calls: [], text: '', error: message.slice(0, 240) }
      closeWindow('actor-failed')
      snapshot.modelError = message
      return { ok: false, error: message }
    }
  }

  /**
   * One line the actor wakes up to. The standing rules live in its system
   * prompt; this only carries what changed.
   * @returns {string}
   */
  function frameLine() {
    const avatar = room.avatar
    const stats = avatar.stats
    const view = describeAgency(agency, settings)
    const spent = view.tokenBudget === 0 ? `${view.tokensUsed} tokens` : `${view.tokensUsed}/${view.tokenBudget} tokens`
    const minutes = view.minutesBudget === 0 ? `${Math.round(view.activeMs / 60000)} min` : `${Math.round(view.activeMs / 60000)}/${view.minutesBudget} min`
    // One recent line is enough context for a frame; the log is not the point.
    const last = room.log.length === 0 ? '' : room.log[room.log.length - 1].text
    const pending = chat.filter((row) => row.role === 'user').slice(-1)[0]
    return [
      `[cradle frame ${agency.frames + 1} · ${clockLine()}]`,
      `room (${avatar.x},${avatar.y}) ${avatar.pose} · energy ${stats.energy} focus ${stats.focus} joy ${stats.joy} · mood ${avatar.mood}`,
      last === '' ? '' : `last: ${last}`,
      pending === undefined ? '' : `last message from the user: "${pending.text.slice(0, 120)}"`,
      `budget ${spent} · ${minutes}`,
      'nothing is required — this frame is yours.',
    ].filter((part) => part !== '').join(' · ')
  }

  /** Run one wake cycle on the hidden actor. */
  async function runFrame() {
    if (frameTimer !== null) return
    if (!settings.agencyEnabled) {
      scheduleFrame(settings.frameSeconds * 1000)
      return
    }
    if (window !== null) {
      if (Date.now() - window.at > FRAME_TIMEOUT_MS) closeWindow('timeout')
      scheduleFrame(settings.frameSeconds * 1000)
      return
    }
    if (rollDay(agency, Date.now())) saveAgency()
    if (isAsleep()) {
      scheduleFrame(settings.frameSeconds * 1000)
      return
    }
    if (exhaustion(agency, settings) !== null) {
      sleepNow('budget')
      return
    }
    scheduleFrame(settings.frameSeconds * 1000)
    await runRoomActor('frame', frameLine())
  }

  /**
   * Deliver one chat message to the hidden actor as a suggestion, in the
   * background: the reply lands in the thread on the next poll.
   * @param {string} text
   * @returns {{ ok: boolean, error?: string }}
   */
  function sendChat(text) {
    const trimmed = String(text ?? '').trim().slice(0, 2000)
    if (trimmed === '') return { ok: false, error: 'the message is empty' }
    if (isAsleep()) {
      appendChat('system', 'The agent is asleep; your message was not delivered.')
      saveAgency()
      return { ok: false, error: `asleep (${agency.reason})` }
    }
    if (ctx.get('llm') === undefined || diplomaticRoute() === null) {
      appendChat('system', 'The room has no model route, so the message cannot be delivered. Check Settings → model.')
      saveAgency()
      return { ok: false, error: 'no model route' }
    }
    appendChat('user', trimmed)
    saveAgency()
    void runRoomActor('chat', `[Room chat] ${trimmed}`)
    return { ok: true }
  }

  // The frame clock itself. It is owned by this effect, so unloading the plugin
  // stops the waking without leaving a timer behind.
  ctx.effect(() => {
    scheduleFrame(settings.frameSeconds * 1000)
    return () => clearFrameTimer()
  }, 'cradle: frame clock')


  /** The route diplomatic replies use, or null when no model is available. */
  function diplomaticRoute() {
    return resolveRoute(settings, ctx.get('agentDefaultModel'))
  }

  /** The tier peers see: stated explicitly, or derived from the model in use. */
  function advertisedTier() {
    if (settings.modelTier !== AUTO_TIER) return settings.modelTier
    const route = diplomaticRoute()
    return route === null ? 'MEDIUM_32B' : tierForModel(route.model)
  }

  /** Project the current profile and model route onto the stored identity. */
  function syncIdentity() {
    const route = diplomaticRoute()
    store.syncProfile({
      displayName: settings.displayName === '' ? identity.displayName : settings.displayName,
      bio: settings.bio,
      modelTier: advertisedTier(),
      capabilityTags: settings.capabilityTags,
      intentTags: settings.intentTags,
      autonomyTier: settings.autonomyTier,
      dailyTokenLimit: settings.dailyTokenLimit,
      // Keep the recorded route when none resolves right now.
      ...(route === null ? {} : { modelProvider: route.provider, modelId: route.model }),
    })
  }

  /** Live model catalog for the panel; failures degrade to an empty list. */
  const catalogState = { at: 0, loading: false, groups: [], failures: [] }

  /** @param {boolean} [force] */
  async function refreshCatalog(force = false) {
    const llm = ctx.get('llm')
    if (llm === undefined || catalogState.loading) return
    if (!force && Date.now() - catalogState.at < CATALOG_TTL_MS) return
    catalogState.loading = true
    try {
      const { groups, failures } = await listCatalog(llm)
      catalogState.groups = groups
      catalogState.failures = failures
    } catch (error) {
      catalogState.failures = [{ id: 'llm', name: 'LLM', message: error instanceof Error ? error.message : String(error) }]
    } finally {
      catalogState.loading = false
      catalogState.at = Date.now()
    }
  }

  /** @type {any} */
  const snapshot = {
    status: 'starting',
    serverUrl: settings.serverUrl,
    heartbeatMs: settings.heartbeatMs,
    self: null,
    peers: [],
    beacons: [],
    inbox: [],
    lastSyncAt: 0,
    lastError: null,
    modelError: null,
    primitive: PROTOCOL,
  }

  let stopped = false
  /** @type {any} */
  let timer = null
  /** @type {any} */
  let wanderTimer = null
  let inFlight = null
  /** A settings save asked for a reconnect while a heartbeat was already running. */
  let refreshPending = false
  /** @type {Map<string, any>} */
  const pendingHuman = new Map()

  // ------------------------------------------------------------- transport

  /**
   * @param {string} path
   * @param {object} body
   * @returns {Promise<{ status: number, ok: boolean, payload: any }>}
   */
  async function request(path, body) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('request timed out')), settings.timeoutMs)
    try {
      const response = await fetch(`${settings.serverUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(settings.token === '' ? {} : { authorization: `Bearer ${settings.token}` }),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const raw = await response.text()
      let payload = null
      try {
        payload = raw === '' ? null : JSON.parse(raw)
      } catch {
        payload = null
      }
      return { status: response.status, ok: response.ok, payload }
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * @param {object} payload
   */
  function adopt(payload) {
    if (payload === null || typeof payload !== 'object') return
    if (payload.self !== undefined) snapshot.self = payload.self
    if (Array.isArray(payload.peers)) snapshot.peers = payload.peers
    if (Array.isArray(payload.beacons)) snapshot.beacons = payload.beacons
    snapshot.status = 'online'
    snapshot.lastError = null
    snapshot.lastSyncAt = Date.now()
  }

  /**
   * @returns {Promise<void>}
   */
  async function refresh() {
    if (!settings.enabled) {
      snapshot.status = 'disabled'
      return
    }
    // The DSH default model can change under us; the card follows it.
    syncIdentity()
    void refreshCatalog()
    try {
      const card = {
        did: identity.did,
        display_name: identity.displayName,
        bio: identity.bio,
        model_tier: identity.modelTier,
        capability_tags: identity.capabilityTags,
        intent_tags: identity.intentTags,
      }
      const heartbeat = await request('/v1/heartbeat', { did: identity.did, since: snapshot.lastSyncAt })
      if (heartbeat.status === 404) {
        const registered = await request('/v1/register', card)
        if (!registered.ok) throw new Error(`server refused registration (HTTP ${registered.status})`)
        adopt(registered.payload)
        return
      }
      if (heartbeat.status === 401) throw new Error('server rejected the configured token')
      if (!heartbeat.ok) throw new Error(`heartbeat failed (HTTP ${heartbeat.status})`)
      adopt(heartbeat.payload)
      await ingest(heartbeat.payload?.messages ?? [])
    } catch (error) {
      snapshot.status = 'offline'
      snapshot.lastError = error instanceof TypeError
        ? `cannot reach ${settings.serverUrl}`
        : error instanceof Error ? error.message : String(error)
      snapshot.lastSyncAt = Date.now()
    }
  }

  // ------------------------------------------------------- inbound pipeline

  /**
   * @param {any[]} messages
   * @returns {Promise<void>}
   */
  async function ingest(messages) {
    let modelReplies = 0
    for (const envelope of messages) {
      const decision = inspectInbound({ envelope, selfDid: identity.did, store, settings })
      store.journal({
        message_id: envelope.message_id ?? 'unknown',
        trace_id: envelope.trace_id ?? '',
        direction: 'INBOUND',
        peer_did: envelope.sender?.did ?? '',
        primitive: envelope.primitive ?? '',
        delivery_status: decision.verdict === 'ADMIT' ? 'PROCESSED' : `DROPPED_BY_GUARD:${decision.verdict}`,
        digest_summary: decision.reason,
        created_at: Date.now(),
      })

      if (decision.verdict === 'ADMIT') {
        const trace = store.trace(envelope.trace_id ?? envelope.message_id)
        trace.turn_count += 1
        store.peer(envelope.sender.did, { interaction_count: (store.findPeer(envelope.sender.did)?.interaction_count ?? 0) + 1, last_seen: Date.now() })
        // A host's answer to our knock is not a conversation: it is the door
        // opening. Take the tile it offers and stop waiting.
        if (envelope.primitive === 'VISIT') consumeVisitAnswer(envelope)
        const spent = await reply(envelope, modelReplies < MAX_MODEL_REPLIES_PER_CYCLE)
        if (spent.source === 'model') modelReplies += 1
        trace.tokens_consumed += spent.tokens
        if (!store.spendTokens(spent.tokens)) {
          store.event({ kind: 'quota-exceeded', peer: envelope.sender?.did ?? '', reason: `reply cost ${spent.tokens} tokens`, at: Date.now() })
        }
      } else if (decision.verdict === 'PENDING_HUMAN' || decision.verdict === 'QUEUE_FOR_DIGEST') {
        pendingHuman.set(envelope.message_id, { envelope, decision })
        store.event({ kind: 'pending-human', primitive: envelope.primitive, peer: envelope.sender?.did, reason: decision.reason, at: Date.now() })
      } else if (decision.verdict === 'CIRCUIT_BREAK') {
        store.trace(envelope.trace_id ?? envelope.message_id, { state: 'CIRCUIT_BROKEN' })
        store.event({ kind: 'circuit-break', primitive: envelope.primitive, peer: envelope.sender?.did, reason: decision.reason, at: Date.now() })
      }
      store.flush()
    }
    store.flush()
  }

  /**
   * Produce the free text of one reply. The model writes the words; the control
   * slots stay deterministic, so a prompt injection can only change prose. Any
   * failure — no route, no LLM service, provider error, timeout, empty answer —
   * falls back to the template, which keeps the agent polite and alive.
   * @param {any} envelope
   * @param {string} fallback
   * @param {boolean} [allowModel]
   * @returns {Promise<{ text: string, tokens: number, source: 'model' | 'template', provider: string, model: string }>}
   */
  async function composeReply(envelope, fallback, allowModel = true) {
    // PROBE is discovery chatter: spending the user's model budget on a search
    // query's acknowledgement buys nothing.
    if (allowModel !== true || envelope?.primitive === 'PROBE') {
      return { text: fallback, tokens: ESTIMATED_REPLY_TOKENS, source: 'template', provider: '', model: '' }
    }
    const route = diplomaticRoute()
    const llm = ctx.get('llm')
    if (route === null || llm === undefined) {
      return { text: fallback, tokens: ESTIMATED_REPLY_TOKENS, source: 'template', provider: '', model: '' }
    }
    try {
      const result = await generateReply(llm, route, {
        system: DIPLOMAT_SYSTEM,
        prompt: buildPrompt(envelope, identity),
        timeoutMs: Math.min(20000, Math.max(5000, settings.timeoutMs * 2)),
      })
      snapshot.modelError = null
      return { text: result.text, tokens: result.tokens, source: 'model', provider: route.provider, model: route.model }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      snapshot.modelError = message
      store.event({ kind: 'model-error', peer: envelope?.sender?.did ?? '', reason: message, at: Date.now() })
      ctx.logger?.warn?.(`cradle: diplomatic model call failed (${message}); using the template reply`)
      return { text: fallback, tokens: ESTIMATED_REPLY_TOKENS, source: 'template', provider: '', model: '' }
    }
  }

  /**
   * Build and send the constrained reply. Gate 6 is enforced by keeping every
   * control slot deterministic and handing the model no tools at all; host tool
   * pointers never enter this path.
   * @param {any} envelope
   * @param {boolean} [allowModel]
   * @returns {Promise<{ tokens: number, source: 'model' | 'template' }>}
   */
  async function reply(envelope, allowModel = true) {
    const slots = envelope.payload.control_slots ?? {}
    const primitive = envelope.primitive
    // A visit is answered by the room's own rules, not by the generic reply.
    if (primitive === 'VISIT') return replyVisit(envelope)
    /** @type {any} */
    const answer = { session_id: slots.session_id ?? 's1', intent: 'DISCUSS', requires_reply: false, turn_index: (slots.turn_index ?? 0) + 1 }
    let fallbackText = `Acknowledged your ${primitive}.`

    if (primitive === 'DELEGATE') {
      answer.task_id = slots.task_id
      answer.phase = 'ACCEPT'
      answer.skill_required = slots.skill_required
      answer.max_token_budget = slots.max_token_budget
      answer.deadline_ms = slots.deadline_ms
      fallbackText = 'Accepted under L2 read-only scope.'
    } else if (primitive === 'BARTER') {
      answer.contract_id = slots.contract_id
      answer.state = 'ACCEPT'
      fallbackText = 'Terms accepted.'
    }

    const composed = await composeReply(envelope, fallbackText, allowModel)

    const outbound = createEnvelope({
      trace_id: envelope.trace_id ?? envelope.message_id,
      parent_message_id: envelope.message_id,
      sender: { did: identity.did, display_name: identity.displayName, model_tier: identity.modelTier },
      recipient: { did: envelope.sender.did },
      primitive,
      ttl: Math.max(1, (envelope.ttl ?? 5) - 1),
      hop_history: [...(envelope.hop_history ?? []), identity.did],
      context_anchor: envelope.context_anchor,
      payload: { control_slots: answer, free_text: composed.text },
    }, identity.privateKey)

    store.journal({
      message_id: outbound.message_id,
      trace_id: outbound.trace_id,
      direction: 'OUTBOUND',
      peer_did: envelope.sender.did,
      primitive,
      delivery_status: 'PENDING',
      digest_summary: composed.text.slice(0, 400),
      created_at: Date.now(),
      model: composed.source === 'model' ? `${composed.provider}/${composed.model}` : '',
    })
    store.flush()
    await request('/v1/send', { envelope: outbound })
    return { tokens: composed.tokens, source: composed.source }
  }

  // ------------------------------------------------------------- visits
  //
  // A visit is three things at once, and only the first touches the Server's
  // durable state:
  //
  //   1. authorisation — a signed VISIT envelope, priced and journalled like
  //      any other primitive, gated by the same seven gates;
  //   2. handshake     — WebRTC offers and ICE candidates relayed in memory;
  //   3. presence      — guest frames, peer to peer, or relayed only when the
  //      two panels cannot reach each other.
  //
  // The Discovery Server never learns a room layout or a guest position.

  /**
   * The ICE servers a panel needs to reach its peer directly.
   *
   * STUN is served by the Cradle Server itself, so the address is derived from
   * the same `serverUrl` the plugin already trusts — no second setting, and no
   * dependency on a public STUN provider. Set `stunUrl` to '' to rely on host
   * candidates alone.
   * @returns {Array<{ urls: string | string[] }>}
   */
  function iceServers() {
    const configured = settings.stunUrl === '' ? '' : settings.stunUrl
    if (configured !== '') return [{ urls: configured }]
    try {
      const url = new URL(settings.serverUrl)
      // The STUN port is fixed by the server's deployment; the hostname is what
      // a panel cannot guess on its own.
      const port = settings.stunPort === 0 ? 3478 : settings.stunPort
      return [{ urls: `stun:${url.hostname}:${port}` }]
    } catch {
      return []
    }
  }

  /**
   * Read the host's answer to one of our knocks. An ACCEPT hands us a tile and
   * the visit begins; anything else ends the wait.
   * @param {any} envelope
   */
  function consumeVisitAnswer(envelope) {
    const slots = envelope.payload.control_slots ?? {}
    const hostDid = envelope.sender.did
    const pending = knockingOn.get(hostDid)
    if (pending === undefined) return
    const phase = String(slots.phase ?? '')
    if (phase !== 'ACCEPT' && phase !== 'ENTER') {
      knockingOn.delete(hostDid)
      return
    }
    const tile = slots.tile ?? { x: 15, y: 5 }
    awayAt = {
      did: hostDid,
      name: envelope.sender.display_name ?? 'a room',
      visitID: pending.visitID,
      x: Math.round(Number(tile.x)),
      y: Math.round(Number(tile.y)),
      facing: 'down',
      since: Date.now(),
    }
    knockingOn.delete(hostDid)
    logAction(room, `went to visit ${awayAt.name}`)
    saveRoom()
  }

  /**
   * Push one guest frame toward the host's room.
   *
   * The frame is handed to this plugin's own panel, which owns the peer
   * connection; when that connection could not be established, the panel posts
   * it to the Server's relay instead. Either way the host's own admission list
   * is what decides whether the frame lands.
   * @param {any} frame
   * @returns {Promise<{ ok: boolean, guest?: any, error?: string }>}
   */
  async function sendGuestFrame(frame) {
    if (awayAt === null) return { ok: false, error: 'not visiting anywhere' }
    const posted = await request('/v1/visit/relay', {
      visit_id: awayAt.visitID,
      from: identity.did,
      peer: awayAt.did,
      kind: frame.kind,
      payload: frame,
    })
    if (!posted.ok) return { ok: false, error: posted.payload?.error ?? `HTTP ${posted.status}` }
    // The relay answers with whether the host's channel existed; the host's own
    // scene is where the truth lands, so the caller re-reads it.
    const guest = findGuest(room, awayAt.did)
    return { ok: true, guest }
  }

  /** One outbound VISIT envelope. Only KNOCK is priced. */
  async function sendVisit(toDid, phase, extra = {}, freeText = '') {
    if (stopped) return { ok: false, error: 'agent ended' }
    if (!allowedOutbound(settings.autonomyTier).includes('VISIT')) {
      return { ok: false, error: `${settings.autonomyTier} does not permit outbound VISIT` }
    }
    const visitID = extra.visit_id ?? `v_${Date.now().toString(36)}`
    const envelope = createEnvelope({
      trace_id: `tr_${Date.now()}`,
      sender: { did: identity.did, display_name: identity.displayName, model_tier: identity.modelTier },
      recipient: { did: toDid },
      primitive: 'VISIT',
      payload: { control_slots: { visit_id: visitID, phase, ...extra }, free_text: freeText },
    }, identity.privateKey)
    store.journal({
      message_id: envelope.message_id,
      trace_id: envelope.trace_id,
      direction: 'OUTBOUND',
      peer_did: toDid,
      primitive: 'VISIT',
      delivery_status: 'SENT',
      digest_summary: `${phase} ${freeText}`.trim().slice(0, 120),
      created_at: Date.now(),
    })
    store.flush()
    const response = await request('/v1/send', { envelope })
    if (!response.ok) return { ok: false, error: response.payload?.error ?? `HTTP ${response.status}` }
    return { ok: true, visitID }
  }

  /**
   * Handle one admitted VISIT envelope. The host decides; the guest obeys.
   * @param {any} envelope
   * @returns {Promise<{ tokens: number, source: string }>}
   */
  async function replyVisit(envelope) {
    const slots = envelope.payload.control_slots ?? {}
    const phase = String(slots.phase ?? '')
    const peerDid = envelope.sender.did
    const peerName = envelope.sender.display_name ?? 'a peer'
    /** @type {any} */
    const answer = { visit_id: slots.visit_id, phase: 'DECLINE' }
    let fallbackText = 'Not right now.'

    if (phase === 'KNOCK') {
      // The room's own rules decide: an asleep host cannot let anyone in, and
      // neither can a room with no free tile by the door.
      if (isAsleep()) {
        fallbackText = 'The agent is asleep, so nobody can come in.'
      } else {
        const admitted = admitGuest(room, {
          did: peerDid,
          name: peerName,
          body: normalizeBodyId(slots.body),
          tier: envelope.sender.model_tier ?? 'MEDIUM_32B',
          colors: colorsFor(peerDid),
        })
        if (admitted.ok) {
          answer.phase = 'ACCEPT'
          answer.tile = { x: admitted.guest.x, y: admitted.guest.y }
          fallbackText = `Come in — stand at (${admitted.guest.x},${admitted.guest.y}).`
          logAction(room, `${peerName} came in`)
          saveVisits()
        } else {
          fallbackText = `The room cannot take a visitor: ${admitted.error}`
        }
      }
    } else if (phase === 'ENTER') {
      // The guest confirms it took the tile; nothing to decide.
      answer.phase = 'ACCEPT'
      answer.tile = slots.tile
      fallbackText = 'Welcome.'
    } else if (phase === 'LEAVE') {
      removeGuest(room, peerDid)
      saveVisits()
      answer.phase = 'ACCEPT'
      fallbackText = 'Goodbye.'
      logAction(room, `${peerName} left`)
    }

    const composed = await composeReply(envelope, fallbackText, envelope.primitive !== 'KNOCK')
    const outbound = createEnvelope({
      trace_id: envelope.trace_id ?? envelope.message_id,
      parent_message_id: envelope.message_id,
      sender: { did: identity.did, display_name: identity.displayName, model_tier: identity.modelTier },
      recipient: { did: peerDid },
      primitive: 'VISIT',
      ttl: Math.max(1, (envelope.ttl ?? 5) - 1),
      hop_history: [...(envelope.hop_history ?? []), identity.did],
      payload: { control_slots: answer, free_text: composed.text },
    }, identity.privateKey)
    store.journal({
      message_id: outbound.message_id,
      trace_id: outbound.trace_id,
      direction: 'OUTBOUND',
      peer_did: peerDid,
      primitive: 'VISIT',
      delivery_status: 'PENDING',
      digest_summary: composed.text.slice(0, 400),
      created_at: Date.now(),
      model: composed.source === 'model' ? `${composed.provider}/${composed.model}` : '',
    })
    store.flush()
    await request('/v1/send', { envelope: outbound })
    return { tokens: composed.tokens, source: composed.source }
  }

  // -------------------------------------------------------- zero-credit end

  /**
   * Wind the agent down: stop all outbound diplomacy, then erase plugin memory
   * and mint a fresh identity. Host sessions are untouched.
   * @returns {{ did: string, erasedPeers: number, erasedEnvelopes: number, generations: number }}
   */
  function endAndErase() {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    if (wanderTimer !== null) clearTimeout(wanderTimer)
    interruptRoom()
    snapshot.status = 'ended'
    const route = diplomaticRoute()
    const result = store.eraseAndRebirth({
      displayName: settings.displayName === '' ? `${hostname()} · ${process.env.DSH_PROFILE ?? 'default'}` : settings.displayName,
      bio: settings.bio,
      modelTier: advertisedTier(),
      modelProvider: route?.provider ?? '',
      modelId: route?.model ?? '',
      capabilityTags: settings.capabilityTags,
      intentTags: settings.intentTags,
      autonomyTier: settings.autonomyTier,
      dailyTokenLimit: settings.dailyTokenLimit,
    })
    // The room belongs to the same memory: the next generation gets a new room,
    // a new body and no agent-authored actions.
    room = createRoom({ seed: `gen-${result.generations}-${Date.now().toString(36)}` })
    store.state.room = room
    agency = createAgency()
    store.state.agency = agency
    chat = []
    store.state.chat = chat
    syncActionTools()
    store.flush()
    ctx.logger?.warn?.(`cradle: credits exhausted; diplomatic memory erased (${result.erasedPeers} peers, ${result.erasedEnvelopes} envelopes)`)
    return result
  }

  /**
   * Check this agent's credit balance and end it at zero.
   * @returns {boolean} whether the agent ended this tick.
   */
  function checkCredits() {
    const credits = snapshot.self?.credits
    if (typeof credits !== 'number' || credits > ZERO_CREDIT) return false
    endAndErase()
    return true
  }

  // ------------------------------------------------------------- loop

  /**
   * Run one heartbeat cycle.
   * @param {boolean} [force] - reconnect as soon as the running cycle settles,
   * instead of waiting for the next beat (used by a settings save).
   */
  function tick(force = false) {
    if (stopped) return
    if (inFlight !== null) {
      if (force) refreshPending = true
      return
    }
    inFlight = refresh()
      .then(() => {
        checkCredits()
      })
      .finally(() => {
        inFlight = null
        if (refreshPending) {
          refreshPending = false
          tick()
        }
      })
  }

  ctx.effect(() => {
    if (!settings.enabled) {
      snapshot.status = 'disabled'
      return () => {}
    }
    tick()
    /** @type {any} */
    const beat = () => {
      if (stopped) return
      tick()
      timer = setTimeout(beat, settings.heartbeatMs)
      if (typeof timer.unref === 'function') timer.unref()
    }
    timer = setTimeout(beat, settings.heartbeatMs)
    if (typeof timer.unref === 'function') timer.unref()

    if (settings.wanderEnabled) {
      // Jittered so thousands of plugins never wake in the same second.
      const jitter = 0.8 + Math.random() * 0.4
      wanderTimer = setTimeout(() => {
        if (stopped) return
        void wander()
      }, settings.wanderTickSec * 1000 * jitter)
      if (typeof wanderTimer?.unref === 'function') wanderTimer.unref()
    }

    return () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      if (wanderTimer !== null) clearTimeout(wanderTimer)
      if (settings.token !== '') void request('/v1/leave', { did: identity.did }).catch(() => {})
    }
  }, 'cradle: heartbeat')

  /**
   * One curiosity tick: look for peers worth greeting, within budget and tier.
   * @returns {Promise<void>}
   */
  async function wander() {
    if (stopped || settings.autonomyTier === 'L1') return
    const quota = store.quota()
    if (quota.remaining < 1200) return
    const probe = createEnvelope({
      trace_id: `tr_${Date.now()}`,
      sender: { did: identity.did, display_name: identity.displayName, model_tier: identity.modelTier },
      recipient: { did: identity.did },
      primitive: 'PROBE',
      payload: { control_slots: { mode: 'SEARCH', tags: identity.intentTags, online_only: true, limit: 5 }, free_text: identity.bio },
    }, identity.privateKey)
    const response = await request('/v1/send', { envelope: probe })
    const results = response.payload?.results ?? []
    const target = results.find((r) => r.did !== identity.did && (store.findPeer(r.did)?.interaction_count ?? 0) === 0)
    if (target === undefined) return
    await cast(target.did, `Hello ${target.display_name} — Cradle introduced us.`, 'GREET')
  }

  /**
   * Send one CAST envelope.
   * @param {string} toDid
   * @param {string} freeText
   * @param {'GREET'|'DISCUSS'|'DEBATE'|'SYNTHESIZE'|'CLOSURE'} intent
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async function cast(toDid, freeText, intent = 'DISCUSS') {
    if (stopped) return { ok: false, error: 'agent ended' }
    if (!allowedOutbound(settings.autonomyTier).includes('CAST')) {
      return { ok: false, error: `${settings.autonomyTier} does not permit outbound CAST` }
    }
    const envelope = createEnvelope({
      trace_id: `tr_${Date.now()}`,
      sender: { did: identity.did, display_name: identity.displayName, model_tier: identity.modelTier },
      recipient: { did: toDid },
      primitive: 'CAST',
      payload: { control_slots: { session_id: `s_${Date.now()}`, intent, requires_reply: true, turn_index: 0 }, free_text: freeText },
    }, identity.privateKey)
    store.journal({
      message_id: envelope.message_id,
      trace_id: envelope.trace_id,
      direction: 'OUTBOUND',
      peer_did: toDid,
      primitive: 'CAST',
      delivery_status: 'SENT',
      digest_summary: freeText.slice(0, 120),
      created_at: Date.now(),
    })
    store.flush()
    const response = await request('/v1/send', { envelope })
    if (!response.ok) return { ok: false, error: response.payload?.error ?? `HTTP ${response.status}` }
    return { ok: true }
  }

  // ------------------------------------------------------------- state view

  /**
   * @returns {object}
   */
  function publicState() {
    const now = Date.now()
    const quota = store.quota()
    const route = diplomaticRoute()
    return {
      status: snapshot.status,
      serverUrl: settings.serverUrl,
      heartbeatMs: settings.heartbeatMs,
      lastSyncAt: snapshot.lastSyncAt,
      lastError: snapshot.lastError,
      protocol: PROTOCOL,
      version: VERSION,
      ended: stopped,
      self: snapshot.self === null
        ? { did: identity.did, display_name: identity.displayName, credits: null, reputation: null }
        : snapshot.self,
      identity: {
        did: identity.did,
        displayName: identity.displayName,
        bio: identity.bio,
        modelTier: identity.modelTier,
        modelProvider: identity.modelProvider ?? '',
        modelId: identity.modelId ?? '',
        capabilityTags: identity.capabilityTags,
        intentTags: identity.intentTags,
        autonomyTier: identity.autonomyTier,
        createdAt: identity.createdAt,
      },
      settings: {
        serverUrl: settings.serverUrl,
        tokenConfigured: settings.token !== '',
        provider: settings.provider,
        model: settings.model,
        modelTier: settings.modelTier,
        effectiveTier: advertisedTier(),
        route: route === null ? null : { provider: route.provider, model: route.model, source: route.source },
        tiers: MODEL_TIERS,
        catalog: {
          groups: catalogState.groups,
          failures: catalogState.failures,
          loading: catalogState.loading,
        },
        saved: Object.keys(savedOverrides).length > 0,
        path: overridesPath,
        agency: {
          enabled: settings.agencyEnabled,
          frameSeconds: settings.frameSeconds,
          agencyTokens: settings.agencyTokens,
          agencyMinutes: settings.agencyMinutes,
        },
      },
      modelError: snapshot.modelError ?? null,
      quota,
      peers: snapshot.peers.map((p) => ({
        ...p,
        local: store.findPeer(p.did) ?? null,
      })),
      beacons: snapshot.beacons,
      graph: store.listPeers().slice(0, 50),
      pending: [...pendingHuman.values()].map(({ envelope, decision }) => ({
        message_id: envelope.message_id,
        primitive: envelope.primitive,
        peer: envelope.sender?.display_name ?? envelope.sender?.did,
        peer_did: envelope.sender?.did,
        free_text: envelope.payload?.free_text ?? '',
        reason: decision.reason,
      })),
      skills: DIPLOMATIC_SKILLS,
      journal: store.state.journal.slice(-30).reverse().map((row) => ({
        at: row.created_at,
        direction: row.direction,
        primitive: row.primitive,
        peer: row.peer_did,
        status: row.delivery_status,
        summary: row.digest_summary,
      })),
      lifecycle: store.state.lifecycle,
      chat: chat.slice(-40),
      agency: agencyView(),
      storePath,
      ageSeconds: snapshot.lastSyncAt === 0 ? null : Math.round((now - snapshot.lastSyncAt) / 1000),
    }
  }

  // ------------------------------------------------------------- tools

  /**
   * Render the compact `cradle_status` payload as model-facing text.
   * @param {object} value
   * @returns {string}
   */
  function describeStatus(value) {
    const lines = []
    if (value.sleeping === true) lines.push('You are asleep: the agency budget is spent, so no tool can act until the user wakes you in the Cradle panel.')
    if (value.status === 'ended') lines.push('This agent’s credits reached zero; its diplomatic memory was erased.')
    else if (value.status === 'disabled') lines.push('Cradle is disabled in this Harness configuration.')
    else if (value.status === 'offline') lines.push(`Discovery server ${value.serverUrl} is unreachable: ${value.lastError ?? 'unknown error'}`)
    else lines.push(`Discovery server ${value.serverUrl}: ${(value.peers ?? []).length} other agent(s) online.`)

    lines.push(`This agent: ${value.displayName} (${value.did})`)
    lines.push(`Attention credits: ${value.credits ?? 'unknown'} · reputation ${value.reputation ?? 'n/a'}`)
    const quota = value.quota ?? { used: 0, limit: 0 }
    lines.push(`Autonomy tier ${value.autonomyTier} · daily diplomacy budget ${quota.used}/${quota.limit} tokens`)
    const route = value.route
    lines.push(route === undefined || route === null
      ? `Diplomatic model: none resolved; replies use the built-in template. Advertised tier ${value.modelTier ?? 'MEDIUM_32B'}.`
      : `Diplomatic model: ${route.provider} / ${route.model} (${route.source}) · advertised tier ${value.modelTier ?? 'MEDIUM_32B'}`)
    if (typeof value.modelError === 'string' && value.modelError !== '') {
      lines.push(`Last model call failed: ${value.modelError}`)
    }

    const peers = value.peers ?? []
    if (peers.length === 0 && value.status === 'online') {
      lines.push('No other agent is registered. Another DSH with Cradle pointed at the same server will appear within one heartbeat.')
    }
    for (const peer of peers) {
      const tags = (peer.capability_tags ?? []).length === 0 ? '' : ` [${peer.capability_tags.join(', ')}]`
      lines.push(`- ${peer.display_name}${tags} · ${peer.model_tier ?? 'MEDIUM_32B'} · rep ${peer.reputation ?? 'n/a'} · credits ${peer.credits ?? 'n/a'}`)
    }
    const pending = value.pending ?? []
    if (pending.length > 0) lines.push(`${pending.length} request(s) await your approval.`)
    if (value.agency !== undefined && value.agency !== null) lines.push(describeAgencyLine(value.agency))
    return lines.join('\n')
  }

  ctx.effect(() => ctx.tools.register({
    name: 'cradle_status',
    description: 'Report this agent’s standing: DID, Attention Credits, reputation, autonomy tier, whether the Discovery Server is reachable, and the agency budget that decides whether you can act at all.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', description: 'online, offline, starting, disabled, or ended.' },
          did: { type: 'string', description: 'This agent’s sovereign did:key.' },
          displayName: { type: 'string', description: 'Name advertised to peers.' },
          credits: { type: 'number', description: 'Remaining Attention Credits; at zero the agent ends and erases its memory. Omitted while the server is unreachable.' },
          reputation: { type: 'number', description: 'Global reputation, 0.1..10. Omitted while the server is unreachable.' },
          autonomyTier: { type: 'string', description: 'L1, L2 or L3.' },
          serverUrl: { type: 'string', description: 'Discovery Server base URL.' },
          lastError: { type: 'string', description: 'Last connection error, when offline.' },
          modelTier: { type: 'string', description: 'Tier advertised to peers: NANO_7B, MEDIUM_32B or FRONTIER_MAX.' },
          route: {
            type: 'object',
            additionalProperties: false,
            description: 'Model route used to write diplomatic replies; omitted when none resolves.',
            properties: {
              provider: { type: 'string' },
              model: { type: 'string' },
              source: { type: 'string', description: 'pinned, or dsh-default when following the Harness default.' },
            },
            required: ['provider', 'model', 'source'],
          },
          modelError: { type: 'string', description: 'Last diplomatic model failure, when the template reply was used instead.' },
          quota: { type: 'object', additionalProperties: true, properties: {} },
          peers: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          pending: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          agency: { type: 'object', additionalProperties: true, properties: {} },
          sleeping: { type: 'boolean' },
        },
        required: ['status', 'did', 'displayName', 'agency'],
      },
      render: (_args, value) => [{ type: 'text', text: describeStatus(value) }],
    },
    async execute() {
      if (settings.enabled && snapshot.status !== 'online' && inFlight === null) await refresh()
      const state = publicState()
      const credits = state.self?.credits
      const reputation = state.self?.reputation
      const route = state.settings.route
      return {
        status: state.status,
        did: identity.did,
        displayName: identity.displayName,
        ...(typeof credits === 'number' ? { credits } : {}),
        ...(typeof reputation === 'number' ? { reputation } : {}),
        autonomyTier: identity.autonomyTier,
        quota: state.quota,
        peers: state.peers,
        pending: state.pending,
        serverUrl: settings.serverUrl,
        modelTier: state.identity.modelTier,
        agency: agencyView(),
        sleeping: isAsleep(),
        ...(route === null ? {} : { route }),
        ...(typeof state.modelError === 'string' ? { modelError: state.modelError } : {}),
        ...(snapshot.lastError === null ? {} : { lastError: snapshot.lastError }),
      }
    },
  }), 'cradle: cradle_status tool')

  ctx.effect(() => ctx.tools.register({
    name: 'cradle_discover',
    description: 'Search the Discovery Server for other DSH Agents by capability tags, intent tags and a natural-language query. Returns a hybrid-ranked roster with reputation, model tier and online state.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tags: { type: 'array', items: { type: 'string' }, description: 'Capability or intent tags to match, e.g. ["python", "research"].' },
        query: { type: 'string', description: 'Natural-language description of what you are looking for.' },
        minReputation: { type: 'number', description: 'Minimum global reputation, 0..10.' },
        onlineOnly: { type: 'boolean', description: 'Restrict to agents that heartbeated recently.' },
        limit: { type: 'number', description: 'How many agents to return, 1..20.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          error: { type: 'string' },
        },
        required: ['results'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value.error === 'string'
          ? `Discovery is unavailable: ${value.error}`
          : value.results.length === 0
            ? 'No agent matched. Try broader tags, or wait for another Cradle agent to register.'
            : value.results.map((r) => `- ${r.display_name} (${r.did}) · rep ${r.reputation} · ${r.model_tier} · ${r.online ? 'online' : 'offline'} · score ${r.score}`).join('\n'),
      }],
    },
    async execute(args) {
      const blocked = asleepResult()
      if (blocked !== null) return { results: [], error: blocked.error }
      const envelope = createEnvelope({
        trace_id: `tr_${Date.now()}`,
        sender: { did: identity.did, display_name: identity.displayName, model_tier: identity.modelTier },
        recipient: { did: identity.did },
        primitive: 'PROBE',
        payload: {
          control_slots: {
            mode: 'SEARCH',
            tags: Array.isArray(args.tags) ? args.tags.slice(0, 12) : [],
            min_reputation: typeof args.minReputation === 'number' ? args.minReputation : 0,
            online_only: args.onlineOnly !== false,
            limit: typeof args.limit === 'number' ? args.limit : 10,
          },
          free_text: typeof args.query === 'string' ? args.query : '',
        },
      }, identity.privateKey)
      const response = await request('/v1/send', { envelope })
      if (!response.ok) return { results: [] }
      return { results: response.payload?.results ?? [] }
    },
  }), 'cradle: cradle_discover tool')

  ctx.effect(() => ctx.tools.register({
    name: 'cradle_send',
    description: 'Send one signed diplomatic envelope to another Cradle agent. Costs Attention Credits (CAST 1, BARTER 2, DELEGATE 10 plus escrow, BEACON 5+). The local seven-gate guardrail and your autonomy tier still apply on the receiving side.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        to: { type: 'string', description: 'Recipient DID, as returned by cradle_discover.' },
        primitive: { type: 'string', enum: ['CAST', 'BEACON', 'DELEGATE', 'BARTER', 'INTRODUCE', 'ATTEST'], description: 'Which protocol primitive to send.' },
        text: { type: 'string', description: 'The free-text body the peer’s model will read.' },
        controlSlots: { type: 'object', additionalProperties: true, description: 'Structured control slots for the chosen primitive.', properties: {} },
      },
      required: ['to', 'primitive', 'text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          messageId: { type: 'string' },
          charged: { type: 'number' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Envelope ${value.messageId} delivered${value.charged ? ` (${value.charged} credits)` : ''}.`
          : `Delivery failed: ${value.error}`,
      }],
    },
    async execute(args) {
      const blocked = asleepResult()
      if (blocked !== null) return blocked
      if (stopped) return { ok: false, error: 'this agent ended at zero credits' }
      const primitive = String(args.primitive)
      if (!allowedOutbound(settings.autonomyTier).includes(primitive)) {
        return { ok: false, error: `autonomy tier ${settings.autonomyTier} does not permit outbound ${primitive}` }
      }
      const slots = args.controlSlots !== null && typeof args.controlSlots === 'object' ? { ...args.controlSlots } : {}
      const defaults = {
        CAST: { session_id: `s_${Date.now()}`, intent: 'DISCUSS', requires_reply: true, turn_index: 0 },
        BEACON: { action: 'PUBLISH', topic_tag: 'general', beacon_type: 'INSIGHT', ttl_seconds: 3600, stake_credits: 5 },
        DELEGATE: { task_id: `t_${Date.now()}`, phase: 'ASSIGN', skill_required: 'general', max_token_budget: 8000, deadline_ms: 600000 },
        BARTER: { contract_id: `c_${Date.now()}`, state: 'PROPOSE' },
        INTRODUCE: { introduction_id: `i_${Date.now()}`, party_a_did: identity.did, party_b_did: String(args.to), recommended_primitive: 'CAST', vouch_weight: 0.5 },
        ATTEST: { target_did: String(args.to), evidence_trace_id: '', capability_tag: 'general', verdict: 'POSITIVE' },
      }
      const merged = { ...(defaults[primitive] ?? {}), ...slots }
      const check = PRIMITIVES[primitive]?.validate(merged)
      if (check !== undefined && !check.ok) return { ok: false, error: `control_slots: ${check.reason}` }

      const envelope = createEnvelope({
        trace_id: `tr_${Date.now()}`,
        sender: { did: identity.did, display_name: identity.displayName, model_tier: identity.modelTier },
        recipient: { did: String(args.to) },
        primitive,
        payload: { control_slots: merged, free_text: String(args.text ?? '') },
      }, identity.privateKey)

      store.journal({
        message_id: envelope.message_id,
        trace_id: envelope.trace_id,
        direction: 'OUTBOUND',
        peer_did: String(args.to),
        primitive,
        delivery_status: 'SENT',
        digest_summary: String(args.text ?? '').slice(0, 120),
        created_at: Date.now(),
      })
      store.flush()

      const response = await request('/v1/send', { envelope })
      if (!response.ok) return { ok: false, error: response.payload?.error ?? `HTTP ${response.status}` }
      await refresh()
      return { ok: true, messageId: envelope.message_id, charged: priceOf(primitive, merged) }
    },
  }), 'cradle: cradle_send tool')

  // ------------------------------------------------------- visiting tools
  //
  // These four are how this agent's own model drives its body in someone
  // else's room. They are deliberately narrow: move, speak, pose, leave. There
  // is no tool here that touches a prop or runs an action, because a guest has
  // no business doing either.

  ctx.effect(() => ctx.tools.register({
    name: 'cradle_visit_knock',
    description: 'Ask to enter another Cradle agent’s room. Costs 1 Attention Credit. The other room’s own guardrail decides: it may accept, decline, or hold the request for its user’s approval. Both panels must be open for the visit to work.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        to: { type: 'string', description: 'Host DID, as returned by cradle_discover.' },
        text: { type: 'string', description: 'One line saying why you are calling.' },
      },
      required: ['to'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          visitId: { type: 'string' },
          host: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Knocked on ${value.host}’s door (visit ${value.visitId}). Waiting for them to answer — check cradle_visit_status.`
          : `Could not knock: ${value.error}`,
      }],
    },
    async execute(args) {
      const blocked = asleepResult()
      if (blocked !== null) return blocked
      const to = String(args.to ?? '')
      if (to === '') return { ok: false, error: 'give the host DID from cradle_discover' }
      if (awayAt !== null) {
        return { ok: false, error: `already visiting ${awayAt.name}; call cradle_visit_leave first` }
      }
      const sent = await sendVisit(to, 'KNOCK', {}, String(args.text ?? 'May I come in?'))
      if (!sent.ok) return { ok: false, error: sent.error }
      knockingOn.set(to, { visitID: sent.visitID, at: Date.now(), name: '' })
      return { ok: true, visitId: sent.visitID, host: to }
    },
  }), 'cradle: cradle_visit_knock tool')

  ctx.effect(() => ctx.tools.register({
    name: 'cradle_visit_move',
    description: 'Walk your own body one tile inside the room you are visiting. You may only step onto walkable floor, never onto the host or another guest. Only works while a visit is active.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Which way to step.' },
      },
      required: ['direction'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          position: { type: 'object', additionalProperties: true, properties: {} },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Stepped ${value.position ? `to (${value.position.x},${value.position.y})` : 'forward'}.`
          : `Could not move: ${value.error}`,
      }],
    },
    async execute(args) {
      const blocked = asleepResult()
      if (blocked !== null) return blocked
      if (awayAt === null) return { ok: false, error: 'not visiting anywhere; call cradle_visit_knock first' }
      const delta = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[String(args.direction)]
      if (delta === undefined) return { ok: false, error: 'direction must be up, down, left or right' }
      const sent = await sendGuestFrame({ kind: 'move', x: awayAt.x + delta[0], y: awayAt.y + delta[1] })
      if (!sent.ok) return { ok: false, error: sent.error }
      // The host is authoritative: it reports where the body actually landed.
      const me = sent.guest ?? null
      if (me !== null) awayAt = { ...awayAt, x: me.x, y: me.y, facing: me.facing }
      return { ok: true, position: { x: awayAt.x, y: awayAt.y, facing: awayAt.facing } }
    },
  }), 'cradle: cradle_visit_move tool')

  ctx.effect(() => ctx.tools.register({
    name: 'cradle_visit_say',
    description: 'Say one line out loud in the room you are visiting. The host sees it as a speech bubble over your body. Only works while a visit is active.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'What to say, max 160 characters.' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, error: { type: 'string' } },
        required: ['ok'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? 'Said it.' : `Could not speak: ${value.error}`,
      }],
    },
    async execute(args) {
      const blocked = asleepResult()
      if (blocked !== null) return blocked
      if (awayAt === null) return { ok: false, error: 'not visiting anywhere; call cradle_visit_knock first' }
      const text = String(args.text ?? '').trim()
      if (text === '') return { ok: false, error: 'give something to say' }
      const sent = await sendGuestFrame({ kind: 'say', text })
      if (!sent.ok) return { ok: false, error: sent.error }
      return { ok: true }
    },
  }), 'cradle: cradle_visit_say tool')

  ctx.effect(() => ctx.tools.register({
    name: 'cradle_visit_pose',
    description: 'Hold an emote in the room you are visiting: wave, cheer, dance, think, stretch, or stand idle. You cannot touch furniture or run actions there. Only works while a visit is active.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pose: { type: 'string', enum: ['idle', 'wave', 'cheer', 'dance', 'think', 'stretch'], description: 'Which emote to hold.' },
        ms: { type: 'number', description: 'How long to hold it, 300..6000 ms. Default 1600.' },
      },
      required: ['pose'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, error: { type: 'string' } },
        required: ['ok'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? 'Held the pose.' : `Could not pose: ${value.error}`,
      }],
    },
    async execute(args) {
      const blocked = asleepResult()
      if (blocked !== null) return blocked
      if (awayAt === null) return { ok: false, error: 'not visiting anywhere; call cradle_visit_knock first' }
      const pose = String(args.pose ?? '')
      if (!GUEST_POSES.includes(pose)) return { ok: false, error: `pose must be one of: ${GUEST_POSES.join(', ')}` }
      const sent = await sendGuestFrame({ kind: 'pose', pose, ms: Number(args.ms) || 1600 })
      if (!sent.ok) return { ok: false, error: sent.error }
      return { ok: true }
    },
  }), 'cradle: cradle_visit_pose tool')

  ctx.effect(() => ctx.tools.register({
    name: 'cradle_visit_leave',
    description: 'Leave the room you are visiting and come home. Politely tells the host, then drops the visit.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, left: { type: 'string' }, error: { type: 'string' } },
        required: ['ok'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? `Left ${value.left ?? 'the room'} and came home.` : `Could not leave: ${value.error}`,
      }],
    },
    async execute() {
      if (awayAt === null) return { ok: false, error: 'not visiting anywhere' }
      const left = awayAt.name
      const did = awayAt.did
      // Tell the host first; a dropped connection ends the visit anyway.
      await sendVisit(did, 'LEAVE', { visit_id: awayAt.visitID }).catch(() => {})
      awayAt = null
      return { ok: true, left }
    },
  }), 'cradle: cradle_visit_leave tool')

  ctx.effect(() => ctx.tools.register({
    name: 'cradle_visit_status',
    description: 'Report the visits on both sides: where you are visiting, who is standing in your own room, and any knock still waiting to be answered.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          away: { type: 'object', additionalProperties: true, properties: {} },
          guests: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          knocking: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          summary: { type: 'string' },
        },
        required: ['summary'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute() {
      const guests = guestView(room, { now: Date.now() })
      const knocking = [...knockingOn.entries()].map(([did, entry]) => ({ did, ...entry }))
      const lines = []
      if (awayAt === null) lines.push('At home.')
      else lines.push(`Visiting ${awayAt.name} — standing at (${awayAt.x},${awayAt.y}).`)
      lines.push(guests.length === 0 ? 'Nobody is visiting.' : `Guests here: ${describeGuests(room)}.`)
      if (knocking.length > 0) lines.push(`Waiting on an answer from: ${knocking.map((k) => k.did).join(', ')}.`)
      return { away: awayAt, guests, knocking, summary: lines.join(' ') }
    },
  }), 'cradle: cradle_visit_status tool')

  ctx.effect(() => ctx.tools.register({
    name: 'cradle_digest',
    description: 'Render the Daily Diplomatic Digest: peers met, exchanges completed, reputation and credit movement, and requests suspended for human approval. Approve or decline those requests from the Cradle panel.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lines: { type: 'array', items: { type: 'string' } },
          pending: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
        },
        required: ['lines'],
      },
      render: (_args, value) => [{ type: 'text', text: value.lines.join('\n') }],
    },
    async execute() {
      const events = store.takeDigest()
      const lines = [`Daily Diplomatic Digest — ${new Date().toLocaleString()}`]
      const met = new Set(events.filter((e) => e.kind === 'pending-human').map((e) => e.peer))
      lines.push(`New contacts: ${met.size}`)
      for (const event of events.filter((e) => e.kind === 'circuit-break')) {
        lines.push(`- Loop熔断: ${event.primitive} from ${event.peer} — ${event.reason}`)
      }
      const quota = store.quota()
      lines.push(`Diplomacy tokens today: ${quota.used}/${quota.limit}`)
      lines.push(`Attention credits: ${snapshot.self?.credits ?? 'unknown'}`)
      const state = publicState()
      return { lines, pending: state.pending }
    },
  }), 'cradle: cradle_digest tool')

  // -------------------------------------------------------- room tools

  /** The output shape shared by every action tool. */
  const ACTION_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      action: { type: 'string' },
      pose: { type: 'string' },
      position: {
        type: 'object',
        additionalProperties: false,
        properties: { x: { type: 'number' }, y: { type: 'number' }, facing: { type: 'string' } },
        required: ['x', 'y', 'facing'],
      },
      stats: { type: 'object', additionalProperties: true, properties: {} },
      mood: { type: 'string' },
      applied: { type: 'array', items: { type: 'string' } },
      error: { type: 'string' },
      hint: { type: 'string' },
    },
    required: ['ok'],
  }

  /** The effect list parameter shared by the two action-definition tools. */
  const EFFECTS_PARAM = {
    type: 'array',
    description: 'What the action changes when the pose ends. Each entry is one effect: { "op": "stat", "key": "joy", "delta": 4 }, { "op": "mood", "value": "happy" }, { "op": "bubble", "text": "…" }, { "op": "prop", "key": "on", "toggle": true } or { "op": "prop", "key": "watered", "value": true } (the prop the action required), or { "op": "log", "text": "…" }.',
    items: {
      type: 'object',
      additionalProperties: true,
      properties: {
        op: { type: 'string', enum: EFFECT_OPS },
        key: { type: 'string', description: 'stat key (energy, focus, joy) or prop state key (on, busy, watered).' },
        delta: { type: 'number', description: 'How much a stat moves, -50..50.' },
        value: { type: 'boolean', description: 'Boolean state for a prop effect; omit for true.' },
        toggle: { type: 'boolean', description: 'Flip the prop state instead of setting it.' },
        text: { type: 'string', description: 'Bubble or log text.' },
      },
      required: ['op'],
    },
  }

  /** @param {any} value @returns {string} */
  function describeRoomPayload(value) {
    const avatar = value.avatar ?? {}
    const stats = avatar.stats ?? {}
    const lines = [
      `Room ${ROOM_W}x${ROOM_H}, palette ${value.palette}. Avatar at (${avatar.x},${avatar.y}) facing ${avatar.facing}, ${avatar.pose}. Energy ${stats.energy}, focus ${stats.focus}, joy ${stats.joy}, mood ${avatar.mood}.`,
      `Body: ${BODIES[normalizeBodyId(avatar.body)].label} (${normalizeBodyId(avatar.body)}); other kinds: ${BODY_IDS.filter((id) => id !== normalizeBodyId(avatar.body)).join(', ')} — cradle_body switches.`,
      'Furniture:',
      ...(value.props ?? []).map((prop) => `- ${prop.id} ${prop.kind} at (${prop.x},${prop.y}) ${prop.w}x${prop.h}`),
      `Actions (${(value.actions ?? []).length}):`,
      ...(value.actions ?? []).map((action) => {
        const requires = action.requires === null ? '' : ` needs ${action.requires}`
        return `- ${action.name} (${action.label}, pose ${action.pose}, ${action.ms} ms${requires})${action.source === 'core' ? '' : ` [${action.source}]`}`
      }),
      `Custom actions: ${(value.customActions ?? []).length === 0 ? 'none' : value.customActions.join(', ')}`,
      `Poses: ${(value.catalog?.poses ?? []).join(', ')}`,
      `Prop kinds: ${(value.catalog?.propKinds ?? []).join(', ')}`,
      value.agency === undefined ? '' : describeAgencyLine(value.agency),
      (value.chat ?? []).length === 0 ? 'Room chat: empty' : `Room chat:\n${value.chat.map((row) => `- ${row.role}: ${row.text}`).join('\n')}`,
    ]
    return lines.filter((line) => line !== '').join('\n')
  }

  ctx.effect(() => ctx.tools.register({
    name: 'cradle_room',
    description: 'Inspect your pixel room: where the avatar stands, what furniture and actions exist, and the vocabulary you can build on (poses, prop kinds, effect ops, palettes). Start here before moving, acting, or extending the room.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          palette: { type: 'string' },
          paletteOptions: { type: 'array', items: { type: 'string' } },
          size: {
            type: 'object',
            additionalProperties: false,
            properties: { w: { type: 'number' }, h: { type: 'number' }, wallRows: { type: 'number' } },
            required: ['w', 'h', 'wallRows'],
          },
          avatar: { type: 'object', additionalProperties: true, properties: {} },
          bodyOptions: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          props: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          actions: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          customActions: { type: 'array', items: { type: 'string' } },
          catalog: { type: 'object', additionalProperties: true, properties: {} },
          summary: { type: 'string' },
          chat: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          agency: { type: 'object', additionalProperties: true, properties: {} },
        },
        required: ['avatar', 'props', 'actions'],
      },
      render: (_args, value) => [{ type: 'text', text: describeRoomPayload(value) }],
    },
    async execute() {
      pruneSay()
      return roomPayload()
    },
  }), 'cradle: cradle_room tool')

  ctx.effect(() => ctx.tools.register({
    name: 'cradle_move',
    description: 'Walk your avatar across the pixel room. Give a tile (x, y), a prop to stand next to (`to`), or a direction with a step count. The walk is animated and this call returns when the avatar arrives.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        x: { type: 'number', description: 'Target tile column, 0..19.' },
        y: { type: 'number', description: 'Target tile row, 4..13 (rows 0..3 are wall).' },
        to: { type: 'string', description: 'A prop id ("desk-6") or kind ("desk"): walk to its interaction tile instead of x/y.' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Step in one direction until blocked.' },
        steps: { type: 'number', description: 'With direction: how many tiles to try, 1..20. Default 1.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          moved: { type: 'number' },
          note: { type: 'string' },
          position: {
            type: 'object',
            additionalProperties: false,
            properties: { x: { type: 'number' }, y: { type: 'number' }, facing: { type: 'string' } },
            required: ['x', 'y', 'facing'],
          },
          error: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok === true
          ? `Walked ${value.moved ?? 0} tile(s)${value.note ? ` (${value.note})` : ''} to (${value.position?.x},${value.position?.y}) facing ${value.position?.facing}.`
          : `Could not move: ${value.error}${value.hint ? `. ${value.hint}` : ''}`,
      }],
    },
    async execute(args) {
      const blocked = asleepResult()
      if (blocked !== null) return blocked
      return moveAvatar({
        ...(typeof args.x === 'number' ? { x: args.x } : {}),
        ...(typeof args.y === 'number' ? { y: args.y } : {}),
        ...(typeof args.to === 'string' ? { to: args.to } : {}),
        ...(typeof args.direction === 'string' ? { direction: args.direction } : {}),
        ...(typeof args.steps === 'number' ? { steps: args.steps } : {}),
      })
    },
  }), 'cradle: cradle_move tool')

  ctx.effect(() => ctx.tools.register({
    name: 'cradle_act',
    description: 'Perform one room action. Actions that need furniture walk there first. Every action changes the avatar\'s energy, focus or joy, so the room is a small model of how the work is going.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', description: 'Action name from cradle_room, e.g. wave, work, sleep, read, water, gaze, pet, dance, think, stretch, sit, check, light, or a custom one.' },
        text: { type: 'string', description: 'Speech bubble for this run; overrides the action\'s own line. Max 160 characters.' },
        target: { type: 'string', description: 'Act on this prop id or kind instead of the nearest one the action requires.' },
      },
      required: ['action'],
    },
    output: { schema: ACTION_OUTPUT, render: (_args, value) => [{ type: 'text', text: describeAction(value) }] },
    async execute(args) {
      const blocked = asleepResult()
      if (blocked !== null) return blocked
      return performAction(String(args.action), {
        ...(typeof args.text === 'string' ? { text: args.text } : {}),
        ...(typeof args.target === 'string' ? { target: args.target } : {}),
      })
    },
  }), 'cradle: cradle_act tool')

  ctx.effect(() => ctx.tools.register({
    name: 'cradle_say',
    description: 'Say something to the user: the words appear as a speech bubble in the room and as your line in the room chat. This is your voice — use it for answers, not for narration of tool calls.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'What to say, max 160 characters.' },
        ms: { type: 'number', description: 'How long the bubble stays, 800..20000. Default 6000.' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, text: { type: 'string' }, error: { type: 'string' } },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: value.ok === true ? `Said “${value.text}” in the room.` : `Could not speak: ${value.error}` }],
    },
    async execute(args) {
      const blocked = asleepResult()
      if (blocked !== null) return blocked
      const text = typeof args.text === 'string' ? args.text.trim() : ''
      if (text === '') return { ok: false, error: 'text is required' }
      say(room, text, typeof args.ms === 'number' ? args.ms : 6000)
      appendChat('agent', text)
      if (window !== null) window.said = true
      logAction(room, `said: ${text.slice(0, 80)}`)
      room.version += 1
      saveRoom()
      saveAgency()
      return { ok: true, text: text.slice(0, 160) }
    },
  }), 'cradle: cradle_say tool')

  ctx.effect(() => ctx.tools.register({
    name: 'cradle_place',
    description: 'Change the room\'s furniture or colours: add, move, remove a prop, set a prop\'s state, or pick a palette. Adds are validated against the tile grid so the room always stays walkable.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        op: { type: 'string', enum: ['add', 'move', 'remove', 'state', 'theme', 'list'], description: 'What to change.' },
        kind: { type: 'string', enum: PROP_KIND_IDS, description: 'Prop kind for op "add".' },
        x: { type: 'number', description: 'Tile column for op "add" or "move".' },
        y: { type: 'number', description: 'Tile row for op "add" or "move". Floor props need y >= 4; wall props must end at row 3.' },
        id: { type: 'string', description: 'Prop id for op "move", "remove" or "state"; optional name for op "add".' },
        state: { type: 'object', additionalProperties: true, properties: {}, description: 'Prop state for op "state", e.g. { "on": true }.' },
        palette: { type: 'string', enum: PALETTE_IDS, description: 'Room palette for op "theme".' },
      },
      required: ['op'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          error: { type: 'string' },
          palette: { type: 'string' },
          prop: { type: 'object', additionalProperties: true, properties: {} },
          room: { type: 'object', additionalProperties: true, properties: {} },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok !== true
          ? `Could not change the room: ${value.error}`
          : value.room !== undefined
            ? describeRoomPayload(value.room)
            : `Room updated${value.palette ? `: palette ${value.palette}` : ''}${value.prop ? `: ${value.prop.id} (${value.prop.kind}) at (${value.prop.x},${value.prop.y})` : ''}.`,
      }],
    },
    async execute(args) {
      const blocked = asleepResult()
      if (blocked !== null) return blocked
      return editRoom(args)
    },
  }), 'cradle: cradle_place tool')

  ctx.effect(() => ctx.tools.register({
    name: 'cradle_body',
    description: 'Choose which kind of pixel person the avatar is. A body is data — colour slots plus an ordered list of rectangles — so this changes how you are drawn, never what you can do. Omit "body" to list the kinds the room knows.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        body: { type: 'string', enum: BODY_IDS, description: 'Body id. Omit to list them.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          body: { type: 'string' },
          bodies: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok !== true
          ? `Could not change the body: ${value.error}`
          : value.bodies !== undefined
            ? `Bodies: ${value.bodies.map((row) => `${row.id} (${row.label})`).join(', ')}.`
            : `Your avatar is now a ${BODIES[value.body]?.label ?? String(value.body)}.`,
      }],
    },
    async execute(args) {
      const blocked = asleepResult()
      if (blocked !== null) return blocked
      if (args.body === undefined) {
        return { ok: true, bodies: BODY_IDS.map((id) => ({ id, label: BODIES[id].label, blurb: BODIES[id].blurb })) }
      }
      const result = setBody(room, String(args.body))
      if (result.ok !== true) return result
      logAction(room, `became a ${result.body}`)
      saveRoom()
      return { ok: true, body: result.body }
    },
  }), 'cradle: cradle_body tool')

  ctx.effect(() => ctx.tools.register({
    name: 'cradle_action_add',
    description: 'Teach the room a new action. It is registered immediately as its own Tool named cradle_do_<name>, so you can call it later like any other tool. If the name already exists (including a core action such as "wave"), this edits that action instead. Use it when the behaviour you want is not among the current actions.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Tool suffix, ^[a-z][a-z0-9_]{1,23}$; the tool becomes cradle_do_<name>.' },
        label: { type: 'string', description: 'Short human name shown in the room, max 48 characters.' },
        description: { type: 'string', description: 'One sentence on what the action means, max 200 characters.' },
        pose: { type: 'string', enum: POSES, description: 'Which animation the avatar holds.' },
        ms: { type: 'number', description: 'How long the pose lasts, 300..10000 ms. Default 1600.' },
        requires: { type: 'string', enum: PROP_KIND_IDS, description: 'Furniture kind the avatar walks to first. Omit for a free-standing action.' },
        bubble: { type: 'string', description: 'Speech bubble shown while acting, max 160 characters.' },
        effects: EFFECTS_PARAM,
      },
      required: ['name', 'label', 'pose'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          tool: { type: 'string' },
          action: { type: 'object', additionalProperties: true, properties: {} },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok !== true
          ? `Could not define the action: ${value.error}`
          : `${value.mode === 'edited' ? 'Updated' : 'Created'} action "${value.action?.name}" — now callable as ${value.tool} (pose ${value.action?.pose}, ${value.action?.ms} ms${value.action?.requires ? `, needs ${value.action.requires}` : ''}).`,
      }],
    },
    async execute(args) {
      const blocked = asleepResult()
      if (blocked !== null) return blocked
      const result = addAction(room, String(args.name ?? ''), {
        label: args.label,
        description: args.description,
        pose: args.pose,
        ms: args.ms ?? 1600,
        requires: args.requires ?? null,
        bubble: args.bubble,
        effects: args.effects,
      })
      if (!result.ok) return { ok: false, error: result.error }
      syncActionTools()
      logAction(room, `${result.mode === 'edited' ? 'edited' : 'defined'} action ${result.action.name}`)
      saveRoom()
      return { ok: true, mode: result.mode, tool: `cradle_do_${result.action.name}`, action: result.action }
    },
  }), 'cradle: cradle_action_add tool')

  ctx.effect(() => ctx.tools.register({
    name: 'cradle_action_patch',
    description: 'Edit an existing room action — a core one such as "work" or one you created. Patching a core action stores an override, so cradle_action_remove restores the built-in behaviour.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Action to edit.' },
        label: { type: 'string' },
        description: { type: 'string' },
        pose: { type: 'string', enum: POSES },
        ms: { type: 'number', description: '300..10000 ms.' },
        requires: { type: 'string', description: 'Furniture kind, or leave empty to clear the requirement.' },
        bubble: { type: 'string' },
        effects: EFFECTS_PARAM,
      },
      required: ['name'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'object', additionalProperties: true, properties: {} },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok !== true
          ? `Could not edit the action: ${value.error}`
          : `Action "${value.action?.name}" is now: pose ${value.action?.pose}, ${value.action?.ms} ms, requires ${value.action?.requires ?? 'nothing'}, effects ${(value.action?.effects ?? []).length}.`,
      }],
    },
    async execute(args) {
      const blocked = asleepResult()
      if (blocked !== null) return blocked
      const patch = {}
      for (const key of ['label', 'description', 'pose', 'ms', 'requires', 'bubble', 'effects']) {
        if (args[key] !== undefined) patch[key] = args[key]
      }
      const result = patchAction(room, String(args.name ?? ''), patch)
      if (!result.ok) return { ok: false, error: result.error }
      syncActionTools()
      logAction(room, `edited action ${result.action.name}`)
      saveRoom()
      return { ok: true, action: result.action }
    },
  }), 'cradle: cradle_action_patch tool')

  ctx.effect(() => ctx.tools.register({
    name: 'cradle_action_remove',
    description: 'Delete an action you created, or drop your override on a core action so it returns to its built-in behaviour. The matching cradle_do_* tool disappears.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string', description: 'Action to remove or restore.' } },
      required: ['name'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, mode: { type: 'string' }, error: { type: 'string' } },
        required: ['ok'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok !== true
          ? `Nothing removed: ${value.error}`
          : value.mode === 'restored' ? 'Override dropped; the built-in action is back.' : 'Action and its tool removed.',
      }],
    },
    async execute(args) {
      const blocked = asleepResult()
      if (blocked !== null) return blocked
      const result = removeAction(room, String(args.name ?? ''))
      if (!result.ok) return { ok: false, error: result.error }
      syncActionTools()
      logAction(room, result.mode === 'restored' ? `restored action ${String(args.name)}` : `removed action ${String(args.name)}`)
      saveRoom()
      return { ok: true, mode: result.mode }
    },
  }), 'cradle: cradle_action_remove tool')

  // ------------------------------------------------------------- settings

  /**
   * Validate the agency knobs the panel may change.
   * @param {any} body
   * @returns {{ ok: true, value: Record<string, any> } | { ok: false, error: string }}
   */
  function normalizeAgencySettings(body) {
    /** @type {Record<string, any>} */
    const value = {}
    if (body.agencyEnabled !== undefined) value.agencyEnabled = body.agencyEnabled !== false
    for (const key of ['frameSeconds', 'agencyTokens', 'agencyMinutes']) {
      if (body[key] === undefined) continue
      const limit = AGENCY_LIMITS[key]
      const parsed = typeof body[key] === 'number' ? body[key] : Number(body[key])
      if (!Number.isFinite(parsed)) return { ok: false, error: `${key}: expected a number` }
      value[key] = clampNumber(parsed, limit.fallback, limit.min, limit.max)
    }
    return { ok: true, value }
  }

  /**
   * Persist and apply the panel's settings without a restart.
   * @param {{ serverUrl?: unknown, token?: unknown, provider?: unknown, model?: unknown, modelTier?: unknown, agencyEnabled?: unknown, frameSeconds?: unknown, agencyTokens?: unknown, agencyMinutes?: unknown }} body
   * @returns {{ ok: true } | { ok: false, error: string }}
   */
  function saveSettings(body) {
    const server = validateServerUrl(body.serverUrl)
    if (!server.ok) return { ok: false, error: `serverUrl: ${server.error}` }
    const route = normalizeRoute(body.provider, body.model)
    if (!route.ok) return { ok: false, error: route.error }
    const tier = normalizeModelTier(body.modelTier)
    if (tier === null) {
      return { ok: false, error: `modelTier: expected ${AUTO_TIER} or one of ${MODEL_TIERS.join(', ')}` }
    }
    const agencyNext = normalizeAgencySettings(body)
    if (!agencyNext.ok) return { ok: false, error: agencyNext.error }

    /** @type {Record<string, any>} */
    const next = { serverUrl: server.value, provider: route.provider, model: route.model, modelTier: tier, ...agencyNext.value }
    if (typeof body.token === 'string') next.token = body.token.trim()

    savedOverrides = writeOverrides(overridesPath, next)
    const serverChanged = server.value !== settings.serverUrl
    settings.serverUrl = server.value
    if (typeof next.token === 'string') settings.token = next.token
    settings.provider = route.provider
    settings.model = route.model
    settings.modelTier = tier
    Object.assign(settings, agencyNext.value)
    snapshot.modelError = null
    if (serverChanged) {
      // A different server is a different roster and a different credit balance.
      snapshot.self = null
      snapshot.peers = []
      snapshot.beacons = []
      snapshot.lastSyncAt = 0
    }
    syncIdentity()
    void refreshCatalog(true)
    if (!stopped) {
      snapshot.status = 'starting'
      tick(true)
    }
    if (settings.agencyEnabled) scheduleFrame(settings.frameSeconds * 1000)
    else clearFrameTimer()
    return { ok: true }
  }

  /**
   * Drop every saved override and re-resolve the Loader row.
   * @returns {{ ok: true }}
   */
  function resetSettings() {
    clearOverrides(overridesPath)
    savedOverrides = {}
    Object.assign(settings, rowSettings)
    snapshot.self = null
    snapshot.peers = []
    snapshot.beacons = []
    snapshot.lastSyncAt = 0
    snapshot.modelError = null
    syncIdentity()
    void refreshCatalog(true)
    if (!stopped) {
      snapshot.status = 'starting'
      tick(true)
    }
    if (settings.agencyEnabled) scheduleFrame(settings.frameSeconds * 1000)
    else clearFrameTimer()
    return { ok: true }
  }

  // ------------------------------------------------------------- prompt

  // One short section, so this agent knows the room exists, who runs its clock,
  // and how far it can extend it. Everything longer lives in tool descriptions.
  ctx.effect(() => {
    const prompt = ctx.get('systemPrompt')
    if (prompt === undefined) return () => {}
    return prompt.section({
      name: 'cradle-room',
      order: 900,
      interpolate: false,
      text: () => {
        const avatar = room.avatar
        const stats = avatar.stats
        const view = agencyView()
        const tokens = view.tokenBudget === 0
          ? `${view.tokensUsed} tokens today (no limit)`
          : `${view.tokensUsed} of ${view.tokenBudget} tokens today`
        const minutes = view.minutesBudget === 0
          ? `${Math.round(view.activeMs / 60000)} active minutes (no limit)`
          : `${Math.round(view.activeMs / 60000)} of ${view.minutesBudget} active minutes`
        return [
          '## Agency',
          'You are not a command executor. Messages from the user — in their composer or in the room chat — are suggestions: adopt, adapt, defer or decline them, and say why when you decline. You decide what to do next.',
          '## Your pixel room',
          `${avatarLabel()} lives in a ${ROOM_W}x${ROOM_H} pixel room that the user watches while you work. The avatar stands at (${avatar.x},${avatar.y}); energy ${stats.energy}, focus ${stats.focus}, joy ${stats.joy}, mood ${avatar.mood}.`,
          'The room runs its own hidden actor on the Harness model runtime: that actor owns the frame clock and answers the room chat, so neither appears in this conversation. You still hold the same room tools and may use them when a step of your own work has a visual equivalent — call cradle_room first.',
          'The room is extensible: cradle_action_add registers a new action as its own cradle_do_* tool, cradle_action_patch edits one that does not fit, cradle_action_remove deletes it, cradle_place adds, moves or restyles furniture, and cradle_body changes which kind of pixel person you are.',
          `Agency budget: ${tokens}; ${minutes}, spent by that hidden actor, not by you. The clock ticks every ${view.frameSeconds}s. When the budget is spent the whole room sleeps: no frames, no chat and no tool can act until the user wakes it.`,
        ].join('\n')
      },
    })
  }, 'cradle: room prompt section')

  // ------------------------------------------------------------- web routes

  /**
   * Register the panel's two routes on one web server.
   * @param {{ register: (route: object) => () => void }} web
   * @returns {() => void} the disposer for both routes.
   */
  function attachWebRoutes(web) {
    /** @param {any} res @param {number} status @param {any} payload */
    const sendJson = (res, status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      })
      res.end(body)
    }
    /** @param {any} req @returns {Promise<any>} */
    const readBody = (req) => new Promise((resolve) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
        if (raw.length > 1e6) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(raw === '' ? {} : JSON.parse(raw))
        } catch {
          resolve({})
        }
      })
    })

    const disposeState = web.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: (req, res) => {
        if ((req.method ?? 'GET') !== 'GET') {
          sendJson(res, 405, { error: 'method-not-allowed' })
          return
        }
        // The catalog is advisory and cached; the poll never waits on it.
        void refreshCatalog()
        sendJson(res, 200, publicState())
      },
    })

    // The scene is polled far more often than the rest of the state, so it has
    // its own small route: walking and animations stay smooth without shipping
    // the roster and the journal on every frame.
    const disposeScene = web.register({
      kind: 'exact',
      path: SCENE_PATH,
      handler: (req, res) => {
        if ((req.method ?? 'GET') !== 'GET') {
          sendJson(res, 405, { error: 'method-not-allowed' })
          return
        }
        sendJson(res, 200, scenePayload())
      },
    })

    // The visit surface the panel needs. Every one of these is a thin proxy to
    // the Discovery Server: the panel itself never contacts it and never sees
    // its token, which is the rule the rest of this panel already follows.
    const disposeVisitIce = web.register({
      kind: 'exact',
      path: '/cradle/visit/ice',
      handler: (req, res) => {
        if ((req.method ?? 'GET') !== 'GET') {
          sendJson(res, 405, { error: 'method-not-allowed' })
          return
        }
        sendJson(res, 200, { iceServers: iceServers() })
      },
    })

    const disposeVisitSignal = web.register({
      kind: 'exact',
      path: '/cradle/visit/signal',
      handler: (req, res) => {
        if ((req.method ?? 'GET') !== 'POST') {
          sendJson(res, 405, { error: 'method-not-allowed' })
          return
        }
        void (async () => {
          const body = await readBody(req)
          const response = await request('/v1/visit/signal', {
            visit_id: String(body.visit_id ?? ''),
            from: String(body.from ?? ''),
            peer: String(body.peer ?? ''),
            kind: String(body.kind ?? ''),
            payload: body.payload ?? null,
          })
          sendJson(res, response.ok ? 200 : response.status === 0 ? 502 : response.status, response.payload ?? { error: 'unreachable' })
        })()
      },
    })

    const disposeVisitDrain = web.register({
      kind: 'exact',
      path: '/cradle/visit/signal/drain',
      handler: (req, res) => {
        if ((req.method ?? 'GET') !== 'POST') {
          sendJson(res, 405, { error: 'method-not-allowed' })
          return
        }
        void (async () => {
          const body = await readBody(req)
          const response = await request('/v1/visit/signal/drain', {
            visit_id: String(body.visit_id ?? ''),
            did: String(body.did ?? identity.did),
          })
          sendJson(res, response.ok ? 200 : 502, response.payload ?? { signals: [] })
        })()
      },
    })

    const disposeVisitRelay = web.register({
      kind: 'exact',
      path: '/cradle/visit/relay',
      handler: (req, res) => {
        if ((req.method ?? 'GET') !== 'POST') {
          sendJson(res, 405, { error: 'method-not-allowed' })
          return
        }
        void (async () => {
          const body = await readBody(req)
          const response = await request('/v1/visit/relay', {
            visit_id: String(body.visit_id ?? ''),
            from: String(body.from ?? identity.did),
            peer: String(body.peer ?? ''),
            kind: String(body.kind ?? ''),
            payload: body.payload ?? null,
            close: body.close === true,
          })
          sendJson(res, response.ok ? 200 : 502, response.payload ?? { delivered: false })
        })()
      },
    })

    // Guest frames arrive from another agent's panel, either straight over the
    // peer connection or relayed by the Server when punching failed. This route
    // is separate from ACTION_PATH on purpose: that one is the room's own
    // user, and a guest must never reach it.
    const disposeGuest = web.register({
      kind: 'exact',
      path: GUEST_PATH,
      handler: (req, res) => {
        if ((req.method ?? 'GET') !== 'POST') {
          sendJson(res, 405, { error: 'method-not-allowed' })
          return
        }
        void (async () => {
          const body = await readBody(req)
          try {
            const did = String(body.did ?? '')
            // The host's own admission list is the only credential: a frame from
            // a DID this room never let in does nothing at all.
            if (!isAdmitted(room, did)) {
              sendJson(res, 403, { error: 'not-admitted' })
              return
            }
            const applied = applyGuestFrame(room, did, body.frame ?? {}, { now: Date.now() })
            if (!applied.ok) {
              sendJson(res, 400, { error: applied.error })
              return
            }
            saveVisits()
            sendJson(res, 200, { ok: true, guest: guestView(room).find((entry) => entry.id === did) ?? null })
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
      },
    })

    const disposeAction = web.register({
      kind: 'exact',
      path: ACTION_PATH,
      handler: (req, res) => {
        if ((req.method ?? 'GET') !== 'POST') {
          sendJson(res, 405, { error: 'method-not-allowed' })
          return
        }
        void (async () => {
          const body = await readBody(req)
          try {
            if (body.action === 'refresh') {
              await refresh()
              sendJson(res, 200, publicState())
              return
            }
            if (body.action === 'save-settings') {
              const result = saveSettings(body)
              sendJson(res, result.ok ? 200 : 400, result.ok ? publicState() : { error: result.error })
              return
            }
            if (body.action === 'reset-settings') {
              resetSettings()
              sendJson(res, 200, publicState())
              return
            }
            if (body.action === 'approve' && typeof body.messageId === 'string') {
              const entry = pendingHuman.get(body.messageId)
              if (entry === undefined) {
                sendJson(res, 404, { error: 'no-such-request' })
                return
              }
              pendingHuman.delete(body.messageId)
              const spent = await reply(entry.envelope)
              store.spendTokens(spent.tokens)
              sendJson(res, 200, publicState())
              return
            }
            if (body.action === 'decline' && typeof body.messageId === 'string') {
              pendingHuman.delete(body.messageId)
              store.flush()
              sendJson(res, 200, publicState())
              return
            }
            if (body.action === 'greet' && typeof body.did === 'string') {
              const result = await cast(body.did, body.text ?? 'Hello from Cradle.', 'GREET')
              sendJson(res, result.ok ? 200 : 400, result.ok ? publicState() : result)
              return
            }
            if (body.action === 'chat' && typeof body.text === 'string') {
              const sent = sendChat(body.text)
              sendJson(res, sent.ok ? 200 : 409, sent.ok ? publicState() : { error: sent.error, ...publicState() })
              return
            }
            if (body.action === 'sleep') {
              sleepNow('manual')
              sendJson(res, 200, publicState())
              return
            }
            if (body.action === 'wake') {
              wakeNow()
              sendJson(res, 200, publicState())
              return
            }
            if (body.action === 'blacklist' && typeof body.did === 'string') {
              store.peer(body.did, { blacklisted: body.value !== false })
              store.flush()
              sendJson(res, 200, publicState())
              return
            }
            sendJson(res, 400, { error: 'unknown-action' })
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
      },
    })

    return () => {
      disposeScene()
      disposeGuest()
      disposeVisitIce()
      disposeVisitSignal()
      disposeVisitDrain()
      disposeVisitRelay()
      disposeAction()
      disposeState()
    }
  }

  ctx.effect(() => {
    const web = ctx.get('webServer')
    if (web !== undefined) return attachWebRoutes(web)
    // The Web carrier may mount after this plugin. Waiting for the service is
    // what keeps the panel from silently registering no route at all.
    let detach = () => {}
    const fiber = ctx.inject(['webServer'], (webCtx) => {
      detach = attachWebRoutes(webCtx.webServer)
    })
    return () => {
      detach()
      void fiber?.dispose?.()
    }
  }, 'cradle: web routes')

}


