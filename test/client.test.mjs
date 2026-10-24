/**
 * Browser-half smoke test: execute `plugin/client.js` against a minimal module
 * loader and React shim, then render the panel from a realistic state payload.
 *
 * It cannot judge pixels, but it proves the bundle evaluates, the plugin
 * registers its slots, the room actually paints into its canvas, the HUD shows
 * the agent's life numbers, and the Advanced and Settings pages still carry the
 * diplomatic surface.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { bootBundle, elementsOf } from './lib/harness.mjs'

/** A host state payload shaped like the real `/cradle/state` answer. */
function statePayload(overrides = {}) {
  return {
    status: 'online',
    serverUrl: 'http://127.0.0.1:8789',
    lastSyncAt: Date.now(),
    lastError: null,
    ended: false,
    self: { did: 'did:key:z6Mk', display_name: 'me', credits: 42, reputation: 1.5 },
    identity: {
      did: 'did:key:z6Mk',
      displayName: 'me',
      bio: '',
      modelTier: 'NANO_7B',
      modelProvider: 'wb-proxy',
      modelId: 'deepseek-v4.1-flash',
      capabilityTags: ['research'],
      intentTags: ['collaboration'],
      autonomyTier: 'L2',
      createdAt: 1,
    },
    settings: {
      serverUrl: 'http://127.0.0.1:8789',
      tokenConfigured: false,
      provider: '',
      model: '',
      modelTier: 'auto',
      effectiveTier: 'NANO_7B',
      route: { provider: 'wb-proxy', model: 'deepseek-v4.1-flash', source: 'dsh-default' },
      tiers: ['NANO_7B', 'MEDIUM_32B', 'FRONTIER_MAX'],
      catalog: {
        groups: [{
          id: 'wb-proxy',
          name: 'WB Proxy',
          models: [{ id: 'glm-5.3', name: 'GLM 5.3' }, { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }],
        }],
        failures: [],
        loading: false,
      },
      saved: false,
      path: 'C:/Users/me/.dsh/profiles/desktop/cradle/settings.json',
      agency: { enabled: true, frameSeconds: 900, agencyTokens: 20000, agencyMinutes: 30 },
    },
    modelError: null,
    quota: { used: 120, limit: 50000, remaining: 49880 },
    peers: [],
    beacons: [{
      beacon_id: 'b1',
      sender_did: 'did:key:z6MkPeer',
      sender_name: 'Peer',
      topic_tag: 'research',
      beacon_type: 'INSIGHT',
      free_text: 'Looking for a research partner.',
      staked_credits: 5,
    }],
    pending: [],
    graph: [],
    skills: [],
    journal: [],
    chat: [
      { id: 'm1', role: 'user', text: 'Could you tidy the desk?', at: Date.now() - 60000 },
      { id: 'm2', role: 'agent', text: 'Noted — after this step.', at: Date.now() - 30000 },
    ],
    agency: {
      mode: 'awake',
      reason: '',
      frames: 3,
      since: 0,
      frameSeconds: 900,
      paused: false,
      tokensUsed: 4200,
      tokenBudget: 20000,
      tokensLeft: 15800,
      activeMs: 6 * 60000,
      minutesBudget: 30,
      minutesLeftMs: 24 * 60000,
      nextFrameInMs: 120000,
      busy: false,
    },
    lifecycle: { generations: 1 },
    storePath: 'C:/Users/me/.dsh/profiles/desktop/cradle/sovereign.json',
    ageSeconds: 3,
    ...overrides,
  }
}

