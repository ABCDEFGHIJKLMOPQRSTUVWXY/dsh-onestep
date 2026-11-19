/**
 * dsh-onestep P2 验证共享库。
 *
 * 职责：读隔离实例 URL、打开页面、记录基线 sha、断言/步骤记录、对比度计算、
 * 稳定等待、截图、Tab/DOM 顺序采集、localStorage 舞台状态注入、按键组合。
 *
 * 约定：
 * - 只读产品源码/构建产物；只写 artifacts/p2/**。
 * - 实例 URL 每次从 artifacts/p2/server-url.txt 重读（token 会变）。
 * - Playwright 在 tools/pw（playwright-core + msedge channel，headless）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

export const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
export const ARTIFACTS = path.join(ROOT, 'artifacts', 'p2')
export const VERIFY_OUT = path.join(ARTIFACTS, 'verify')
export const URL_FILE = path.join(ARTIFACTS, 'server-url.txt')
export const STORAGE_KEY = 'dsh.onestep.v1'
export const STATE_VERSION = 3

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function log(...args) {
  console.log(...args)
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/** 从 artifacts/p2/server-url.txt 读取带 token 的隔离实例 URL（去掉 # 注释）。 */
export function readServerUrl() {
  if (!fs.existsSync(URL_FILE)) {
    throw new Error('缺少隔离实例 URL 文件：' + URL_FILE + '（不由本套件启动/重启实例）')
  }
  const raw = fs.readFileSync(URL_FILE, 'utf8').trim()
  const url = raw.split('#')[0].split(/\r?\n/)[0].trim()
  if (!/^https?:\/\//.test(url)) throw new Error('server-url.txt 内容不是 http(s) URL：' + raw.slice(0, 40))
  return url
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase()
}

export function fileSize(file) {
  try {
    return fs.statSync(file).size
  } catch (_error) {
    return null
  }
}

/** 基线身份：client.js / index.js sha + 版本 + 运行环境。每个 suite 运行前记录一次。 */
export function baselineInfo() {
  const pkgPath = path.join(ROOT, 'package.json')
  let pkg = {}
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  } catch (_error) {
    /* ignore */
  }
  let playwrightVersion = null
  try {
    const require = createRequire(path.join(ROOT, 'tools', 'pw') + path.sep)
    playwrightVersion = require('playwright-core/package.json').version
  } catch (_error) {
    playwrightVersion = null
  }
  return {
    at: new Date().toISOString(),
    node: process.version,
    platform: process.platform + ' ' + os.release(),
    cpu: (os.cpus()[0] || {}).model || null,
    cpuCount: os.cpus().length,
    totalMemGB: Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10,
    playwrightVersion,
    packageVersion: pkg.version || null,
    clientSha256: sha256File(path.join(ROOT, 'client.js')),
    clientBytes: fileSize(path.join(ROOT, 'client.js')),
    indexSha256: sha256File(path.join(ROOT, 'index.js')),
    indexBytes: fileSize(path.join(ROOT, 'index.js')),
    serverUrlFile: URL_FILE,
    serverUrlFileName: path.basename(URL_FILE),
  }
}

export function loadPlaywright() {
  const require = createRequire(path.join(ROOT, 'tools', 'pw') + path.sep)
  return require('playwright-core')
}

/** 断言/步骤/证据记录器。ok = 无失败断言、无 fatal error。 */
export class Results {
  /**
   * @param {string} suite suite 文件名标识
   * @param {string} [title] 人类可读标题
   * @param {string} [outFile] JSON 输出路径
   */
  constructor(suite, title, outFile) {
    this.data = {
      suite,
      title: title || suite,
      ok: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      baseline: baselineInfo(),
      env: {},
      steps: [],
      assertions: [],
      skips: [],
      screenshots: [],
      consoleErrors: [],
      pageErrors: [],
      error: null,
    }
    this.outFile = outFile || path.join(VERIFY_OUT, suite + '.json')
  }

  setEnv(key, value) {
    this.data.env[key] = value
  }

  step(name, data) {
    this.data.steps.push({ name, at: new Date().toISOString(), data: data === undefined ? null : data })
    log('[step] ' + name + ' ' + JSON.stringify(data === undefined ? null : data).slice(0, 600))
  }

