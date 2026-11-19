/**
 * P4-9 验证套件共享库（verify-harness）。
 *
 * 职责：
 * - 复用 P3 探针链路（openApp / enterStage / actionCall / listSessions ...）与 P4-1 探针的纯 Node 统计函数
 *   （stats / analyzeFrameIntervals / decodePng / imageStats / regionDiff）；
 * - 产物只写 artifacts/p4/verify/**（每个 suite 一份 JSON + shots/）；
 * - 浏览器侧运行时 window.__V：几何/动画清单/VT 观察器（ready/callback/finished 分相）/关键帧暂停 seek/
 *   命名唯一性/插件自有动画过滤/浮动窗采样；
 * - Node 侧辅助：舞台搭建、待动画静默、关键帧截图、区域图像统计。
 *
 * 边界：只读产品源码与构建产物；不启动/重启隔离实例；不改 src/**、client.js、package.json。
 * 关键经验（P4-1）：VT 更新回调内禁止 await rAF（渲染暂停会死锁）；关键帧用 pause+seek 确定性截图。
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  ROOT,
  sleep,
  readServerUrl,
  openApp,
  closeApp,
  waitFor,
  actionCall,
  p3Call,
  listSessions,
  stageSnapshot,
  stageLayout,
  mountedSessionId,
  fileAddress,
  enterStage,
  leaveStage,
  rafSample,
  baselineInfo,
  Results,
} from '../../p3/probe/lib.mjs'
import {
  stats,
  analyzeFrameIntervals,
  decodePng,
  imageStats,
  regionDiff,
} from '../probe/lib.mjs'

export {
  ROOT,
  sleep,
  readServerUrl,
  openApp,
  closeApp,
  waitFor,
  actionCall,
  p3Call,
  listSessions,
  stageSnapshot,
  stageLayout,
  mountedSessionId,
  fileAddress,
  enterStage,
  leaveStage,
  rafSample,
  baselineInfo,
  stats,
  analyzeFrameIntervals,
  decodePng,
  imageStats,
  regionDiff,
}

export const OUT = path.join(ROOT, 'artifacts', 'p4', 'verify')
export const SHOTS = path.join(OUT, 'shots')

export function ensureDirs() {
  fs.mkdirSync(SHOTS, { recursive: true })
}

export function relPath(abs) {
  return path.relative(ROOT, abs).replace(/\\/g, '/')
}

/** P4 结果记录器：JSON 写 artifacts/p4/verify/<suite>.json，截图写 artifacts/p4/verify/shots/。 */
export function createResults(suite, title) {
  ensureDirs()
  const results = new Results(suite, title, path.join(OUT, suite + '.json'))
  results.data.p4 = {
    urlFile: 'artifacts/p3/server-url.txt',
    shotsDir: 'artifacts/p4/verify/shots',
    rerun: 'node scripts/p4/verify/' + suite + '.mjs',
    gate: 'docs/p4-plan.md §5 G3-G9',
  }
  return results
}

export async function shot(results, page, name) {
  return results.shot(page, name, SHOTS)
}

/** 读取舞台几何（含 snapshot/layout/motion），供 layoutDeviation 使用。 */
export async function geometry(page) {
  return page.evaluate(() => window.__V.geometry())
}

export const measure = (page) => page.evaluate(() => window.__V.geometry())

export async function motionState(page) {
  return page.evaluate(() => window.__V.motion())
}

export async function snapshot(page) {
  return page.evaluate(() => window.__V.snapshot())
}

/** 等待动作/动画全部静默（controller.active=false、activeState=idle、无 VT 伪元素动画）。 */
export async function waitMotionIdle(page, timeout = 15000) {
  const result = await page.evaluate((ms) => window.__V.waitMotionIdle(ms), timeout)
  if (!result || result.ok !== true) {
    throw new Error('waitMotionIdle timeout: ' + JSON.stringify(result).slice(0, 600))
  }
  return result
}

/** 等待舞台就绪（焦点窗有尺寸）。 */
export async function waitStageReady(page, timeout = 15000) {
  await page.waitForFunction(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    if (!stage) return false
    const focus = stage.querySelector('.onestep-frame[data-mode="focus"]')
    if (!focus) return false
    const rect = focus.getBoundingClientRect()
    return rect.width > 2 && rect.height > 2
  }, null, { timeout })
}

export async function waitStageGone(page, timeout = 10000) {
  await page.waitForFunction(
    () => !document.querySelector('[data-onestep-stage]') && window.__ONESTEP__ && window.__ONESTEP__.actions.snapshot().mounted === false,
    null,
    { timeout },
  )
}

/** 打开应用 + 安装验证运行时。 */
export async function openVerifyApp(options = {}) {
  const app = await openApp(options)
  await app.page.evaluate(installRuntime)
  return app
}

/**
 * 搭建 4 窗舞台（1 焦点 + 3 候场）。
 * @returns {{app:object, ids:string[], windows:string[], focusId:string, candidates:string[], geometry:object, baseline:object}}
 */
export async function setupFourWindows(page, options = {}) {
  const rows = await listSessions(page)
  const ids = Object.keys(rows || {})
  if (ids.length < 5) throw new Error('setupFourWindows 需要至少 5 个 session（现有 ' + ids.length + '）')
  const ranked = [...ids.filter((id) => !(rows[id] || {}).blank), ...ids.filter((id) => (rows[id] || {}).blank)]
  const entered = await enterStage(page, { count: 3, settleMs: options.settleMs === undefined ? 900 : options.settleMs })
  await waitMotionIdle(page)
  // 0.5.0 起上限 6：确保测试场景仍是「1 焦点 + 3 候场」（多余候场移出，保持 P4 断言口径）。
  const extra = await page.evaluate(() => {
    const actions = window.__ONESTEP__.actions
    const snap = actions.snapshot()
    const extras = (snap.candidates || []).slice(3)
    for (const id of extras) actions.removeCandidate(id)
    return extras
  })
  if (extra.length > 0) { await sleep(400); await waitMotionIdle(page) }
  const snap = await snapshot(page)
  const geo = await geometry(page)
  if (!snap.mounted) throw new Error('舞台未挂载：' + JSON.stringify(snap).slice(0, 400))
  const windows = [snap.focusId, ...(snap.candidates || [])].filter(Boolean)
  if (windows.length !== 4) throw new Error('期望 4 窗，实际 ' + windows.length + '：' + JSON.stringify(windows))
  return {
    rows,
    ids: ranked,
    extraIds: ranked.filter((id) => !windows.includes(id)),
    windows,
    focusId: snap.focusId,
    candidates: snap.candidates.slice(),
    geometry: geo,
    baseline: baselineGrid(geo),
    snapshot: snap,
  }
}

