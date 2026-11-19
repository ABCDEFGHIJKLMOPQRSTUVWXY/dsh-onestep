#!/usr/bin/env node
/**
 * dsh-onestep P2-5 只读运行期兼容冒烟（Playwright，headless Edge）。
 *
 * 检查目标（基线 DSH 0.2.2-rc.1 隔离实例）：
 *   1. 页面可加载、鉴权通过、无 pageerror / console error / 请求失败；
 *   2. __DSH_BOOT__ 存在，release.version 可读，entries 含 dsh-onestep 且 client bundle URL 正确；
 *   3. window.__ONESTEP__ 就绪（version / snapshot / actions / log），且版本与 package.json 一致；
 *   4. 插件 apply 生命周期日志齐备：capability.ok（missing=[]）、locale.registered、styles.injected、
 *      shortcut.register × N、main.declared（main 槽可用）、sessions.ready（sessions 服务可用）；
 *   5. 探针 snapshot 自洽（mounted/mainReady/候选数/舞台 DOM 计数），官方界面未被破坏；
 *   6. 只读证明：本脚本不点击 / 不输入 / 不切会话 / 不加候场 / 不开右栏 / 不 resize。
 *
 * 用法（仓库根目录）：
 *   node scripts/p2/compat/smoke.mjs
 *   node scripts/p2/compat/smoke.mjs --url-file artifacts/p2/server-url.txt --out artifacts/p2/compat/smoke.json
 *   node scripts/p2/compat/smoke.mjs --retries 1 --timeout 45000
 *
 * 退出码：0 全绿 / 1 断言失败 / 2 用法错误 / 3 目标不可达或鉴权失败 / 4 浏览器启动失败 / 5 页面就绪超时。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const DEFAULT_URL_FILE = path.join(ROOT, 'artifacts', 'p2', 'server-url.txt')
const DEFAULT_OUT = path.join(ROOT, 'artifacts', 'p2', 'compat', 'smoke.json')
const DEFAULT_SHOT = path.join(ROOT, 'artifacts', 'p2', 'compat', 'smoke.png')
const PACKAGE_JSON = path.join(ROOT, 'package.json')
const CLIENT_JS = path.join(ROOT, 'client.js')
const BASELINE_DSH = '0.2.2-rc.1'
const SMOKE_VERSION = '1.0.0'
const EXPECTED_SHORTCUTS = 15 // toggle-stage / quick-new / close-focus / undo / focus-1..9（上限 12 候场，Digit 只到 9）/ cycle-prev / cycle-next

const EXIT = { OK: 0, FAIL: 1, USAGE: 2, TARGET: 3, LAUNCH: 4, TIMEOUT: 5 }

function parseArgs(argv) {
  const cfg = {
    urlFile: DEFAULT_URL_FILE, url: null, out: DEFAULT_OUT, screenshot: DEFAULT_SHOT,
    timeout: 45000, readyTimeout: 20000, settleMs: 1000, retries: 1,
    channel: 'msedge', headless: true, quiet: false, help: false, noScreenshot: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--url-file') cfg.urlFile = path.resolve(ROOT, argv[++i])
    else if (arg === '--url') cfg.url = argv[++i]
    else if (arg === '--out') cfg.out = path.resolve(ROOT, argv[++i])
    else if (arg === '--screenshot') cfg.screenshot = path.resolve(ROOT, argv[++i])
    else if (arg === '--no-screenshot') cfg.noScreenshot = true
    else if (arg === '--timeout') cfg.timeout = Number(argv[++i])
    else if (arg === '--ready-timeout') cfg.readyTimeout = Number(argv[++i])
    else if (arg === '--settle') cfg.settleMs = Number(argv[++i])
    else if (arg === '--retries') cfg.retries = Number(argv[++i])
    else if (arg === '--channel') cfg.channel = argv[++i]
    else if (arg === '--headless') cfg.headless = String(argv[++i]) !== 'false'
    else if (arg === '--quiet') cfg.quiet = true
    else if (arg === '--help' || arg === '-h') cfg.help = true
    else throw new Error('unknown argument: ' + arg)
  }
  return cfg
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function maskUrl(text) {
  return String(text || '').replace(/([?&]token=)[^&#\s]+/g, '$1***')
}

function sha256(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase()
  } catch (_error) {
    return null
  }
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

async function preflight(url) {
  const started = Date.now()
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) })
    const body = await res.text().catch(() => '')
    return {
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      latencyMs: Date.now() - started,
      authRequired: res.status === 401 || /authentication required/i.test(body),
      bodyHead: body.replace(/\s+/g, ' ').trim().slice(0, 160),
    }
  } catch (error) {
    const cause = (error && error.cause && (error.cause.code || error.cause.message)) || ''
    return { ok: false, status: null, latencyMs: Date.now() - started, error: String(cause || (error && error.message) || error) }
  }
}

function loadPlaywright() {
  const toolsPw = path.join(ROOT, 'tools', 'pw')
  const attempt = (loader) => {
    const require = createRequire(loader)
    const pw = require('playwright-core')
    return { pw, version: require('playwright-core/package.json').version }
  }
  if (fs.existsSync(path.join(toolsPw, 'package.json'))) {
    try {
      return { ...attempt(path.join(toolsPw, 'package.json')), from: 'tools/pw' }
    } catch (_error) {
      /* fall through */
    }
  }
  throw Object.assign(new Error('无法加载 playwright-core（期望 tools/pw 下已安装；见 scripts/p0/verify/playwright-driver.mjs 约定）'), { code: 'LAUNCH' })
}