  /**
   * @param {string} name 断言 id
   * @param {boolean} pass
   * @param {object} [detail] {expected, actual, category, evidence, note}
   */
  assert(name, pass, detail = {}) {
    const record = {
      name,
      pass: !!pass,
      category: detail.category || null,
      expected: detail.expected === undefined ? null : detail.expected,
      actual: detail.actual === undefined ? null : detail.actual,
      note: detail.note || null,
      evidence: detail.evidence || null,
      at: new Date().toISOString(),
    }
    this.data.assertions.push(record)
    log('[' + (record.pass ? 'PASS' : 'FAIL') + '] ' + name + (record.category ? ' <' + record.category + '>' : '') + ' ' + JSON.stringify(record.actual).slice(0, 400))
    return record.pass
  }

  skip(name, reason, category) {
    this.data.skips.push({ name, reason, category: category || null, at: new Date().toISOString() })
    log('[SKIP] ' + name + ' ' + reason)
  }

  captureErrors(handles) {
    this.data.pageErrors = handles.pageErrors
    this.data.consoleErrors = handles.consoleErrors
  }

  async shot(page, name, outDir) {
    const dir = outDir || VERIFY_OUT
    ensureDir(dir)
    const file = path.join(dir, name)
    try {
      await page.screenshot({ path: file })
      this.data.screenshots.push(path.relative(ROOT, file).replace(/\\/g, '/'))
      return file
    } catch (error) {
      log('[shot] failed ' + name + ' ' + String(error).slice(0, 200))
      return null
    }
  }

  async shotElement(page, selector, name, outDir) {
    const dir = outDir || VERIFY_OUT
    ensureDir(dir)
    const file = path.join(dir, name)
    try {
      await page.locator(selector).first().screenshot({ path: file })
      this.data.screenshots.push(path.relative(ROOT, file).replace(/\\/g, '/'))
      return file
    } catch (error) {
      log('[shot] failed ' + name + ' ' + String(error).slice(0, 200))
      return null
    }
  }

  fatal(error) {
    this.data.error = String((error && error.stack) || error)
    log('[FATAL] ' + String(error && error.message ? error.message : error))
  }

  finish(extra) {
    this.data.finishedAt = new Date().toISOString()
    const failed = this.data.assertions.filter((item) => !item.pass)
    this.data.summary = {
      total: this.data.assertions.length,
      pass: this.data.assertions.length - failed.length,
      fail: failed.length,
      skipped: this.data.skips.length,
      failedNames: failed.map((item) => item.name),
    }
    this.data.ok = !this.data.error && failed.length === 0
    if (extra) Object.assign(this.data, extra)
    ensureDir(path.dirname(this.outFile))
    fs.writeFileSync(this.outFile, JSON.stringify(this.data, null, 2), 'utf8')
    log('[' + this.data.suite + '] wrote ' + path.relative(ROOT, this.outFile) + ' ' + JSON.stringify(this.data.summary) + ' ok=' + this.data.ok)
    return this.data
  }
}

/* ------------------------------------------------------------------ *
 * 浏览器/页面
 * ------------------------------------------------------------------ */

const COMPOSER_SELECTOR = '[role="textbox"], [contenteditable="true"]'

async function waitAppReady(page, options = {}) {
  await page.waitForSelector(COMPOSER_SELECTOR, { timeout: options.composerTimeout || 60000 })
  await page.waitForFunction(() => !!window.__ONESTEP__, null, { timeout: options.probeTimeout || 40000 })
  await sleep(options.settleMs === undefined ? 1200 : options.settleMs)
  if (options.normalize !== false) {
    await leaveStage(page)
  }
}

export async function openApp(options = {}) {
  const { chromium } = loadPlaywright()
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({
    viewport: options.viewport || { width: 1440, height: 900 },
    colorScheme: options.colorScheme || 'light',
    reducedMotion: options.reducedMotion || 'no-preference',
  })
  const page = await context.newPage()
  page.setDefaultTimeout(30000)
  const handles = { consoleErrors: [], pageErrors: [] }
  page.on('pageerror', (error) => handles.pageErrors.push(String(error).slice(0, 400)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') handles.consoleErrors.push(msg.text().slice(0, 400))
  })
  await page.goto(options.url || readServerUrl(), { waitUntil: 'domcontentloaded', timeout: 60000 })
  await waitAppReady(page, options)
  return { browser, context, page, handles }
}

