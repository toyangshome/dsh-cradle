/**
 * Agency: the agent's own clock.
 *
 * Cradle's agent is not only reactive. It wakes on its own "frame rate", looks
 * at its room, and decides whether to do anything. That autonomy costs the
 * user's model budget, so it is bounded twice — by tokens and by active
 * minutes — and when either budget runs out the agent goes to sleep: no frames,
 * no tools, no chat until the user wakes it.
 *
 * This module is the pure bookkeeping behind that: no timers, no I/O, no agent
 * handle. The host half owns the scheduling and the model calls; here we only
 * decide what the numbers mean, which is what the unit tests exercise.
 */

/** The agent is either awake (may act) or asleep (may not). */
export const AGENCY_MODES = ['awake', 'asleep']
/** Why the agent is asleep. `budget` refills on a new day; `manual` does not. */
export const SLEEP_REASONS = ['budget', 'manual']

/** @param {number} now @returns {string} local calendar day, e.g. `2026-10-23`. */
export function dayKey(now = Date.now()) {
  return new Date(now).toLocaleDateString('sv-SE')
}

/** @param {number} [now] @returns {any} a fresh, awake agency state. */
export function createAgency(now = Date.now()) {
  return {
    mode: 'awake',
    reason: '',
    since: 0,
    day: dayKey(now),
    tokens: 0,
    activeMs: 0,
    frames: 0,
    lastFrameAt: 0,
    lastSleepAt: 0,
    lastWakeAt: now,
  }
}

/**
 * Repair a stored agency state. Unknown modes fall back to awake, counters are
 * clamped, and yesterday's usage is rolled over before it reaches the budget.
 * @param {any} raw
 * @param {number} [now]
 * @returns {any}
 */
export function normalizeAgency(raw, now = Date.now()) {
  const fresh = createAgency(now)
  if (raw === null || typeof raw !== 'object') return fresh
  const mode = AGENCY_MODES.includes(raw.mode) ? raw.mode : 'awake'
  const reason = SLEEP_REASONS.includes(raw.reason) ? raw.reason : ''
  const agency = {
    ...fresh,
    mode,
    reason: mode === 'asleep' ? (reason || 'manual') : '',
    since: Number.isFinite(raw.since) ? raw.since : 0,
    day: typeof raw.day === 'string' && raw.day !== '' ? raw.day : fresh.day,
    tokens: Math.max(0, Number.isFinite(raw.tokens) ? raw.tokens : 0),
    activeMs: Math.max(0, Number.isFinite(raw.activeMs) ? raw.activeMs : 0),
    frames: Math.max(0, Number.isFinite(raw.frames) ? Math.trunc(raw.frames) : 0),
    lastFrameAt: Number.isFinite(raw.lastFrameAt) ? raw.lastFrameAt : 0,
    lastSleepAt: Number.isFinite(raw.lastSleepAt) ? raw.lastSleepAt : 0,
    lastWakeAt: Number.isFinite(raw.lastWakeAt) ? raw.lastWakeAt : now,
  }
  rollDay(agency, now)
  return agency
}

/**
 * Reset the counters when the local date changes, and let a budget sleep end
 * with the old day: a new allowance means a new chance to act.
 * @param {any} agency @param {number} now
 * @returns {boolean} whether anything changed.
 */
export function rollDay(agency, now = Date.now()) {
  const today = dayKey(now)
  if (agency.day === today) return false
  agency.day = today
  agency.tokens = 0
  agency.activeMs = 0
  agency.frames = 0
  if (agency.mode === 'asleep' && agency.reason === 'budget') {
    agency.mode = 'awake'
    agency.reason = ''
    agency.since = 0
    agency.lastWakeAt = now
  }
  return true
}

/**
 * The budgets in effect. Zero means "no limit" for that dimension.
 * @param {{ agencyTokens: number, agencyMinutes: number }} settings
 * @returns {{ tokens: number, minutes: number }}
 */
export function budgetsOf(settings) {
  return {
    tokens: Math.max(0, Math.trunc(Number(settings.agencyTokens) || 0)),
    minutes: Math.max(0, Math.trunc(Number(settings.agencyMinutes) || 0)),
  }
}

/**
 * @param {any} agency @param {{ agencyTokens: number, agencyMinutes: number }} settings
 * @returns {{ kind: 'tokens' | 'minutes', used: number, budget: number } | null}
 */
