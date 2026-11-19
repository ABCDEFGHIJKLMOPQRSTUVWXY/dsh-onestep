/**
 * G1 默认打开不重排（docs/p3-plan.md §6 G1 / §5.3）：
 * 进入舞台后逐帧（rAF）采样 stage / focus / 官方右栏 panel / 浮窗，
 * 在同一帧内触发 `p3.openFloat(address, slot)`（= §5.3 探针版：官方打开 → float → 收起），
 * 断言：focus/stage 几何全程不变（0px 容差，记录最大偏差）、无 `data-sidebar-right-open` 中间帧、
 * 最终浮窗 rect ≈ 指定槽位。
 * 对照组（独立 context）：直接 `p3.openResource` 不重定向 → 应展开右栏并 push 收窄，证明测量方法有效。
 */
import {
  Results, closeApp, domState, enterStage, fileAddress, isExpanded, log, mountedSessionId, openApp, p3Call,
  rafSample, rectDeviation, slotLayout, sleep, stageLayout, stageSnapshot,
} from './lib.mjs'

const VIEWPORT = { width: 1440, height: 900 }
const FRAMES = 40
const TRIGGER_FRAME = 6
const results = new Results('g1-frames', 'G1 默认打开不重排（逐帧）')
let app = null

const round2 = (value) => Math.round(value * 100) / 100

