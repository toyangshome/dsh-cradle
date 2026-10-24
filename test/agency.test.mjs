/**
 * The agency model: the frame clock's budget arithmetic, sleep and wake. Pure
 * functions, no timers, no agent handle.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addUsage, budgetsOf, createAgency, dayKey, describeAgency, describeAgencyLine, exhaustion,
  normalizeAgency, putToSleep, rollDay, wakeUp,
} from '../plugin/lib/agency.js'

const SETTINGS = { agencyEnabled: true, frameSeconds: 900, agencyTokens: 20000, agencyMinutes: 30 }

test('a fresh agency starts awake with a clean daily allowance', () => {
  const agency = createAgency(1_700_000_000_000)
  assert.equal(agency.mode, 'awake')
  assert.equal(agency.tokens, 0)
  assert.equal(agency.activeMs, 0)
  assert.equal(agency.frames, 0)
  assert.equal(agency.day, dayKey(1_700_000_000_000))
  assert.equal(normalizeAgency(null).mode, 'awake', 'a missing state is a fresh one')
})

test('a damaged store file is repaired instead of trusted', () => {
  const repaired = normalizeAgency({
    mode: 'sleeping', reason: 'nap', tokens: -5, activeMs: -1, frames: 'many', day: 42, lastFrameAt: 'x',
  }, 1_700_000_000_000)
  assert.equal(repaired.mode, 'awake', 'an unknown mode falls back to awake')
  assert.equal(repaired.reason, '')
  assert.equal(repaired.tokens, 0)
  assert.equal(repaired.activeMs, 0)
  assert.equal(repaired.frames, 0)
  assert.equal(repaired.day, dayKey(1_700_000_000_000))
  assert.equal(repaired.lastFrameAt, 0)
})

test('budgets count up and the limit is reported with its kind', () => {
  const agency = createAgency()
  assert.equal(exhaustion(agency, SETTINGS), null)

  addUsage(agency, 12000, 5 * 60000)
  assert.equal(agency.tokens, 12000)
  assert.equal(agency.activeMs, 5 * 60000)
  assert.equal(exhaustion(agency, SETTINGS), null)

  addUsage(agency, 8000, 0)
  assert.deepEqual(exhaustion(agency, SETTINGS), { kind: 'tokens', used: 20000, budget: 20000 })

  addUsage(agency, 0, 25 * 60000)
  assert.deepEqual(exhaustion(agency, SETTINGS), { kind: 'tokens', used: 20000, budget: 20000 })

  const timeOnly = { ...agency, tokens: 0, activeMs: 30 * 60000 }
  assert.deepEqual(exhaustion(timeOnly, SETTINGS), { kind: 'minutes', used: 30 * 60000, budget: 30 * 60000 })

  // Zero means "no limit" on that dimension.
  const unlimited = { ...agency, tokens: 999999, activeMs: 999999 }
  assert.equal(exhaustion(unlimited, { ...SETTINGS, agencyTokens: 0, agencyMinutes: 0 }), null)
  assert.deepEqual(budgetsOf({ agencyTokens: 0, agencyMinutes: 0 }), { tokens: 0, minutes: 0 })
})

test('sleeping and waking: only a budget sleep starts a fresh allowance', () => {
  const agency = createAgency()
  addUsage(agency, 20000, 60000)
  putToSleep(agency, 'budget', 1000)
  assert.equal(agency.mode, 'asleep')
  assert.equal(agency.reason, 'budget')
  assert.equal(agency.since, 1000)

  wakeUp(agency, 2000)
  assert.equal(agency.mode, 'awake')
  assert.equal(agency.reason, '')
  assert.equal(agency.tokens, 0, 'a budget sleep refills when the user wakes it')
  assert.equal(agency.activeMs, 0)

  const manual = createAgency()
  addUsage(manual, 5000, 120000)
  putToSleep(manual, 'manual', 3000)
  wakeUp(manual, 4000)
  assert.equal(manual.tokens, 5000, 'a manual nap keeps the spend')
  assert.equal(manual.activeMs, 120000)
})

test('a new day rolls the counters and ends a budget sleep', () => {
  const agency = createAgency(Date.parse('2026-10-22T23:00:00'))
  addUsage(agency, 20000, 30 * 60000)
  putToSleep(agency, 'budget', Date.parse('2026-10-22T23:30:00'))

  assert.equal(rollDay(agency, Date.parse('2026-10-22T23:59:00')), false, 'same day, nothing changes')
  assert.equal(agency.mode, 'asleep')

  assert.equal(rollDay(agency, Date.parse('2026-10-23T00:01:00')), true)
  assert.equal(agency.day, dayKey(Date.parse('2026-10-23T00:01:00')))
  assert.equal(agency.tokens, 0)
  assert.equal(agency.activeMs, 0)
  assert.equal(agency.mode, 'awake', 'a budget sleep ends with the old day')

  // A manual sleep survives the rollover: only the user can end it.
  const manual = createAgency(Date.parse('2026-10-22T23:00:00'))
  putToSleep(manual, 'manual', Date.parse('2026-10-22T23:10:00'))
  rollDay(manual, Date.parse('2026-10-23T00:10:00'))
  assert.equal(manual.mode, 'asleep')
})

test('the shared view and its one-line summary agree', () => {
  const agency = createAgency()
  addUsage(agency, 4200, 6 * 60000)
  const view = describeAgency(agency, SETTINGS, { now: 10000, nextFrameAt: 70000, busy: true })

  assert.equal(view.mode, 'awake')
  assert.equal(view.tokensUsed, 4200)
  assert.equal(view.tokenBudget, 20000)
  assert.equal(view.tokensLeft, 15800)
  assert.equal(view.minutesLeftMs, 24 * 60000)
  assert.equal(view.nextFrameInMs, 60000)
  assert.equal(view.busy, true)
  assert.match(describeAgencyLine(view), /^Awake/)
  assert.match(describeAgencyLine(view), /4200\/20000 tokens/)
  assert.match(describeAgencyLine(view), /6\/30 min/)

  const unlimited = describeAgency(agency, { ...SETTINGS, agencyTokens: 0, agencyMinutes: 0 })
  assert.equal(unlimited.tokensLeft, -1)
  assert.equal(unlimited.minutesLeftMs, -1)
  assert.match(describeAgencyLine(unlimited), /no limit/)

  putToSleep(agency, 'budget', 5000)
  const asleep = describeAgency(agency, SETTINGS)
  assert.match(describeAgencyLine(asleep), /^Asleep \(agency budget exhausted\)/)

  const paused = describeAgency(agency, { ...SETTINGS, agencyEnabled: false })
  assert.equal(paused.paused, true)
  assert.match(describeAgencyLine({ ...paused, mode: 'awake' }), /frames paused/)
})
