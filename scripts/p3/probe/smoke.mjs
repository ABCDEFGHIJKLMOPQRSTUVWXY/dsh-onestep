/**
 * P3-1 探针 smoke：探测桥事实与库函数本身（不属于 4 个验收套件，但保留证据）。
 * 目的：确认 contract / stage / 资源地址 / 浮窗 DOM / 官方 push 量测方法可用，再跑 g1-g4。
 */
import {
  ARTIFACTS, PROBE_OUT, Results, closeApp, domState, enterStage, fileAddress, isExpanded, listActionNames,
  listSessions, log, mountedSessionId, openApp, p3Call, p3Contract, p3OpenTabs, p3Snapshot, p3Tabs, slotLayout,
  sleep, stageLayout, stageSnapshot,
} from './lib.mjs'

const results = new Results('smoke', 'P3-1 探针桥 smoke / 库自检')
let app = null
try {
  app = await openApp({ viewport: { width: 1440, height: 900 } })
  const { page, handles } = app
  results.step('app.open', { url: page.url().replace(/token=[^&]+/, 'token=***') })

  const actionNames = await listActionNames(page)
  results.step('actions.names', actionNames)
  const contract = await p3Contract(page)
  results.assert('p3.contract.ok', !!contract.ok, { actual: contract, expected: { ok: true } })
  results.metric('kinds', contract.kinds)
  const sessionList = await listSessions(page)
  results.step('sessions', { total: Object.keys(sessionList).length, sample: Object.keys(sessionList).slice(0, 6) })

  const stage = await enterStage(page, { count: 3 })
  results.step('stage.enter', { focusId: stage.snapshot.focusId, candidates: stage.snapshot.candidates, layout: stage.layout })
  results.assert('stage.mounted', !!stage.snapshot.mounted && !!stage.layout.stage, { actual: { mounted: stage.snapshot.mounted, stage: stage.layout.stage } })

  const layoutNow = await stageLayout(page)
  const slots = slotLayout(layoutNow.stage, { viewportWidth: 1440 })
  results.metric('slotLayout.1440', slots)
  results.assert('stage.geometry.1440', !!layoutNow.stage && Math.abs(layoutNow.stage.w - 1160) < 2, {
    actual: layoutNow.stage,
    expected: { x: 280, w: 1160 },
    note: 'Lead smoke 实测 stage {x:280,y:0,w:1160,h:900}',
  })

  const mounted = await mountedSessionId(page)
  results.metric('mounted', mounted)
  const address = fileAddress(mounted, 'README.md')
  results.step('resource.address', address)

  const before = await domState(page)
  const openResult = await p3Call(page, 'openFloat', address, slots.slots[0])
  results.step('p3.openFloat', openResult)
  await sleep(700)
  const after = await domState(page)
  results.metric('float.after', after.floats)
  results.metric('panel.after', after.panels)
  results.assert('p3.openFloat.ok', !!openResult.ok, { actual: openResult })
  results.assert('float.count.1', after.dom.floatCount === 1, { actual: after.dom.floatCount, expected: 1 })
  results.assert('float.rect', !!after.floats[0] && Math.abs(after.floats[0].rect.x - slots.slots[0].x) <= 2, {
    expected: slots.slots[0],
    actual: after.floats[0] && after.floats[0].rect,
  })
  results.assert('panel.collapsed.after.redirect', (await isExpanded(page)) === false, { actual: await isExpanded(page), expected: false })
  results.metric('focus.before', before.focus)
  results.metric('focus.after', after.focus)

  const tabs = await p3Tabs(page)
  const openTabs = await p3OpenTabs(page)
  results.step('tabs.after', { tabs, openTabs })
  const p3 = await p3Snapshot(page)
  results.step('p3.snapshot.after', p3)

  // 对照组：直接 openResource（不重定向）应展开右栏并 push 主区（focus 窗口收窄）。
  const control = await openApp({ viewport: { width: 1440, height: 900 } })
  try {
    const cp = control.page
    await enterStage(cp, { count: 3 })
    const cLayout = await stageLayout(cp)
    const cMounted = await mountedSessionId(cp)
    const cAddress = fileAddress(cMounted, 'package.json')
    const cBefore = await domState(cp)
    const rawOpen = await p3Call(cp, 'openResource', cAddress)
    await sleep(900)
    const cAfter = await domState(cp)
    results.step('control.openResource', { address: cAddress, result: rawOpen })
    results.metric('control.focus.before', cBefore.focus)
    results.metric('control.focus.after', cAfter.focus)
    results.metric('control.stage.before', cBefore.stage)
    results.metric('control.stage.after', cAfter.stage)
    results.metric('control.expanded.after', cAfter.expanded)
    results.metric('control.panels.after', cAfter.panels.filter((panel) => panel.panel))
    const push = cBefore.focus && cAfter.focus ? cBefore.focus.w - cAfter.focus.w : null
    results.metric('control.focus.shrink', push)
    results.assert('control.push.detected', !!cAfter.expanded && push !== null && Math.abs(push) > 1, {
      actual: { expanded: cAfter.expanded, shrink: push, stageBefore: cBefore.stage, stageAfter: cAfter.stage },
      note: '证明「push 会被 stage/focus 几何量到」，G1 的测量方法有效',
    })
    await results.shot(cp, 'smoke-control-push-1440.png')
  } finally {
    await closeApp(control)
  }

  await results.shot(page, 'smoke-float-1440.png')
  results.captureErrors(handles)
  results.step('page.errors', { pageErrors: handles.pageErrors.slice(0, 5), consoleErrors: handles.consoleErrors.slice(0, 5) })
} catch (error) {
  results.fatal(error)
} finally {
  await closeApp(app)
}
const data = results.finish()
process.exit(data.ok ? 0 : 1)
