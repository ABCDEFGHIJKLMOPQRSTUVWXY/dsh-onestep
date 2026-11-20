/**
 * P3-11 收起/标签层纯逻辑单测（node:test）：可见性注入/还原、kind 图标、控制器状态与订阅。
 * 不依赖 jsdom：用最小 fake element/document。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { applyPeekToElement, disposePeekMotionTimers, PEEK_RESTORING_ATTR, glyphForKind, createPeekLayer, defaultPeekTop, minPeekTop, clampPeekTop, snapPeekTop, peekTopRange, PEEK_LAYER_DEFAULT_TOP } from '../src/client/peek-layer.js'

function fakeElement(attributes = {}) {
  const attrs = new Map(Object.entries(attributes).map(([key, value]) => [key, String(value)]))
  const styleProps = new Map()
  return {
    id: '',
    inert: false,
    style: {
      setProperty(name, value, priority) {
        styleProps.set(name, { value, priority: priority || '' })
      },
      removeProperty(name) {
        styleProps.delete(name)
      },
      getPropertyValue(name) {
        return styleProps.has(name) ? styleProps.get(name).value : ''
      },
      getPropertyPriority(name) {
        return styleProps.has(name) ? styleProps.get(name).priority : ''
      },
    },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null
    },
    setAttribute(name, value) {
      attrs.set(name, String(value))
    },
    removeAttribute(name) {
      attrs.delete(name)
    },
    hasAttribute(name) {
      return attrs.has(name)
    },
  }
}

test('glyphForKind：已知 kind 有字形，未知名回退 ◇；零 CJK/emoji 字面量', () => {
  assert.equal(glyphForKind('text'), '▤')
  assert.equal(glyphForKind('terminal'), '▣')
  assert.equal(glyphForKind('unknown-kind'), '◇')
  assert.equal(glyphForKind(undefined), '◇')
})

test('applyPeekToElement：注入 data-peek/transform(100vw)/pointer-events/inert/aria-hidden + id', () => {
  const element = fakeElement({ 'data-dockkit-content': 'tab2' })
  applyPeekToElement(element, true)
  assert.equal(element.getAttribute('data-onestep-peek'), '1')
  assert.equal(element.id, 'onestep-float-tab2')
  assert.match(element.style.getPropertyValue('transform'), /100vw/)
  assert.equal(element.style.getPropertyPriority('transform'), 'important')
  assert.equal(element.style.getPropertyValue('pointer-events'), 'none')
  assert.equal(element.getAttribute('inert'), '')
  assert.equal(element.getAttribute('aria-hidden'), 'true')
})

test('applyPeekToElement：还原移除全部注入，位置/状态不受污染', () => {
  const element = fakeElement({ 'data-dockkit-content': 'tab2' })
  applyPeekToElement(element, true)
  applyPeekToElement(element, false)
  assert.equal(element.getAttribute('data-onestep-peek'), null)
  assert.equal(element.style.getPropertyValue('transform'), '')
  assert.equal(element.style.getPropertyValue('pointer-events'), '')
  assert.equal(element.getAttribute('inert'), null)
  assert.equal(element.getAttribute('aria-hidden'), null)
  assert.equal(element.inert, false)
})

test('applyPeekToElement：非法元素不抛', () => {
  assert.doesNotThrow(() => applyPeekToElement(null, true))
  assert.doesNotThrow(() => applyPeekToElement({}, true))
})

test('applyPeekToElement：重复恢复、再次收起与卸载都清理恢复动画标记', () => {
  for (const finish of [
    (element) => applyPeekToElement(element, false),
    (element) => applyPeekToElement(element, true),
    () => disposePeekMotionTimers(),
  ]) {
    const element = fakeElement({ 'data-dockkit-content': 'tab2' })
    element.getBoundingClientRect = () => ({ width: 300, height: 200 })
    try {
      applyPeekToElement(element, true)
      applyPeekToElement(element, false)
      assert.equal(element.getAttribute(PEEK_RESTORING_ATTR), '1')
      finish(element)
      assert.equal(element.getAttribute(PEEK_RESTORING_ATTR), null)
    } finally {
      disposePeekMotionTimers()
    }
  }
})

test('createPeekLayer：setItems 归一化/订阅通知/snapshotStats；无 DOM 环境不抛', () => {
  const previousDocument = globalThis.document
  const previousRaf = globalThis.requestAnimationFrame
  globalThis.document = { querySelectorAll: () => [], querySelector: () => null }
  globalThis.requestAnimationFrame = (fn) => {
    fn()
    return 1
  }
  try {
    const layer = createPeekLayer({ t: (key, params) => key + ':' + JSON.stringify(params || {}), log: () => {} })
    let notifications = 0
    const dispose = layer.subscribe(() => {
      notifications += 1
    })
    layer.setItems('s1', [
      { tabId: 'tab2', title: 'README.md', kind: 'text', slot: 0, peeked: true },
      { tabId: 'tab5', title: '', kind: 'terminal', slot: 1, peeked: false },
    ])
    const snapshot = layer.getSnapshot()
    assert.equal(snapshot.sessionId, 's1')
    assert.equal(snapshot.items.length, 2)
    assert.equal(snapshot.items[0].tabId, 'tab2')
    assert.equal(snapshot.items[0].peeked, true)
    assert.equal(snapshot.items[1].title, '')
    assert.equal(notifications, 1)
    const stats = layer.snapshotStats()
    assert.deepEqual({ sessionId: stats.sessionId, items: stats.items, peeked: stats.peeked, tags: stats.tags, layer: stats.layer }, { sessionId: 's1', items: 2, peeked: 1, tags: 0, layer: false })
    assert.equal(layer.hasOutsideHandler(), false)
    dispose()
    layer.dispose()
    layer.setItems('s1', [])
    assert.equal(notifications, 1) // dispose 后不再通知
  } finally {
    globalThis.document = previousDocument
    globalThis.requestAnimationFrame = previousRaf
  }
})

test('defaultPeekTop/minPeekTop：桌面标题栏高度参与安全位置', () => {
  assert.equal(defaultPeekTop(0), PEEK_LAYER_DEFAULT_TOP)
  assert.equal(defaultPeekTop(40), PEEK_LAYER_DEFAULT_TOP + 40) // 桌面 App 默认避开窗口控制
  assert.equal(minPeekTop(0), PEEK_LAYER_DEFAULT_TOP / 2)
  assert.equal(minPeekTop(40), 48)
  assert.equal(defaultPeekTop(Number.NaN), PEEK_LAYER_DEFAULT_TOP)
})

test('clampPeekTop：拖动/键盘位置夹取（不越过标题栏、不超出视口底部）', () => {
  // 桌面：minTop=标题栏+8；视口 900、层高 200 → 最大 900-200-8=692
  assert.equal(clampPeekTop(0, { viewportHeight: 900, layerHeight: 200, minTop: 48 }), 48)
  assert.equal(clampPeekTop(300, { viewportHeight: 900, layerHeight: 200, minTop: 48 }), 300)
  assert.equal(clampPeekTop(10000, { viewportHeight: 900, layerHeight: 200, minTop: 48 }), 692)
  // 未知视口/层高时只保底
  assert.equal(clampPeekTop(-5, { minTop: 16 }), 16)
  assert.equal(clampPeekTop(Number.NaN, { viewportHeight: 900, layerHeight: 100, minTop: 16 }), 16)
})

test('peekTopRange：minTop/maxTop 与 clamp 同源', () => {
  assert.deepEqual(peekTopRange({ viewportHeight: 900, layerHeight: 200, minTop: 48 }), { minTop: 48, maxTop: 692 })
  assert.deepEqual(peekTopRange({ minTop: 16 }), { minTop: 16, maxTop: Number.MAX_SAFE_INTEGER })
})

test('snapPeekTop：松手在阈值内吸附上沿/下沿/默认安全位置', () => {
  const options = { viewportHeight: 900, layerHeight: 200, minTop: 48, defaultTop: 56 }
  assert.equal(snapPeekTop(52, options), 48) // 距上沿 4 < 10
  assert.equal(snapPeekTop(60, options), 56) // 距默认位置 4 < 10
  assert.equal(snapPeekTop(300, options), 300) // 远离锚点不吸附
  assert.equal(snapPeekTop(690, options), 692) // 距下沿 2 < 10
  assert.equal(snapPeekTop(10000, options), 692) // 越界夹取
  assert.equal(snapPeekTop(52, { ...options, snap: 0 }), 52) // 阈值 0 不吸附
  assert.equal(snapPeekTop(78, { viewportHeight: 900, layerHeight: 200, minTop: 48 }), 78) // 无默认位置时只吸附边界
})