/** 基线几何签名：焦点 rect + 候场 rect 多重集。 */
export function baselineGrid(geo) {
  const roundRect = (rect) => (rect
    ? { x: Math.round(rect.x * 100) / 100, y: Math.round(rect.y * 100) / 100, w: Math.round(rect.w * 100) / 100, h: Math.round(rect.h * 100) / 100 }
    : null)
  return {
    stage: roundRect(geo.stage),
    focus: roundRect(geo.focus && geo.focus.rect),
    candidateRects: (geo.candidates || []).map((item) => roundRect(item.rect)),
  }
}

function rectDeviation(a, b) {
  if (!a || !b) return { max: Infinity }
  return {
    max: Math.max(
      Math.abs(a.x - b.x), Math.abs(a.y - b.y),
      Math.abs(a.w - b.w), Math.abs(a.h - b.h),
    ),
  }
}

/**
 * 结束几何断言数据：
 * - layoutDeviation：DOM rect vs actions.layout()（计划 §5 G3 口径，容差 ≤0.5px）；
 * - focusVsBaseline：焦点 rect vs 初始焦点 rect；
 * - candidatesVsBaseline：每张候场卡与初始候场 rect 多重集的最优匹配偏差。
 */
export function geometryCheck(geo, baseline) {
  const focusDeviation = rectDeviation(geo.focus && geo.focus.rect, geo.layout && geo.layout.focus)
  const latency = geo.layout && geo.layout.focus
  const layoutCandidates = (geo.layout && geo.layout.candidates) || []
  const candidateDeviations = (geo.candidates || []).map((candidate, index) => {
    const expected = layoutCandidates.find((item) => item.sessionId === candidate.sessionId) || layoutCandidates[index]
    return { sessionId: candidate.sessionId, deviation: rectDeviation(candidate.rect, expected) }
  })
  const layoutMax = Math.max(
    focusDeviation.max || 0,
    ...candidateDeviations.map((item) => item.deviation.max || 0),
    0,
  )
  const focusVsBaseline = rectDeviation(geo.focus && geo.focus.rect, baseline.focus)
  const remaining = baseline.candidateRects.slice()
  const candidateMatches = (geo.candidates || []).map((candidate) => {
    let best = null
    let bestIndex = -1
    remaining.forEach((rect, index) => {
      const deviation = rectDeviation(candidate.rect, rect)
      if (!best || deviation.max < best.max) {
        best = deviation
        bestIndex = index
      }
    })
    if (bestIndex >= 0) remaining.splice(bestIndex, 1)
    return { sessionId: candidate.sessionId, deviation: best }
  })
  const candidateVsBaseline = Math.max(0, ...candidateMatches.map((item) => (item.deviation ? item.deviation.max : Infinity)))
  return {
    layoutMax,
    focusVsBaselineMax: focusVsBaseline.max,
    candidateVsBaselineMax: candidateVsBaseline,
    detail: { focusDeviation, candidateDeviations, focusVsBaseline, candidateMatches, missingCandidateRects: remaining },
  }
}

/** 快照与期望模型比对（focusId + 候场集合）。 */
export function snapshotCheck(snap, model) {
  const expected = new Set(model.candidates)
  const actual = new Set(snap.candidates || [])
  const missing = [...expected].filter((id) => !actual.has(id))
  const extra = [...actual].filter((id) => !expected.has(id))
  return {
    focusOk: snap.focusId === model.focusId,
    candidatesOk: missing.length === 0 && extra.length === 0,
    expected: { focusId: model.focusId, candidates: model.candidates },
    actual: { focusId: snap.focusId, candidates: snap.candidates },
    missing,
    extra,
  }
}

/** 动画清单里 VT 伪元素（::view-transition-*）摘要。 */
export function vtGroups(pseudoAnimations) {
  const groups = {}
  for (const animation of pseudoAnimations || []) {
    const match = /^::view-transition-(group|old|new|image-pair)\((.+)\)$/.exec(animation.pseudoElement || '')
    if (!match) continue
    const kind = match[1]
    const name = match[2]
    groups[name] = groups[name] || { name, kinds: {} }
    groups[name].kinds[kind] = groups[name].kinds[kind] || []
    groups[name].kinds[kind].push({
      duration: animation.duration,
      delay: animation.delay,
      easing: animation.easing,
      playState: animation.playState,
    })
  }
  return groups
}

/** sessionId → view-transition-name（与 motion.js windowName 一致）。 */
export function windowName(sessionId) {
  return 'onestep-w-' + String(sessionId === undefined || sessionId === null ? '' : sessionId).replace(/[^A-Za-z0-9_-]/g, '_')
}

/** 在动画播放期间等待 VT 伪元素动画出现。 */
export async function waitPseudoAnimations(page, timeout = 6000) {
  await page.waitForFunction(() => window.__V.pseudoAnimations().length > 0 || window.__V.pseudoFirst() !== null, null, { timeout, polling: 10 })
  return page.evaluate(() => ({
    current: window.__V.pseudoAnimations(),
    first: window.__V.pseudoFirst(),
  }))
}

/**
 * 触发一次动作并测量 VT：返回 watch（含 calls/pseudoFirst/longtasks）+ 伪元素摘要 + 动作后 motionState。
 * @param {object} page
 * @param {() => Promise<void>} trigger 触发动作（Node 侧执行）
 * @param {{label?:string, timeout?:number}} [options]
 */
