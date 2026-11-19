#!/usr/bin/env node
/**
 * P2-7 发布演练浏览器探针（Playwright headless Edge，只读/受控写入 onestep-p2 实例）。
 *
 * 用途：对独立 profile onestep-p2（端口 4661）做安装/升级/卸载/坏 bundle 的浏览器层证据采集。
 * 与 P2 验证套件（scripts/p2/verify/lib.mjs）解耦：这里要能在「插件缺失/整页 boot 失败」时也出证据，
 * 所以不假设 __ONESTEP__ 存在。
 *
 * 模式：
 *   boot           只采集：boot graph entries / dsh-onestep entry / __ONESTEP__ 是否存在 / 官方 UI / 探针 DOM / 页面错误
 *   positive       正向冒烟：安装后 boot+__ONESTEP__ 就绪、官方 UI 正常、进入舞台（1 焦点 + N 候场）、退出舞台、0 pageerror
 *   absent         卸载后断言：官方 UI 正常、无 boot entry、无 __ONESTEP__、无插件 DOM、无错误
 *   bad            坏 bundle 观察：如实记录 boot 失败模式（官方是否渲染、SyntaxError、bundle 请求失败）
 *   settings-write 打开页面（需要持久 user-data-dir），写入 localStorage 舞台设置 + 标记后退出
 *
 * 用法（仓库根）：
 *   node scripts/p2/pack/browser.mjs --mode boot --out artifacts/p2/pack/boot-before.json
 *   node scripts/p2/pack/browser.mjs --mode positive --candidates 2 --expect-version 0.1.0-p1.0 --out artifacts/p2/pack/smoke-install.json
 *   node scripts/p2/pack/browser.mjs --mode absent --out artifacts/p2/pack/uninstall-probe.json
 *   node scripts/p2/pack/browser.mjs --mode bad --out artifacts/p2/pack/bad-bundle.json
 *   node scripts/p2/pack/browser.mjs --mode settings-write --persistent-dir tmp/pw-p2-profile --settings "{\"railSide\":\"right\"}"
 *
 * 退出码：0 断言全过 / 1 断言失败 / 2 用法 / 3 目标不可达 / 4 浏览器启动失败 / 5 页面就绪超时。
 * 证据里 URL 的 token 一律掩码。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const OUT_DIR = path.join(ROOT, 'artifacts', 'p2', 'pack')
const DEFAULT_URL_FILE = path.join(OUT_DIR, 'server-url.txt')
const SETTINGS_KEY = 'dsh.onestep.v1'
const MARKER_KEY = 'onestep.rehearsal.marker'
const EXIT = { OK: 0, FAIL: 1, USAGE: 2, TARGET: 3, LAUNCH: 4, TIMEOUT: 5 }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const maskUrl = (text) => String(text || '').replace(/([?&]token=)[^&#\s]+/g, '$1***')

function parseArgs(argv) {
  const cfg = {
    mode: 'boot', urlFile: DEFAULT_URL_FILE, url: null, out: null, shotDir: path.join(OUT_DIR, 'shots'),
    expectVersion: null, candidates: 2, expectSettings: false, persistentDir: null, settings: null,
    timeout: 60000, readyTimeout: 25000, settle: 1500, headless: true, quiet: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--mode') cfg.mode = argv[++i]
    else if (arg === '--url-file') cfg.urlFile = path.resolve(ROOT, argv[++i])
    else if (arg === '--url') cfg.url = argv[++i]
    else if (arg === '--out') cfg.out = path.resolve(ROOT, argv[++i])
    else if (arg === '--shot-dir') cfg.shotDir = path.resolve(ROOT, argv[++i])
    else if (arg === '--expect-version') cfg.expectVersion = argv[++i]
    else if (arg === '--candidates') cfg.candidates = Number(argv[++i])
    else if (arg === '--expect-settings') cfg.expectSettings = true
    else if (arg === '--persistent-dir') cfg.persistentDir = path.resolve(ROOT, argv[++i])
    else if (arg === '--settings') cfg.settings = JSON.parse(argv[++i])
    else if (arg === '--settings-file') cfg.settings = JSON.parse(fs.readFileSync(path.resolve(ROOT, argv[++i]), 'utf8'))
    else if (arg === '--timeout') cfg.timeout = Number(argv[++i])
    else if (arg === '--ready-timeout') cfg.readyTimeout = Number(argv[++i])
    else if (arg === '--settle') cfg.settle = Number(argv[++i])
    else if (arg === '--quiet') cfg.quiet = true
    else throw new Error('unknown argument: ' + arg)
  }
  if (!['boot', 'positive', 'absent', 'bad', 'settings-write'].includes(cfg.mode)) throw new Error('unknown mode: ' + cfg.mode)
  cfg.out = cfg.out || path.join(OUT_DIR, 'browser-' + cfg.mode + '.json')
  return cfg
}

function loadPlaywright() {
  const require = createRequire(path.join(ROOT, 'tools', 'pw') + path.sep)
  return { pw: require('playwright-core'), version: require('playwright-core/package.json').version }
}

function readTargetUrl(cfg) {
  if (cfg.url) return { url: cfg.url, source: { kind: 'url-arg' } }
  if (!fs.existsSync(cfg.urlFile)) throw Object.assign(new Error('URL 文件不存在: ' + cfg.urlFile), { code: 'USAGE' })
  const raw = fs.readFileSync(cfg.urlFile, 'utf8')
  const url = raw.split('#')[0].trim().split(/\r?\n/)[0].trim()
  if (!/^https?:\/\//.test(url)) throw Object.assign(new Error('URL 文件内容不是 http(s) URL'), { code: 'USAGE' })
  const stat = fs.statSync(cfg.urlFile)
  return {
    url,
    source: { kind: 'url-file', path: path.relative(ROOT, cfg.urlFile).split(path.sep).join('/'), mtime: stat.mtime.toISOString(), ageSeconds: Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000)) },
  }
}

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase() } catch (_error) { return null }
}

/** 页面内采集（单次 evaluate；任何异常都吞掉，坏 bundle 场景也要能出证据）。 */
function collectInPage() {
  const q = (selector) => document.querySelectorAll(selector).length
  const has = (selector) => !!document.querySelector(selector)
  const boot = window.__DSH_BOOT__ || null
  const entries = boot && Array.isArray(boot.entries) ? boot.entries : []
  const selfEntry = entries.find((entry) => entry && entry.id === 'dsh-onestep') || null
  const api = window.__ONESTEP__ || null
  let snapshot = null
  let snapshotError = null
  if (api) {
    try { snapshot = api.actions && typeof api.actions.snapshot === 'function' ? api.actions.snapshot() : (typeof api.snapshot === 'function' ? api.snapshot() : null) } catch (error) { snapshotError = String((error && error.message) || error) }
  }
  let storage = null
  let storageRaw = null
  let marker = null
  try {
    storageRaw = localStorage.getItem('dsh.onestep.v1')
    storage = storageRaw ? JSON.parse(storageRaw) : null
  } catch (error) { storage = { __parseError: String(error) } }
  try { marker = localStorage.getItem('onestep.rehearsal.marker') } catch (_error) { marker = null }
  const controls = []
  for (const el of Array.from(document.querySelectorAll('button, [role="button"], a[href]')).slice(0, 400)) {
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').trim()).replace(/\s+/g, ' ').slice(0, 48)
    if (!label) continue
    if (/新|new|会话|session|创建|create|add/i.test(label)) {
      controls.push({ tag: el.tagName, label, cls: String(el.className || '').slice(0, 60) })
      if (controls.length >= 20) break
    }
  }
  const stage = document.querySelector('[data-onestep-stage]')
  const frames = stage ? Array.from(stage.querySelectorAll('.onestep-frame')) : []
  return {
    title: document.title,
    urlWithoutQuery: String(location.href).replace(/\?.*$/, ''),
    readyState: document.readyState,
    boot: boot ? {
      release: boot.release || null,
      rev: boot.rev || null,
      entriesCount: entries.length,
      hasSelfEntry: !!selfEntry,
      selfEntry: selfEntry ? { id: selfEntry.id, url: selfEntry.url, rev: selfEntry.rev } : null,
      entriesTail: entries.slice(-3).map((entry) => entry && entry.id),
    } : null,
    onestepPresent: !!api,
    onestep: api ? {
      version: api.version || null,
      hasActions: !!(api.actions && typeof api.actions === 'object'),
      actionNames: api.actions && typeof api.actions === 'object' ? Object.keys(api.actions).sort() : [],
      hasLog: typeof api.log === 'function',
    } : null,
    snapshot: snapshot ? {
      version: snapshot.version,
      mounted: !!snapshot.mounted,
      mainReady: !!snapshot.mainReady,
      focusId: snapshot.focusId || null,
      candidates: Array.isArray(snapshot.candidates) ? snapshot.candidates : [],
      stageActive: !!snapshot.stageActive,
      railSide: snapshot.railSide,
      railSize: snapshot.railSize,
      railCollapsed: snapshot.railCollapsed,
      previewMode: snapshot.previewMode,
      autoLite: snapshot.autoLite || null,
      rowsTotal: typeof snapshot.rowsTotal === 'number' ? snapshot.rowsTotal : null,
      dom: snapshot.dom || null,
    } : null,
    snapshotError,
    storage: { raw: storageRaw, parsed: storage, marker },
    dom: {
      stage: q('[data-onestep-stage]'),
      frames: frames.length,
      focusFrames: stage ? stage.querySelectorAll('.onestep-frame[data-mode="focus"]').length : 0,
      candidateFrames: stage ? stage.querySelectorAll('.onestep-frame[data-mode="candidate"]').length : 0,
      occurrences: q('[data-onestep-occurrence]'),
      rowActions: q('[data-onestep-row-action]'),
      headerActions: q('[data-onestep-header-action]'),
      stylesTag: q('style[data-onestep="1"]'),
      probePanels: q('.onestep-probe'),
      quickBars: q('.onestep-quick'),
      officialConversation: q('[data-conversation-content]'),
      editableComposers: q('[contenteditable="true"]'),
      textboxes: q('[role="textbox"], textarea'),
      sessionRows: q('[data-row-key]'),
      inertBodies: q('.onestep-body[data-inert="1"]'),
    },
    bodyTextLength: document.body ? document.body.innerText.length : 0,
    bodyTextHead: document.body ? document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 300) : '',
    newSessionControls: controls,
  }
}