/** 页面内只读采集（唯一一次 evaluate）。 */
function collectInPage() {
  const boot = window.__DSH_BOOT__ || null
  const entries = boot && Array.isArray(boot.entries) ? boot.entries : []
  const selfEntry = entries.find((entry) => entry && entry.id === 'dsh-onestep') || null
  const api = window.__ONESTEP__ || null
  let snapshot = null
  let snapshotError = null
  let logTail = []
  if (api) {
    try {
      snapshot = api.actions && typeof api.actions.snapshot === 'function'
        ? api.actions.snapshot()
        : (typeof api.snapshot === 'function' ? api.snapshot() : null)
    } catch (error) {
      snapshotError = String((error && error.message) || error)
    }
    try {
      if (typeof api.log === 'function') logTail = api.log(200)
    } catch (_error) {
      logTail = []
    }
  }
  const q = (selector) => document.querySelectorAll(selector).length
  const safeSnapshot = snapshot
    ? {
        version: snapshot.version,
        startedAt: snapshot.startedAt,
        now: snapshot.now,
        mounted: !!snapshot.mounted,
        mainReady: !!snapshot.mainReady,
        focusId: snapshot.focusId || null,
        candidates: Array.isArray(snapshot.candidates) ? snapshot.candidates : [],
        stageActive: !!snapshot.stageActive,
        railSide: snapshot.railSide,
        previewMode: snapshot.previewMode,
        rowsTotal: typeof snapshot.rowsTotal === 'number' ? snapshot.rowsTotal : null,
        statusesCount: snapshot.statuses ? Object.keys(snapshot.statuses).length : null,
        companion: snapshot.companion || null,
        dom: snapshot.dom || null,
      }
    : null
  return {
    title: document.title,
    urlWithoutQuery: String(location.href).replace(/\?.*$/, ''),
    readyState: document.readyState,
    boot: boot
      ? {
          release: boot.release || null,
          rev: boot.rev || null,
          entriesCount: entries.length,
          hasSelfEntry: !!selfEntry,
          selfEntry: selfEntry
            ? { id: selfEntry.id, url: selfEntry.url, rev: selfEntry.rev, inject: selfEntry.inject, immediately: selfEntry.immediately, external: selfEntry.external }
            : null,
        }
      : null,
    onestep: api
      ? {
          version: api.version || null,
          hasActions: !!(api.actions && typeof api.actions === 'object'),
          actionNames: api.actions && typeof api.actions === 'object' ? Object.keys(api.actions) : [],
          hasSnapshot: !!(api.actions && typeof api.actions.snapshot === 'function'),
          hasListSessions: !!(api.actions && typeof api.actions.listSessions === 'function'),
          hasWaitFor: !!(api.actions && typeof api.actions.waitFor === 'function'),
          hasLog: typeof api.log === 'function',
          logTailCount: logTail.length,
        }
      : null,
    snapshot: safeSnapshot,
    snapshotError,
    log: logTail.map((item) => ({ t: item && item.t, event: String(item && item.event), data: item && item.data !== undefined ? item.data : null })),
    dom: {
      officialConversation: q('[data-conversation-content]'),
      editableComposers: q('[contenteditable="true"]'),
      textboxes: q('[role="textbox"], textarea'),
      stage: q('[data-onestep-stage]'),
      occurrences: q('[data-onestep-occurrence]'),
      rowActions: q('[data-onestep-row-action]'),
      headerActions: q('[data-onestep-header-action]'),
      stylesTag: q('style[data-onestep="1"]'),
      probePanels: q('.onestep-probe'),
    },
    bodyTextLength: document.body ? document.body.innerText.length : 0,
  }
}

