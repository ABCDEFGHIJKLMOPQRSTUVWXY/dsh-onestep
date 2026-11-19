/**
 * P4-9 m3：覆盖层动效验证 —— 计划 §5 G6。
 *
 * 覆盖：快速新建条进 180ms/出 120ms（computed transition-duration + 运行期 CSSTransition 时长）、
 *       菜单进场 onestep-menu-in 120ms（关闭即时，读数 ≤50ms）、picker mask 120ms / panel 160ms（关闭即时 ≤50ms）、
 *       toast onestep-toast-in 160ms + 1000ms 淡出 + role=status、
 *       HUD 140ms（静态规则 + token，标记 partial：拖拽 HUD 运行态需要真实指针拖拽，headless 下不做）。
 *
 * 运行：node scripts/p4/verify/m3-overlays.mjs
 * 产物：artifacts/p4/verify/m3-overlays.json
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  ROOT,
  openVerifyApp,
  closeApp,
  snapshot,
  geometry,
  waitMotionIdle,
  createResults,
  finishSuite,
  assertNoPageErrors,
  waitFor,
  sleep,
  listSessions,
  durationIncludes,
} from './lib.mjs'

const results = createResults('m3-overlays', 'P4-9 m3：覆盖层动效（G6）')
let app = null

try {
  app = await openVerifyApp({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
  const page = app.page
  results.setEnv('viewport', '1440x900')
  const rows = await listSessions(page)
  const ids = Object.keys(rows || {}).slice(0, 4)
  await page.evaluate((list) => window.__ONESTEP__.actions.enterStage(list), ids)
  await waitFor(async () => (await snapshot(page)).mounted === true, { timeout: 15000, label: 'stage.mounted' })
  await waitFor(async () => (await snapshot(page)).candidates.length >= 1, { timeout: 15000, label: 'stage.candidates' })
  await waitMotionIdle(page)

  // ---------- G6：快速新建条 进 180ms / 出 120ms ----------
  await page.click('[data-onestep-quick-open]')
  await page.waitForFunction(() => {
    const quick = document.querySelector('.onestep-quick')
    return !!quick && quick.getAttribute('data-open') === '1'
  }, null, { timeout: 5000 })
  const quickOpen = await page.evaluate(() => window.__V.computed('.onestep-quick-inner'))
  const quickTransitions = await page.evaluate(() => window.__V.animations().filter((animation) => animation.target && String(animation.target.cls || '').indexOf('onestep-quick-inner') >= 0))
  results.metric('m3.quick.open', { computed: quickOpen, transitions: quickTransitions })
  results.assert('m3.quick.open-180', durationIncludes(quickOpen.transitionDuration, '0.18s'), {
    category: 'duration',
    expected: '快速条开启 transition-duration = 0.18s',
    actual: { transitionDuration: quickOpen.transitionDuration, transitionProperty: quickOpen.transitionProperty },
  })
  results.assert('m3.quick.open-transition-live', quickTransitions.length === 0 || quickTransitions.every((animation) => Number(animation.duration) === 180), {
    category: 'duration',
    expected: '运行期 CSSTransition 180ms',
    actual: quickTransitions.map((animation) => ({ property: animation.transitionProperty, duration: animation.duration })),
  })
  await page.focus('.onestep-input')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => {
    const quick = document.querySelector('.onestep-quick')
    return !!quick && quick.getAttribute('data-open') === '0'
  }, null, { timeout: 5000 })
  const quickClosed = await page.evaluate(() => window.__V.computed('.onestep-quick-inner'))
  results.metric('m3.quick.closed', quickClosed)
  results.assert('m3.quick.close-120', durationIncludes(quickClosed.transitionDuration, '0.12s'), {
    category: 'duration',
    expected: '快速条关闭 transition-duration = 0.12s',
    actual: { transitionDuration: quickClosed.transitionDuration, transitionProperty: quickClosed.transitionProperty },
  })
  await sleep(220)

  // ---------- G6：菜单 120ms + 关闭即时 ----------
  await page.click('[data-onestep-more]')
  await page.waitForFunction(() => !!document.querySelector('.onestep-menu'), null, { timeout: 5000 })
  const menuComputed = await page.evaluate(() => window.__V.computed('.onestep-menu'))
  results.metric('m3.menu.open', menuComputed)
  results.assert('m3.menu.open-120', String(menuComputed.animationName || '').indexOf('onestep-menu-in') >= 0 && durationIncludes(menuComputed.animationDuration, '0.12s'), {
    category: 'duration',
    expected: { animationName: 'onestep-menu-in', animationDuration: '0.12s' },
    actual: { animationName: menuComputed.animationName, animationDuration: menuComputed.animationDuration },
  })
  const menuCloseLatency = await page.evaluate(async () => {
    const button = document.querySelector('[data-onestep-more]')
    if (!button) return { ok: false, reason: 'no-more-button' }
    const started = performance.now()
    button.click()
    return await new Promise((resolve) => {
      const tick = () => {
        if (!document.querySelector('.onestep-menu')) {
          resolve({ ok: true, latencyMs: Math.round(performance.now() - started) })
          return
        }
        if (performance.now() - started > 1000) {
          resolve({ ok: false, latencyMs: -1 })
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  })
  results.metric('m3.menu.closeLatency', menuCloseLatency)
  results.assert('m3.menu.close-not-delayed', menuCloseLatency.ok === true && menuCloseLatency.latencyMs <= 50, {
    category: 'closure', expected: '关闭（DOM 移除）≤50ms，不被动画延迟', actual: menuCloseLatency,
  })

  // ---------- G6：picker mask 120ms / panel 160ms + 关闭即时 ----------
  const openPicker = await page.evaluate(async () => {
    const actions = window.__ONESTEP__.actions
    if (typeof actions.openPicker === 'function') {
      actions.openPicker()
      return { path: 'actions.openPicker' }
    }
    const button = document.querySelector('[data-onestep-header-action]')
    if (button) {
      button.click()
      return { path: 'header-action-click' }
    }
    return { path: null, reason: 'no-open-picker-entry' }
  })
  let picker = null
  if (openPicker.path) {
    try {
      await page.waitForFunction(() => !!document.querySelector('[data-onestep-picker]'), null, { timeout: 5000 })
      const maskComputed = await page.evaluate(() => window.__V.computed('.onestep-picker-mask'))
      const panelComputed = await page.evaluate(() => window.__V.computed('.onestep-picker'))
      picker = { maskComputed, panelComputed }
      results.metric('m3.picker.open', { openPicker, ...picker })
      results.assert('m3.picker.mask-120', String(maskComputed.animationName || '').indexOf('onestep-mask-in') >= 0 && durationIncludes(maskComputed.animationDuration, '0.12s'), {
        category: 'duration',
        expected: { animationName: 'onestep-mask-in', animationDuration: '0.12s' },
        actual: { animationName: maskComputed.animationName, animationDuration: maskComputed.animationDuration },
      })
      results.assert('m3.picker.panel-160', String(panelComputed.animationName || '').indexOf('onestep-panel-in') >= 0 && durationIncludes(panelComputed.animationDuration, '0.16s'), {
        category: 'duration',
        expected: { animationName: 'onestep-panel-in', animationDuration: '0.16s' },
        actual: { animationName: panelComputed.animationName, animationDuration: panelComputed.animationDuration },
      })
      await sleep(200)
      const pickerCloseLatency = await page.evaluate(async () => {
        const mask = document.querySelector('.onestep-picker-mask')
        if (!mask) return { ok: false, reason: 'no-mask' }
        const started = performance.now()
        mask.click()
        return await new Promise((resolve) => {
          const tick = () => {
            if (!document.querySelector('.onestep-picker-mask')) {
              resolve({ ok: true, latencyMs: Math.round(performance.now() - started) })
              return
            }
            if (performance.now() - started > 1000) {
              resolve({ ok: false, latencyMs: -1 })
              return
            }
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
      })
      results.metric('m3.picker.closeLatency', pickerCloseLatency)
      results.assert('m3.picker.close-not-delayed', pickerCloseLatency.ok === true && pickerCloseLatency.latencyMs <= 50, {
        category: 'closure', expected: 'picker 关闭（DOM 移除）≤50ms，焦点/状态不被动画延迟', actual: pickerCloseLatency,
      })
    } catch (error) {
      results.assert('m3.picker.open', false, { category: 'duration', expected: 'picker 打开', actual: { openPicker, error: String(error) } })
    }
  } else {
    results.skip('m3.picker', '无 picker 打开入口（probe 面 actions.openPicker 与 header 按钮均不可用）：' + (openPicker.reason || ''), 'surface-gap')
  }

  // ---------- G6：toast 进场 160ms + 1000ms 淡出 + role=status ----------
  await page.evaluate(() => window.__ONESTEP__.actions.closeFocus())
  await page.waitForFunction(() => !!document.querySelector('.onestep-toast'), null, { timeout: 6000 })
  const toast = await page.evaluate(() => {
    const element = document.querySelector('.onestep-toast')
    const cs = getComputedStyle(element)
    const animations = window.__V.animations().filter((animation) => animation.target && String(animation.target.cls || '').indexOf('onestep-toast') >= 0)
    return {
      role: element.getAttribute('role'),
      animationName: cs.animationName,
      animationDuration: cs.animationDuration,
      animationDelay: cs.animationDelay,
      animations: animations.map((animation) => ({ name: animation.animationName, duration: animation.duration, delay: animation.delay, playState: animation.playState })),
    }
  })
  results.metric('m3.toast', toast)
  results.assert('m3.toast.role', toast.role === 'status', { category: 'toast', expected: 'role=status', actual: toast.role })
  results.assert('m3.toast.in-160', String(toast.animationName || '').indexOf('onestep-toast-in') >= 0 && durationIncludes(toast.animationDuration, '0.16s'), {
    category: 'duration', expected: { animationName: 'onestep-toast-in', animationDuration: '0.16s' }, actual: { animationName: toast.animationName, animationDuration: toast.animationDuration },
  })
  results.assert('m3.toast.out-1000', durationIncludes(toast.animationDuration, '1s'), {
    category: 'duration', expected: 'toast 淡出 animation-duration 含 1s', actual: { animationDuration: toast.animationDuration, animationDelay: toast.animationDelay, animations: toast.animations },
  })

  // ---------- G6：HUD 140ms（静态规则 + token，记录 partial） ----------
  const stylesSource = fs.readFileSync(path.join(ROOT, 'src', 'client', 'styles.js'), 'utf8')
  const dragSource = fs.readFileSync(path.join(ROOT, 'src', 'client', 'drag.js'), 'utf8')
  const hudRule = /\.onestep-hud-zone\{[^}]*animation:onestep-hud-in var\(--onestep-hud\)/m.test(stylesSource)
  const hudToken = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--onestep-hud').trim())
  const dragLiterals = (dragSource.match(/\b\d+(?:\.\d+)?ms\b/g) || [])
  results.metric('m3.hud', { hudRule, hudToken, dragLiterals, hudCount: (await geometry(page)).dom.hudCount })
  results.assert('m3.hud.css-rule', hudRule, {
    category: 'duration', expected: '.onestep-hud-zone 使用 onestep-hud-in var(--onestep-hud)', actual: { hudRule },
  })
  results.assert('m3.hud.token-140', hudToken === '140ms', { category: 'duration', expected: '--onestep-hud=140ms', actual: hudToken })
  results.assert('m3.hud.no-literal-duration', dragLiterals.length === 0, {
    category: 'duration', expected: 'drag.js 不残留裸时长字面量（全部 token）', actual: dragLiterals,
  })
  results.skip('m3.hud.live', '拖拽 HUD 运行态需要真实 pointer 拖拽（headless 下不稳定）：已用 CSS 规则 + token + drag.js 无字面量三条静态断言覆盖，记录为 partial', 'partial')

  const infinite = await page.evaluate(() => window.__V.pluginInfinite())
  results.assert('m3.idle.no-infinite', infinite.count === 0, { category: 'cleanup', expected: '插件自有 infinite=0', actual: infinite })
  assertNoPageErrors(results, app.handles, 'm3')
} catch (error) {
  results.fatal(error)
} finally {
  try {
    if (app) await closeApp(app)
  } catch (_error) { /* ignore */ }
  finishSuite(results)
}
process.exitCode = results.data.ok ? 0 : 1
