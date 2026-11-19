/**
 * P4-9 m5：reduced motion 全量验证 —— 计划 §5 G8（§4.7 三层接线）。
 *
 * 覆盖：
 * 1) 插件设置路径：setReducedMotion('always') → <html data-onestep-motion="reduced">、mode=reduced、
 *    promote 不启动 VT（route=instant、VT 调用数 0、无伪元素动画）、插件自有 running/infinite 动画=0；
 * 2) 菜单项文案随状态变化（跟随系统 / 减少动效）；
 * 3) setReducedMotion('system') 恢复（normal context 系统 no-preference → 属性移除、mode=full）；
 * 4) 系统 media 路径：emulateMedia reduce → 属性 reduced、mode=reduced、VT 不启动；恢复 no-preference；
 * 5) 持久化：always 写入 localStorage 后 reload 仍生效（dsh.onestep.v1）；
 * 6) reduced context（openApp reducedMotion:'reduce'）：加载即 reduced、动作全部 instant。
 *
 * 运行：node scripts/p4/verify/m5-reduced.mjs
 * 产物：artifacts/p4/verify/m5-reduced.json
 */
import {
  openVerifyApp,
  closeApp,
  reloadApp,
  snapshot,
  motionState,
  geometry,
  waitMotionIdle,
  waitMotionMode,
  createResults,
  finishSuite,
  assertNoPageErrors,
  waitFor,
  sleep,
  listSessions,
} from './lib.mjs'

const results = createResults('m5-reduced', 'P4-9 m5：reduced motion（G8）')
let app = null
let reducedApp = null

async function menuLabel(page) {
  const alreadyOpen = await page.evaluate(() => !!document.querySelector('.onestep-menu'))
  if (!alreadyOpen) await page.click('[data-onestep-more]')
  await page.waitForFunction(() => !!document.querySelector('.onestep-menu'), null, { timeout: 5000 })
  const label = await page.evaluate(() => {
    const item = document.querySelector('[data-onestep-motion-toggle]')
    return item ? { text: String(item.textContent || '').trim(), aria: item.getAttribute('aria-label') } : null
  })
  if (!alreadyOpen) {
    await page.evaluate(() => {
      const button = document.querySelector('[data-onestep-more]')
      if (button) button.click()
    })
    await page.waitForFunction(() => !document.querySelector('.onestep-menu'), null, { timeout: 3000 })
  }
  return label
}

async function pluginIdleState(page) {
  await waitMotionIdle(page, 12000)
  await sleep(300)
  const infinite = await page.evaluate(() => window.__V.pluginInfinite())
  const running = await page.evaluate(() => window.__V.runningPluginAnimations())
  const pseudo = await page.evaluate(() => window.__V.pseudoAnimations())
  return { infinite, running, pseudo }
}

