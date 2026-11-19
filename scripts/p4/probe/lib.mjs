/**
 * P4-1 动效探针共享库（motion-probe）。
 *
 * 职责：
 * - 复用 P3 探针链路（readServerUrl / openApp / closeApp / enterStage / actionCall / p3Call / rafSample）；
 * - P4 产物路径与结果记录（artifacts/p4/probe/**；截图 artifacts/p4/probe/shots/）；
 * - 统计（帧间隔 P50/P95/max、长任务、几何偏差）；
 * - 浏览器侧运行时 window.__P4：命名注入、VT 包装计时（ready/finished/callback 分相）、
 *   getAnimations 伪元素采样、暂停+seek 关键帧、rAF 帧采样、longtask 观察器。
 *
 * 边界：只读产品源码/构建产物；只写 artifacts/p4/probe/**。
 * 关键经验（Lead 冒烟 + docs/p4-plan.md §4.2）：
 * - VT 更新回调内 await requestAnimationFrame 会死锁（渲染暂停）→ 提交等待一律用宏任务轮询
 *   （setTimeout(0) 谓词轮询，上限 150ms），禁止在回调内 await rAF/ResizeObserver。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import {
  ROOT,
  sleep,
  readServerUrl,
  openApp,
  closeApp,
  enterStage,
  actionCall,
  p3Call,
  rafSample,
  listSessions,
  fileAddress,
  waitFor,
  stageSnapshot,
  stageLayout,
  normalizeRect,
  rectDeviation,
  baselineInfo,
  Results,
} from '../../p3/probe/lib.mjs'

export {
  ROOT,
  sleep,
  readServerUrl,
  openApp,
  closeApp,
  enterStage,
  actionCall,
  p3Call,
  rafSample,
  listSessions,
  fileAddress,
  waitFor,
  stageSnapshot,
  stageLayout,
  normalizeRect,
  rectDeviation,
  baselineInfo,
  Results,
}

export const OUT = path.join(ROOT, 'artifacts', 'p4', 'probe')
export const SHOTS = path.join(OUT, 'shots')
export const URL_FILE_REL = 'artifacts/p3/server-url.txt'

export function ensureDirs() {
  fs.mkdirSync(SHOTS, { recursive: true })
}

export function relPath(abs) {
  return path.relative(ROOT, abs).replace(/\\/g, '/')
}

export function writeJson(file, data) {
  ensureDirs()
  const target = path.isAbsolute(file) ? file : path.join(OUT, file)
  fs.writeFileSync(target, JSON.stringify(data, null, 2) + '\n', 'utf8')
  return target
}

/** P4 结果记录器：JSON 写 artifacts/p4/probe/<suite>.json，截图写 artifacts/p4/probe/shots/。 */
export function createResults(suite, title) {
  ensureDirs()
  const results = new Results(suite, title, path.join(OUT, suite + '.json'))
  results.data.p4 = {
    urlFile: URL_FILE_REL,
    shotsDir: 'artifacts/p4/probe/shots',
    rerun: 'node scripts/p4/probe/' + suite + '.mjs',
  }
  return results
}

function round(value, digits = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 数字统计（P50/P95/max；空数组返回 null 字段）。 */
export function stats(values) {
  const list = (values || []).filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (list.length === 0) return { count: 0, min: null, p50: null, p95: null, max: null, mean: null }
  const pick = (q) => {
    if (list.length === 1) return list[0]
    const index = Math.min(list.length - 1, Math.max(0, Math.ceil(q * list.length) - 1))
    return list[index]
  }
  const sum = list.reduce((acc, value) => acc + value, 0)
  return {
    count: list.length,
    min: round(list[0]),
    p50: round(pick(0.5)),
    p95: round(pick(0.95)),
    max: round(list[list.length - 1]),
    mean: round(sum / list.length),
  }
}

/**
 * rAF 帧间隔分析：把间隔分相为 callback（VT 更新回调期间渲染暂停）与 animation。
 * @param {{frames:number[], callbackSpans:{start:number,end:number}[]}} input
 * @returns {{intervals:number[], animation:number[], callbackGap:number[], p95:number|null, max:number|null, over50:number, over100:number}}
 */
export function analyzeFrameIntervals(input) {
  const frames = input.frames || []
  const spans = (input.callbackSpans || []).filter((span) => span && typeof span.start === 'number' && typeof span.end === 'number')
  const all = []
  const animation = []
  const callbackGap = []
  for (let index = 1; index < frames.length; index += 1) {
    const prev = frames[index - 1]
    const cur = frames[index]
    const delta = cur - prev
    if (!(delta > 0)) continue
    const overlaps = spans.some((span) => cur >= span.start && prev <= span.end)
    all.push(round(delta))
    if (overlaps) callbackGap.push(round(delta))
    else animation.push(round(delta))
  }
  return {
    intervals: all,
    animation,
    callbackGap,
    animationStats: stats(animation),
    callbackStats: stats(callbackGap),
    p95: stats(animation).p95,
    max: stats(animation).max,
    over50: animation.filter((value) => value > 50).length,
    over100: animation.filter((value) => value > 100).length,
  }
}

/* ========================================================================== *
 * PNG 解码 / 像素区域对比（关键帧遮挡判定用；Playwright 截图 = RGBA8 非隔行）
 * ========================================================================== */

export function decodePng(buffer) {
  if (!buffer || buffer.length < 33) throw new Error('decodePng: empty buffer')
  const signature = buffer.subarray(0, 8)
  const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!signature.equals(expected)) throw new Error('decodePng: not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1')
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
    throw new Error('decodePng: unsupported format bitDepth=' + bitDepth + ' colorType=' + colorType + ' interlace=' + interlace)
  }
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(width * height * channels)
  let prevRow = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const rowRaw = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const row = Buffer.from(rowRaw)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? row[x - channels] : 0
      const b = prevRow[x]
      const c = x >= channels ? prevRow[x - channels] : 0
      let value = row[x]
      if (filter === 1) value = (value + a) & 0xff
      else if (filter === 2) value = (value + b) & 0xff
      else if (filter === 3) value = (value + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        value = (value + predictor) & 0xff
      }
      row[x] = value
    }
    row.copy(out, y * stride)
    prevRow = row
  }
  return { width, height, channels, data: out }
}

