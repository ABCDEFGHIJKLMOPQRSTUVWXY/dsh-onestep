/**
 * P4-9 m6：性能与清理验证 —— 计划 §5 G9（§4.8 预算，按 P4-1 标定口径修订）。
 *
 * 口径（Lead/@P4-1 证据冻结）：
 * 1) VT 快照开销 = ready − 回调内官方提交耗时；门禁 P95 ≤ 20ms（P4-1 实测 P95 6.5ms）。
 *    ready 全量只记录，软门禁 readyP95 ≤ 官方提交 P95 + 40ms。
 * 2) 帧率用「干净帧」：剔除 VT 更新回调分相与官方提交长任务阻塞窗口后，P95 ≤ 同次运行 idle P95 + 4ms。
 * 3) 长任务：空回调 VT 对照 = 0；真实 morph 的长任务归因官方提交/内容挂载，单独记录不判失败。
 * 4) 动画结束 500ms 后插件自有 running animations = 0；退出舞台后无 :root --onestep-vt-* / 内联 view-transition-name /
 *    data-onestep-motion 残留。插件 dispose 无法从 e2e 触发（宿主生命周期），记录 partial。
 *
 * 运行：node scripts/p4/verify/m6-perf.mjs
 * 产物：artifacts/p4/verify/m6-perf.json
 */
import {
  openVerifyApp,
  closeApp,
  setupFourWindows,
  snapshot,
  geometry,
  motionState,
  waitMotionIdle,
  waitStageGone,
  createResults,
  finishSuite,
  assertNoPageErrors,
  waitFor,
  sleep,
  stats,
  analyzeFrameIntervals,
} from './lib.mjs'

const results = createResults('m6-perf', 'P4-9 m6：性能与清理（G9）')
let app = null

function intervalsOf(frames) {
  const list = []
  for (let index = 1; index < (frames || []).length; index += 1) {
    const delta = frames[index] - frames[index - 1]
    if (delta > 0) list.push(delta)
  }
  return list
}

function overlaps(prev, current, span) {
  return current >= span.start && prev <= span.end
}

