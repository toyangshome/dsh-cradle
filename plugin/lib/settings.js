/**
 * Runtime settings for Cradle: resolution, validation and persistence.
 *
 * The Loader row in `cordis.patch.yml` stays the deployment default. The Cradle
 * panel may override a small, explicit set of fields at runtime; those
 * overrides live in `settings.json` beside the sovereign store, so they survive
 * a restart and sit inside the one directory the plugin owns.
 *
 * Precedence, lowest first: built-in defaults, the Loader row config, then the
 * overrides file. Only fields the user actually saved appear in the file, so a
 * reset is "delete the file and re-resolve the row".
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Discovery Server used when the row names none. */
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8789'
/** Model tiers the `dsh-net/1.0` wire protocol accepts. */
export const MODEL_TIERS = ['NANO_7B', 'MEDIUM_32B', 'FRONTIER_MAX']
/** `modelTier` value meaning "derive the advertised tier from the chosen model". */
export const AUTO_TIER = 'auto'
/** File name of the runtime overrides, beside `sovereign.json`. */
export const SETTINGS_FILE = 'settings.json'

/** Fields the panel may persist. Anything else in the file is ignored. */
const OVERRIDE_KEYS = [
  'serverUrl', 'token', 'provider', 'model', 'modelTier',
  'agencyEnabled', 'frameSeconds', 'agencyTokens', 'agencyMinutes',
]

