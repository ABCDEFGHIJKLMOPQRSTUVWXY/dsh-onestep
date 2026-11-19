/**
 * P4-2 动效基础设施单测（node:test，纯函数/注入依赖）。
 * 覆盖：token 单一源、reduced 矩阵、VT 控制器回退/跳过/清理、命名规范化、提交等待。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MOTION,
  MOTION_KINDS,
  motionTokensCss,
  motionReducedCss,
  motionViewTransitionCss,
  resolveMotionMode,
  systemPrefersReducedMotion,
  isReduced,
  windowName,
  transitionName,
  nextTask,
  waitForApplied,
  viewTransitionDirectionCss,
  createMotionController,
} from '../src/client/motion.js'
import { CSS } from '../src/client/styles.js'
import { setReducedMotion, normalizeState, serializePersisted, defaultStageState } from '../src/client/store.js'
import { DICTIONARIES } from '../src/client/locale.js'
import { createFeedback } from '../src/client/feedback.js'
import { applyPeekToElement, disposePeekMotionTimers, PEEK_RESTORING_ATTR } from '../src/client/peek-layer.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('MOTION：关键时长/距离冻结（改动需同步 docs/p4-plan.md §2.2/§2.3）', () => {
  assert.equal(MOTION.fast, 120)
  assert.equal(MOTION.base, 180)
  assert.equal(MOTION.slow, 240)
  assert.equal(MOTION.morph, 220)
  assert.equal(MOTION.morphClick, 320)
  assert.equal(MOTION.morphOut, 200)
  assert.equal(MOTION.evict, 160)
  assert.equal(MOTION.stageIn, 260)
  assert.equal(MOTION.peek, 180)
  assert.equal(MOTION.flash, 600)
  assert.equal(MOTION.flashHold, 1400)
  assert.equal(MOTION.vtOldFade, 60)
  assert.equal(MOTION.vtFade, 120)
  assert.equal(MOTION.vtDelay, 40)
  assert.equal(MOTION.easeMorph, 'cubic-bezier(0.22,1,0.36,1)')
  assert.equal(MOTION.scaleIdle, 0.96)
  assert.equal(MOTION.hoverLift, 1)
  assert.equal(MOTION_KINDS.promote.groupMs, MOTION.morph)
  assert.equal(MOTION_KINDS.evict.groupMs, MOTION.evict)
})

test('motionTokensCss：:root 单一源 + 宿主曲线映射', () => {
  const css = motionTokensCss()
  assert.ok(css.startsWith(':root{'))
  assert.ok(css.includes('--onestep-fast:120ms'))
  assert.ok(css.includes('--onestep-base:180ms'))
  assert.ok(css.includes('--onestep-morph:220ms'))
  assert.ok(css.includes('--onestep-stage-in:260ms'))
  assert.ok(css.includes('--onestep-flash:600ms'))
  assert.ok(css.includes('--onestep-shift:4px'))
  assert.ok(css.includes('--onestep-scale-idle:0.96'))
  assert.ok(css.includes('--onestep-ease:var(--ds-ease-in-out,cubic-bezier(0.4,0,0.2,1))'))
  assert.ok(css.includes('--onestep-ease-morph:cubic-bezier(0.22,1,0.36,1)'))
  // 时长 token 数量固定（16 个），避免漏加
  assert.equal((css.match(/--onestep-[a-z-]+:\d+ms/g) || []).length, 16)
})

test('motionReducedCss：全部时长归零、距离归零、缩放归 1', () => {
  const reduced = motionReducedCss()
  const durations = (motionTokensCss().match(/--onestep-[a-z-]+:\d+ms/g) || []).map((item) => item.split(':')[0])
  assert.equal(durations.length, 16)
  for (const token of durations) assert.ok(reduced.includes(token + ':0ms'), token + ' 未归零')
  assert.ok(reduced.includes('--onestep-shift:0px'))
  assert.ok(reduced.includes('--onestep-hover-lift:0px'))
  assert.ok(reduced.includes('--onestep-scale-idle:1'))
  assert.ok(reduced.includes('--onestep-scale-enter:1'))
})

test('motionViewTransitionCss：组/old/new 规则 + reduced 保底', () => {
  const css = motionViewTransitionCss()
  assert.ok(css.includes('::view-transition-group(*)'))
  assert.ok(css.includes('::view-transition-old(*)'))
  assert.ok(css.includes('::view-transition-new(*)'))
  assert.ok(css.includes('var(--onestep-vt-ms,220ms)'))
  assert.ok(css.includes('var(--onestep-vt-old-fade,60ms)'))
  assert.ok(css.includes('var(--onestep-vt-fade,120ms)'))
  assert.ok(css.includes('var(--onestep-vt-delay,40ms)'))
  assert.ok(css.includes('cubic-bezier(0.22,1,0.36,1)'))
  assert.ok(css.includes('::view-transition-old(root){animation:none;opacity:0}'))
  assert.ok(css.includes('::view-transition-new(root){animation:none;opacity:1}'))
  assert.ok(css.includes('prefers-reduced-motion'))
})

test('styles.CSS：token 来自 motion.js、reduced 双路径、无私有曲线', () => {
  assert.ok(CSS.includes('--onestep-fast:120ms'))
  assert.ok(CSS.includes(':root[data-onestep-motion="reduced"]{'))
  assert.ok(CSS.includes('@media (prefers-reduced-motion:reduce){:root:not([data-onestep-motion="full"]){'))
  assert.ok(CSS.includes('::view-transition-group(*)'))
  assert.ok(!CSS.includes('cubic-bezier(0.2,0.8,0.2,1)'), '私有曲线应已删除（D6）')
  // stage 不再自己定义 token（单一源在 :root）：旧实现是 font 之后直接跟 token 声明
  assert.ok(!CSS.includes('sans-serif);--onestep-fast'), 'stage 不得再定义动效 token')
})

test('resolveMotionMode：system/always/never × 系统 reduce', () => {
  assert.equal(resolveMotionMode('system', false), 'full')
  assert.equal(resolveMotionMode('system', true), 'reduced')
  assert.equal(resolveMotionMode('always', false), 'reduced')
  assert.equal(resolveMotionMode('always', true), 'reduced')
  assert.equal(resolveMotionMode('never', false), 'full')
  assert.equal(resolveMotionMode('never', true), 'reduced')
  assert.equal(resolveMotionMode(undefined, false), 'full')
})

test('systemPrefersReducedMotion / isReduced：matchMedia 缺失按否', () => {
  assert.equal(systemPrefersReducedMotion({}), false)
  const reducedWin = { matchMedia: () => ({ matches: true }) }
  const fullWin = { matchMedia: () => ({ matches: false }) }
  assert.equal(systemPrefersReducedMotion(reducedWin), true)
  assert.equal(isReduced(() => 'system', reducedWin), true)
  assert.equal(isReduced(() => 'system', fullWin), false)
  assert.equal(isReduced(() => 'always', fullWin), true)
})

test('transitionName/windowName：custom-ident 合法、稳定、按 id 唯一', () => {
  assert.equal(transitionName('onestep-float-', 'tab2'), 'onestep-float-tab2')
  assert.equal(transitionName('onestep-peek-tag-', 'a b/c'), 'onestep-peek-tag-a_b_c')
  assert.equal(transitionName('x-', ''), null)
  assert.equal(transitionName('x-', null), null)
  assert.equal(windowName('session-a1458a29-b816'), 'onestep-w-session-a1458a29-b816')
  assert.equal(windowName('a b/c.d'), 'onestep-w-a_b_c_d')
  assert.equal(windowName(''), null)
  assert.equal(windowName(null), null)
  const name = windowName('session-x')
  assert.match(name, /^[-_A-Za-z][-_A-Za-z0-9]*$/)
  assert.notEqual(windowName('session-x'), windowName('session-y'))
})

test('setReducedMotion：system/always 两态 + 持久化字段 + never 读取容错', () => {
  const base = defaultStageState()
  assert.equal(base.reducedMotion, 'system')
  const reduced = setReducedMotion(base, 'always')
  assert.notEqual(reduced, base)
  assert.equal(reduced.reducedMotion, 'always')
  assert.equal(setReducedMotion(reduced, 'always'), reduced, '同值不产生新状态')
  assert.equal(setReducedMotion(reduced, 'system').reducedMotion, 'system')
  assert.equal(setReducedMotion(reduced, 'bogus').reducedMotion, 'system', '非法值回落 system')
  assert.equal(serializePersisted(reduced).reducedMotion, 'always')
  assert.equal(normalizeState({ ...base, reducedMotion: 'never' }).reducedMotion, 'never', 'never 字段读取保留（v1 不暴露）')
})

test('locale：减少动效菜单键 zh/en 齐备', () => {
  for (const key of ['window.motionSystem', 'window.motionReduced']) {
    assert.equal(typeof DICTIONARIES.zh[key], 'string')
    assert.equal(typeof DICTIONARIES.en[key], 'string')
    assert.ok(DICTIONARIES.zh[key].length > 0 && DICTIONARIES.en[key].length > 0)
  }
  assert.notEqual(DICTIONARIES.zh['window.motionSystem'], DICTIONARIES.en['window.motionSystem'])
})

test('feedback：flash 到点自清（不依赖 re-render）且 dispose 清理定时器', async () => {
  const feedback = createFeedback()
  feedback.flash('session-a', { holdMs: 30 })
  assert.deepEqual(Object.keys(feedback.getSnapshot().flash), ['session-a'])
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(Object.keys(feedback.getSnapshot().flash), [], '到点自动清除')
  feedback.flash('session-b', { holdMs: 500 })
  feedback.dispose()
  assert.doesNotThrow(() => feedback.dispose())
})

test('feedback：toast lifetimeMs（可撤销 5s / 普通 2.6s）', () => {
  const feedback = createFeedback()
  feedback.toast('x', { undoable: true })
  assert.equal(feedback.getSnapshot().toast.lifetimeMs, 5000)
  feedback.toast('y')
  assert.equal(feedback.getSnapshot().toast.lifetimeMs, 2600)
  feedback.toast('z', { lifetimeMs: 1200 })
  assert.equal(feedback.getSnapshot().toast.lifetimeMs, 1200)
  feedback.dispose()
})

test('feedback：气泡出场先 leaving 再清空；重新 setBubble 取消出场', async () => {
  const feedback = createFeedback()
  feedback.setBubble('session-a', 'approval')
  assert.equal(feedback.getSnapshot().bubbleLeaving, false)
  feedback.clearBubble('session-a')
  assert.equal(feedback.getSnapshot().bubbleLeaving, true, '先标记 leaving')
  assert.ok(feedback.getSnapshot().bubble, 'leaving 期间仍保留气泡元素')
  await new Promise((resolve) => setTimeout(resolve, 160))
  assert.equal(feedback.getSnapshot().bubble, null, '动画结束后清空')
  assert.equal(feedback.getSnapshot().bubbleLeaving, false)
  // 出场期间再次 setBubble → 取消清空
  feedback.setBubble('session-b', 'question')
  feedback.clearBubble('session-b')
  feedback.setBubble('session-b', 'plan')
  await new Promise((resolve) => setTimeout(resolve, 160))
  assert.ok(feedback.getSnapshot().bubble, '重新 setBubble 后不应被旧定时器清掉')
  assert.equal(feedback.getSnapshot().bubble.kind, 'plan')
  feedback.dispose()
})

function fakePeekElement(attributes = {}) {
  const attrs = new Map(Object.entries(attributes).map(([key, value]) => [key, String(value)]))
  const styles = new Map()
  return {
    id: '',
    inert: false,
    style: {
      setProperty(name, value) { styles.set(name, value) },
      removeProperty(name) { styles.delete(name) },
      getPropertyValue(name) { return styles.has(name) ? styles.get(name) : '' },
    },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null },
    setAttribute(name, value) { attrs.set(name, String(value)) },
    removeAttribute(name) { attrs.delete(name) },
    hasAttribute(name) { return attrs.has(name) },
    // 可测量 → 触发 P4-7 过渡路径
    getBoundingClientRect() { return { x: 0, y: 0, width: 1, height: 1 } },
  }
}

test('applyPeekToElement：恢复先加 restoring 标记、180ms 后清理（P4-7）', async () => {
  const element = fakePeekElement({ 'data-dockkit-content': 'tab9' })
  applyPeekToElement(element, true)
  assert.equal(element.getAttribute('data-onestep-peek'), '1')
  assert.match(element.style.getPropertyValue('transform'), /100vw/)
  applyPeekToElement(element, false)
  assert.equal(element.getAttribute('data-onestep-peek'), null)
  assert.equal(element.style.getPropertyValue('transform'), '')
  assert.equal(element.getAttribute(PEEK_RESTORING_ATTR), '1', '过渡期间保留 restoring 标记')
  await new Promise((resolve) => setTimeout(resolve, MOTION.peek + 40))
  assert.equal(element.getAttribute(PEEK_RESTORING_ATTR), null, '过渡结束后清理标记')
})

test('disposePeekMotionTimers：dispose 清理过渡定时器', () => {
  const element = fakePeekElement({ 'data-dockkit-content': 'tab10' })
  applyPeekToElement(element, true)
  applyPeekToElement(element, false)
  assert.equal(element.getAttribute(PEEK_RESTORING_ATTR), '1')
  disposePeekMotionTimers()
  assert.doesNotThrow(() => disposePeekMotionTimers())
})

test('nextTask / waitForApplied：宏任务轮询与超时', async () => {
  await nextTask()
  let calls = 0
  const ok = await waitForApplied(() => {
    calls += 1
    return calls >= 3
  }, { timeoutMs: 200 })
  assert.equal(ok, true)
  assert.equal(calls, 3)
  const failed = await waitForApplied(() => false, { timeoutMs: 10, intervalMs: 5 })
  assert.equal(failed, false)
})

function fakeDoc(options = {}) {
  const props = new Map()
  const calls = { started: 0, skipped: 0, kinds: [], callbacks: [], resolveFinished: null, rejectFinished: null }
  const doc = {
    documentElement: {
      style: {
        setProperty(name, value) { props.set(name, value); calls.kinds.push([name, value]) },
        removeProperty(name) { props.delete(name) },
        getPropertyValue(name) { return props.get(name) || '' },
      },
    },
    startViewTransition(callback) {
      calls.started += 1
      if (options.failStart) throw new Error('start-failed')
      calls.callbacks.push(callback)
      if (options.manual) {
        const finished = new Promise((resolve, reject) => {
          calls.resolveFinished = resolve
          calls.rejectFinished = reject
        })
        return { ready: Promise.resolve(), finished, skipTransition() { calls.skipped += 1 } }
      }
      const update = Promise.resolve().then(callback)
      const finished = options.pending ? new Promise(() => {}) : update.then(() => {})
      return {
        ready: Promise.resolve(),
        finished,
        skipTransition() { calls.skipped += 1 },
      }
    },
  }
  return { doc, props, calls }
}

test('createMotionController：不支持 → instant，且 update 只执行一次', async () => {
  const logs = []
  let runs = 0
  const controller = createMotionController({
    doc: { documentElement: { style: {} } },
    win: {},
    getSetting: () => 'system',
    log: (...args) => logs.push(args),
  })
  const route = await controller.run(() => { runs += 1 }, { kind: 'promote' })
  assert.equal(route, 'instant')
  assert.equal(runs, 1)
  assert.equal(controller.snapshot().last.route, 'instant')
  assert.equal(controller.snapshot().supported, false)
})

test('createMotionController：reduced → instant 且不启动 VT', async () => {
  const { doc, calls } = fakeDoc()
  const controller = createMotionController({ doc, win: {}, getSetting: () => 'always' })
  let runs = 0
  const route = await controller.run(() => { runs += 1 }, { kind: 'promote' })
  assert.equal(route, 'instant')
  assert.equal(runs, 1)
  assert.equal(calls.started, 0)
  assert.equal(controller.snapshot().reduced, true)
})

test('createMotionController：VT 路径设置/清理根变量并记录 kind 时长', async () => {
  const { doc, props, calls } = fakeDoc()
  const logs = []
  const controller = createMotionController({ doc, win: {}, getSetting: () => 'system', log: (...args) => logs.push(args) })
  let runs = 0
  const route = await controller.run(() => { runs += 1 }, { kind: 'promote' })
  assert.equal(route, 'vt')
  assert.equal(runs, 1)
  assert.equal(calls.started, 1)
  assert.equal(props.get('--onestep-vt-ms'), '220ms')
  assert.equal(props.get('--onestep-vt-old-fade'), '60ms')
  assert.equal(props.get('--onestep-vt-fade'), '120ms')
  assert.equal(props.get('--onestep-vt-delay'), '40ms')
  await tick()
  assert.equal(props.size, 0, '过渡结束后应清理根变量')
  const snap = controller.snapshot()
  assert.equal(snap.last.route, 'vt')
  assert.equal(snap.last.status, 'finished')
  assert.ok(logs.some((entry) => String(entry[0]).startsWith('motion.promote.')))
})

test('createMotionController：evict 使用 160ms 组时长', async () => {
  const { doc, calls } = fakeDoc()
  const controller = createMotionController({ doc, win: {}, getSetting: () => 'system' })
  await controller.run(() => {}, { kind: 'evict' })
  assert.equal(calls.kinds.find((item) => item[0] === '--onestep-vt-ms')[1], '160ms')
})

test('createMotionController：同帧连续动作 → queued 按调用顺序在回调内执行', async () => {
  const { doc, calls } = fakeDoc({ manual: true })
  const controller = createMotionController({ doc, win: {}, getSetting: () => 'system' })
  const order = []
  assert.equal(await controller.run(() => { order.push(1) }, { kind: 'add' }), 'vt')
  assert.equal(await controller.run(() => { order.push(2) }, { kind: 'add' }), 'queued')
  assert.equal(await controller.run(() => { order.push(3) }, { kind: 'add' }), 'queued')
  assert.deepEqual(order, [], '队列更新在 VT 回调执行前不得先跑')
  await calls.callbacks[0]()
  assert.deepEqual(order, [1, 2, 3], '回调内基础更新 + 队列按调用顺序执行')
  // 回调已完成、动画仍在播 → 新动作跳过并立即应用
  assert.equal(await controller.run(() => { order.push(4) }, { kind: 'add' }), 'skipped')
  assert.deepEqual(order, [1, 2, 3, 4])
  assert.equal(calls.skipped, 1)
  assert.equal(controller.snapshot().activeState, 'done')
})

test('createMotionController：decorate 在 VT 前注入、结束/抛错后还原', async () => {
  const { doc, calls } = fakeDoc({ manual: true })
  const controller = createMotionController({ doc, win: {}, getSetting: () => 'system' })
  let decorated = 0
  let cleaned = 0
  await controller.run(() => {}, {
    kind: 'promote',
    decorate: () => { decorated += 1; return () => { cleaned += 1 } },
  })
  assert.equal(decorated, 1)
  assert.equal(cleaned, 0, '过渡结束前不得清理命名')
  await calls.callbacks[0]()
  calls.resolveFinished()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(cleaned, 1, 'finished 后应还原命名')

  const failing = fakeDoc({ failStart: true })
  const controller2 = createMotionController({ doc: failing.doc, win: {}, getSetting: () => 'system' })
  let cleaned2 = 0
  assert.equal(await controller2.run(() => {}, { kind: 'promote', decorate: () => () => { cleaned2 += 1 } }), 'fallback')
  assert.equal(cleaned2, 1, 'start 抛错也应还原命名')
})

test('createMotionController：VT 在回调前中止 → 基础更新与队列兜底执行', async () => {
  const { doc, calls } = fakeDoc({ manual: true })
  const controller = createMotionController({ doc, win: {}, getSetting: () => 'system' })
  const order = []
  assert.equal(await controller.run(() => { order.push('base') }, { kind: 'promote' }), 'vt')
  assert.equal(await controller.run(() => { order.push('queued') }, { kind: 'evict' }), 'queued')
  calls.rejectFinished(new Error('aborted before callback'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(order, ['base', 'queued'], '中止时基础更新与队列按序补齐')
  assert.equal(controller.snapshot().active, false)
})

test('createMotionController：startViewTransition 抛错 → fallback 回退直切', async () => {
  const { doc, props } = fakeDoc({ failStart: true })
  const controller = createMotionController({ doc, win: {}, getSetting: () => 'system' })
  let runs = 0
  const route = await controller.run(() => { runs += 1 }, { kind: 'promote' })
  assert.equal(route, 'fallback')
  assert.equal(runs, 1)
  assert.equal(props.size, 0)
})

test('createMotionController：VT aborted 时记录 fallback 且清理变量', async () => {
  const logs = []
  const controller = createMotionController({
    doc: {
      documentElement: { style: { setProperty() {}, removeProperty() {} } },
      startViewTransition() {
        return { finished: Promise.reject(new Error('timeout in DOM update')), skipTransition() {} }
      },
    },
    win: {},
    getSetting: () => 'system',
    log: (...args) => logs.push(args),
  })
  await controller.run(() => {}, { kind: 'promote' })
  await tick()
  assert.ok(logs.some((entry) => String(entry[0]).startsWith('motion.promote.fallback')), 'aborted 应记录 fallback')
})


test('viewTransitionDirectionCss：提升窗旧快照立即隐藏、降级窗新快照延迟淡入（P4.2）', () => {
  const css = viewTransitionDirectionCss({ from: 'session-a', to: 'session-b' })
  assert.ok(css.includes('::view-transition-old(' + windowName('session-b') + '){animation-duration:1ms !important}'))
  assert.ok(css.includes('::view-transition-new(' + windowName('session-b') + '){animation-delay:0ms !important}'))
  assert.ok(css.includes('::view-transition-new(' + windowName('session-a') + '){animation-delay:150ms !important;animation-duration:80ms !important}'))
  assert.equal(viewTransitionDirectionCss(null), '')
  assert.equal(viewTransitionDirectionCss({}), '')
  assert.ok(!viewTransitionDirectionCss({ to: 'x' }).includes('150ms'))
})
