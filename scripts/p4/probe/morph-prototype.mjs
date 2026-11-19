/**
 * P4-1 探针②③④⑤⑥：真实舞台 View Transitions morph 原型（docs/p4-plan.md §4.2/§4.3/§4.4/§4.10 #2-#6）
 *
 * 做法（不改产品源码、不重建 client.js）：
 * 1) 页面内给 4 个窗口注入 --onestep-vt-name=onestep-w-<sanitized sessionId>
 *    （用 data-onestep-window-session 取 id；CSS 规则临时注入：.onestep-frame{view-transition-name:var(--onestep-vt-name,none)}）；
 * 2) 注入 ::view-transition-group/* 时长曲线（220ms；old 120ms；new 120ms+delay 60ms）；
 * 3) document.startViewTransition(async () => { actions.promote(id); 宏任务轮询 focusId+DOM 提交（上限 150ms）；
 *    在回调内按新 DOM 重新注入名称（模拟产品 render 期命名）；再等 2 个宏任务 });
 * 4) 量 ready/finished/callback 分相、伪元素动画时长、rAF 帧间隔（callback 空档单列）、longtask；
 * 5) ready 后暂停全部伪元素动画 → currentTime 0/110/220 → 截图（1440/1280 亮色主题）→ resume；
 * 6) 结束状态几何 = actions.layout()（偏差 0）、名称配对（组 keyframes 起止 = 角色互换前后 rect）；
 * 7) 快速连切 5 次（VT 进行中 → skipTransition + 立即应用）；长对话滚动后快照成本；无 VT 基线对照。
 *
 * 用法：node scripts/p4/probe/morph-prototype.mjs
 * 产物：artifacts/p4/probe/morph-prototype.json + artifacts/p4/probe/shots/morph-*.png
 */
import path from 'node:path'

import {
  OUT, createResults, sleep, openApp, closeApp, enterStage, pageEnv, installRuntime,
  capture, shot, relPath, analyzeFrameIntervals, stats, layoutDeviation, slotGridSignature,
  loadShot, decodePng, regionDiff, imageStats, vtAnimationBreakdown,
} from './lib.mjs'

const results = createResults('morph-prototype', 'P4-1 探针②③④⑤⑥：真实舞台 VT morph 原型')

/** 解析 matrix(a,b,c,d,e,f)。 */
function parseMatrix(transform) {
  const match = /matrix\(([^)]+)\)/.exec(String(transform || ''))
  if (!match) return null
  const parts = match[1].split(',').map((value) => Number(value.trim()))
  if (parts.length !== 6) return null
  return { a: parts[0], b: parts[1], c: parts[2], d: parts[3], e: parts[4], f: parts[5] }
}

/** 解码 group 伪元素动画 keyframes（Chromium：transform translate + width/height 表达位置尺寸）。 */
function decodeGroupAnimations(animations) {
  const groups = {}
  for (const animation of animations || []) {
    if (!animation.pseudoElement) continue
    const match = /^::view-transition-group\((.+)\)$/.exec(animation.pseudoElement)
    if (!match) continue
    const keyframes = animation.keyframes || []
    if (keyframes.length < 2) {
      groups[match[1]] = { name: match[1], incomplete: true, keyframeCount: keyframes.length }
      continue
    }
    const read = (keyframe) => {
      const matrix = parseMatrix(keyframe.transform)
      return {
        x: matrix ? Math.round(matrix.e * 100) / 100 : null,
        y: matrix ? Math.round(matrix.f * 100) / 100 : null,
        w: Number.parseFloat(keyframe.width),
        h: Number.parseFloat(keyframe.height),
        easing: keyframe.easing || null,
        opacity: keyframe.opacity === undefined ? null : Number(keyframe.opacity),
      }
    }
    const start = read(keyframes[0])
    const end = read(keyframes[keyframes.length - 1])
    groups[match[1]] = {
      name: match[1],
      start,
      end,
      duration: animation.duration,
      delay: animation.delay,
      keyframeCount: keyframes.length,
    }
  }
  return groups
}

function rectMatches(rect, start, tolerance = 1.5) {
  if (!rect || !start) return false
  return Math.abs(rect.x - start.x) <= tolerance && Math.abs(rect.y - start.y) <= tolerance &&
    Math.abs(rect.w - start.w) <= tolerance && Math.abs(rect.h - start.h) <= tolerance
}

function sessionRects(geometry) {
  const map = {}
  if (!geometry) return map
  if (geometry.focus) map[geometry.focus.sessionId] = { mode: 'focus', rect: geometry.focus.rect }
  for (const candidate of geometry.candidates || []) map[candidate.sessionId] = { mode: 'candidate', rect: candidate.rect }
  return map
}

/** 页面内：重新注入名称并返回稳定状态。 */
async function prepareNames(page) {
  return page.evaluate(async () => {
    const R = window.__P4
    R.installVtStyle({ ms: 220, fade: 120, delay: 60 })
    const applied = R.applyWindowNames()
    await R.sleep(32)
    return { applied, entries: R.windowEntries(), geometry: R.geometry(), pseudoBefore: R.vtAnimations().length }
  })
}