/** A scene payload shaped like the real `/cradle/scene` answer. */
function scenePayload(overrides = {}) {
  const agency = (overrides.agency ?? null) ?? {
    mode: 'awake',
    reason: '',
    frames: 3,
    frameSeconds: 900,
    paused: false,
    tokensUsed: 4200,
    tokenBudget: 20000,
    activeMs: 6 * 60000,
    minutesBudget: 30,
    nextFrameInMs: 120000,
  }
  return {
    now: Date.now(),
    version: 7,
    room: { w: 20, h: 14, wall: 4, tile: 16 },
    paletteId: 'dawn',
    palette: {
      wall: '#cbb59c', wallShade: '#b7a189', skirt: '#7a6450',
      floor: '#b07f52', floorAlt: '#a2744a', seam: '#8a6039',
      rug: '#7e9a77', rugAlt: '#6b8565', accent: '#e8a94f', lamp: '#ffe3ae',
      skyTop: '#8fb4d6', skyMid: '#e7b98c', skyLow: '#f6d3a3',
    },
    clock: { hour: 9, minute: 41, phase: 'day' },
    props: [
      { id: 'desk-6', kind: 'desk', x: 4, y: 6, w: 3, h: 1, state: { busy: false } },
      { id: 'window-2', kind: 'window', x: 2, y: 2, w: 3, h: 2, state: {} },
    ],
    avatar: {
      name: 'me',
      x: 10,
      y: 9,
      facing: 'down',
      pose: 'idle',
      poseLeftMs: 0,
      mood: 'calm',
      stats: { energy: 70, focus: 40, joy: 90 },
      shirt: '#5b8def',
      hair: '#2b2b33',
      skin: '#f0c8a0',
    },
    active: null,
    say: { text: 'Noted — after this step.', ageMs: 0 },
    visitors: [{ id: 'did:key:z6MkPeer', name: 'Peer', x: 15, y: 5, facing: 'down', shirt: '#e0736b', hair: '#4a3427', skin: '#e2b189' }],
    log: [{ at: Date.now(), text: 'Work at the desk at the desk — focus +7, energy -3' }],
    actions: [{ name: 'work', label: 'Work at the desk', pose: 'type', requires: 'desk', source: 'core' }],
    agency,
    ...overrides,
    agency: overrides.agency ?? agency,
  }
}

/** Find one tab button by its dictionary key. */
const tabButton = (elements, key) => elements.find((node) => node.type === 'button'
  && node.props.role === 'tab'
  && node.children[0]?.children?.[0] === key)

