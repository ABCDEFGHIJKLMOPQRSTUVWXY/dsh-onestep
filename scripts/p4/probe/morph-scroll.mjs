/**
 * P4-1 探针③b：长对话滚动后的快照成本（docs/p4-plan.md §4.10 #3「含长对话、已滚动」）
 *
 * 独立页面（fresh）：
 * 1) 顶部对照：焦点窗未滚动时 2 次 morph（ready/帧率/长任务）；
 * 2) 滚到中部（真实长对话 scrollTop=scrollHeight/2）后 3 次 morph；
 * 3) 滚到底部后 3 次 morph；
 * 记录每次 ready、callback、VT 开销、干净帧/原始帧 P95、长任务，截图证据。
 *
 * 用法：node scripts/p4/probe/morph-scroll.mjs
 * 产物：artifacts/p4/probe/morph-scroll.json + artifacts/p4/probe/shots/morph-scroll-*.png
 */
import path from 'node:path'

import {
  OUT, createResults, sleep, openApp, closeApp, enterStage, pageEnv, installRuntime,
  shot, relPath, analyzeFrameIntervals, stats, slotGridSignature, layoutDeviation, decodePng, imageStats, loadShot,
} from './lib.mjs'

const results = createResults('morph-scroll', 'P4-1 探针③b：长对话滚动后的快照成本')
let app = null

function analyzeRun(record, sampling) {
  const longtasks = (sampling && sampling.longtasks) || []
  const finishedAt = record.finishedAt || (record.startedMs + (record.finishedMs || 0))
  const during = longtasks.filter((entry) => entry.start >= record.startedMs - 2 && entry.start <= finishedAt + 2)
  const callbackStart = record.callbackStartMs
  const callbackEnd = record.callbackEndMs
  const callbackPhase = during.filter((entry) => callbackStart !== null && callbackEnd !== null && entry.start < callbackEnd && entry.start + entry.duration > callbackStart)
  const animationPhase = during.filter((entry) => !callbackPhase.includes(entry))
  const frames = ((sampling && sampling.frames) || []).filter((timestamp) => timestamp >= record.startedMs - 4 && timestamp <= finishedAt + 4)
  const intervals = []
  for (let index = 1; index < frames.length; index += 1) intervals.push({ prev: frames[index - 1], cur: frames[index], delta: frames[index] - frames[index - 1] })
  const callbackGap = intervals.filter((item) => callbackEnd !== null && item.cur >= callbackStart && item.prev <= callbackEnd)
  const animationIntervals = intervals.filter((item) => !callbackGap.includes(item))
  const busy = animationIntervals.filter((item) => animationPhase.some((entry) => item.cur >= entry.start && item.prev <= entry.start + entry.duration))
  const clean = animationIntervals.filter((item) => !busy.includes(item))
  return {
    frameCount: frames.length,
    cleanIntervals: clean.map((item) => Math.round(item.delta * 10) / 10),
    rawIntervals: animationIntervals.map((item) => Math.round(item.delta * 10) / 10),
    cleanStats: stats(clean.map((item) => item.delta)),
    rawStats: stats(animationIntervals.map((item) => item.delta)),
    longtasksTotal: during.length,
    longtasksCallback: callbackPhase.length,
    longtasksAnimation: animationPhase.length,
    longtasksAnimationMax: animationPhase.length ? Math.max(...animationPhase.map((item) => item.duration)) : 0,
    readyOverheadMs: typeof record.readyMs === 'number' && typeof record.callbackEndMs === 'number' ? Math.round((record.readyMs - (record.callbackEndMs - record.startedMs)) * 100) / 100 : null,
    animationsAfterPseudo: (record.animationsAfterFinal || record.animationsAfter || []).filter((item) => item.pseudoElement).length,
  }
}

/** 一次 morph（带采样 + 可选先滚动）。 */
async function scrollMorph(page, label, where) {
  const prep = await page.evaluate(async (position) => {
    const R = window.__P4
    R.applyWindowNames()
    const scroll = position ? R.scrollFocus(position) : null
    await R.sleep(48)
    const before = R.geometry()
    const target = (before.snapshot.candidates || [])[0] || null
    const row = target ? ((R.snapshot().rowsSample || {})[target] || null) : null
    return { scroll, before, target, targetTitle: row ? String(row.title || '').slice(0, 60) : null }
  }, where || null)
  if (!prep.target) return { label, error: 'no-candidate', prep }
  const run = await page.evaluate(async ({ target, tag }) => {
    const R = window.__P4
    R.startSampling(tag)
    R.beginMorph(target, { includeKeyframes: false, macroTasks: 2, label: tag })
    const ready = await R.waitReady(5000)
    const readyGeometry = R.geometry()
    const record = await R.waitMorph(8000)
    const sampling = R.stopSampling()
    R.applyWindowNames()
    await R.sleep(16)
    const after = R.geometry()
    return { label: tag, target, ready, readyGeometry, after, sampling, record: { targetId: record.targetId, readyMs: record.readyMs, readyError: record.readyError, finishedMs: record.finishedMs, finishedError: record.finishedError, callbackDurationMs: record.callbackDurationMs, callbackStartMs: record.callbackStartMs, callbackEndMs: record.callbackEndMs, startedMs: record.startedMs, finishedAt: record.finishedAt, focusSignalMs: record.focusSignalMs, domCommittedMs: record.domCommittedMs, animationsAfterPseudo: (record.animationsAfterFinal || record.animationsAfter || []).filter((item) => item.pseudoElement).length, activeVtAfter: record.activeVtAfter } }
  }, { target: prep.target, tag: label })
  return Object.assign({}, prep, run, { analysis: analyzeRun(run.record, run.sampling) })
}