function judge(checks, id, name, pass, detail) {
  checks.push({ id, name, pass: !!pass, detail: detail === undefined ? null : detail })
}

async function screenshot(page, cfg, name) {
  try {
    fs.mkdirSync(cfg.shotDir, { recursive: true })
    const file = path.join(cfg.shotDir, name + '.png')
    await page.screenshot({ path: file, fullPage: false })
    return { path: path.relative(ROOT, file).split(path.sep).join('/'), bytes: fs.statSync(file).size }
  } catch (_error) { return null }
}

/** 打开页面 + 事件采集。mode=bad 时接受官方 UI 不出现。 */
async function openPage(cfg, playwright, target, events) {
  let browser = null
  let context = null
  if (cfg.persistentDir) {
    fs.mkdirSync(cfg.persistentDir, { recursive: true })
    context = await playwright.chromium.launchPersistentContext(cfg.persistentDir, {
      channel: 'msedge', headless: cfg.headless, viewport: { width: 1440, height: 900 }, colorScheme: null,
    })
    browser = context
  } else {
    browser = await playwright.chromium.launch({ channel: 'msedge', headless: cfg.headless })
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: null })
  }
  const page = context.pages && context.pages().length ? context.pages()[0] : await context.newPage()
  page.setDefaultTimeout(30000)
  for (const [event, handler] of Object.entries({
    console: (message) => {
      if (events.consoleMessages.length < 300) events.consoleMessages.push({ level: message.type(), text: String(message.text()).slice(0, 500) })
    },
    pageerror: (error) => events.pageErrors.push({ text: String((error && error.message) || error).slice(0, 700) }),
    requestfailed: (request) => {
      if (events.requestFailures.length < 60) events.requestFailures.push({ url: maskUrl(request.url()), error: request.failure() ? request.failure().errorText : null })
    },
    response: (response) => {
      if (response.status() >= 500 && events.httpErrors.length < 40) events.httpErrors.push({ status: response.status(), url: maskUrl(response.url()) })
    },
    dialog: async (dialog) => {
      events.dialogs.push({ type: dialog.type(), message: dialog.message().slice(0, 300) })
      await dialog.dismiss().catch(() => {})
    },
  })) page.on(event, handler)
  return { browser, context, page, persistent: !!cfg.persistentDir }
}