try {
  /* ---------------- 主场景：openFloat 重定向 ---------------- */
  app = await openApp({ viewport: VIEWPORT })
  const { page, handles } = app
  results.setEnv('viewport', VIEWPORT)
  results.step('app.open', { url: page.url().replace(/token=[^&]+/, 'token=***') })

  const stage = await enterStage(page, { count: 3 })
  const layout = await stageLayout(page)
  const mounted = await mountedSessionId(page)
  const slotInfo = slotLayout(layout.stage, { viewportWidth: VIEWPORT.width })
  const slot = slotInfo.slots[0]
  const address = fileAddress(mounted, 'README.md')
  const baseline = await domState(page)

  results.metric('slotLayout', slotInfo)
  results.metric('slot', slot)
  results.metric('address', address)
  results.metric('baseline', { stage: baseline.stage, focus: baseline.focus, expanded: baseline.expanded, openPanelCount: baseline.dom.openPanelCount, floatCount: baseline.dom.floatCount })

  results.assert('baseline.stage.visible', !!baseline.stage && baseline.stage.w > 100, { actual: baseline.stage })
  results.assert('baseline.collapsed', baseline.expanded === false && baseline.dom.openPanelCount === 0, {
    actual: { expanded: baseline.expanded, openPanelCount: baseline.dom.openPanelCount },
    expected: { expanded: false, openPanelCount: 0 },
    note: '全新 context 的官方默认布局应为收起',
  })

  // 逐帧采样 + 同一帧内触发重定向打开
  const sampled = await rafSample(page, {
    frames: FRAMES,
    triggerFrame: TRIGGER_FRAME,
    action: { source: 'p3', method: 'openFloat', args: [address, slot] },
  })
  const frames = sampled.frames || []
  results.metric('action', {
    return: sampled.actionReturn,
    error: sampled.actionError,
    frame: sampled.actionFrame,
    durationMs: sampled.actionDurationMs,
  })

  await sleep(600)
  const settled = await domState(page)
  results.metric('settled', {
    stage: settled.stage,
    focus: settled.focus,
    expanded: settled.expanded,
    openPanelCount: settled.dom.openPanelCount,
    floatCount: settled.dom.floatCount,
    floats: settled.floats.map((flt) => ({ paneId: flt.paneId, tabId: flt.tabId, rect: flt.rect })),
  })

  /* ---- 帧分析 ---- */
  const baselineFocus = baseline.focus
  const baselineStage = baseline.stage
  const frameAnalysis = frames.map((frame) => ({
    i: frame.i,
    t: frame.t,
    focusDev: rectDeviation(frame.focus, baselineFocus).max,
    stageDev: rectDeviation(frame.stage, baselineStage).max,
    expanded: frame.expanded,
    openPanelCount: frame.openPanelCount,
    floatCount: (frame.floats || []).length,
    focusW: frame.focus ? frame.focus.w : null,
    stageW: frame.stage ? frame.stage.w : null,
  }))
  results.metric('frameSeries', frameAnalysis)

  const preFrames = frameAnalysis.filter((frame) => frame.i < TRIGGER_FRAME)
  const postFrames = frameAnalysis.filter((frame) => frame.i > TRIGGER_FRAME)
  const maxFocusDeviation = Math.max(0, ...postFrames.map((frame) => frame.focusDev))
  const maxStageDeviation = Math.max(0, ...postFrames.map((frame) => frame.stageDev))
  // 中间展开帧：触发帧之后任意帧出现 data-sidebar-right-open（或 expanded=true）
  const openFrames = postFrames.filter((frame) => frame.openPanelCount > 0 || frame.expanded === true)
  // 几何抖动帧（含 panel 打开之外的任何位移；0px 容差口径）
  const disturbanceFrames = postFrames.filter((frame) => frame.focusDev > 0.5 || frame.stageDev > 0.5)
  const firstFloatFrame = postFrames.find((frame) => frame.floatCount > 0) || null

  results.metric('g1.maxFocusDeviationPx', maxFocusDeviation)
  results.metric('g1.maxStageDeviationPx', maxStageDeviation)
  results.metric('g1.intermediateOpenFrames', openFrames)
  results.metric('g1.openFrameCount', openFrames.length)
  results.metric('g1.disturbanceFrames', disturbanceFrames)
  results.metric('g1.firstFloatFrame', firstFloatFrame)
  results.metric('g1.framesSampled', frames.length)
  results.metric('g1.preFrameDeviation', Math.max(0, ...preFrames.map((frame) => Math.max(frame.focusDev, frame.stageDev))))

  results.assert('g1.frames.sampled', frames.length >= 30, { actual: frames.length, expected: '>=30' })
  results.assert('g1.action.ok', !!sampled.actionReturn && sampled.actionReturn.ok === true, {
    actual: sampled.actionReturn,
    expected: { ok: true, steps: ['open', 'active', 'float', 'collapse'] },
  })
  results.assert('g1.openFloat.steps', !!(sampled.actionReturn && JSON.stringify(sampled.actionReturn.steps) === JSON.stringify(['open', 'active', 'float', 'collapse'])), {
    actual: sampled.actionReturn && sampled.actionReturn.steps,
    expected: ['open', 'active', 'float', 'collapse'],
  })
  results.assert('g1.focus.geometry.stable', maxFocusDeviation <= 0.5, {
    actual: { maxDeviationPx: maxFocusDeviation, baseline: baselineFocus, disturbanceFrames },
    expected: { maxDeviationPx: 0, tolerancePx: 0.5 },
    category: 'G1',
    note: '0px 容差口径；>0.5px 视为重排',
  })
  results.assert('g1.stage.geometry.stable', maxStageDeviation <= 0.5, {
    actual: { maxDeviationPx: maxStageDeviation, baseline: baselineStage, disturbanceFrames },
    expected: { maxDeviationPx: 0, tolerancePx: 0.5 },
    category: 'G1',
  })
  results.assert('g1.no.intermediate.open.frames', openFrames.length === 0, {
    actual: { count: openFrames.length, frames: openFrames.map((frame) => ({ i: frame.i, t: frame.t, openPanelCount: frame.openPanelCount, expanded: frame.expanded })) },
    expected: { count: 0 },
    category: 'G1',
    note: '中间展开帧会记录帧号/持续帧数，作为 No-Go/降级依据',
  })
  const floatRect = settled.floats[0] ? settled.floats[0].rect : null
  const floatDev = rectDeviation(floatRect, slot)
  results.metric('g1.finalFloatDeviation', floatDev)
  results.assert('g1.final.rect', !!floatRect && floatDev.max <= 2, {
    actual: floatRect,
    expected: slot,
    category: 'G1',
    note: '浮窗 rect 容差 2px',
  })
  results.assert('g1.final.expanded.false', settled.expanded === false, { actual: settled.expanded, expected: false })
  results.assert('g1.final.float.count', settled.dom.floatCount === 1, { actual: settled.dom.floatCount, expected: 1 })

  await results.shot(page, 'g1-float-1440.png')
  results.captureErrors(handles)
  results.step('page.errors', { pageErrors: handles.pageErrors.slice(0, 8), consoleErrors: handles.consoleErrors.slice(0, 8) })

  /* ---------------- 对照组：官方 openResource 直通（应 push） ---------------- */
  const control = await openApp({ viewport: VIEWPORT })
  try {
    const cp = control.page
    await enterStage(cp, { count: 3 })
    const cLayout = await stageLayout(cp)
    const cMounted = await mountedSessionId(cp)
    const cAddress = fileAddress(cMounted, 'package.json')
    const cBefore = await domState(cp)
    const rawOpen = await p3Call(cp, 'openResource', cAddress)
    await sleep(1000)
    const cAfter = await domState(cp)
    const focusShrink = cBefore.focus && cAfter.focus ? round2(cBefore.focus.w - cAfter.focus.w) : null
    const stageShrink = cBefore.stage && cAfter.stage ? round2(cBefore.stage.w - cAfter.stage.w) : null
    results.step('control.openResource', { address: cAddress, result: rawOpen })
    results.metric('control', {
      focusBefore: cBefore.focus,
      focusAfter: cAfter.focus,
      stageBefore: cBefore.stage,
      stageAfter: cAfter.stage,
      focusShrink,
      stageShrink,
      expandedAfter: cAfter.expanded,
      openPanelCountAfter: cAfter.dom.openPanelCount,
      panel: cAfter.panels.filter((panel) => panel.panel),
      baselineExpanded: cBefore.expanded,
    })
    results.assert('control.push.measured', !!cAfter.expanded && focusShrink !== null && Math.abs(focusShrink) > 10, {
      actual: { expandedAfter: cAfter.expanded, focusShrink, stageShrink },
      expected: { expandedAfter: true, focusShrink: '>10px' },
      category: 'G1-control',
      note: '证明「官方展开 push 会改变 stage/focus 几何」，因此 G1 的 0px 稳定断言有判别力',
    })
    results.assert('control.baseline.collapsed', cBefore.expanded === false, { actual: cBefore.expanded, expected: false })
    await results.shot(cp, 'g1-control-push-1440.png')
    await sleep(100)
  } finally {
    await closeApp(control)
  }
} catch (error) {
  results.fatal(error)
} finally {
  await closeApp(app)
}
const data = results.finish()
log('[g1] summary ' + JSON.stringify(data.summary))
process.exit(data.ok ? 0 : 1)
