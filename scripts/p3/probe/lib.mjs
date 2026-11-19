/**
 * dsh-onestep P3-1 探针共享库。
 *
 * 职责：读隔离实例 URL、打开页面（全新 context = 全新官方布局持久化）、探针桥调用、
 * 舞台进入、逐帧（rAF）采样、官方右侧栏 / dockkit 浮窗 DOM 事实采集、断言与证据记录。
 *
 * 边界：
 * - 只读产品源码/构建产物；只写 artifacts/p3/probe/**。
 * - 实例 URL 每次从 artifacts/p3/server-url.txt 重读（token 会变）；本库不启动/停止实例。
 * - Playwright 在 tools/pw（playwright-core + msedge channel，headless）。
 *
 * 事实基线（探针桥源码 src/client/float-probe.js 与 Lead smoke artifacts/p3/probe/lead-smoke.json）：
 * - `window.__ONESTEP__.actions.p3.*` 是官方 sidebarRight 原语桥，返回 `{ok, value?, error?}`。
 * - 舞台进入：`actions.enterStage([sessionId...])`（probe.js，异步）；`actions.layout()` 读舞台几何。
 * - 官方资源地址：`dsh-resource://file/session/<sessionId>/<path>`（text 预览器认领）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

export const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
export const ARTIFACTS = path.join(ROOT, 'artifacts', 'p3')
export const PROBE_OUT = path.join(ARTIFACTS, 'probe')
export const SHOTS = path.join(PROBE_OUT, 'shots')
export const URL_FILE = path.join(ARTIFACTS, 'server-url.txt')

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function log(...args) {
  console.log(...args)
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/** 从 artifacts/p3/server-url.txt 读取带 token 的隔离实例 URL（去掉 # 注释）。 */
export function readServerUrl() {
  if (!fs.existsSync(URL_FILE)) {
    throw new Error('缺少隔离实例 URL 文件：' + URL_FILE + '（本套件不启动/重启实例）')
  }
  const raw = fs.readFileSync(URL_FILE, 'utf8').trim()
  const url = raw.split('#')[0].split(/\r?\n/)[0].trim()
  if (!/^https?:\/\//.test(url)) throw new Error('server-url.txt 内容不是 http(s) URL：' + raw.slice(0, 40))
  return url
}

export function loadPlaywright() {
  const require = createRequire(path.join(ROOT, 'tools', 'pw') + path.sep)
  return require('playwright-core')
}

export function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase()
  } catch (_error) {
    return null
  }
}

/** 基线身份：构建产物 sha + 版本 + 运行环境。每个 suite 运行前记录一次。 */
export function baselineInfo() {
  let pkg = {}
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
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
    playwrightVersion,
    packageVersion: pkg.version || null,
    clientSha256: sha256File(path.join(ROOT, 'client.js')),
    clientBytes: fs.existsSync(path.join(ROOT, 'client.js')) ? fs.statSync(path.join(ROOT, 'client.js')).size : null,
    indexSha256: sha256File(path.join(ROOT, 'index.js')),
    floatProbeSha256: sha256File(path.join(ROOT, 'src', 'client', 'float-probe.js')),
    serverUrlFile: path.relative(ROOT, URL_FILE).replace(/\\/g, '/'),
  }
}

/**
 * 断言/步骤/证据记录器。ok = 无失败断言、无 fatal error。
 * 失败时也先写盘再退出非 0（`finish()` 总会写 JSON）。
 */
export class Results {
  /**
   * @param {string} suite suite 文件名标识
   * @param {string} title 人类可读标题
   * @param {string} [outFile] JSON 输出路径（默认 artifacts/p3/probe/<suite>.json）
   */
  constructor(suite, title, outFile) {
    this.data = {
      suite,
      title,
      ok: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      baseline: baselineInfo(),
      env: {},
      steps: [],
      assertions: [],
      skips: [],
      screenshots: [],
      metrics: {},
      consoleErrors: [],
      pageErrors: [],
      error: null,
    }
    this.outFile = outFile || path.join(PROBE_OUT, suite + '.json')
  }

  setEnv(key, value) {
    this.data.env[key] = value
  }

  /** 记录关键数值（供回报/后续决策引用）。 */
  metric(key, value) {
    this.data.metrics[key] = value
    log('[metric] ' + key + ' ' + JSON.stringify(value).slice(0, 800))
  }