async function closePage(handle) {
  try { await handle.context.close() } catch (_error) { /* ignore */ }
  if (!handle.persistent) { try { await handle.browser.close() } catch (_error) { /* ignore */ } }
}

async function waitComposer(page, timeout) {
  try {
    await page.waitForSelector('[contenteditable="true"], [role="textbox"], textarea', { timeout })
    return true
  } catch (_error) { return false }
}

async function waitBoot(page, timeout) {
  try {
    await page.waitForFunction(() => !!window.__DSH_BOOT__, null, { timeout, polling: 100 })
    return true
  } catch (_error) { return false }
}

const consoleErrorFilter = (message) => message.level === 'error' && !/favicon|Failed to load resource/i.test(message.text)

function summarizeErrors(events) {
  const consoleErrors = events.consoleMessages.filter(consoleErrorFilter)
  return {
    pageErrors: events.pageErrors,
    consoleErrors,
    requestFailures: events.requestFailures,
    httpErrors: events.httpErrors,
    dialogs: events.dialogs,
    counts: { consoleError: consoleErrors.length, pageError: events.pageErrors.length, requestFailure: events.requestFailures.length, httpError: events.httpErrors.length },
    clean: events.pageErrors.length === 0 && consoleErrors.length === 0 && events.requestFailures.length === 0 && events.httpErrors.length === 0,
  }
}

/* ------------------------------------------------------------------ *
 * 模式实现
 * ------------------------------------------------------------------ */