export function pixelAt(image, x, y) {
  const px = Math.max(0, Math.min(image.width - 1, Math.round(x)))
  const py = Math.max(0, Math.min(image.height - 1, Math.round(y)))
  const index = (py * image.width + px) * image.channels
  return { r: image.data[index], g: image.data[index + 1], b: image.data[index + 2], a: image.channels === 4 ? image.data[index + 3] : 255 }
}

/** 整图基础统计（白屏/黑屏判别用）：亮度均值/标准差、纯白/纯黑像素比例、唯一颜色采样数。 */
export function imageStats(image, options = {}) {
  const step = options.step || 3
  const lum = []
  let white = 0
  let black = 0
  let count = 0
  const colors = new Set()
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const pixel = pixelAt(image, x, y)
      const value = 0.2126 * pixel.r + 0.7152 * pixel.g + 0.0722 * pixel.b
      lum.push(value)
      if (pixel.r > 248 && pixel.g > 248 && pixel.b > 248) white += 1
      if (pixel.r < 8 && pixel.g < 8 && pixel.b < 8) black += 1
      if (colors.size < 512) colors.add((pixel.r >> 3) + ',' + (pixel.g >> 3) + ',' + (pixel.b >> 3))
      count += 1
    }
  }
  const mean = lum.reduce((sum, value) => sum + value, 0) / Math.max(1, lum.length)
  const variance = lum.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, lum.length)
  return {
    width: image.width,
    height: image.height,
    sampled: count,
    meanLuminance: Math.round(mean * 100) / 100,
    stdLuminance: Math.round(Math.sqrt(variance) * 100) / 100,
    whiteFraction: count ? Math.round((white / count) * 10000) / 10000 : null,
    blackFraction: count ? Math.round((black / count) * 10000) / 10000 : null,
    sampledColorBuckets: colors.size,
  }
}

/** 两个同尺寸截图的区域差异（CSS px 矩形；默认全图）。 */
export function regionDiff(imageA, imageB, rect, options = {}) {
  const tolerance = options.tolerance === undefined ? 10 : options.tolerance
  const step = options.step || 2
  const minX = Math.max(0, Math.round(rect ? rect.x : 0))
  const minY = Math.max(0, Math.round(rect ? rect.y : 0))
  const maxX = Math.min(imageA.width, Math.round(rect ? rect.x + rect.w : imageA.width))
  const maxY = Math.min(imageA.height, Math.round(rect ? rect.y + rect.h : imageA.height))
  let count = 0
  let changed = 0
  let sumAbs = 0
  let maxAbs = 0
  const samples = []
  for (let y = minY; y < maxY; y += step) {
    for (let x = minX; x < maxX; x += step) {
      const a = pixelAt(imageA, x, y)
      const b = pixelAt(imageB, x, y)
      const diff = (Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)) / 3
      count += 1
      sumAbs += diff
      maxAbs = Math.max(maxAbs, diff)
      if (diff > tolerance) changed += 1
      if (samples.length < 12) samples.push({ x, y, a: [a.r, a.g, a.b], b: [b.r, b.g, b.b], diff: round(diff) })
    }
  }
  return {
    rect: rect || { x: 0, y: 0, w: imageA.width, h: imageA.height },
    pixels: count,
    changed,
    changedFraction: count ? round(changed / count, 4) : null,
    meanAbsDiff: count ? round(sumAbs / count) : null,
    maxAbsDiff: round(maxAbs),
    samples,
  }
}

/* ========================================================================== *
 * 浏览器侧运行时 window.__P4（自包含：page.evaluate 序列化后执行）
 * ========================================================================== */

/**
 * 安装 window.__P4 运行时。注意：本函数会被 Playwright 序列化到页面执行，
 * 因此内部不能引用任何模块作用域变量。
 */