export async function triggerWithWatch(page, trigger, options = {}) {
  const label = options.label || 'vt'
  await page.evaluate((name) => window.__V.startVtWatch(name), label)
  await trigger()
  let pseudo = { current: [], first: null }
  let watchTimeout = false
  try {
    pseudo = await waitPseudoAnimations(page, options.timeout || 6000)
  } catch (_error) {
    watchTimeout = true
  }
  return {
    label,
    pseudo,
    watchTimeout,
    /** 停止观察并返回 watch（包含 ready/callback/finished 分相与伪元素首帧）。 */
    stop: async () => {
      const watch = await page.evaluate(() => window.__V.stopVtWatch())
      return watch
    },
  }
}

/**
 * 关键帧截图：暂停全部 VT 伪元素动画并逐时刻 seek + 截图（确定性，P4-1 方法）。
 * 调用前 VT 必须已在播放（伪元素动画存在）。
 * @returns {{shots:Array<{t:number,file:string}>, pause:object}}
 */
export async function captureKeyframes(page, results, label, times) {
  const list = Array.isArray(times) && times.length > 0 ? times : [0, 110, 220]
  const pause = await page.evaluate((t) => window.__V.pausePseudo(t), list[0])
  const shots = []
  for (let index = 0; index < list.length; index += 1) {
    const t = list[index]
    if (index > 0) await page.evaluate((value) => window.__V.seekPseudo(value), t)
    await page.evaluate(() => window.__V.forceFrames(2))
    const file = await shot(results, page, label + '-t' + String(t).padStart(3, '0') + '.png')
    shots.push({ t, file })
  }
  return { shots, pause }
}

export async function resumePseudo(page) {
  return page.evaluate(() => window.__V.resumePseudo())
}

/** 页面内属性/元素等待（短轮询，避免 Playwright 默认 30s 拖长失败时间）。 */
export async function waitForSelectorCount(page, selector, predicate, options = {}) {
  const timeout = options.timeout || 8000
  const interval = options.interval || 40
  const started = Date.now()
  for (;;) {
    const count = await page.evaluate((sel) => document.querySelectorAll(sel).length, selector)
    if (predicate(count)) return count
    if (Date.now() - started > timeout) {
      throw new Error('waitForSelectorCount timeout selector=' + selector + ' last=' + count)
    }
    await sleep(interval)
  }
}

export async function waitForCondition(page, predicateSource, options = {}) {
  const timeout = options.timeout || 8000
  const interval = options.interval || 50
  const started = Date.now()
  let last = null
  for (;;) {
    try {
      last = await page.evaluate(predicateSource)
    } catch (error) {
      last = { error: String(error) }
    }
    if (last && last.ok) return last
    if (Date.now() - started > timeout) {
      throw new Error('waitForCondition timeout (' + (options.label || '') + '): ' + JSON.stringify(last).slice(0, 600))
    }
    await sleep(interval)
  }
}

/* ------------------------------------------------------------------ *
 * 图像区域统计（关键帧内容防闪判据；theme-aware 相对判据，禁止绝对白像素比例）
 * ------------------------------------------------------------------ */

/** 区域基础统计（step 采样）：亮度均值/标准差/颜色桶数。 */
export function regionStats(image, rect) {
  const x0 = Math.max(0, Math.round(rect ? rect.x : 0))
  const y0 = Math.max(0, Math.round(rect ? rect.y : 0))
  const x1 = Math.min(image.width, Math.round(rect ? rect.x + rect.w : image.width))
  const y1 = Math.min(image.height, Math.round(rect ? rect.y + rect.h : image.height))
  const step = 2
  let count = 0
  let sum = 0
  let sumSq = 0
  const colors = new Set()
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const index = (y * image.width + x) * image.channels
      const r = image.data[index]
      const g = image.data[index + 1]
      const b = image.data[index + 2]
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
      sum += lum
      sumSq += lum * lum
      if (colors.size < 1024) colors.add((r >> 3) + ',' + (g >> 3) + ',' + (b >> 3))
      count += 1
    }
  }
  const mean = count ? sum / count : 0
  const variance = count ? Math.max(0, sumSq / count - mean * mean) : 0
  return {
    rect: { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) },
    sampled: count,
    meanLuminance: Math.round(mean * 100) / 100,
    stdLuminance: Math.round(Math.sqrt(variance) * 100) / 100,
    colorBuckets: colors.size,
  }
}

/**
 * 内容防闪判据（相对、theme-aware）：
 * - post 帧必须有内容（stdLuminance ≥ 5 且 colorBuckets ≥ 24）；
 * - t110 vs post：亮度均值相对差 ≤ 0.10、颜色桶比 ≥ 0.5、标准差比 ≥ 0.3、区域 meanAbsDiff ≤ 25；
 * - tEnd(=220/160) vs post：亮度均值相对差 ≤ 0.02、meanAbsDiff ≤ 5、颜色桶比 ≥ 0.9。
 * 不使用绝对白像素比例（浅色主题整页白是正常）。
 */
export function contentFlashCheck(images, rect) {
  const post = regionStats(images.post, rect)
  const mid = regionStats(images.mid, rect)
  const end = regionStats(images.end, rect)
  const midDiff = regionDiff(images.mid, images.post, rect, { tolerance: 10, step: 3 })
  const endDiff = regionDiff(images.end, images.post, rect, { tolerance: 10, step: 3 })
  const relativeDelta = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b))
  const bucketRatio = (a, b) => (b > 0 ? a / b : 0)
  const checks = {
    postHasContent: post.stdLuminance >= 5 && post.colorBuckets >= 24,
    midLuminance: relativeDelta(mid.meanLuminance, post.meanLuminance) <= 0.1,
    midBuckets: bucketRatio(mid.colorBuckets, post.colorBuckets) >= 0.5,
    midStd: post.stdLuminance > 0 ? mid.stdLuminance / post.stdLuminance >= 0.3 : true,
    midMeanDiff: (midDiff.meanAbsDiff || 0) <= 25,
    endLuminance: relativeDelta(end.meanLuminance, post.meanLuminance) <= 0.02,
    endMeanDiff: (endDiff.meanAbsDiff || 0) <= 5,
    endBuckets: bucketRatio(end.colorBuckets, post.colorBuckets) >= 0.9,
  }
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    stats: { post, mid, end },
    diffs: { mid: midDiff, end: endDiff },
  }
}