async function runBoot(cfg, playwright, target, result) {
  const events = result.events
  const handle = await openPage(cfg, playwright, target, events)
  let pageData = null
  let composer = false
  try {
    await handle.page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: cfg.timeout })
    const boot = await waitBoot(handle.page, cfg.readyTimeout)
    composer = await waitComposer(handle.page, boot ? 20000 : 5000)
    await sleep(cfg.settle)
    pageData = await handle.page.evaluate(collectInPage)
    result.screenshots.push(await screenshot(handle.page, cfg, 'boot'))
  } finally {
    await closePage(handle)
  }
  result.page = pageData
  result.officialReady = composer
  const checks = result.checks
  judge(checks, 'page.boot', '__DSH_BOOT__ 可读', !!(pageData && pageData.boot && pageData.boot.release), pageData && pageData.boot ? { release: pageData.boot.release, entriesCount: pageData.boot.entriesCount } : null)
  judge(checks, 'official.ready', '官方界面就绪（composer 可见 + 官方会话区）', composer && !!(pageData && pageData.dom.officialConversation >= 1 && pageData.bodyTextLength > 100), pageData ? { composer, officialConversation: pageData.dom.officialConversation, bodyTextLength: pageData.bodyTextLength } : null)
  judge(checks, 'console.clean', '无 pageerror / console error / 请求失败 / 5xx', summarizeErrors(events).clean, summarizeErrors(events).counts)
  if (cfg.mode === 'boot' && cfg.expectVersion) judge(checks, 'onestep.version', '__ONESTEP__.version == ' + cfg.expectVersion, !!(pageData && pageData.onestep && pageData.onestep.version === cfg.expectVersion), pageData && pageData.onestep ? { version: pageData.onestep.version } : null)
  return pageData
}

