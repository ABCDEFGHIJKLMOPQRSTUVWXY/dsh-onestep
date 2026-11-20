/**
 * 候场卡静态快照的纯逻辑单测：状态签名 / 快照缓存 / 串行抓取调度器。
 * DOM 抓取管线（CandidatePreview）由浏览器 e2e 覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { RECAPTURE_DEBOUNCE_MS, RECAPTURE_MIN_INTERVAL_MS, createCaptureScheduler, createPreviewCache, fitSnapshot, previewStatusKey, recaptureDelayMs } from '../src/client/preview-cache.js'

const row = (extra) => ({ displayTitle: 'A', blank: false, awaitingFirstTurn: false, updatedAt: 1, ...(extra || {}) })
const status = (extra) => ({ running: false, completionUnread: false, pendingInteraction: null, ...(extra || {}) })

test('previewStatusKey：状态不变时签名稳定，状态字段变化时签名变化', () => {
  const base = previewStatusKey(row(), status())
  assert.equal(previewStatusKey(row(), status()), base)
  assert.notEqual(previewStatusKey(row(), status({ running: true })), base)
  assert.notEqual(previewStatusKey(row(), status({ completionUnread: true })), base)
  assert.notEqual(previewStatusKey(row(), status({ pendingInteraction: { kind: 'approval' } })), base)
  assert.notEqual(previewStatusKey(row({ blank: true }), status()), base)
  assert.notEqual(previewStatusKey(row({ awaitingFirstTurn: true }), status()), base)
  assert.notEqual(previewStatusKey(row({ displayTitle: 'B' }), status()), base)
  // 内容/时间变化不进入签名：流式输出期间不会重拍快照
  assert.equal(previewStatusKey(row({ updatedAt: 999 }), status()), base)
})

test('previewStatusKey：pending 类型变化但同 kind 不重拍（只按状态签名更新）', () => {
  const one = previewStatusKey(row(), status({ pendingInteraction: { kind: 'question' } }))
  const two = previewStatusKey(row(), status({ pendingInteraction: { kind: 'question' } }))
  assert.equal(one, two)
  assert.notEqual(previewStatusKey(row(), status({ pendingInteraction: { kind: 'plan' } })), one)
})

test('previewCache：latest/get/set、LRU 上限与 retain/clear', () => {
  const cache = createPreviewCache({ max: 2, now: () => 1 })
  assert.equal(cache.latest('a'), null)
  const entry = cache.set('a', 'k1', '<div>a</div>', 560, 320)
  assert.equal(entry.key, 'k1')
  assert.equal(cache.latest('a').html, '<div>a</div>')
  assert.equal(cache.get('a', 'k1').width, 560)
  assert.equal(cache.get('a', 'k2'), null)
  cache.set('b', 'k1', '<div>b</div>', 560, 320)
  cache.set('c', 'k1', '<div>c</div>', 560, 320)
  // max=2：最早写入的 a 被淘汰
  assert.equal(cache.latest('a'), null)
  assert.equal(cache.size(), 2)
  // retain 只保留指定会话
  cache.retain(['b'])
  assert.equal(cache.latest('b').html, '<div>b</div>')
  assert.equal(cache.latest('c'), null)
  // 非法快照不写入
  assert.equal(cache.set('d', 'k', '', 1, 1), null)
  assert.equal(cache.set('', 'k', '<i></i>', 1, 1), null)
  cache.clear()
  assert.equal(cache.size(), 0)
})

test('previewCache：重复 set 同一会话替换旧快照（状态变化刷新）', () => {
  const cache = createPreviewCache({ max: 4, now: () => 2 })
  cache.set('a', 'k1', '<div>old</div>', 560, 320)
  cache.set('a', 'k2', '<div>new</div>', 560, 330)
  assert.equal(cache.size(), 1)
  assert.equal(cache.latest('a').key, 'k2')
  assert.equal(cache.get('a', 'k1'), null)
  assert.equal(cache.latest('a').height, 330)
})

function fakeEnv() {
  const idles = []
  const timers = new Map()
  let nextTimer = 1
  return {
    idles,
    timers,
    requestIdleCallback(callback) {
      idles.push(callback)
      return idles.length
    },
    cancelIdleCallback() {},
    setTimeout(callback) {
      const id = nextTimer++
      timers.set(id, callback)
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    flushIdle() {
      const callback = idles.shift()
      if (callback) callback({ didTimeout: false, timeRemaining: () => 10 })
    },
    flushTimers() {
      for (const [id, callback] of Array.from(timers.entries())) {
        timers.delete(id)
        callback()
      }
    },
  }
}

test('captureScheduler：串行执行、done 后按 gap 再调度下一个', () => {
  const env = fakeEnv()
  const scheduler = createCaptureScheduler({ requestIdleCallback: env.requestIdleCallback, cancelIdleCallback: env.cancelIdleCallback, setTimeout: env.setTimeout, clearTimeout: env.clearTimeout, gapMs: 50 })
  const ran = []
  const jobA = { run: () => ran.push('a') }
  const jobB = { run: () => ran.push('b') }
  scheduler.push(jobA)
  scheduler.push(jobB)
  assert.equal(env.idles.length, 1)
  env.flushIdle()
  assert.deepEqual(ran, ['a'])
  scheduler.done()
  assert.equal(env.idles.length, 0)
  assert.equal(env.timers.size, 1)
  env.flushTimers()
  assert.equal(env.idles.length, 1)
  env.flushIdle()
  assert.deepEqual(ran, ['a', 'b'])
  scheduler.dispose()
})

test('captureScheduler：remove 取消未开始任务；dispose 清理一切', () => {
  const env = fakeEnv()
  const scheduler = createCaptureScheduler({ requestIdleCallback: env.requestIdleCallback, gapMs: 0 })
  let ran = 0
  const job = { run: () => { ran += 1 } }
  scheduler.push(job)
  scheduler.remove(job)
  env.flushIdle()
  assert.equal(ran, 0)
  scheduler.push({ run: () => { ran += 1 } })
  scheduler.dispose()
  env.flushIdle()
  assert.equal(ran, 0)
  assert.equal(scheduler.pending(), 0)
})

test('captureScheduler：任务 throw 不会卡死队列', () => {
  const env = fakeEnv()
  const scheduler = createCaptureScheduler({ requestIdleCallback: env.requestIdleCallback, cancelIdleCallback: env.cancelIdleCallback, setTimeout: env.setTimeout, clearTimeout: env.clearTimeout, gapMs: 0 })
  let ran = 0
  scheduler.push({ run: () => { throw new Error('boom') } })
  scheduler.push({ run: () => { ran += 1 } })
  env.flushIdle()
  // 失败的抓取也保留间隔，之后继续排队。
  env.flushTimers()
  env.flushIdle()
  assert.equal(ran, 1)
  scheduler.dispose()
})

test('captureScheduler：间隔期间新增任务不能提前启动下一次抓取', () => {
  const env = fakeEnv()
  const scheduler = createCaptureScheduler({ ...env, gapMs: 140 })
  const ran = []
  const first = { run: () => ran.push('first') }
  scheduler.push(first)
  env.flushIdle()
  scheduler.done(first)
  scheduler.push({ run: () => ran.push('second') })
  assert.equal(env.idles.length, 0, '新增任务必须等待抓取间隔结束')
  env.flushIdle()
  assert.deepEqual(ran, ['first'])
  env.flushTimers()
  env.flushIdle()
  assert.deepEqual(ran, ['first', 'second'])
  scheduler.dispose()
})

test('captureScheduler：失败抓取后仍遵守间隔', () => {
  const env = fakeEnv()
  const scheduler = createCaptureScheduler({ ...env, gapMs: 140 })
  let ran = false
  scheduler.push({ run: () => { throw new Error('capture failed') } })
  scheduler.push({ run: () => { ran = true } })
  env.flushIdle()
  assert.equal(env.idles.length, 0)
  assert.equal(env.timers.size, 1)
  env.flushTimers()
  env.flushIdle()
  assert.equal(ran, true)
  scheduler.dispose()
})

test('captureScheduler：卸载取消默认回退计时器且保留显式零延迟', () => {
  const timers = new Map()
  const delays = []
  let nextTimer = 1
  const scheduler = createCaptureScheduler({
    fallbackDelayMs: 0,
    gapMs: 0,
    setTimeout(callback, delay) {
      const id = nextTimer++
      delays.push(delay)
      timers.set(id, callback)
      return id
    },
    clearTimeout(id) { timers.delete(id) },
  })
  let ran = false
  scheduler.push({ run: () => { ran = true } })
  assert.deepEqual(delays, [0])
  scheduler.dispose()
  assert.equal(timers.size, 0, '回退 setTimeout 必须由 clearTimeout 取消')
  assert.equal(ran, false)
  assert.equal(scheduler.pending(), 0)
})

test('recaptureDelayMs：重拍节流（防抖 500ms + 每会话最小间隔 2500ms）', () => {
  // 刚抓拍完（age=0）：直接等到满足最小间隔
  assert.equal(RECAPTURE_MIN_INTERVAL_MS, 2500)
  assert.equal(RECAPTURE_DEBOUNCE_MS, 500)
  assert.equal(recaptureDelayMs(1000, 1000), 2500)
  // 已过 2000ms（不足 2500）：补足到 2500 → 延迟 500，且不低于防抖窗口
  assert.equal(recaptureDelayMs(1000, 3000), 500)
  // 已过 5000ms：只需防抖窗口
  assert.equal(recaptureDelayMs(1000, 6000), 500)
  // 时间戳非法/缺失：按 0 处理（age=now → 补足间隔）
  assert.equal(recaptureDelayMs(undefined, 1000), 1500)
  // 未来时间戳：age 归 0，取最小间隔
  assert.equal(recaptureDelayMs(5000, 1000), 2500)
  // 延后值恒 >= 防抖窗口
  assert.ok(recaptureDelayMs(1000, 1000) >= RECAPTURE_DEBOUNCE_MS)
})

test('captureScheduler：done(job) 只有 token 匹配才释放槽位（F4 竞态修复）', () => {
  const env = fakeEnv()
  const scheduler = createCaptureScheduler({ requestIdleCallback: env.requestIdleCallback, cancelIdleCallback: env.cancelIdleCallback, setTimeout: env.setTimeout, clearTimeout: env.clearTimeout, gapMs: 50 })
  const ran = []
  const jobA = { run: () => ran.push('a') }
  const jobB = { run: () => ran.push('b') }
  const staleJob = { run: () => ran.push('stale') }
  scheduler.push(jobA)
  scheduler.push(jobB)
  env.flushIdle()
  assert.deepEqual(ran, ['a'])
  // 拿错 token（B 还在排队 / 完全不相关的旧 job）调用 done：不释放、不排下一拍
  assert.equal(scheduler.done(jobB), false)
  assert.equal(scheduler.done(staleJob), false)
  assert.equal(env.timers.size, 0)
  assert.equal(env.idles.length, 0)
  // 正确 token 才释放，并按 gap 调度下一个
  assert.equal(scheduler.done(jobA), true)
  assert.equal(env.timers.size, 1)
  env.flushTimers()
  assert.equal(env.idles.length, 1)
  env.flushIdle()
  assert.deepEqual(ran, ['a', 'b'])
  // 重复释放同一 token 安全（幂等）：A 已释放，B 正占用 → 都不匹配
  assert.equal(scheduler.done(jobA), false)
  // 无参 done() 仍无条件释放「当前任务」（兼容旧调用点/探针）
  assert.equal(scheduler.done(), true)
  assert.equal(scheduler.done(), false)
  scheduler.dispose()
})

test('captureScheduler：无参 done() 保持向后兼容（无条件释放当前任务）', () => {
  const env = fakeEnv()
  const scheduler = createCaptureScheduler({ requestIdleCallback: env.requestIdleCallback, cancelIdleCallback: env.cancelIdleCallback, setTimeout: env.setTimeout, clearTimeout: env.clearTimeout, gapMs: 0 })
  const ran = []
  scheduler.push({ run: () => ran.push('a') })
  scheduler.push({ run: () => ran.push('b') })
  env.flushIdle()
  assert.deepEqual(ran, ['a'])
  assert.equal(scheduler.done(), true)
  env.flushTimers()
  env.flushIdle()
  assert.deepEqual(ran, ['a', 'b'])
  scheduler.dispose()
})

test('fitSnapshot：整张快照装入卡片内容区（contain），比例不一致时居中留白', () => {
  // 宽而矮的卡：受高度限制，左右留白
  const wide = fitSnapshot(400, 200, 560, 320)
  assert.equal(wide.scale, 200 / 320)
  assert.ok(Math.abs(wide.height - 200) < 1e-9)
  assert.ok(Math.abs(wide.width - (560 * (200 / 320))) < 1e-9)
  assert.ok(wide.left > 0)
  assert.ok(Math.abs(wide.top) < 1e-9)
  assert.ok(wide.left + wide.width <= 400 + 1e-9)
  assert.ok(wide.top + wide.height <= 200 + 1e-9)

  // 窄而高的卡：受宽度限制，上下留白
  const tall = fitSnapshot(300, 500, 560, 800)
  assert.equal(tall.scale, 300 / 560)
  assert.ok(Math.abs(tall.width - 300) < 1e-9)
  assert.ok(Math.abs(tall.height - (800 * (300 / 560))) < 1e-9)
  assert.ok(tall.top > 0)
  assert.ok(tall.left + tall.width <= 300 + 1e-9)
  assert.ok(tall.top + tall.height <= 500 + 1e-9)

  // 等比例时刚好铺满、无留白
  const exact = fitSnapshot(400, 250, 800, 500)
  assert.equal(exact.scale, 0.5)
  assert.ok(Math.abs(exact.left) < 1e-9)
  assert.ok(Math.abs(exact.top) < 1e-9)

  // 非法尺寸兜底：不抛、始终在盒内
  const tiny = fitSnapshot(0, 0, 0, 0)
  assert.ok(tiny.scale >= 0.01)
  assert.ok(tiny.left >= 0)
  assert.ok(tiny.top >= 0)
})