/** 关键帧 morph：ready → 暂停/seek 0/110/220（每步截图）→ resume → finished。 */
async function keyframeMorph(page, prefix, options = {}) {
  const prep = await page.evaluate(async () => {
    const R = window.__P4
    R.applyWindowNames()
    await R.sleep(32)
    const before = R.geometry()
    return { before, target: (before.snapshot.candidates || [])[0] || null }
  })
  if (!prep.target) throw new Error('keyframeMorph: 没有候场候选可提升')
  const readyInfo = await page.evaluate(async ({ target, label }) => {
    const R = window.__P4
    const record = R.beginMorph(target, { includeKeyframes: true, macroTasks: 2, label })
    const ready = await R.waitReady(4000)
    await R.sleep(16)
    const geometry = R.geometry()
    const focusEl = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
    const contentEl = focusEl ? focusEl.querySelector('[data-conversation-content]') : null
    return {
      ready,
      pseudo: R.vtAnimationNames(),
      geometry,
      focusContentPresent: !!contentEl,
      focusContentRect: contentEl ? R.rectOf(contentEl) : null,
      animationsAtReady: record.animationsAtReady,
      record: {
        targetId: record.targetId, readyMs: record.readyMs, readyError: record.readyError,
        callbackDurationMs: record.callbackDurationMs, callbackStartMs: record.callbackStartMs,
        callbackEndMs: record.callbackEndMs, focusPoll: record.focusPoll, domPoll: record.domPoll,
        focusSignalMs: record.focusSignalMs, domCommittedMs: record.domCommittedMs,
        namesInCallback: record.namesInCallback,
      },
    }
  }, { target: prep.target, label: prefix })

  const controlFrames = []
  for (const time of [0, 110, 220]) {
    if (time === 0) controlFrames.push(await page.evaluate(() => window.__P4.pauseAt(0)))
    else controlFrames.push(await page.evaluate((seekTo) => window.__P4.seek(seekTo), time))
    await page.evaluate(() => window.__P4.forceFrames(2))
    controlFrames[controlFrames.length - 1].shot = await shot(page, results, prefix + '-t' + String(time).padStart(3, '0') + '.png')
  }
  const post = await page.evaluate(async () => {
    const R = window.__P4
    R.resume()
    const record = await R.waitMorph(6000)
    R.applyWindowNames()
    await R.sleep(20)
    return {
      record: {
        finishedMs: record.finishedMs, finishedError: record.finishedError,
        animationsAfterPseudo: (record.animationsAfterFinal || record.animationsAfter || []).filter((item) => item.pseudoElement).length,
        activeVtAfter: record.activeVtAfter, activeVtFinal: record.activeVtFinal,
      },
      geometry: R.geometry(),
      pseudoAfter: R.vtAnimations().length,
      names: R.windowEntries(),
    }
  })
  const postShot = await shot(page, results, prefix + '-post.png')
  return Object.assign({ prefix, target: prep.target }, prep, readyInfo, { controlFrames, post, postShot })
}

/** 性能 morph（带 rAF/longtask 采样）：返回 record + sampling + 前后几何。 */
async function perfMorph(page, label) {
  return page.evaluate(async (tag) => {
    const R = window.__P4
    R.applyWindowNames()
    await R.sleep(24)
    const before = R.geometry()
    const target = (before.snapshot.candidates || [])[0] || null
    if (!target) return { error: 'no-candidate', label: tag, before }
    const rowSample = (R.snapshot().rowsSample || {})[target] || null
    const targetTitle = rowSample ? String(rowSample.title || '').slice(0, 60) : null
    R.startSampling(tag)
    R.beginMorph(target, { includeKeyframes: false, macroTasks: 2, label: tag })
    const ready = await R.waitReady(4000)
    const readyGeometry = R.geometry()
    const record = await R.waitMorph(6000)
    const sampling = R.stopSampling()
    R.applyWindowNames()
    await R.sleep(16)
    const after = R.geometry()
    return {
      label: tag,
      target,
      targetTitle,
      ready,
      readyGeometry,
      before,
      after,
      sampling,
      record: {
        targetId: record.targetId, readyMs: record.readyMs, readyError: record.readyError,
        startedMs: record.startedMs, finishedAt: record.finishedAt,
        finishedMs: record.finishedMs, finishedError: record.finishedError,
        callbackDurationMs: record.callbackDurationMs, callbackStartMs: record.callbackStartMs,
        callbackEndMs: record.callbackEndMs, focusPoll: record.focusPoll, domPoll: record.domPoll,
        focusSignalMs: record.focusSignalMs, domCommittedMs: record.domCommittedMs,
        namesInCallback: record.namesInCallback,
        animationsAtReady: (record.animationsAtReady || []).map((item) => ({ pseudoElement: item.pseudoElement, duration: item.duration, delay: item.delay })),
        animationsAfterPseudo: (record.animationsAfterFinal || record.animationsAfter || []).filter((item) => item.pseudoElement).length,
        activeVtAtReady: record.activeVtAtReady, activeVtAfter: record.activeVtAfter,
      },
    }
  }, label)
}

/** 无 VT 基线：官方 promote 的提交延迟（用于把 ready 拆成「官方提交」+「VT 开销」）。 */
async function baselinePromote(page, label) {
  return page.evaluate(async (tag) => {
    const R = window.__P4
    const before = R.geometry()
    const target = (before.snapshot.candidates || [])[0] || null
    if (!target) return { error: 'no-candidate', label: tag }
    R.startSampling(tag)
    const started = performance.now()
    let actionReturn = null
    let actionError = null
    try { actionReturn = window.__ONESTEP__.actions.promote(target) } catch (error) { actionError = String(error) }
    const focusPoll = await R.pollUntil(() => {
      const snapshot = R.snapshot()
      return snapshot && snapshot.focusId === target
    }, 500)
    const focusMs = performance.now() - started
    const domPoll = await R.pollUntil(() => {
      const focusEl = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
      return !!focusEl && focusEl.getAttribute('data-onestep-window-session') === target
    }, 400)
    const domMs = performance.now() - started
    await R.sleep(16)
    const sampling = R.stopSampling()
    R.applyWindowNames()
    const after = R.geometry()
    return { label: tag, target, actionReturn, actionError, focusPoll, focusMs: R.round(focusMs), domPoll, domMs: R.round(domMs), sampling, before, after }
  }, label)
}

/** 空回调 VT：只量 VT 快照/ready/finished 固定开销（无状态变化）。 */
async function noopTransition(page, label) {
  return page.evaluate(async (tag) => {
    const R = window.__P4
    R.startSampling(tag)
    const record = R.beginMorph(null, { noop: true, label: tag })
    const ready = await R.waitReady(4000)
    const done = await R.waitMorph(4000)
    const sampling = R.stopSampling()
    return {
      label: tag, ready,
      record: {
        readyMs: done.readyMs, finishedMs: done.finishedMs, readyError: done.readyError,
        finishedError: done.finishedError, callbackDurationMs: done.callbackDurationMs,
        animationsAtReady: (done.animationsAtReady || []).map((item) => ({ pseudoElement: item.pseudoElement, duration: item.duration, delay: item.delay })),
      },
      sampling,
    }
  }, label)
}