async function runPositive(cfg, playwright, target, result) {
  const events = result.events
  const handle = await openPage(cfg, playwright, target, events)
  let pageData = null
  try {
    await handle.page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: cfg.timeout })
    const boot = await waitBoot(handle.page, cfg.readyTimeout)
    const composer = await waitComposer(handle.page, boot ? 30000 : 5000)
    result.officialReady = composer
    let probeReady = false
    try {
      await handle.page.waitForFunction(() => !!window.__ONESTEP__ && !!window.__ONESTEP__.actions, null, { timeout: cfg.readyTimeout, polling: 100 })
      probeReady = true
    } catch (_error) { probeReady = false }
    await sleep(cfg.settle)
    result.probeReady = probeReady
    pageData = await handle.page.evaluate(collectInPage)
    result.pageBeforeStage = pageData
    result.screenshots.push(await screenshot(handle.page, cfg, 'normal-mode'))

    // 舞台：进入 1 焦点 + N 候场
    let stageInfo = null
    if (probeReady) stageInfo = await enterStage(handle.page, cfg, result)
    result.stage = stageInfo
    if (stageInfo && stageInfo.ok) {
      result.screenshots.push(await screenshot(handle.page, cfg, 'stage-' + cfg.candidates + 'candidates'))
      // 退出舞台 → 恢复官方界面
      const exitInfo = await handle.page.evaluate(async () => {
        const api = window.__ONESTEP__
        api.actions.exitStage()
        return api.actions.snapshot()
      })
      await sleep(800)
      const afterExit = await handle.page.evaluate(collectInPage)
      result.afterExit = { snapshot: afterExit.snapshot, dom: afterExit.dom, officialTextLength: afterExit.bodyTextLength }
      result.exitInfo = { mountedAfterExit: exitInfo.mounted, candidatesAfterExit: exitInfo.candidates.length }
      result.screenshots.push(await screenshot(handle.page, cfg, 'after-exit'))
    }
  } finally {
    await closePage(handle)
  }

  const checks = result.checks
  const data = pageData
  judge(checks, 'page.boot', '__DSH_BOOT__ 可读', !!(data && data.boot && data.boot.release), data && data.boot ? { release: data.boot.release, entriesCount: data.boot.entriesCount } : null)
  judge(checks, 'boot.self-entry', 'boot entries 含 dsh-onestep 且 client bundle URL 正确', !!(data && data.boot && data.boot.hasSelfEntry && /dsh-onestep\/client\.js/.test(String(data.boot.selfEntry && data.boot.selfEntry.url))), data && data.boot ? { id: data.boot.selfEntry && data.boot.selfEntry.id, url: data.boot.selfEntry && data.boot.selfEntry.url, entriesCount: data.boot.entriesCount } : null)
  judge(checks, 'official.ready', '普通模式官方界面正常（会话区 + 可编辑 composer）', !!(result.officialReady && data && data.dom.officialConversation >= 1 && data.dom.editableComposers >= 1 && data.bodyTextLength > 100), data ? { composer: result.officialReady, officialConversation: data.dom.officialConversation, editableComposers: data.dom.editableComposers, bodyTextLength: data.bodyTextLength } : null)
  judge(checks, 'onestep.ready', 'window.__ONESTEP__ 就绪（version/snapshot/actions/log）', !!(data && data.onestepPresent && data.onestep && data.onestep.version && data.onestep.hasActions && data.onestep.hasLog), data && data.onestep ? { version: data.onestep.version, actionCount: data.onestep.actionNames.length } : null)
  if (cfg.expectVersion) judge(checks, 'onestep.version', '__ONESTEP__.version == ' + cfg.expectVersion, !!(data && data.onestep && data.onestep.version === cfg.expectVersion), data && data.onestep ? { version: data.onestep.version, expected: cfg.expectVersion } : null)
  const storage = data && data.storage
  if (cfg.expectSettings) {
    const expected = cfg.settings || {}
    const actual = (storage && storage.parsed) || {}
    const fieldsOk = Object.keys(expected).every((key) => JSON.stringify(actual[key]) === JSON.stringify(expected[key]))
    judge(checks, 'storage.persisted', '升级后 localStorage 舞台设置不丢（字段一致）', !!(fieldsOk && storage && storage.marker), { expected: expected, actual: actual, marker: storage && storage.marker })
    // 运行期可观测字段：probe snapshot 暴露 railSide / railSize / railCollapsed / previewMode
    // （autoLite 在 snapshot 里是运行时对象、persistStage 不参与渲染，不做运行期比对）。
    const runtimeKeys = ['railSide', 'railSize', 'railCollapsed', 'previewMode']
    const snap = data && data.snapshot
    const runtimeExpected = {}
    for (const key of Object.keys(expected)) if (runtimeKeys.includes(key)) runtimeExpected[key] = expected[key]
    const runtimeOk = !!snap && Object.keys(runtimeExpected).every((key) => JSON.stringify(snap[key]) === JSON.stringify(runtimeExpected[key]))
    judge(checks, 'storage.applied', '持久化设置在运行期生效（snapshot 字段一致）', runtimeOk, snap ? { expected: runtimeExpected, railSide: snap.railSide, railSize: snap.railSize, railCollapsed: snap.railCollapsed, previewMode: snap.previewMode } : null)
  }
  const stage = result.stage || {}
  judge(checks, 'stage.mounted', '进入舞台：' + (1 + cfg.candidates) + ' 窗（1 焦点 + ' + cfg.candidates + ' 候场）', !!(stage.ok && stage.mounted && stage.focusFrames === 1 && stage.candidateFrames === cfg.candidates && stage.candidates === cfg.candidates && stage.focusHasContent), stage.snapshot ? { mounted: stage.mounted, focusFrames: stage.focusFrames, candidateFrames: stage.candidateFrames, candidates: stage.candidates, focusHasContent: stage.focusHasContent, focus: stage.focus, rowsTotal: stage.rowsTotal, added: (stage.addResults || []).filter((item) => item.addedNow).length } : stage)
  judge(checks, 'stage.exit', '退出舞台后 DOM 归零、官方界面恢复', !!(result.exitInfo && result.exitInfo.mountedAfterExit === false && result.exitInfo.candidatesAfterExit === 0 && result.afterExit && result.afterExit.dom.stage === 0 && result.afterExit.officialTextLength > 100), result.exitInfo ? { ...result.exitInfo, dom: result.afterExit && result.afterExit.dom, afterExitTextLength: result.afterExit && result.afterExit.officialTextLength } : null)
  const errs = summarizeErrors(events)
  judge(checks, 'console.clean', '无 pageerror / console error / 请求失败 / 5xx', errs.clean, errs.counts)
}

