/**
 * G2 多浮窗槽位（docs/p3-plan.md §6 G2 / §5.4）：
 * 1440x900 连续 `p3.openFloat` 3 个不同资源到公式槽位 → 断言浮窗数=3、rect 与公式一致（容差 2px）、
 * 两两不重叠、同内容再打开 tab 数不增且能抬升已有浮窗（§5.3 managed-float 分支）。
 * 再记录 1280x900 / 860x900 的 maxSlots 行为事实（不强制统一策略）。
 */
import {
  Results, closeApp, domState, enterStage, fileAddress, isExpanded, log, mountedSessionId, normalizeRect, openApp,
  p3Call, p3OpenTabs, p3Snapshot, rectDeviation, rectsOverlap, sleep, slotLayout, stageLayout, stageSnapshot,
} from './lib.mjs'

const results = new Results('g2-slots', 'G2 多浮窗槽位')
const RESOURCE_PATHS = ['README.md', 'package.json', 'docs/p3-plan.md']
let app = null

const round2 = (value) => Math.round(value * 100) / 100

/** 打开一个浮窗并记录前后事实。 */
async function openFloatAndRecord(page, address, slot) {
  const before = await domState(page)
  const call = await p3Call(page, 'openFloat', address, slot)
  await sleep(650)
  const after = await domState(page)
  return {
    address,
    slot,
    call: { ok: call && call.ok, tabId: call && call.tabId, steps: call && call.steps, error: call && call.error, expandedAfterFloat: call && call.expandedAfterFloat, collapsed: call && call.collapsed },
    floatsBefore: before.dom.floatCount,
    floatsAfter: after.dom.floatCount,
    floatRects: after.floats.map((float) => ({ paneId: float.paneId, tabId: float.tabId, rect: float.rect })),
    expanded: after.expanded,
    stage: after.stage,
    focus: after.focus,
  }
}

