/**
 * 0.7.0 浮窗边缘缩放单测（node:test）：矩形计算、视口边界、官方 intents/actions 提交、把手生命周期。
 * 不依赖 jsdom：最小 fake element/document。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { COMPANION } from '../src/client/adapter.js'
import {
  MIN_SIZE,
  RESIZE_ATTR,
  RESIZING_ATTR,
  commitFloatRect,
  computeResizeRect,
  findFloatIntents,
  floatBounds,
  installFloatResize,
  normalizeRect,
  resolveServiceActions,
} from '../src/client/float-resize.js'

function fakeStyle() {
  return { left: '', top: '', width: '', height: '', zIndex: '', cursor: '' }
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parent = null
    this.attrs = new Map()
    this.style = fakeStyle()
    this.listeners = []
    this.rect = { left: 0, top: 0, width: 300, height: 200 }
    this.isConnected = true
  }
  appendChild(child) {
    child.parent = this
    this.children.push(child)
    return child
  }
  remove() {
    if (this.parent) {
      const index = this.parent.children.indexOf(this)
      if (index >= 0) this.parent.children.splice(index, 1)
    }
    this.parent = null
    this.isConnected = false
  }
  setAttribute(name, value) {
    this.attrs.set(String(name), String(value))
  }
  getAttribute(name) {
    return this.attrs.has(String(name)) ? this.attrs.get(String(name)) : null
  }
  hasAttribute(name) {
    return this.attrs.has(String(name))
  }
  removeAttribute(name) {
    this.attrs.delete(String(name))
  }
  addEventListener(type, fn, capture) {
    this.listeners.push({ type, fn, capture: !!capture })
  }
  removeEventListener(type, fn) {
    this.listeners = this.listeners.filter((item) => !(item.type === type && item.fn === fn))
  }
  dispatch(type, event) {
    for (const listener of this.listeners.slice()) if (listener.type === type) listener.fn(event)
  }
  matchesSelector(selector) {
    if (selector === '[' + RESIZE_ATTR + ']') return this.hasAttribute(RESIZE_ATTR)
    if (selector === COMPANION.selectors.float) return this.hasAttribute(COMPANION.attrs.float)
    if (selector === COMPANION.selectors.panel) return this.hasAttribute(COMPANION.attrs.session)
    if (selector === '[hidden]') return this.hasAttribute('hidden')
    return false
  }
  closest(selector) {
    let node = this
    while (node) {
      if (node.matchesSelector(selector)) return node
      node = node.parent
    }
    return null
  }
  querySelectorAll(selector) {
    const out = []
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matchesSelector(selector)) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }
  contains(node) {
    let current = node
    while (current) {
      if (current === this) return true
      current = current.parent
    }
    return false
  }
  getBoundingClientRect() {
    return { ...this.rect }
  }
  setPointerCapture() {}
  releasePointerCapture() {}
}

function fakeDocument({ titlebar = false, caption = '40px' } = {}) {
  const view = {
    innerWidth: 1440,
    innerHeight: 900,
    listeners: [],
    addEventListener(type, fn, capture) {
      this.listeners.push({ type, fn, capture: !!capture })
    },
    removeEventListener(type, fn) {
      this.listeners = this.listeners.filter((item) => !(item.type === type && item.fn === fn))
    },
    requestAnimationFrame(fn) {
      fn()
      return 1
    },
    cancelAnimationFrame() {},
    getComputedStyle() {
      return { getPropertyValue: () => (titlebar ? caption : '0px') }
    },
    fire(type, event) {
      for (const listener of this.listeners.slice()) if (listener.type === type) listener.fn(event)
    },
  }
  const doc = {
    defaultView: view,
    documentElement: {
      hasAttribute(name) {
        return titlebar && name === 'data-windows-titlebar'
      },
    },
    body: new FakeElement('body'),
    createElement: (tag) => new FakeElement(tag),
    querySelectorAll: () => [],
  }
  return { doc, view }
}

function buildPanel() {
  const panel = new FakeElement('div')
  panel.setAttribute(COMPANION.attrs.session, 's1')
  const float = new FakeElement('div')
  float.setAttribute(COMPANION.attrs.float, 'pane-1')
  float.setAttribute(COMPANION.attrs.content, 'tab-1')
  float.rect = { left: 500, top: 100, width: 400, height: 300 }
  panel.appendChild(float)
  return { panel, float }
}

test('normalizeRect：DOMRect 与 {x,y,w,h} 两种形状', () => {
  assert.deepEqual(normalizeRect({ left: 10, top: 20, width: 30, height: 40 }), { x: 10, y: 20, width: 30, height: 40 })
  assert.deepEqual(normalizeRect({ x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, width: 3, height: 4 })
  assert.deepEqual(normalizeRect(null), { x: 0, y: 0, width: 1, height: 1 })
})

test('computeResizeRect：八个方向与最小尺寸/视口边界', () => {
  const start = { x: 500, y: 100, width: 400, height: 300 }
  const bounds = { top: 60, width: 1440, height: 900 }
  assert.deepEqual(computeResizeRect(start, 'e', 80, 0, bounds), { x: 500, y: 100, width: 480, height: 300 })
  assert.deepEqual(computeResizeRect(start, 'w', -50, 0, bounds), { x: 450, y: 100, width: 450, height: 300 })
  assert.deepEqual(computeResizeRect(start, 's', 0, 40, bounds), { x: 500, y: 100, width: 400, height: 340 })
  assert.deepEqual(computeResizeRect(start, 'n', 0, -20, bounds), { x: 500, y: 80, width: 400, height: 320 })
  assert.deepEqual(computeResizeRect(start, 'se', 10, 20, bounds), { x: 500, y: 100, width: 410, height: 320 })
  assert.deepEqual(computeResizeRect(start, 'nw', 20, 30, bounds), { x: 520, y: 130, width: 380, height: 270 })
  // 最小尺寸：东侧只增不减到 min，西侧右缘固定
  assert.equal(computeResizeRect(start, 'e', -1000, 0, bounds).width, MIN_SIZE.width)
  const westMin = computeResizeRect(start, 'w', 1000, 0, bounds)
  assert.equal(westMin.width, MIN_SIZE.width)
  assert.equal(westMin.x, start.x + start.width - MIN_SIZE.width)
  // 视口右/下缘约束
  assert.equal(computeResizeRect(start, 'e', 5000, 0, bounds).width, 1440 - start.x)
  assert.equal(computeResizeRect(start, 's', 0, 5000, bounds).height, 900 - start.y)
  // 北侧不越过标题栏下沿；西侧不越过 x=0
  assert.equal(computeResizeRect(start, 'n', 0, -1000, bounds).y, bounds.top)
  assert.equal(computeResizeRect(start, 'w', -1000, 0, bounds).x, 0)
})

test('floatBounds：无标题栏顶界 0；桌面标题栏 = caption + 20', () => {
  const plain = fakeDocument()
  assert.deepEqual(floatBounds(plain.doc), { top: 0, width: 1440, height: 900 })
  const desktop = fakeDocument({ titlebar: true, caption: '40px' })
  assert.deepEqual(floatBounds(desktop.doc), { top: 60, width: 1440, height: 900 })
  assert.deepEqual(floatBounds(null), { top: 0, width: 0, height: 0 })
})

test('findFloatIntents：沿 React fiber 向上找 FloatLayer intents', () => {
  const float = new FakeElement('div')
  const intents = { resizeFloat() {} }
  float['__reactFiber$test'] = { memoizedProps: { paneId: 'p' }, return: { memoizedProps: { intents }, return: null } }
  assert.equal(findFloatIntents(float), intents)
  assert.equal(findFloatIntents(new FakeElement('div')), null)
  assert.equal(findFloatIntents(null), null)
})

test('resolveServiceActions：actionsFor 优先，其次 adopted store.actions', () => {
  const direct = { resizeFloat() {} }
  assert.equal(resolveServiceActions({ actionsFor: () => direct }, 's1'), direct)
  assert.equal(resolveServiceActions({ actionsFor: () => undefined, adopted: new Map([['s1', { store: { actions: direct } }]]) }, 's1'), direct)
  assert.equal(resolveServiceActions({ adopted: new Map() }, 's1'), null)
  assert.equal(resolveServiceActions(null, 's1'), null)
  assert.equal(resolveServiceActions({ actionsFor: () => direct }, null), null)
})

test('commitFloatRect：优先 fiber intents，其次服务 actions，失败返回原因', () => {
  const { panel, float } = buildPanel()
  const calls = []
  const intents = { resizeFloat: (paneId, rect) => calls.push({ via: 'intents', paneId, rect }) }
  float['__reactFiber$test'] = { memoizedProps: { intents }, return: null }
  const first = commitFloatRect(float, { x: 10, y: 20, width: 300, height: 200 })
  assert.deepEqual(first, { ok: true, via: 'intents' })
  assert.equal(calls[0].paneId, 'pane-1')

  delete float['__reactFiber$test']
  const viaActions = []
  const service = { actionsFor: (sessionId) => ({ resizeFloat: (sid, paneId, rect) => viaActions.push({ sessionId: sid, paneId, rect }) }) }
  const second = commitFloatRect(float, { x: 1, y: 2, width: 3, height: 4 }, { getService: () => service, getSessionId: () => 's1' })
  assert.deepEqual(second, { ok: true, via: 'actions' })
  assert.equal(viaActions[0].sessionId, 's1')
  assert.equal(viaActions[0].paneId, 'pane-1')

  const bare = new FakeElement('div')
  bare.setAttribute(COMPANION.attrs.float, 'pane-2')
  assert.equal(commitFloatRect(bare, { x: 0, y: 0, width: 10, height: 10 }).ok, false)
  assert.equal(commitFloatRect(null, { x: 0, y: 0, width: 10, height: 10 }).reason, 'no-pane')
})

test('installFloatResize：把手注入/拖动预览/提交/还原/卸载', () => {
  const { doc, view } = fakeDocument()
  const { panel, float } = buildPanel()
  panel.parent = doc.body
  doc.body.appendChild(panel)
  doc.querySelectorAll = (selector) => (selector === COMPANION.selectors.panel ? [panel] : [])
  const calls = []
  float['__reactFiber$test'] = { memoizedProps: { intents: { resizeFloat: (paneId, rect) => calls.push({ paneId, rect }) } }, return: null }
  const controller = installFloatResize({ doc, isEnabled: () => true, getSessionId: () => 's1', getService: () => undefined })
  controller.sync()
  const initial = controller.snapshot()
  assert.equal(initial.floats, 1)
  assert.equal(initial.grips, 8)

  const grip = float.children.find((child) => child.getAttribute(RESIZE_ATTR) === 'e')
  assert.ok(grip)
  float.dispatch('pointerdown', { button: 0, pointerId: 7, clientX: 900, clientY: 250, target: grip, preventDefault() {}, stopPropagation() {} })
  assert.equal(float.getAttribute(RESIZING_ATTR), '1')
  assert.equal(float.style.cursor, 'ew-resize')
  view.fire('pointermove', { pointerId: 7, clientX: 980, clientY: 250 })
  assert.equal(float.style.width, '480px')
  view.fire('pointerup', { pointerId: 7, clientX: 980, clientY: 250 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].paneId, 'pane-1')
  assert.equal(calls[0].rect.width, 480)
  // 双 rAF 清理（fake requestAnimationFrame 同步执行）；恢复为 CSS 变量驱动
  assert.equal(float.style.left, '')
  assert.equal(float.style.width, '')
  assert.equal(float.hasAttribute(RESIZING_ATTR), false)

  controller.dispose()
  assert.equal(controller.snapshot().floats, 0)
  assert.equal(float.children.filter((child) => child.hasAttribute(RESIZE_ATTR)).length, 0)
})

test('installFloatResize：未启用或无法提交时不注入/不改官方状态', () => {
  const { doc, view } = fakeDocument()
  const { panel, float } = buildPanel()
  doc.body.appendChild(panel)
  doc.querySelectorAll = (selector) => (selector === COMPANION.selectors.panel ? [panel] : [])
  const disabled = installFloatResize({ doc, isEnabled: () => false, getSessionId: () => 's1' })
  disabled.sync()
  assert.equal(disabled.snapshot().floats, 0)
  disabled.dispose()

  const controller = installFloatResize({ doc, isEnabled: () => true, getSessionId: () => 's1', getService: () => undefined })
  controller.sync()
  const grip = float.children.find((child) => child.getAttribute(RESIZE_ATTR) === 's')
  float.dispatch('pointerdown', { button: 0, pointerId: 9, clientX: 700, clientY: 400, target: grip, preventDefault() {}, stopPropagation() {} })
  view.fire('pointermove', { pointerId: 9, clientX: 700, clientY: 420 })
  view.fire('pointerup', { pointerId: 9, clientX: 700, clientY: 420 })
  // 无 intents/服务：revert 预览，官方 DOM 保持原样式
  assert.equal(controller.snapshot().last.ok, false)
  assert.equal(float.style.height, '')
  assert.equal(float.hasAttribute(RESIZING_ATTR), false)
  controller.dispose()
})

function resizeFixture() {
  const { doc, view } = fakeDocument()
  const { panel, float } = buildPanel()
  doc.body.appendChild(panel)
  doc.querySelectorAll = (selector) => (selector === COMPANION.selectors.panel ? [panel] : [])
  const state = { enabled: true, sessionId: 's1' }
  const commits = []
  const controller = installFloatResize({
    doc,
    isEnabled: () => state.enabled,
    getSessionId: () => state.sessionId,
    getService: () => ({ actionsFor: () => ({ resizeFloat: (...args) => commits.push(args) }) }),
  })
  controller.sync()
  const start = () => {
    const grip = float.children.find((child) => child.getAttribute(RESIZE_ATTR) === 'e')
    float.dispatch('pointerdown', { button: 0, pointerId: 7, clientX: 900, clientY: 250, target: grip, preventDefault() {}, stopPropagation() {} })
    view.fire('pointermove', { pointerId: 7, clientX: 980, clientY: 250 })
  }
  return { doc, view, panel, float, state, commits, controller, start }
}

test('installFloatResize：切会话/关闭舞台/收起/移除浮窗后取消缩放，不提交旧手势', () => {
  const changes = [
    (f) => { f.state.sessionId = 's2' },
    (f) => { f.state.enabled = false },
    (f) => { f.float.setAttribute(COMPANION.attrs.peek, '1') },
    (f) => { f.float.remove() },
  ]
  for (const change of changes) {
    for (const syncFirst of [false, true]) {
      const f = resizeFixture()
      f.start()
      change(f)
      if (syncFirst) f.controller.sync()
      f.view.fire('pointerup', { pointerId: 7 })
      assert.deepEqual(f.commits, [], '失效手势不能提交到原会话或新会话')
      assert.equal(f.float.hasAttribute(RESIZING_ATTR), false)
      assert.equal(f.float.style.width, '')
      assert.equal(f.view.listeners.length, 0)
      f.controller.dispose()
    }
  }
})

test('installFloatResize：官方重渲染移除把手后 sync 补齐八向把手且不重复监听', () => {
  const f = resizeFixture()
  f.float.children.find((child) => child.getAttribute(RESIZE_ATTR) === 'e').remove()
  f.controller.sync()
  assert.equal(f.float.children.filter((child) => child.hasAttribute(RESIZE_ATTR)).length, 8)
  assert.equal(f.float.listeners.filter((item) => item.type === 'pointerdown').length, 1)
  f.start()
  f.view.fire('pointerup', { pointerId: 7 })
  assert.equal(f.commits.length, 1)
  f.controller.dispose()
})