async function enterStage(page, cfg, result) {
  const wanted = Math.max(1, Math.min(3, Number(cfg.candidates) || 2))
  const prep = await page.evaluate(() => {
    const api = window.__ONESTEP__ || null
    if (!api) return { error: 'no-probe' }
    let rows = {}
    try { rows = api.actions.listSessions() || {} } catch (error) { return { error: 'listSessions: ' + String(error) } }
    let current = null
    try { current = api.actions.currentSessionId ? api.actions.currentSessionId() : null } catch (_error) { current = null }
    const snap = api.actions.snapshot()
    return {
      ids: Object.keys(rows),
      rows: Object.keys(rows).map((id) => ({ id, blank: !!(rows[id] || {}).blank, title: String((rows[id] || {}).title || '').slice(0, 40), keys: Object.keys(rows[id] || {}) })),
      current, focus: snap.focusId || null, mounted: snap.mounted, candidates: snap.candidates,
    }
  })
  result.stagePrep = prep
  if (prep.error) return { ok: false, error: prep.error }
  // 清空持久化恢复的旧舞台（若有），保证从普通模式开始
  await page.evaluate(() => { try { window.__ONESTEP__.actions.exitStage() } catch (_error) { /* ignore */ } })
  await sleep(500)
  // probe.api.addCandidate 返回 snapshot 而非 {ok}，因此用「候场数量增长 + 含该 id」判断是否真的加入。
  const addResults = []
  let added = 0
  for (const row of prep.rows) {
    if (added >= wanted) break
    if (row.id === prep.current) continue
    const res = await page.evaluate((sessionId) => {
      const api = window.__ONESTEP__
      const before = api.actions.snapshot().candidates.slice()
      try { api.actions.addCandidate(sessionId) } catch (error) { return { error: String(error) } }
      const after = api.actions.snapshot()
      return {
        before,
        afterCandidates: after.candidates.slice(),
        focusId: after.focusId || null,
        contains: after.candidates.indexOf(sessionId) !== -1,
        grew: after.candidates.length > before.length,
        mounted: snapshotMounted(after),
      }
      function snapshotMounted(snap) { return !!snap.mounted }
    }, row.id)
    const addedNow = !!(res && res.contains && res.grew)
    if (addedNow) added += 1
    addResults.push({ sessionId: row.id, blank: row.blank, title: row.title, addedNow, res: res && { grew: res.grew, contains: res.contains, mounted: res.mounted, focusId: res.focusId, candidates: res.afterCandidates, error: res.error } })
  }
  result.stageAddResults = addResults
  let mounted = false
  try {
    await page.waitForFunction((want) => {
      const api = window.__ONESTEP__
      if (!api) return false
      const snap = api.actions.snapshot()
      return snap.mounted === true && snap.candidates.length === want
    }, wanted, { timeout: 15000, polling: 100 })
    mounted = true
  } catch (_error) { mounted = false }
  await sleep(1200)
  const probe = await page.evaluate(collectInPage)
  const focus = await page.evaluate(() => {
    const frame = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
    if (!frame) return { present: false, hasContent: false }
    const rect = frame.getBoundingClientRect()
    const overview = frame.querySelector('[data-conversation-content]')
    const overviewRect = overview ? overview.getBoundingClientRect() : null
    return {
      present: true,
      hasContent: !!(overview && overviewRect.width > 2 && overviewRect.height > 2),
      rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
      mode: frame.getAttribute('data-mode'),
    }
  })
  return {
    ok: true,
    mounted: mounted && !!(probe.snapshot && probe.snapshot.mounted),
    candidates: probe.snapshot ? probe.snapshot.candidates.length : 0,
    focusId: probe.snapshot ? probe.snapshot.focusId : null,
    focusFrames: probe.dom.focusFrames,
    candidateFrames: probe.dom.candidateFrames,
    focusHasContent: !!(focus && focus.hasContent),
    focus,
    rowsTotal: probe.snapshot ? probe.snapshot.rowsTotal : null,
    dom: probe.dom,
    snapshot: probe.snapshot,
    addResults,
  }
}

async function runAbsent(cfg, playwright, target, result) {
  const events = result.events
  const handle = await openPage(cfg, playwright, target, events)
  let pageData = null
  try {
    await handle.page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: cfg.timeout })
    const boot = await waitBoot(handle.page, cfg.readyTimeout)
    const composer = await waitComposer(handle.page, boot ? 30000 : 5000)
    result.officialReady = composer
    await sleep(cfg.settle + 1000)
    pageData = await handle.page.evaluate(collectInPage)
    result.screenshots.push(await screenshot(handle.page, cfg, 'after-uninstall'))
  } finally {
    await closePage(handle)
  }
  result.page = pageData
  const checks = result.checks
  const data = pageData || {}
  const dom = data.dom || {}
  judge(checks, 'page.boot', '__DSH_BOOT__ 可读', !!(data.boot && data.boot.release), data.boot ? { release: data.boot.release, entriesCount: data.boot.entriesCount } : null)
  judge(checks, 'boot.entry-absent', 'boot entries 不含 dsh-onestep', !(data.boot && data.boot.hasSelfEntry), data.boot ? { entriesCount: data.boot.entriesCount, hasSelfEntry: data.boot.hasSelfEntry } : null)
  judge(checks, 'probe.absent', '无 window.__ONESTEP__ 全局', data.onestepPresent === false, { onestepPresent: data.onestepPresent })
  const domResidue = ['stage', 'frames', 'occurrences', 'rowActions', 'headerActions', 'stylesTag', 'probePanels', 'quickBars', 'inertBodies']
    .filter((key) => (dom[key] || 0) > 0)
    .map((key) => key + '=' + dom[key])
  judge(checks, 'dom.absent', '无插件探针/舞台 DOM 残留', domResidue.length === 0, { residue: domResidue, dom })
  judge(checks, 'official.ready', '官方会话与 composer 正常', !!(result.officialReady && dom.officialConversation >= 1 && dom.editableComposers >= 1 && data.bodyTextLength > 100), { composer: result.officialReady, officialConversation: dom.officialConversation, editableComposers: dom.editableComposers, bodyTextLength: data.bodyTextLength })
  const errs = summarizeErrors(events)
  judge(checks, 'console.clean', '无 pageerror / console error / 请求失败 / 5xx', errs.clean, errs.counts)
}

