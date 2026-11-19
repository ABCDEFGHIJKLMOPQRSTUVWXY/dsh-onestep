/**
 * P4-9 m4：伴生窗（peek）动效验证 —— 计划 §5 G7。
 *
 * 覆盖：打开 1-2 个伴生浮窗 → 点击舞台空白收起（产品路径 pointerdown）→
 *  - 收起：浮窗 transform 过渡存在（--onestep-peek=180ms，transition-property 含 transform），
 *    采样到中间 transform、~180ms 后位移出视口；
 *  - 标签：hover 无布局动画（标签 width 恒 38px，标题浮层 opacity 变化 120ms）；
 *  - 恢复：点击标签 → data-onestep-peek-restoring=1、180ms 内位移过渡、结束后临时属性清理；
 *  - reduced context：transition-duration 0s、恢复立即（≤50ms）；
 *  - P3 回归：inert/aria-hidden/pointer-events 注入与还原、标签层与标签一致、舞台几何不重排。
 *
 * 运行：node scripts/p4/verify/m4-peek.mjs
 * 产物：artifacts/p4/verify/m4-peek.json
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
  waitFor,
  sleep,
  listSessions,
  mountedSessionId,
  fileAddress,
  durationIncludes,
} from './lib.mjs'

const results = createResults('m4-peek', 'P4-9 m4：伴生窗 peek 动效（G7）')
let app = null
let reducedApp = null

/** 解析 matrix(...) 的 x 位移（transform 为 none 时返回 0）。 */
function translateX(transform) {
  if (!transform || transform === 'none') return 0
  const match = /matrix\(([^)]+)\)/.exec(transform)
  if (!match) return 0
  const parts = match[1].split(',').map((value) => Number(value.trim()))
  return parts.length >= 6 ? parts[4] : 0
}