/** 长任务分类 + rAF 间隔分相：callback 空档 / 动画阶段（干净帧 vs 主线程长任务阻塞帧）。 */
function analyzeMorphSampling(record, sampling) {
  const longtasks = (sampling && sampling.longtasks) || []
  const finishedAt = record.finishedAt || (record.startedMs + (record.finishedMs || 0))
  const during = longtasks.filter((entry) => entry.start >= record.startedMs - 2 && entry.start <= finishedAt + 2)
  const callbackStart = record.callbackStartMs
  const callbackEnd = record.callbackEndMs
  const callbackPhase = during.filter((entry) => callbackStart !== null && callbackEnd !== null && entry.start < callbackEnd && entry.start + entry.duration > callbackStart)
  const animationPhase = during.filter((entry) => !callbackPhase.includes(entry))
  const frames = ((sampling && sampling.frames) || []).filter((timestamp) => timestamp >= record.startedMs - 4 && timestamp <= finishedAt + 4)
  const intervals = []
  for (let index = 1; index < frames.length; index += 1) {
    intervals.push({ prev: frames[index - 1], cur: frames[index], delta: frames[index] - frames[index - 1] })
  }
  const callbackGap = intervals.filter((item) => callbackEnd !== null && item.cur >= callbackStart && item.prev <= callbackEnd)
  const animationIntervals = intervals.filter((item) => !callbackGap.includes(item))
  const busyIntervals = animationIntervals.filter((item) => animationPhase.some((entry) => item.cur >= entry.start && item.prev <= entry.start + entry.duration))
  const cleanIntervals = animationIntervals.filter((item) => !busyIntervals.includes(item))
  const clean = stats(cleanIntervals.map((item) => item.delta))
  const raw = stats(animationIntervals.map((item) => item.delta))
  return {
    longtasks: during,
    callbackPhase,
    animationPhase,
    frameCount: frames.length,
    callbackGapIntervals: callbackGap.map((item) => Math.round(item.delta * 10) / 10),
    rawIntervals: animationIntervals.map((item) => Math.round(item.delta * 10) / 10),
    busyIntervals: busyIntervals.map((item) => Math.round(item.delta * 10) / 10),
    cleanIntervals: cleanIntervals.map((item) => Math.round(item.delta * 10) / 10),
    cleanStats: clean,
    rawStats: raw,
    rawOver50: animationIntervals.filter((item) => item.delta > 50).length,
    cleanOver50: cleanIntervals.filter((item) => item.delta > 50).length,
  }
}

function summarizeMorphPerf(entry) {
  const record = entry.record
  const analysis = analyzeMorphSampling(record, entry.sampling)
  return {
    label: entry.label,
    target: entry.target,
    targetTitle: entry.targetTitle || null,
    readyMs: record.readyMs,
    finishedMs: record.finishedMs,
    callbackDurationMs: record.callbackDurationMs,
    focusSignalMs: record.focusSignalMs,
    domCommittedMs: record.domCommittedMs,
    readyOverheadMs: typeof record.readyMs === 'number' && typeof record.callbackEndMs === 'number' ? Math.round((record.readyMs - (record.callbackEndMs - record.startedMs)) * 100) / 100 : null,
    frameCount: analysis.frameCount,
    frameIntervals: analysis.cleanIntervals,
    rawFrameIntervals: analysis.rawIntervals,
    busyFrameIntervals: analysis.busyIntervals,
    callbackGapIntervals: analysis.callbackGapIntervals,
    frameP95Clean: analysis.cleanStats.p95,
    frameP95Raw: analysis.rawStats.p95,
    frameMaxClean: analysis.cleanStats.max,
    frameMaxRaw: analysis.rawStats.max,
    frameOver50Clean: analysis.cleanOver50,
    frameOver50Raw: analysis.rawOver50,
    longtasks: {
      total: analysis.longtasks.length,
      callbackPhase: analysis.callbackPhase.length,
      animationPhase: analysis.animationPhase.length,
      animationPhaseMaxDuration: analysis.animationPhase.length ? Math.max(...analysis.animationPhase.map((item) => item.duration)) : 0,
      callbackPhaseMaxDuration: analysis.callbackPhase.length ? Math.max(...analysis.callbackPhase.map((item) => item.duration)) : 0,
      animationPhaseEntries: analysis.animationPhase,
      callbackPhaseEntries: analysis.callbackPhase,
    },
    animationsAfterPseudo: record.animationsAfterPseudo,
    activeVtAfter: record.activeVtAfter,
    readyError: record.readyError,
    finishedError: record.finishedError,
    durationsAtReady: [...new Set((record.animationsAtReady || []).filter((item) => item.pseudoElement).map((item) => item.duration))],
  }
}

/** ready 分解 + 预算表：把「官方提交（非动效可控）」与「VT 快照/捕获开销」分开。 */
function budgetTable(perfEntries, baselineSummary, noopSummary) {
  const ready = perfEntries.map((entry) => entry.readyMs).filter((value) => typeof value === 'number')
  const commit = perfEntries.map((entry) => entry.domCommittedMs).filter((value) => typeof value === 'number')
  const overhead = perfEntries.map((entry) => entry.readyOverheadMs).filter((value) => typeof value === 'number')
  const cleanP95 = perfEntries.map((entry) => entry.frameP95Clean).filter((value) => typeof value === 'number')
  const rawP95 = perfEntries.map((entry) => entry.frameP95Raw).filter((value) => typeof value === 'number')
  const longtasksAnimation = perfEntries.reduce((sum, entry) => sum + (entry.longtasks ? entry.longtasks.animationPhase : 0), 0)
  const longtasksCallback = perfEntries.reduce((sum, entry) => sum + (entry.longtasks ? entry.longtasks.callbackPhase : 0), 0)
  const baselineMax = baselineSummary && baselineSummary.maxLongtaskMs ? baselineSummary.maxLongtaskMs : null
  const animationMax = perfEntries.reduce((max, entry) => Math.max(max, entry.longtasks ? entry.longtasks.animationPhaseMaxDuration : 0), 0)
  return {
    samples: perfEntries.length,
    ready: stats(ready),
    readyP95: stats(ready).p95,
    commitInsideCallback: stats(commit),
    readyOverhead: stats(overhead),
    readyOverheadP95: stats(overhead).p95,
    frameCleanP95: stats(cleanP95),
    frameRawP95: stats(rawP95),
    longtaskAnimationPhase: longtasksAnimation,
    longtaskCallbackPhase: longtasksCallback,
    longtaskAnimationPhaseMax: animationMax,
    baselineLongtaskMax: baselineMax,
    noopVtLongtasks: noopSummary ? noopSummary.longtaskCount : null,
    budget: {
      readyP95Ok: stats(ready).p95 !== null && stats(ready).p95 <= 80,
      readyOverheadOk: stats(overhead).p95 !== null && stats(overhead).p95 <= 30,
      frameCleanP95Ok: stats(cleanP95).p95 !== null && stats(cleanP95).p95 <= 18,
      longtaskOk: (noopSummary ? noopSummary.longtaskCount === 0 : true) && (baselineMax === null || animationMax <= baselineMax),
      readyP95WithCommitAdjusted: stats(ready).p95 !== null && stats(ready).p95 <= (baselineSummary && baselineSummary.p95 ? baselineSummary.p95 : 0) + 40,
    },
  }
}

