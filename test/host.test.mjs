/**
 * Host-half wiring tests: the panel's state route and the settings actions,
 * exercised through a fake context with no network, no LLM, and a temp store.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../plugin/index.js'

/** One throwaway store directory per test. */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cradle-host-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A context with just the services this plugin reaches for. */
function makeCtx({ llm, agentDefaultModel, deferWeb = false } = {}) {
  const routes = new Map()
  const cleanups = []
  const web = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  const services = { llm, agentDefaultModel }
  if (!deferWeb) services.webServer = web
  let pendingWeb = null
  return {
    routes,
    /** Injected contexts expose services as properties, like cordis does. */
    get webServer() {
      return services.webServer
    },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup ?? (() => {})
    },
    get(name) {
      if (name === 'webServer') return services.webServer
      if (name === 'llm') return services.llm
      if (name === 'agentDefaultModel') return services.agentDefaultModel
      return undefined
    },
    inject(deps, callback) {
      if (deps.length === 1 && deps[0] === 'webServer') pendingWeb = callback
      return { dispose: async () => {} }
    },
    /** Simulate the Web carrier mounting after this plugin. */
    provideWeb() {
      services.webServer = web
      pendingWeb?.(this)
    },
    tools: { register: () => () => {} },
    logger: { warn() {} },
    dispose() {
      while (cleanups.length > 0) cleanups.pop()()
    },
  }
}

/** Call the read-only state route. */
function readState(ctx) {
  let payload = null
  let status = 0
  ctx.routes.get('/cradle/state')({ method: 'GET' }, {
    writeHead(code) { status = code },
    end(raw) { payload = JSON.parse(raw) },
  })
  return { status, payload }
}

/** Call one action and wait for the route to answer. */
function callAction(ctx, body) {
  return new Promise((resolve, reject) => {
    const handlers = {}
    const req = {
      method: 'POST',
      on(event, callback) {
        ;(handlers[event] ??= []).push(callback)
        return req
      },
      destroy() {},
    }
    const timer = setTimeout(() => reject(new Error('action timed out')), 5000)
    const res = {
      statusCode: 0,
      writeHead(code) { this.statusCode = code },
      end(raw) {
        clearTimeout(timer)
        resolve({ status: res.statusCode, payload: raw === undefined || raw === '' ? null : JSON.parse(raw) })
      },
    }
    ctx.routes.get('/cradle/action')(req, res)
    const raw = JSON.stringify(body)
    for (const callback of handlers.data ?? []) callback(raw)
    for (const callback of handlers.end ?? []) callback()
  })
}