async function runBad(cfg, playwright, target, result) {
  const events = result.events
  const handle = await openPage(cfg, playwright, target, events)
  let pageData = null
  let composer = false
  let bootSeen = false
  try {
    await handle.page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: cfg.timeout })
    bootSeen = await waitBoot(handle.page, Math.min(cfg.readyTimeout, 15000))
    composer = await waitComposer(handle.page, cfg.readyTimeout)
    await sleep(2000)
    pageData = await handle.page.evaluate(collectInPage)
    result.screenshots.push(await screenshot(handle.page, cfg, 'bad-bundle'))
  } finally {
    await closePage(handle)
  }
  result.page = pageData
  result.bootSeen = bootSeen
  result.officialComposerSeen = composer
  const errs = summarizeErrors(events)
  result.failureMode = {
    bootPayloadSeen: bootSeen,
    officialUiRendered: !!(composer && pageData && pageData.dom.officialConversation >= 1 && pageData.bodyTextLength > 100),
    appShellRendered: !!(pageData && pageData.bodyTextLength > 100),
    onestepPresent: !!(pageData && pageData.onestepPresent),
    selfEntryAdvertised: !!(pageData && pageData.boot && pageData.boot.hasSelfEntry),
    pageErrorCount: errs.counts.pageError,
    pageErrorTexts: errs.pageErrors.map((item) => item.text).slice(0, 5),
    consoleErrorTexts: errs.consoleErrors.map((item) => item.text).slice(0, 5),
    requestFailureTexts: errs.requestFailures.map((item) => ({ url: item.url, error: item.error })).slice(0, 5),
    httpErrors: errs.httpErrors.slice(0, 5),
    bodyTextHead: pageData ? pageData.bodyTextHead : null,
    bodyTextLength: pageData ? pageData.bodyTextLength : null,
  }
  const checks = result.checks
  judge(checks, 'bad.observed', '坏 bundle 失败模式已采集（有 boot 图/官方 UI/错误事件证据）', !!(pageData && pageData.boot), pageData && pageData.boot ? { entriesCount: pageData.boot.entriesCount, selfEntry: pageData.boot.selfEntry } : null)
  judge(checks, 'bad.self-entry', '坏 bundle 仍被 boot graph 广告（插件包安装生效）', !!(pageData && pageData.boot && pageData.boot.hasSelfEntry), pageData && pageData.boot ? { selfEntry: pageData.boot.selfEntry } : null)
  // 负向场景的判定是「记录」而非「通过/失败」：只要确实观察到失败/或确实未影响官方，都如实写入。
  const failed = !result.failureMode.officialUiRendered || errs.counts.pageError > 0 || errs.counts.consoleError > 0
  judge(checks, 'bad.recorded', '失败模式已如实分类（是否需要恢复动作）', true, { observedBootFailure: !result.failureMode.officialUiRendered, consoleErrors: errs.counts })
  result.needsRecovery = failed
}

async function runSettingsWrite(cfg, playwright, target, result) {
  const events = result.events
  if (!cfg.persistentDir) throw Object.assign(new Error('settings-write 需要 --persistent-dir（持久 user-data-dir 才能跨重启保留 localStorage）'), { code: 'USAGE' })
  const settings = cfg.settings || { railSide: 'right', railSize: 288, previewMode: 'card', autoLite: false, persistStage: true }
  const handle = await openPage(cfg, playwright, target, events)
  let written = null
  try {
    await handle.page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: cfg.timeout })
    const boot = await waitBoot(handle.page, cfg.readyTimeout)
    const composer = await waitComposer(handle.page, boot ? 30000 : 5000)
    result.officialReady = composer
    await sleep(1200)
    written = await handle.page.evaluate(({ key, markerKey, fields, marker }) => {
      let current = {}
      try { current = JSON.parse(localStorage.getItem(key) || '{}') || {} } catch (_error) { current = {} }
      const next = { ...current, version: 3, ...fields }
      localStorage.setItem(key, JSON.stringify(next))
      localStorage.setItem(markerKey, marker)
      return { stored: JSON.parse(localStorage.getItem(key)), marker: localStorage.getItem(markerKey) }
    }, { key: SETTINGS_KEY, markerKey: MARKER_KEY, fields: settings, marker: 'p2-7-upgrade-' + settings.previewMode })
    result.settingsWritten = written
  } finally {
    await closePage(handle)
  }
  const checks = result.checks
  judge(checks, 'settings.written', 'localStorage 舞台设置已写入（持久 user-data-dir）', !!(written && written.stored), written)
  const errs = summarizeErrors(events)
  judge(checks, 'console.clean', '写入过程无页面错误', errs.clean, errs.counts)
}