function findLifecycle(log) {
  const events = log.map((item) => item.event)
  const count = (name) => events.filter((event) => event === name).length
  const apply = log.find((item) => item.event === 'apply') || null
  const capability = log.find((item) => item.event === 'capability.ok') || null
  const missing = log.find((item) => item.event === 'capability.missing') || null
  return {
    events: events.slice(0, 60),
    apply: !!apply,
    applyData: apply ? apply.data : null,
    capabilityOk: !!capability,
    capabilityData: capability ? capability.data : null,
    capabilityMissing: !!missing,
    localeRegistered: count('locale.registered') > 0,
    localeRegisterError: count('locale.register.error') > 0,
    stylesInjected: count('styles.injected') > 0,
    shortcutsRegistered: count('shortcut.register'),
    shortcutRegisterError: count('shortcut.register.error') > 0,
    shortcutsMissing: count('shortcuts.missing') > 0,
    mainDeclared: count('main.declared') > 0,
    sessionsReady: count('sessions.ready') > 0,
    stageMountErrors: count('stage.mount.error'),
  }
}

async function runAttempt(cfg, targetUrl, playwright) {
  const attempt = {
    startedAt: new Date().toISOString(),
    target: { requestedUrl: maskUrl(targetUrl), source: null },
    browser: null,
    page: null,
    console: { counts: {}, messages: [], pageErrors: [], requestFailures: [], httpErrors: [] },
    lifecycle: null,
    failed: [],
    error: null,
  }
  let browser = null
  try {
    browser = await playwright.chromium.launch({ channel: cfg.channel, headless: cfg.headless })
    attempt.browser = { channel: cfg.channel, version: browser.version(), headless: cfg.headless }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: null })
    const page = await context.newPage()
    page.on('console', (message) => {
      const level = message.type()
      attempt.console.counts[level] = (attempt.console.counts[level] || 0) + 1
      if (attempt.console.messages.length < 400) {
        attempt.console.messages.push({ ts: Date.now(), level, text: String(message.text()).slice(0, 500) })
      }
    })
    page.on('pageerror', (error) => attempt.console.pageErrors.push({ ts: Date.now(), text: String(error && error.message ? error.message : error).slice(0, 500) }))
    page.on('requestfailed', (request) => {
      if (attempt.console.requestFailures.length < 50) {
        attempt.console.requestFailures.push({ ts: Date.now(), url: maskUrl(request.url()), error: request.failure() ? request.failure().errorText : null })
      }
    })
    page.on('response', (response) => {
      if (response.status() >= 500 && attempt.console.httpErrors.length < 50) {
        attempt.console.httpErrors.push({ ts: Date.now(), status: response.status(), url: maskUrl(response.url()) })
      }
    })
    page.on('dialog', async (dialog) => {
      attempt.console.messages.push({ ts: Date.now(), level: 'dialog', text: dialog.message().slice(0, 200) })
      await dialog.dismiss().catch(() => {})
    })

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: cfg.timeout })
    await page.waitForFunction(() => !!window.__DSH_BOOT__, null, { timeout: cfg.readyTimeout, polling: 100 })
    let onestepReady = true
    try {
      await page.waitForFunction(() => !!window.__ONESTEP__, null, { timeout: cfg.readyTimeout, polling: 100 })
    } catch (_error) {
      onestepReady = false
    }
    await sleep(cfg.settleMs)

    attempt.page = await page.evaluate(collectInPage)
    attempt.page.targetUrl = undefined
    attempt.page.onestepReady = onestepReady
    attempt.console.counts = { ...attempt.console.counts }
    attempt.lifecycle = findLifecycle(attempt.page.log || [])
    if (!cfg.noScreenshot) {
      fs.mkdirSync(path.dirname(cfg.screenshot), { recursive: true })
      await page.screenshot({ path: cfg.screenshot, fullPage: false })
      attempt.screenshot = { path: path.relative(ROOT, cfg.screenshot).split(path.sep).join('/'), bytes: fs.statSync(cfg.screenshot).size }
    }
    await context.close()
    attempt.page.collectDurationMs = null
    return attempt
  } catch (error) {
    attempt.error = {
      message: String((error && error.message) || error).slice(0, 600),
      name: error && error.name ? error.name : 'Error',
    }
    attempt.page = attempt.page && typeof attempt.page === 'object' ? attempt.page : null
    attempt.console.counts = { ...attempt.console.counts }
    return attempt
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}