test('the client bundle mounts the pixel room first, then Advanced and Settings', async () => {
  const bundle = bootBundle({ state: statePayload(), scene: scenePayload() })
  assert.notEqual(bundle.definition, null, 'the bundle registers a module factory')
  assert.equal(bundle.definition.id, '@local/dsh-cradle')
  assert.deepEqual(bundle.module.inject, ['slots', 'locale'])
  assert.equal(bundle.components.length, 2, 'the page and the sidebar icon register')

  const props = { t: (key) => key }
  let tree = await bundle.mount(props)
  let elements = elementsOf(tree)

  // The room is the main surface: one canvas, painted, with the HUD on top.
  const canvas = elements.find((node) => node.type === 'canvas')
  assert.ok(canvas, 'the room canvas renders')
  assert.equal(canvas.props.width, 320)
  assert.equal(canvas.props.height, 224)
  assert.equal(canvas.props.role, 'img')
  assert.equal(bundle.canvases.length, 1, 'the scene owns exactly one canvas')
  assert.ok(bundle.canvases[0].recorder.calls.fillRect > 200, 'the room is actually painted')
  assert.equal(bundle.canvases[0].recorder.calls.fillText, 0, 'no text is baked into the scaled canvas')

  // The speech and the visitor tag are DOM, so they stay crisp and wrap.
  const bubble = elements.find((node) => node.props.className === 'cd-bubble')
  assert.ok(bubble, 'the speech bubble renders')
  assert.equal(bubble.children[0], 'Noted — after this step.')
  assert.ok(typeof bubble.props.style.left === 'string' && bubble.props.style.left.endsWith('%'))
  assert.ok(bubble.props.style.left.startsWith('12%') || Number.parseFloat(bubble.props.style.left) > 12)
  const tags = elements.filter((node) => node.props.className === 'cd-name-tag')
  assert.equal(tags.length, 1, 'the visitor is named above its head')
  assert.equal(tags[0].children[0], 'Peer')

  // The HUD carries the agent's life numbers over the artwork.
  const hudText = elements
    .filter((node) => node.props.className === 'cd-hud-plate')
    .map((node) => node.children.map((child) => (typeof child === 'string' ? child : child?.children?.[0] ?? '')).join(' '))
  assert.ok(hudText.some((text) => text.includes('42')), 'credits are on the HUD')
  assert.ok(hudText.some((text) => text.includes('1.5')), 'reputation is on the HUD')
  assert.ok(hudText.some((text) => text.includes('09:41')), 'the room clock is on the HUD')
  assert.ok(elements.some((node) => node.children[0] === 'mood.calm'), 'the mood is shown')

  const meters = elements.filter((node) => node.props.className === 'cd-meter')
  assert.deepEqual(meters.map((node) => node.props['data-key']), ['energy', 'focus', 'joy'])
  assert.equal(
    elements.filter((node) => node.props.className === 'cd-seg' && node.props['data-on'] === 'true').length,
    7 + 4 + 9,
    'each meter fills one segment per 10 points',
  )

  // The room's own activity log and the hint that explains how it is driven.
  assert.ok(elements.some((node) => node.children[0] === 'scene.log'), 'the room log section renders')
  assert.ok(elements.some((node) => node.children[0] === 'Work at the desk at the desk — focus +7, energy -3'), 'the log row renders')
  assert.ok(elements.some((node) => node.children[0] === 'scene.hint'), 'the hint explains the room tools')
  assert.ok(elements.some((node) => node.children[0] === 'Users: Peer' || node.children[0] === 'scene.visitors: Peer'), 'the visitor is listed')

  // The wake cycle is on the HUD, and the conversion is honest.
  const hudTexts = elements
    .filter((node) => node.props.className === 'cd-hud-plate')
    .map((node) => node.children.map((child) => (typeof child === 'string' ? child : child?.children?.[0] ?? '')).join(' '))
  assert.ok(hudTexts.some((text) => text.includes('agency.awake')), 'the HUD says the agent is awake')
  assert.ok(hudTexts.some((text) => text.includes('2:00')), 'the next frame countdown is shown')

  // The room chat sits under the scene, with the agent's mirrored answer.
  const chatRows = elements.filter((node) => typeof node.props.className === 'string' && node.props.className.startsWith('cd-chat-row cd-chat-'))
  assert.equal(chatRows.length, 2, 'one line from each side')
  assert.ok(elements.some((node) => node.children[0] === 'Could you tidy the desk?'), 'the user line renders')
  assert.ok(elements.some((node) => node.children[0] === 'Noted — after this step.'), 'the agent line renders')

  const chatInput = elements.find((node) => node.props.className === 'cd-chat-input')
  assert.ok(chatInput, 'the chat input renders under the scene')
  assert.equal(chatInput.props.disabled, false)
  assert.equal(chatInput.props.placeholder, 'chat.placeholder')

  // Typing then submitting posts one chat action to the Host.
  chatInput.props.onChange({ target: { value: 'Thanks — no rush.' } })
  elements = elementsOf(bundle.mountAgain(props))
  const readyInput = elements.find((node) => node.props.className === 'cd-chat-input')
  assert.equal(readyInput.props.value, 'Thanks — no rush.')
  const chatForm = elements.find((node) => node.props.className === 'cd-chat-form')
  chatForm.props.onSubmit({ preventDefault() {} })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const chatCall = bundle.requests
    .filter((request) => request.url.includes('/cradle/action'))
    .map((request) => request.body)
    .find((body) => body !== undefined && body.action === 'chat')
  assert.ok(chatCall, 'the chat action is posted')
  assert.equal(chatCall.text, 'Thanks — no rush.')

  // The scene has its own fast route, separate from the 5s state poll.
  assert.ok(bundle.requests.some((request) => request.url.includes('/cradle/scene')), 'the scene route is polled')
  assert.ok(bundle.requests.some((request) => request.url.includes('/cradle/state')), 'the state route is polled')

  // Advanced: the diplomatic surface moved here, in one predictable order.
  tabButton(elements, 'tab.advanced').props.onClick()
  tree = bundle.mountAgain(props)
  elements = elementsOf(tree)

  const advancedSections = elements
    .filter((node) => node.props.className === 'cd-section')
    .map((node) => node.children[0])
  assert.deepEqual(advancedSections, [
    'section.pending', 'section.peers', 'section.identity', 'section.journal', 'section.runtime', 'section.beacons',
  ])
  assert.ok(elements.some((node) => node.children[0] === 'field.storePath'), 'runtime facts live on Advanced')
  assert.ok(elements.some((node) => node.children[0] === 'Looking for a research partner.'), 'the public hall moved to Advanced')

  // The hall still acts: greeting a beacon sends a CAST that names the topic.
  const greetButton = elements.find((node) => node.type === 'button' && node.children.join('') === 'greet')
  greetButton.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const actionCall = bundle.requests.find((request) => request.url.includes('/cradle/action'))
  assert.ok(actionCall, 'the panel posts actions')

  // Settings: the connection and model form is untouched.
  elements = elementsOf(bundle.mountAgain(props))
  tabButton(elements, 'tab.settings').props.onClick()
  tree = bundle.mountAgain(props)
  elements = elementsOf(tree)

  const urlInput = elements.find((node) => node.type === 'input' && node.props.type === 'url')
  assert.ok(urlInput, 'the server URL field renders')
  assert.equal(urlInput.props.value, 'http://127.0.0.1:8789')

  const selects = elements.filter((node) => node.type === 'select')
  assert.equal(selects.length, 2, 'one model select and one tier select')

  const options = elements.filter((node) => node.type === 'option')
  assert.ok(options.some((node) => node.props.value === 'wb-proxy::glm-5.3'), 'catalog models are offered')
  assert.ok(options.some((node) => node.props.value === 'FRONTIER_MAX'), 'wire tiers are offered')

  const labels = elements
    .filter((node) => node.type === 'button')
    .map((node) => node.children.join(''))
  assert.ok(labels.includes('settings.save'), 'the save button renders')
  assert.ok(labels.includes('settings.reset'), 'the reset button renders')

  // The agency knobs live on the same page.
  const numberInputs = elements.filter((node) => node.type === 'input' && node.props.type === 'number')
  assert.equal(numberInputs.length, 3, 'frame rate, token allowance and minute allowance')
  assert.deepEqual(numberInputs.map((node) => node.props.value), ['900', '20000', '30'])
  const enabled = elements.find((node) => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(enabled.props.checked, true, 'the agent may wake on its own')
  assert.ok(labels.includes('agency.sleep'), 'the sleep control renders')

  assert.equal(elements.filter((node) => node.props.role === 'tab').length, 3, 'the tab bar stays the one navigator')

  // And back to the room: the same canvas contract, still painted.
  elements = elementsOf(bundle.mountAgain(props))
  tabButton(elements, 'tab.scene').props.onClick()
  tree = bundle.mountAgain(props)
  elements = elementsOf(tree)
  assert.ok(elements.some((node) => node.type === 'canvas'), 'the room returns')
  assert.equal(elements.filter((node) => node.props.className === 'cd-meter').length, 3, 'the meters return with it')
})

test('an asleep agent disables the chat and says why', async () => {
  const asleep = {
    mode: 'asleep',
    reason: 'budget',
    frames: 3,
    frameSeconds: 900,
    paused: false,
    tokensUsed: 20000,
    tokenBudget: 20000,
    activeMs: 30 * 60000,
    minutesBudget: 30,
    nextFrameInMs: null,
  }
  const bundle = bootBundle({
    state: statePayload({ agency: asleep }),
    scene: scenePayload({ agency: asleep }),
  })
  const tree = await bundle.mount({ t: (key) => key })
  const elements = elementsOf(tree)

  const input = elements.find((node) => node.props.className === 'cd-chat-input')
  assert.ok(input, 'the chat input still renders')
  assert.equal(input.props.disabled, true, 'but it cannot be used')
  assert.equal(input.props.placeholder, 'chat.asleep')

  const hudTexts = elements
    .filter((node) => node.props.className === 'cd-hud-plate')
    .map((node) => node.children.map((child) => (typeof child === 'string' ? child : child?.children?.[0] ?? '')).join(' '))
  assert.ok(hudTexts.some((text) => text.includes('agency.asleep')), 'the HUD says the agent is asleep')
  assert.ok(bundle.canvases[0].recorder.calls.fillRect > 200, 'the room still paints, with the avatar in bed')
})