export function installPageRuntime() {
  if (window.__P4 && window.__P4.version === 'p4-runtime-1') return window.__P4
  const R = { version: 'p4-runtime-1' }
  R.records = []
  R.activeVt = null
  R.activeTarget = null
  R.styleEl = null
  R.sampling = null
  R.paused = null
  R.tempNodes = []

  R.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  R.sanitize = (id) => String(id === null || id === undefined ? '' : id).replace(/[^A-Za-z0-9_-]/g, '_')
  R.windowName = (id) => 'onestep-w-' + R.sanitize(id)
  R.round = (value, digits) => {
    const factor = 10 ** (digits === undefined ? 2 : digits)
    return Math.round(value * factor) / factor
  }
  R.rectOf = (el) => {
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { x: R.round(rect.x), y: R.round(rect.y), w: R.round(rect.width), h: R.round(rect.height) }
  }
  R.frameEls = () => Array.from(document.querySelectorAll('[data-onestep-stage] .onestep-frame[data-mode]'))
  R.snapshot = () => {
    try { return window.__ONESTEP__.actions.snapshot() } catch (error) { return { error: String(error) } }
  }
  R.layout = () => {
    try { return window.__ONESTEP__.actions.layout() } catch (error) { return null }
  }
  R.windowEntries = () => R.frameEls().map((el) => ({
    sessionId: el.getAttribute('data-onestep-window-session'),
    mode: el.getAttribute('data-mode'),
    rect: R.rectOf(el),
    vtName: getComputedStyle(el).viewTransitionName,
    inlineName: el.style.getPropertyValue('--onestep-vt-name') || null,
  }))
  R.stageRect = () => R.rectOf(document.querySelector('[data-onestep-stage]'))

  R.vtCss = (opts) => {
    const o = opts || {}
    const ms = o.ms === undefined ? 220 : o.ms
    const fade = o.fade === undefined ? 120 : o.fade
    const delay = o.delay === undefined ? 60 : o.delay
    const reducedBlock = o.reducedSuppression
      ? '@media (prefers-reduced-motion: reduce){::view-transition-group(*),::view-transition-old(*),::view-transition-new(*){animation-duration:.001ms !important;animation-delay:0ms !important}}'
      : ''
    return '.onestep-frame{view-transition-name:var(--onestep-vt-name,none)}' +
      '::view-transition-group(*){animation-duration:' + ms + 'ms;animation-timing-function:cubic-bezier(0.4,0,0.2,1)}' +
      '::view-transition-old(*){animation-duration:' + fade + 'ms}' +
      '::view-transition-new(*){animation-duration:' + fade + 'ms;animation-delay:' + delay + 'ms}' +
      reducedBlock
  }

  R.installVtStyle = (opts) => {
    if (R.styleEl && R.styleEl.parentNode) R.styleEl.parentNode.removeChild(R.styleEl)
    const style = document.createElement('style')
    style.setAttribute('data-p4-vt-style', '1')
    style.textContent = R.vtCss(opts)
    document.head.appendChild(style)
    R.styleEl = style
    return style.textContent.length
  }
  R.removeVtStyle = () => {
    if (R.styleEl && R.styleEl.parentNode) R.styleEl.parentNode.removeChild(R.styleEl)
    R.styleEl = null
  }

  /** 给舞台窗口按 sessionId 注入 --onestep-vt-name，返回名称表与唯一性检查。 */
  R.applyWindowNames = () => {
    const names = {}
    const duplicates = []
    for (const el of R.frameEls()) {
      const id = el.getAttribute('data-onestep-window-session') || ''
      if (!id) continue
      const name = R.windowName(id)
      el.style.setProperty('--onestep-vt-name', name)
      if (names[name]) duplicates.push(name)
      names[name] = id
    }
    return { names, duplicates, entries: R.windowEntries() }
  }
  R.clearWindowNames = () => {
    for (const el of R.frameEls()) el.style.removeProperty('--onestep-vt-name')
    return R.windowEntries().map((entry) => entry.vtName)
  }

  /** Q2 实验：给额外元素（官方浮窗/收起标签）临时命名。返回可还原的清理函数信息。 */
  R.applyExtraNames = (selector, prefix) => {
    const list = []
    const els = Array.from(document.querySelectorAll(selector))
    els.forEach((el, index) => {
      const previous = el.style.getPropertyValue('view-transition-name')
      const name = (prefix || 'onestep-x-') + index
      el.setAttribute('data-p4-vt-extra', String(index))
      el.style.setProperty('view-transition-name', name)
      list.push({ index, name, previous, tag: el.tagName, cls: String(el.className || '').slice(0, 120), rect: R.rectOf(el) })
    })
    return list
  }
  R.clearExtraNames = () => {
    const list = []
    for (const el of Array.from(document.querySelectorAll('[data-p4-vt-extra]'))) {
      const index = el.getAttribute('data-p4-vt-extra')
      el.removeAttribute('data-p4-vt-extra')
      const previous = el.getAttribute('data-p4-vt-extra-previous')
      if (previous) {
        el.style.setProperty('view-transition-name', previous)
        el.removeAttribute('data-p4-vt-extra-previous')
      } else {
        el.style.removeProperty('view-transition-name')
      }
      list.push(index)
    }
    return list
  }

  R.pollUntil = (predicate, timeoutMs) => new Promise((resolve) => {
    const started = performance.now()
    const limit = timeoutMs === undefined ? 150 : timeoutMs
    const tick = () => {
      let value = false
      try { value = predicate() } catch (error) { value = false }
      if (value) { resolve(true); return }
      if (performance.now() - started > limit) { resolve(false); return }
      setTimeout(tick, 4)
    }
    tick()
  })
  /** 宏任务等待（setTimeout(0) 链；VT 更新回调内禁止 rAF）。 */
  R.macroTasks = (count) => {
    const total = Math.max(1, count === undefined ? 2 : count)
    let chain = Promise.resolve()
    for (let index = 0; index < total; index += 1) chain = chain.then(() => R.sleep(0))
    return chain.then(() => true)
  }

  R.summaryAnimations = (includeKeyframes) => document.getAnimations().map((animation) => {
    const effect = animation.effect
    const timing = effect && typeof effect.getTiming === 'function' ? effect.getTiming() : {}
    const target = effect && effect.target && effect.target.nodeType === 1 ? effect.target : null
    let keyframes = null
    if (includeKeyframes) {
      try { keyframes = effect && typeof effect.getKeyframes === 'function' ? effect.getKeyframes() : null } catch (error) { keyframes = null }
    }
    return {
      pseudoElement: effect && effect.pseudoElement ? effect.pseudoElement : null,
      animationName: animation.animationName || null,
      duration: timing.duration,
      delay: timing.delay || 0,
      easing: timing.easing || null,
      iterations: timing.iterations === Infinity ? 'infinite' : timing.iterations,
      fill: timing.fill || null,
      playState: animation.playState,
      currentTime: animation.currentTime === null || animation.currentTime === undefined ? null : R.round(animation.currentTime),
      target: target ? {
        tag: target.tagName,
        cls: String(target.className || '').slice(0, 120),
        mode: target.getAttribute('data-mode'),
        sessionId: target.getAttribute('data-onestep-window-session'),
      } : null,
      keyframes,
    }
  })
  R.vtAnimations = () => document.getAnimations().filter((animation) => animation.effect && animation.effect.pseudoElement)
  R.vtAnimationNames = () => R.vtAnimations().map((animation) => animation.effect.pseudoElement)

  R.geometry = () => {
    const stage = document.querySelector('[data-onestep-stage]')
    const frames = R.windowEntries()
    const snapshot = R.snapshot()
    const layout = R.layout()
    const stageComputed = stage ? getComputedStyle(stage) : null
    return {
      at: R.round(performance.now()),
      visibility: document.visibilityState,
      hidden: document.hidden,
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      scroll: { x: window.scrollX, y: window.scrollY },
      stage: R.rectOf(stage),
      focus: frames.find((entry) => entry.mode === 'focus') || null,
      candidates: frames.filter((entry) => entry.mode === 'candidate'),
      frames,
      snapshot: {
        available: snapshot.available !== false,
        mounted: snapshot.mounted,
        mainReady: snapshot.mainReady,
        focusId: snapshot.focusId,
        candidates: snapshot.candidates,
        railCollapsed: snapshot.railCollapsed,
        rowsTotal: snapshot.rowsTotal,
        dom: snapshot.dom,
        error: snapshot.error || null,
      },
      layout,
      theme: {
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        dataTheme: document.documentElement.getAttribute('data-theme') || document.documentElement.getAttribute('data-ds-theme') || null,
        htmlBg: getComputedStyle(document.documentElement).backgroundColor,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        stageBg: stageComputed ? stageComputed.backgroundColor : null,
        stageTokens: stageComputed ? {
          fast: stageComputed.getPropertyValue('--onestep-fast').trim(),
          base: stageComputed.getPropertyValue('--onestep-base').trim(),
          slow: stageComputed.getPropertyValue('--onestep-slow').trim(),
          ease: stageComputed.getPropertyValue('--onestep-ease').trim(),
        } : null,
      },
      dom: {
        stageCount: document.querySelectorAll('[data-onestep-stage]').length,
        frameCount: frames.length,
        floatCount: document.querySelectorAll('[data-dockkit-float]').length,
        peekTagCount: document.querySelectorAll('[data-onestep-peek-tag]').length,
        animationCount: document.getAnimations().length,
        vtPseudoCount: R.vtAnimations().length,
      },
      activeViewTransition: !!document.activeViewTransition,
    }
  }

  R.floats = () => Array.from(document.querySelectorAll('[data-dockkit-float]')).map((el) => ({
    tabId: el.getAttribute('data-dockkit-content'),
    paneId: el.getAttribute('data-dockkit-float'),
    active: el.hasAttribute('data-dockkit-float-active'),
    rect: R.rectOf(el),
    zIndex: getComputedStyle(el).zIndex,
    peeked: el.getAttribute('data-onestep-peek') === '1',
    display: getComputedStyle(el).display,
    visibility: getComputedStyle(el).visibility,
    opacity: getComputedStyle(el).opacity,
    transform: getComputedStyle(el).transform,
  }))
  R.peekTags = () => Array.from(document.querySelectorAll('[data-onestep-peek-tag]')).map((el) => ({
    tabId: el.getAttribute('data-onestep-peek-tag'),
    rect: R.rectOf(el),
    maxWidth: getComputedStyle(el).maxWidth,
    transitionDuration: getComputedStyle(el).transitionDuration,
    transitionDelay: getComputedStyle(el).transitionDelay,
    background: getComputedStyle(el).backgroundColor,
  }))
  R.peekLayer = () => {
    const layer = document.querySelector('[data-onestep-peek-layer]')
    return layer ? { rect: R.rectOf(layer), zIndex: getComputedStyle(layer).zIndex } : null
  }

  R.startSampling = (label) => {
    if (R.sampling && R.sampling.running) R.stopSampling()
    const sampling = {
      label: label || 'sample',
      running: true,
      frames: [],
      longtasks: [],
      startedMs: performance.now(),
      endedMs: null,
      longtaskSupported: typeof PerformanceObserver !== 'undefined' && Array.isArray(PerformanceObserver.supportedEntryTypes) && PerformanceObserver.supportedEntryTypes.indexOf('longtask') >= 0,
      observerError: null,
    }
    const tick = (ts) => {
      if (!sampling.running) return
      sampling.frames.push(R.round(ts, 3))
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    try {
      sampling.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) sampling.longtasks.push({ start: R.round(entry.startTime, 2), duration: R.round(entry.duration, 2), name: entry.name })
      })
      sampling.observer.observe({ entryTypes: ['longtask'] })
    } catch (error) {
      sampling.observerError = String(error)
    }
    R.sampling = sampling
    return { label: sampling.label, startedMs: R.round(sampling.startedMs), longtaskSupported: sampling.longtaskSupported, observerError: sampling.observerError }
  }
  R.stopSampling = () => {
    const sampling = R.sampling
    if (!sampling) return null
    sampling.running = false
    sampling.endedMs = performance.now()
    try { if (sampling.observer) sampling.observer.disconnect() } catch (error) { /* ignore */ }
    const result = {
      label: sampling.label,
      startedMs: R.round(sampling.startedMs),
      endedMs: R.round(sampling.endedMs),
      frames: sampling.frames,
      longtasks: sampling.longtasks,
      longtaskSupported: sampling.longtaskSupported,
      observerError: sampling.observerError,
    }
    R.sampling = null
    return result
  }

  /**
   * 开始一次 VT morph：包装 document.startViewTransition，记录 callback 分相、ready/finished、
   * 回调内用宏任务轮询 focusSignal 与 DOM 提交（禁止 await rAF）。
   * @param {string} targetId 目标 sessionId
   * @param {{action?:string, focusTimeout?:number, domTimeout?:number, macroTasks?:number}} [opts]
   */
  R.beginMorph = (targetId, opts) => {
    const options = opts || {}
    const record = {
      targetId,
      action: options.action || 'promote',
      label: options.label || null,
      startedMs: R.round(performance.now(), 2),
      callbackStartMs: null,
      callbackEndMs: null,
      callbackDurationMs: null,
      focusPoll: null,
      focusSignalMs: null,
      domPoll: null,
      domCommittedMs: null,
      stageMountMs: null,
      readyMs: null,
      readyWallMs: null,
      finishedMs: null,
      finishedError: null,
      readyError: null,
      actionReturn: null,
      actionError: null,
      animationsAtReady: null,
      animationsBefore: null,
      animationsAfter: null,
      activeVtAtReady: null,
      activeVtAfter: null,
      route: 'vt',
    }
    R.records.push(record)
    R.current = record
    record.animationsBefore = R.summaryAnimations(false)
    let vt = null
    try {
      vt = document.startViewTransition(async () => {
        const callbackStart = performance.now()
        record.callbackStartMs = R.round(callbackStart, 2)
        if (options.noop === true) {
          // 空回调：只测 VT 快照/ready/finished 的固定开销（无状态变化）。
          await R.macroTasks(1)
          record.callbackEndMs = R.round(performance.now(), 2)
          record.callbackDurationMs = R.round(record.callbackEndMs - callbackStart, 2)
          return
        }
        try {
          record.actionReturn = window.__ONESTEP__.actions[record.action](targetId)
        } catch (error) {
          record.actionError = String(error)
        }
        record.focusPoll = await R.pollUntil(() => {
          const snapshot = R.snapshot()
          return snapshot && snapshot.focusId === targetId
        }, options.focusTimeout === undefined ? 150 : options.focusTimeout)
        record.focusSignalMs = R.round(performance.now() - callbackStart, 2)
        record.domPoll = await R.pollUntil(() => {
          const focusEl = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
          return !!focusEl && focusEl.getAttribute('data-onestep-window-session') === targetId
        }, options.domTimeout === undefined ? 100 : options.domTimeout)
        record.domCommittedMs = R.round(performance.now() - callbackStart, 2)
        // 模拟产品渲染期命名：角色互换后按当前 DOM 的 sessionId 重新注入 --onestep-vt-name，
        // 让旧/新快照按同一 sessionId 配对（P4-3 设计：命名随 render 写入）。
        if (options.applyNames !== false) {
          try {
            const applied = R.applyWindowNames()
            record.namesInCallback = { count: Object.keys(applied.names).length, duplicates: applied.duplicates, entries: applied.entries }
          } catch (error) {
            record.namesInCallback = { error: String(error) }
          }
        }
        await R.macroTasks(options.macroTasks === undefined ? 2 : options.macroTasks)
        record.callbackEndMs = R.round(performance.now(), 2)
        record.callbackDurationMs = R.round(record.callbackEndMs - callbackStart, 2)
      })
    } catch (error) {
      record.route = 'error'
      record.error = String(error)
      record.readyError = String(error)
      record.finishedError = String(error)
      return record
    }
    R.activeVt = vt
    R.activeTarget = targetId
    record.vtHasSkip = typeof vt.skipTransition === 'function'
    record.vtReadyIsPromise = !!(vt.ready && typeof vt.ready.then === 'function')
    vt.ready.then(() => {
      record.readyMs = R.round(performance.now() - record.startedMs, 2)
      record.readyWallMs = R.round(performance.now(), 2)
      record.animationsAtReady = R.summaryAnimations(options.includeKeyframes === true)
      record.activeVtAtReady = document.activeViewTransition === vt
    }, (error) => {
      record.readyError = String(error)
      record.readyWallMs = R.round(performance.now(), 2)
    })
    vt.finished.then(() => {
      record.finishedMs = R.round(performance.now() - record.startedMs, 2)
      record.finishedAt = R.round(performance.now(), 2)
      record.animationsAfter = R.summaryAnimations(false)
      record.activeVtAfter = !!document.activeViewTransition
    }, (error) => {
      record.finishedError = String(error)
      record.finishedMs = R.round(performance.now() - record.startedMs, 2)
      record.finishedAt = R.round(performance.now(), 2)
      record.animationsAfter = R.summaryAnimations(false)
      record.activeVtAfter = !!document.activeViewTransition
    })
    vt.finished.catch(() => {}).then(() => {
      if (R.activeVt === vt) {
        R.activeVt = null
        R.activeTarget = null
      }
    })
    return record
  }

  R.waitReady = async (timeoutMs) => {
    const record = R.current
    if (!record) return null
    const started = performance.now()
    const limit = timeoutMs === undefined ? 3000 : timeoutMs
    while (record.readyMs === null && record.readyError === null && record.error === undefined && performance.now() - started < limit) {
      await R.sleep(2)
    }
    return { readyMs: record.readyMs, readyError: record.readyError, error: record.error || null, callbackDurationMs: record.callbackDurationMs }
  }
  R.waitMorph = async (timeoutMs) => {
    const record = R.current
    if (!record) return null
    const started = performance.now()
    const limit = timeoutMs === undefined ? 5000 : timeoutMs
    while (record.finishedMs === null && performance.now() - started < limit) await R.sleep(4)
    await R.sleep(16)
    record.animationsAfterFinal = R.summaryAnimations(false)
    record.activeVtFinal = !!document.activeViewTransition
    return record
  }
  R.morphToFinish = async (targetId, opts) => {
    R.beginMorph(targetId, opts)
    return await R.waitMorph(opts && opts.timeout)
  }

  /**
   * D4 快速连切模拟：VT 进行中收到新请求 → skipTransition() + 立即应用（不排队）。
   * @returns {object} record（route='vt' | 'skipped'）
   */
  R.requestMorph = (targetId, opts) => {
    const options = opts || {}
    if (R.activeVt) {
      const active = R.activeVt
      R.activeVt = null
      const record = {
        targetId,
        action: options.action || 'promote',
        label: options.label || 'sequence',
        route: 'skipped',
        startedMs: R.round(performance.now(), 2),
        skipCalled: true,
        skipError: null,
        actionReturn: null,
        actionError: null,
      }
      try { active.skipTransition() } catch (error) { record.skipError = String(error) }
      try { record.actionReturn = window.__ONESTEP__.actions[record.action](targetId) } catch (error) { record.actionError = String(error) }
      R.records.push(record)
      return record
    }
    const record = R.beginMorph(targetId, Object.assign({}, options, { label: options.label || 'sequence' }))
    record.route = record.error ? 'error' : 'vt'
    return record
  }

  /** 无 VT 基线：量一次官方 promote 的提交延迟（对照 ready 的组成）。 */
  R.baselinePromote = async (targetId) => {
    const started = performance.now()
    const result = { targetId, startedMs: R.round(started, 2), actionReturn: null, actionError: null, focusPoll: null, focusMs: null, domPoll: null, domMs: null, totalMs: null }
    try {
      result.actionReturn = window.__ONESTEP__.actions.promote(targetId)
    } catch (error) {
      result.actionError = String(error)
    }
    result.focusPoll = await R.pollUntil(() => {
      const snapshot = R.snapshot()
      return snapshot && snapshot.focusId === targetId
    }, 400)
    result.focusMs = R.round(performance.now() - started, 2)
    result.domPoll = await R.pollUntil(() => {
      const focusEl = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
      return !!focusEl && focusEl.getAttribute('data-onestep-window-session') === targetId
    }, 300)
    result.domMs = R.round(performance.now() - started, 2)
    await R.sleep(16)
    result.totalMs = R.round(performance.now() - started, 2)
    result.after = R.geometry()
    return result
  }

  /** 等待稳定：focusId 到位 + 动画清零（最多 timeout）。 */
  R.waitSettled = async (targetId, timeoutMs) => {
    const started = performance.now()
    const limit = timeoutMs === undefined ? 2000 : timeoutMs
    let focusOk = false
    while (performance.now() - started < limit) {
      const snapshot = R.snapshot()
      focusOk = !targetId || (snapshot && snapshot.focusId === targetId)
      const pseudoCount = R.vtAnimations().length
      if (focusOk && pseudoCount === 0) break
      await R.sleep(16)
    }
    await R.sleep(32)
    return {
      focusOk,
      pseudoCount: R.vtAnimations().length,
      activeViewTransition: !!document.activeViewTransition,
      waitedMs: R.round(performance.now() - started, 2),
      geometry: R.geometry(),
    }
  }

  /** 官方主绑定切换跟踪：rAF 逐帧记录 focus/candidates/snapshot/pseudo 状态（外部切会话 = 直切证据）。 */
  R.startSwitchTrack = (durationMs) => {
    const track = { running: true, startedMs: performance.now(), durationMs: durationMs || 1200, samples: [] }
    const read = () => {
      const frames = R.windowEntries()
      const focus = frames.find((entry) => entry.mode === 'focus') || null
      let snapshot = null
      try { snapshot = R.snapshot() } catch (error) { snapshot = null }
      return {
        t: R.round(performance.now() - track.startedMs, 1),
        focusSession: focus ? focus.sessionId : null,
        focusRect: focus ? focus.rect : null,
        candidateSessions: frames.filter((entry) => entry.mode === 'candidate').map((entry) => entry.sessionId),
        focusId: snapshot ? snapshot.focusId : null,
        mounted: snapshot ? snapshot.mounted : null,
        pseudoAnimations: R.vtAnimations().length,
        activeViewTransition: !!document.activeViewTransition,
      }
    }
    track.samples.push(read())
    const tick = () => {
      if (!track.running) return
      track.samples.push(read())
      if (performance.now() - track.startedMs < track.durationMs) requestAnimationFrame(tick)
      else track.running = false
    }
    requestAnimationFrame(tick)
    R.switchTrack = track
    return { started: true, durationMs: track.durationMs }
  }
  R.stopSwitchTrack = () => {
    const track = R.switchTrack
    if (!track) return null
    track.running = false
    R.switchTrack = null
    const rectSignature = (sample) => sample.focusRect ? [sample.focusRect.x, sample.focusRect.y, sample.focusRect.w, sample.focusRect.h].join(',') : null
    const candidateSignature = (sample) => (sample.candidateSessions || []).join('|')
    let rectChangeIndex = -1
    let focusIdChangeIndex = -1
    let focusSessionChangeIndex = -1
    let candidateChangeIndex = -1
    let pseudoMax = 0
    let activeMax = 0
    const distinctRects = []
    const distinctFocusSessions = []
    for (let index = 0; index < track.samples.length; index += 1) {
      const sample = track.samples[index]
      pseudoMax = Math.max(pseudoMax, sample.pseudoAnimations)
      if (sample.activeViewTransition) activeMax += 1
      const signature = rectSignature(sample)
      if (distinctRects.length === 0 || distinctRects[distinctRects.length - 1] !== signature) distinctRects.push(signature)
      if (distinctFocusSessions.length === 0 || distinctFocusSessions[distinctFocusSessions.length - 1] !== sample.focusSession) distinctFocusSessions.push(sample.focusSession)
      if (index > 0) {
        if (rectChangeIndex < 0 && rectSignature(track.samples[index - 1]) !== signature) rectChangeIndex = index
        if (focusIdChangeIndex < 0 && track.samples[index - 1].focusId !== sample.focusId) focusIdChangeIndex = index
        if (focusSessionChangeIndex < 0 && track.samples[index - 1].focusSession !== sample.focusSession) focusSessionChangeIndex = index
        if (candidateChangeIndex < 0 && candidateSignature(track.samples[index - 1]) !== candidateSignature(sample)) candidateChangeIndex = index
      }
    }
    const domChangeIndex = [focusSessionChangeIndex, candidateChangeIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0]
    return {
      startedMs: track.startedMs,
      durationMs: track.durationMs,
      sampleCount: track.samples.length,
      samples: track.samples,
      rectChangeIndex,
      focusIdChangeIndex,
      focusSessionChangeIndex,
      candidateChangeIndex,
      domChangeIndex,
      distinctFocusRects: distinctRects,
      distinctFocusSessions,
      pseudoMax,
      activeViewTransitionFrames: activeMax,
      domChangedBeforeFocusReport: domChangeIndex !== undefined && (focusIdChangeIndex < 0 || domChangeIndex <= focusIdChangeIndex),
    }
  }

  /** 页面动画清单（用于基线审计）：document.getAnimations() 全量摘要 + infinite 标记。 */
  R.auditAnimations = () => {
    const list = document.getAnimations()
    const items = list.map((animation) => {
      const effect = animation.effect
      const timing = effect && typeof effect.getTiming === 'function' ? effect.getTiming() : {}
      const target = effect && effect.target && effect.target.nodeType === 1 ? effect.target : null
      const describe = target ? {
        tag: target.tagName,
        cls: String(target.className || '').slice(0, 120),
        attrs: ['data-tone', 'data-mode', 'data-flash', 'data-onestep-window-session'].reduce((out, name) => {
          if (target.hasAttribute(name)) out[name] = target.getAttribute(name)
          return out
        }, {}),
      } : null
      return {
        pseudoElement: effect && effect.pseudoElement ? effect.pseudoElement : null,
        animationName: animation.animationName || null,
        duration: timing.duration,
        delay: timing.delay || 0,
        iterations: timing.iterations === Infinity ? 'infinite' : timing.iterations,
        playState: animation.playState,
        target: describe,
      }
    })
    const infinite = items.filter((item) => item.iterations === 'infinite')
    return { count: items.length, items, infiniteCount: infinite.length, infinite }
  }

  /** 计算样式审计：命中 selector 的元素（含 ::after 等伪元素）的 transition/animation 事实。 */
  R.auditComputed = (spec) => {
    const out = []
    for (const entry of spec || []) {
      const elements = entry.selector ? Array.from(document.querySelectorAll(entry.selector)) : []
      const element = entry.selector ? elements[0] : null
      if (entry.selector && !element) {
        out.push({ key: entry.key || entry.selector, selector: entry.selector, found: false, count: 0 })
        continue
      }
      const read = (el, pseudo) => {
        const cs = getComputedStyle(el, pseudo || undefined)
        return {
          transitionProperty: cs.transitionProperty,
          transitionDuration: cs.transitionDuration,
          transitionDelay: cs.transitionDelay,
          transitionTimingFunction: cs.transitionTimingFunction,
          animationName: cs.animationName,
          animationDuration: cs.animationDuration,
          animationIterationCount: cs.animationIterationCount,
          animationDelay: cs.animationDelay,
          maxWidth: cs.maxWidth,
          transform: cs.transform,
          opacity: cs.opacity,
        }
      }
      out.push({
        key: entry.key || entry.selector,
        selector: entry.selector,
        found: true,
        count: element ? elements.length : 0,
        computed: element ? read(element, entry.pseudo) : null,
        vars: entry.vars && element ? entry.vars.reduce((vars, name) => {
          vars[name] = getComputedStyle(element).getPropertyValue(name).trim()
          return vars
        }, {}) : null,
      })
    }
    return out
  }

  /** 查找元素内部是否有 infinite 动画（扫描全部元素的计算样式 animation-iteration-count）。 */
  R.scanInfiniteStyles = () => {
    const results = []
    const all = document.querySelectorAll('*')
    for (const el of all) {
      const cs = getComputedStyle(el)
      const iteration = cs.animationIterationCount
      if (!iteration || iteration === 'none') continue
      if (iteration.split(',').every((part) => part.trim() === '1' || part.trim() === '0')) continue
      results.push({
        tag: el.tagName,
        cls: String(el.className || '').slice(0, 120),
        animationName: cs.animationName,
        animationDuration: cs.animationDuration,
        animationIterationCount: iteration,
        attrs: ['data-tone', 'data-mode', 'data-flash'].reduce((out, name) => {
          if (el.hasAttribute(name)) out[name] = el.getAttribute(name)
          return out
        }, {}),
      })
    }
    return { scanned: all.length, count: results.length, items: results }
  }

  /** 暂停全部 VT 伪元素动画并定位到 t（返回动画摘要）。 */
  R.pauseAt = (t) => {
    R.paused = R.vtAnimations()
    const applied = []
    for (const animation of R.paused) {
      try {
        animation.pause()
        animation.currentTime = t
        applied.push({ pseudoElement: animation.effect.pseudoElement, currentTime: R.round(animation.currentTime), playState: animation.playState })
      } catch (error) {
        applied.push({ pseudoElement: animation.effect && animation.effect.pseudoElement, error: String(error) })
      }
    }
    return { at: t, count: R.paused.length, applied }
  }
  R.seek = (t) => {
    const list = R.paused || []
    for (const animation of list) {
      try { animation.currentTime = t } catch (error) { /* ignore */ }
    }
    return { at: t, count: list.length, states: list.map((animation) => ({ pseudoElement: animation.effect && animation.effect.pseudoElement, currentTime: R.round(animation.currentTime || 0), playState: animation.playState })) }
  }
  R.forceFrames = (count) => new Promise((resolve) => {
    let left = Math.max(1, count === undefined ? 2 : count)
    const tick = () => {
      left -= 1
      if (left <= 0) resolve(true)
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  R.resume = () => {
    const list = R.paused || []
    for (const animation of list) {
      try { animation.play() } catch (error) { /* ignore */ }
    }
    R.paused = null
    return list.length
  }

  /** 把焦点窗内可滚动内容滚到中部/底部，返回滚动结果。 */
  R.scrollFocus = (where) => {
    const focusEl = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
    if (!focusEl) return { ok: false, error: 'no-focus-frame' }
    const all = [focusEl].concat(Array.from(focusEl.querySelectorAll('*')))
    const candidates = []
    for (const el of all) {
      const delta = el.scrollHeight - el.clientHeight
      if (delta > 40 && el.clientHeight > 40) candidates.push({ el, delta })
    }
    candidates.sort((a, b) => b.delta - a.delta)
    if (candidates.length === 0) {
      return { ok: false, error: 'no-scrollable', focusRect: R.rectOf(focusEl) }
    }
    const target = candidates[0].el
    const max = target.scrollHeight - target.clientHeight
    const top = where === 'bottom' ? max : Math.round(max / 2)
    target.scrollTop = top
    if (target !== focusEl && typeof focusEl.scrollTop === 'number' && focusEl.scrollHeight > focusEl.clientHeight) {
      focusEl.scrollTop = where === 'bottom' ? focusEl.scrollHeight : Math.round((focusEl.scrollHeight - focusEl.clientHeight) / 2)
    }
    return {
      ok: true,
      where: where || 'middle',
      tag: target.tagName,
      cls: String(target.className || '').slice(0, 120),
      candidates: candidates.length,
      scrollTop: target.scrollTop,
      max,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    }
  }

  /** 舞台内一个不在浮窗/标签/菜单/窗口帧上的空白点（用于「点击舞台空白收起」，避免误触窗口动作）。 */
  R.findStageBlankPoint = () => {
    const stage = document.querySelector('[data-onestep-stage]')
    if (!stage) return null
    const stageRect = stage.getBoundingClientRect()
    const blocked = (el) => !!(
      el.closest('[data-dockkit-float]') ||
      el.closest('[data-onestep-peek-layer]') ||
      el.closest('[data-onestep-menu]') ||
      el.closest('.onestep-frame') ||
      el.closest('button') ||
      el.closest('.onestep-quick')
    )
    for (let y = stageRect.bottom - 16; y > stageRect.top + 8; y -= 16) {
      for (let x = stageRect.left + 8; x < stageRect.right - 8; x += 16) {
        const el = document.elementFromPoint(x, y)
        if (!el) continue
        if (!el.closest('[data-onestep-stage]')) continue
        if (blocked(el)) continue
        return { x: R.round(x, 1), y: R.round(y, 1), hit: { tag: el.tagName, cls: String(el.className || '').slice(0, 100) } }
      }
    }
    return null
  }

  /** 官方左栏可点击的会话行（不在当前焦点）。 */
  R.officialSessionRows = () => Array.from(document.querySelectorAll('[data-row-key^="session:"]')).map((el) => {
    const rect = el.getBoundingClientRect()
    return {
      key: el.getAttribute('data-row-key'),
      sessionId: String(el.getAttribute('data-row-key') || '').replace(/^session:/, ''),
      rect: { x: R.round(rect.x), y: R.round(rect.y), w: R.round(rect.width), h: R.round(rect.height) },
      x: R.round(rect.x + rect.width / 2, 1),
      y: R.round(rect.y + rect.height / 2, 1),
    }
  })

  R.installStartViewTransitionCounter = () => {
    if (R.counterInstalled) return R.vtCallCount
    R.vtCallCount = 0
    R.vtCalls = []
    const original = document.startViewTransition.bind(document)
    R.originalStartViewTransition = original
    document.startViewTransition = function patched(callback) {
      R.vtCallCount += 1
      R.vtCalls.push({ at: R.round(performance.now(), 2), stack: String(new Error().stack || '').slice(0, 400) })
      return original(callback)
    }
    R.counterInstalled = true
    return R.vtCallCount
  }
  R.readStartViewTransitionCounter = () => ({ count: R.vtCallCount || 0, calls: R.vtCalls || [] })

  R.uninstallTempNodes = () => {
    for (const node of R.tempNodes) {
      try { node.remove() } catch (error) { /* ignore */ }
    }
    R.tempNodes = []
    return true
  }
  R.cleanup = () => {
    R.resume()
    R.clearWindowNames()
    R.clearExtraNames()
    R.removeVtStyle()
    R.uninstallTempNodes()
    return { activeVt: !!R.activeVt, paused: !!R.paused }
  }

  window.__P4 = R
  return { version: R.version, vtSupported: typeof document.startViewTransition === 'function', longtaskApi: typeof PerformanceObserver !== 'undefined' }
}

export async function installRuntime(page) {
  return page.evaluate(installPageRuntime)
}

/** 页面环境基线（每个 suite 打开页面后记录一次）。 */
export async function pageEnv(page) {
  return page.evaluate(() => ({
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory || null,
    dpr: window.devicePixelRatio,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    hasFocus: document.hasFocus(),
    startViewTransition: typeof document.startViewTransition,
    activeViewTransitionInDocument: 'activeViewTransition' in document,
    getAnimations: typeof document.getAnimations,
    longtaskSupported: typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask'),
    viewTransitionNameSupported: CSS.supports('view-transition-name', 'none'),
    probe: (() => {
      try {
        return { version: window.__ONESTEP__.version, actions: Object.keys(window.__ONESTEP__.actions).length }
      } catch (error) {
        return { error: String(error) }
      }
    })(),
    timeOrigin: performance.timeOrigin,
  }))
}

/* ========================================================================== *
 * 截图（保存 + 返回 buffer 供像素对比）
 * ========================================================================== */

/**
 * 截图到 artifacts/p4/probe/shots/<name>.png。
 * @returns {Promise<{file:string, rel:string, buffer:Buffer, bytes:number}>}
 */
export async function capture(page, name, options = {}) {
  ensureDirs()
  const file = path.join(SHOTS, name)
  const buffer = await page.screenshot({ path: file, type: 'png', animations: options.animations || 'allow', caret: 'hide' })
  return { file, rel: relPath(file), buffer, bytes: buffer.length }
}

/** 截图并登记到结果里（返回瘦身对象：不含 buffer，避免 JSON 里出现二进制）。 */
export async function shot(page, results, name) {
  const captured = await capture(page, name)
  results.data.screenshots.push(captured.rel)
  results.step('shot', { name: captured.rel, bytes: captured.bytes })
  return { file: captured.file, rel: captured.rel, bytes: captured.bytes }
}

/** 读取截图（用于之后对比；文件已存在时）。 */
export function loadShot(name) {
  const file = path.join(SHOTS, name)
  return fs.readFileSync(file)
}

/* ========================================================================== *
 * 舞台几何小工具
 * ========================================================================== */

/** DOM frame 列表 → 以 sessionId 为键的 rect 表。 */
export function rectsBySession(geometry) {
  const out = {}
  if (!geometry) return out
  if (geometry.focus) out[geometry.focus.sessionId] = geometry.focus.rect
  for (const candidate of geometry.candidates || []) out[candidate.sessionId] = candidate.rect
  return out
}

/** 两套 rect 表的最大几何偏差。 */
export function rectTableDeviation(tableA, tableB) {
  const sessions = new Set([...Object.keys(tableA || {}), ...Object.keys(tableB || {})])
  let max = 0
  const details = {}
  for (const sessionId of sessions) {
    const deviation = rectDeviation(tableA[sessionId], tableB[sessionId])
    details[sessionId] = deviation
    if (deviation.max > max) max = deviation.max
  }
  return { max, details }
}

/** 比较 DOM frame rect 与 actions.layout() 的偏差（按模式/顺序配对）。 */
export function layoutDeviation(geometry) {
  const layout = geometry.layout || {}
  const focusDeviation = rectDeviation(geometry.focus && geometry.focus.rect, layout.focus)
  const candidates = geometry.candidates || []
  const layoutCandidates = (layout.candidates || [])
  const candidateDeviations = candidates.map((candidate, index) => {
    const expected = layoutCandidates.find((item) => item.sessionId === candidate.sessionId) || layoutCandidates[index]
    return { sessionId: candidate.sessionId, deviation: rectDeviation(candidate.rect, expected) }
  })
  const maxCandidate = candidateDeviations.reduce((max, item) => Math.max(max, item.deviation.max), 0)
  return {
    focus: focusDeviation,
    candidates: candidateDeviations,
    max: Math.max(focusDeviation.max || 0, maxCandidate),
  }
}

/** 4 窗期望几何：焦点窗 rect 与三张候场卡 rect 的多重集是否与初始一致。 */
export function slotGridSignature(geometry) {
  const round = (rect) => rect ? [rect.x, rect.y, rect.w, rect.h].map((value) => Math.round(value)).join(',') : null
  return {
    focus: geometry.focus ? { sessionId: geometry.focus.sessionId, rect: round(geometry.focus.rect) } : null,
    candidates: (geometry.candidates || []).map((candidate) => ({ sessionId: candidate.sessionId, rect: round(candidate.rect) })),
    candidateRects: (geometry.candidates || []).map((candidate) => round(candidate.rect)).sort(),
  }
}

/** VT 伪元素动画名称集合（按 group/old/new 与名称拆开）。 */
export function vtAnimationBreakdown(animations) {
  const list = (animations || []).filter((animation) => animation.pseudoElement)
  const groups = {}
  for (const animation of list) {
    const match = /^::view-transition-(group|old|new|image-pair)\((.+)\)$/.exec(animation.pseudoElement)
    if (!match) continue
    const kind = match[1]
    const name = match[2]
    groups[name] = groups[name] || { name, kinds: {} }
    groups[name].kinds[kind] = groups[name].kinds[kind] || []
    groups[name].kinds[kind].push({ duration: animation.duration, delay: animation.delay, easing: animation.easing, playState: animation.playState })
  }
  return groups
}