export async function closeApp(app) {
  if (!app) return
  try {
    await app.context.close()
  } catch (_error) {
    /* ignore */
  }
  try {
    await app.browser.close()
  } catch (_error) {
    /* ignore */
  }
}

/** 页面重载并等待应用/插件就绪；normalize=false 时保留持久化状态（用于持久化断言）。 */
export async function reloadApp(page, options = {}) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  await waitAppReady(page, options)
}

export async function waitFor(fn, options = {}) {
  const timeout = options.timeout || 8000
  const interval = options.interval || 80
  const started = Date.now()
  let lastError = null
  for (;;) {
    let value = false
    try {
      value = await fn()
    } catch (error) {
      lastError = error
    }
    if (value) return value
    if (Date.now() - started > timeout) {
      throw new Error('waitFor timeout (' + (options.label || 'predicate') + ')' + (lastError ? ': ' + String(lastError) : ''))
    }
    await sleep(interval)
  }
}

/* ------------------------------------------------------------------ *
 * 探针 / 舞台状态
 * ------------------------------------------------------------------ */

export const snapshot = (page) => page.evaluate(() => window.__ONESTEP__.actions.snapshot())

export const listSessions = (page) => page.evaluate(() => window.__ONESTEP__.actions.listSessions())

export const listActionNames = (page) => page.evaluate(() => Object.keys(window.__ONESTEP__.actions).sort())

export const probeLog = (page, count = 120) =>
  page.evaluate((n) => {
    const fn = window.__ONESTEP__ && window.__ONESTEP__.log
    return typeof fn === 'function' ? fn(n) : []
  }, count)

export async function domStats(page) {
  return page.evaluate(() => {
    const q = (selector) => document.querySelectorAll(selector).length
    const stage = document.querySelector('[data-onestep-stage]')
    const inside = (selector) => (stage ? stage.querySelectorAll(selector).length : 0)
    return {
      stage: q('[data-onestep-stage]'),
      focusFrames: q('[data-onestep-stage] .onestep-frame[data-mode="focus"]'),
      candidateFrames: q('[data-onestep-stage] .onestep-frame[data-mode="candidate"]'),
      occurrences: q('[data-onestep-occurrence]'),
      occurrencesInsideStage: inside('[data-onestep-occurrence]'),
      conversationContentInsideStage: inside('[data-conversation-content]'),
      conversationContentOutsideStage: Array.from(document.querySelectorAll('[data-conversation-content]')).filter(
        (el) => !el.closest('[data-onestep-stage]'),
      ).length,
      editableComposers: q('[contenteditable="true"]'),
      editableComposersInsideStage: inside('[contenteditable="true"]'),
      visibleEditableComposers: Array.from(document.querySelectorAll('[contenteditable="true"]')).filter((el) => {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none'
      }).length,
      inertBodies: q('.onestep-body[data-inert="1"]'),
      quickBars: q('.onestep-quick'),
      headers: q('[data-onestep-header-action]'),
      rowActions: q('[data-onestep-row-action]'),
      toasts: q('.onestep-toast'),
    }
  })
}

/** 舞台就绪：stage + 期望候场帧 + 焦点帧且焦点帧内官方内容已渲染。 */
export const stageReadyPredicate = (expectedCandidates) =>
  // 该函数在浏览器上下文执行（字符串化后传入）
  `(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    if (!stage) return false
    const cands = stage.querySelectorAll('.onestep-frame[data-mode="candidate"]')
    if (cands.length !== ${Number(expectedCandidates)}) return false
    const focus = stage.querySelector('.onestep-frame[data-mode="focus"]')
    if (!focus) return false
    const rect = focus.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return false
    const overview = focus.querySelector('[data-conversation-content]')
    if (!overview) return false
    const overviewRect = overview.getBoundingClientRect()
    return overviewRect.width > 2 && overviewRect.height > 2
  })()`

export async function waitStageReady(page, expectedCandidates, timeout = 12000) {
  await page.waitForFunction(stageReadyPredicate(expectedCandidates), null, { timeout })
}

export async function waitStageGone(page, timeout = 10000) {
  await page.waitForFunction(
    () => !document.querySelector('[data-onestep-stage]') && window.__ONESTEP__ && window.__ONESTEP__.actions.snapshot().mounted === false,
    null,
    { timeout },
  )
}

