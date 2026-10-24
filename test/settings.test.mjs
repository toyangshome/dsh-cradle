/**
 * Unit tests for the runtime settings layer: precedence, validation,
 * persistence, and the tier heuristic.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTO_TIER, clearOverrides, mergeOverrides, normalizeModelTier, normalizeRoute,
  readOverrides, resolveSettings, settingsFileFor, tierForModel, validateServerUrl,
  writeOverrides,
} from '../plugin/lib/settings.js'

/** One throwaway directory per test. */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cradle-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('resolveSettings fills defaults and normalizes the row config', () => {
  const settings = resolveSettings({
    serverUrl: 'http://example.test:8789/',
    modelTier: 'FRONTIER_MAX',
    autonomyTier: 'l3',
    provider: 'wb-proxy',
    model: 'glm-5.3',
    dailyTokenLimit: 1,
  })
  assert.equal(settings.serverUrl, 'http://example.test:8789')
  assert.equal(settings.modelTier, 'FRONTIER_MAX')
  assert.equal(settings.autonomyTier, 'L3')
  assert.equal(settings.provider, 'wb-proxy')
  assert.equal(settings.model, 'glm-5.3')
  assert.equal(settings.dailyTokenLimit, 1000, 'clamped to the lower bound')
  assert.equal(settings.heartbeatMs, 15000)
  assert.equal(settings.token, '')
})

test('an absent tier means automatic, and a broken route is dropped', () => {
  const settings = resolveSettings({ provider: 'wb-proxy' })
  assert.equal(settings.modelTier, AUTO_TIER)
  assert.equal(settings.provider, '')
  assert.equal(settings.model, '')
})

test('validateServerUrl accepts http(s) bases and rejects the rest', () => {
  assert.deepEqual(validateServerUrl('https://cradle.example/v1/'), { ok: true, value: 'https://cradle.example/v1' })
  assert.equal(validateServerUrl('').ok, false)
  assert.equal(validateServerUrl('cradle.example').ok, false)
  assert.equal(validateServerUrl('ftp://cradle.example').ok, false)
  assert.equal(validateServerUrl('http://cradle.example/?a=1').ok, false)
  assert.equal(validateServerUrl('http://cradle.example/#x').ok, false)
})

test('normalizeRoute requires both halves or neither', () => {
  assert.deepEqual(normalizeRoute('', ''), { ok: true, provider: '', model: '' })
  assert.deepEqual(normalizeRoute(' wb-proxy ', ' glm-5.3 '), { ok: true, provider: 'wb-proxy', model: 'glm-5.3' })
  assert.equal(normalizeRoute('wb-proxy', '').ok, false)
  assert.equal(normalizeRoute('', 'glm-5.3').ok, false)
})

test('normalizeModelTier maps blanks and auto to automatic', () => {
  assert.equal(normalizeModelTier(undefined), AUTO_TIER)
  assert.equal(normalizeModelTier(''), AUTO_TIER)
  assert.equal(normalizeModelTier('auto'), AUTO_TIER)
  assert.equal(normalizeModelTier('nano_7b'), 'NANO_7B')
  assert.equal(normalizeModelTier('FRONTIER_MAX'), 'FRONTIER_MAX')
  assert.equal(normalizeModelTier('huge'), null)
})

test('tierForModel derives a wire tier from a real model id', () => {
  assert.equal(tierForModel('deepseek-v4.1-flash'), 'NANO_7B')
  assert.equal(tierForModel('glm-5.3'), 'MEDIUM_32B')
  assert.equal(tierForModel('kimi-k2.6-max'), 'FRONTIER_MAX')
  assert.equal(tierForModel(''), 'MEDIUM_32B')
})

test('settings file lives beside the sovereign store', () => {
  const store = join('C:', 'Users', 'me', '.dsh', 'profiles', 'desktop', 'cradle', 'sovereign.json')
  assert.equal(settingsFileFor(store), join('C:', 'Users', 'me', '.dsh', 'profiles', 'desktop', 'cradle', 'settings.json'))
  assert.equal(settingsFileFor('/tmp/cradle/sovereign.json'), join('/tmp/cradle', 'settings.json'))
})