/* ------------------------------------------------------------------ *
 * 页面内运行时 window.__V（自包含；Playwright 序列化执行，禁止引用模块作用域）
 * ------------------------------------------------------------------ */

export function installRuntime() {
  if (window.__V && window.__V.version === 'p4-verify-1') return { installed: true, reused: true }
  const V = { version: 'p4-verify-1' }
  V.watch = null
  V.paused = null
  V.counter = null
  V.sampling = null
  V.animationWatcher = null

  const round = (value, digits) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return value
    const factor = 10 ** (digits === undefined ? 2 : digits)
    return Math.round(value * factor) / factor
  }
  V.round = round
  V.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  V.forceFrames = (count) => new Promise((resolve) => {
    let left = Math.max(1, count === undefined ? 2 : count)
    const tick = () => {
      left -= 1
      if (left <= 0) resolve(true)
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  V.rectOf = (el) => {
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) }
  }
  V.stageEl = () => document.querySelector('[data-onestep-stage]')
  V.snapshot = () => {
    try {
      return window.__ONESTEP__.actions.snapshot()
    } catch (error) {
      return { error: String((error && error.message) || error) }
    }
  }
  V.motion = () => {
    try {
      return window.__ONESTEP__.actions.motionState()
    } catch (error) {
      return { error: String((error && error.message) || error) }
    }
  }
  V.layout = () => {
    try {
      return window.__ONESTEP__.actions.layout()
    } catch (error) {
      return null
    }
  }
  V.frames = () => Array.from(document.querySelectorAll('[data-onestep-stage] .onestep-frame[data-mode]')).map((el) => ({
    sessionId: el.getAttribute('data-onestep-window-session'),
    mode: el.getAttribute('data-mode'),
    rect: V.rectOf(el),
    vtName: getComputedStyle(el).viewTransitionName,
    inlineName: el.style.getPropertyValue('--onestep-vt-name') || null,
    flash: el.getAttribute('data-flash'),
    drop: el.getAttribute('data-drop'),
    bubble: !!el.querySelector('.onestep-bubble'),
  }))

  const pluginClass = (target) => {
    if (!target) return false
    const cls = String(target.className || '')
    if (cls.indexOf('onestep-') >= 0) return true
    if (target.hasAttribute) {
      for (const attr of Array.from(target.attributes || [])) {
        if (String(attr.name).indexOf('data-onestep-') === 0) return true
      }
    }
    return false
  }
  const pluginOwnedTarget = (target) => {
    if (!target || target.nodeType !== 1) return false
    if (pluginClass(target)) return true
    if (target.closest) {
      if (target.closest('[data-onestep-picker],[data-onestep-peek-layer],[data-onestep-drag-hud],[data-onestep-drag-rail]')) return true
    }
    return false
  }
  V.describeAnimation = (animation) => {
    const effect = animation.effect
    const timing = effect && typeof effect.getTiming === 'function' ? effect.getTiming() : {}
    const target = effect && effect.target && effect.target.nodeType === 1 ? effect.target : null
    const pseudoElement = effect && effect.pseudoElement ? effect.pseudoElement : null
    const animationName = animation.animationName || null
    const transitionProperty = animation.transitionProperty || null
    const pluginOwned = !!(
      (pseudoElement && String(pseudoElement).indexOf('onestep') >= 0) ||
      (!pseudoElement && (String(animationName || '').indexOf('onestep') === 0 || pluginOwnedTarget(target)))
    )
    return {
      pseudoElement,
      animationName,
      transitionProperty,
      duration: timing.duration,
      delay: timing.delay || 0,
      easing: timing.easing || null,
      iterations: timing.iterations === Infinity ? 'infinite' : timing.iterations,
      fill: timing.fill || null,
      playState: animation.playState,
      currentTime: animation.currentTime === null || animation.currentTime === undefined ? null : round(animation.currentTime),
      pluginOwned,
      target: target ? {
        tag: target.tagName,
        cls: String(target.className || '').slice(0, 160),
        mode: target.getAttribute('data-mode'),
        sessionId: target.getAttribute('data-onestep-window-session'),
        pluginOwned: pluginOwnedTarget(target),
      } : null,
    }
  }
  V.animations = () => document.getAnimations().map(V.describeAnimation)
  V.pseudoAnimations = () => V.animations().filter((animation) => !!animation.pseudoElement)
  V.pluginAnimations = () => V.animations().filter((animation) => animation.pluginOwned)
  V.runningPluginAnimations = () => V.pluginAnimations().filter((animation) => animation.playState === 'running')

  V.pseudoFirst = () => (V.watch && V.watch.pseudoFirst ? V.watch.pseudoFirst : null)

  V.computed = (selector, pseudo) => {
    const element = document.querySelector(selector)
    if (!element) return { found: false, selector, pseudo: pseudo || null }
    const cs = getComputedStyle(element, pseudo || undefined)
    return {
      found: true,
      selector,
      pseudo: pseudo || null,
      transitionProperty: cs.transitionProperty,
      transitionDuration: cs.transitionDuration,
      transitionDelay: cs.transitionDelay,
      transitionTimingFunction: cs.transitionTimingFunction,
      animationName: cs.animationName,
      animationDuration: cs.animationDuration,
      animationTimingFunction: cs.animationTimingFunction,
      animationIterationCount: cs.animationIterationCount,
      animationDelay: cs.animationDelay,
      opacity: cs.opacity,
      transform: cs.transform,
      width: cs.width,
      backgroundColor: cs.backgroundColor,
      outlineColor: cs.outlineColor,
      viewTransitionName: cs.viewTransitionName,
      pointerEvents: cs.pointerEvents,
      inertAttr: element.hasAttribute('inert'),
      attrs: Array.from(element.attributes || []).reduce((out, attr) => {
        if (String(attr.name).indexOf('data-') === 0) out[attr.name] = attr.value
        return out
      }, {}),
    }
  }

  V.geometry = () => {
    const stage = V.stageEl()
    const frames = V.frames()
    const focus = frames.find((frame) => frame.mode === 'focus') || null
    const candidates = frames.filter((frame) => frame.mode === 'candidate')
    const snapshot = V.snapshot()
    return {
      at: round(performance.now()),
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      stage: V.rectOf(stage),
      focus,
      candidates,
      frames,
      layout: V.layout(),
      snapshot: {
        mounted: snapshot.mounted,
        focusId: snapshot.focusId,
        candidates: snapshot.candidates,
        railCollapsed: snapshot.railCollapsed,
        dom: snapshot.dom,
        previewMode: snapshot.previewMode,
      },
      motion: V.motion(),
      attribute: document.documentElement.getAttribute('data-onestep-motion'),
      dom: {
        stageCount: document.querySelectorAll('[data-onestep-stage]').length,
        frameCount: frames.length,
        animationCount: document.getAnimations().length,
        vtPseudoCount: V.pseudoAnimations().length,
        floatCount: document.querySelectorAll('[data-dockkit-float]').length,
        peekTagCount: document.querySelectorAll('[data-onestep-peek-tag]').length,
        pickerCount: document.querySelectorAll('[data-onestep-picker]').length,
        menuCount: document.querySelectorAll('.onestep-menu').length,
        toastCount: document.querySelectorAll('.onestep-toast').length,
        bubbleCount: document.querySelectorAll('.onestep-bubble').length,
        hudCount: document.querySelectorAll('[data-onestep-drag-hud],[data-onestep-drag-rail]').length,
      },
    }
  }

  /** VT 命名唯一性：扫描所有元素解析后的 view-transition-name。 */
  V.naming = () => {
    const list = []
    for (const element of document.querySelectorAll('*')) {
      let name = ''
      try {
        name = getComputedStyle(element).viewTransitionName || 'none'
      } catch (error) {
        continue
      }
      if (!name || name === 'none') continue
      list.push({
        name,
        tag: element.tagName,
        cls: String(element.className || '').slice(0, 120),
        sessionId: element.getAttribute('data-onestep-window-session'),
        mode: element.getAttribute('data-mode'),
        inline: element.style.getPropertyValue('view-transition-name') || null,
      })
    }
    const counts = {}
    const duplicates = []
    for (const item of list) {
      counts[item.name] = (counts[item.name] || 0) + 1
      if (counts[item.name] === 2) duplicates.push(item.name)
    }
    return { count: list.length, names: list, duplicates }
  }

  /** 插件自有 infinite 动画（运行中 + 计算样式两路）。 */
  V.pluginInfinite = () => {
    const animations = V.pluginAnimations().filter((animation) => animation.iterations === 'infinite')
    const styles = []
    for (const element of document.querySelectorAll('[data-onestep-stage], [data-onestep-stage] *, [data-onestep-picker], [data-onestep-picker] *, [data-onestep-peek-layer], [data-onestep-peek-layer] *, .onestep-toast, .onestep-menu, .onestep-quick, .onestep-bubble, .onestep-hud-zone')) {
      if (!pluginOwnedTarget(element)) continue
      const cs = getComputedStyle(element)
      const iteration = String(cs.animationIterationCount || '')
      if (!iteration || iteration === 'none') continue
      if (iteration.split(',').every((part) => part.trim() === '1' || part.trim() === '0')) continue
      styles.push({
        tag: element.tagName,
        cls: String(element.className || '').slice(0, 120),
        animationName: cs.animationName,
        animationDuration: cs.animationDuration,
        animationIterationCount: iteration,
      })
    }
    return { animations, styles, count: animations.length + styles.length }
  }

  /** 关键帧：暂停所有 VT 伪元素动画并 seek 到 t。 */
  V.pausePseudo = (t) => {
    V.paused = document.getAnimations().filter((animation) => animation.effect && animation.effect.pseudoElement)
    const applied = []
    for (const animation of V.paused) {
      try {
        animation.pause()
        if (typeof t === 'number') animation.currentTime = t
        applied.push({ pseudoElement: animation.effect.pseudoElement, currentTime: round(animation.currentTime), playState: animation.playState })
      } catch (error) {
        applied.push({ pseudoElement: animation.effect && animation.effect.pseudoElement, error: String(error) })
      }
    }
    return { at: t, count: V.paused.length, applied }
  }
  V.seekPseudo = (t) => {
    for (const animation of V.paused || []) {
      try {
        animation.currentTime = t
      } catch (error) {
        /* ignore */
      }
    }
    return { at: t, count: (V.paused || []).length }
  }
  V.pausedCount = () => (V.paused || []).length
  V.resumePseudo = () => {
    const list = V.paused || []
    for (const animation of list) {
      try {
        animation.play()
      } catch (error) {
        /* ignore */
      }
    }
    V.paused = null
    return list.length
  }

  /** 等待动作/动画静默（控制器空闲 + 无 VT 伪元素动画）。 */
  V.waitMotionIdle = (timeoutMs) => new Promise((resolve) => {
    const limit = timeoutMs === undefined ? 15000 : timeoutMs
    const started = performance.now()
    const tick = () => {
      const motion = V.motion()
      const controller = motion && motion.controller
      const idle = !!controller && controller.active === false && controller.activeState === 'idle' && V.pseudoAnimations().length === 0
      if (idle) {
        resolve({ ok: true, waitedMs: round(performance.now() - started) })
        return
      }
      if (performance.now() - started > limit) {
        resolve({ ok: false, waitedMs: round(performance.now() - started), motion, pseudo: V.pseudoAnimations().length })
        return
      }
      setTimeout(tick, 30)
    }
    tick()
  })

  /** VT 观察器：包装 startViewTransition，记录 ready/callback/finished 分相 + 伪元素首帧 + longtask。 */
  V.startVtWatch = (label) => {
    V.stopVtWatch()
    const watch = {
      label: label || 'vt',
      startedMs: round(performance.now()),
      calls: [],
      pseudoSeen: [],
      pseudoFirst: null,
      longtasks: [],
      previewFlips: [],
      thumbAdds: [],
      running: true,
      original: typeof document.startViewTransition === 'function' ? document.startViewTransition.bind(document) : null,
      supported: typeof document.startViewTransition === 'function',
    }
    V.watch = watch
    if (!watch.supported) return { supported: false, label: watch.label }
    document.startViewTransition = (callback) => {
      const call = {
        index: watch.calls.length,
        startedMs: round(performance.now()),
        callbackStartMs: null,
        callbackEndMs: null,
        callbackDurationMs: null,
        readyMs: null,
        readyDelayMs: null,
        finishedMs: null,
        totalMs: null,
        error: null,
      }
      watch.calls.push(call)
      const wrapped = async () => {
        call.callbackStartMs = round(performance.now())
        try {
          return await callback()
        } finally {
          call.callbackEndMs = round(performance.now())
          call.callbackDurationMs = round(call.callbackEndMs - call.callbackStartMs)
        }
      }
      let vt = null
      try {
        vt = watch.original(wrapped)
      } catch (error) {
        call.error = 'start-threw:' + String((error && error.message) || error)
        throw error
      }
      if (vt && vt.ready) {
        Promise.resolve(vt.ready).then(() => {
          call.readyMs = round(performance.now())
          call.readyDelayMs = round(call.readyMs - call.startedMs)
        }).catch((error) => {
          call.error = 'ready:' + String((error && error.message) || error)
        })
      }
      if (vt && vt.finished) {
        Promise.resolve(vt.finished).then(() => {
          call.finishedMs = round(performance.now())
          call.totalMs = round(call.finishedMs - call.startedMs)
        }).catch((error) => {
          call.error = 'finished:' + String((error && error.message) || error)
        })
      }
      return vt
    }
    const pushPseudo = () => {
      const pseudo = V.pseudoAnimations()
      if (pseudo.length > 0 && !watch.pseudoFirst) {
        watch.pseudoFirst = {
          atMs: round(performance.now() - watch.startedMs),
          items: pseudo.map((animation) => ({
            pseudoElement: animation.pseudoElement,
            duration: animation.duration,
            delay: animation.delay,
            easing: animation.easing,
            playState: animation.playState,
            currentTime: animation.currentTime,
          })),
        }
      }
      if (pseudo.length > 0) {
        watch.pseudoSeen.push({ atMs: round(performance.now() - watch.startedMs), count: pseudo.length })
      }
    }
    const tick = () => {
      if (!watch.running) return
      pushPseudo()
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    try {
      watch.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          watch.longtasks.push({ start: round(entry.startTime), duration: round(entry.duration), name: entry.name })
        }
      })
      watch.observer.observe({ entryTypes: ['longtask'] })
    } catch (error) {
      watch.observerError = String(error)
    }
    // P4 卡顿回归：记录候场卡 data-preview 切换与 live 缩略节点新增时刻（绝对 performance.now）。
    try {
      watch.domObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'attributes' && mutation.attributeName === 'data-preview') {
            watch.previewFlips.push({
              atMs: round(performance.now()),
              value: mutation.target.getAttribute('data-preview'),
              sessionId: mutation.target.getAttribute('data-onestep-window-session'),
            })
          } else if (mutation.type === 'childList') {
            for (const node of mutation.addedNodes) {
              if (node.nodeType !== 1) continue
              const isThumb = (typeof node.matches === 'function' && node.matches('[data-onestep-thumb]'))
                || (typeof node.querySelector === 'function' && !!node.querySelector('[data-onestep-thumb]'))
              if (isThumb) watch.thumbAdds.push({ atMs: round(performance.now()) })
            }
          }
        }
      })
      const stage = document.querySelector('[data-onestep-stage]')
      if (stage) watch.domObserver.observe(stage, { subtree: true, attributes: true, attributeFilter: ['data-preview'], childList: true })
    } catch (error) {
      watch.domObserverError = String(error)
    }
    return { supported: true, label: watch.label }
  }
  V.stopVtWatch = () => {
    const watch = V.watch
    if (!watch) return null
    watch.running = false
    watch.endedMs = round(performance.now())
    try {
      if (watch.observer) watch.observer.disconnect()
    } catch (error) {
      /* ignore */
    }
    try {
      if (watch.domObserver) watch.domObserver.disconnect()
    } catch (error) {
      /* ignore */
    }
    try {
      if (watch.original) document.startViewTransition = watch.original
    } catch (error) {
      /* ignore */
    }
    V.watch = null
    return watch
  }

  /** 简单的 VT 调用计数器（reduced 断言：VT 调用数必须为 0）。 */
  V.installVtCounter = () => {
    if (V.counter) return { installed: true, reused: true, supported: V.counter.supported }
    const counter = {
      count: 0,
      calls: [],
      supported: typeof document.startViewTransition === 'function',
      original: typeof document.startViewTransition === 'function' ? document.startViewTransition.bind(document) : null,
    }
    V.counter = counter
    if (!counter.supported) return { installed: true, supported: false, count: 0 }
    document.startViewTransition = (callback) => {
      counter.count += 1
      counter.calls.push({ at: round(performance.now()) })
      return counter.original(callback)
    }
    return { installed: true, supported: true, count: 0 }
  }
  V.vtCalls = () => (V.counter ? { installed: true, count: V.counter.count, calls: V.counter.calls.slice() } : { installed: false, count: 0, calls: [] })
  V.uninstallVtCounter = () => {
    if (V.counter && V.counter.original) {
      try {
        document.startViewTransition = V.counter.original
      } catch (error) {
        /* ignore */
      }
    }
    V.counter = null
    return true
  }

  /** rAF + longtask 采样（性能用例）。 */
  V.startRafSampling = (label) => {
    if (V.sampling) V.stopRafSampling()
    const sampling = {
      label: label || 'sample',
      running: true,
      frames: [],
      longtasks: [],
      startedMs: round(performance.now()),
      supportedLongtask: typeof PerformanceObserver !== 'undefined' && Array.isArray(PerformanceObserver.supportedEntryTypes) && PerformanceObserver.supportedEntryTypes.indexOf('longtask') >= 0,
    }
    const tick = (ts) => {
      if (!sampling.running) return
      sampling.frames.push(round(ts, 3))
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    try {
      sampling.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) sampling.longtasks.push({ start: round(entry.startTime), duration: round(entry.duration) })
      })
      sampling.observer.observe({ entryTypes: ['longtask'] })
    } catch (error) {
      sampling.observerError = String(error)
    }
    V.sampling = sampling
    return { label: sampling.label, startedMs: sampling.startedMs, supportedLongtask: sampling.supportedLongtask }
  }
  V.stopRafSampling = () => {
    const sampling = V.sampling
    if (!sampling) return null
    sampling.running = false
    sampling.endedMs = round(performance.now())
    try {
      if (sampling.observer) sampling.observer.disconnect()
    } catch (error) {
      /* ignore */
    }
    V.sampling = null
    return {
      label: sampling.label,
      startedMs: sampling.startedMs,
      endedMs: sampling.endedMs,
      frames: sampling.frames,
      longtasks: sampling.longtasks,
      supportedLongtask: sampling.supportedLongtask,
      observerError: sampling.observerError || null,
    }
  }
  V.idleSample = (durationMs) => new Promise((resolve) => {
    const duration = durationMs === undefined ? 2000 : durationMs
    const frames = []
    const longtasks = []
    const startedAt = performance.now()
    let observer = null
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longtasks.push({ start: round(entry.startTime), duration: round(entry.duration) })
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch (error) {
      /* ignore */
    }
    const tick = (ts) => {
      frames.push(round(ts, 3))
      if (performance.now() - startedAt < duration) {
        requestAnimationFrame(tick)
        return
      }
      try {
        if (observer) observer.disconnect()
      } catch (error) {
        /* ignore */
      }
      resolve({ frames, longtasks, durationMs: round(performance.now() - startedAt) })
    }
    requestAnimationFrame(tick)
  })

  /** 对照组：空回调 VT（临时命名节点 + 只改 transform），测量长任务与 ready 开销。 */
  V.emptyVtControl = () => new Promise((resolve) => {
    if (typeof document.startViewTransition !== 'function') {
      resolve({ supported: false, longtasks: [], calls: [] })
      return
    }
    const node = document.createElement('div')
    node.setAttribute('data-onestep-verify-control', '1')
    node.style.cssText = 'position:fixed;left:8px;top:8px;width:24px;height:24px;background:rgb(12,20,32);z-index:2147483646;view-transition-name:onestep-verify-control;pointer-events:none'
    document.body.appendChild(node)
    const longtasks = []
    let observer = null
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longtasks.push({ start: round(entry.startTime), duration: round(entry.duration) })
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch (error) {
      /* ignore */
    }
    const call = { startedMs: round(performance.now()), callbackStartMs: null, callbackEndMs: null, callbackDurationMs: null, readyMs: null, readyDelayMs: null, finishedMs: null, totalMs: null }
    const original = document.startViewTransition.bind(document)
    const cleanup = () => {
      try {
        if (observer) observer.disconnect()
      } catch (error) {
        /* ignore */
      }
      try {
        node.remove()
      } catch (error) {
        /* ignore */
      }
    }
    document.startViewTransition = (callback) => {
      const wrapped = async () => {
        call.callbackStartMs = round(performance.now())
        try {
          return await callback()
        } finally {
          call.callbackEndMs = round(performance.now())
          call.callbackDurationMs = round(call.callbackEndMs - call.callbackStartMs)
        }
      }
      const vt = original(wrapped)
      Promise.resolve(vt.ready).then(() => {
        call.readyMs = round(performance.now())
        call.readyDelayMs = round(call.readyMs - call.startedMs)
      }).catch(() => {})
      Promise.resolve(vt.finished).then(() => {
        call.finishedMs = round(performance.now())
        call.totalMs = round(call.finishedMs - call.startedMs)
      }).catch(() => {}).finally(() => {
        try {
          document.startViewTransition = original
        } catch (error) {
          /* ignore */
        }
        cleanup()
        resolve({ supported: true, longtasks, calls: [call] })
      })
      return vt
    }
    document.startViewTransition(async () => {
      node.style.transform = 'translateX(12px)'
    })
  })

  /** 动画名称观察器（舞台进场等一次性动画）。 */
  V.startAnimationWatcher = () => {
    const watcher = { running: true, seen: {}, startedMs: round(performance.now()) }
    V.animationWatcher = watcher
    const tick = () => {
      if (!watcher.running) return
      for (const animation of V.animations()) {
        const name = animation.animationName
        if (!name || watcher.seen[name]) continue
        watcher.seen[name] = { name, duration: animation.duration, delay: animation.delay, pseudoElement: animation.pseudoElement, atMs: round(performance.now() - watcher.startedMs), target: animation.target }
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return { started: true }
  }
  V.stopAnimationWatcher = () => {
    const watcher = V.animationWatcher
    if (!watcher) return { seen: {}, elapsedMs: 0 }
    watcher.running = false
    V.animationWatcher = null
    return { seen: watcher.seen, elapsedMs: round(performance.now() - watcher.startedMs) }
  }

  /** 官方浮窗收起/恢复采样。 */
  V.floats = () => Array.from(document.querySelectorAll('[data-dockkit-float]')).map((element) => {
    const cs = getComputedStyle(element)
    return {
      tabId: element.getAttribute('data-dockkit-content'),
      paneId: element.getAttribute('data-dockkit-float'),
      rect: V.rectOf(element),
      peeked: element.getAttribute('data-onestep-peek') === '1',
      restoring: element.getAttribute('data-onestep-peek-restoring') === '1',
      inert: element.hasAttribute('inert'),
      ariaHidden: element.getAttribute('aria-hidden'),
      transform: cs.transform,
      transitionProperty: cs.transitionProperty,
      transitionDuration: cs.transitionDuration,
      transitionTimingFunction: cs.transitionTimingFunction,
      pointerEvents: cs.pointerEvents,
      zIndex: cs.zIndex,
    }
  })
  V.peekTags = () => Array.from(document.querySelectorAll('[data-onestep-peek-tag]')).map((element) => {
    const label = element.querySelector('.onestep-peek-label')
    const rect = element.getBoundingClientRect()
    return {
      tabId: element.getAttribute('data-onestep-peek-tag'),
      rect: V.rectOf(element),
      width: round(rect.width),
      height: round(rect.height),
      labelOpacity: label ? getComputedStyle(label).opacity : null,
      labelTransform: label ? getComputedStyle(label).transform : null,
      labelMaxWidth: label ? getComputedStyle(label).maxWidth : null,
      transitionDuration: getComputedStyle(element).transitionDuration,
      transitionProperty: getComputedStyle(element).transitionProperty,
      zIndex: getComputedStyle(element).zIndex,
    }
  })
  V.peekLayer = () => {
    const layer = document.querySelector('[data-onestep-peek-layer]')
    return layer ? { rect: V.rectOf(layer), zIndex: getComputedStyle(layer).zIndex } : null
  }
  /** 在舞台元素上派发 pointerdown（产品路径：点击浮窗外收起）。 */
  V.stagePointerDown = () => {
    const stage = V.stageEl()
    if (!stage) return { ok: false, reason: 'no-stage' }
    stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
    return { ok: true }
  }
  /** 连续采样浮窗 transition（含触发瞬间）。trigger: 'none' | 'stage-pointerdown' */
  V.sampleFloatsFor = (durationMs, trigger) => new Promise((resolve) => {
    const duration = durationMs === undefined ? 320 : durationMs
    const samples = []
    const before = V.floats()
    const startedAt = performance.now()
    if (trigger === 'stage-pointerdown') V.stagePointerDown()
    const tick = () => {
      samples.push({ t: round(performance.now() - startedAt), floats: V.floats() })
      if (performance.now() - startedAt < duration) {
        requestAnimationFrame(tick)
        return
      }
      resolve({ before, samples, endedAt: round(performance.now() - startedAt) })
    }
    requestAnimationFrame(tick)
  })

  /** 读取当前样式表里命中的规则文本（静态+computed 混合断言用）。 */
  V.cssRulesMatching = (substring) => {
    const hits = []
    const visit = (rules) => {
      for (const rule of Array.from(rules || [])) {
        if (rule.cssRules && rule.cssRules.length) visit(rule.cssRules)
        if (rule.cssText && String(rule.cssText).indexOf(substring) >= 0) hits.push(rule.cssText.slice(0, 600))
      }
    }
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        visit(sheet.cssRules)
      } catch (error) {
        /* 跨域样式表忽略 */
      }
    }
    return hits
  }

  /** documentElement 上残留的 :root 临时变量。 */
  V.rootVars = () => {
    const style = document.documentElement.style
    const vars = {}
    for (let index = 0; index < style.length; index += 1) {
      const name = style.item(index)
      if (name.indexOf('--onestep-vt-') === 0) vars[name] = style.getPropertyValue(name)
    }
    return vars
  }
  /** 元素内联 view-transition-name（Q2 临时命名）残留。 */
  V.inlineVtNames = () => Array.from(document.querySelectorAll('[style*="view-transition-name"]')).map((element) => ({
    tag: element.tagName,
    cls: String(element.className || '').slice(0, 120),
    inline: element.style.getPropertyValue('view-transition-name') || null,
    priority: element.style.getPropertyPriority('view-transition-name') || null,
  }))

  /** 等 html 属性/模式达到期望（reduced 用例）。 */
  V.waitMotionMode = (expected, timeoutMs) => new Promise((resolve) => {
    const limit = timeoutMs === undefined ? 6000 : timeoutMs
    const started = performance.now()
    const tick = () => {
      const motion = V.motion()
      const attribute = document.documentElement.getAttribute('data-onestep-motion')
      const mode = motion && motion.mode
      const ok = (!expected || expected.mode === undefined || mode === expected.mode) && (!expected || expected.attribute === undefined || attribute === expected.attribute)
      if (ok) {
        resolve({ ok: true, motion, attribute, waitedMs: round(performance.now() - started) })
        return
      }
      if (performance.now() - started > limit) {
        resolve({ ok: false, motion, attribute, waitedMs: round(performance.now() - started) })
        return
      }
      setTimeout(tick, 40)
    }
    tick()
  })

  window.__V = V
  return { installed: true, version: V.version }
}

