/**
 * G4 dock 分屏探针（docs/p3-plan.md §5.6 / §6 G4）：
 * 浮窗 → `p3.dock(paneId)`：断言浮窗消失、官方右栏展开（`data-sidebar-right-open`）、焦点窗被 push 收窄（记录前后宽度）、
 * tab 不丢失；再 `p3.float(tabId, rect)` 回到浮窗（记录官方是否允许、是否需要先展开）；切回浮动后新打开不 push；
 * 刷新后记录官方浮窗/展开态恢复事实（P3-3 形态恢复的输入）。
 */
import {
  Results, closeApp, domState, enterStage, fileAddress, isExpanded, log, mountedSessionId, normalizeRect, openApp,
  p3Call, p3OpenTabs, p3Snapshot, rectDeviation, sleep, slotLayout, stageLayout, waitFor,
} from './lib.mjs'

const VIEWPORT = { width: 1440, height: 900 }
const results = new Results('g4-split', 'G4 dock 分屏 / 回浮窗 / 刷新恢复')
let app = null

/**
 * 等舞台/焦点几何连续稳定 3 次采样再测量（官方右栏列宽变化有过渡；
 * P4 起插件侧动作还可能有 VT 队列延迟，固定 sleep 易在过渡中间采样）。
 */
async function waitStageStable(page, timeoutMs = 9000) {
  const started = Date.now()
  let previous = null
  let stable = 0
  let state = null
  for (;;) {
    state = await domState(page)
    const key = JSON.stringify({ stage: state.stage, focus: state.focus, floats: state.floats && state.floats.map((item) => item.rect) })
    if (key === previous) stable += 1
    else {
      stable = 0
      previous = key
    }
    if (stable >= 2) return state
    if (Date.now() - started > timeoutMs) return state
    await sleep(120)
  }
}

