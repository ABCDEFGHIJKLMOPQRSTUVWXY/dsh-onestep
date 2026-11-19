/**
 * P4-1 探针⑧：reduced motion（docs/p4-plan.md §4.7 / §4.10 #9 / D5）
 *
 * 内容（reduced context，openApp({reducedMotion:'reduce'})）：
 * - matchMedia=true；引擎仍支持 VT；
 * - 现有产品 reduced 降级事实：stage token=0ms、窗口/控制点/快速条/标签 transition=0、pulse/flash/bubble 动画 none、infinite 动画=0；
 * - 「reduced 不启动 VT」的两层机制实测：
 *   ① JS 策略：motion.isReduced() → 直切（不调用 startViewTransition），用「产品动作不触发 VT」+「守卫模拟」证明；
 *   ② CSS 兜底：@media(prefers-reduced-motion:reduce) 把 ::view-transition-*(*) 压到 .001ms —
 *      先测无兜底时默认 250ms，再注入计划 §4.3 的兜底 CSS 复测，验证机制有效性。
 *
 * 用法：node scripts/p4/probe/reduced.mjs
 * 产物：artifacts/p4/probe/reduced.json
 */
import path from 'node:path'

import {
  OUT, createResults, sleep, openApp, closeApp, pageEnv, installRuntime, relPath,
  actionCall, enterStage, fileAddress, p3Call, actionCall as callAction,
} from './lib.mjs'

const results = createResults('reduced', 'P4-1 探针⑧：reduced motion 策略与现有降级事实')
let app = null

const SUP_RE = '.onestep-stage{--onestep-fast:0ms;--onestep-base:0ms;--onestep-slow:0ms}'
const VT_SUP_CSS = '@media (prefers-reduced-motion: reduce){::view-transition-group(*),::view-transition-old(*),::view-transition-new(*){animation-duration:.001ms !important;animation-delay:0ms !important}}'

/** 单次简单 VT（临时节点），可选注入 reduced 兜底 CSS；返回伪元素时长与 finished。 */
async function vtWithOptionalSuppression(page, options = {}) {
  return page.evaluate(async ({ suppress, css, nodeId }) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const existing = document.getElementById('p4-reduced-style')
    if (existing) existing.remove()
    if (suppress) {
      const style = document.createElement('style')
      style.id = 'p4-reduced-style'
      style.textContent = css
      document.head.appendChild(style)
    }
    const host = document.createElement('div')
    host.id = nodeId
    host.style.cssText = 'position:fixed;left:700px;top:40px;width:60px;height:30px;background:#4c8dff;z-index:2147483000;view-transition-name:onestep-p4-reduced'
    document.body.appendChild(host)
    await sleep(40)
    const started = performance.now()
    let vt = null
    let error = null
    try {
      vt = document.startViewTransition(async () => {
        await sleep(0)
        host.style.transform = 'translateX(40px)'
      })
    } catch (caught) {
      error = String(caught)
    }
    if (!vt) {
      host.remove()
      if (suppress) { const style = document.getElementById('p4-reduced-style'); if (style) style.remove() }
      return { started: false, error }
    }
    let readyMs = null
    let finishedMs = null
    let finishedError = null
    await vt.ready.catch(() => {})
    readyMs = performance.now() - started
    const animations = document.getAnimations().map((animation) => {
      const effect = animation.effect
      const timing = effect && effect.getTiming ? effect.getTiming() : {}
      return { pseudoElement: effect && effect.pseudoElement ? effect.pseudoElement : null, duration: timing.duration, delay: timing.delay || 0 }
    })
    const pseudo = animations.filter((item) => item.pseudoElement)
    await vt.finished.then(() => { finishedMs = performance.now() - started }, (caught) => { finishedError = String(caught) })
    host.remove()
    if (suppress) { const style = document.getElementById('p4-reduced-style'); if (style) style.remove() }
    return {
      started: true,
      readyMs,
      finishedMs,
      finishedError,
      pseudoCount: pseudo.length,
      pseudoDurations: [...new Set(pseudo.map((item) => item.duration))],
      pseudoDelays: [...new Set(pseudo.map((item) => item.delay))],
      pseudoSample: pseudo.slice(0, 4),
    }
  }, { suppress: options.suppress === true, css: options.css || '', nodeId: options.nodeId || 'p4-reduced-node' })
}