export async function leaveStage(page) {
  const mounted = await page.evaluate(() => {
    try {
      const probe = window.__ONESTEP__
      if (!probe) return false
      const snap = probe.actions.snapshot()
      if (snap.mounted || snap.candidates.length > 0 || document.querySelector('[data-onestep-stage]')) {
        probe.actions.exitStage()
        return true
      }
      return false
    } catch (_error) {
      return false
    }
  })
  if (mounted) {
    try {
      await waitStageGone(page, 8000)
    } catch (_error) {
      /* 退化：至少等 400ms */
    }
    await sleep(400)
  }
  return mounted
}

/** 挑非空白会话 id（排除 exclude 与当前主绑定）。 */
export async function pickSessions(page, count, options = {}) {
  const rows = await listSessions(page)
  const current = await page.evaluate(() => {
    try {
      return window.__ONESTEP__.actions.currentSessionId() || null
    } catch (_error) {
      return null
    }
  })
  const exclude = new Set(options.exclude || [])
  if (options.includeCurrent !== true && current) exclude.add(current)
  const ids = Object.keys(rows)
  const nonBlank = ids.filter((id) => {
    const row = rows[id] || {}
    return !row.blank && !exclude.has(id)
  })
  const blank = ids.filter((id) => (rows[id] || {}).blank && !exclude.has(id))
  const picked = nonBlank.slice(0, count)
  if (picked.length < count) picked.push(...blank.slice(0, count - picked.length))
  return {
    current,
    ids,
    picked,
    rowsSummary: picked.map((id) => ({
      id,
      blank: !!(rows[id] || {}).blank,
      title: titleOfRow(rows[id]),
      keys: Object.keys(rows[id] || {}),
    })),
  }
}

function titleOfRow(row) {
  if (!row) return null
  const keys = ['title', 'name', 'label', 'summary']
  for (const key of keys) if (row[key]) return String(row[key]).slice(0, 80)
  return null
}

/**
 * 进入舞台：先回普通模式，再逐个 addCandidate，等舞台+期望候场数+焦点内容就绪。
 * candidateIds 必须是排除当前主绑定后的 id；若有 id 被忽略（如已成为焦点）会抛错。
 * 需要「自动挑会话」时用 ensureStage。
 * @returns {Promise<object>} snapshot
 */
export async function enterStage(page, candidateIds, options = {}) {
  const ids = (candidateIds || []).filter(Boolean)
  if (ids.length === 0) throw new Error('enterStage 需要至少 1 个候场 sessionId')
  await leaveStage(page)
  await page.evaluate((list) => {
    for (const id of list) window.__ONESTEP__.actions.addCandidate(id)
  }, ids)
  try {
    await waitStageReady(page, ids.length, options.timeout || 15000)
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      snapshot: (() => {
        try {
          return window.__ONESTEP__.actions.snapshot()
        } catch (_error) {
          return null
        }
      })(),
      stage: !!document.querySelector('[data-onestep-stage]'),
      frames: document.querySelectorAll('[data-onestep-stage] .onestep-frame[data-mode="candidate"]').length,
    }))
    throw new Error('enterStage 未就绪（期望 ' + ids.length + ' 候场）: ' + JSON.stringify({ ids, diagnostics: { mounted: diagnostics.snapshot && diagnostics.snapshot.mounted, focus: diagnostics.snapshot && (diagnostics.snapshot.focusId || '').slice(0, 12), candidates: diagnostics.snapshot && diagnostics.snapshot.candidates.length, frames: diagnostics.frames, stage: diagnostics.stage } }).slice(0, 900))
  }
  await sleep(options.settleMs === undefined ? 900 : options.settleMs)
  const snap = await snapshot(page)
  if (!snap.mounted) throw new Error('enterStage 后 stage 未挂载')
  return snap
}

/**
 * 稳健进入舞台：每次重新挑会话（排除当前主绑定/焦点），不足时补 pick。
 * @param {number} count 需要几个候场窗（1..3）
 */