let app = null
try {
  results.data.env.command = 'node scripts/p4/probe/morph-prototype.mjs'
  app = await openApp({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
  const { page } = app
  const env = await pageEnv(page)
  results.data.env.page = env
  results.step('env.page', env)
  results.assert('env.light', env.colorScheme === 'light' && env.dpr === 1, {
    expected: '亮色主题 + DPR 1（关键帧截图可比对）',
    actual: { colorScheme: env.colorScheme, dpr: env.dpr },
    category: 'env',
  })

  await enterStage(page, { count: 3 })
  const install = await installRuntime(page)
  results.step('runtime.install', install)
  const setup = await prepareNames(page)
  results.step('stage.setup', {
    names: setup.applied.names,
    duplicates: setup.applied.duplicates,
    entries: setup.entries,
    geometry: setup.geometry,
  })
  const baselineGrid = slotGridSignature(setup.geometry)
  results.data.baseline = {
    grid: baselineGrid,
    focusSession: setup.geometry.snapshot.focusId,
    candidates: setup.geometry.snapshot.candidates,
    layout: setup.geometry.layout,
  }
  results.metric('baseline.grid', baselineGrid)
  const namesOk = Object.keys(setup.applied.names).length === 4 && setup.applied.duplicates.length === 0 &&
    setup.entries.every((entry) => entry.sessionId && entry.vtName === 'onestep-w-' + entry.sessionId.replace(/[^A-Za-z0-9_-]/g, '_'))
  results.assert('names.unique-and-computed', namesOk, {
    expected: '4 个窗口名称唯一；computed viewTransitionName = onestep-w-<sanitized sessionId>',
    actual: { names: setup.applied.names, duplicates: setup.applied.duplicates, entries: setup.entries.map((entry) => ({ sessionId: entry.sessionId, vtName: entry.vtName })) },
    category: 'naming',
  })

  // ---------- ③ 性能 morph（1440，4 窗）——本套件最先测量，避免多次过渡后的累计漂移污染 ----------
  // 热身：1 次不计入样本（首次 VT 有 JIT/资源初始化成本）
  const warmup = await perfMorph(page, 'perf-warmup')
  await sleep(120)
  results.step('perf.1440.warmup', { readyMs: warmup.record && warmup.record.readyMs, targetTitle: warmup.targetTitle, callbackDurationMs: warmup.record && warmup.record.callbackDurationMs })

  // 无 VT 基线：官方 promote 的提交延迟（ready 的主要组成，动效不可控）
  const baselineRuns = []
  for (let round = 0; round < 3; round += 1) {
    baselineRuns.push(await baselinePromote(page, 'baseline-' + round))
    await sleep(100)
  }
  const baselineStats = baselineRuns.map((run) => {
    const sampling = run.sampling || {}
    const longtasks = sampling.longtasks || []
    const frames = sampling.frames || []
    const intervals = []
    for (let index = 1; index < frames.length; index += 1) intervals.push({ prev: frames[index - 1], cur: frames[index], delta: frames[index] - frames[index - 1] })
    const busy = intervals.filter((item) => longtasks.some((entry) => item.cur >= entry.start && item.prev <= entry.start + entry.duration))
    const clean = intervals.filter((item) => !busy.includes(item))
    return {
      label: run.label,
      focusMs: run.focusMs,
      domMs: run.domMs,
      longtaskCount: longtasks.length,
      longtaskDurations: longtasks.map((entry) => entry.duration),
      longtaskMax: longtasks.length ? Math.max(...longtasks.map((entry) => entry.duration)) : 0,
      frameRawStats: stats(intervals.map((item) => item.delta)),
      frameCleanStats: stats(clean.map((item) => item.delta)),
    }
  })
  const baselineSummary = {
    focusMs: stats(baselineStats.map((item) => item.focusMs)),
    domMs: stats(baselineStats.map((item) => item.domMs)),
    p95: stats(baselineStats.map((item) => item.focusMs)).p95,
    longtaskCounts: baselineStats.map((item) => item.longtaskCount),
    longtaskDurations: baselineStats.map((item) => item.longtaskDurations),
    maxLongtaskMs: Math.max(0, ...baselineStats.map((item) => item.longtaskMax)),
    frameCleanP95: stats(baselineStats.map((item) => item.frameCleanStats.p95)),
    runs: baselineStats,
  }

  const perfRuns = []
  for (let round = 0; round < 8; round += 1) {
    perfRuns.push(await perfMorph(page, 'perf-1440-' + round))
    await sleep(120)
  }
  const perfEntries = perfRuns.map(summarizeMorphPerf)
  const readySeries = perfEntries.map((entry, index) => ({ index, targetTitle: entry.targetTitle, readyMs: entry.readyMs, commitMs: entry.domCommittedMs, readyOverheadMs: entry.readyOverheadMs, callbackDurationMs: entry.callbackDurationMs, frameP95Clean: entry.frameP95Clean, frameP95Raw: entry.frameP95Raw, longtasksAnimation: entry.longtasks.animationPhase, longtasksCallback: entry.longtasks.callbackPhase }))
  const half = Math.floor(perfEntries.length / 2)
  const readyValues = perfEntries.map((entry) => entry.readyMs).filter((value) => typeof value === 'number')
  const drift = {
    series: readySeries,
    firstHalf: stats(readyValues.slice(0, half)),
    secondHalf: stats(readyValues.slice(half)),
    ratio: stats(readyValues.slice(0, half)).mean ? Math.round((stats(readyValues.slice(half)).mean / stats(readyValues.slice(0, half)).mean) * 100) / 100 : null,
    note: '同一页面内连续 morph 的 ready 前后半段对比（≤1.5 视为稳定；累计漂移会在 P4-3/G9 复核）',
  }

  const noopRuns = []
  for (let round = 0; round < 2; round += 1) {
    noopRuns.push(await noopTransition(page, 'noop-' + round))
    await sleep(100)
  }
  const noopStats = noopRuns.map((run) => ({
    label: run.label,
    readyMs: run.record.readyMs,
    finishedMs: run.record.finishedMs,
    callbackDurationMs: run.record.callbackDurationMs,
    durations: [...new Set((run.record.animationsAtReady || []).map((item) => item.duration))],
    longtaskCount: ((run.sampling && run.sampling.longtasks) || []).length,
    longtaskDurations: ((run.sampling && run.sampling.longtasks) || []).map((entry) => entry.duration),
  }))
  const noopSummary = {
    ready: stats(noopStats.map((item) => item.readyMs)),
    finished: stats(noopStats.map((item) => item.finishedMs)),
    longtaskCount: noopStats.reduce((sum, item) => sum + item.longtaskCount, 0),
    runs: noopStats,
  }

  const perfBudgets = budgetTable(perfEntries, baselineSummary, noopSummary)
  results.data.perf1440 = { warmup: { readyMs: warmup.record && warmup.record.readyMs, targetTitle: warmup.targetTitle }, entries: perfEntries, readySeries, drift, budgets: perfBudgets, baseline: baselineSummary, noop: noopSummary }
  results.step('perf.1440.entries', perfEntries.map((entry) => ({
    label: entry.label, targetTitle: entry.targetTitle, readyMs: entry.readyMs, finishedMs: entry.finishedMs, callbackDurationMs: entry.callbackDurationMs,
    focusSignalMs: entry.focusSignalMs, domCommittedMs: entry.domCommittedMs, readyOverheadMs: entry.readyOverheadMs,
    frameP95Clean: entry.frameP95Clean, frameP95Raw: entry.frameP95Raw, frameMaxClean: entry.frameMaxClean,
    cleanIntervals: entry.frameIntervals, busyIntervals: entry.busyFrameIntervals, callbackGap: entry.callbackGapIntervals,
    longtasks: { total: entry.longtasks.total, callback: entry.longtasks.callbackPhase, animation: entry.longtasks.animationPhase, animationMax: entry.longtasks.animationPhaseMaxDuration },
  })))
  results.step('perf.1440.drift', drift)
  results.step('perf.1440.baseline', { summary: baselineSummary, noop: noopSummary })
  results.metric('perf1440.budgets', perfBudgets)
  results.metric('perf1440.drift', drift)
  results.data.env.pageErrorsMorph = app.handles.pageErrors.slice(0, 10)
  results.assert('perf.1440.ready-budget', perfBudgets.budget.readyP95Ok, {
    expected: '【计划 §4.8/§5 G2 原文】4 窗 ready P95 ≤ 80ms',
    actual: { ready: perfBudgets.ready, readyP95: perfBudgets.readyP95, decomposition: { baselineCommitP95: baselineSummary.p95, morphCommitInsideCallbackP95: perfBudgets.commitInsideCallback.p95, readyOverheadP95: perfBudgets.readyOverheadP95, noopVtReadyP95: noopSummary.ready.p95 }, targets: readySeries.map((item) => ({ targetTitle: item.targetTitle, readyMs: item.readyMs })) },
    category: 'budget',
  })
  results.assert('perf.1440.ready-overhead', perfBudgets.budget.readyOverheadOk, {
    expected: 'VT 捕获开销（ready − callback 结束）P95 ≤ 30ms：这是动效可控部分（noop VT ready P95=' + noopSummary.ready.p95 + 'ms）',
    actual: { readyOverhead: perfBudgets.readyOverhead, noopVtReady: noopSummary.ready },
    category: 'budget',
  })
  results.assert('perf.1440.ready-adjusted', perfBudgets.budget.readyP95WithCommitAdjusted, {
    expected: 'ready P95 ≤ 官方提交基线 P95 + 40ms（把不可控的官方提交计入后重标定）',
    actual: { readyP95: perfBudgets.readyP95, baselineCommitP95: baselineSummary.p95, adjustedBudget: (baselineSummary.p95 || 0) + 40, byTarget: readySeries.map((item) => ({ targetTitle: item.targetTitle, readyMs: item.readyMs, commitMs: item.commitMs })) },
    category: 'budget',
  })
  results.assert('perf.1440.frame-budget', perfBudgets.budget.frameCleanP95Ok, {
    expected: 'morph 干净帧 rAF P95 ≤ 18ms（≈55fps；干净帧=排除官方提交长任务阻塞的间隔）',
    actual: { frameCleanP95: perfBudgets.frameCleanP95, frameRawP95: perfBudgets.frameRawP95, perRun: readySeries.map((item) => ({ targetTitle: item.targetTitle, clean: item.frameP95Clean, raw: item.frameP95Raw })) },
    category: 'budget',
  })
  results.assert('perf.1440.longtask-budget', perfBudgets.budget.longtaskOk, {
    expected: '无 VT 引入的 >50ms 长任务：空回调 VT 长任务=0，且动画阶段长任务 ≤ 无 VT 基线（官方提交本身有长任务）',
    actual: { noopVtLongtasks: perfBudgets.noopVtLongtasks, animationPhase: perfBudgets.longtaskAnimationPhase, animationPhaseMax: perfBudgets.longtaskAnimationPhaseMax, callbackPhase: perfBudgets.longtaskCallbackPhase, baselineLongtaskMax: perfBudgets.baselineLongtaskMax },
    category: 'budget',
  })
  results.assert('perf.1440.drift-stable', drift.ratio === null || drift.ratio <= 1.5, {
    expected: '同一页面连续 8 次 morph 的 ready 后半段/前半段均值 ≤ 1.5（无累计漂移）',
    actual: { firstHalf: drift.firstHalf, secondHalf: drift.secondHalf, ratio: drift.ratio },
    category: 'budget',
  })
  results.assert('perf.1440.settle', perfEntries.every((entry) => entry.animationsAfterPseudo === 0 && entry.activeVtAfter === false), {
    expected: '每次 morph 结束无残留伪元素动画',
    actual: perfEntries.map((entry) => ({ animationsAfterPseudo: entry.animationsAfterPseudo, activeVtAfter: entry.activeVtAfter })),
    category: 'cleanup',
  })
  const perfLayoutDeviations = perfRuns.map((run) => run.after && layoutDeviation(run.after))
  results.data.perf1440.layoutDeviations = perfLayoutDeviations
  results.assert('perf.1440.layout', perfLayoutDeviations.every((deviation) => deviation && deviation.max <= 0.05), {
    expected: '每次 morph 结束几何与 actions.layout() 偏差 0',
    actual: perfLayoutDeviations.map((deviation) => deviation && deviation.max),
    category: 'morph',
  })
  const decomposition = {
    baselinePromoteFocusMs: baselineSummary.focusMs,
    baselinePromoteDomMs: baselineSummary.domMs,
    baselineLongtaskCounts: baselineSummary.longtaskCounts,
    baselineLongtaskDurations: baselineSummary.longtaskDurations,
    noopVtReadyMs: noopSummary.ready,
    noopVtFinishedMs: noopSummary.finished,
    noopVtLongtaskCount: noopSummary.longtaskCount,
    morphReadyMs: perfBudgets.ready,
    morphCommitInsideCallbackMs: perfBudgets.commitInsideCallback,
    morphReadyOverheadMs: perfBudgets.readyOverhead,
    morphFrameCleanP95: perfBudgets.frameCleanP95,
    morphFrameRawP95: perfBudgets.frameRawP95,
    warmupReadyMs: warmup.record && warmup.record.readyMs,
  }
  results.data.decomposition = decomposition
  results.step('decomposition', decomposition)
  results.metric('decomposition', decomposition)

  // ---------- ② 关键帧 morph（1440） ----------
  const keyframe = await keyframeMorph(page, 'morph-1440', { viewport: '1440x900' })
  const groupAnims = decodeGroupAnimations(keyframe.animationsAtReady)
  const preRects = sessionRects(keyframe.before)
  const postRects = sessionRects(keyframe.post.geometry)
  const promotedId = keyframe.target
  const demotedId = keyframe.before.snapshot.focusId
  const expectedNames = Object.keys(preRects).map((sessionId) => 'onestep-w-' + sessionId.replace(/[^A-Za-z0-9_-]/g, '_'))
  const actualGroupNames = Object.keys(groupAnims).filter((name) => name !== 'root')

  const pairing = []
  for (const [sessionId, pre] of Object.entries(preRects)) {
    const name = 'onestep-w-' + sessionId.replace(/[^A-Za-z0-9_-]/g, '_')
    const group = groupAnims[name]
    const post = postRects[sessionId]
    const startMatches = group && !group.incomplete ? rectMatches(pre.rect, group.start) : false
    const endMatches = group && !group.incomplete && post ? rectMatches(post.rect, group.end) : false
    pairing.push({
      sessionId,
      name,
      groupFound: !!group,
      incomplete: !!(group && group.incomplete),
      roleBefore: pre.mode,
      roleAfter: post ? post.mode : null,
      rectBefore: pre.rect,
      rectAfter: post ? post.rect : null,
      keyframeStart: group ? group.start : null,
      keyframeEnd: group ? group.end : null,
      startMatches,
      endMatches,
      duration: group ? group.duration : null,
      delay: group ? group.delay : null,
    })
  }
  const pairingOk = pairing.every((item) => item.groupFound && item.startMatches && item.endMatches)
  const roleSwapOk = (() => {
    const promoted = pairing.find((item) => item.sessionId === promotedId)
    const demoted = pairing.find((item) => item.sessionId === demotedId)
    return !!promoted && promoted.roleBefore === 'candidate' && promoted.roleAfter === 'focus' &&
      !!demoted && demoted.roleBefore === 'focus' && demoted.roleAfter === 'candidate'
  })()
  results.step('morph.1440.keyframe', {
    target: keyframe.target,
    focusBefore: demotedId,
    ready: keyframe.ready,
    record: keyframe.record,
    pseudo: keyframe.pseudo,
    geometry: keyframe.geometry,
    focusContentPresent: keyframe.focusContentPresent,
    shots: keyframe.controlFrames.map((item) => item.shot && item.shot.rel),
    post: keyframe.post.record,
    postGeometry: keyframe.post.geometry,
  })
  results.data.keyframe1440 = {
    groupAnims,
    pairing,
    promotedId,
    demotedId,
    controlFrames: keyframe.controlFrames,
  }
  results.metric('keyframe1440', { readyMs: keyframe.record.readyMs, finishedMs: keyframe.post.record.finishedMs, callbackDurationMs: keyframe.record.callbackDurationMs, focusSignalMs: keyframe.record.focusSignalMs, domCommittedMs: keyframe.record.domCommittedMs })
  results.assert('morph.1440.ready', typeof keyframe.record.readyMs === 'number' && !keyframe.record.readyError && !keyframe.post.record.finishedError, {
    expected: 'VT 1440 ready/finished 正常 resolve',
    actual: keyframe.record,
    category: 'morph',
  })
  results.assert('morph.1440.pseudo-durations', (() => {
    const durations = (keyframe.animationsAtReady || []).filter((item) => item.pseudoElement)
    const groups = durations.filter((item) => /group/.test(item.pseudoElement))
    const olds = durations.filter((item) => /old/.test(item.pseudoElement))
    const news = durations.filter((item) => /new/.test(item.pseudoElement))
    return groups.length > 0 && olds.length > 0 && news.length > 0 &&
      groups.every((item) => item.duration === 220) && olds.every((item) => item.duration === 120 && item.delay === 0) && news.every((item) => item.duration === 120 && item.delay === 60)
  })(), {
    expected: '伪元素动画时长 = 计划 §4.3：group 220ms / old 120ms / new 120ms+delay 60ms',
    actual: (keyframe.animationsAtReady || []).filter((item) => item.pseudoElement).map((item) => ({ pseudo: item.pseudoElement, duration: item.duration, delay: item.delay })),
    category: 'morph',
  })
  results.assert('morph.1440.group-names', expectedNames.every((name) => actualGroupNames.includes(name)), {
    expected: '4 个 sessionId 各有一个 group 伪元素（名称配对齐全）',
    actual: { expectedNames, actualGroupNames },
    category: 'naming',
  })
  results.assert('morph.1440.pairing', pairingOk && roleSwapOk, {
    expected: '名称配对：候选位→焦点位 / 焦点位→候选位（组 keyframes 起止 = 角色互换前后 rect）',
    actual: { pairing, roleSwapOk },
    category: 'pairing',
  })
  results.assert('morph.1440.final-focus', keyframe.post.geometry.snapshot.focusId === keyframe.target, {
    expected: 'promote 完成后 snapshot().focusId = 目标 sessionId',
    actual: { focusId: keyframe.post.geometry.snapshot.focusId, target: keyframe.target },
    category: 'morph',
  })
  const keyframeDeviation = layoutDeviation(keyframe.post.geometry)
  results.metric('keyframe1440.layoutDeviation', keyframeDeviation)
  results.assert('morph.1440.geometry', keyframeDeviation.max <= 0.05, {
    expected: '结束后焦点窗/候场卡 rect 与 actions.layout() 偏差 0',
    actual: keyframeDeviation,
    category: 'morph',
  })
  const postGrid = slotGridSignature(keyframe.post.geometry)
  const gridOk = JSON.stringify(postGrid.focus && postGrid.focus.rect) === JSON.stringify(baselineGrid.focus && baselineGrid.focus.rect) &&
    JSON.stringify(postGrid.candidateRects) === JSON.stringify(baselineGrid.candidateRects)
  results.assert('morph.1440.grid', gridOk && (keyframe.post.geometry.candidates || []).length === 3, {
    expected: 'promote 后 4 窗几何网格与初始一致（焦点槽 + 3 候场槽多重集）',
    actual: { baseline: baselineGrid, post: postGrid },
    category: 'morph',
  })
  results.assert('morph.1440.residual', keyframe.post.pseudoAfter === 0 && keyframe.post.record.activeVtFinal === false, {
    expected: '结束后无残留 VT 伪元素动画 / 无 activeViewTransition',
    actual: { pseudoAfter: keyframe.post.pseudoAfter, activeVtFinal: keyframe.post.record.activeVtFinal },
    category: 'cleanup',
  })
  // 关键帧截图非空白 + t0→t110 变化 + t220≈post
  const png0 = decodePng(loadShot('morph-1440-t000.png'))
  const png110 = decodePng(loadShot('morph-1440-t110.png'))
  const png220 = decodePng(loadShot('morph-1440-t220.png'))
  const pngPost = decodePng(loadShot('morph-1440-post.png'))
  const diff0to110 = regionDiff(png0, png110, null, { step: 6 })
  const diff110to220 = regionDiff(png110, png220, null, { step: 6 })
  const diff220toPost = regionDiff(png220, pngPost, null, { step: 6 })
  const imageStats1440 = {
    t000: imageStats(png0),
    t110: imageStats(png110),
    t220: imageStats(png220),
    post: imageStats(pngPost),
  }
  results.data.keyframePixels1440 = { diff0to110, diff110to220, diff220toPost, imageStats: imageStats1440, sizes: { t0: png0.width + 'x' + png0.height, post: pngPost.width + 'x' + pngPost.height } }
  results.step('morph.1440.image-stats', imageStats1440)
  const noWhiteScreen = ['t000', 't110', 't220'].every((key) => imageStats1440[key].whiteFraction < 0.98 && imageStats1440[key].stdLuminance > 5 && imageStats1440[key].sampledColorBuckets > 20)
  results.assert('morph.1440.no-white-screen', noWhiteScreen, {
    expected: '关键帧非白屏/黑屏（白像素比例 < 50%、亮度标准差 > 5、颜色桶 > 20）',
    actual: imageStats1440,
    category: 'keyframe',
  })
  results.step('morph.1440.pixels', { diff0to110: { changedFraction: diff0to110.changedFraction, meanAbsDiff: diff0to110.meanAbsDiff }, diff110to220: { changedFraction: diff110to220.changedFraction, meanAbsDiff: diff110to220.meanAbsDiff }, diff220toPost: { changedFraction: diff220toPost.changedFraction, meanAbsDiff: diff220toPost.meanAbsDiff } })
  results.assert('morph.1440.keyframes-move', diff0to110.changedFraction > 0.02 && diff110to220.changedFraction > 0.005, {
    expected: 't=0→110→220 画面确实在 morph（像素变化比例 > 2% / > 0.5%）',
    actual: { t0to110: diff0to110.changedFraction, t110to220: diff110to220.changedFraction },
    category: 'keyframe',
  })
  results.assert('morph.1440.keyframes-final', diff220toPost.changedFraction < 0.01, {
    expected: 't=220 收敛到结束态（与 post 截图差异 < 1%）',
    actual: { t220toPost: diff220toPost.changedFraction },
    category: 'keyframe',
  })

  // ---------- ⑥ 快速连切 5 次（busy → skipTransition + 立即应用，D4） ----------
  await page.evaluate(() => { window.__P4.seqIndex = 0; window.__P4.lastSequenceTarget = null; window.__P4.sequenceRecords = [] })
  const sequence = []
  for (let index = 0; index < 5; index += 1) {
    const step = await page.evaluate(() => {
      const R = window.__P4
      const snapshot = R.snapshot()
      const candidates = (snapshot.candidates || []).slice()
      const target = candidates.find((id) => id !== R.lastSequenceTarget) || candidates[0]
      if (!target) return { error: 'no-candidate' }
      R.lastSequenceTarget = target
      const record = R.requestMorph(target, { label: 'rapid-' + R.seqIndex })
      R.seqIndex += 1
      R.sequenceRecords.push(record)
      return { target, route: record.route, skipError: record.skipError || null, actionError: record.actionError || null, actionReturn: record.actionReturn || null }
    })
    sequence.push(step)
    await sleep(80)
  }
  const rapidSettle = await page.evaluate(async () => {
    const R = window.__P4
    await R.sleep(60)
    const last = R.lastSequenceTarget
    const settled = await R.waitSettled(last, 3000)
    await R.sleep(400)
    const names = R.applyWindowNames()
    await R.sleep(24)
    return {
      last,
      settled: {
        focusOk: settled.focusOk, waitedMs: settled.waitedMs, activeViewTransition: settled.activeViewTransition,
      },
      pseudoAfter500: R.vtAnimations().length,
      snapshot: R.snapshot(),
      geometry: R.geometry(),
      names,
      records: R.sequenceRecords.map((record) => ({
        targetId: record.targetId, route: record.route, skipError: record.skipError || null,
        actionError: record.actionError || null, actionReturn: record.actionReturn && record.actionReturn.ok !== undefined ? record.actionReturn : null,
        readyMs: record.readyMs === undefined ? null : record.readyMs,
        finishedMs: record.finishedMs === undefined ? null : record.finishedMs,
        finishedError: record.finishedError === null || record.finishedError === undefined ? null : record.finishedError,
      })),
      animations: R.auditAnimations(),
    }
  })
  const rapidDeviation = layoutDeviation(rapidSettle.geometry)
  const rapidGrid = slotGridSignature(rapidSettle.geometry)
  const rapidGridOk = JSON.stringify(rapidGrid.focus && rapidGrid.focus.rect) === JSON.stringify(baselineGrid.focus && baselineGrid.focus.rect) &&
    JSON.stringify(rapidGrid.candidateRects) === JSON.stringify(baselineGrid.candidateRects)
  const rapidFocusOk = rapidSettle.geometry.snapshot.focusId === rapidSettle.last
  const rapidVtCount = sequence.filter((step) => step.route === 'vt').length
  const rapidSkipCount = sequence.filter((step) => step.route === 'skipped').length
  results.data.rapid = { sequence, settle: rapidSettle, deviation: rapidDeviation, gridOk: rapidGridOk, focusOk: rapidFocusOk, vtCount: rapidVtCount, skipCount: rapidSkipCount }
  results.step('rapid.sequence', { sequence, rapidVtCount, rapidSkipCount, last: rapidSettle.last, focusOk: rapidFocusOk, gridOk: rapidGridOk, pseudoAfter500: rapidSettle.pseudoAfter500, deviation: rapidDeviation.max })
  results.metric('rapid', { sequence, vtCount: rapidVtCount, skipCount: rapidSkipCount, focusId: rapidSettle.snapshot.focusId, pseudoAfter500: rapidSettle.pseudoAfter500, deviationMax: rapidDeviation.max })
  results.assert('rapid.final-state', rapidFocusOk && rapidGridOk && rapidSettle.snapshot.candidates.length === 3 && rapidDeviation.max <= 0.05, {
    expected: '5 连切后 snapshot.focusId = 最后一次目标、候场 3 张、几何网格一致（偏差 0）',
    actual: { focusOk: rapidFocusOk, gridOk: rapidGridOk, focusId: rapidSettle.snapshot.focusId, last: rapidSettle.last, candidates: rapidSettle.snapshot.candidates, deviation: rapidDeviation.max },
    category: 'interrupt',
  })
  results.assert('rapid.no-residual', rapidSettle.pseudoAfter500 === 0 && rapidSettle.settled.activeViewTransition === false, {
    expected: '5 连切动画结束后无残留 VT 伪元素动画 / 无 activeViewTransition',
    actual: { pseudoAfter500: rapidSettle.pseudoAfter500, activeViewTransition: rapidSettle.settled.activeViewTransition },
    category: 'cleanup',
  })
  results.assert('rapid.routes', rapidVtCount >= 1 && rapidSkipCount >= 1 && sequence.every((step) => !step.error), {
    expected: '连切中既有 VT 也有 skipTransition 直切路径（D4：进行中→skipTransition+立即应用）',
    actual: { vtCount: rapidVtCount, skipCount: rapidSkipCount, sequence },
    category: 'interrupt',
  })
  results.assert('env.no-pageerror', app.handles.pageErrors.length === 0, {
    expected: 'morph/连切/滚动全程无 pageerror',
    actual: { pageErrors: app.handles.pageErrors.slice(0, 10) },
    category: 'env',
  })

  // ---------- ④ 关键帧截图（1280 视口） ----------
  await page.setViewportSize({ width: 1280, height: 900 })
  await sleep(900)
  const viewport1280 = await page.evaluate(() => window.__P4.geometry())
  let keyframe1280 = null
  if (viewport1280.snapshot.mounted) {
    await prepareNames(page)
    keyframe1280 = await keyframeMorph(page, 'morph-1280')
    const deviation1280 = layoutDeviation(keyframe1280.post.geometry)
    results.step('morph.1280', {
      viewport: viewport1280.viewport,
      geometry: viewport1280,
      ready: keyframe1280.ready,
      record: keyframe1280.record,
      shots: keyframe1280.controlFrames.map((item) => item.shot && item.shot.rel),
      post: keyframe1280.post.record,
      postGeometry: keyframe1280.post.geometry,
      deviation: deviation1280,
    })
    results.data.keyframe1280 = {
      viewport: viewport1280.viewport,
      geometryBefore: viewport1280,
      geometryAfter: keyframe1280.post.geometry,
      groupAnims: decodeGroupAnimations(keyframe1280.animationsAtReady),
      controlFrames: keyframe1280.controlFrames,
      deviation: deviation1280,
    }
    results.metric('keyframe1280', { viewport: viewport1280.viewport, readyMs: keyframe1280.record.readyMs, deviationMax: deviation1280.max })
    const pngA = decodePng(loadShot('morph-1280-t000.png'))
    const pngB = decodePng(loadShot('morph-1280-t110.png'))
    const pngC = decodePng(loadShot('morph-1280-t220.png'))
    const diff1280 = regionDiff(pngA, pngB, null, { step: 6 })
    const imageStats1280 = { t000: imageStats(pngA), t110: imageStats(pngB), t220: imageStats(pngC) }
    results.data.keyframe1280.imageStats = imageStats1280
    results.step('morph.1280.image-stats', imageStats1280)
    results.assert('morph.1280.keyframes', keyframe1280.target && typeof keyframe1280.record.readyMs === 'number' && diff1280.changedFraction > 0.01 && deviation1280.max <= 0.05 && Object.values(imageStats1280).every((item) => item.whiteFraction < 0.98 && item.stdLuminance > 5 && item.sampledColorBuckets > 20), {
      expected: '1280 视口关键帧 0/110/220 截图生成、t0≠t110、结束几何偏差 0',
      actual: { target: keyframe1280.target, readyMs: keyframe1280.record.readyMs, diff: diff1280.changedFraction, deviation: deviation1280.max, shots: keyframe1280.controlFrames.length, imageStats: imageStats1280 },
      category: 'keyframe',
    })
    results.assert('morph.1280.no-residual', keyframe1280.post.pseudoAfter === 0, {
      expected: '1280 关键帧 morph 结束后无残留伪元素动画',
      actual: { pseudoAfter: keyframe1280.post.pseudoAfter },
      category: 'cleanup',
    })
  } else {
    results.skip('morph.1280', '1280 视口下舞台未挂载（mounted=false）', 'keyframe')
  }

  // ---------- 收尾 ----------
  const cleanup = await page.evaluate(() => window.__P4.cleanup())
  const finalState = await page.evaluate(() => ({
    pseudoLeft: window.__P4.vtAnimations().length,
    activeViewTransition: !!document.activeViewTransition,
    stageNames: window.__P4.windowEntries().map((entry) => entry.vtName),
    tempStyles: document.querySelectorAll('[data-p4-vt-style]').length,
    visibility: document.visibilityState,
  }))
  results.step('cleanup.final', { cleanup, finalState })
  results.data.env.pageErrors = app.handles.pageErrors.slice(0, 10)
  results.assert('cleanup.final', finalState.pseudoLeft === 0 && finalState.activeViewTransition === false && finalState.tempStyles === 0 && finalState.stageNames.every((name) => name === 'none'), {
    expected: '清理：无残留伪元素动画/活动过渡/注入样式，窗口名称还原 none',
    actual: finalState,
    category: 'cleanup',
  })
} catch (error) {
  results.fatal(error)
} finally {
  try { await closeApp(app) } catch (_error) { /* ignore */ }
  const data = results.finish()
  console.log('[morph-prototype] ok=' + data.ok + ' summary=' + JSON.stringify(data.summary))
  if (data.metrics.perf1440) console.log('[morph-prototype] budgets=' + JSON.stringify(data.metrics.perf1440.budgets))
  console.log('[morph-prototype] json=' + relPath(path.join(OUT, 'morph-prototype.json')))
}
process.exitCode = results.data.ok ? 0 : 1