async function main() {
  let cfg
  try { cfg = parseArgs(process.argv.slice(2)) } catch (error) {
    process.stderr.write('[browser] ' + String(error && error.message ? error.message : error) + '\n')
    process.exitCode = EXIT.USAGE
    return
  }
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const result = {
    ok: false, probe: { name: 'p2-7-pack-rehearsal-browser', version: '1.0.0', mode: cfg.mode },
    startedAt, target: null, browser: null, events: { consoleMessages: [], pageErrors: [], requestFailures: [], httpErrors: [], dialogs: [] },
    screenshots: [], checks: [], page: null,
  }
  let target
  try { target = readTargetUrl(cfg) } catch (error) {
    result.error = { kind: 'usage', message: error.message }
    writeResult(cfg, result, t0)
    process.exitCode = EXIT.USAGE
    return
  }
  result.target = { requestedUrl: maskUrl(target.url), source: target.source }
  const pre = await (async () => {
    try {
      const res = await fetch(target.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) })
      return { status: res.status, ok: res.status >= 200 && res.status < 400, authRequired: res.status === 401 }
    } catch (error) { return { status: null, ok: false, error: String(error) } }
  })()
  result.preflight = pre
  if (!pre.ok) {
    result.error = { kind: pre.authRequired ? 'auth-required' : 'unreachable', message: pre.authRequired ? '实例要求鉴权，URL token 可能已失效（重启后需重读 server-url.txt）' : '实例不可达' }
    writeResult(cfg, result, t0)
    process.exitCode = EXIT.TARGET
    return
  }
  let playwright
  try { playwright = loadPlaywright() } catch (error) {
    result.error = { kind: 'launch', message: error.message }
    writeResult(cfg, result, t0)
    process.exitCode = EXIT.LAUNCH
    return
  }
  result.browser = { version: playwright.version, channel: 'msedge', headless: cfg.headless, persistent: !!cfg.persistentDir }
  result.build = {
    packageVersion: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
    clientJs: { sha256: sha256File(path.join(ROOT, 'client.js')), bytes: fs.existsSync(path.join(ROOT, 'client.js')) ? fs.statSync(path.join(ROOT, 'client.js')).size : null },
  }
  try {
    if (cfg.mode === 'boot') await runBoot(cfg, playwright.pw, target, result)
    else if (cfg.mode === 'positive') await runPositive(cfg, playwright.pw, target, result)
    else if (cfg.mode === 'absent') await runAbsent(cfg, playwright.pw, target, result)
    else if (cfg.mode === 'bad') await runBad(cfg, playwright.pw, target, result)
    else if (cfg.mode === 'settings-write') await runSettingsWrite(cfg, playwright.pw, target, result)
  } catch (error) {
    result.error = { kind: 'probe', message: String((error && error.message) || error), name: error && error.name }
    const eventCounts = summarizeErrors(result.events).counts
    writeResult(cfg, result, t0, eventCounts)
    process.stderr.write('[browser] FAIL ' + result.error.message + '\n')
    process.exitCode = /timeout/i.test(result.error.message) ? EXIT.TIMEOUT : EXIT.FAIL
    return
  }
  const failed = result.checks.filter((check) => !check.pass)
  result.failedChecks = failed.map((check) => check.id)
  result.ok = failed.length === 0 && !result.error
  writeResult(cfg, result, t0)
  if (!cfg.quiet) {
    const lines = [
      '[browser] mode=' + cfg.mode + ' target=' + maskUrl(target.url),
      '[browser] checks ' + (result.checks.length - failed.length) + '/' + result.checks.length + ' passed',
      ...result.checks.map((check) => '  ' + (check.pass ? 'PASS' : 'FAIL') + '  ' + check.id + ' - ' + check.name),
      '[browser] ' + (result.ok ? 'OK' : 'FAIL') + ' -> ' + path.relative(ROOT, cfg.out).split(path.sep).join('/'),
    ]
    process.stdout.write(lines.join('\n') + '\n')
  }
  process.exitCode = result.ok ? EXIT.OK : EXIT.FAIL
}

function writeResult(cfg, result, t0, extra) {
  result.finishedAt = new Date().toISOString()
  result.durationMs = Date.now() - t0
  result.summary = { checks: result.checks.length, passed: result.checks.filter((check) => check.pass).length, failed: result.checks.filter((check) => !check.pass).length, ...(extra || {}) }
  result.artifacts = { json: path.relative(ROOT, cfg.out).split(path.sep).join('/'), screenshots: result.screenshots }
  fs.mkdirSync(path.dirname(cfg.out), { recursive: true })
  fs.writeFileSync(cfg.out, JSON.stringify(result, null, 2) + '\n', 'utf8')
}

main()