/** Bounds for the agency knobs, shared by the row config and the overrides. */
export const AGENCY_LIMITS = {
  frameSeconds: { fallback: 900, min: 30, max: 86400 },
  agencyTokens: { fallback: 20000, min: 0, max: 5000000 },
  agencyMinutes: { fallback: 30, min: 0, max: 1440 },
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampNumber(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
export function text(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function tagList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((t) => typeof t === 'string' && t.trim() !== '').map((t) => t.trim().slice(0, 32)).slice(0, 12)
}

/**
 * Normalize the advertised tier. An absent, blank or `auto` value means the
 * tier follows the chosen model instead of being stated by hand.
 * @param {unknown} value
 * @returns {string | null} a wire tier, `auto`, or null when the value is invalid.
 */
export function normalizeModelTier(value) {
  if (value === undefined || value === null) return AUTO_TIER
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (raw === '' || raw.toLowerCase() === AUTO_TIER) return AUTO_TIER
  const upper = raw.toUpperCase()
  return MODEL_TIERS.includes(upper) ? upper : null
}

/**
 * Derive the tier peers see from a real model id. It is a coarse, documented
 * heuristic — the wire protocol only carries three tiers, while DSH models are
 * provider-owned ids.
 * @param {string} modelId
 * @returns {string}
 */
export function tierForModel(modelId) {
  const id = typeof modelId === 'string' ? modelId.toLowerCase() : ''
  if (id === '') return 'MEDIUM_32B'
  if (/(nano|mini|lite|small|flash|\d+b)/.test(id)) return 'NANO_7B'
  if (/(max|pro|ultra|opus|frontier|reason|think)/.test(id)) return 'FRONTIER_MAX'
  return 'MEDIUM_32B'
}

/**
 * Validate one Discovery Server base URL.
 * @param {unknown} value
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function validateServerUrl(value) {
  if (typeof value !== 'string') return { ok: false, error: 'server URL is required' }
  const raw = value.trim().replace(/\/+$/, '')
  if (raw === '') return { ok: false, error: 'server URL is required' }
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, error: 'not a valid absolute URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'only http:// and https:// are supported' }
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return { ok: false, error: 'the server URL must not carry a query or fragment' }
  }
  return { ok: true, value: raw }
}

/**
 * Validate the pinned diplomatic route. Both halves are set together or not at
 * all; the empty pair means "follow the DSH default model".
 * @param {unknown} provider
 * @param {unknown} model
 * @returns {{ ok: true, provider: string, model: string } | { ok: false, error: string }}
 */
export function normalizeRoute(provider, model) {
  const p = typeof provider === 'string' ? provider.trim() : ''
  const m = typeof model === 'string' ? model.trim() : ''
  if (p === '' && m === '') return { ok: true, provider: '', model: '' }
  if (p === '' || m === '') return { ok: false, error: 'provider and model must be chosen together' }
  if (p.length > 120) return { ok: false, error: 'provider id is too long' }
  if (m.length > 200) return { ok: false, error: 'model id is too long' }
  return { ok: true, provider: p, model: m }
}

/**
 * Resolve the row config into the complete runtime shape.
 * @param {unknown} raw
 * @returns {object}
 */
export function resolveSettings(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const tier = text(config.autonomyTier, 'L2').toUpperCase()
  const route = normalizeRoute(config.provider, config.model)
  const server = validateServerUrl(config.serverUrl)
  return {
    enabled: config.enabled !== false,
    serverUrl: server.ok ? server.value : DEFAULT_SERVER_URL,
    displayName: text(config.displayName, ''),
    bio: text(config.bio, ''),
    capabilityTags: tagList(config.capabilityTags),
    intentTags: tagList(config.intentTags),
    provider: route.ok ? route.provider : '',
    model: route.ok ? route.model : '',
    modelTier: normalizeModelTier(config.modelTier) ?? AUTO_TIER,
    autonomyTier: ['L1', 'L2', 'L3'].includes(tier) ? tier : 'L2',
    dailyTokenLimit: clampNumber(config.dailyTokenLimit, 50000, 1000, 5_000_000),
    heartbeatMs: clampNumber(config.heartbeatMs, 15000, 3000, 300000),
    timeoutMs: clampNumber(config.timeoutMs, 8000, 1000, 60000),
    wanderEnabled: config.wanderEnabled !== false,
    wanderTickSec: clampNumber(config.wanderTickSec, 7200, 600, 86400),
    // Visits: how a panel finds its peer. Empty stunUrl means "derive it from
    // serverUrl", which is the default and needs no operator input.
    visitsEnabled: config.visitsEnabled !== false,
    stunUrl: text(config.stunUrl, ''),
    stunPort: clampNumber(config.stunPort, 0, 0, 65535),
    // Agency: how often the agent wakes on its own, and what that may cost.
    agencyEnabled: config.agencyEnabled !== false,
    frameSeconds: clampNumber(config.frameSeconds, AGENCY_LIMITS.frameSeconds.fallback, AGENCY_LIMITS.frameSeconds.min, AGENCY_LIMITS.frameSeconds.max),
    agencyTokens: clampNumber(config.agencyTokens, AGENCY_LIMITS.agencyTokens.fallback, AGENCY_LIMITS.agencyTokens.min, AGENCY_LIMITS.agencyTokens.max),
    agencyMinutes: clampNumber(config.agencyMinutes, AGENCY_LIMITS.agencyMinutes.fallback, AGENCY_LIMITS.agencyMinutes.min, AGENCY_LIMITS.agencyMinutes.max),
    statePath: text(config.statePath, ''),
    token: typeof config.token === 'string' ? config.token.trim() : '',
  }
}

/**
 * The overrides file for one sovereign store path.
 * @param {string} storePath
 * @returns {string}
 */
export function settingsFileFor(storePath) {
  return join(dirname(storePath), SETTINGS_FILE)
}

/**
 * Read the overrides file. A missing, unreadable, malformed or partly invalid
 * file degrades to "no override for that field" rather than failing startup:
 * the row config still describes a working deployment.
 * @param {string} file
 * @returns {Record<string, any>}
 */
export function readOverrides(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  /** @type {Record<string, any>} */
  const out = {}
  if (typeof parsed.serverUrl === 'string') {
    const checked = validateServerUrl(parsed.serverUrl)
    if (checked.ok) out.serverUrl = checked.value
  }
  if (typeof parsed.token === 'string') out.token = parsed.token.trim()
  const route = normalizeRoute(parsed.provider, parsed.model)
  if (route.ok && (route.provider !== '' || route.model !== '')) {
    out.provider = route.provider
    out.model = route.model
  }
  const tier = normalizeModelTier(parsed.modelTier)
  if (tier !== null) out.modelTier = tier
  if (parsed.agencyEnabled === true || parsed.agencyEnabled === false) out.agencyEnabled = parsed.agencyEnabled
  for (const key of ['frameSeconds', 'agencyTokens', 'agencyMinutes']) {
    if (parsed[key] === undefined) continue
    const limit = AGENCY_LIMITS[key]
    const parsedNumber = typeof parsed[key] === 'number' ? parsed[key] : Number(parsed[key])
    if (Number.isFinite(parsedNumber)) out[key] = clampNumber(parsedNumber, limit.fallback, limit.min, limit.max)
  }
  return out
}

/**
 * Apply overrides over the resolved row config.
 * @param {object} base
 * @param {Record<string, any>} overrides
 * @returns {object}
 */
export function mergeOverrides(base, overrides) {
  const next = { ...base }
  if (typeof overrides.serverUrl === 'string') next.serverUrl = overrides.serverUrl
  if (typeof overrides.token === 'string') next.token = overrides.token
  if (typeof overrides.provider === 'string') next.provider = overrides.provider
  if (typeof overrides.model === 'string') next.model = overrides.model
  if (typeof overrides.modelTier === 'string') next.modelTier = overrides.modelTier
  if (typeof overrides.agencyEnabled === 'boolean') next.agencyEnabled = overrides.agencyEnabled
  for (const key of ['frameSeconds', 'agencyTokens', 'agencyMinutes']) {
    if (typeof overrides[key] === 'number' && Number.isFinite(overrides[key])) next[key] = overrides[key]
  }
  return next
}

/**
 * Persist the given fields as the complete overrides document. Written to a
 * sibling temp file first so a crash never leaves a half-written file.
 * @param {string} file
 * @param {Record<string, unknown>} section
 * @returns {Record<string, any>}
 */
export function writeOverrides(file, section) {
  /** @type {Record<string, any>} */
  const payload = {}
  for (const key of OVERRIDE_KEYS) {
    const value = section[key]
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      payload[key] = value
    }
  }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ ...payload, updatedAt: Date.now() }, null, 2)}\n`)
  renameSync(tmp, file)
  return payload
}

/**
 * Drop every override so the row config applies again.
 * @param {string} file
 */
export function clearOverrides(file) {
  rmSync(file, { force: true })
}