  step(name, data) {
    this.data.steps.push({ name, at: new Date().toISOString(), data: data === undefined ? null : data })
    log('[step] ' + name + ' ' + JSON.stringify(data === undefined ? null : data).slice(0, 800))
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
    log(
      '[' + (record.pass ? 'PASS' : 'FAIL') + '] ' + name + (record.category ? ' <' + record.category + '>' : '') +
      ' ' + JSON.stringify(record.actual).slice(0, 500),
    )
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
    const dir = outDir || SHOTS
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
 * 浏览器 / 页面
 * ------------------------------------------------------------------ */

const COMPOSER_SELECTOR = '[role="textbox"], [contenteditable="true"]'

async function waitAppReady(page, options = {}) {
  await page.waitForSelector(COMPOSER_SELECTOR, { timeout: options.composerTimeout || 60000 })
  await page.waitForFunction(() => !!window.__ONESTEP__ && !!window.__ONESTEP__.actions, null, { timeout: options.probeTimeout || 40000 })
  await page.waitForFunction(() => {
    try {
      const snap = window.__ONESTEP__.actions.p3.snapshot()
      return !!snap && snap.available === true
    } catch (_error) {
      return false
    }
  }, null, { timeout: options.probeTimeout || 40000 })
  await sleep(options.settleMs === undefined ? 1200 : options.settleMs)
}

/**
 * 打开应用（全新 context：官方 localStorage 布局持久化为默认值，保证套件间相互隔离）。
 * @param {{viewport?:{width:number,height:number}, colorScheme?:string, settleMs?:number}} [options]
 */
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

/**
 * P4：等待动效控制器空闲（VT 队列清空、无进行中过渡）。
 * 旧构建无 motionState 时直接返回，保持 P3 探针对旧构建可用。
 */
export async function waitMotionIdle(page, timeout = 8000) {
  try {
    await page.waitForFunction(() => {
      const probe = window.__ONESTEP__
      if (!probe || typeof probe.actions.motionState !== 'function') return true
      let state = null
      try {
        state = probe.actions.motionState()
      } catch (_error) {
        return true
      }
      const controller = state && state.controller
      if (!controller) return true
      return !controller.active && controller.activeState === 'idle' && (controller.pending || 0) === 0
    }, null, { timeout })
  } catch (_error) {
    /* 超时/旧构建：不阻塞探针 */
  }
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
 * 探针桥
 * ------------------------------------------------------------------ */

export const listActionNames = (page) => page.evaluate(() => Object.keys(window.__ONESTEP__.actions).sort())

export const listSessions = (page) => page.evaluate(() => window.__ONESTEP__.actions.listSessions())

export const stageSnapshot = (page) => page.evaluate(() => window.__ONESTEP__.actions.snapshot())

export const stageLayout = (page) => page.evaluate(() => window.__ONESTEP__.actions.layout())

/** 通用 actions 调用（probe.js 面上的方法，如 enterStage / layout）。 */
export const actionCall = (page, method, ...args) =>
  page.evaluate(
    ({ method, args }) => {
      try {
        const fn = window.__ONESTEP__.actions[method]
        if (typeof fn !== 'function') return { ok: false, error: 'missing-action:' + method }
        return { ok: true, value: fn.apply(window.__ONESTEP__.actions, args) }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    { method, args },
  )

/** p3 探针桥通用调用；异常已由桥归一化。 */
export const p3Call = (page, method, ...args) =>
  page.evaluate(
    ({ method, args }) => {
      try {
        const fn = window.__ONESTEP__.actions.p3[method]
        if (typeof fn !== 'function') return { ok: false, error: 'missing-p3-method:' + method }
        return fn.apply(window.__ONESTEP__.actions.p3, args)
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    { method, args },
  )

export const p3Contract = (page) => p3Call(page, 'contract')
export const p3Snapshot = (page) => p3Call(page, 'snapshot')
export const p3Tabs = (page) => p3Call(page, 'tabs')
export const p3OpenTabs = (page) => p3Call(page, 'openTabs')
export const p3Active = (page) => p3Call(page, 'active')
export const p3IsExpanded = (page) => p3Call(page, 'isExpanded')

/** 当前 on-screen 会话 id（sidebarRight.mounted；工作区里的资源地址用它）。p3.snapshot() 返回裸对象。 */
export async function mountedSessionId(page) {
  const snap = await p3Snapshot(page)
  return snap && snap.available ? snap.mounted : null
}

/**
 * 构造 documentpreview 认领的会话资源地址（text kind）：
 * `dsh-resource://file/session/<sessionId>/<path>`（path 相对会话 workspace 根）。
 * @param {string} sessionId
 * @param {string} relativePath
 */
export function fileAddress(sessionId, relativePath) {
  const segments = String(relativePath)
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
  return 'dsh-resource://file/session/' + encodeURIComponent(sessionId) + '/' + segments.join('/')
}

/* ------------------------------------------------------------------ *
 * 舞台
 * ------------------------------------------------------------------ */

const stageReadyPredicate = `(() => {
  const stage = document.querySelector('[data-onestep-stage]')
  if (!stage) return false
  const focus = stage.querySelector('.onestep-frame[data-mode="focus"]')
  if (!focus) return false
  const rect = focus.getBoundingClientRect()
  return rect.width > 2 && rect.height > 2
})()`

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

/**
 * 进入舞台：挑会话 → actions.enterStage(ids)（probe.js 异步实现）→ 等舞台/焦点帧就绪。
 * @returns {{rows:object, ids:string[], picked:string[], ready:boolean, layout:object}}
 */
export async function enterStage(page, options = {}) {
  const want = Math.max(1, Math.min(3, Number(options.count) || 3))
  // 0.6.0 夹具稳健性：重启实例后 sessions 目录可能晚于应用 ready，先等目录非空再挑会话。
  await waitFor(async () => {
    const rows = await listSessions(page)
    return Object.keys(rows || {}).length > 0
  }, { timeout: options.timeout || 20000, label: 'sessions.ready' }).catch(() => {})
  const rows = await listSessions(page)
  const ids = Object.keys(rows || {})
  const ranked = [...ids.filter((id) => !(rows[id] || {}).blank), ...ids.filter((id) => (rows[id] || {}).blank)]
  const picked = ranked.slice(0, Math.min(ranked.length, want + 1))
  if (picked.length === 0) throw new Error('enterStage 需要至少 1 个 sessionId（listSessions 为空）')
  await leaveStage(page)
  await page.evaluate((list) => window.__ONESTEP__.actions.enterStage(list), picked)
  await waitFor(
    () => page.evaluate(() => {
      const snap = window.__ONESTEP__.actions.snapshot()
      return !!snap.mounted && !!document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
    }),
    { timeout: options.timeout || 15000, label: 'stage.mounted' },
  )
  // 0.5.0 起候场上限 6：probe.enterStage 会把 picked 全部加入候场，不再被 3 上限截断。
  // 探针语义保持「1 焦点 + want 候场」：多余候场移出，不足时补足（只影响测试夹具，不改产品行为）。
  // 注意：add/remove 走 VT 异步队列，不能在同一 evaluate 内读快照循环（会造成重复移除/死循环）。
  const trimRemoved = await page.evaluate((count) => {
    const actions = window.__ONESTEP__.actions
    const extras = (actions.snapshot().candidates || []).slice(count)
    for (const id of extras) actions.removeCandidate(id)
    return extras
  }, want)
  if (trimRemoved.length > 0) {
    await sleep(500)
    await waitMotionIdle(page)
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const countNow = await page.evaluate(() => (window.__ONESTEP__.actions.snapshot().candidates || []).length)
    if (countNow >= want) break
    const added = await page.evaluate(() => {
      const actions = window.__ONESTEP__.actions
      const snap = actions.snapshot()
      const pool = Object.keys(actions.listSessions())
      const id = pool.find((candidateId) => candidateId !== snap.focusId && !(snap.candidates || []).includes(candidateId))
      if (!id) return null
      actions.addCandidate(id)
      return id
    })
    if (!added) break
    await sleep(400)
    await waitMotionIdle(page)
  }
  await page.waitForFunction(stageReadyPredicate, null, { timeout: options.timeout || 15000 })
  await waitMotionIdle(page)
  await sleep(options.settleMs === undefined ? 900 : options.settleMs)
  const snap = await stageSnapshot(page)
  const layout = await stageLayout(page)
  return { rows, ids, picked, snapshot: snap, layout }
}

/** 官方右栏当前展开态（读探针桥；无 surface 时 false）。 */
export async function isExpanded(page) {
  const result = await p3IsExpanded(page)
  return !!(result && result.ok !== false && result.value)
}

/* ------------------------------------------------------------------ *
 * DOM 事实采集
 * ------------------------------------------------------------------ */

/**
 * 官方右侧栏 / dockkit 浮窗 / 舞台几何快照（单次 evaluate，帧内可复用）。
 * @returns {Promise<object>}
 */
export async function domState(page) {
  return page.evaluate(() => {
    const round = (rect) => ({
      x: Math.round(rect.x * 100) / 100,
      y: Math.round(rect.y * 100) / 100,
      w: Math.round(rect.width * 100) / 100,
      h: Math.round(rect.height * 100) / 100,
    })
    const rectOf = (el) => (el ? round(el.getBoundingClientRect()) : null)
    const styleOf = (el) => (el ? getComputedStyle(el) : null)
    const stage = document.querySelector('[data-onestep-stage]')
    const focus = stage ? stage.querySelector('.onestep-frame[data-mode="focus"]') : null
    const candidates = stage ? Array.from(stage.querySelectorAll('.onestep-frame[data-mode="candidate"]')) : []
    const panels = Array.from(document.querySelectorAll('[data-sidebar-right-panel]')).map((el) => {
      const style = styleOf(el)
      return {
        session: el.getAttribute('data-sidebar-right-session'),
        panel: el.getAttribute('data-sidebar-right-panel'),
        open: el.hasAttribute('data-sidebar-right-open'),
        opening: el.hasAttribute('data-sidebar-right-opening'),
        rect: rectOf(el),
        width: style.width,
        pointerEvents: style.pointerEvents,
        zIndex: style.zIndex,
        position: style.position,
        transform: style.transform,
      }
    })
    const floats = Array.from(document.querySelectorAll('[data-dockkit-float]')).map((el) => {
      const style = styleOf(el)
      const parent = el.parentElement
      const parentStyle = parent ? getComputedStyle(parent) : null
      const titleEl = el.querySelector('[data-dockkit-float-title]')
      return {
        paneId: el.getAttribute('data-dockkit-float'),
        tabId: el.getAttribute('data-dockkit-content'),
        active: el.hasAttribute('data-dockkit-float-active'),
        ariaHidden: el.getAttribute('aria-hidden'),
        inert: el.hasAttribute('inert') || el.inert === true,
        rect: rectOf(el),
        position: style.position,
        zIndex: style.zIndex,
        pointerEvents: style.pointerEvents,
        styleAttr: String(el.getAttribute('style') || '').slice(0, 400),
        parent: parent ? { tag: parent.tagName, zIndex: parentStyle.zIndex, position: parentStyle.position, rect: rectOf(parent) } : null,
        title: titleEl ? String(titleEl.textContent || '').slice(0, 120) : null,
        hasDock: !!el.querySelector('[data-dockkit-float-dock]'),
        hasClose: !!el.querySelector('[data-dockkit-float-close]'),
        hasGrip: !!el.querySelector('[data-dockkit-float-grip]'),
        hasResize: !!el.querySelector('[data-dockkit-float-resize]'),
        buttons: Array.from(el.querySelectorAll('button')).map((button) => ({
          attrs: ['data-dockkit-float-dock', 'data-dockkit-float-close', 'aria-label', 'title'].reduce((out, name) => {
            if (button.hasAttribute(name)) out[name] = button.getAttribute(name)
            return out
          }, {}),
        })),
      }
    })
    const tabsInDom = Array.from(document.querySelectorAll('[data-dockkit-tab]')).map((el) => ({
      tabId: el.getAttribute('data-dockkit-tab'),
      selected: el.getAttribute('aria-selected'),
      visible: (() => {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden'
      })(),
      title: String(el.textContent || '').slice(0, 80),
    }))
    const probe = window.__ONESTEP__ && window.__ONESTEP__.actions ? window.__ONESTEP__.actions.p3 : null
    const expanded = (() => {
      try {
        const result = probe.isExpanded()
        return result && result.ok !== false ? !!result.value : null
      } catch (_error) {
        return null
      }
    })()
    const p3 = (() => {
      try {
        return probe.snapshot()
      } catch (_error) {
        return null
      }
    })()
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      stage: rectOf(stage),
      focus: rectOf(focus),
      candidates: candidates.map((el) => ({ rect: rectOf(el), sessionId: el.getAttribute('data-onestep-window-session') })),
      panels,
      floats,
      tabsInDom,
      expanded,
      p3: p3 && p3.available ? { mounted: p3.mounted, focusId: p3.focusId, expanded: p3.expanded, activeTab: p3.activeTab, openTabs: p3.openTabs } : p3,
      dom: {
        stageCount: document.querySelectorAll('[data-onestep-stage]').length,
        floatCount: floats.length,
        panelCount: panels.length,
        openPanelCount: panels.filter((panel) => panel.open).length,
        sidebarRightOpenCount: document.querySelectorAll('[data-sidebar-right-open]').length,
        mainPanelOpen: document.querySelectorAll('[data-sidebar-right-panel][data-sidebar-right-open]').length,
      },
    }
  })
}

/** 取「当前展开态对应 panel」的 DOM 事实（有 data-sidebar-right-panel 的那份，优先 mounted 会话）。 */
export function activePanel(state) {
  if (!state || !Array.isArray(state.panels)) return null
  const mounted = state.p3 && state.p3.mounted
  const candidates = state.panels.filter((panel) => panel.panel)
  return candidates.find((panel) => panel.session === mounted) || candidates[0] || null
}

/**
 * 逐帧 rAF 采样。整段循环在页面内执行，避免跨进程往返丢帧。
 *
 * spec:
 * - frames: 采样帧数（默认 40）
 * - triggerFrame: 在第几帧「采样后」执行 action（默认 6；-1 表示不执行）
 * - action: {source:'p3'|'actions', method:string, args:any[]} 可序列化调用
 * - captureP3: 每帧是否调用 p3.active()/isExpanded()（默认 true）
 *
 * @returns {Promise<{frames:object[], actionReturn:any, actionError:any, actionFrame:number, actionDurationMs:number, startedAt:number, endedAt:number}>}
 */
export async function rafSample(page, spec = {}) {
  return page.evaluate(
    (input) => new Promise((resolve) => {
      const frames = []
      const total = Math.max(1, Number(input.frames) || 40)
      const triggerFrame = Number.isFinite(input.triggerFrame) ? input.triggerFrame : 6
      const captureP3 = input.captureP3 !== false
      const startedAt = performance.now()
      let actionReturn = null
      let actionError = null
      let actionDurationMs = null
      let actionFrame = -1

      const round2 = (value) => Math.round(value * 100) / 100
      const rectOf = (el) => {
        if (!el) return null
        const rect = el.getBoundingClientRect()
        return { x: round2(rect.x), y: round2(rect.y), w: round2(rect.width), h: round2(rect.height) }
      }
      const sample = (index) => {
        const stage = document.querySelector('[data-onestep-stage]')
        const focus = stage ? stage.querySelector('.onestep-frame[data-mode="focus"]') : null
        const panels = Array.from(document.querySelectorAll('[data-sidebar-right-panel]')).map((el) => ({
          session: el.getAttribute('data-sidebar-right-session'),
          open: el.hasAttribute('data-sidebar-right-open'),
          opening: el.hasAttribute('data-sidebar-right-opening'),
          rect: rectOf(el),
        }))
        const floats = Array.from(document.querySelectorAll('[data-dockkit-float]')).map((el) => ({
          paneId: el.getAttribute('data-dockkit-float'),
          tabId: el.getAttribute('data-dockkit-content'),
          active: el.hasAttribute('data-dockkit-float-active'),
          rect: rectOf(el),
        }))
        const frame = {
          i: index,
          t: round2(performance.now() - startedAt),
          stage: rectOf(stage),
          focus: rectOf(focus),
          panels,
          floats,
          openPanelCount: panels.filter((panel) => panel.open).length,
        }
        if (captureP3) {
          try {
            const probe = window.__ONESTEP__.actions.p3
            const expanded = probe.isExpanded()
            frame.expanded = expanded && expanded.ok !== false ? !!expanded.value : null
            const active = probe.active()
            frame.activeId = active && active.ok !== false && active.value ? active.value.id : null
          } catch (_error) {
            frame.expanded = null
            frame.activeId = null
          }
        }
        return frame
      }
      const runAction = () => {
        const call = input.action
        if (!call || typeof call.method !== 'string') return
        const target = call.source === 'actions'
          ? window.__ONESTEP__.actions
          : window.__ONESTEP__.actions.p3
        const fn = target[call.method]
        const before = performance.now()
        try {
          if (typeof fn !== 'function') throw new Error('missing-method:' + call.method)
          actionReturn = fn.apply(target, Array.isArray(call.args) ? call.args : [])
        } catch (error) {
          actionError = String((error && error.message) || error)
        }
        actionDurationMs = round2(performance.now() - before)
        actionFrame = index
      }
      let index = 0
      const tick = () => {
        const frame = sample(index)
        frames.push(frame)
        if (index === triggerFrame) runAction()
        index += 1
        if (index >= total) {
          resolve({
            frames,
            actionReturn,
            actionError,
            actionFrame,
            actionDurationMs,
            startedAt: round2(startedAt),
            endedAt: round2(performance.now()),
          })
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }),
    spec,
  )
}

/** 矩形归一化：接受 {x,y,w,h} 或 {x,y,width,height}。 */
export function normalizeRect(rect) {
  if (!rect) return null
  return { x: rect.x, y: rect.y, w: rect.w === undefined ? rect.width : rect.w, h: rect.h === undefined ? rect.height : rect.h }
}

/** 稳定矩形比较：返回各字段最大绝对偏差。 */
export function rectDeviation(a, b) {
  const left = normalizeRect(a)
  const right = normalizeRect(b)
  if (!left || !right) return { max: Infinity, dx: null, dy: null, dw: null, dh: null }
  const dx = Math.abs(left.x - right.x)
  const dy = Math.abs(left.y - right.y)
  const dw = Math.abs(left.w - right.w)
  const dh = Math.abs(left.h - right.h)
  return { max: Math.max(dx, dy, dw, dh), dx, dy, dw, dh }
}

/** 视口内夹取（官方 `.float` CSS 会把 rect clamp 到视口，越界时实际值与期望不同属正常）。 */
export function clampRectToViewport(rect, viewport) {
  const width = Math.min(rect.width, viewport.w)
  const height = Math.min(rect.height, viewport.h)
  const x = Math.max(0, Math.min(rect.x, viewport.w - width))
  const y = Math.max(0, Math.min(rect.y, viewport.h - height))
  return { x, y, width, height }
}

/**
 * 槽位公式（docs/p3-plan.md §5.4）：gap=8，slotW=clamp(340, stage.w*0.30, 480)，
 * y=stage.top+16，h=stage.h-32；第 i 槽从右向左：
 * x = stage.right - 16 - slotW - i*(slotW+gap)。
 * maxSlots = min(3, floor((stage.w - 32 + gap) / (slotW + gap)))，窄屏（视口<900 或 stage.w<760）1 槽。
 * @param {{x:number,y:number,w:number,h:number}} stageRect
 * @param {{viewportWidth?:number}} [options]
 */
export function slotLayout(stageRect, options = {}) {
  const gap = 8
  const viewportWidth = options.viewportWidth || 0
  const slotW = Math.min(480, Math.max(340, stageRect.w * 0.30))
  const rawMax = Math.min(3, Math.floor((stageRect.w - 32 + gap) / (slotW + gap)))
  const narrow = (viewportWidth > 0 && viewportWidth < 900) || stageRect.w < 760
  const maxSlots = Math.max(1, narrow ? 1 : rawMax)
  const slots = []
  for (let index = 0; index < 3; index += 1) {
    slots.push({
      x: stageRect.x + stageRect.w - 16 - slotW - index * (slotW + gap),
      y: stageRect.y + 16,
      width: slotW,
      height: stageRect.h - 32,
    })
  }
  return { gap, slotW, rawMaxSlots: rawMax, maxSlots, narrow, slots }
}

export function rectsOverlap(a, b) {
  if (!a || !b) return false
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

export function roundRect(rect) {
  if (!rect) return null
  const round = (value) => Math.round(value * 100) / 100
  const out = { x: round(rect.x), y: round(rect.y), w: round(rect.w === undefined ? rect.width : rect.w), h: round(rect.h === undefined ? rect.height : rect.h) }
  return out
}