export function exhaustion(agency, settings) {
  const budgets = budgetsOf(settings)
  if (budgets.tokens > 0 && agency.tokens >= budgets.tokens) {
    return { kind: 'tokens', used: agency.tokens, budget: budgets.tokens }
  }
  if (budgets.minutes > 0 && agency.activeMs >= budgets.minutes * 60000) {
    return { kind: 'minutes', used: agency.activeMs, budget: budgets.minutes * 60000 }
  }
  return null
}

/**
 * @param {any} agency @param {number} tokens @param {number} activeMs
 */
export function addUsage(agency, tokens, activeMs) {
  if (Number.isFinite(tokens) && tokens > 0) agency.tokens += Math.trunc(tokens)
  if (Number.isFinite(activeMs) && activeMs > 0) agency.activeMs += Math.trunc(activeMs)
}

/**
 * @param {any} agency @param {'budget' | 'manual'} reason @param {number} [now]
 */
export function putToSleep(agency, reason, now = Date.now()) {
  agency.mode = 'asleep'
  agency.reason = reason
  agency.since = now
  agency.lastSleepAt = now
  return agency
}

/**
 * Wake the agent. Waking after a budget sleep starts a fresh allowance, because
 * only the user can do it and they are asking for exactly that.
 * @param {any} agency @param {number} [now]
 * @param {{ replenish?: boolean }} [options]
 */
export function wakeUp(agency, now = Date.now(), options = {}) {
  const replenish = options.replenish ?? agency.reason === 'budget'
  agency.mode = 'awake'
  agency.reason = ''
  agency.since = 0
  agency.lastWakeAt = now
  if (replenish) {
    agency.tokens = 0
    agency.activeMs = 0
    agency.frames = 0
  }
  return agency
}

/**
 * The compact view the panel, the scene and `cradle_status` share.
 * @param {any} agency
 * @param {{ agencyEnabled: boolean, frameSeconds: number, agencyTokens: number, agencyMinutes: number }} settings
 * @param {{ now?: number, nextFrameAt?: number, busy?: boolean }} [extra]
 * @returns {any}
 */
export function describeAgency(agency, settings, extra = {}) {
  const now = Number.isFinite(extra.now) ? extra.now : Date.now()
  const budgets = budgetsOf(settings)
  const minutesBudgetMs = budgets.minutes * 60000
  return {
    mode: agency.mode,
    reason: agency.reason,
    frames: agency.frames,
    since: agency.since,
    frameSeconds: Math.max(0, Math.trunc(Number(settings.frameSeconds) || 0)),
    paused: settings.agencyEnabled === false,
    tokensUsed: Math.trunc(agency.tokens),
    tokenBudget: budgets.tokens,
    tokensLeft: budgets.tokens === 0 ? -1 : Math.max(0, budgets.tokens - agency.tokens),
    activeMs: Math.trunc(agency.activeMs),
    minutesBudget: budgets.minutes,
    minutesLeftMs: minutesBudgetMs === 0 ? -1 : Math.max(0, minutesBudgetMs - agency.activeMs),
    nextFrameInMs: Number.isFinite(extra.nextFrameAt) ? Math.max(0, extra.nextFrameAt - now) : null,
    busy: extra.busy === true,
  }
}

/**
 * One line for a model-facing tool result.
 * @param {any} view
 * @returns {string}
 */
export function describeAgencyLine(view) {
  if (view.mode === 'asleep') {
    return `Asleep (${view.reason === 'budget' ? 'agency budget exhausted' : 'put to sleep by the user'}) since ${new Date(view.since).toLocaleTimeString()}. No action is possible until the user wakes you in the Cradle panel.`
  }
  const tokens = view.tokenBudget === 0 ? `${view.tokensUsed} tokens (no limit)` : `${view.tokensUsed}/${view.tokenBudget} tokens`
  const minutes = view.minutesBudget === 0
    ? `${Math.round(view.activeMs / 60000)} min (no limit)`
    : `${Math.round(view.activeMs / 60000)}/${view.minutesBudget} min`
  const next = view.nextFrameInMs === null ? '' : ` · next frame in ${Math.max(0, Math.round(view.nextFrameInMs / 1000))}s`
  return `Awake${view.paused ? ' (frames paused)' : ''} · ${view.frames} frames today · ${tokens} · ${minutes}${next}`
}