try {
  /* ================= 1440x900 主场景 ================= */
  app = await openApp({ viewport: { width: 1440, height: 900 } })
  const { page, handles } = app
  const stage = await enterStage(page, { count: 3 })
  const layout = await stageLayout(page)
  const mounted = await mountedSessionId(page)
  const slotInfo = slotLayout(layout.stage, { viewportWidth: 1440 })
  const addresses = RESOURCE_PATHS.map((relativePath) => fileAddress(mounted, relativePath))
  const baseline = await domState(page)

  results.setEnv('viewport1440', { width: 1440, height: 900 })
  results.metric('stage.layout', layout.stage)
  results.metric('slotLayout.1440', slotInfo)
  results.metric('addresses', addresses)
  results.metric('baseline', { expanded: baseline.expanded, floatCount: baseline.dom.floatCount, stage: baseline.stage, focus: baseline.focus })
  results.assert('g2.slots.formula.1440', slotInfo.slotW === 348 && slotInfo.maxSlots === 3, {
    actual: slotInfo,
    expected: { slotW: 348, maxSlots: 3 },
    category: 'G2',
    note: 'stage.w=1160 → slotW=clamp(340, 348, 480)=348',
  })

  // 依次打开 3 个不同资源到 3 槽
  const opens = []
  for (let index = 0; index < 3; index += 1) {
    opens.push(await openFloatAndRecord(page, addresses[index], slotInfo.slots[index]))
    results.metric('openFloat.' + index, opens[index])
  }
  const finalState = await domState(page)
  const finalFloats = finalState.floats.map((float) => ({ paneId: float.paneId, tabId: float.tabId, rect: float.rect, active: float.active }))
  results.metric('floats.final', finalFloats)

  results.assert('g2.opens.all.ok', opens.every((entry) => entry.call.ok), {
    actual: opens.map((entry) => ({ ok: entry.call.ok, error: entry.call.error })),
    expected: 'all ok',
    category: 'G2',
  })
  results.assert('g2.float.count.3', finalState.dom.floatCount === 3, { actual: finalState.dom.floatCount, expected: 3, category: 'G2' })

  // rect 与公式一致（容差 2px）
  const rectChecks = finalFloats.map((float, index) => {
    const expected = slotInfo.slots[index]
    const dev = rectDeviation(float.rect, expected)
    return { paneId: float.paneId, expected, actual: float.rect, deviation: dev, pass: dev.max <= 2 }
  })
  results.metric('g2.rectChecks', rectChecks)
  results.assert('g2.rects.match.slots', rectChecks.length === 3 && rectChecks.every((check) => check.pass), {
    actual: rectChecks.map((check) => ({ actual: check.actual, expected: check.expected, deviation: check.deviation.max })),
    expected: { tolerance: 2 },
    category: 'G2',
  })

  // 两两不重叠
  const overlapPairs = []
  for (let left = 0; left < finalFloats.length; left += 1) {
    for (let right = left + 1; right < finalFloats.length; right += 1) {
      if (rectsOverlap(normalizeRect(finalFloats[left].rect), normalizeRect(finalFloats[right].rect))) {
        overlapPairs.push([finalFloats[left].paneId, finalFloats[right].paneId])
      }
    }
  }
  results.metric('g2.overlapPairs', overlapPairs)
  results.assert('g2.no.overlap', overlapPairs.length === 0, { actual: overlapPairs, expected: [], category: 'G2' })

  // 槽位由公式决定，且已有浮窗在后续打开时不移动（rect 与刚创建时一致）
  const stability = addresses.map((address, index) => {
    const created = opens[index].floatRects.find((float) => float.tabId)
    const createdRect = opens[index].floatRects[index] || opens[index].floatRects[opens[index].floatRects.length - 1]
    const finalRect = finalFloats[index] && finalFloats[index].rect
    return { index, createdRect: createdRect && createdRect.rect, finalRect, dev: rectDeviation(createdRect && createdRect.rect, finalRect).max }
  })
  results.metric('g2.rectStability', stability)
  results.assert('g2.rects.stable.after.open', stability.every((entry) => entry.dev <= 2), {
    actual: stability,
    expected: 'previous floats stay put',
    category: 'G2',
    note: '已有浮窗不因新浮窗移动（官方无公开 move）',
  })

  // 舞台/焦点窗不被浮窗改变
  const stageStable = rectDeviation(baseline.stage, finalState.stage).max <= 0.5 && rectDeviation(baseline.focus, finalState.focus).max <= 0.5
  results.metric('g2.stageStability', { before: { stage: baseline.stage, focus: baseline.focus }, after: { stage: finalState.stage, focus: finalState.focus } })
  results.assert('g2.stage.focus.stable', stageStable, { actual: { before: baseline.stage, after: finalState.stage }, expected: 'unchanged', category: 'G2' })

  await results.shot(page, 'g2-three-floats-1440.png')

  /* ---- 同内容再次打开 ---- */
  const tabsBefore = await p3OpenTabs(page)
  const tabIdsBefore = (tabsBefore.value || []).map((tab) => tab.tabId)
  const firstFloat = finalFloats[0]
  const rawReopen = await p3Call(page, 'openResource', addresses[0])
  await sleep(650)
  const afterRawReopen = await domState(page)
  const tabsAfterRaw = await p3OpenTabs(page)
  const tabIdsAfterRaw = (tabsAfterRaw.value || []).map((tab) => tab.tabId)
  const rawActive = await p3Call(page, 'active')
  const rawFacts = {
    openResource: rawReopen,
    tabCountBefore: tabIdsBefore.length,
    tabCountAfterRawOpen: tabIdsAfterRaw.length,
    floatCountAfterRawOpen: afterRawReopen.dom.floatCount,
    activeIdAfterRawOpen: rawActive && rawActive.ok ? rawActive.value && rawActive.value.id : null,
    targetFloatTabId: firstFloat && firstFloat.tabId,
    targetFloatActiveAttr: (afterRawReopen.floats.find((float) => float.tabId === (firstFloat && firstFloat.tabId)) || {}).active || false,
    expandedAfterRawOpen: afterRawReopen.expanded,
  }
  results.metric('g2.reopen.rawReveal', rawFacts)
  results.assert('g2.reopen.tabcount.unchanged', tabIdsAfterRaw.length === tabIdsBefore.length, {
    actual: { before: tabIdsBefore.length, after: tabIdsAfterRaw.length },
    expected: 'unchanged',
    category: 'G2',
    note: '同内容 openResource 只揭示、不新增 tab（官方语义）',
  })
  results.assert('g2.reopen.floatcount.unchanged', afterRawReopen.dom.floatCount === 3, {
    actual: afterRawReopen.dom.floatCount,
    expected: 3,
    category: 'G2',
  })

  // §5.3 managed-float 分支：官方揭示不改变焦点 → 补 focus(tabId) 抬升
  const focusCall = firstFloat ? await p3Call(page, 'focus', firstFloat.tabId) : { ok: false, error: 'no-float' }
  await sleep(500)
  const afterFocus = await domState(page)
  const activeAfterFocus = await p3Call(page, 'active')
  const activeIdAfterFocus = activeAfterFocus && activeAfterFocus.ok && activeAfterFocus.value ? activeAfterFocus.value.id : null
  const focusedFloat = afterFocus.floats.find((float) => float.tabId === (firstFloat && firstFloat.tabId)) || null
  results.metric('g2.reopen.managedFocus', {
    focusCall,
    activeIdAfterFocus,
    targetTabId: firstFloat && firstFloat.tabId,
    floatActiveAttr: focusedFloat ? focusedFloat.active : null,
    expanded: afterFocus.expanded,
  })
  results.assert('g2.reopen.existing.float.focused', !!firstFloat && activeIdAfterFocus === firstFloat.tabId, {
    actual: { activeIdAfterFocus, targetTabId: firstFloat && firstFloat.tabId },
    expected: 'active() = 已有浮窗 tab',
    category: 'G2',
    note: '§5.3：isManagedFloat(rec.id) 时补 svc.focus(rec.id) 抬升（官方 raw reveal 不负责焦点）',
  })
  results.assert('g2.reopen.float.active.attr', !!(focusedFloat && focusedFloat.active), {
    actual: focusedFloat && { paneId: focusedFloat.paneId, active: focusedFloat.active },
    expected: { active: true },
    category: 'G2',
  })
  await results.shot(page, 'g2-reopen-focus-1440.png')

  // 收尾：关闭全部浮窗与展开态，避免影响下一段（每段其实用新 context，这里只保证截图状态干净）
  await sleep(100)
  results.captureErrors(handles)
  results.step('page.errors', { pageErrors: handles.pageErrors.slice(0, 8), consoleErrors: handles.consoleErrors.slice(0, 8) })
  await closeApp(app)
  app = null

  /* ================= 1280x900：maxSlots 事实 ================= */
  const wide = await openApp({ viewport: { width: 1280, height: 900 } })
  try {
    const wp = wide.page
    await enterStage(wp, { count: 3 })
    const wLayout = await stageLayout(wp)
    const wMounted = await mountedSessionId(wp)
    const wSlotInfo = slotLayout(wLayout.stage, { viewportWidth: 1280 })
    const wAddresses = RESOURCE_PATHS.map((relativePath) => fileAddress(wMounted, relativePath))
    results.setEnv('viewport1280', { width: 1280, height: 900 })
    results.metric('g2.1280', { stage: wLayout.stage, slotInfo: wSlotInfo })
    results.assert('g2.1280.formula', wSlotInfo.slotW === 340 && wSlotInfo.maxSlots === 2, {
      actual: wSlotInfo,
      expected: { slotW: 340, maxSlots: 2 },
      category: 'G2',
      note: 'stage.w=1000 → slotW=340，maxSlots=floor((1000-32+8)/348)=2',
    })
    const opensWide = []
    for (let index = 0; index < 3; index += 1) {
      opensWide.push(await openFloatAndRecord(wp, wAddresses[index], wSlotInfo.slots[index]))
    }
    const wideState = await domState(wp)
    results.metric('g2.1280.opens', opensWide)
    results.metric('g2.1280.floats', wideState.floats.map((float) => ({ paneId: float.paneId, tabId: float.tabId, rect: float.rect })))
    results.metric('g2.1280.floatCount', wideState.dom.floatCount)
    results.metric('g2.1280.slots', wSlotInfo.slots)
    results.step('g2.1280.observation', {
      note: '只记录事实：官方 float() 不按 maxSlots 拒绝，第 3 窗落在公式第 3 槽（可能左越 stage 边界）；满槽策略属 P3-10',
      floatCount: wideState.dom.floatCount,
      thirdFloatRect: wideState.floats[2] && wideState.floats[2].rect,
    })
    await results.shot(wp, 'g2-slots-1280.png')
  } finally {
    await closeApp(wide)
  }

  /* ================= 860x900：窄屏事实 ================= */
  const narrow = await openApp({ viewport: { width: 860, height: 900 } })
  try {
    const np = narrow.page
    let narrowStage = null
    try {
      await enterStage(np, { count: 3, timeout: 8000 })
      narrowStage = await stageLayout(np)
    } catch (error) {
      narrowStage = null
      results.metric('g2.860.enterStage.error', String((error && error.message) || error).slice(0, 400))
    }
    const nState = await domState(np)
    const nSnap = await stageSnapshot(np)
    results.setEnv('viewport860', { width: 860, height: 900 })
    const nSlotInfo = narrowStage && narrowStage.stage ? slotLayout(narrowStage.stage, { viewportWidth: 860 }) : null
    results.metric('g2.860', {
      stageMounted: !!nState.stage,
      snapshot: { mounted: nSnap && nSnap.mounted, candidates: nSnap && (nSnap.candidates || []).length, stageActive: nSnap && nSnap.stageActive },
      stage: nState.stage,
      focus: nState.focus,
      slotInfo: nSlotInfo,
      toast: await np.evaluate(() => Array.from(document.querySelectorAll('.onestep-toast')).map((el) => String(el.textContent || '').slice(0, 120))),
    })
    if (nState.stage && nSlotInfo) {
      results.assert('g2.860.narrow.single.slot', nSlotInfo.narrow === true && nSlotInfo.maxSlots === 1, {
        actual: { narrow: nSlotInfo.narrow, maxSlots: nSlotInfo.maxSlots, stage: nState.stage },
        expected: { narrow: true, maxSlots: 1 },
        category: 'G2',
      })
      // 窄屏事实：打开 1 个浮窗到唯一槽位，记录 rect 是否落在视口内（不强制产品策略）
      const nAddress = fileAddress(await mountedSessionId(np), RESOURCE_PATHS[0])
      const narrowOpen = await openFloatAndRecord(np, nAddress, nSlotInfo.slots[0])
      const narrowFloats = nState.floats
      results.metric('g2.860.singleSlot', { open: narrowOpen, expected: nSlotInfo.slots[0], need: 1, viewport: 860 })
      results.assert('g2.860.singleSlot.opened', narrowOpen.call.ok === true && narrowOpen.floatsAfter === 1, {
        actual: { ok: narrowOpen.call.ok, floats: narrowOpen.floatsAfter },
        expected: { ok: true, floats: 1 },
        category: 'G2',
        note: '窄屏 1 槽仍可承载一个浮窗（提示/满槽策略属 P3-4/P3-10）',
      })
      results.assert('g2.860.singleSlot.inViewport', !!narrowOpen.floatRects[0]
        && narrowOpen.floatRects[0].rect.x >= 0
        && narrowOpen.floatRects[0].rect.x + narrowOpen.floatRects[0].rect.w <= 860, {
        actual: narrowOpen.floatRects[0] && narrowOpen.floatRects[0].rect,
        expected: '0 <= x 且 x+w <= 860',
        category: 'G2',
      })
      results.metric('g2.860.floatRects', narrowOpen.floatRects)
      await results.shot(np, 'g2-slots-860.png')
    } else {
      results.skip(
        'g2.860.narrow.single.slot',
        '860x900 视口下舞台未挂载（onNarrow 退出舞台），无法在当前构建量测窄屏 maxSlots 行为；这是 P3-4/P3-5 窄屏策略的输入事实',
        'G2',
      )
      await results.shot(np, 'g2-narrow-860.png')
    }
  } finally {
    await closeApp(narrow)
  }
} catch (error) {
  results.fatal(error)
} finally {
  await closeApp(app)
}
const data = results.finish()
log('[g2] summary ' + JSON.stringify(data.summary))
process.exit(data.ok ? 0 : 1)