test('overrides win over the row config and survive a round trip', (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'settings.json')
  const row = resolveSettings({ serverUrl: 'http://127.0.0.1:8789', modelTier: 'MEDIUM_32B' })

  writeOverrides(file, {
    serverUrl: 'http://10.0.0.5:9000',
    provider: 'wb-proxy',
    model: 'glm-5.3',
    modelTier: '',
    ignored: 'nope',
  })

  const stored = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(stored.ignored, undefined, 'only known fields persist')
  assert.equal(typeof stored.updatedAt, 'number')

  const merged = mergeOverrides(row, readOverrides(file))
  assert.equal(merged.serverUrl, 'http://10.0.0.5:9000')
  assert.equal(merged.provider, 'wb-proxy')
  assert.equal(merged.model, 'glm-5.3')
  assert.equal(merged.modelTier, AUTO_TIER)
})

test('a malformed or invalid overrides file degrades field by field', (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'settings.json')
  const row = resolveSettings({ serverUrl: 'http://127.0.0.1:8789' })

  writeFileSync(file, '{not json')
  assert.deepEqual(readOverrides(file), {})
  assert.equal(mergeOverrides(row, readOverrides(file)).serverUrl, 'http://127.0.0.1:8789')

  writeFileSync(file, JSON.stringify({ serverUrl: 'ftp://nope', model: 'only-model', modelTier: 'bogus' }))
  assert.deepEqual(readOverrides(file), {}, 'invalid values are dropped, not trusted')
})

test('the agency knobs persist as numbers and booleans and override the row', (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'settings.json')
  const row = resolveSettings({ serverUrl: 'http://127.0.0.1:8789', frameSeconds: 900, agencyTokens: 20000 })
  assert.equal(row.agencyEnabled, true)
  assert.equal(row.frameSeconds, 900)
  assert.equal(row.agencyTokens, 20000)
  assert.equal(row.agencyMinutes, 30)

  writeOverrides(file, { frameSeconds: 60, agencyTokens: 0, agencyMinutes: 0, agencyEnabled: false })
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(stored.frameSeconds, 60)
  assert.equal(stored.agencyTokens, 0, 'zero survives as "no limit"')
  assert.equal(stored.agencyEnabled, false)

  const merged = mergeOverrides(row, readOverrides(file))
  assert.equal(merged.frameSeconds, 60)
  assert.equal(merged.agencyTokens, 0)
  assert.equal(merged.agencyMinutes, 0)
  assert.equal(merged.agencyEnabled, false)

  // Out-of-range values are clamped, not rejected outright.
  writeFileSync(file, JSON.stringify({ frameSeconds: 1, agencyTokens: -5, agencyMinutes: 99999 }))
  const clamped = mergeOverrides(row, readOverrides(file))
  assert.equal(clamped.frameSeconds, 30)
  assert.equal(clamped.agencyTokens, 0)
  assert.equal(clamped.agencyMinutes, 1440)
})

test('clearOverrides re-inherits the row config', (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'settings.json')
  const row = resolveSettings({ serverUrl: 'http://127.0.0.1:8789' })
  writeOverrides(file, { serverUrl: 'http://elsewhere:1', provider: 'p', model: 'm' })
  assert.equal(readOverrides(file).serverUrl, 'http://elsewhere:1')

  clearOverrides(file)
  assert.deepEqual(readOverrides(file), {})
  assert.equal(mergeOverrides(row, readOverrides(file)).serverUrl, 'http://127.0.0.1:8789')
})

test('a token can be cleared explicitly but an absent one keeps the row value', (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'settings.json')
  const row = resolveSettings({ serverUrl: 'http://127.0.0.1:8789', token: 'row-token' })

  writeOverrides(file, { serverUrl: 'http://127.0.0.1:8789', token: 'saved-token' })
  assert.equal(mergeOverrides(row, readOverrides(file)).token, 'saved-token')

  writeOverrides(file, { serverUrl: 'http://127.0.0.1:8789', token: '' })
  assert.equal(mergeOverrides(row, readOverrides(file)).token, '')
})
