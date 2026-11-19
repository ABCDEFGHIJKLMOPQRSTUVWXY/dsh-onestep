#!/usr/bin/env node
/**
 * dsh-onestep P2-4 性能基准（可复跑）：
 *   a) 进入舞台 2 窗（焦点+1 候场）/ 4 窗（焦点+3 候场）——addCandidate 调用到舞台挂载 +
 *      官方内容渲染完成的耗时（rAF 轮询；产品无 performance.mark，故按轮询方案并注明 P2-4 需补打点）
 *   b) 焦点切换延迟（合成点击候选卡 → 新焦点窗内容可见）
 *   c) 拖拽帧率（候场栏 splitter 拖拽 1s，rAF 间隔 P95；≥55fps 判定）
 *   d) 内存（普通模式 1 窗 vs 舞台 4 窗，performance.memory，Chromium 精度限制注明）
 *   e) 退出残留（stage DOM=0、可编辑 composer=1、snapshot().mounted=false）
 *   f) 产品 performance.mark('stage-enter-start'/'stage-enter-ready') 是否存在
 *
 * 预算：docs/产品设计报告.md §11.1。每项先暖机 1 轮，正式 3 轮取中位。
 * 产物：artifacts/p2/verify/perf-bench.json + artifacts/p2/perf/*.png
 * 运行：node scripts/p2/verify/perf-bench.mjs（需隔离实例在跑）
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ARTIFACTS, Results, openApp, closeApp, snapshot, domStats, listSessions, leaveStage, sleep,
  waitFor, composerStats, blurActive, resetStageStorage, stageGeometry, pressChord, round2, ensureStage,
} from './lib.mjs'

const SHOTS = path.join(ARTIFACTS, 'perf')
fs.mkdirSync(SHOTS, { recursive: true })
const results = new Results('perf-bench', 'P2-4 性能基准', path.join(ARTIFACTS, 'verify', 'perf-bench.json'))
const BUDGET = {
  enter2ms: 400,
  enter4ms: 900,
  focusSwitchClickMs: 200,
  focusSwitchShortcutMs: 100,
  dragFps: 55,
  memoryDeltaMB: 200,
}
const app = await openApp({ colorScheme: 'light', viewport: { width: 1440, height: 900 } })
const { page } = app

const median = (values) => {
  const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (!list.length) return null
  const mid = Math.floor(list.length / 2)
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2
}
const percentile = (values, p) => {
  const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (!list.length) return null
  const index = Math.min(list.length - 1, Math.max(0, Math.ceil((p / 100) * list.length) - 1))
  return list[index]
}
const summarize = (values) => ({
  samples: values.map((value) => (value === null ? null : round2(value))),
  median: values.length ? round2(median(values)) : null,
  min: values.length ? round2(Math.min(...values.filter((value) => value !== null))) : null,
  max: values.length ? round2(Math.max(...values.filter((value) => value !== null))) : null,
})

/** 把主绑定归一化为空白/可编辑会话（保证退出后 composer 可编辑、焦点测量有对象）。 */
async function normalizeMain(page) {
  await leaveStage(page)
  const rows = await listSessions(page)
  const blankId = Object.keys(rows).find((id) => rows[id].blank)
  if (!blankId) throw new Error('无可用的空白会话用于归一化主绑定')
  await page.evaluate((id) => window.__ONESTEP__.actions.focusSession(id), blankId)
  await waitFor(
    async () => {
      const stats = await composerStats(page)
      return stats.editableVisible >= 1
    },
    { timeout: 8000, interval: 200, label: 'main-composer' },
  )
  await sleep(500)
  return {
    mainId: blankId,
    nonBlankIds: Object.keys(rows).filter((id) => !rows[id].blank),
  }
}