export async function ensureStage(page, count, options = {}) {
  await leaveStage(page)
  const wanted = Math.max(1, Math.min(3, Number(count) || 1))
  const tried = new Set()
  let snap = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await page.evaluate(() => {
      try {
        return window.__ONESTEP__.actions.snapshot().focusId || window.__ONESTEP__.actions.currentSessionId()
      } catch (_error) {
        return null
      }
    })
    const exclude = new Set(options.exclude || [])
    if (current) exclude.add(current)
    if (snap) for (const id of snap.candidates) exclude.add(id)
    const pick = await pickSessions(page, wanted + exclude.size + 3, { exclude: Array.from(exclude), includeCurrent: false })
    const additions = pick.picked.filter((id) => !tried.has(id) && !exclude.has(id)).slice(0, wanted - (snap ? snap.candidates.length : 0))
    if (additions.length === 0) break
    for (const id of additions) tried.add(id)
    const result = await page.evaluate((list) => {
      const out = []
      for (const id of list) out.push(window.__ONESTEP__.actions.addCandidate(id))
      return out
    }, additions)
    await waitFor(
      () => page.evaluate(() => window.__ONESTEP__.actions.snapshot().mounted === true),
      { timeout: 8000, label: 'stage.mounted' },
    )
    snap = await snapshot(page)
    if (snap.candidates.length >= wanted) break
    log('ensureStage 补候场 attempt=' + attempt + ' result=' + JSON.stringify(result).slice(0, 300))
  }
  if (!snap || snap.candidates.length < wanted) {
    throw new Error('ensureStage 未能挂载 ' + wanted + ' 个候场（实际 ' + (snap ? snap.candidates.length : 0) + '）')
  }
  await waitStageReady(page, snap.candidates.length, options.timeout || 15000)
  await sleep(options.settleMs === undefined ? 900 : options.settleMs)
  const final = await snapshot(page)
  if (!final.mounted) throw new Error('ensureStage 后 stage 未挂载')
  return final
}

/** 把焦点从官方 composer 移开（page 区域快捷键在文本输入内不触发）。 */
export async function blurActive(page) {
  await page.evaluate(() => {
    if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur()
    if (document.body) document.body.focus()
  })
  await sleep(120)
}

/** composer 统计（退出残留断言用）：可编辑/可见/role=textbox 三类。 */
export async function composerStats(page) {
  return page.evaluate(() => {
    const editable = Array.from(document.querySelectorAll('[contenteditable="true"]'))
    const textboxes = Array.from(document.querySelectorAll('[role="textbox"]'))
    const visible = (el) => {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05
    }
    return {
      editable: editable.length,
      editableVisible: editable.filter(visible).length,
      textboxes: textboxes.length,
      textboxesVisible: textboxes.filter(visible).length,
      insideStage: editable.filter((el) => el.closest('[data-onestep-stage]')).length,
    }
  })
}

/* ------------------------------------------------------------------ *
 * localStorage 舞台状态（持久化注入；只写浏览器存储，不写源码）
 * ------------------------------------------------------------------ */

export async function readStageStorage(page) {
  return page.evaluate((key) => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : null
    } catch (_error) {
      return { __parseError: String(_error) }
    }
  }, STORAGE_KEY)
}

export async function writeStageStorage(page, patch) {
  return page.evaluate(
    ({ key, version, patchData }) => {
      let current = {}
      try {
        current = JSON.parse(localStorage.getItem(key) || '{}') || {}
      } catch (_error) {
        current = {}
      }
      const next = { ...current, version, ...patchData }
      localStorage.setItem(key, JSON.stringify(next))
      return next
    },
    { key: STORAGE_KEY, version: STATE_VERSION, patchData: patch },
  )
}

/** 常规清理：恢复默认舞台状态（保留 localStorage 键本身，写回默认值）。 */
export async function resetStageStorage(page) {
  return page.evaluate(
    ({ key, version }) => {
      const next = {
        version,
        candidates: [],
        railSide: 'left',
        railSize: 240,
        railCollapsed: false,
        previewMode: 'live',
        autoLite: true,
        persistStage: true,
      }
      localStorage.setItem(key, JSON.stringify(next))
      return next
    },
    { key: STORAGE_KEY, version: STATE_VERSION },
  )
}

/* ------------------------------------------------------------------ *
 * 样式 / 对比度
 * ------------------------------------------------------------------ */

export function parseColor(text) {
  const match = String(text || '').match(/rgba?\(([^)]+)\)/)
  if (!match) return null
  const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number)
  if (parts.length < 3 || parts.some((value) => Number.isNaN(value))) return null
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
}

