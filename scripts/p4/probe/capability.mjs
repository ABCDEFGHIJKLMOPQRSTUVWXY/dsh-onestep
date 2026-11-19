/**
 * P4-1 探针①：能力探测（docs/p4-plan.md §4.10 #1）
 *
 * 内容：
 * - 页面环境基线（UA/Chromium/可见性/无 pageerror）；
 * - VT API：startViewTransition / activeViewTransition / skipTransition / getAnimations 伪元素可读；
 * - 临时节点简单过渡：ready/finished、伪元素动画可读、结束后零残留；
 * - skipTransition 行为（进行中跳过 → finished 立即 resolve、无残留）；
 * - reduced context（openApp({reducedMotion:'reduce'})）：matchMedia=true、引擎仍支持 VT、简单过渡可跑。
 *
 * 用法：node scripts/p4/probe/capability.mjs
 * 产物：artifacts/p4/probe/capability.json
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  OUT, SHOTS, createResults, sleep, openApp, closeApp, readServerUrl,
  pageEnv, capture, relPath, installRuntime, vtAnimationBreakdown,
} from './lib.mjs'

const results = createResults('capability', 'P4-1 探针①：VT 能力与 reduced context')
let app = null
let reducedApp = null

const PROBE_NODE_ID = 'p4-probe-node'

/** 注入临时探针节点 + 简单过渡（页面运行时；不写产品源码）。 */
async function simpleTransition(page, options = {}) {
  return page.evaluate(async ({ reduced, nodeId }) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const started = performance.now()
    const existing = document.getElementById(nodeId)
    if (existing) existing.remove()
    const host = document.createElement('div')
    host.id = nodeId
    host.setAttribute('data-p4-probe', '1')
    host.style.cssText = 'position:fixed;left:24px;top:24px;width:80px;height:40px;background:#4c8dff;z-index:2147483000;view-transition-name:onestep-p4-probe'
    document.body.appendChild(host)
    await sleep(50)
    const collect = () => document.getAnimations().map((animation) => {
      const effect = animation.effect
      const timing = effect && typeof effect.getTiming === 'function' ? effect.getTiming() : {}
      return {
        pseudoElement: effect && effect.pseudoElement ? effect.pseudoElement : null,
        duration: timing.duration,
        delay: timing.delay || 0,
        playState: animation.playState,
      }
    })
    const before = collect()
    let vt = null
    let startError = null
    try {
      vt = document.startViewTransition(async () => {
        await sleep(0)
        await sleep(0)
        host.style.transform = 'translateX(120px)'
      })
    } catch (error) {
      startError = String(error)
    }
    if (!vt) {
      host.remove()
      return { supported: typeof document.startViewTransition === 'function', startError, before, reduced }
    }
    const vtApi = {
      skipTransition: typeof vt.skipTransition,
      readyThen: !!(vt.ready && typeof vt.ready.then === 'function'),
      finishedThen: !!(vt.finished && typeof vt.finished.then === 'function'),
      updateCallbackDoneThen: !!(vt.updateCallbackDone && typeof vt.updateCallbackDone.then === 'function'),
    }
    let readyMs = null
    let readyError = null
    let finishedMs = null
    let finishedError = null
    await vt.ready.then(() => { readyMs = performance.now() - started }, (error) => { readyError = String(error) })
    const during = collect()
    const activeDuring = !!document.activeViewTransition
    await sleep(20)
    await vt.finished.then(() => { finishedMs = performance.now() - started }, (error) => { finishedError = String(error) })
    const after = collect()
    const hostRect = host.getBoundingClientRect()
    host.remove()
    return {
      supported: true,
      reduced,
      startError,
      vtApi,
      readyMs,
      readyError,
      currentTimeAtReady: null,
      during,
      activeDuring,
      finishedMs,
      finishedError,
      after,
      pseudoDuringCount: during.filter((item) => item.pseudoElement).length,
      pseudoAfterCount: after.filter((item) => item.pseudoElement).length,
      transformAfter: hostRect.x,
      visibility: document.visibilityState,
    }
  }, { reduced: options.reduced === true, nodeId: options.nodeId || PROBE_NODE_ID })
}