try {
  results.data.env.command = 'node scripts/p4/probe/morph-scroll.mjs'
  app = await openApp({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
  const { page } = app
  const env = await pageEnv(page)
  results.data.env.page = env
  await enterStage(page, { count: 3 })
  await installRuntime(page)
  await page.evaluate(async () => { const R = window.__P4; R.installVtStyle({}); R.applyWindowNames(); await R.sleep(40) })
  const baselineGrid = await page.evaluate(async () => { const R = window.__P4; await R.sleep(24); return { geometry: R.geometry(), grid: null } })
  const grid = slotGridSignature(baselineGrid.geometry)
  results.data.baseline = { grid }
  results.step('scroll.baseline', { grid, focus: baselineGrid.geometry.snapshot.focusId })

  // 1) 顶部对照（未滚动）
  const topRuns = []
  for (let index = 0; index < 2; index += 1) {
    topRuns.push(await scrollMorph(page, 'top-' + index, null))
    await sleep(120)
  }

  // 2) 滚到中部
  const middleRuns = []
  for (let index = 0; index < 3; index += 1) {
    middleRuns.push(await scrollMorph(page, 'middle-' + index, 'middle'))
    await sleep(120)
  }
  await shot(page, results, 'morph-scroll-middle.png')

  // 3) 滚到底部
  const bottomRuns = []
  for (let index = 0; index < 3; index += 1) {
    bottomRuns.push(await scrollMorph(page, 'bottom-' + index, 'bottom'))
    await sleep(120)
  }
  await shot(page, results, 'morph-scroll-bottom.png')

  const summarize = (run) => ({
    label: run.label,
    where: run.scroll ? run.scroll.where : 'top',
    targetTitle: run.targetTitle,
    scroll: run.scroll ? { ok: run.scroll.ok, scrollTop: run.scroll.scrollTop, max: run.scroll.max, scrollHeight: run.scroll.scrollHeight, clientHeight: run.scroll.clientHeight, cls: run.scroll.cls } : null,
    readyMs: run.record.readyMs,
    finishedMs: run.record.finishedMs,
    callbackDurationMs: run.record.callbackDurationMs,
    focusSignalMs: run.record.focusSignalMs,
    readyOverheadMs: run.analysis.readyOverheadMs,
    frameP95Clean: run.analysis.cleanStats.p95,
    frameP95Raw: run.analysis.rawStats.p95,
    frameMaxClean: run.analysis.cleanStats.max,
    longtasksTotal: run.analysis.longtasksTotal,
    longtasksCallback: run.analysis.longtasksCallback,
    longtasksAnimation: run.analysis.longtasksAnimation,
    longtasksAnimationMax: run.analysis.longtasksAnimationMax,
    animationsAfterPseudo: run.record.animationsAfterPseudo,
    finishedError: run.record.finishedError,
  })
  const summarized = { top: topRuns.map(summarize), middle: middleRuns.map(summarize), bottom: bottomRuns.map(summarize) }
  const allRuns = topRuns.concat(middleRuns, bottomRuns)
  const scrolled = middleRuns.concat(bottomRuns)
  const metrics = {
    runs: summarized,
    topReady: stats(topRuns.map((run) => run.record.readyMs)),
    middleReady: stats(middleRuns.map((run) => run.record.readyMs)),
    bottomReady: stats(bottomRuns.map((run) => run.record.readyMs)),
    scrolledReady: stats(scrolled.map((run) => run.record.readyMs)),
    scrolledReadyP95: stats(scrolled.map((run) => run.record.readyMs)).p95,
    topFrameCleanP95: stats(topRuns.map((run) => run.analysis.cleanStats.p95)),
    scrolledFrameCleanP95: stats(scrolled.map((run) => run.analysis.cleanStats.p95)),
    scrolledFrameRawP95: stats(scrolled.map((run) => run.analysis.rawStats.p95)),
    scrolledLongtasksAnimation: scrolled.reduce((sum, run) => sum + run.analysis.longtasksAnimation, 0),
    scrolledLongtasksCallback: scrolled.reduce((sum, run) => sum + run.analysis.longtasksCallback, 0),
    scrollEvidence: middleRuns.concat(bottomRuns).map((run) => run.scroll).filter(Boolean),
  }
  results.data.scroll = metrics
  results.data.topRuns = topRuns.map(summarize)
  results.data.middleRuns = middleRuns.map(summarize)
  results.data.bottomRuns = bottomRuns.map(summarize)
  results.step('scroll.runs', summarized)
  results.step('scroll.metrics', metrics)
  results.metric('scroll', metrics)

  const realLongConversation = (metrics.scrollEvidence || []).some((item) => item.ok && item.scrollHeight > item.clientHeight + 200)
  results.assert('scroll.long-conversation', realLongConversation, {
    expected: '焦点窗内存在真实长对话（scrollHeight 比 clientHeight 大 200px 以上）并已滚动到中部/底部',
    actual: { evidence: metrics.scrollEvidence, middleReady: metrics.middleReady, bottomReady: metrics.bottomReady },
    category: 'scroll',
  })
  results.assert('scroll.ready-budget', metrics.scrolledReadyP95 !== null && metrics.scrolledReadyP95 <= 80, {
    expected: '【计划 §4.10 #3】长对话滚动后 ready P95 ≤ 80ms',
    actual: { scrolledReady: metrics.scrolledReady, topReady: metrics.topReady, middleReady: metrics.middleReady, bottomReady: metrics.bottomReady },
    category: 'budget',
  })
  results.assert('scroll.longtask-budget', metrics.scrolledLongtasksAnimation === 0, {
    expected: '【计划 §4.10 #3】滚动后 morph 动画阶段 0 个 >50ms 长任务',
    actual: { longtasksAnimation: metrics.scrolledLongtasksAnimation, longtasksCallback: metrics.scrolledLongtasksCallback, runs: summarized.middle.concat(summarized.bottom).map((item) => ({ label: item.label, ltA: item.longtasksAnimation, max: item.longtasksAnimationMax })) },
    category: 'budget',
  })
  results.assert('scroll.frame-budget', stats(scrolled.map((run) => run.analysis.cleanStats.p95)).p95 !== null && stats(scrolled.map((run) => run.analysis.cleanStats.p95)).p95 <= 18, {
    expected: '滚动后 morph 干净帧 rAF P95 ≤ 18ms',
    actual: { scrolledFrameCleanP95: metrics.scrolledFrameCleanP95, topFrameCleanP95: metrics.topFrameCleanP95 },
    category: 'budget',
  })
  results.assert('scroll.focus-ok', allRuns.every((run) => run.after.snapshot.focusId === run.target), {
    expected: '每次滚动后 morph 的 focusId = 目标',
    actual: allRuns.map((run) => ({ label: run.label, focusId: run.after.snapshot.focusId, target: run.target })),
    category: 'scroll',
  })
  results.assert('scroll.no-residual', allRuns.every((run) => run.record.animationsAfterPseudo === 0 && !run.record.finishedError), {
    expected: '滚动后 morph 结束无残留伪元素动画、无 VT 错误',
    actual: allRuns.map((run) => ({ label: run.label, animationsAfterPseudo: run.record.animationsAfterPseudo, finishedError: run.record.finishedError })),
    category: 'cleanup',
  })
  const png = decodePng(loadShot('morph-scroll-middle.png'))
  results.data.scrollShots = { middle: imageStats(png) }
  results.step('scroll.shots', results.data.scrollShots)
  results.data.env.pageErrors = app.handles.pageErrors.slice(0, 10)
  results.assert('scroll.no-pageerror', app.handles.pageErrors.length === 0, {
    expected: '长对话滚动探针无 pageerror',
    actual: { pageErrors: app.handles.pageErrors.slice(0, 10) },
    category: 'env',
  })

  // 清理
  await page.evaluate(() => window.__P4.cleanup())
  const finalState = await page.evaluate(() => ({ pseudoLeft: window.__P4.vtAnimations().length, activeViewTransition: !!document.activeViewTransition, tempStyles: document.querySelectorAll('[data-p4-vt-style]').length }))
  results.step('cleanup', finalState)
  results.assert('scroll.cleanup', finalState.pseudoLeft === 0 && finalState.activeViewTransition === false && finalState.tempStyles === 0, {
    expected: '滚动探针结束无残留',
    actual: finalState,
    category: 'cleanup',
  })
} catch (error) {
  results.fatal(error)
} finally {
  try { await closeApp(app) } catch (_error) { /* ignore */ }
  const data = results.finish()
  console.log('[morph-scroll] ok=' + data.ok + ' summary=' + JSON.stringify(data.summary))
  if (data.metrics.scroll) console.log('[morph-scroll] metrics=' + JSON.stringify({ topReady: data.metrics.scroll.topReady, middleReady: data.metrics.scroll.middleReady, bottomReady: data.metrics.scroll.bottomReady, scrolledReady: data.metrics.scroll.scrolledReady, scrolledFrameCleanP95: data.metrics.scroll.scrolledFrameCleanP95 }))
  console.log('[morph-scroll] json=' + relPath(path.join(OUT, 'morph-scroll.json')))
}
process.exitCode = results.data.ok ? 0 : 1