async function openFloats(page, sessionId, addresses) {
  for (const address of addresses) {
    const result = await page.evaluate(({ addr }) => {
      try {
        return window.__ONESTEP__.actions.companionOpenResource(null, addr)
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    }, { addr: address })
    results.step('open.float', { address, result })
    if (result && result.ok === false && result.error) throw new Error('companionOpenResource 失败：' + JSON.stringify(result))
    await sleep(350)
  }
  await waitFor(async () => {
    const count = await page.evaluate(() => document.querySelectorAll('[data-dockkit-float]').length)
    return count >= addresses.length
  }, { timeout: 12000, label: 'floats.opened' })
}

try {
  // ========== 正常动效上下文 ==========
  app = await openVerifyApp({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
  const page = app.page
  results.setEnv('viewport', '1440x900')
  const rows = await listSessions(page)
  const ids = Object.keys(rows || {}).slice(0, 3)
  await page.evaluate((list) => window.__ONESTEP__.actions.enterStage(list), ids)
  await waitFor(async () => (await snapshot(page)).mounted === true, { timeout: 15000, label: 'stage.mounted' })
  await waitMotionIdle(page)
  const focusId = (await snapshot(page)).focusId
  const sessionId = (await mountedSessionId(page)) || focusId
  results.setEnv('sessionId', sessionId)

  await openFloats(page, sessionId, [fileAddress(sessionId, 'README.md'), fileAddress(sessionId, 'CHANGELOG.md')])
  const floatsOpened = await page.evaluate(() => window.__V.floats())
  const stageBefore = await geometry(page)
  results.metric('m4.opened', { floats: floatsOpened, focusId, sessionId })
  results.assert('m4.setup.floats', floatsOpened.length >= 2, { category: 'setup', expected: '≥2 个官方浮窗', actual: floatsOpened.length })

  // ---------- 收起：舞台空白 pointerdown（产品路径）→ 180ms transform 过渡 ----------
  const collapse = await page.evaluate(() => window.__V.sampleFloatsFor(340, 'stage-pointerdown'))
  await waitFor(async () => {
    const floats = await page.evaluate(() => window.__V.floats())
    return floats.length > 0 && floats.every((item) => item.peeked)
  }, { timeout: 8000, label: 'floats.peeked' })
  const collapseAfter = await page.evaluate(() => window.__V.floats())
  const collapseTags = await page.evaluate(() => window.__V.peekTags())
  const collapseSamples = collapse.samples || []
  const sampledFloatId = (collapse.before[0] || {}).tabId
  const transitionSamples = collapseSamples
    .map((sample) => (sample.floats || []).find((item) => item.tabId === sampledFloatId))
    .filter(Boolean)
    .map((item, index) => ({ t: collapseSamples[index].t, tx: translateX(item.transform), transform: item.transform, peeked: item.peeked }))
  const intermediate = transitionSamples.filter((item) => item.peeked && Math.abs(item.tx) > 0.5 && item.tx < 1400)
  const peekedComputed = collapseAfter.find((item) => item.tabId === sampledFloatId) || null
  results.metric('m4.collapse', {
    sampledFloatId,
    transitionSamples,
    intermediateCount: intermediate.length,
    after: collapseAfter,
    tags: collapseTags,
  })
  results.assert('m4.peek.floats-peeked', collapseAfter.length >= 2 && collapseAfter.every((item) => item.peeked), {
    category: 'peek', expected: '全部浮窗 data-onestep-peek=1', actual: collapseAfter.map((item) => ({ tabId: item.tabId, peeked: item.peeked })),
  })
  results.assert('m4.peek.transition-180', !!peekedComputed && durationIncludes(peekedComputed.transitionDuration, '0.18s'), {
    category: 'duration',
    expected: '收起状态浮窗 transition-duration = 0.18s',
    actual: peekedComputed ? { transitionDuration: peekedComputed.transitionDuration, transitionProperty: peekedComputed.transitionProperty } : null,
  })
  results.assert('m4.peek.transition-property-transform', !!peekedComputed && String(peekedComputed.transitionProperty || '').indexOf('transform') >= 0, {
    category: 'peek', expected: 'transition-property 含 transform', actual: peekedComputed ? peekedComputed.transitionProperty : null,
  })
  results.assert('m4.peek.mid-transition', intermediate.length >= 1, {
    category: 'peek', expected: '采样到 transform 中间值（180ms 过渡真实发生）', actual: { samples: transitionSamples.slice(0, 8) },
  })
  results.assert('m4.peek.frame-at-rest', !!peekedComputed && translateX(peekedComputed.transform) > 1440, {
    category: 'peek', expected: '收起后 x 位移 > 视口宽（translateX(calc(100vw + offset))）', actual: peekedComputed ? { transform: peekedComputed.transform, tx: translateX(peekedComputed.transform), rect: peekedComputed.rect } : null,
  })
  const stageAfterCollapse = await geometry(page)
  results.assert('m4.peek.no-layout-shift', (() => {
    const stageA = stageBefore.stage
    const stageB = stageAfterCollapse.stage
    const focusA = stageBefore.focus && stageBefore.focus.rect
    const focusB = stageAfterCollapse.focus && stageAfterCollapse.focus.rect
    if (!stageA || !stageB || !focusA || !focusB) return false
    const dev = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h))
    return dev(stageA, stageB) <= 0.5 && dev(focusA, focusB) <= 0.5
  })(), {
    category: 'peek',
    expected: '收起只动 transform，不触发布局（舞台/焦点 rect 偏差 ≤0.5px）',
    actual: { stageBefore: stageBefore.stage, stageAfter: stageAfterCollapse.stage, focusBefore: stageBefore.focus && stageBefore.focus.rect, focusAfter: stageAfterCollapse.focus && stageAfterCollapse.focus.rect },
  })

  // ---------- P3 回归：注入属性 ----------
  results.assert('m4.p3.injection', collapseAfter.every((item) => item.peeked && item.inert && item.ariaHidden === 'true' && item.pointerEvents === 'none'), {
    category: 'p3-regression',
    expected: 'data-onestep-peek=1 + inert + aria-hidden=true + pointer-events:none',
    actual: collapseAfter.map((item) => ({ tabId: item.tabId, peeked: item.peeked, inert: item.inert, ariaHidden: item.ariaHidden, pointerEvents: item.pointerEvents })),
  })
  results.assert('m4.p3.tags', collapseTags.length === collapseAfter.length && new Set(collapseTags.map((tag) => tag.tabId)).size === collapseTags.length && collapseTags.every((tag) => Math.abs(tag.width - 38) <= 0.5), {
    category: 'p3-regression',
    expected: '每个收起浮窗一个标签、tabId 唯一、标签宽 38px',
    actual: collapseTags.map((tag) => ({ tabId: tag.tabId, width: tag.width, zIndex: tag.zIndex })),
  })
  const peekLayer = await page.evaluate(() => window.__V.peekLayer())
  results.assert('m4.p3.layer', !!peekLayer && String(peekLayer.zIndex) === '63', {
    category: 'p3-regression',
    expected: '收起标签层 [data-onestep-peek-layer] 存在且 z-index=63（高于浮窗层 60）',
    actual: peekLayer,
  })

  // ---------- 标签 hover：无布局动画（width 恒 38px；标题浮层 opacity 变化） ----------
  const tagBefore = (await page.evaluate(() => window.__V.peekTags()))[0]
  let hoverError = null
  try {
    await page.hover('[data-onestep-peek-tag]')
  } catch (error) {
    hoverError = String((error && error.message) || error)
    await page.evaluate(() => {
      const tag = document.querySelector('[data-onestep-peek-tag]')
      if (tag) tag.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    })
  }
  await sleep(220)
  const tagAfter = (await page.evaluate(() => window.__V.peekTags()))[0]
  results.metric('m4.tagHover.error', hoverError)
  const labelRule = await page.evaluate(() => window.__V.cssRulesMatching('.onestep-peek-label'))
  results.metric('m4.tagHover', { tagBefore, tagAfter, labelRules: labelRule.slice(0, 3) })
  results.assert('m4.tag.hover-no-width-change', !!tagBefore && !!tagAfter && Math.abs(tagAfter.width - tagBefore.width) <= 0.5 && Math.abs(tagAfter.width - 38) <= 0.5, {
    category: 'peek', expected: 'hover 前后标签宽度不变（38px，无布局动画）', actual: { before: tagBefore && tagBefore.width, after: tagAfter && tagAfter.width },
  })
  results.assert('m4.tag.hover-label-opacity', !!tagAfter && Number(tagAfter.labelOpacity) > 0.5, {
    category: 'peek', expected: 'hover 后标题浮层 opacity→1（120ms 过渡）', actual: { before: tagBefore && tagBefore.labelOpacity, after: tagAfter && tagAfter.labelOpacity, transform: tagAfter && tagAfter.labelTransform },
  })
  results.assert('m4.tag.hover-transition-scope', !!tagAfter && String(tagAfter.transitionProperty || '').indexOf('width') < 0 && String(tagAfter.transitionProperty || '').indexOf('max-width') < 0, {
    category: 'peek', expected: '标签 transition-property 不含 width/max-width', actual: tagAfter && tagAfter.transitionProperty,
  })

  // ---------- 恢复：点击标签 → restoring 临时属性 + 180ms 过渡 → 清理 ----------
  const restore = await page.evaluate(async () => {
    const tag = document.querySelector('[data-onestep-peek-tag]')
    if (!tag) return { ok: false, reason: 'no-tag' }
    const tabId = tag.getAttribute('data-onestep-peek-tag')
    const samples = []
    const startedAt = performance.now()
    tag.click()
    return await new Promise((resolve) => {
      const tick = () => {
        const floats = window.__V.floats()
        samples.push({ t: Math.round(performance.now() - startedAt), floats })
        if (performance.now() - startedAt < 360) {
          requestAnimationFrame(tick)
          return
        }
        resolve({ ok: true, tabId, samples })
      }
      requestAnimationFrame(tick)
    })
  })
  const restored = await page.evaluate(() => window.__V.floats())
  const targetFloat = restored.find((item) => item.tabId === restore.tabId) || null
  const restoringSamples = (restore.samples || []).map((sample) => (sample.floats || []).find((item) => item.tabId === restore.tabId)).filter(Boolean)
  const restoringSample = restoringSamples.find((item) => item.restoring) || null
  const restoringIntermediate = restoringSamples.filter((item) => item.restoring && Math.abs(translateX(item.transform)) > 0.5 && Math.abs(translateX(item.transform)) < 1400)
  results.metric('m4.restore', { restore: { tabId: restore.tabId }, targetFloat, restoringSamples: restoringSamples.slice(0, 12) })
  results.assert('m4.restore.restoring-attr', !!restoringSample, {
    category: 'peek', expected: '恢复期出现 data-onestep-peek-restoring=1（保住 transition）', actual: restoringSamples.slice(0, 5),
  })
  if (restoringSample) {
    results.assert('m4.restore.transition-180', durationIncludes(restoringSample.transitionDuration, '0.18s'), {
      category: 'duration', expected: '恢复过渡 transition-duration = 0.18s', actual: { transitionDuration: restoringSample.transitionDuration, transitionProperty: restoringSample.transitionProperty },
    })
    results.assert('m4.restore.mid-transition', restoringIntermediate.length >= 1, {
      category: 'peek', expected: '采样到恢复过程的中间 transform', actual: restoringSamples.map((item) => ({ t: translateX(item.transform), restoring: item.restoring })),
    })
  }
  await waitFor(async () => {
    const floats = await page.evaluate(() => window.__V.floats())
    const target = floats.find((item) => item.tabId === restore.tabId)
    return !!target && !target.restoring && !target.peeked
  }, { timeout: 6000, label: 'float.restored:' + restore.tabId })
  const restoredFinal = await page.evaluate(() => window.__V.floats())
  const restoredTarget = restoredFinal.find((item) => item.tabId === restore.tabId) || null
  results.assert('m4.restore.cleanup', !!restoredTarget && !restoredTarget.restoring && !restoredTarget.peeked && !restoredTarget.inert && restoredTarget.ariaHidden !== 'true' && restoredTarget.pointerEvents !== 'none', {
    category: 'cleanup',
    expected: '恢复正常：无 peek/restoring 属性、无 inert/aria-hidden、pointer-events 恢复',
    actual: restoredTarget,
  })
  results.assert('m4.restore.visible', !!restoredTarget && translateX(restoredTarget.transform) === 0 && (!restoredTarget.rect || restoredTarget.rect.x < 1440), {
    category: 'peek', expected: '恢复后无位移、回到视口内', actual: restoredTarget,
  })

  // ---------- reduced context：transition 0s + 立即恢复 ----------
  reducedApp = await openVerifyApp({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const reducedPage = reducedApp.page
  const reducedRows = await listSessions(reducedPage)
  const reducedIds = Object.keys(reducedRows || {}).slice(0, 3)
  await reducedPage.evaluate((list) => window.__ONESTEP__.actions.enterStage(list), reducedIds)
  await waitFor(async () => (await snapshot(reducedPage)).mounted === true, { timeout: 15000, label: 'reduced.stage' })
  await waitMotionIdle(reducedPage)
  const reducedFocus = (await snapshot(reducedPage)).focusId
  const reducedSession = (await mountedSessionId(reducedPage)) || reducedFocus
  await openFloats(reducedPage, reducedSession, [fileAddress(reducedSession, 'README.md')])
  const reducedCollapse = await reducedPage.evaluate(() => window.__V.sampleFloatsFor(220, 'stage-pointerdown'))
  await waitFor(async () => {
    const floats = await reducedPage.evaluate(() => window.__V.floats())
    return floats.length > 0 && floats.every((item) => item.peeked)
  }, { timeout: 6000, label: 'reduced.peeked' })
  const reducedFloat = (await reducedPage.evaluate(() => window.__V.floats()))[0]
  results.metric('m4.reduced', {
    motion: await motionState(reducedPage),
    collapse: reducedCollapse,
    float: reducedFloat,
  })
  results.assert('m4.reduced.transition-0s', !!reducedFloat && String(reducedFloat.transitionDuration || '').split(',').every((part) => part.trim() === '0s'), {
    category: 'reduced', expected: 'transition-duration = 0s（reduced 直切）', actual: reducedFloat && reducedFloat.transitionDuration,
  })
  results.assert('m4.reduced.instant-displacement', (() => {
    const firstPeeked = (reducedCollapse.samples || []).find((sample) => (sample.floats || []).some((item) => item.peeked))
    if (!firstPeeked) return false
    const item = firstPeeked.floats.find((float) => float.peeked)
    return Math.abs(translateX(item && item.transform)) > 1440
  })(), {
    category: 'reduced',
    expected: 'reduced 下收起立即到达终态（无中间位移采样）',
    actual: (() => {
      const firstPeeked = (reducedCollapse.samples || []).find((sample) => (sample.floats || []).some((item) => item.peeked))
      return firstPeeked ? { t: firstPeeked.t, floats: firstPeeked.floats.map((item) => ({ peeked: item.peeked, tx: translateX(item.transform) })) } : null
    })(),
  })
  const reducedRestore = await reducedPage.evaluate(async () => {
    const tag = document.querySelector('[data-onestep-peek-tag]')
    if (!tag) return { ok: false, reason: 'no-tag' }
    const started = performance.now()
    tag.click()
    return await new Promise((resolve) => {
      const tick = () => {
        const floats = window.__V.floats()
        const restored = floats.length > 0 && floats.every((item) => !item.peeked)
        if (restored) {
          resolve({ ok: true, latencyMs: Math.round(performance.now() - started), restoring: floats.some((item) => item.restoring), floats })
          return
        }
        if (performance.now() - started > 1000) {
          resolve({ ok: false, latencyMs: -1, floats })
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  })
  results.metric('m4.reduced.restore', reducedRestore)
  results.assert('m4.reduced.restore-immediate', reducedRestore.ok === true && reducedRestore.latencyMs <= 50, {
    category: 'reduced', expected: '恢复立即（≤50ms）且无 restoring 过渡', actual: reducedRestore,
  })

  assertNoPageErrors(results, app.handles, 'm4')
  assertNoPageErrors(results, reducedApp.handles, 'm4.reduced')
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