/** skipTransition：进行中跳过 → finished 立即 resolve、伪元素动画零残留。 */
async function skipTransitionTest(page) {
  return page.evaluate(async (nodeId) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const host = document.createElement('div')
    host.id = nodeId + '-skip'
    host.style.cssText = 'position:fixed;left:200px;top:24px;width:60px;height:30px;background:#22c55e;z-index:2147483000;view-transition-name:onestep-p4-skip'
    document.body.appendChild(host)
    await sleep(30)
    const started = performance.now()
    const errors = []
    let vt = null
    try {
      vt = document.startViewTransition(async () => {
        await sleep(0)
        host.style.transform = 'translateX(60px)'
      })
    } catch (error) {
      errors.push('start:' + String(error))
    }
    if (!vt) {
      host.remove()
      return { started: true, errors }
    }
    let readyMs = null
    let finishedMs = null
    let readyError = null
    let finishedError = null
    vt.ready.then(() => { readyMs = performance.now() - started }, (error) => { readyError = String(error) })
    vt.finished.then(() => { finishedMs = performance.now() - started }, (error) => { finishedError = String(error) })
    // 等 ready 后立即跳过（模拟 D4：动画进行中收到新请求）
    await vt.ready.catch(() => {})
    const skipAt = performance.now() - started
    let skipError = null
    try { vt.skipTransition() } catch (error) { skipError = String(error) }
    await vt.finished.catch(() => {})
    await sleep(30)
    const pseudoLeft = document.getAnimations().filter((animation) => animation.effect && animation.effect.pseudoElement).length
    const activeAfter = !!document.activeViewTransition
    host.remove()
    return { started: true, errors, readyMs, readyError, skipAt, skipError, finishedMs, finishedError, pseudoLeft, activeAfter, finishedAfterSkip: finishedMs !== null }
  }, PROBE_NODE_ID)
}