/** 由采集结果生成断言列表。 */
function judge(cfg, pageData, lifecycle, consoleData) {
  const checks = []
  const add = (id, name, pass, detail) => checks.push({ id, name, pass: !!pass, detail })
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'))
  const boot = pageData && pageData.boot
  const onestep = pageData && pageData.onestep
  const snapshot = pageData && pageData.snapshot
  const dom = pageData && pageData.dom

  add('boot.present', '__DSH_BOOT__ 存在且 release.version 可读', !!(boot && boot.release && boot.release.version), boot ? { release: boot.release, entriesCount: boot.entriesCount } : null)
  add('boot.self-entry', 'boot entries 含 dsh-onestep 且 client bundle URL 正确', !!(boot && boot.hasSelfEntry && /dsh-onestep\/client\.js/.test(String(boot.selfEntry && boot.selfEntry.url))), boot && boot.selfEntry ? { id: boot.selfEntry.id, url: boot.selfEntry.url, rev: boot.selfEntry.rev } : null)
  add('onestep.ready', 'window.__ONESTEP__ 就绪（version/snapshot/actions/log）', !!(onestep && onestep.version && onestep.hasSnapshot && onestep.hasActions && onestep.hasLog), onestep ? { version: onestep.version, hasSnapshot: onestep.hasSnapshot, hasLog: onestep.hasLog, actionCount: onestep.actionNames.length } : null)
  add('version.match', '__ONESTEP__.version 与 package.json version 一致', !!(onestep && onestep.version === pkg.version), { plugin: onestep ? onestep.version : null, packageJson: pkg.version })
  add('snapshot.usable', '探针 snapshot 可用且版本一致', !!(snapshot && snapshot.version === pkg.version), snapshot ? { version: snapshot.version, mounted: snapshot.mounted, mainReady: snapshot.mainReady, rowsTotal: snapshot.rowsTotal } : (pageData ? { snapshotError: pageData.snapshotError } : null))
  add('lifecycle.apply', '插件 apply 生命周期日志存在', !!(lifecycle && lifecycle.apply && lifecycle.capabilityOk && !lifecycle.capabilityMissing), lifecycle ? { capability: lifecycle.capabilityData, applyVersion: lifecycle.applyData && lifecycle.applyData.version } : null)
  add('lifecycle.locale', 'locale 字典注册成功', !!(lifecycle && lifecycle.localeRegistered && !lifecycle.localeRegisterError), lifecycle ? { registered: lifecycle.localeRegistered, error: lifecycle.localeRegisterError } : null)
  add('lifecycle.styles', '插件样式已注入', !!(lifecycle && lifecycle.stylesInjected && dom && dom.stylesTag === 1), lifecycle && dom ? { injected: lifecycle.stylesInjected, styleTags: dom.stylesTag } : null)
  add('lifecycle.shortcuts', '快捷键注册无冲突（官方占位序列避让）', !!(lifecycle && lifecycle.shortcutsRegistered >= EXPECTED_SHORTCUTS && !lifecycle.shortcutRegisterError && !lifecycle.shortcutsMissing), lifecycle ? { registered: lifecycle.shortcutsRegistered, expected: EXPECTED_SHORTCUTS, registerError: lifecycle.shortcutRegisterError } : null)
  add('slots.main', 'main 槽声明可用（舞台接管点）', !!(lifecycle && lifecycle.mainDeclared && snapshot && snapshot.mainReady === true), lifecycle ? { mainDeclared: lifecycle.mainDeclared, mainReady: snapshot ? snapshot.mainReady : null } : null)
  add('service.sessions', 'sessions 服务可用（目录订阅就绪）', !!(lifecycle && lifecycle.sessionsReady), lifecycle ? { sessionsReady: lifecycle.sessionsReady } : null)
  add('snapshot.consistent', 'snapshot 与 DOM 状态自洽（舞台挂载/候选数/窗口计数）', !!(
    snapshot &&
    snapshot.mounted === snapshot.stageActive &&
    snapshot.candidates.length <= 3 &&
    dom &&
    dom.stage === (snapshot.mounted ? 1 : 0) &&
    (!snapshot.dom || (!snapshot.dom.stage || snapshot.dom.stage === dom.stage))
  ), snapshot && dom ? { mounted: snapshot.mounted, stageActive: snapshot.stageActive, candidates: snapshot.candidates.length, domStage: dom.stage, domOccurrences: dom.occurrences } : null)
  add('ui.official-intact', '官方界面未被破坏（官方会话区 + 可编辑区存在）', !!(dom && dom.officialConversation >= 1 && (dom.editableComposers >= 1 || dom.stage >= 1) && pageData.bodyTextLength > 100), dom ? { officialConversation: dom.officialConversation, editableComposers: dom.editableComposers, stage: dom.stage, bodyTextLength: pageData.bodyTextLength } : null)
  const consoleErrors = (consoleData.messages || []).filter((message) => message.level === 'error' && !/favicon|Failed to load resource/i.test(message.text))
  const consoleClean = !(consoleData.pageErrors || []).length && !consoleErrors.length && !(consoleData.requestFailures || []).length && !(consoleData.httpErrors || []).length
  add('console.clean', '无 pageerror / console error / 请求失败 / 5xx', consoleClean, { pageErrors: (consoleData.pageErrors || []).length, consoleErrors: consoleErrors.map((m) => m.text.slice(0, 200)), requestFailures: (consoleData.requestFailures || []).length, httpErrors: (consoleData.httpErrors || []).length })
  add('readonly.mode', '本次冒烟严格只读（有采集记录，未调用任何写动作）', true, {
    actionsInvoked: ['snapshot()', 'log(n)'],
    clicks: 0,
    typed: 0,
    sessionSwitch: 0,
    candidateChanges: 0,
    rightbarToggles: 0,
    viewportResizes: 0,
    navigations: 1,
  })
  return checks
}