try {
  // ========== 正常上下文 + 插件设置路径 ==========
  app = await openVerifyApp({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
  const page = app.page
  results.setEnv('viewport', '1440x900')
  const rows = await listSessions(page)
  const ids = Object.keys(rows || {}).slice(0, 4)
  await page.evaluate((list) => window.__ONESTEP__.actions.enterStage(list), ids)
  await waitFor(async () => (await snapshot(page)).mounted === true, { timeout: 15000, label: 'stage.mounted' })
  await waitMotionIdle(page)

  const initial = await motionState(page)
  results.metric('m5.initial', initial)
  results.assert('m5.initial.full', initial.mode === 'full' && initial.attribute === null && initial.setting === 'system', {
    category: 'reduced', expected: { mode: 'full', attribute: null, setting: 'system' }, actual: { mode: initial.mode, attribute: initial.attribute, setting: initial.setting, systemReduced: initial.systemReduced },
  })

  // 菜单文案（system 态 → 显示「减少动效」）
  const labelBefore = await menuLabel(page)
  results.metric('m5.menu.before', labelBefore)
  results.assert('m5.menu.label-system', !!labelBefore && /减少动效|reduced/i.test(labelBefore.text), {
    category: 'reduced', expected: 'setting=system 时菜单项显示「减少动效」', actual: labelBefore,
  })

  // setReducedMotion('always')
  const setAlways = await page.evaluate(() => window.__ONESTEP__.actions.setReducedMotion('always'))
  await waitMotionMode(page, { mode: 'reduced', attribute: 'reduced' })
  const alwaysMotion = await motionState(page)
  const htmlAttr = await page.evaluate(() => document.documentElement.getAttribute('data-onestep-motion'))
  results.metric('m5.always', { setAlways, alwaysMotion, htmlAttr })
  results.assert('m5.setting.always', alwaysMotion.setting === 'always' && alwaysMotion.mode === 'reduced' && alwaysMotion.controller.reduced === true, {
    category: 'reduced', expected: { setting: 'always', mode: 'reduced', controllerReduced: true }, actual: { setting: alwaysMotion.setting, mode: alwaysMotion.mode, controller: alwaysMotion.controller },
  })
  results.assert('m5.setting.always-attr', htmlAttr === 'reduced', { category: 'reduced', expected: 'html data-onestep-motion=reduced', actual: htmlAttr })

  // 菜单文案（always 态 → 显示「跟随系统」）
  const labelAfter = await menuLabel(page)
  results.metric('m5.menu.after', labelAfter)
  results.assert('m5.menu.label-always', !!labelAfter && /跟随系统|follow system/i.test(labelAfter.text), {
    category: 'reduced', expected: 'setting=always 时菜单项显示「跟随系统」', actual: labelAfter,
  })

  // reduced 下 promote：不启动 VT
  const reducedIdleBefore = await page.evaluate(() => window.__V.installVtCounter())
  const counterInit = await page.evaluate(() => window.__V.vtCalls())
  const reducedSnap = await snapshot(page)
  const reducedTarget = reducedSnap.candidates[0]
  await page.evaluate((id) => window.__ONESTEP__.actions.promote(id), reducedTarget)
  await waitFor(async () => (await snapshot(page)).focusId === reducedTarget, { timeout: 12000, label: 'reduced.promote' })
  await waitMotionIdle(page, 12000)
  const counterAfter = await page.evaluate(() => window.__V.vtCalls())
  const reducedMotionAfter = await motionState(page)
  const reducedIdle = await pluginIdleState(page)
  results.metric('m5.promote', { counterInit, counterAfter, motion: reducedMotionAfter.controller, idle: { infinite: reducedIdle.infinite.count, running: reducedIdle.running.length, pseudo: reducedIdle.pseudo.length } })
  results.assert('m5.promote.no-vt-call', counterAfter.count === 0, {
    category: 'reduced', expected: 'VT 调用数 0', actual: counterAfter,
  })
  results.assert('m5.promote.route-instant', reducedMotionAfter.controller.last.route === 'instant', {
    category: 'reduced', expected: 'route=instant', actual: reducedMotionAfter.controller.last,
  })
  results.assert('m5.promote.no-pseudo', reducedIdle.pseudo.length === 0, {
    category: 'reduced', expected: 0, actual: reducedIdle.pseudo.map((animation) => animation.pseudoElement),
  })
  results.assert('m5.promote.no-plugin-animations', reducedIdle.infinite.count === 0 && reducedIdle.running.length === 0, {
    category: 'reduced', expected: { infinite: 0, running: 0 }, actual: { infinite: reducedIdle.infinite, running: reducedIdle.running },
  })
  results.assert('m5.promote.state', (await snapshot(page)).focusId === reducedTarget, {
    category: 'state', expected: reducedTarget, actual: (await snapshot(page)).focusId,
  })
  await page.evaluate(() => window.__V.uninstallVtCounter())

  // setReducedMotion('system') 恢复
  await page.evaluate(() => window.__ONESTEP__.actions.setReducedMotion('system'))
  await waitMotionMode(page, { mode: 'full', attribute: null })
  const restoredMotion = await motionState(page)
  const restoredAttr = await page.evaluate(() => document.documentElement.getAttribute('data-onestep-motion'))
  results.metric('m5.restored', { restoredMotion, restoredAttr })
  results.assert('m5.setting.system-restored', restoredMotion.setting === 'system' && restoredMotion.mode === 'full' && restoredAttr === null, {
    category: 'reduced', expected: { setting: 'system', mode: 'full', attribute: null }, actual: { setting: restoredMotion.setting, mode: restoredMotion.mode, attribute: restoredAttr },
  })

  // ========== 系统 media 路径 ==========
  const mediaDiagBefore = await page.evaluate(() => ({ attr: document.documentElement.getAttribute('data-onestep-motion'), motion: window.__ONESTEP__.actions.motionState() }))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await sleep(150)
  const mediaDiagEarly = await page.evaluate(() => ({ attr: document.documentElement.getAttribute('data-onestep-motion'), motion: window.__ONESTEP__.actions.motionState() }))
  await sleep(150)
  const mediaDiagLate = await page.evaluate(() => ({ attr: document.documentElement.getAttribute('data-onestep-motion'), motion: window.__ONESTEP__.actions.motionState() }))
  results.metric('m5.media.diag', { before: mediaDiagBefore, early: mediaDiagEarly, late: mediaDiagLate })
  let mediaModeResult = null
  let mediaAttempts = 0
  for (; mediaAttempts < 3; mediaAttempts += 1) {
    try {
      mediaModeResult = await waitMotionMode(page, { mode: 'reduced', attribute: 'reduced' }, 2500)
      break
    } catch (_error) {
      await page.emulateMedia({ reducedMotion: 'reduce' })
    }
  }
  results.metric('m5.media.attempts', { mediaAttempts, mediaModeResult })
  if (!mediaModeResult) {
    throw new Error('media reduce 未生效（attr 未变 reduced）：' + JSON.stringify({ before: mediaDiagBefore, early: mediaDiagEarly, late: mediaDiagLate, now: await page.evaluate(() => ({ attr: document.documentElement.getAttribute('data-onestep-motion'), motion: window.__ONESTEP__.actions.motionState() })) }))
  }
  const mediaReduced = await motionState(page)
  const mediaIdle = await pluginIdleState(page)
  results.metric('m5.media.reduce', { motion: mediaReduced, idle: { infinite: mediaIdle.infinite.count, running: mediaIdle.running.length } })
  results.assert('m5.media.reduce', mediaReduced.systemReduced === true && mediaReduced.mode === 'reduced' && mediaReduced.setting === 'system', {
    category: 'reduced', expected: { systemReduced: true, mode: 'reduced', setting: 'system' }, actual: { systemReduced: mediaReduced.systemReduced, mode: mediaReduced.mode, setting: mediaReduced.setting },
  })
  results.assert('m5.media.reduce-attr', mediaReduced.attribute === 'reduced', {
    category: 'reduced', expected: 'reduced', actual: mediaReduced.attribute,
  })
  results.assert('m5.media.reduce-no-plugin-animations', mediaIdle.infinite.count === 0 && mediaIdle.running.length === 0, {
    category: 'reduced', expected: { infinite: 0, running: 0 }, actual: { infinite: mediaIdle.infinite, running: mediaIdle.running },
  })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await waitMotionMode(page, { mode: 'full', attribute: null })
  const mediaBack = await motionState(page)
  results.assert('m5.media.restored', mediaBack.mode === 'full' && mediaBack.attribute === null && mediaBack.systemReduced === false, {
    category: 'reduced', expected: { mode: 'full', attribute: null, systemReduced: false }, actual: { mode: mediaBack.mode, attribute: mediaBack.attribute, systemReduced: mediaBack.systemReduced },
  })

  // ========== 持久化：always → reload 仍生效 ==========
  await page.evaluate(() => {
    const actions = window.__ONESTEP__.actions
    actions.setReducedMotion('always')
    if (typeof actions.flushPersist === 'function') actions.flushPersist()
  })
  await waitMotionMode(page, { mode: 'reduced', attribute: 'reduced' })
  let persisted = null
  try {
    persisted = await waitFor(async () => {
      const raw = await page.evaluate(() => {
        try {
          return JSON.parse(localStorage.getItem('dsh.onestep.v1') || 'null')
        } catch (error) {
          return null
        }
      })
      return raw && raw.reducedMotion === 'always' ? raw : false
    }, { timeout: 5000, label: 'persisted.reducedMotion' })
  } catch (_error) {
    persisted = await page.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem('dsh.onestep.v1') || 'null')
      } catch (error) {
        return null
      }
    })
  }
  results.metric('m5.persisted.store', persisted)
  results.assert('m5.persist.store-value', !!persisted && persisted.reducedMotion === 'always', {
    category: 'reduced', expected: 'localStorage dsh.onestep.v1.reducedMotion=always', actual: persisted && persisted.reducedMotion,
  })
  await reloadApp(page)
  await waitMotionMode(page, { mode: 'reduced', attribute: 'reduced' }, 10000)
  const afterReload = await motionState(page)
  results.metric('m5.reload', afterReload)
  results.assert('m5.persist.reload', afterReload.setting === 'always' && afterReload.mode === 'reduced' && afterReload.attribute === 'reduced', {
    category: 'reduced',
    expected: '刷新后 setting=always、属性 reduced 持久',
    actual: { setting: afterReload.setting, mode: afterReload.mode, attribute: afterReload.attribute },
  })
  await page.evaluate(() => window.__ONESTEP__.actions.setReducedMotion('system'))
  await waitMotionMode(page, { mode: 'full', attribute: null }, 10000)

  // ========== reduced context（系统 reduce 启动路径） ==========
  reducedApp = await openVerifyApp({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const reducedPage = reducedApp.page
  const reducedRows = await listSessions(reducedPage)
  const reducedIds = Object.keys(reducedRows || {}).slice(0, 3)
  const contextMotion = await motionState(reducedPage)
  const contextAttr = await reducedPage.evaluate(() => document.documentElement.getAttribute('data-onestep-motion'))
  results.metric('m5.context', { contextMotion, contextAttr })
  results.assert('m5.context.attr', contextAttr === 'reduced' && contextMotion.mode === 'reduced' && contextMotion.systemReduced === true, {
    category: 'reduced',
    expected: { attribute: 'reduced', mode: 'reduced', systemReduced: true },
    actual: { attribute: contextAttr, mode: contextMotion.mode, systemReduced: contextMotion.systemReduced },
  })
  await reducedPage.evaluate((list) => window.__ONESTEP__.actions.enterStage(list), reducedIds)
  await waitFor(async () => (await snapshot(reducedPage)).mounted === true, { timeout: 15000, label: 'reduced.stage' })
  await waitMotionIdle(reducedPage)
  await reducedPage.evaluate(() => window.__V.installVtCounter())
  const contextSnap = await snapshot(reducedPage)
  const contextTarget = contextSnap.candidates[0]
  await reducedPage.evaluate((id) => window.__ONESTEP__.actions.promote(id), contextTarget)
  await waitFor(async () => (await snapshot(reducedPage)).focusId === contextTarget, { timeout: 12000, label: 'context.promote' })
  await waitMotionIdle(reducedPage, 12000)
  const contextCalls = await reducedPage.evaluate(() => window.__V.vtCalls())
  const contextAfter = await motionState(reducedPage)
  const contextGeo = await geometry(reducedPage)
  const contextIdle = await pluginIdleState(reducedPage)
  results.metric('m5.context.promote', {
    calls: contextCalls,
    motion: contextAfter.controller,
    pseudo: contextGeo.dom.vtPseudoCount,
    infinite: contextIdle.infinite.count,
    running: contextIdle.running.length,
  })
  results.assert('m5.context.no-vt-call', contextCalls.count === 0, { category: 'reduced', expected: 0, actual: contextCalls })
  results.assert('m5.context.route-instant', contextAfter.controller.last.route === 'instant', {
    category: 'reduced', expected: 'instant', actual: contextAfter.controller.last,
  })
  results.assert('m5.context.no-animations', contextGeo.dom.vtPseudoCount === 0 && contextIdle.infinite.count === 0 && contextIdle.running.length === 0, {
    category: 'reduced',
    expected: { vtPseudo: 0, infinite: 0, running: 0 },
    actual: { vtPseudo: contextGeo.dom.vtPseudoCount, infinite: contextIdle.infinite, running: contextIdle.running },
  })

  assertNoPageErrors(results, app.handles, 'm5')
  assertNoPageErrors(results, reducedApp.handles, 'm5.context')
} catch (error) {
  results.fatal(error)
} finally {
  try {
    if (app) await closeApp(app)
  } catch (_error) { /* ignore */ }
  try {
    if (reducedApp) await closeApp(reducedApp)
  } catch (_error) { /* ignore */ }
  finishSuite(results)
}
process.exitCode = results.data.ok ? 0 : 1