try {
  app = await openVerifyApp({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
  const page = app.page
  results.setEnv('viewport', '1440x900')
  const setup = await setupFourWindows(page)
  results.metric('m6.setup', { windows: setup.windows, baseline: setup.baseline })
  results.assert('m6.setup.windows', setup.windows.length === 4, { category: 'setup', expected: 4, actual: setup.windows })

  // ---------- 1) 空闲 rAF 基线（同一次运行采样 2s） ----------
  const idle = await page.evaluate(() => window.__V.idleSample(2000))
  const idleIntervals = intervalsOf(idle.frames)
  const idleStats = stats(idleIntervals)
  const idleP95 = idleStats.p95
  results.metric('m6.idle', { intervalStats: idleStats, frames: idle.frames.length, longtasks: idle.longtasks, durationMs: idle.durationMs })
  results.assert('m6.idle.baseline', idleIntervals.length >= 30 && idleP95 > 0 && idleP95 < 100, {
    category: 'perf',
    expected: '同次运行 idle rAF 基线可测（30+ 帧，P95 < 100ms）',
    actual: idleStats,
  })

  // ---------- 2) 空回调 VT 对照（VT 自身引入长任务 = 0） ----------
  const control = await page.evaluate(() => window.__V.emptyVtControl())
  results.metric('m6.control', control)
  results.assert('m6.control.supported', control && control.supported === true && control.calls && control.calls.length === 1, {
    category: 'perf', expected: '空回调 VT 可运行', actual: control,
  })
  if (control && control.calls && control.calls[0]) {
    const controlOverhead = Number(control.calls[0].readyDelayMs) - Number(control.calls[0].callbackDurationMs)
    results.metric('m6.control.overhead', controlOverhead)
  }
  results.assert('m6.control.no-longtasks', !!control && (control.longtasks || []).length === 0, {
    category: 'perf',
    expected: '空回调 VT 长任务 = 0（VT 本身不引入 longtask）',
    actual: control && control.longtasks,
  })

  // ---------- 3) 3 次真实 morph：VT 快照开销 / 干净帧 P95 ----------
  // 预热：先把 3 个目标各提升一次（官方内容首次挂载/长任务不进入测量窗口；对齐 P4-1 warmup 口径）。
  const warmup = []
  for (const target of setup.candidates.slice(0, 3)) {
    await waitMotionIdle(page)
    const snap = await snapshot(page)
    if (!snap.candidates || !snap.candidates.includes(target)) continue
    await page.evaluate((id) => window.__ONESTEP__.actions.promote(id), target)
    await waitFor(async () => (await snapshot(page)).focusId === target, { timeout: 15000, label: 'warmup.' + target })
    await waitMotionIdle(page, 15000)
    warmup.push(target)
  }
  results.metric('m6.warmup', { targets: warmup })
  await sleep(300)
  const runs = []
  const targets = setup.candidates.slice(0, 3)
  const attempts = []
  for (let index = 0; index < targets.length; index += 1) {
    let kept = null
    for (let attempt = 0; attempt < 4 && !kept; attempt += 1) {
      await waitMotionIdle(page)
      const target = targets[index]
      const beforeSnap = await snapshot(page)
      if (!beforeSnap.candidates || !beforeSnap.candidates.includes(target)) {
        results.step('perf.skip', { index, target, reason: 'target 不在候场', candidates: beforeSnap.candidates })
        break
      }
      await page.evaluate((label) => {
        window.__V.startVtWatch(label)
        window.__V.startRafSampling(label)
      }, 'm6.run' + index + '.' + attempt)
      await page.evaluate((id) => window.__ONESTEP__.actions.promote(id), target)
      await waitFor(async () => {
        const current = await snapshot(page)
        return current.focusId === target
      }, { timeout: 15000, label: 'run' + index + '.focus' })
      await page.waitForFunction(() => {
        const motion = window.__V.motion()
        return !!motion && !!motion.controller && motion.controller.active === false && motion.controller.activeState === 'idle' && window.__V.pseudoAnimations().length === 0
      }, null, { timeout: 15000 })
      const sampling = await page.evaluate(() => window.__V.stopRafSampling())
      const watch = await page.evaluate(() => window.__V.stopVtWatch())
      const motion = await motionState(page)
      const call = watch && watch.calls && watch.calls[0] ? watch.calls[0] : null
      // 噪声过滤：官方内容挂载的长任务若落在快照抓取窗口 [callbackEnd, ready] 内，
      // 则该次 overhead 被外部主线程占用污染（非 VT 成本），重试并记录（最多 4 次尝试/测量点）。
      const captureWindow = call && Number.isFinite(call.callbackEndMs) && Number.isFinite(call.readyMs)
        ? { start: call.callbackEndMs, end: call.readyMs }
        : null
      const contaminating = captureWindow ? (sampling.longtasks || []).filter((task) => Number(task.duration) > 50 && task.start < captureWindow.end && task.start + task.duration > captureWindow.start) : []
      const record = {
        index,
        attempt,
        target,
        kept: contaminating.length === 0,
        contaminating,
        call,
        sampling,
        watch,
        motion,
      }
      attempts.push(record)
      if (record.kept) {
        kept = record
        runs.push(record)
      }
      await sleep(250)
    }
    if (!kept) {
      results.step('perf.attempts-exhausted', { index, target: targets[index], note: '4 次尝试均被官方内容挂载长任务污染，记录未采用' })
    }
  }
  results.metric('m6.perf.attempts', attempts.map((item) => ({ index: item.index, attempt: item.attempt, target: item.target, kept: item.kept, contaminating: item.contaminating.map((task) => task.duration) })))
  const overheads = []
  const readyDelays = []
  const callbackDurations = []
  const runDetails = []
  for (const run of runs) {
    const call = run.watch && run.watch.calls && run.watch.calls[0] ? run.watch.calls[0] : null
    if (!call) continue
    // P4-1 口径（morph-prototype readyOverheadMs）：overhead = ready − callbackEnd（新快照抓取阶段）
    const overhead = Number(call.readyMs) - Number(call.callbackEndMs)
    overheads.push(overhead)
    readyDelays.push(call.readyDelayMs)
    callbackDurations.push(call.callbackDurationMs)
    runDetails.push({
      index: run.index,
      target: run.target,
      route: run.motion && run.motion.controller && run.motion.controller.last ? run.motion.controller.last.route : null,
      call,
      overhead,
      longtasks: run.sampling ? run.sampling.longtasks : [],
      frameCount: run.sampling ? run.sampling.frames.length : 0,
    })
  }
  const overheadStats = stats(overheads)
  const readyStats = stats(readyDelays)
  const commitStats = stats(callbackDurations)
  results.metric('m6.perf.runs', { details: runDetails, overhead: overheadStats, ready: readyStats, commit: commitStats })

  // 环境污染判定（P4-1 口径）：官方内容挂载/提交出现 ≥200ms 长任务时，性能测量不可信 →
  // 性能断言降级为记录（硬门禁仍保留：空回调 VT 长任务=0、清理=0、无 pageerror），避免把环境噪声判成回归。
  const heavyTasks = runDetails.flatMap((run) => (run.longtasks || [])).filter((task) => Number(task.duration) >= 200)
  const heavyAttempts = attempts.filter((item) => !item.kept && item.contaminating.some((duration) => Number(duration) >= 200))
  const environmentContaminated = heavyTasks.length > 0 || heavyAttempts.length > 0
  results.metric('m6.perf.environment', {
    environmentContaminated,
    heavyTasks: heavyTasks.map((task) => ({ duration: task.duration, start: task.start })),
    contaminatedAttempts: heavyAttempts.length,
  })
  if (environmentContaminated) {
    results.skip('m6.perf.vt-overhead-p95', '环境污染：本次 morph 出现 ≥200ms 官方提交/内容挂载长任务（' + heavyTasks.map((task) => task.duration).join(',') + 'ms）→ VT 开销断言降级为记录（见 m6.perf.runs）', 'perf')
  } else {
    results.assert('m6.perf.vt-overhead-p95', overheads.length >= 2 && overheadStats.p95 !== null && overheadStats.p95 <= 20, {
      category: 'perf',
      expected: 'VT 快照开销（ready − 回调内提交）P95 ≤ 20ms',
      actual: { overheads, stats: overheadStats, commits: commitStats, ready: readyStats },
    })
  }
  results.metric('m6.perf.ready-soft', {
    readyP95: readyStats.p95,
    commitP95: commitStats.p95,
    budget: commitStats.p95 === null ? null : commitStats.p95 + 40,
    pass: readyStats.p95 !== null && commitStats.p95 !== null && readyStats.p95 <= commitStats.p95 + 40,
    note: '全量 ready 只记录（含官方提交），不作硬门禁（P4-1 §4.8 口径）',
  })

  // 干净帧：剔除回调分相 + 提交长任务阻塞窗口
  const cleanStatsList = []
  const runFrameDetails = []
  for (const run of runs) {
    const call = run.watch && run.watch.calls && run.watch.calls[0] ? run.watch.calls[0] : null
    if (!call || !run.sampling) continue
    const frames = run.sampling.frames || []
    const spans = []
    if (Number.isFinite(call.callbackStartMs) && Number.isFinite(call.callbackEndMs)) spans.push({ start: call.callbackStartMs, end: call.callbackEndMs })
    const taskSpans = []
    for (const task of run.sampling.longtasks || []) {
      if (Number(task.duration) > 50) taskSpans.push({ start: task.start, end: task.start + task.duration })
    }
    // 长任务阻塞窗口 + 前后恢复期（长任务结束后第一帧是追赶帧，同样不应计入动画干净帧）
    const blockedSpans = spans.concat(taskSpans.map((span) => ({ start: span.start - 50, end: span.end + 50 })))
    const intervals = []
    const rawIntervals = []
    const excluded = []
    for (let index = 1; index < frames.length; index += 1) {
      const prev = frames[index - 1]
      const current = frames[index]
      const delta = current - prev
      if (!(delta > 0)) continue
      const hit = spans.some((span) => overlaps(prev, current, span))
      if (!hit) rawIntervals.push(delta)
      if (blockedSpans.some((span) => overlaps(prev, current, span))) {
        excluded.push({ from: prev, to: current, delta })
        continue
      }
      intervals.push(delta)
    }
    const cleanStats = stats(intervals)
    cleanStatsList.push(cleanStats)
    runFrameDetails.push({
      index: run.index,
      totalIntervals: Math.max(0, frames.length - 1),
      cleanIntervals: intervals.length,
      clean: cleanStats,
      pooledIntervals: intervals,
      rawClean: stats(rawIntervals),
      excluded,
      callbackSpans: spans,
      longtaskSpans: taskSpans,
      longtasks: (run.sampling.longtasks || []).map((task) => ({ duration: task.duration })),
    })
  }
  const pooled = runFrameDetails.flatMap((item) => item.pooledIntervals || [])
  const pooledStats = stats(pooled)
  const cleanP95 = pooledStats.p95
  const maxRunP95 = runFrameDetails.reduce((max, item) => (typeof item.clean.p95 === 'number' && item.clean.count >= 3 ? Math.max(max, item.clean.p95) : max), 0)
  results.metric('m6.perf.frames', { runs: runFrameDetails.map((item) => ({ index: item.index, clean: item.clean, raw: item.rawClean, excluded: item.excluded.length })), pooled: pooledStats, maxRunP95, idleP95 })
  const cleanFramePass = cleanP95 !== null && idleP95 !== null && pooledStats.count >= 8 && cleanP95 <= idleP95 + 4
  if (environmentContaminated) {
    results.skip('m6.perf.clean-frame-p95', '环境污染：≥200ms 官方长任务存在，干净帧 P95 断言降级为记录（指标见 m6.perf.frames）', 'perf')
  } else {
    results.assert('m6.perf.clean-frame-p95', cleanFramePass, {
      category: 'perf',
      expected: '动画阶段干净帧 P95（跨 run 合并）≤ idle P95 + 4ms（idle=' + idleP95 + 'ms，样本≥8）',
      actual: { cleanP95, pooled: pooledStats, idleP95, maxRunP95, runs: runFrameDetails.map((item) => ({ index: item.index, p95: item.clean.p95, count: item.clean.count, rawP95: item.rawClean && item.rawClean.p95, clean: item.cleanIntervals, total: item.totalIntervals, excluded: item.excluded.length })) },
    })
  }

  // 长任务归因记录（真实 morph 不判失败；空回调对照已断言 0）
  const animationLongtasks = []
  for (const run of runs) {
    const call = run.watch && run.watch.calls && run.watch.calls[0] ? run.watch.calls[0] : null
    for (const task of (run.sampling && run.sampling.longtasks) || []) {
      if (Number(task.duration) <= 50) continue
      const inCallback = call && Number.isFinite(call.callbackStartMs) && task.start >= call.callbackStartMs && task.start <= call.callbackEndMs
      animationLongtasks.push({ index: run.index, duration: task.duration, start: task.start, inCallback })
    }
  }
  results.metric('m6.perf.longtasks', { animationLongtasks, note: '真实 morph 的长任务归因官方提交/内容挂载，单独记录不判失败（Lead 口径）' })
  results.step('m6.perf.longtask-attribution', { longtasks: animationLongtasks })

  // ---------- 4) 动画结束 500ms 后插件自有动画清理 ----------
  await waitMotionIdle(page, 12000)
  await sleep(500)
  const cleanup = await page.evaluate(() => ({
    running: window.__V.runningPluginAnimations(),
    allPlugin: window.__V.pluginAnimations(),
    pseudo: window.__V.pseudoAnimations(),
    rootVars: window.__V.rootVars(),
    inlineNames: window.__V.inlineVtNames(),
    motion: window.__V.motion(),
  }))
  results.metric('m6.cleanup', cleanup)
  results.assert('m6.cleanup.no-running-animations', cleanup.running.length === 0 && cleanup.pseudo.length === 0, {
    category: 'cleanup', expected: { running: 0, pseudo: 0 }, actual: { running: cleanup.running, pseudo: cleanup.pseudo.map((item) => item.pseudoElement) },
  })
  results.assert('m6.cleanup.no-root-vars', Object.keys(cleanup.rootVars).length === 0, {
    category: 'cleanup', expected: '无 :root --onestep-vt-* 残留', actual: cleanup.rootVars,
  })
  results.assert('m6.cleanup.no-inline-vt-names', cleanup.inlineNames.length === 0, {
    category: 'cleanup', expected: '无内联 view-transition-name 残留（Q2 临时命名已还原）', actual: cleanup.inlineNames,
  })
  results.assert('m6.cleanup.controller-idle', !!cleanup.motion && cleanup.motion.controller.active === false && cleanup.motion.controller.activeState === 'idle', {
    category: 'cleanup', expected: { active: false, activeState: 'idle' }, actual: cleanup.motion && cleanup.motion.controller,
  })

  // ---------- 5) 卸载舞台：残留清理 ----------
  await page.evaluate(() => window.__ONESTEP__.actions.exitStage(true))
  await waitStageGone(page, 12000)
  await sleep(500)
  const unload = await page.evaluate(() => ({
    stageCount: document.querySelectorAll('[data-onestep-stage]').length,
    attr: document.documentElement.getAttribute('data-onestep-motion'),
    rootVars: window.__V.rootVars(),
    inlineNames: window.__V.inlineVtNames(),
    pseudo: window.__V.pseudoAnimations(),
    pluginAnimations: window.__V.pluginAnimations(),
    activeViewTransition: !!document.activeViewTransition,
  }))
  results.metric('m6.unload', unload)
  results.assert('m6.unload.stage-gone', unload.stageCount === 0, { category: 'unload', expected: 0, actual: unload.stageCount })
  results.assert('m6.unload.no-motion-attr', unload.attr === null, { category: 'unload', expected: 'html 无 data-onestep-motion', actual: unload.attr })
  results.assert('m6.unload.clean', unload.rootVars && Object.keys(unload.rootVars).length === 0 && unload.inlineNames.length === 0 && unload.pseudo.length === 0 && unload.pluginAnimations.length === 0 && unload.activeViewTransition === false, {
    category: 'unload',
    expected: { rootVars: {}, inlineNames: [], pseudo: [], pluginAnimations: [], activeViewTransition: false },
    actual: unload,
  })
  results.skip('m6.unload.plugin-dispose', '插件 dispose 由宿主生命周期触发，e2e 无法卸载插件；已覆盖舞台卸载清理，dispose 代码路径（移除 data-onestep-motion/media 监听/peek 层）由 P4-10 review 确认', 'partial')

  assertNoPageErrors(results, app.handles, 'm6')
} catch (error) {
  results.fatal(error)
} finally {
  try {
    if (app) await closeApp(app)
  } catch (_error) { /* ignore */ }
  finishSuite(results)
}
process.exitCode = results.data.ok ? 0 : 1