try {
  app = await openApp({ viewport: VIEWPORT })
  const { page, handles } = app
  const stage = await enterStage(page, { count: 3 })
  const layout = await stageLayout(page)
  const mounted = await mountedSessionId(page)
  const slotInfo = slotLayout(layout.stage, { viewportWidth: VIEWPORT.width })
  const addresses = ['README.md', 'package.json'].map((relativePath) => fileAddress(mounted, relativePath))

  /* ---- 1. 先开一个浮窗 ---- */
  const baseline = await domState(page)
  const openFloat = await p3Call(page, 'openFloat', addresses[0], slotInfo.slots[0])
  await sleep(650)
  const floatState = await domState(page)
  const floatPaneId = floatState.floats[0] ? floatState.floats[0].paneId : null
  const floatTabId = floatState.floats[0] ? floatState.floats[0].tabId : null
  results.metric('g4.baseline', { stage: baseline.stage, focus: baseline.focus, expanded: baseline.expanded })
  results.metric('g4.openFloat', { call: openFloat && { ok: openFloat.ok, tabId: openFloat.tabId, steps: openFloat.steps }, paneId: floatPaneId, tabId: floatTabId, rect: floatState.floats[0] && floatState.floats[0].rect })
  results.assert('g4.float.opened', !!openFloat.ok && floatState.dom.floatCount === 1, {
    actual: { ok: openFloat.ok, floatCount: floatState.dom.floatCount },
    expected: { ok: true, floatCount: 1 },
    category: 'G4',
  })
  const tabsBeforeDock = await p3OpenTabs(page)

  /* ---- 2. dock：浮窗收回右栏 ---- */
  const dockCall = await p3Call(page, 'dock', floatPaneId)
  await sleep(800)
  const afterDock = await domState(page)
  const tabsAfterDock = await p3OpenTabs(page)
  const focusShrink = baseline.focus && afterDock.focus ? Math.round((baseline.focus.w - afterDock.focus.w) * 100) / 100 : null
  const stageShrink = baseline.stage && afterDock.stage ? Math.round((baseline.stage.w - afterDock.stage.w) * 100) / 100 : null
  const panelAfterDock = afterDock.panels.filter((panel) => panel.panel)[0] || null
  results.metric('g4.dock', {
    call: dockCall,
    floatCount: afterDock.dom.floatCount,
    openPanelCount: afterDock.dom.openPanelCount,
    expanded: afterDock.expanded,
    panel: panelAfterDock,
    focusBefore: baseline.focus,
    focusAfter: afterDock.focus,
    focusShrink,
    stageBefore: baseline.stage,
    stageAfter: afterDock.stage,
    stageShrink,
    floatTabStillOpen: (tabsAfterDock.value || []).some((tab) => tab.tabId === floatTabId),
    tabCountBefore: (tabsBeforeDock.value || []).length,
    tabCountAfter: (tabsAfterDock.value || []).length,
  })
  results.assert('g4.dock.float.gone', afterDock.dom.floatCount === 0, {
    actual: afterDock.dom.floatCount,
    expected: 0,
    category: 'G4',
  })
  results.assert('g4.dock.panel.open', !!panelAfterDock && panelAfterDock.open === true && afterDock.expanded === true, {
    actual: { panelOpenAttr: panelAfterDock && panelAfterDock.open, expanded: afterDock.expanded },
    expected: { panelOpenAttr: true, expanded: true },
    category: 'G4',
  })
  results.assert('g4.dock.push.focus', focusShrink !== null && Math.abs(focusShrink) > 10, {
    actual: { focusBefore: baseline.focus, focusAfter: afterDock.focus, shrinkPx: focusShrink, stageShrinkPx: stageShrink },
    expected: 'focus 窗按官方 push 收窄（>10px）',
    category: 'G4',
  })
  results.assert('g4.dock.tab.preserved', (tabsAfterDock.value || []).some((tab) => tab.tabId === floatTabId), {
    actual: { tabCountBefore: (tabsBeforeDock.value || []).length, tabCountAfter: (tabsAfterDock.value || []).length, floatTabId },
    expected: '被 dock 的 tab 仍在 openTabs',
    category: 'G4',
  })

  /* ---- 3. float 回到浮窗（expanded 态下） ---- */
  const backRect = slotInfo.slots[1]
  const floatBack = floatTabId ? await p3Call(page, 'float', floatTabId, backRect) : { ok: false, error: 'no-tab' }
  await sleep(700)
  const afterFloatBack = await domState(page)
  const backFloat = afterFloatBack.floats[0] || null
  const backDev = rectDeviation(backFloat && backFloat.rect, backRect)
  results.metric('g4.floatBack', {
    call: floatBack,
    floatCount: afterFloatBack.dom.floatCount,
    expanded: afterFloatBack.expanded,
    rect: backFloat && backFloat.rect,
    expectedRect: backRect,
    deviation: backDev,
    panelOpen: (afterFloatBack.panels.filter((panel) => panel.panel)[0] || {}).open,
  })
  results.assert('g4.floatBack.allowed', !!floatBack.ok && afterFloatBack.dom.floatCount === 1, {
    actual: { call: floatBack, floatCount: afterFloatBack.dom.floatCount },
    expected: { ok: true, floatCount: 1 },
    category: 'G4',
    note: '官方 float(tabId, rect) 对 docked tab 允许；服务文档要求 tab 位于 dock',
  })
  results.assert('g4.floatBack.rect', !!backFloat && backDev.max <= 2, {
    actual: backFloat && backFloat.rect,
    expected: backRect,
    category: 'G4',
  })

  /* ---- 4. 收起右栏 → 切回浮动形态后新打开不 push ---- */
  if (await isExpanded(page)) {
    await p3Call(page, 'toggleExpanded')
    await sleep(600)
  }
  const collapsedState = await waitStageStable(page)
  const openSecond = await p3Call(page, 'openFloat', addresses[1], slotInfo.slots[0])
  await waitFor(async () => {
    const state = await domState(page)
    return state.dom.floatCount === 2
  }, { timeout: 9000, label: 'g4.second-float' })
  const afterSecondFloat = await waitStageStable(page)
  const secondShrink = collapsedState.focus && afterSecondFloat.focus ? Math.round((collapsedState.focus.w - afterSecondFloat.focus.w) * 100) / 100 : null
  results.metric('g4.floatMode.newOpen', {
    collapsedFocus: collapsedState.focus,
    collapsedExpanded: collapsedState.expanded,
    openCall: openSecond && { ok: openSecond.ok, tabId: openSecond.tabId, steps: openSecond.steps },
    floatsAfter: afterSecondFloat.dom.floatCount,
    focusAfter: afterSecondFloat.focus,
    focusShrink: secondShrink,
    expandedAfter: afterSecondFloat.expanded,
  })
  results.assert('g4.floatMode.no.push', Math.abs(secondShrink === null ? 9999 : secondShrink) <= 0.5 && afterSecondFloat.expanded === false, {
    actual: { focusShrinkPx: secondShrink, expanded: afterSecondFloat.expanded },
    expected: { focusShrinkPx: 0, expanded: false },
    category: 'G4',
    note: '切回浮动形态后新打开不再 push（§5.6）',
  })
  results.assert('g4.floatMode.second.float', afterSecondFloat.dom.floatCount === 2, {
    actual: afterSecondFloat.dom.floatCount,
    expected: 2,
    category: 'G4',
  })

  /* ---- 5. 刷新后官方恢复事实（P3-3 形态恢复输入） ---- */
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('[role="textbox"], [contenteditable="true"]', { timeout: 60000 })
  await page.waitForFunction(() => !!window.__ONESTEP__ && !!window.__ONESTEP__.actions, null, { timeout: 40000 })
  await page.waitForFunction(() => {
    try {
      const snap = window.__ONESTEP__.actions.p3.snapshot()
      return !!snap && snap.available === true
    } catch (_error) {
      return false
    }
  }, null, { timeout: 20000 })
  await sleep(1500)
  const afterReload = await domState(page)
  const reloadSnapshot = await p3Snapshot(page)
  results.metric('g4.reload', {
    stage: afterReload.stage,
    floatCount: afterReload.dom.floatCount,
    floats: afterReload.floats.map((float) => ({ paneId: float.paneId, tabId: float.tabId, rect: float.rect, active: float.active })),
    expanded: afterReload.expanded,
    panels: afterReload.panels.filter((panel) => panel.panel),
    openTabs: reloadSnapshot && reloadSnapshot.openTabs,
    mounted: reloadSnapshot && reloadSnapshot.mounted,
  })
  results.assert('g4.reload.floats.restored', afterReload.dom.floatCount >= 1, {
    actual: afterReload.dom.floatCount,
    expected: '>=1（官方持久化恢复浮窗）',
    category: 'G4',
    note: '插件形态恢复属 P3-3；这里只记录官方基线',
  })
  results.metric('g4.reload.expanded', afterReload.expanded)
  await results.shot(page, 'g4-after-reload-1440.png')

  results.captureErrors(handles)
  results.step('page.errors', { pageErrors: handles.pageErrors.slice(0, 8), consoleErrors: handles.consoleErrors.slice(0, 8) })
  await results.shot(page, 'g4-float-mode-1440.png')
} catch (error) {
  results.fatal(error)
} finally {
  await closeApp(app)
}
const data = results.finish()
log('[g4] summary ' + JSON.stringify(data.summary))
process.exit(data.ok ? 0 : 1)