try {
  results.data.env.urlFile = relPath(path.join('artifacts', 'p3', 'server-url.txt'))
  results.data.env.command = 'node scripts/p4/probe/capability.mjs'

  // ---------- 正常 context ----------
  app = await openApp({ viewport: { width: 1440, height: 900 } })
  const { page } = app
  const env = await pageEnv(page)
  results.data.env.normal = env
  results.setEnv('url', String(readServerUrl()).replace(/token=[^&]+/, 'token=***'))
  results.step('env.normal', env)
  results.assert('env.visibility', env.visibilityState === 'visible' && env.hidden === false, {
    expected: '探针页面可见（document.visibilityState=visible / hidden=false）',
    actual: { visibilityState: env.visibilityState, hidden: env.hidden },
    category: 'env',
  })

  const install = await installRuntime(page)
  results.step('runtime.install', install)

  const api = await page.evaluate(() => {
    const hasOwn = (name) => Object.prototype.hasOwnProperty.call(document, name) || name in document
    return {
      startViewTransition: typeof document.startViewTransition,
      activeViewTransitionInDocument: 'activeViewTransition' in document,
      getAnimations: typeof document.getAnimations,
      skipTransitionOnPrototype: (() => {
        // 不启动真实过渡；只检查 document.activeViewTransition 的原型方法是否可预期（当前为 null）
        return document.activeViewTransition === null
      })(),
      cssViewTransitionName: CSS.supports('view-transition-name', 'none'),
      longtaskSupported: typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask'),
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      viewTransitionTypesSupported: CSS.supports('view-transition-name', 'none') && typeof document.startViewTransition === 'function',
      hasOwnActiveViewTransition: hasOwn('activeViewTransition'),
    }
  })
  results.step('vt.api', api)
  results.assert('vt.api.present', api.startViewTransition === 'function' && api.activeViewTransitionInDocument === true && api.getAnimations === 'function', {
    expected: 'document.startViewTransition / activeViewTransition / getAnimations 全部存在',
    actual: api,
    category: 'capability',
  })
  results.assert('vt.css.property', api.cssViewTransitionName === true, {
    expected: 'CSS.supports(view-transition-name) 为真（样式注入路径可用）',
    actual: { cssViewTransitionName: api.cssViewTransitionName },
    category: 'capability',
  })
  results.assert('perf.longtask-api', api.longtaskSupported === true, {
    expected: 'PerformanceObserver 支持 longtask（P4-9 需要长任务门禁）',
    actual: { longtaskSupported: api.longtaskSupported },
    category: 'capability',
  })

  const simple = await simpleTransition(page, { reduced: false })
  results.step('vt.simple', simple)
  results.metric('vt.simple', { readyMs: simple.readyMs, finishedMs: simple.finishedMs, pseudoDuringCount: simple.pseudoDuringCount })
  results.assert('vt.simple.supported', simple.supported === true && !simple.startError, {
    expected: '临时节点简单过渡可启动',
    actual: { supported: simple.supported, startError: simple.startError },
    category: 'capability',
  })
  results.assert('vt.simple.api', simple.vtApi && simple.vtApi.skipTransition === 'function' && simple.vtApi.readyThen && simple.vtApi.finishedThen, {
    expected: 'ViewTransition 实例暴露 skipTransition/ready/finished',
    actual: simple.vtApi,
    category: 'capability',
  })
  results.assert('vt.simple.ready', typeof simple.readyMs === 'number' && simple.readyError === null && simple.readyMs < 150, {
    expected: 'ready resolve（<150ms）',
    actual: { readyMs: simple.readyMs, readyError: simple.readyError },
    category: 'capability',
  })
  results.assert('vt.simple.finished', typeof simple.finishedMs === 'number' && simple.finishedError === null, {
    expected: 'finished resolve',
    actual: { finishedMs: simple.finishedMs, finishedError: simple.finishedError },
    category: 'capability',
  })
  results.assert('vt.simple.pseudo-readable', simple.pseudoDuringCount > 0 && simple.during.every((item) => item.pseudoElement === null || /^::view-transition-/.test(item.pseudoElement)), {
    expected: 'getAnimations() 能读到 VT 伪元素动画（effect.pseudoElement）',
    actual: { pseudoDuringCount: simple.pseudoDuringCount, sample: simple.during.slice(0, 6) },
    category: 'capability',
  })
  results.assert('vt.simple.clean', simple.pseudoAfterCount === 0 && (typeof simple.finishedMs === 'number'), {
    expected: '过渡结束后伪元素动画清零（可做「暂停+seek」与残留断言）',
    actual: { pseudoAfterCount: simple.pseudoAfterCount },
    category: 'capability',
  })
  const breakdown = vtAnimationBreakdown(simple.during)
  results.step('vt.simple.pseudo-groups', Object.keys(breakdown))
  results.metric('vt.simple.pseudoNames', Object.keys(breakdown))

  const skip = await skipTransitionTest(page)
  results.step('vt.skip', skip)
  results.metric('vt.skip', { finishedAfterSkip: skip.finishedAfterSkip, pseudoLeft: skip.pseudoLeft, activeAfter: skip.activeAfter })
  results.assert('vt.skipTransition', skip.started === true && skip.skipError === null && skip.finishedAfterSkip === true && skip.pseudoLeft === 0 && skip.activeAfter === false, {
    expected: 'skipTransition() 后 finished 立即 resolve 且伪元素动画零残留',
    actual: skip,
    category: 'capability',
  })

  const afterAll = await page.evaluate(() => ({
    pseudoAnimations: document.getAnimations().filter((animation) => animation.effect && animation.effect.pseudoElement).length,
    activeViewTransition: !!document.activeViewTransition,
    probeNodes: document.querySelectorAll('[data-p4-probe]').length,
    visibility: document.visibilityState,
  }))
  results.step('cleanup.normal', afterAll)
  results.assert('cleanup.normal', afterAll.pseudoAnimations === 0 && afterAll.activeViewTransition === false && afterAll.probeNodes === 0, {
    expected: '能力探测后页面无残留 VT 动画/活动过渡/临时节点',
    actual: afterAll,
    category: 'cleanup',
  })
  results.data.env.pageErrorsNormal = app.handles.pageErrors.slice(0, 10)
  results.assert('env.normal.no-pageerror', app.handles.pageErrors.length === 0, {
    expected: '正常 context 无 pageerror',
    actual: { pageErrors: app.handles.pageErrors.slice(0, 10) },
    category: 'env',
  })
  await closeApp(app)
  app = null

  // ---------- reduced context ----------
  reducedApp = await openApp({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const rPage = reducedApp.page
  const reducedEnv = await pageEnv(rPage)
  results.data.env.reduced = reducedEnv
  results.step('env.reduced', reducedEnv)
  results.assert('reduced.ctx.matchMedia', reducedEnv.reducedMotion === true, {
    expected: 'reduced context 下 matchMedia(prefers-reduced-motion: reduce)=true',
    actual: { reducedMotion: reducedEnv.reducedMotion },
    category: 'reduced',
  })
  results.assert('reduced.ctx.vt-engine', reducedEnv.startViewTransition === 'function' && reducedEnv.getAnimations === 'function', {
    expected: 'reduced context 下引擎仍支持 VT（是否启用由产品 JS/CSS 决定）',
    actual: { startViewTransition: reducedEnv.startViewTransition, getAnimations: reducedEnv.getAnimations },
    category: 'reduced',
  })
  await installRuntime(rPage)
  const reducedSimple = await simpleTransition(rPage, { reduced: true })
  results.step('vt.simple.reduced', reducedSimple)
  results.metric('vt.simple.reduced', { readyMs: reducedSimple.readyMs, finishedMs: reducedSimple.finishedMs, pseudoDuringCount: reducedSimple.pseudoDuringCount })
  results.assert('reduced.ctx.vt-runs', reducedSimple.supported === true && typeof reducedSimple.finishedMs === 'number', {
    expected: 'reduced context 下简单 VT 仍可运行（证明「跳过 VT」必须由产品策略执行，引擎不会自动跳过）',
    actual: { supported: reducedSimple.supported, readyMs: reducedSimple.readyMs, finishedMs: reducedSimple.finishedMs },
    category: 'reduced',
  })
  results.data.env.pageErrorsReduced = reducedApp.handles.pageErrors.slice(0, 10)
  results.assert('env.reduced.no-pageerror', reducedApp.handles.pageErrors.length === 0, {
    expected: 'reduced context 无 pageerror',
    actual: { pageErrors: reducedApp.handles.pageErrors.slice(0, 10) },
    category: 'env',
  })
} catch (error) {
  results.fatal(error)
} finally {
  try { await closeApp(reducedApp) } catch (_error) { /* ignore */ }
  try { await closeApp(app) } catch (_error) { /* ignore */ }
  const data = results.finish()
  console.log('[capability] ok=' + data.ok + ' summary=' + JSON.stringify(data.summary))
  console.log('[capability] json=' + relPath(path.join(OUT, 'capability.json')))
}
process.exitCode = results.data.ok ? 0 : 1