/** 页面内等待 reduced/attr 模式（Node 包装）。 */
export async function waitMotionMode(page, expected, timeout = 8000) {
  const result = await page.evaluate(({ mode, attribute, timeoutMs }) => window.__V.waitMotionMode({ mode, attribute }, timeoutMs), { ...expected, timeoutMs: timeout })
  if (!result || result.ok !== true) throw new Error('waitMotionMode timeout: ' + JSON.stringify(result).slice(0, 800))
  return result
}

/**
 * 重新加载页面并等应用/探针就绪（持久化用例）。
 * 注意：reload 后官方主绑定可能处于「父会话已离线」的重连态（composer disabled），
 * 这里只要求 composer 挂载（attached）+ 插件探针面就绪，不要求可输入。
 */
export async function reloadApp(page, options = {}) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForSelector('[role="textbox"], [contenteditable="true"]', { state: 'attached', timeout: 90000 })
  await page.waitForFunction(() => !!window.__ONESTEP__ && !!window.__ONESTEP__.actions, null, { timeout: 60000 })
  await page.waitForFunction(() => {
    try {
      return !!window.__ONESTEP__.actions.motionState()
    } catch (error) {
      return false
    }
  }, null, { timeout: 30000 })
  await sleep(options.settleMs === undefined ? 1800 : options.settleMs)
  await page.evaluate(installRuntime)
}

/** 汇总 suite：捕获 fatal 并写盘；调用方在 finally 里执行。 */
export function finishSuite(results, error) {
  if (error) results.fatal(error)
  return results.finish()
}

/** 控制台/页面错误断言。 */
export function assertNoPageErrors(results, handles, prefix) {
  const pageErrors = handles && handles.pageErrors ? handles.pageErrors : []
  const consoleErrors = handles && handles.consoleErrors ? handles.consoleErrors : []
  results.assert(prefix + '.no-pageerror', pageErrors.length === 0, {
    category: 'runtime',
    expected: '0 pageerror',
    actual: pageErrors,
  })
  const ownErrors = consoleErrors.filter((text) => String(text).indexOf('onestep') >= 0)
  results.assert(prefix + '.no-plugin-console-error', ownErrors.length === 0, {
    category: 'runtime',
    expected: '0 条插件 console.error',
    actual: ownErrors,
  })
  results.captureErrors(handles)
}

/** 汇总某元素当前 CSS animation 时长是否包含期望值（'0.12s' 等）。 */
export function durationIncludes(value, expected) {
  return String(value || '').split(',').map((part) => part.trim()).includes(expected)
}
