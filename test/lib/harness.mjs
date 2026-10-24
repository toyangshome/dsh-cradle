/**
 * A very small React + DOM stand-in for testing the browser half.
 *
 * It renders the panel without a browser: function components are expanded,
 * refs resolve to stub nodes, effects run after the tree is complete, and a
 * canvas stub records the paint calls so a test can assert that the room was
 * actually drawn.
 */

import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../plugin/client.js', import.meta.url), 'utf8')

/** Minimal React: one hook bucket per component, effects after each render. */
export function createHarness() {
  const instances = new Map()
  let current = null
  let pending = []
  let dirty = false

  const hook = (initial) => {
    const index = current.cursor++
    if (current.slots[index] === undefined) current.slots[index] = { value: typeof initial === 'function' ? initial() : initial }
    return current.slots[index]
  }

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const slot = hook(initial)
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        dirty = true
      }]
    },
    useEffect(effect) { pending.push(effect) },
    useCallback(callback) { return callback },
    useRef(initial) {
      const slot = hook(undefined)
      if (slot.ref === undefined) slot.ref = { current: initial ?? null }
      return slot.ref
    },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
  }

  const resolveRefs = (node, registry) => {
    if (Array.isArray(node)) {
      for (const child of node) resolveRefs(child, registry)
      return
    }
    if (node === null || node === undefined || typeof node !== 'object') return
    const ref = node.props?.ref
    if (ref !== null && ref !== undefined && typeof ref === 'object') ref.current = registry(node)
    for (const child of node.children ?? []) resolveRefs(child, registry)
  }

  const renderTree = (node, registry) => {
    if (Array.isArray(node)) return node.map((child) => renderTree(child, registry))
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      let instance = instances.get(node.type)
      if (instance === undefined) {
        instance = { slots: [], cursor: 0 }
        instances.set(node.type, instance)
      }
      instance.cursor = 0
      current = instance
      const tree = node.type(node.props ?? {})
      current = null
      return renderTree(tree, registry)
    }
    const ref = node.props?.ref
    if (ref !== null && ref !== undefined && typeof ref === 'object') ref.current = registry(node)
    const children = (node.children ?? []).map((child) => renderTree(child, registry))
    return { ...node, children }
  }

  const render = (component, props, registry, runEffects) => {
    pending = []
    const tree = renderTree({ type: component, props, children: [] }, registry)
    resolveRefs(tree, registry)
    // Effects belong to a mount, not to every render pass.
    if (runEffects) for (const effect of pending) effect()
    pending = []
    return tree
  }

  return {
    React,
    mount(component, props, registry) {
      let tree = render(component, props, registry, true)
      for (let pass = 0; pass < 12 && dirty; pass += 1) {
        dirty = false
        tree = render(component, props, registry, false)
      }
      return tree
    },
  }
}

/** Collect every element in a rendered tree. */
export function elementsOf(node, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, found)
    return found
  }
  if (node === null || node === undefined || typeof node !== 'object') return found
  found.push(node)
  for (const child of node.children ?? []) elementsOf(child, found)
  return found
}

/** A 2D context that counts its calls instead of painting pixels. */
export function createRecordingContext() {
  const calls = { fillRect: 0, fillText: 0, clearRect: 0, setTransform: 0 }
  const state = { fillStyle: '#000000', font: '', textBaseline: 'alphabetic', imageSmoothingEnabled: false }
  const context = {
    get fillStyle() { return state.fillStyle },
    set fillStyle(value) { state.fillStyle = value },
    get font() { return state.font },
    set font(value) { state.font = value },
    get textBaseline() { return state.textBaseline },
    set textBaseline(value) { state.textBaseline = value },
    get imageSmoothingEnabled() { return state.imageSmoothingEnabled },
    set imageSmoothingEnabled(value) { state.imageSmoothingEnabled = value },
    fillRect() { calls.fillRect += 1 },
    fillText() { calls.fillText += 1 },
    clearRect() { calls.clearRect += 1 },
    // The panel paints the room through a scale transform (unit device px per
    // art unit); the recorder only has to accept it.
    setTransform() { calls.setTransform += 1 },
    measureText(text) { return { width: String(text).length * 4 } },
  }
  return { context, calls, state }
}

/**
 * Boot `plugin/client.js` against stubs.
 * @param {{ state: any, scene: any }} payloads
 */
export function bootBundle({ state, scene }) {
  /** @type {any} */
  let definition = null
  const frames = []
  const requests = []
  const canvases = []
  const windowStub = { __ModuleLoader__: { load(value) { definition = value } } }

  /** One canvas, reused across re-renders, like a real DOM node. */
  let canvas = null
  const makeCanvas = () => {
    if (canvas !== null) return canvas
    const recorder = createRecordingContext()
    canvas = {
      width: 320,
      height: 224,
      getContext(kind) {
        return kind === '2d' ? recorder.context : null
      },
      recorder,
    }
    canvases.push(canvas)
    return canvas
  }

  const documentStub = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
    getElementById() { return null },
    createElement() { return makeCanvas() },
  }

  const fetchStub = async (url, options) => {
    let body
    try {
      body = options?.body === undefined ? undefined : JSON.parse(options.body)
    } catch {
      body = undefined
    }
    requests.push({ url: String(url), options, body })
    return {
      ok: true,
      status: 200,
      json: async () => (String(url).includes('/cradle/scene') ? scene : state),
    }
  }

  const run = new Function(
    'window', 'document', 'fetch', 'setInterval', 'clearInterval',
    'requestAnimationFrame', 'cancelAnimationFrame', source,
  )
  run(
    windowStub,
    documentStub,
    fetchStub,
    () => 0,
    () => {},
    (callback) => { frames.push(callback); return frames.length },
    () => {},
  )

  const harness = createHarness()
  const module = definition.factory((id) => {
    if (id !== 'react') throw new Error(`unexpected module ${id}`)
    return harness.React
  })

  /** @type {Array<any>} */
  const components = []
  const ctx = {
    effect(fn) {
      const cleanup = fn()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
    locale: { register() {}, bind() { return (key) => key } },
    slots: {
      inject(_name, register) { register() },
      register(_options, component) { components.push(component); return () => {} },
    },
  }
  module.apply(ctx)

  /** Let the initial fetches settle, then render into the stub canvas. */
  const settle = async () => {
    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  return {
    definition,
    module,
    components,
    requests,
    canvases,
    frames,
    async mount(props = {}, time = 1000) {
      await settle()
      const registry = (node) => (node.type === 'canvas' ? makeCanvas() : { createElement: makeCanvas })
      const tree = harness.mount(components[0], props, registry)
      const callbacks = frames.splice(0, frames.length)
      for (const callback of callbacks) callback(time)
      return tree
    },
    mountAgain(props = {}) {
      const registry = (node) => (node.type === 'canvas' ? makeCanvas() : { createElement: makeCanvas })
      return harness.mount(components[0], props, registry)
    },
  }
}