/** Poll the state route until the advisory catalog has loaded. */
async function waitForCatalog(ctx, timeoutMs = 2000) {
  const started = Date.now()
  for (;;) {
    const { payload } = readState(ctx)
    if ((payload.settings.catalog.groups ?? []).length > 0) return payload
    if (Date.now() - started > timeoutMs) throw new Error('catalog never loaded')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Apply the plugin over a temp store. */
function boot(t, { llm, agentDefaultModel, config } = {}) {
  const dir = tempDir(t)
  const ctx = makeCtx({ llm, agentDefaultModel })
  apply(ctx, {
    enabled: false,
    serverUrl: 'http://127.0.0.1:1',
    statePath: join(dir, 'sovereign.json'),
    ...config,
  })
  t.after(() => ctx.dispose())
  return { ctx, dir }
}

test('the state route exposes settings, the route, and the wire tiers', (t) => {
  const { ctx } = boot(t)
  const { status, payload } = readState(ctx)

  assert.equal(status, 200)
  assert.equal(payload.settings.serverUrl, 'http://127.0.0.1:1')
  assert.equal(payload.settings.saved, false)
  assert.equal(payload.settings.route, null)
  assert.equal(payload.settings.modelTier, 'auto')
  assert.equal(payload.settings.effectiveTier, 'MEDIUM_32B')
  assert.equal(payload.settings.tokenConfigured, false)
  assert.deepEqual(payload.settings.tiers, ['NANO_7B', 'MEDIUM_32B', 'FRONTIER_MAX'])
  assert.equal(payload.identity.modelId, '')
})

test('saving settings persists the file and applies it live', async (t) => {
  const { ctx, dir } = boot(t)
  const saved = await callAction(ctx, {
    action: 'save-settings',
    serverUrl: 'http://127.0.0.1:2/',
    provider: 'wb-proxy',
    model: 'glm-5.3',
    modelTier: 'FRONTIER_MAX',
    token: 'shared-secret',
  })

  assert.equal(saved.status, 200)
  assert.equal(saved.payload.settings.serverUrl, 'http://127.0.0.1:2')
  assert.equal(saved.payload.settings.provider, 'wb-proxy')
  assert.equal(saved.payload.settings.model, 'glm-5.3')
  assert.equal(saved.payload.settings.modelTier, 'FRONTIER_MAX')
  assert.equal(saved.payload.settings.saved, true)
  assert.equal(saved.payload.settings.tokenConfigured, true)
  assert.equal(saved.payload.identity.modelProvider, 'wb-proxy')
  assert.equal(saved.payload.identity.modelId, 'glm-5.3')
  assert.equal(saved.payload.identity.modelTier, 'FRONTIER_MAX')

  const file = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  assert.equal(file.serverUrl, 'http://127.0.0.1:2')
  assert.equal(file.token, 'shared-secret')
})

test('an invalid server URL is refused and nothing is written', async (t) => {
  const { ctx, dir } = boot(t)
  const refused = await callAction(ctx, {
    action: 'save-settings',
    serverUrl: 'not a url',
    provider: '',
    model: '',
    modelTier: '',
  })

  assert.equal(refused.status, 400)
  assert.match(refused.payload.error, /serverUrl/)
  assert.equal(existsSync(join(dir, 'settings.json')), false)
  assert.equal(readState(ctx).payload.settings.serverUrl, 'http://127.0.0.1:1')
})

test('a half-specified model route is refused', async (t) => {
  const { ctx } = boot(t)
  const refused = await callAction(ctx, {
    action: 'save-settings',
    serverUrl: 'http://127.0.0.1:1',
    provider: 'wb-proxy',
    model: '',
  })
  assert.equal(refused.status, 400)
  assert.match(refused.payload.error, /together/)
})

test('reset drops the overrides file and re-inherits the row config', async (t) => {
  const { ctx, dir } = boot(t)
  await callAction(ctx, {
    action: 'save-settings',
    serverUrl: 'http://127.0.0.1:3',
    provider: 'wb-proxy',
    model: 'glm-5.3',
    modelTier: 'NANO_7B',
  })
  assert.equal(existsSync(join(dir, 'settings.json')), true)

  const reset = await callAction(ctx, { action: 'reset-settings' })
  assert.equal(reset.status, 200)
  assert.equal(reset.payload.settings.serverUrl, 'http://127.0.0.1:1')
  assert.equal(reset.payload.settings.provider, '')
  assert.equal(reset.payload.settings.modelTier, 'auto')
  assert.equal(reset.payload.settings.saved, false)
  assert.equal(existsSync(join(dir, 'settings.json')), false)
})

test('an unset model follows the DSH default and derives the tier', (t) => {
  const { ctx } = boot(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'wb-proxy', model: 'deepseek-v4.1-flash' }) },
  })
  const { payload } = readState(ctx)

  assert.deepEqual(payload.settings.route, {
    provider: 'wb-proxy',
    model: 'deepseek-v4.1-flash',
    source: 'dsh-default',
  })
  assert.equal(payload.identity.modelProvider, 'wb-proxy')
  assert.equal(payload.identity.modelId, 'deepseek-v4.1-flash')
  assert.equal(payload.identity.modelTier, 'NANO_7B')
  assert.equal(payload.settings.effectiveTier, 'NANO_7B')
})

test('the panel receives the live model catalog from the LLM service', async (t) => {
  const { ctx } = boot(t, {
    llm: {
      listProviders: () => [{ id: 'wb-proxy', name: 'WB Proxy' }],
      listModels: async () => [{ id: 'glm-5.3', name: 'GLM 5.3' }, { id: 'kimi-k2.6' }],
    },
  })
  const payload = await waitForCatalog(ctx)

  assert.deepEqual(payload.settings.catalog.groups, [{
    id: 'wb-proxy',
    name: 'WB Proxy',
    models: [{ id: 'glm-5.3', name: 'GLM 5.3' }, { id: 'kimi-k2.6', name: 'kimi-k2.6' }],
  }])
  assert.deepEqual(payload.settings.catalog.failures, [])
})

test('a previously saved override survives a restart', async (t) => {
  const dir = tempDir(t)
  const first = makeCtx()
  apply(first, { enabled: false, serverUrl: 'http://127.0.0.1:1', statePath: join(dir, 'sovereign.json') })
  await callAction(first, {
    action: 'save-settings',
    serverUrl: 'http://127.0.0.1:4',
    provider: 'wb-proxy',
    model: 'glm-5.3',
    modelTier: 'MEDIUM_32B',
  })
  first.dispose()

  const second = makeCtx()
  apply(second, { enabled: false, serverUrl: 'http://127.0.0.1:1', statePath: join(dir, 'sovereign.json') })
  t.after(() => second.dispose())
  const { payload } = readState(second)

  assert.equal(payload.settings.serverUrl, 'http://127.0.0.1:4')
  assert.equal(payload.settings.provider, 'wb-proxy')
  assert.equal(payload.settings.model, 'glm-5.3')
  assert.equal(payload.settings.saved, true)
})

test('the routes wait for a web server that mounts later', (t) => {
  const dir = tempDir(t)
  const ctx = makeCtx({ deferWeb: true })
  apply(ctx, { enabled: false, serverUrl: 'http://127.0.0.1:1', statePath: join(dir, 'sovereign.json') })
  t.after(() => ctx.dispose())

  assert.equal(ctx.routes.size, 0, 'no route before the carrier exists')
  ctx.provideWeb()
  assert.equal(ctx.routes.has('/cradle/state'), true)
  assert.equal(ctx.routes.has('/cradle/action'), true)
})