export function luminance(color) {
  const channel = (value) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

export function contrastRatio(fg, bg) {
  const a = luminance(fg)
  const b = luminance(bg)
  const hi = Math.max(a, b)
  const lo = Math.min(a, b)
  return (hi + 0.05) / (lo + 0.05)
}

export function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * 计算元素文字与其「有效背景」（沿祖先链合成半透明背景 + 主题基色）的 WCAG 对比度。
 * 浏览器内执行，返回 {selector, fg, bg, ratio, font:{size,weight}, theme}
 */
export async function measureContrast(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const parse = (text) => {
      const match = String(text || '').match(/rgba?\(([^)]+)\)/)
      if (!match) return null
      const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number)
      if (parts.length < 3 || parts.some((value) => Number.isNaN(value))) return null
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
    }
    const fgRaw = parse(getComputedStyle(el).color)
    const layers = []
    let node = el
    while (node && node.nodeType === 1) {
      const color = parse(getComputedStyle(node).backgroundColor)
      if (color && color.a > 0.001) layers.push(color)
      node = node.parentElement
    }
    const theme =
      document.body.getAttribute('data-ds-dark-theme') === '' ||
      document.documentElement.getAttribute('data-ds-dark-theme') === ''
        ? 'dark'
        : 'light'
    const base = theme === 'dark' ? { r: 21, g: 21, b: 23, a: 1 } : { r: 255, g: 255, b: 255, a: 1 }
    let bg = { ...base }
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const layer = layers[index]
      bg = {
        r: layer.r * layer.a + bg.r * (1 - layer.a),
        g: layer.g * layer.a + bg.g * (1 - layer.a),
        b: layer.b * layer.a + bg.b * (1 - layer.a),
        a: 1,
      }
    }
    const fg =
      fgRaw && fgRaw.a < 1
        ? {
            r: fgRaw.r * fgRaw.a + bg.r * (1 - fgRaw.a),
            g: fgRaw.g * fgRaw.a + bg.g * (1 - fgRaw.a),
            b: fgRaw.b * fgRaw.a + bg.b * (1 - fgRaw.a),
            a: 1,
          }
        : fgRaw
    const channel = (value) => {
      const c = value / 255
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    }
    const lum = (color) => 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
    let ratio = null
    if (fg) {
      const la = lum(fg)
      const lb = lum(bg)
      ratio = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
    }
    const style = getComputedStyle(el)
    return {
      selector: sel,
      theme,
      fg,
      bg,
      ratio: ratio === null ? null : Math.round(ratio * 100) / 100,
      font: { size: style.fontSize, weight: style.fontWeight, lineHeight: style.lineHeight },
      text: (el.textContent || '').trim().slice(0, 80),
    }
  }, selector)
}

/* ------------------------------------------------------------------ *
 * 键盘 / Tab 顺序
 * ------------------------------------------------------------------ */

/** 按 Ctrl/Alt/Shift + key 发送组合键；key 用 Playwright 键名（'s'、'2'、'ArrowRight'）。 */
export async function pressChord(page, chord) {
  const modifiers = []
  if (chord.ctrl) modifiers.push('Control')
  if (chord.alt) modifiers.push('Alt')
  if (chord.shift) modifiers.push('Shift')
  if (chord.meta) modifiers.push('Meta')
  for (const modifier of modifiers) await page.keyboard.down(modifier)
  try {
    await page.keyboard.press(chord.key)
  } finally {
    for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier)
  }
  await sleep(chord.settleMs === undefined ? 250 : chord.settleMs)
}

export async function resetFocus(page) {
  await page.evaluate(() => {
    const active = document.activeElement
    if (active && typeof active.blur === 'function') active.blur()
    if (document.body) document.body.focus()
  })
  await sleep(80)
}

