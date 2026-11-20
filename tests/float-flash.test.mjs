/**
 * 0.7.0 已打开浮窗「再次点击」高亮闪烁单测（node:test）：标记生命周期与计时器隔离。
 * 不依赖 jsdom：最小 fake element + 可注入计时器。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { FLASH_ATTR, FLASH_DURATION, createFloatFlash } from '../src/client/float-flash.js'

function fakeElement() {
  const attrs = new Map()
  const element = {
    attrs,
    reflows: 0,
    setAttribute(name, value) {
      attrs.set(String(name), String(value))
    },
    removeAttribute(name) {
      attrs.delete(String(name))
    },
    getAttribute(name) {
      return attrs.has(String(name)) ? attrs.get(String(name)) : null
    },
    hasAttribute(name) {
      return attrs.has(String(name))
    },
    getBoundingClientRect() {
      element.reflows += 1
      return { x: 0, y: 0, width: 0, height: 0 }
    },
  }
  return element
}

function fakeTimers() {
  let nextId = 1
  const pending = new Map()
  return {
    setTimeout(fn, ms) {
      const id = nextId++
      pending.set(id, { fn, ms })
      return id
    },
    clearTimeout(id) {
      pending.delete(id)
    },
    runAll() {
      for (const [id, entry] of Array.from(pending.entries())) {
        pending.delete(id)
        entry.fn()
      }
    },
    count() {
      return pending.size
    },
    durations() {
      return Array.from(pending.values()).map((entry) => entry.ms)
    },
  }
}

test('flash：设置标记、安排一次移除计时、返回 true', () => {
  const timers = fakeTimers()
  const controller = createFloatFlash({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, duration: 123 })
  const element = fakeElement()
  assert.equal(controller.flash(element), true)
  assert.equal(element.getAttribute(FLASH_ATTR), '1')
  assert.equal(controller.isFlashing(element), true)
  assert.deepEqual(timers.durations(), [123])
  assert.equal(element.reflows, 1) // 起播前强制一次样式计算
  timers.runAll()
  assert.equal(element.getAttribute(FLASH_ATTR), null)
  assert.equal(controller.isFlashing(element), false)
  controller.dispose()
})

test('flash：重复点击先清旧计时并从头起播，只保留一个移除计时', () => {
  const timers = fakeTimers()
  const controller = createFloatFlash({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, duration: 100 })
  const element = fakeElement()
  controller.flash(element)
  const firstReflow = element.reflows
  controller.flash(element)
  assert.equal(timers.count(), 1)
  assert.equal(element.getAttribute(FLASH_ATTR), '1')
  assert.ok(element.reflows > firstReflow)
  timers.runAll()
  assert.equal(element.getAttribute(FLASH_ATTR), null)
  controller.dispose()
})

test('flash：非法元素返回 false 且不抛', () => {
  const controller = createFloatFlash()
  assert.equal(controller.flash(null), false)
  assert.equal(controller.flash({}), false)
  assert.equal(controller.isFlashing(null), false)
  controller.dispose()
})

test('dispose：清计时器、移除残留标记，之后 flash 不再生效', () => {
  const timers = fakeTimers()
  const controller = createFloatFlash({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, duration: 100 })
  const element = fakeElement()
  controller.flash(element)
  controller.dispose()
  assert.equal(timers.count(), 0)
  assert.equal(element.getAttribute(FLASH_ATTR), null)
  assert.equal(controller.flash(element), false)
})

test('FLASH_DURATION：两下 × 单下时长 + 缓冲，覆盖 CSS 动画总长', () => {
  assert.equal(FLASH_DURATION, 640)
})