/** 在页内执行一轮「进入舞台」测量（addCandidate → 舞台+焦点内容就绪）。 */
async function enterRound(candidateCount) {
  return page.evaluate(async (count) => {
    const actions = window.__ONESTEP__.actions
    const marksOf = () => performance.getEntriesByType('mark').map((entry) => entry.name)
    actions.exitStage()
    await new Promise((resolve) => setTimeout(resolve, 450))
    const t0 = performance.now()
    const marksBefore = marksOf()
    const rows = actions.listSessions()
    const current = (() => {
      try {
        const snap = actions.snapshot()
        return snap.focusId || actions.currentSessionId() || null
      } catch (_error) {
        return null
      }
    })()
    const ids = Object.keys(rows).filter((id) => !rows[id].blank && id !== current).slice(0, count)
    for (const id of ids) actions.addCandidate(id)
    let readyAt = null
    let frames = 0
    const started = performance.now()
    await new Promise((resolve) => {
      const tick = () => {
        frames += 1
        const stage = document.querySelector('[data-onestep-stage]')
        if (stage) {
          const focus = stage.querySelector('.onestep-frame[data-mode="focus"]')
          const cands = stage.querySelectorAll('.onestep-frame[data-mode="candidate"]')
          if (focus && cands.length >= Math.min(1, ids.length)) {
            const focusRect = focus.getBoundingClientRect()
            const content = focus.querySelector('[data-conversation-content]')
            const contentRect = content ? content.getBoundingClientRect() : null
            if (focusRect.width > 2 && focusRect.height > 2 && contentRect && contentRect.width > 2 && contentRect.height > 2) {
              readyAt = performance.now()
              resolve()
              return
            }
          }
        }
        if (performance.now() - started > 15000) {
          resolve()
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await new Promise((resolve) => setTimeout(resolve, 700))
    const snap = actions.snapshot()
    const marksAfter = marksOf()
    const measuresAfter = performance.getEntriesByType('measure').map((entry) => ({ name: entry.name, durationMs: Math.round(entry.duration * 10) / 10 }))
    const enterMeasure = measuresAfter.filter((entry) => entry.name === 'stage-enter').slice(-1)[0] || null
    return {
      requestedCandidates: count,
      addedIds: ids.length,
      actualCandidates: snap.candidates.length,
      mounted: snap.mounted,
      frames,
      ms: readyAt === null ? null : Math.round((readyAt - t0) * 10) / 10,
      productEnterMs: enterMeasure ? enterMeasure.durationMs : null,
      marksBefore,
      marksAfter,
      productMarks: marksAfter.filter((name) => /stage-enter|focus-switch|onestep/i.test(name)),
    }
  }, candidateCount)
}

/** 采样 rAF 间隔（毫秒数组）。 */
const startRafSampler = (durationMs) =>
  page.evaluate(
    (duration) =>
      new Promise((resolve) => {
        const times = []
        let start = 0
        const tick = (t) => {
          if (!start) start = t
          times.push(t)
          if (t - start < duration) requestAnimationFrame(tick)
          else resolve(times)
        }
        requestAnimationFrame(tick)
      }),
    durationMs,
  )

const intervals = (times) => times.slice(1).map((time, index) => time - times[index])

try {
  const baseline = results.data.baseline
  results.step('method', {
    enter: '主判定 rAF 轮询：performance.now() 起点 = 首次 addCandidate 调用前；终点 = 舞台挂载 + 焦点帧 + 焦点窗 [data-conversation-content] 宽高 >2px（帧粒度 ~7-17ms）。P2-4 起产品另有 performance.mark：stage-enter-start → stage-enter-ready（measure stage-enter），作为交叉校验值记录（productMs）',
    focusSwitch: '页内对首个候场帧 el.click()，起点=click 事件时间戳，终点=snapshot().focusId 变化且新焦点窗 [data-conversation-content] 存在（rAF 轮询）',
    shortcutSwitch:
      '主判定取产品 measure「focus-switch」（focus-switch-start：键盘 run 内 openSession 前 → focus-switch-ready：新焦点窗官方内容可见）；交叉校验记录 rAF 轮询 keydown → focusId 变化的旧口径。真实组合键 Ctrl+Alt+2',
    drag: 'splitter pointer 拖拽 1s（40 次鼠标移动），期间 rAF 采样 1.2s；fps = 1000 / P95(帧间隔)',
    memory: 'performance.memory.usedJSHeapSize（Chromium，无 crossOriginIsolated 时按 ~100KB 量化；仅作参考值）',
    rounds: '每项暖机 1 轮 + 正式 3 轮取中位',
    machine: { cpu: baseline.cpu, cpuCount: baseline.cpuCount, totalMemGB: baseline.totalMemGB, node: baseline.node, playwright: baseline.playwrightVersion },
    viewport: { width: 1440, height: 900 },
    budgetSource: 'docs/产品设计报告.md §11.1',
  })

  const normalized = await normalizeMain(page)
  results.step('normalize', { mainId: String(normalized.mainId).slice(0, 12), nonBlankCount: normalized.nonBlankIds.length })
  results.setEnv('mainSessionKind', 'blank/idle（可编辑 composer）')
  results.setEnv('candidateSessionKind', 'non-blank（真实历史会话）')

  /* ---------- a) 进入舞台 2 窗 / 4 窗 ---------- */
  const enterOnce = async (candidateCount) => {
    const result = await enterRound(candidateCount)
    await page.evaluate(() => window.__ONESTEP__.actions.exitStage())
    await sleep(650)
    return result
  }
  const enterMeasure = {}
  for (const candidateCount of [1, 3]) {
    const warmup = await enterOnce(candidateCount)
    const rounds = []
    for (let index = 0; index < 3; index += 1) rounds.push(await enterOnce(candidateCount))
    const ms = rounds.map((round) => round.ms)
    enterMeasure[candidateCount === 1 ? 'twoWindows' : 'fourWindows'] = {
      candidateCount,
      warmup: { ms: warmup && warmup.ms, productEnterMs: warmup && warmup.productEnterMs, actualCandidates: warmup && warmup.actualCandidates, mounted: warmup && warmup.mounted },
      rounds,
      ms: summarize(ms),
      productMs: summarize(rounds.map((round) => round.productEnterMs)),
      productMarks: rounds.flatMap((round) => round.productMarks),
    }
  }
  results.step('enter-stage', enterMeasure)
  const enter2 = enterMeasure.twoWindows.ms.median
  const enter4 = enterMeasure.fourWindows.ms.median
  results.assert('perf.enter-stage-2windows', enter2 !== null && enter2 <= BUDGET.enter2ms, {
    expected: '进入舞台（2 窗）≤ 400ms（暖机后，报告 §11.1）',
    actual: {
      medianMs: enter2,
      rounds: enterMeasure.twoWindows.ms,
      productMarkMedianMs: enterMeasure.twoWindows.productMs.median,
      budgetMs: BUDGET.enter2ms,
      method: '主判定 rAF 轮询；产品 performance.measure(stage-enter) 交叉校验（P2-4 打点）',
    },
    category: 'P2-4',
  })
  results.assert('perf.enter-stage-4windows', enter4 !== null && enter4 <= BUDGET.enter4ms, {
    expected: '进入舞台（4 窗）≤ 900ms（暖机后）',
    actual: { medianMs: enter4, rounds: enterMeasure.fourWindows.ms, productMarkMedianMs: enterMeasure.fourWindows.productMs.median, budgetMs: BUDGET.enter4ms },
    category: 'P2-4',
  })
  const enterRuns = [...enterMeasure.twoWindows.rounds, ...enterMeasure.fourWindows.rounds]
  results.assert('perf.enter-stage-window-count', enterRuns.every((round) => round.mounted && round.actualCandidates === round.requestedCandidates) && enterMeasure.fourWindows.rounds.every((round) => round.actualCandidates === 3), {
    expected: '2 窗测量=焦点+1 候场，4 窗测量=焦点+3 候场', actual: { two: enterMeasure.twoWindows.rounds.map((round) => round.actualCandidates), four: enterMeasure.fourWindows.rounds.map((round) => round.actualCandidates) }, category: 'P2-4',
  })

  /* ---------- b) 焦点切换延迟（点击） ---------- */
  // 准备并保留 4 窗舞台（focus=空白主绑定，3 个非空白候场）
  await ensureStage(page, 3, { settleMs: 800 })
  const focusClickRounds = await page.evaluate(async () => {
    const actions = window.__ONESTEP__.actions
    const out = []
    for (let round = 0; round < 4; round += 1) {
      const before = actions.snapshot().focusId
      const candidate = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="candidate"]')
      if (!candidate) {
        out.push({ error: 'no-candidate', round })
        break
      }
      let clickAt = null
      const onClick = () => {
        if (clickAt === null) clickAt = performance.now()
      }
      document.addEventListener('click', onClick, true)
      const started = performance.now()
      candidate.click()
      const result = await new Promise((resolve) => {
        const tick = () => {
          const stage = document.querySelector('[data-onestep-stage]')
          const focus = stage && stage.querySelector('.onestep-frame[data-mode="focus"]')
          const content = focus && focus.querySelector('[data-conversation-content]')
          const changed = actions.snapshot().focusId !== before
          if (changed && focus && content) {
            resolve({ ms: Math.round((performance.now() - (clickAt === null ? started : clickAt)) * 10) / 10, changed: true })
            return
          }
          if (performance.now() - started > 5000) {
            resolve({ timeout: true, changed })
            return
          }
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      document.removeEventListener('click', onClick, true)
      await new Promise((resolve) => setTimeout(resolve, 900))
      const productMeasures = performance.getEntriesByType('measure')
      const contentMeasure = [...productMeasures].filter((entry) => entry.name === 'focus-switch-content').slice(-1)[0]
      out.push({ round, ...result, productContentMs: contentMeasure ? Math.round(contentMeasure.duration * 10) / 10 : null })
    }
    return out
  })
  const clickRounds = focusClickRounds.slice(1)
  const clickMs = clickRounds.map((round) => (typeof round.productContentMs === 'number' ? round.productContentMs : round.ms))
  results.step('focus-switch-click', { warmup: focusClickRounds[0], rounds: clickRounds, ms: summarize(clickMs) })
  results.assert('perf.focus-switch-click', median(clickMs) !== null && median(clickMs) <= BUDGET.focusSwitchClickMs, {
    expected: '焦点切换（内容换绑+首帧）≤ 200ms（报告 §11.1；产品 measure focus-switch-content：click → 新焦点窗官方内容可见）',
    actual: {
      medianMs: clickMs.length ? round2(median(clickMs)) : null,
      rounds: summarize(clickMs),
      rafDetectMedianMs: round2(median(clickRounds.map((round) => round.ms))) || null,
      budgetMs: BUDGET.focusSwitchClickMs,
      method: '主判定取产品 measure focus-switch-content（click → 内容首帧）；rAF 轮询（click → focusId 变化 + 内容存在）作交叉校验',
    },
    category: 'P2-4',
  })

  /* ---------- b2) 焦点切换延迟（快捷键 + 产品 measurement） ---------- */
  await blurActive(page)
  const shortcutRounds = []
  for (let round = 0; round < 4; round += 1) {
    const latencyPromise = page.evaluate(
      () =>
        new Promise((resolve) => {
          const actions = window.__ONESTEP__.actions
          const before = actions.snapshot().focusId
          const started = performance.now()
          let chordAt = null
          const onKey = (event) => {
            if (event.code === 'Digit2' && chordAt === null) chordAt = performance.now()
          }
          window.addEventListener('keydown', onKey, true)
          const tick = () => {
            const after = actions.snapshot().focusId
            if (after && after !== before) {
              window.removeEventListener('keydown', onKey, true)
              const base = chordAt === null ? started : chordAt
              resolve({ ms: Math.round((performance.now() - base) * 10) / 10, chordSeen: chordAt !== null, before: String(before).slice(0, 10), after: String(after).slice(0, 10) })
              return
            }
            if (performance.now() - started > 5000) {
              window.removeEventListener('keydown', onKey, true)
              resolve({ timeout: true, chordSeen: chordAt !== null })
              return
            }
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        }),
    )
    await pressChord(page, { ctrl: true, alt: true, key: '2' }, { settleMs: 0 })
    const result = await latencyPromise
    await sleep(700)
    // 产品打点：focus-switch-start（键盘 run 内 openSession 前）→ focus-switch-ready（主视图换绑完成）
    // 以及 focus-switch-content（→ 新焦点窗官方内容首帧）。
    const product = await page.evaluate(() => {
      const measures = performance.getEntriesByType('measure')
      const lastMeasure = (name) => [...measures].filter((entry) => entry.name === name).slice(-1)[0] || null
      const switchMeasure = lastMeasure('focus-switch')
      const contentMeasure = lastMeasure('focus-switch-content')
      const marks = performance.getEntriesByType('mark')
      const last = (name) => [...marks].filter((entry) => entry.name === name).slice(-1)[0] || null
      const start = last('focus-switch-start')
      const ready = last('focus-switch-ready')
      return {
        markDurationMs: switchMeasure ? Math.round(switchMeasure.duration * 10) / 10 : null,
        contentMeasureMs: contentMeasure ? Math.round(contentMeasure.duration * 10) / 10 : null,
        startAt: start ? Math.round(start.startTime * 10) / 10 : null,
        readyAt: ready ? Math.round(ready.startTime * 10) / 10 : null,
      }
    })
    shortcutRounds.push({ round, ...result, product })
    await blurActive(page)
  }
  const shortcutProductMs = shortcutRounds.slice(1).map((round) => round.product && round.product.markDurationMs).filter((value) => typeof value === 'number')
  const shortcutRafMs = shortcutRounds.slice(1).map((round) => round.ms)
  const shortcutContentMs = shortcutRounds.slice(1).map((round) => round.product && round.product.contentMeasureMs).filter((value) => typeof value === 'number')
  results.step('focus-switch-shortcut', {
    warmup: shortcutRounds[0],
    rounds: shortcutRounds.slice(1),
    productMs: summarize(shortcutProductMs),
    contentMs: summarize(shortcutContentMs),
    rafDetectMs: summarize(shortcutRafMs),
    method:
      '主判定 = 产品 measure(focus-switch)：keydown（run 内 focus-switch-start，实测 +0.1ms）→ 主视图换绑完成（桥上报新主绑定 + 舞台记账，focus-switch-ready）；内容首帧单独记录为 focus-switch-content（报告 §11.1 的「内容换绑+首帧」属点击 200ms 口径）',
  })
  results.assert('perf.focus-switch-shortcut', median(shortcutProductMs) !== null && median(shortcutProductMs) <= BUDGET.focusSwitchShortcutMs, {
    expected: '快捷键切换 ≤ 100ms（keydown 到主视图换绑完成，报告 §11.1；产品 measure focus-switch）',
    actual: {
      medianMs: shortcutProductMs.length ? round2(median(shortcutProductMs)) : null,
      rounds: summarize(shortcutProductMs),
      contentFirstFrameMedianMs: shortcutContentMs.length ? round2(median(shortcutContentMs)) : null,
      rafDetectMedianMs: shortcutRafMs.length ? round2(median(shortcutRafMs)) : null,
      budgetMs: BUDGET.focusSwitchShortcutMs,
      note: '实现键 Ctrl+Alt+2（文档 Alt+2 未注册，见 a11y 套件）；报告 §11.1 对快捷键只要求「到主视图换绑完成」，内容首帧属点击 200ms 口径（本套件同时记录）',
    },
    category: 'P2-4',
  })

  /* ---------- f) 产品 performance.mark / measure（进入舞台 + 切换焦点后） ---------- */
  const marks = await page.evaluate(() => {
    const markEntries = performance.getEntriesByType('mark')
    const measureEntries = performance.getEntriesByType('measure')
    return {
      markApi: typeof performance.mark === 'function',
      marks: [...new Set(markEntries.map((entry) => entry.name))],
      measures: [...new Set(measureEntries.map((entry) => entry.name))],
      productMarkCount: markEntries.filter((entry) => /stage-enter|focus-switch/.test(entry.name)).length,
    }
  })
  const expectedMarks = ['stage-enter-start', 'stage-enter-ready', 'focus-switch-start', 'focus-switch-ready']
  const foundMarks = expectedMarks.filter((name) => marks.marks.includes(name))
  results.step('performance-marks', { ...marks, expectedMarks, foundMarks })
  results.assert('perf.performance-marks', foundMarks.length === expectedMarks.length && marks.measures.includes('stage-enter') && marks.measures.includes('focus-switch') && marks.measures.includes('focus-switch-content'), {
    expected: 'P2-4 打点：stage-enter-start/ready + focus-switch-start/ready（及 measure stage-enter / focus-switch / focus-switch-content）在进入舞台/切换焦点后存在',
    actual: { markApi: marks.markApi, marks: marks.marks, measures: marks.measures, foundExpected: foundMarks, productMarkCount: marks.productMarkCount },
    category: 'P2-4',
    note: '本断言位置在点击/快捷键切换之后（切换后才产生 focus-switch 打点）；进入舞台产生 stage-enter 打点。',
  })

  /* ---------- c) 拖拽帧率 ---------- */
  await results.shot(page, 'p2-perf-01-stage-4windows.png', SHOTS)
  const idleTimes = await startRafSampler(700)
  const idleDeltas = intervals(idleTimes)
  const dragRounds = []
  for (let round = 0; round < 4; round += 1) {
    const sampler = startRafSampler(1200)
    const splitter = await page.evaluate(() => {
      const el = document.querySelector('[data-onestep-splitter]')
      if (!el) return null
      const rect = el.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })
    if (!splitter) break
    await page.mouse.move(splitter.x, splitter.y)
    await page.mouse.down()
    for (let step = 0; step < 40; step += 1) {
      const offset = Math.sin(step / 5) * 28
      await page.mouse.move(splitter.x + offset, splitter.y)
      await sleep(22)
    }
    await page.mouse.up()
    const times = await sampler
    const deltas = intervals(times)
    dragRounds.push({ round, frames: times.length, durationMs: round2(times[times.length - 1] - times[0]), p50: round2(percentile(deltas, 50)), p95: round2(percentile(deltas, 95)), fps: round2(1000 / percentile(deltas, 95)) })
    await sleep(350)
  }
  const measuredDrag = dragRounds.slice(1)
  const dragP95 = median(measuredDrag.map((round) => round.p95))
  const dragFps = dragP95 ? round2(1000 / dragP95) : null
  results.step('drag-fps', { idle: { frames: idleTimes.length, p50: round2(percentile(idleDeltas, 50)), p95: round2(percentile(idleDeltas, 95)), fps: round2(1000 / percentile(idleDeltas, 95)) }, warmup: dragRounds[0], rounds: measuredDrag, dragP95Median: dragP95, dragFps })
  results.assert('perf.drag-fps', dragFps !== null && dragFps >= BUDGET.dragFps, {
    expected: '拖拽帧率 ≥ 55fps（rAF 间隔 P95，报告 §11.1）', actual: { dragFps, dragP95Ms: dragP95, idleFps: round2(1000 / percentile(idleDeltas, 95)), rounds: measuredDrag, budgetFps: BUDGET.dragFps, note: 'headless Edge rAF 约 144Hz（6.9ms）' }, category: 'P2-4',
  })
  await results.shot(page, 'p2-perf-02-after-drag.png', SHOTS)

  /* ---------- d) 内存（1 窗 vs 4 窗） ---------- */
  const heap = () => page.evaluate(() => (performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize, limit: performance.memory.jsHeapSizeLimit } : null))
  let cdp = null
  try {
    cdp = await app.context.newCDPSession(page)
  } catch (_error) {
    cdp = null
  }
  const forceGc = async () => {
    if (!cdp) return false
    try {
      await cdp.send('HeapProfiler.collectGarbage')
      return true
    } catch (_error) {
      return false
    }
  }
  const sampleHeap = async (times = 3) => {
    const gcOk = await forceGc()
    await sleep(300)
    const samples = []
    for (let index = 0; index < times; index += 1) {
      samples.push(await heap())
      await sleep(250)
    }
    return { samples, medianUsed: median(samples.map((sample) => (sample ? sample.used : null))), gcOk }
  }
  await page.evaluate(() => window.__ONESTEP__.actions.exitStage())
  await waitFor(
    async () => (await domStats(page)).stage === 0,
    { timeout: 8000, interval: 200, label: 'stage-gone-before-memory' },
  )
  await sleep(1800)
  const mem1 = await sampleHeap()
  const fourWindowSnapshot = await ensureStage(page, 3, { settleMs: 900 })
  await sleep(1500)
  const mem4 = await sampleHeap()
  results.step('memory', {
    oneWindow: { medianUsed: mem1.medianUsed, samples: mem1.samples },
    fourWindows: { medianUsed: mem4.medianUsed, samples: mem4.samples },
    enter: { actualCandidates: fourWindowSnapshot && fourWindowSnapshot.actualCandidates, mounted: fourWindowSnapshot && fourWindowSnapshot.mounted },
  })
  const deltaMB = mem1.medianUsed && mem4.medianUsed ? round2((mem4.medianUsed - mem1.medianUsed) / 1024 / 1024) : null
  results.assert('perf.memory-delta', deltaMB !== null && deltaMB <= BUDGET.memoryDeltaMB, {
    expected: '空闲内存增量（4 窗 vs 1 窗）≤ 200MB（报告 §11.1）',
    actual: { deltaMB, oneWindowMB: mem1.medianUsed ? round2(mem1.medianUsed / 1024 / 1024) : null, fourWindowsMB: mem4.medianUsed ? round2(mem4.medianUsed / 1024 / 1024) : null, budgetMB: BUDGET.memoryDeltaMB, gc: { before1: mem1.gcOk, before4: mem4.gcOk }, precision: 'performance.memory 在 Chromium 未开启精确内存时按 ~100KB 量化；每次采样前尝试 CDP HeapProfiler.collectGarbage；仍仅作参考值（P2-4 建议用 DevTools heap snapshot 复核）' },
    category: 'P2-4',
  })

  /* ---------- e) 退出残留 ---------- */
  const exitBefore = await snapshot(page)
  await page.evaluate(() => window.__ONESTEP__.actions.exitStage())
  await sleep(400)
  let exitStats = null
  try {
    exitStats = await waitFor(
      async () => {
        const dom = await domStats(page)
        const composer = await composerStats(page)
        if (dom.stage === 0 && composer.editableVisible >= 1) return { dom, composer }
        return false
      },
      { timeout: 8000, interval: 200, label: 'exit-cleanup' },
    )
  } catch (_error) {
    exitStats = { dom: await domStats(page), composer: await composerStats(page) }
  }
  const exitSnap = await snapshot(page)
  results.step('exit-residue', { before: { mounted: exitBefore.mounted, candidates: exitBefore.candidates.length }, dom: exitStats.dom, composer: exitStats.composer, mounted: exitSnap.mounted })
  results.assert('perf.exit-residue', exitStats.dom.stage === 0 && exitStats.dom.occurrences === 0 && exitStats.dom.candidateFrames === 0 && exitStats.dom.quickBars === 0 && exitSnap.mounted === false && exitStats.composer.editableVisible === 1, {
    expected: '退出残留：stage DOM=0、候场 occurrence=0、可编辑 composer=1、snapshot().mounted=false（报告 §11.1）',
    actual: { stageDom: exitStats.dom.stage, occurrences: exitStats.dom.occurrences, candidateFrames: exitStats.dom.candidateFrames, quickBars: exitStats.dom.quickBars, editableComposer: exitStats.composer, mounted: exitSnap.mounted },
    category: 'P2-4',
    note: '「0 个插件订阅」无法由 DOM 断言（需 DevTools memory 快照人工核对），P2-4 建议由 probe/日志暴露订阅计数',
  })
  const geometry = await stageGeometry(page)
  results.setEnv('afterExitStageGeometry', geometry)

  await resetStageStorage(page)
  results.assert('env.no-page-errors', app.handles.pageErrors.length === 0, {
    expected: 'perf 套件无页面异常', actual: { pageErrors: app.handles.pageErrors, consoleErrors: app.handles.consoleErrors.slice(0, 5) }, category: 'env',
  })
  results.captureErrors(app.handles)
} catch (error) {
  results.fatal(error)
} finally {
  try {
    await closeApp(app)
  } catch (_error) {
    /* ignore */
  }
}

const data = results.finish()
process.exitCode = data.ok ? 0 : 1