try {
  results.data.env.command = 'node scripts/p4/probe/reduced.mjs'
  app = await openApp({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const { page } = app
  const env = await pageEnv(page)
  results.data.env.reduced = env
  results.step('env.reduced', env)
  results.assert('reduced.matchMedia', env.reducedMotion === true, {
    expected: 'reduced context：matchMedia(prefers-reduced-motion: reduce)=true',
    actual: { reducedMotion: env.reducedMotion },
    category: 'reduced',
  })
  results.assert('reduced.engine.vt', env.startViewTransition === 'function', {
    expected: '引擎仍支持 VT（跳过与否由产品策略决定）',
    actual: { startViewTransition: env.startViewTransition },
    category: 'reduced',
  })

  await installRuntime(page)
  await page.evaluate(() => window.__P4.installStartViewTransitionCounter())
  await enterStage(page, { count: 3 })
  await sleep(400)
  const mounted = (await p3Call(page, 'snapshot')).mounted

  // ① 现有产品 reduced 降级事实（计算样式）
  const audit = await page.evaluate(() => {
    const R = window.__P4
    const focusedDot = document.querySelector('[data-onestep-stage] .onestep-dot')
    const dotProbe = null
    const quickInner = document.querySelector('[data-onestep-stage] .onestep-quick-inner')
    const control = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"] .onestep-control')
    const frame = document.querySelector('[data-onestep-stage] .onestep-frame')
    const stage = document.querySelector('[data-onestep-stage]')
    const cs = (el) => (el ? getComputedStyle(el) : null)
    const stageCs = stage ? getComputedStyle(stage) : null
    const out = {
      media: matchMedia('(prefers-reduced-motion: reduce)').matches,
      stageTokens: stageCs ? {
        fast: stageCs.getPropertyValue('--onestep-fast').trim(),
        base: stageCs.getPropertyValue('--onestep-base').trim(),
        slow: stageCs.getPropertyValue('--onestep-slow').trim(),
      } : null,
      frameTransition: frame ? { duration: cs(frame).transitionDuration, property: cs(frame).transitionProperty, timing: cs(frame).transitionTimingFunction } : null,
      controlTransition: control ? { duration: cs(control).transitionDuration, delay: cs(control).transitionDelay } : null,
      quickTransition: quickInner ? { duration: cs(quickInner).transitionDuration, property: cs(quickInner).transitionProperty } : null,
      dotBefore: focusedDot ? { tone: focusedDot.getAttribute('data-tone'), animationName: cs(focusedDot).animationName, animationDuration: cs(focusedDot).animationDuration } : null,
    }
    if (focusedDot) {
      const before = focusedDot.getAttribute('data-tone')
      focusedDot.setAttribute('data-tone', 'running')
      out.dotRunningProbe = {
        before,
        animationName: cs(focusedDot).animationName,
        animationDuration: cs(focusedDot).animationDuration,
        animationIterationCount: cs(focusedDot).animationIterationCount,
      }
      if (before === null) focusedDot.removeAttribute('data-tone')
      else focusedDot.setAttribute('data-tone', before)
    }
    out.infiniteScan = R.scanInfiniteStyles()
    out.computedAudit = R.auditComputed([
      { key: 'frame.candidate', selector: '.onestep-frame[data-mode="candidate"]', vars: ['--onestep-base', '--onestep-ease'] },
      { key: 'control', selector: '.onestep-frame[data-mode="focus"] .onestep-control' },
      { key: 'quick.inner', selector: '.onestep-quick-inner' },
      { key: 'splitter.after', selector: '.onestep-splitter', pseudo: '::after' },
      { key: 'stage', selector: '.onestep-stage', vars: ['--onestep-fast', '--onestep-base', '--onestep-slow'] },
    ])
    out.reducedVtCallsSoFar = R.readStartViewTransitionCounter()
    return out
  })
  results.step('reduced.audit', audit)
  const tokensZero = audit.stageTokens && ['0ms', '0s'].includes(audit.stageTokens.fast) && ['0ms', '0s'].includes(audit.stageTokens.base) && ['0ms', '0s'].includes(audit.stageTokens.slow)
  results.metric('reduced.audit', { stageTokens: audit.stageTokens, frameTransition: audit.frameTransition, dotRunningProbe: audit.dotRunningProbe, infiniteCount: audit.infiniteScan && audit.infiniteScan.count })
  results.assert('reduced.tokens', !!tokensZero, {
    expected: 'reduced：stage --onestep-fast/base/slow = 0ms',
    actual: audit.stageTokens,
    category: 'reduced',
  })
  const frameDurations = String((audit.frameTransition || {}).duration || '').split(', ').every((part) => part === '0s' || part === '0ms')
  results.assert('reduced.frame-transition', !!frameDurations, {
    expected: 'reduced：窗口 transitionDuration 全 0s',
    actual: audit.frameTransition,
    category: 'reduced',
  })
  results.assert('reduced.pulse', audit.dotRunningProbe && audit.dotRunningProbe.animationName === 'none', {
    expected: 'reduced：运行态状态点 animation=none（临时把 data-tone 改为 running 探测后已还原）',
    actual: audit.dotRunningProbe,
    category: 'reduced',
  })
  results.assert('reduced.infinite-animations', audit.infiniteScan && audit.infiniteScan.count === 0, {
    expected: 'reduced：页面无 infinite 计算动画',
    actual: { count: audit.infiniteScan && audit.infiniteScan.count, items: audit.infiniteScan && audit.infiniteScan.items.slice(0, 5) },
    category: 'reduced',
  })

  // flash：reduced 下无动画、静态描边
  const candidates = await page.evaluate(() => window.__P4.snapshot().candidates)
  const flashId = candidates[0]
  const flash = await page.evaluate(async (id) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    window.__ONESTEP__.actions.demoFeedback({ flashSessionId: id })
    await sleep(120)
    const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-flash="1"]')
    const animations = document.getAnimations().filter((animation) => {
      const target = animation.effect && animation.effect.target
      return target && target.getAttribute && target.getAttribute('data-flash') === '1'
    }).map((animation) => ({ animationName: animation.animationName || null, duration: animation.effect.getTiming().duration }))
    return {
      found: !!el,
      animationName: el ? getComputedStyle(el).animationName : null,
      animationDuration: el ? getComputedStyle(el).animationDuration : null,
      borderColor: el ? getComputedStyle(el).borderColor : null,
      targetAnimations: animations,
      flashAnimationsCount: animations.length,
    }
  }, flashId)
  results.step('reduced.flash', flash)
  results.assert('reduced.flash', flash.found === true && flash.animationName === 'none' && flash.flashAnimationsCount === 0, {
    expected: 'reduced：完成闪烁 animation=none，无运行中 flash 动画（静态描边保留）',
    actual: flash,
    category: 'reduced',
  })
  // flash 窗口寿命（data-flash 移除耗时；reduced 不改变 JS 生命周期）
  const flashLife = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const started = performance.now()
    for (let index = 0; index < 80; index += 1) {
      if (!document.querySelector('[data-onestep-stage] .onestep-frame[data-flash="1"]')) break
      await sleep(50)
    }
    return { removedAfterMs: performance.now() - started }
  })
  results.step('reduced.flash-life', flashLife)
  results.metric('reduced.flashLife', flashLife)

  // ② JS 策略：产品动作不启动 VT（计数器不变）；守卫模拟 route=instant
  const vtCallsAfterProduct = await page.evaluate(() => window.__P4.readStartViewTransitionCounter())
  const promoteGuard = await page.evaluate(async (targetId) => {
    const R = window.__P4
    const started = performance.now()
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    let route = 'instant'
    // 计划 §4.2 的 motion.run：isReduced() → update(); record('instant')
    if (!reduced) {
      route = 'vt-would-start'
      return { reduced, route, skippedByPolicy: false }
    }
    let returnValue = null
    let error = null
    try { returnValue = window.__ONESTEP__.actions.promote(targetId) } catch (caught) { error = String(caught) }
    const committed = await R.pollUntil(() => {
      const snapshot = R.snapshot()
      return snapshot && snapshot.focusId === targetId
    }, 400)
    return {
      reduced,
      route,
      skippedByPolicy: true,
      returnValue,
      error,
      committed,
      latencyMs: R.round(performance.now() - started, 2),
      vtCalls: R.readStartViewTransitionCounter().count,
      animations: R.auditAnimations().count,
      pseudoAnimations: R.vtAnimations().length,
    }
  }, candidates[0])
  results.step('reduced.promote.guard', promoteGuard)
  results.metric('reduced.promoteGuard', promoteGuard)
  results.assert('reduced.product-no-vt', vtCallsAfterProduct.count === 0, {
    expected: '现有产品动作（enterStage/promote 等）在 reduced 下不调用 startViewTransition（计数器 0）',
    actual: vtCallsAfterProduct,
    category: 'reduced',
  })
  results.assert('reduced.guard-instant', promoteGuard.skippedByPolicy === true && promoteGuard.committed === true && promoteGuard.pseudoAnimations === 0 && promoteGuard.vtCalls === 0, {
    expected: 'motion.isReduced() 守卫模拟：route=instant、状态立即提交、无 VT 伪元素动画',
    actual: promoteGuard,
    category: 'reduced',
  })

  // ③ CSS 兜底：默认 250ms（无兜底）→ 注入计划 CSS 后 .001ms
  const noSuppression = await vtWithOptionalSuppression(page, { suppress: false, nodeId: 'p4-reduced-default' })
  const withSuppression = await vtWithOptionalSuppression(page, { suppress: true, css: VT_SUP_CSS, nodeId: 'p4-reduced-suppressed' })
  results.step('reduced.vt.css-fallback', { noSuppression, withSuppression })
  results.metric('reduced.vt.cssFallback', { defaultDurations: noSuppression.pseudoDurations, suppressedDurations: withSuppression.pseudoDurations, defaultFinishedMs: noSuppression.finishedMs, suppressedFinishedMs: withSuppression.finishedMs })
  results.assert('reduced.vt.default-250', noSuppression.started === true && (noSuppression.pseudoDurations || []).every((duration) => duration === 250), {
    expected: '无兜底 CSS 时 reduced context 下 VT 伪元素仍为默认 250ms（引擎不自动降级）',
    actual: { durations: noSuppression.pseudoDurations, finishedMs: noSuppression.finishedMs },
    category: 'reduced',
  })
  results.assert('reduced.vt.css-suppression', withSuppression.started === true && (withSuppression.pseudoDurations || []).length === 1 && withSuppression.pseudoDurations[0] === 0.001 && withSuppression.finishedMs < 120, {
    expected: '注入 @media reduce 兜底 CSS 后伪元素动画 duration=.001ms、finished < 120ms（§4.7 第三层机制有效）',
    actual: { durations: withSuppression.pseudoDurations, finishedMs: withSuppression.finishedMs, delays: withSuppression.pseudoDelays },
    category: 'reduced',
  })

  // ④ 清理与错误
  const cleanup = await page.evaluate(() => {
    const R = window.__P4
    const result = R.cleanup()
    return Object.assign(result, {
      pseudoLeft: R.vtAnimations().length,
      tempStyle: !!document.getElementById('p4-reduced-style'),
      tempNodes: document.querySelectorAll('[data-p4-probe]').length,
      visibility: document.visibilityState,
    })
  })
  results.step('cleanup.reduced', cleanup)
  results.data.env.pageErrors = app.handles.pageErrors.slice(0, 10)
  results.assert('reduced.cleanup', cleanup.pseudoLeft === 0 && cleanup.tempStyle === false && cleanup.tempNodes === 0, {
    expected: 'reduced 探针结束无残留动画/临时样式/临时节点',
    actual: cleanup,
    category: 'cleanup',
  })
  results.assert('reduced.no-pageerror', app.handles.pageErrors.length === 0, {
    expected: 'reduced 套件无 pageerror',
    actual: { pageErrors: app.handles.pageErrors.slice(0, 10) },
    category: 'env',
  })
} catch (error) {
  results.fatal(error)
} finally {
  try { await closeApp(app) } catch (_error) { /* ignore */ }
  const data = results.finish()
  console.log('[reduced] ok=' + data.ok + ' summary=' + JSON.stringify(data.summary))
  console.log('[reduced] json=' + relPath(path.join(OUT, 'reduced.json')))
}
process.exitCode = results.data.ok ? 0 : 1