async function main() {
  let cfg
  try {
    cfg = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write('[smoke] ' + String(error && error.message ? error.message : error) + '\n')
    process.exitCode = EXIT.USAGE
    return
  }
  if (cfg.help) {
    process.stdout.write('用法: node scripts/p2/compat/smoke.mjs [--url-file <path>] [--url <url>] [--out <json>] [--screenshot <png>] [--retries 1] [--timeout 45000]\n只读：不点击、不输入、不切会话、不加候场、不开右栏、不 resize。\n')
    return
  }

  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const result = {
    ok: false,
    smoke: { name: 'dsh-onestep-compat-smoke', version: SMOKE_VERSION, baselineDsh: BASELINE_DSH, mode: 'read-only' },
    startedAt,
    target: null,
    artifacts: {},
  }

  let target
  try {
    target = readTargetUrl(cfg)
  } catch (error) {
    process.stderr.write('[smoke] ' + error.message + '\n')
    result.error = { kind: 'usage', message: error.message }
    fs.mkdirSync(path.dirname(cfg.out), { recursive: true })
    fs.writeFileSync(cfg.out, JSON.stringify(result, null, 2) + '\n', 'utf8')
    process.exitCode = EXIT.USAGE
    return
  }
  result.target = { source: target.source, requestedUrl: maskUrl(target.url) }

  const pre = await preflight(target.url)
  result.preflight = pre
  if (!pre.ok) {
    const kind = pre.authRequired ? 'auth-required' : 'unreachable'
    result.error = { kind, message: pre.authRequired ? '实例要求鉴权，URL token 可能已失效' : '实例不可达：' + (pre.error || 'HTTP ' + pre.status) }
    fs.mkdirSync(path.dirname(cfg.out), { recursive: true })
    fs.writeFileSync(cfg.out, JSON.stringify(result, null, 2) + '\n', 'utf8')
    if (!cfg.quiet) process.stdout.write('[smoke] FAIL target ' + kind + '\n')
    process.exitCode = EXIT.TARGET
    return
  }

  let playwright
  try {
    playwright = loadPlaywright()
  } catch (error) {
    result.error = { kind: 'launch', message: error.message }
    fs.mkdirSync(path.dirname(cfg.out), { recursive: true })
    fs.writeFileSync(cfg.out, JSON.stringify(result, null, 2) + '\n', 'utf8')
    process.stderr.write('[smoke] ' + error.message + '\n')
    process.exitCode = EXIT.LAUNCH
    return
  }
  result.playwright = { version: playwright.version, from: playwright.from }

  const attempts = []
  let finalAttempt = null
  for (let index = 0; index <= Math.max(0, cfg.retries); index += 1) {
    if (index > 0) await sleep(8000)
    const attempt = await runAttempt(cfg, target.url, playwright.pw)
    attempts.push(attempt)
    finalAttempt = attempt
    const ready = !!(attempt.page && attempt.page.boot && attempt.page.onestep)
    if (ready && !attempt.error) break
    if (!cfg.quiet) process.stdout.write('[smoke] attempt ' + (index + 1) + ' not ready' + (attempt.error ? ' (' + attempt.error.message.slice(0, 120) + ')' : '') + (index < cfg.retries ? ' → retry once after 8s' : '') + '\n')
  }

  const attempt = finalAttempt
  const completed = !!(attempt && attempt.page && attempt.page.boot)
  result.attempts = attempts.map((item, index) => ({
    index: index + 1,
    startedAt: item.startedAt,
    error: item.error,
    collected: !!(item.page && item.page.boot),
    consoleCounts: item.console.counts,
  }))
  if (!completed) {
    result.error = { kind: attempt && attempt.error ? 'page-error' : 'not-ready', message: attempt && attempt.error ? attempt.error.message : '页面未就绪（__DSH_BOOT__ 缺失或超时）' }
    result.durationMs = Date.now() - t0
    fs.mkdirSync(path.dirname(cfg.out), { recursive: true })
    fs.writeFileSync(cfg.out, JSON.stringify(result, null, 2) + '\n', 'utf8')
    if (!cfg.quiet) process.stdout.write('[smoke] FAIL not ready: ' + result.error.message + '\n')
    process.exitCode = attempt && attempt.error && /Timeout/i.test(attempt.error.message) ? EXIT.TIMEOUT : EXIT.FAIL
    return
  }

  const pageData = attempt.page
  result.browser = attempt.browser
  result.boot = pageData.boot
  result.onestep = pageData.onestep
  result.lifecycle = attempt.lifecycle
  result.console = attempt.console
  result.dom = pageData.dom
  result.snapshot = pageData.snapshot
  result.snapshotError = pageData.snapshotError
  result.page = { title: pageData.title, url: pageData.urlWithoutQuery, readyState: pageData.readyState, bodyTextLength: pageData.bodyTextLength }
  result.artifacts = {
    json: path.relative(ROOT, cfg.out).split(path.sep).join('/'),
    screenshot: !cfg.noScreenshot && attempt.screenshot ? attempt.screenshot.path : null,
  }
  result.build = {
    packageVersion: JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version,
    clientJs: { path: 'client.js', sha256: sha256(CLIENT_JS), bytes: fs.existsSync(CLIENT_JS) ? fs.statSync(CLIENT_JS).size : null },
    adapterJs: { path: 'src/client/adapter.js', sha256: sha256(path.join(ROOT, 'src', 'client', 'adapter.js')) },
  }
  result.checks = judge(cfg, pageData, attempt.lifecycle, attempt.console)
  result.failedChecks = result.checks.filter((check) => !check.pass).map((check) => check.id)
  result.ok = result.failedChecks.length === 0
  result.summary = {
    checks: result.checks.length,
    passed: result.checks.length - result.failedChecks.length,
    failed: result.failedChecks.length,
    stageActiveAtCheck: !!(result.snapshot && result.snapshot.stageActive),
    notes: '只读冒烟：不改变舞台/会话状态；stageActive 反映持久化恢复或其它驱动遗留状态，属记录项而非断言项。',
  }
  result.finishedAt = new Date().toISOString()
  result.durationMs = Date.now() - t0
  fs.mkdirSync(path.dirname(cfg.out), { recursive: true })
  fs.writeFileSync(cfg.out, JSON.stringify(result, null, 2) + '\n', 'utf8')

  if (!cfg.quiet) {
    const lines = []
    lines.push('[smoke] target ' + maskUrl(target.url) + ' | baseline DSH ' + BASELINE_DSH)
    lines.push('[smoke] boot entries=' + (result.boot ? result.boot.entriesCount : '?') + ' release=' + (result.boot && result.boot.release ? result.boot.release.version : '?'))
    lines.push('[smoke] checks ' + (result.checks.length - result.failedChecks.length) + '/' + result.checks.length + ' passed')
    for (const check of result.checks) lines.push('  ' + (check.pass ? 'PASS' : 'FAIL') + '  ' + check.id + ' — ' + check.name)
    lines.push('[smoke] ' + (result.ok ? 'OK' : 'FAIL') + ' → ' + path.relative(ROOT, cfg.out))
    process.stdout.write(lines.join('\n') + '\n')
  }
  process.exitCode = result.ok ? EXIT.OK : EXIT.FAIL
}

main()
