/**
 * P4-9 m2：舞台 / 候场栏 / 反馈动效验证 —— 计划 §5 G4 + G5。
 *
 * 覆盖：
 * - G4：舞台进场 onestep-stage-in 260ms（data-ready=1）、焦点窗/候场栏进场动画、
 *       候场栏收起/展开 VT（220ms，onestep-rail 组）、分隔条 hover 120ms、落点高亮 120ms（可选，事件派发路径）；
 * - G5：完成闪烁 onestep-flash 1200ms（iteration=1）+ 1400ms 自动清除、idle 插件自有 infinite=0、
 *       气泡进场 180ms（出场 120ms 走静态规则断言，probe 面暂无 clearBubble 触发路径）、控制点 hover 120ms（transform）。
 *
 * 运行：node scripts/p4/verify/m2-stage.mjs
 * 产物：artifacts/p4/verify/m2-stage.json
 */
import {
  openVerifyApp,
  closeApp,
  snapshot,
  geometry,
  motionState,
  waitMotionIdle,
  createResults,
  finishSuite,
  assertNoPageErrors,
  triggerWithWatch,
  waitPseudoAnimations,
  resumePseudo,
  shot,
  waitFor,
  sleep,
  listSessions,
  durationIncludes,
} from './lib.mjs'

const results = createResults('m2-stage', 'P4-9 m2：舞台进场/栏/反馈动效（G4+G5）')
let app = null

function findGroup(items, name) {
  const expected = '::view-transition-group(' + name + ')'
  return (items || []).find((item) => item.pseudoElement === expected) || null
}

