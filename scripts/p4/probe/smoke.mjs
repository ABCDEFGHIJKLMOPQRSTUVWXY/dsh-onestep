/**
 * P4-1 基础设施冒烟（Lead）：验证隔离实例 + Playwright + 探针链路可用，
 * 并做第一轮 View Transitions 能力探测（不修改产品源码，只在页面里创建临时节点）。
 *
 * 用法：node scripts/p4/probe/smoke.mjs
 * 产物：artifacts/p4/probe/smoke.json
 */
import fs from 'node:fs'
import path from 'node:path'

import { ROOT, readServerUrl, openApp, closeApp, enterStage, sleep } from '../../p3/probe/lib.mjs'

const OUT = path.join(ROOT, 'artifacts', 'p4', 'probe')
fs.mkdirSync(OUT, { recursive: true })
const outFile = path.join(OUT, 'smoke.json')

const data = {
  suite: 'p4-smoke',
  title: 'P4-1 基础设施与首轮 VT 能力冒烟',
  startedAt: new Date().toISOString(),
  urlFile: path.relative(ROOT, path.join(ROOT, 'artifacts', 'p3', 'server-url.txt')).replace(/\\/g, '/'),
  capability: null,
  simpleTransition: null,
  stage: null,
  pageErrors: [],
  consoleErrors: [],
  ok: false,
}

let app = null
try {
  app = await openApp({ url: readServerUrl(), viewport: { width: 1440, height: 900 } })
  const { page } = app

  data.capability = await page.evaluate(() => {
    const probe = window.__ONESTEP__ || {}
    const snap = (() => { try { return probe.actions && probe.actions.snapshot ? probe.actions.snapshot() : null } catch (e) { return null } })()
    return {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      devicePixelRatio: window.devicePixelRatio,
      startViewTransition: typeof document.startViewTransition === 'function',
      activeViewTransitionInDocument: 'activeViewTransition' in document,
      getAnimations: typeof document.getAnimations === 'function',
      probeVersion: probe.version || null,
      probeActionNames: probe.actions ? Object.keys(probe.actions).sort() : [],
      mounted: snap ? !!snap.mounted : null,
      reducedMotionMedia: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    }
  })

  // 简单同文档过渡：临时节点命名 → 改变 transform → 记录 ready/finished 与伪元素动画
  data.simpleTransition = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    if (typeof document.startViewTransition !== 'function') return { supported: false }
    const host = document.createElement('div')
    host.setAttribute('data-p4-vt-probe', '1')
    host.style.cssText = 'position:fixed;left:24px;top:24px;width:80px;height:40px;background:#4c8dff;z-index:2147483000;view-transition-name:onestep-p4-probe'
    document.body.appendChild(host)
    await sleep(50)
    const started = performance.now()
    let ready = null
    const collect = () => document.getAnimations().map((a) => ({
      duration: a.effect && a.effect.getTiming ? a.effect.getTiming().duration : null,
      pseudoElement: a.effect && a.effect.pseudoElement ? a.effect.pseudoElement : null,
      playState: a.playState,
    }))
    // 关键探测（P4-1）：更新回调内 await rAF 会死锁（渲染被 VT 暂停），await 宏任务不会。
    const vt = document.startViewTransition(async () => {
      await new Promise((r) => setTimeout(r, 32))
      host.style.transform = 'translateX(120px)'
    })
    let readyError = null
    await vt.ready.then(() => { ready = performance.now() - started }).catch((error) => { readyError = String(error && error.message ? error.message : error) })
    await sleep(30)
    const animations = collect()
    const finishedMs = await vt.finished.then(() => performance.now() - started).catch(() => null)
    const result = {
      supported: true,
      readyMs: ready,
      readyError,
      finishedMs,
      animationsDuring: animations,
      animationsAfter: collect(),
      asyncCallbackOk: readyError === null && finishedMs !== null,
    }
    host.remove()
    return result
  })

  // 舞台可用性
  await enterStage(page, { count: 3 })
  await sleep(600)
  data.stage = await page.evaluate(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    const focus = stage && stage.querySelector('.onestep-frame[data-mode="focus"]')
    const candidates = stage ? Array.from(stage.querySelectorAll('.onestep-frame[data-mode="candidate"]')) : []
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    const snap = window.__ONESTEP__.actions.snapshot()
    return {
      mounted: !!stage,
      focusRect: focus ? rect(focus) : null,
      candidateCount: candidates.length,
      candidateRects: candidates.map(rect),
      focusSession: snap.focusId || null,
      candidateSessions: candidates.map((el) => el.getAttribute('data-onestep-window-session')),
      windowSessions: Array.from(stage ? stage.querySelectorAll('[data-onestep-window-session]') : []).map((el) => el.getAttribute('data-onestep-window-session')),
      vtNames: Array.from(stage ? stage.querySelectorAll('.onestep-frame') : []).map((el) => getComputedStyle(el).viewTransitionName || null),
    }
  })
  data.pageErrors = app.handles.pageErrors
  data.consoleErrors = app.handles.consoleErrors.slice(0, 10)
  data.ok = !!(data.capability && data.capability.startViewTransition && data.simpleTransition && data.simpleTransition.supported && data.stage && data.stage.mounted)
} catch (error) {
  data.error = String((error && error.stack) || error)
} finally {
  await closeApp(app)
  data.finishedAt = new Date().toISOString()
  fs.writeFileSync(outFile, JSON.stringify(data, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify({ ok: data.ok, outFile: path.relative(ROOT, outFile).replace(/\\/g, '/'), capability: data.capability, simpleTransition: data.simpleTransition, stage: data.stage, error: data.error || null, pageErrors: data.pageErrors }, null, 2))
}
process.exitCode = data.ok ? 0 : 1