/** 采集当前 DOM 中可 Tab 聚焦元素（按 DOM 顺序，过滤 inert/隐藏）。 */
export async function domTabbables(page) {
  return page.evaluate(() => {
    const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const describe = (el) => {
      const frame = el.closest('.onestep-frame')
      const stage = el.closest('[data-onestep-stage]')
      const className = typeof el.className === 'string' ? el.className : el.getAttribute('class') || ''
      return {
        tag: el.tagName,
        role: el.getAttribute('role'),
        cls: className.slice(0, 60),
        label: (el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').trim()).slice(0, 40),
        dataOnestepStage: stage ? '1' : '0',
        insideFrame: frame ? frame.getAttribute('data-mode') : null,
        insideInert: !!el.closest('[inert]'),
        tabIndex: el.tabIndex,
      }
    }
    return Array.from(document.querySelectorAll(selector))
      .filter((el) => {
        if (el.closest('[inert]')) return false
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      })
      .slice(0, 5000)
      .map(describe)
  })
}

/** 真实按键采集 Tab 顺序（从 body 起）。 */
export async function tabSequence(page, limit = 16) {
  await resetFocus(page)
  const sequence = []
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press('Tab')
    await sleep(90)
    const current = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body || el === document.documentElement) return null
      const frame = el.closest ? el.closest('.onestep-frame') : null
      const stage = el.closest ? el.closest('[data-onestep-stage]') : null
      const className = typeof el.className === 'string' ? el.className : el.getAttribute('class') || ''
      return {
        tag: el.tagName,
        role: el.getAttribute('role'),
        cls: className.slice(0, 60),
        label: (el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').trim()).slice(0, 40),
        insideFrame: frame ? frame.getAttribute('data-mode') : null,
        insideStage: !!stage,
        id: el.id || null,
      }
    })
    if (current) sequence.push(current)
  }
  return sequence
}

/** 找到使元素获得焦点的样式（focus-visible 断言用）。 */
export async function focusedStyle(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    el.focus()
    const style = getComputedStyle(el)
    return {
      focused: document.activeElement === el,
      opacity: style.opacity,
      boxShadow: style.boxShadow,
      outline: style.outlineStyle + ' ' + style.outlineWidth + ' ' + style.outlineColor,
      background: style.backgroundColor,
      pointerEvents: style.pointerEvents,
      matchesFocusVisible: el.matches(':focus-visible'),
    }
  }, selector)
}

/* ------------------------------------------------------------------ *
 * 其他
 * ------------------------------------------------------------------ */

/** 读取当前主题（body data-ds-dark-theme）与主题 token 环境。 */
export async function themeInfo(page) {
  return page.evaluate(() => {
    const attr = document.body.getAttribute('data-ds-dark-theme')
    const attrHtml = document.documentElement.getAttribute('data-ds-dark-theme')
    return {
      theme: attr === '' ? 'dark' : attr === null && attrHtml === '' ? 'dark' : 'light',
      bodyAttr: attr,
      htmlAttr: attrHtml,
      mediaDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    }
  })
}

export async function setTheme(page, scheme) {
  await page.emulateMedia({ colorScheme: scheme })
  try {
    await waitFor(
      () => page.evaluate((expected) => {
        const attr = document.body.getAttribute('data-ds-dark-theme')
        const htmlAttr = document.documentElement.getAttribute('data-ds-dark-theme')
        const dark = attr === '' || (attr === null && htmlAttr === '')
        return expected === 'dark' ? dark : !dark
      }, scheme),
      { timeout: 5000, interval: 120, label: 'theme=' + scheme },
    )
  } catch (_error) {
    /* 主题属性未变化也继续（记录实测值即可） */
  }
  await sleep(400)
}

/** 舞台内窗口几何快照。 */
export async function stageGeometry(page) {
  return page.evaluate(() => {
    const round = (rect) => ({ x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) })
    const stage = document.querySelector('[data-onestep-stage]')
    if (!stage) return null
    const focus = stage.querySelector('.onestep-frame[data-mode="focus"]')
    const candidates = Array.from(stage.querySelectorAll('.onestep-frame[data-mode="candidate"]'))
    const rail = stage.querySelector('[data-onestep-rail]')
    const splitter = stage.querySelector('[data-onestep-splitter]')
    return {
      stage: round(stage.getBoundingClientRect()),
      focus: focus ? round(focus.getBoundingClientRect()) : null,
      candidates: candidates.map((el) => ({
        ...round(el.getBoundingClientRect()),
        sessionId: el.getAttribute('data-onestep-window-session'),
        preview: el.getAttribute('data-preview'),
      })),
      rail: rail ? round(rail.getBoundingClientRect()) : null,
      splitter: splitter ? round(splitter.getBoundingClientRect()) : null,
      railSide: stage.getAttribute('data-rail-side'),
      previewMode: stage.getAttribute('data-preview-mode'),
    }
  })
}

/** 页面滚动到舞台顶部（避免截图偏移）。 */
export async function scrollTop(page) {
  await page.evaluate(() => window.scrollTo(0, 0))
}

export function writeTextFile(relativePath, text) {
  const file = path.join(ROOT, relativePath)
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, text, 'utf8')
  return file
}