try {
  app = await openVerifyApp({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
  const page = app.page
  results.setEnv('viewport', '1440x900')

  // ---------- G4：舞台进场 260ms ----------
  const rows = await listSessions(page)
  const ids = Object.keys(rows || {}).slice(0, 4)
  if (ids.length < 3) throw new Error('m2 需要至少 3 个 session（现有 ' + ids.length + '）')
  const enterResult = await page.evaluate(async (list) => {
    window.__V.startAnimationWatcher()
    const result = await window.__ONESTEP__.actions.enterStage(list)
    return { mounted: result.mounted, focusId: result.focusId, candidates: result.candidates }
  }, ids)
  await page.waitForFunction(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    return !!stage && stage.getAttribute('data-ready') === '1'
  }, null, { timeout: 15000 })
  await waitFor(async () => (await snapshot(page)).mounted === true, { timeout: 12000, label: 'stage.mounted' })
  await waitMotionIdle(page)
  const stageAnimations = await page.evaluate(() => window.__V.computed('[data-onestep-stage]'))
  const focusEnter = await page.evaluate(() => window.__V.computed('[data-onestep-stage] .onestep-frame[data-mode="focus"]'))
  const railEnter = await page.evaluate(() => window.__V.computed('[data-onestep-stage] .onestep-stage-rail'))
  const watcher = await page.evaluate(() => window.__V.stopAnimationWatcher())
  const stageAttr = await page.evaluate(() => document.querySelector('[data-onestep-stage]').getAttribute('data-ready'))
  results.metric('m2.stageEnter', { enterResult, stageAttr, watcher: watcher.seen, stageAnimations, focusEnter, railEnter })
  results.assert('m2.stage.enter-windows', enterResult.mounted === true && (enterResult.candidates || []).length >= 1, {
    category: 'stage', expected: 'mounted + 至少 1 候场', actual: enterResult,
  })
  results.assert('m2.stage.data-ready', stageAttr === '1', { category: 'stage', expected: '1', actual: stageAttr })
  results.assert('m2.stage.enter-animation', String(stageAnimations.animationName || '').indexOf('onestep-stage-in') >= 0 && durationIncludes(stageAnimations.animationDuration, '0.26s'), {
    category: 'stage',
    expected: { animationName: 'onestep-stage-in', animationDuration: '0.26s' },
    actual: { animationName: stageAnimations.animationName, animationDuration: stageAnimations.animationDuration },
  })
  results.assert('m2.stage.enter-focus-animation', String(focusEnter.animationName || '').indexOf('onestep-focus-in') >= 0 && durationIncludes(focusEnter.animationDuration, '0.26s'), {
    category: 'stage',
    expected: { animationName: 'onestep-focus-in', animationDuration: '0.26s' },
    actual: { animationName: focusEnter.animationName, animationDuration: focusEnter.animationDuration },
  })
  results.assert('m2.stage.enter-rail-animation', String(railEnter.animationName || '').indexOf('onestep-rail-in') >= 0 && durationIncludes(railEnter.animationDuration, '0.26s'), {
    category: 'stage',
    expected: { animationName: 'onestep-rail-in', animationDuration: '0.26s' },
    actual: { animationName: railEnter.animationName, animationDuration: railEnter.animationDuration },
  })
  results.assert('m2.stage.enter-watcher', !!(watcher.seen['onestep-stage-in'] && Number(watcher.seen['onestep-stage-in'].duration) === 260), {
    category: 'stage',
    expected: '运行期观察到 onestep-stage-in duration=260',
    actual: watcher.seen['onestep-stage-in'] || null,
  })

  // ---------- G4：候场栏收起/展开 VT 220ms ----------
  const railBefore = await geometry(page)
  await waitMotionIdle(page)
  const collapseHandle = await triggerWithWatch(page, () => page.evaluate(() => window.__ONESTEP__.actions.setRailCollapsed(true)), { label: 'm2.rail.collapse' })
  await waitPseudoAnimations(page, 6000)
  if (collapseHandle.pseudo.current.length > 0) await resumePseudo(page)
  await waitFor(async () => (await snapshot(page)).railCollapsed === true, { timeout: 8000, label: 'rail.collapsed' })
  await waitMotionIdle(page)
  const collapseWatch = await collapseHandle.stop()
  const collapsedGeo = await geometry(page)
  const collapseItems = collapseHandle.pseudo.current.length > 0 ? collapseHandle.pseudo.current : (collapseWatch && collapseWatch.pseudoFirst ? collapseWatch.pseudoFirst.items : [])
  const collapseGroup = findGroup(collapseItems, 'onestep-rail')
  const collapseMotion = await motionState(page)
  results.metric('m2.railCollapse', {
    route: collapseMotion.controller.last,
    group: collapseGroup,
    railCollapsed: collapsedGeo.snapshot.railCollapsed,
    focusBefore: railBefore.focus && railBefore.focus.rect,
    focusAfter: collapsedGeo.focus && collapsedGeo.focus.rect,
    pseudo: collapseItems.map((item) => item.pseudoElement),
  })
  results.assert('m2.rail.collapse-vt-group', collapseMotion.controller.last.route === 'vt' && !!collapseGroup, {
    category: 'rail',
    expected: '::view-transition-group(onestep-rail) 存在',
    actual: { route: collapseMotion.controller.last, pseudo: collapseItems.map((item) => item.pseudoElement) },
  })
  if (collapseGroup) {
    results.assert('m2.rail.collapse-duration', Number(collapseGroup.duration) === 220, {
      category: 'duration', expected: '220ms', actual: { duration: collapseGroup.duration, delay: collapseGroup.delay },
    })
  }
  results.assert('m2.rail.collapse-state', collapsedGeo.snapshot.railCollapsed === true && collapsedGeo.snapshot.mounted === true, {
    category: 'rail', expected: { railCollapsed: true, mounted: true }, actual: { railCollapsed: collapsedGeo.snapshot.railCollapsed, mounted: collapsedGeo.snapshot.mounted },
  })
  results.assert('m2.rail.collapse-geometry', !!(railBefore.focus && collapsedGeo.focus && collapsedGeo.focus.rect.w > railBefore.focus.rect.w), {
    category: 'geometry',
    expected: '收起后焦点窗变宽（栏收为 40px）',
    actual: { before: railBefore.focus && railBefore.focus.rect, after: collapsedGeo.focus && collapsedGeo.focus.rect },
  })
  results.assert('m2.rail.collapse-layout-deviation', (() => {
    const layout = collapsedGeo.layout || {}
    const focusRect = collapsedGeo.focus && collapsedGeo.focus.rect
    if (!focusRect || !layout.focus) return false
    return Math.abs(focusRect.x - layout.focus.x) <= 0.5 && Math.abs(focusRect.w - layout.focus.w) <= 0.5 && Math.abs(focusRect.h - layout.focus.h) <= 0.5
  })(), {
    category: 'geometry', expected: '≤0.5px', actual: { focus: collapsedGeo.focus && collapsedGeo.focus.rect, layout: collapsedGeo.layout && collapsedGeo.layout.focus },
  })

  // 展开
  await waitMotionIdle(page)
  const expandHandle = await triggerWithWatch(page, () => page.evaluate(() => window.__ONESTEP__.actions.setRailCollapsed(false)), { label: 'm2.rail.expand' })
  await waitPseudoAnimations(page, 6000)
  if (expandHandle.pseudo.current.length > 0) await resumePseudo(page)
  await waitFor(async () => (await snapshot(page)).railCollapsed === false, { timeout: 8000, label: 'rail.expanded' })
  await waitMotionIdle(page)
  const expandWatch = await expandHandle.stop()
  const expandedGeo = await geometry(page)
  const expandItems = expandHandle.pseudo.current.length > 0 ? expandHandle.pseudo.current : (expandWatch && expandWatch.pseudoFirst ? expandWatch.pseudoFirst.items : [])
  const expandGroup = findGroup(expandItems, 'onestep-rail')
  results.metric('m2.railExpand', { group: expandGroup, pseudo: expandItems.map((item) => item.pseudoElement), railCollapsed: expandedGeo.snapshot.railCollapsed })
  results.assert('m2.rail.expand-vt-group', !!expandGroup && Number(expandGroup.duration) === 220, {
    category: 'rail', expected: '::view-transition-group(onestep-rail) 220ms', actual: expandGroup || { pseudo: expandItems.map((item) => item.pseudoElement) },
  })
  results.assert('m2.rail.expand-state', expandedGeo.snapshot.railCollapsed === false, {
    category: 'rail', expected: false, actual: expandedGeo.snapshot.railCollapsed,
  })
  results.assert('m2.rail.expand-geometry', !!(railBefore.focus && expandedGeo.focus && Math.abs(expandedGeo.focus.rect.w - railBefore.focus.rect.w) <= 0.5), {
    category: 'geometry', expected: '展开后焦点窗宽度回到初始', actual: { before: railBefore.focus && railBefore.focus.rect, after: expandedGeo.focus && expandedGeo.focus.rect },
  })

  // ---------- G4：分隔条 hover 120ms ----------
  const splitterBase = await page.evaluate(() => window.__V.computed('.onestep-splitter', '::after'))
  results.metric('m2.splitter', splitterBase)
  results.assert('m2.splitter.found', splitterBase.found === true, { category: 'splitter', expected: '存在 .onestep-splitter', actual: splitterBase })
  if (splitterBase.found) {
    results.assert('m2.splitter.duration', durationIncludes(splitterBase.transitionDuration, '0.12s'), {
      category: 'duration', expected: 'transition-duration 含 0.12s', actual: { transitionDuration: splitterBase.transitionDuration, transitionProperty: splitterBase.transitionProperty },
    })
    results.assert('m2.splitter.transition-property', String(splitterBase.transitionProperty || '').indexOf('background') >= 0, {
      category: 'splitter', expected: 'transition-property 含 background', actual: splitterBase.transitionProperty,
    })
    const beforeHover = splitterBase.backgroundColor
    await page.hover('.onestep-splitter')
    await sleep(200)
    const afterHover = await page.evaluate(() => window.__V.computed('.onestep-splitter', '::after'))
    results.assert('m2.splitter.hover-feedback', afterHover.backgroundColor !== beforeHover, {
      category: 'splitter', expected: 'hover 后 ::after 背景色变化（120ms 过渡）', actual: { before: beforeHover, after: afterHover.backgroundColor },
    })
  }

  // ---------- G4：落点高亮 120ms（可选的 dragover 派发路径） ----------
  const dropBefore = await geometry(page)
  const dropDispatch = await page.evaluate(() => {
    const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
    if (!el) return { ok: false, reason: 'no-focus-frame' }
    try {
      const dataTransfer = new DataTransfer()
      el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }))
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: String((error && error.message) || error) }
    }
  })
  let dropComputed = null
  let dropAttr = null
  if (dropDispatch.ok) {
    try {
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
        return !!el && el.getAttribute('data-drop') === '1'
      }, null, { timeout: 3000 })
      dropAttr = await page.evaluate(() => document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]').getAttribute('data-drop'))
      dropComputed = await page.evaluate(() => window.__V.computed('[data-onestep-stage] .onestep-frame[data-mode="focus"]'))
    } catch (error) {
      results.skip('m2.drop.dragover-attr', 'dragover 未触发 data-drop=1：' + String(error), 'event')
    }
    await page.evaluate(() => {
      const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
      if (el) el.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }))
    })
  }
  results.metric('m2.drop', { dropDispatch, dropAttr, dropComputed })
  if (dropAttr === '1' && dropComputed) {
    results.assert('m2.drop.transition-120', durationIncludes(dropComputed.transitionDuration, '0.12s'), {
      category: 'duration', expected: 'data-drop=1 transition-duration 含 0.12s', actual: { animation: dropComputed.animationName, transitionDuration: dropComputed.transitionDuration, transitionProperty: dropComputed.transitionProperty },
    })
  } else {
    results.skip('m2.drop.live', 'drag 事件路径在 headless 下不可靠，落点高亮改由静态 CSS 断言覆盖（见 m2.drop.css）', 'event')
    const dropCss = await page.evaluate(() => window.__V.cssRulesMatching('data-drop'))
    const dropRule = dropCss.find((text) => String(text).indexOf('onestep-frame[data-drop') >= 0) || null
    results.assert('m2.drop.css', !!dropRule && String(dropRule).indexOf('var(--onestep-fast)') >= 0, {
      category: 'duration', expected: '.onestep-frame[data-drop="1"] 使用 --onestep-fast（120ms）', actual: { rule: dropRule, all: dropCss.slice(0, 5) },
    })
  }

  // ---------- G5：完成闪烁 1200ms（600ms×2）+ 1400ms 自动清除 ----------
  const snapNow = await snapshot(page)
  const flashSessionId = snapNow.candidates[0]
  await page.evaluate((id) => window.__ONESTEP__.actions.demoFeedback({ flashSessionId: id }), flashSessionId)
  await page.waitForFunction((id) => {
    const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-onestep-window-session="' + id + '"]')
    return !!el && el.getAttribute('data-flash') === '1'
  }, flashSessionId, { timeout: 5000 })
  const flashComputed = await page.evaluate((id) => window.__V.computed('[data-onestep-window-session="' + id + '"]'), flashSessionId)
  const flashAnimations = await page.evaluate((id) => window.__V.animations().filter((animation) => animation.animationName === 'onestep-flash' || (animation.target && animation.target.sessionId === id && String(animation.animationName || '').indexOf('flash') >= 0)), flashSessionId)
  results.metric('m2.flash', { flashSessionId, flashComputed, flashAnimations })
  results.assert('m2.flash.attribute', flashComputed.found && flashComputed.attrs['data-flash'] === '1', {
    category: 'feedback', expected: 'data-flash=1', actual: flashComputed.attrs,
  })
  results.assert('m2.flash.animation', flashComputed.found && String(flashComputed.animationName || '').indexOf('onestep-flash') >= 0 && durationIncludes(flashComputed.animationDuration, '1.2s') && flashComputed.animationIterationCount === '1', {
    category: 'feedback',
    expected: { animationName: 'onestep-flash', animationDuration: '1.2s', animationIterationCount: '1' },
    actual: { animationName: flashComputed.animationName, animationDuration: flashComputed.animationDuration, animationIterationCount: flashComputed.animationIterationCount },
  })
  await sleep(1700)
  const flashLate = await page.evaluate((id) => window.__V.computed('[data-onestep-window-session="' + id + '"]'), flashSessionId)
  results.assert('m2.flash.auto-clear-1400ms', flashLate.found && flashLate.attrs['data-flash'] === '0', {
    category: 'feedback', expected: '1400ms 后 data-flash=0', actual: flashLate.attrs,
  })

  // ---------- G5：气泡进场 180ms；出场 120ms（静态规则，probe 面无 clearBubble 路径） ----------
  const bubbleSessionId = (await snapshot(page)).candidates[0]
  await page.evaluate((id) => window.__ONESTEP__.actions.demoFeedback({ bubbleSessionId: id, kind: 'approval' }), bubbleSessionId)
  await page.waitForFunction(() => !!document.querySelector('.onestep-bubble'), null, { timeout: 5000 })
  const bubbleComputed = await page.evaluate(() => window.__V.computed('.onestep-bubble'))
  const bubbleOutRules = await page.evaluate(() => window.__V.cssRulesMatching('onestep-bubble[data-leaving'))
  const bubbleOutVar = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--onestep-bubble-out').trim())
  const bubbleLeavingSupport = await page.evaluate(() => typeof window.__ONESTEP__.actions.clearBubble === 'function')
  results.metric('m2.bubble', { bubbleComputed, bubbleOutRules, bubbleOutVar, bubbleLeavingSupport })
  results.assert('m2.bubble.enter-animation', bubbleComputed.found && String(bubbleComputed.animationName || '').indexOf('onestep-bubble-in') >= 0 && durationIncludes(bubbleComputed.animationDuration, '0.18s'), {
    category: 'feedback',
    expected: { animationName: 'onestep-bubble-in', animationDuration: '0.18s' },
    actual: { animationName: bubbleComputed.animationName, animationDuration: bubbleComputed.animationDuration },
  })
  results.assert('m2.bubble.leaving-rule-120ms', bubbleOutRules.length > 0 && String(bubbleOutRules[0]).indexOf('onestep-bubble-out') >= 0 && bubbleOutVar === '120ms', {
    category: 'feedback',
    expected: '气泡出场规则 animation:onestep-bubble-out 120ms（--onestep-bubble-out=120ms）',
    actual: { rules: bubbleOutRules.slice(0, 2), var: bubbleOutVar },
  })
  if (bubbleLeavingSupport) {
    await page.evaluate((id) => window.__ONESTEP__.actions.clearBubble(id), bubbleSessionId)
    await page.waitForFunction(() => {
      const el = document.querySelector('.onestep-bubble')
      return !!el && el.getAttribute('data-leaving') === '1'
    }, null, { timeout: 3000 })
    const leaving = await page.evaluate(() => {
      const el = document.querySelector('.onestep-bubble')
      return { leaving: el ? el.getAttribute('data-leaving') : null, animationName: el ? getComputedStyle(el).animationName : null, animationDuration: el ? getComputedStyle(el).animationDuration : null }
    })
    await page.waitForFunction(() => !document.querySelector('.onestep-bubble'), null, { timeout: 3000 })
    results.assert('m2.bubble.leaving-live', leaving.leaving === '1' && String(leaving.animationName || '').indexOf('onestep-bubble-out') >= 0 && durationIncludes(leaving.animationDuration, '0.12s'), {
      category: 'feedback', expected: { leaving: '1', animationName: 'onestep-bubble-out', animationDuration: '0.12s' }, actual: leaving,
    })
  } else {
    results.skip('m2.bubble.leaving-live', 'probe 面暂无 clearBubble/demoFeedback 清除路径，无法在产品态观察 data-leaving=1（静态规则+token 已断言；建议 probe.js 暴露 clearBubble）', 'surface-gap')
  }

  // ---------- G5：控制点 hover 120ms（transform） ----------
  const controlBefore = await page.evaluate(() => window.__V.computed('.onestep-frame[data-mode="candidate"] .onestep-control'))
  await page.hover('.onestep-frame[data-mode="candidate"]')
  await sleep(250)
  const controlAfter = await page.evaluate(() => window.__V.computed('.onestep-frame[data-mode="candidate"] .onestep-control'))
  results.metric('m2.control', { controlBefore, controlAfter })
  results.assert('m2.control.hover-transition-120', controlAfter.found && durationIncludes(controlAfter.transitionDuration, '0.12s') && String(controlAfter.transitionProperty || '').indexOf('transform') >= 0, {
    category: 'duration',
    expected: { transitionDuration: '含 0.12s', transitionProperty: '含 transform' },
    actual: { transitionDuration: controlAfter.transitionDuration, transitionProperty: controlAfter.transitionProperty, opacity: controlAfter.opacity, transform: controlAfter.transform },
  })
  results.assert('m2.control.hover-visible', controlAfter.found && Number(controlAfter.opacity) > 0.5, {
    category: 'feedback', expected: '候选卡 hover 后控制点可见', actual: { opacity: controlAfter.opacity, pointerEvents: controlAfter.pointerEvents },
  })

  // ---------- 收尾：idle 时插件自有 infinite / running 动画 = 0 ----------
  await page.evaluate(() => {
    const actions = window.__ONESTEP__.actions
    if (typeof actions.exitStage === 'function') actions.exitStage()
  }).catch(() => {})
  await waitMotionIdle(page, 15000)
  await sleep(600)
  const infinite = await page.evaluate(() => window.__V.pluginInfinite())
  const running = await page.evaluate(() => window.__V.runningPluginAnimations())
  results.metric('m2.idle', { infinite, running })
  results.assert('m2.idle.no-infinite', infinite.count === 0, {
    category: 'feedback', expected: '插件自有 infinite 动画 = 0', actual: infinite,
  })
  results.assert('m2.idle.no-running', running.length === 0, {
    category: 'feedback', expected: '插件自有运行中动画 = 0', actual: running,
  })

  assertNoPageErrors(results, app.handles, 'm2')
} catch (error) {
  results.fatal(error)
} finally {
  try {
    if (app) await closeApp(app)
  } catch (_error) { /* ignore */ }
  finishSuite(results)
}
process.exitCode = results.data.ok ? 0 : 1
