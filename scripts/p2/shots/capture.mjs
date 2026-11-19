#!/usr/bin/env node
/**
 * P2-6 发布截图采集（可重复）。
 *
 * 用途：在隔离实例（artifacts/p2/server-url.txt，每次重读）上，用当前构建的 client.js
 * 拍发布用关键截图，输出到 docs/assets/p2/（1440×900；09 为 1280×800），
 * 并把构建 sha、每张图的尺寸/字节数/sha256 与探针证据写到 artifacts/p2/shots/capture.json。
 *
 * 关键约定：
 * - 截图必须来自当前构建：脚本先校验「实例实际提供的 client bundle sha256 == 仓库 client.js sha256」，
 *   不一致会重载重试，仍不一致则失败（不会拿旧构建冒充）。
 * - 只用探针 actions 建立/调整舞台（enterStage/exitStage/setPreviewMode/setRailCollapsed 等），
 *   真实鼠标 hover 用 page.mouse；不改产品源码。
 * - 结束前恢复普通模式：exitStage + 重置 localStorage 舞台状态 + reload 验证（mounted=false / 无舞台 DOM）。
 * - Playwright 使用独立临时 context，实例本身没有持久写入（localStorage 只存在于本次 context）。
 *
 * 用法：
 *   node scripts/p2/shots/capture.mjs             # 全量采集（约 1-2 分钟）
 *   node scripts/p2/shots/capture.mjs --inspect   # 只读探查环境/会话，不截图（排查用）
 *
 * 依赖：tools/pw（playwright-core + msedge channel，headless），与 scripts/p2/verify/lib.mjs 共用。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  ROOT,
  readServerUrl,
  sha256File,
  fileSize,
  baselineInfo,
  sleep,
  log,
  openApp,
  closeApp,
  reloadApp,
  waitFor,
  snapshot,
  listSessions,
  enterStage,
  leaveStage,
  setTheme,
  themeInfo,
  resetStageStorage,
  readStageStorage,
  stageGeometry,
} from '../verify/lib.mjs'

const OUT_DIR = path.join(ROOT, 'docs', 'assets', 'p2')
const META_DIR = path.join(ROOT, 'artifacts', 'p2', 'shots')
const META_FILE = path.join(META_DIR, 'capture.json')
const INSPECT = process.argv.includes('--inspect')
const VIEW = { width: 1440, height: 900 }
const VIEW_TOP_RAIL = { width: 1280, height: 800 }

/** PNG 尺寸（IHDR：宽高各 4 字节 BE）。 */
function pngSize(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(24)
    fs.readSync(fd, head, 0, 24, 0)
    if (head.toString('ascii', 1, 4) !== 'PNG') return null
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
  } finally {
    fs.closeSync(fd)
  }
}

const meta = {
  task: 'P2-6 发布截图采集',
  script: 'scripts/p2/shots/capture.mjs',
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  mode: INSPECT ? 'inspect' : 'capture',
  server: null,
  build: null,
  environment: null,
  sessions: null,
  stage: null,
  screenshots: [],
  checks: [],
  pageErrors: [],
  consoleErrors: [],
  cleanup: null,
  error: null,
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function writeMeta() {
  meta.finishedAt = new Date().toISOString()
  ensureDir(META_DIR)
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2) + '\n', 'utf8')
  log('[capture] meta -> ' + path.relative(ROOT, META_FILE).replace(/\\/g, '/'))
}

function check(name, pass, detail) {
  meta.checks.push({ name, pass: !!pass, detail: detail === undefined ? null : detail })
  log('[' + (pass ? 'PASS' : 'FAIL') + '] ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail).slice(0, 500)))
  return !!pass
}

/** 探针快照中与截图证据相关的字段（避免把整份 logs 写进元数据）。 */
function probeBrief(snap) {
  if (!snap) return null
  return {
    version: snap.version,
    mounted: snap.mounted,
    focusId: snap.focusId,
    candidates: snap.candidates,
    railSide: snap.railSide,
    railSize: snap.railSize,
    railCollapsed: snap.railCollapsed,
    previewMode: snap.previewMode,
    previewModeEffective: snap.previewModeEffective,
    autoLite: snap.autoLite
      ? {
          active: snap.autoLite.active,
          reason: snap.autoLite.reason,
          target: snap.autoLite.target,
          applied: snap.autoLite.applied,
          fallback: snap.autoLite.fallback,
          manualOverride: snap.autoLite.manualOverride,
        }
      : null,
    dom: snap.dom,
  }
}

async function readProbe(page) {
  return page.evaluate(() => {
    try {
      return window.__ONESTEP__.actions.snapshot()
    } catch (error) {
      return null
    }
  })
}

/**
 * 实例实际提供的 client bundle（从 boot graph entries[].url 拉取；/plugins/<pkg>/client.js 是 404）。
 *
 * 注意：combo 路由会在文件末尾追加一行 dev sourcemap 引用（`;\n//# sourceMappingURL=??dsh-onestep/client.js.map&rev=…`），
 * 因此「当前构建」的判据是：本地 client.js 全文是实际响应内容的**前缀**，且剩余后缀只有 sourceMappingURL。
 * 若服务端返回的是旧构建，正文必然在某处先不同——前缀比较会失败。
 */
async function readServedBundle(page, localText) {
  return page.evaluate(async (expectedPrefix) => {
    const boot = window.__DSH_BOOT__
    const entry = boot && Array.isArray(boot.entries) ? boot.entries.find((item) => item.id === 'dsh-onestep') : null
    if (!entry || !entry.url) return { ok: false, reason: 'boot entry missing', release: boot ? boot.release : null }
    try {
      const response = await fetch(entry.url)
      const buffer = await response.arrayBuffer()
      const text = new TextDecoder('utf-8').decode(buffer)
      const digest = await crypto.subtle.digest('SHA-256', buffer)
      const sha = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()
      const prefixMatch = text.length >= expectedPrefix.length && text.slice(0, expectedPrefix.length) === expectedPrefix
      const suffix = prefixMatch ? text.slice(expectedPrefix.length) : null
      const suffixOnlySourceMap = suffix !== null && /^;?\s*\n?\/\/#\s*sourceMappingURL=\S+\s*$/.test(suffix)
      return {
        ok: response.ok,
        status: response.status,
        url: entry.url,
        bytes: buffer.byteLength,
        sha,
        prefixMatch,
        suffix: suffix === null ? null : suffix.slice(0, 160),
        suffixOnlySourceMap,
        release: boot.release,
      }
    } catch (error) {
      return { ok: false, reason: String(error), url: entry.url }
    }
  }, localText)
}

async function ensureServedBuild(page, localText) {
  let served = await readServedBundle(page, localText)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const match = !!(served && served.ok && served.prefixMatch && served.suffixOnlySourceMap)
    if (match) break
    log('[capture] served bundle 与本地构建不一致（attempt=' + attempt + '），重载页面… ' + JSON.stringify(served && { sha: served.sha, prefixMatch: served.prefixMatch, suffix: served.suffix }))
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForFunction(() => !!window.__ONESTEP__, null, { timeout: 60000 })
    await sleep(2000)
    served = await readServedBundle(page, localText)
  }
  return served
}

async function shot(page, name, options = {}) {
  ensureDir(OUT_DIR)
  const file = path.join(OUT_DIR, name)
  const expectedView = options.viewport || VIEW
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: file })
  const size = pngSize(file)
  const snap = await readProbe(page)
  const theme = await themeInfo(page)
  const record = {
    name,
    file: path.relative(ROOT, file).replace(/\\/g, '/'),
    scene: options.scene || null,
    theme: theme.theme,
    viewport: expectedView,
    size,
    bytes: fileSize(file),
    sha256: sha256File(file),
    probe: probeBrief(snap),
  }
  meta.screenshots.push(record)
  const dimensionOk = !!size && size.width === expectedView.width && size.height === expectedView.height
  check('shot.' + name + '.size', dimensionOk, { expected: expectedView, actual: size })
  log('[shot] ' + record.file + ' ' + JSON.stringify({ size, bytes: record.bytes, theme: theme.theme, preview: snap && snap.previewMode, rail: snap && snap.railSide, collapsed: snap && snap.railCollapsed }))
  return record
}

/** 等舞台几何稳定（连续两次布局一致）。 */
async function waitStableLayout(page, label) {
  let previous = null
  await waitFor(
    async () => {
      const geometry = await stageGeometry(page)
      const text = JSON.stringify(geometry)
      if (previous !== null && previous === text) return true
      previous = text
      await sleep(250)
      return false
    },
    { timeout: 12000, interval: 120, label: label || 'layout.stable' },
  )
  return stageGeometry(page)
}

/**
 * 发布截图脱敏：隐藏官方侧栏底部的当前登录账户行（显示名是本机的脱敏手机号）。
 *
 * 只隐藏「账户标识」这一项官方 UI，不改任何产品功能/舞台状态；每次页面 reload 后都要重新执行
 * （Playwright 临时 context 的注入不跨 reload）。是否隐藏与隐藏对象记录在 capture.json.sanitization。
 */
async function hidePersonalUi(page) {
  return page.evaluate(() => {
    const hidden = []
    const maskedAccount = /^1\d{2}\*{4,}\d{2}$/
    const visible = (el) => {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    // 1) 官方侧栏 footer（含账户触发行）：优先语义类名，其次按脱敏手机号文本定位。
    let target = document.querySelector('[class*="footArea"]')
    if (!target) {
      const hit = Array.from(document.querySelectorAll('div, span')).find((el) => maskedAccount.test((el.textContent || '').trim()) && visible(el))
      if (hit) {
        let node = hit
        while (node && node !== document.body && (node.getBoundingClientRect().height < 40 || node.getBoundingClientRect().width < 180)) {
          node = node.parentElement
        }
        target = node
      }
    }
    if (target) {
      const rect = target.getBoundingClientRect()
      target.style.visibility = 'hidden'
      hidden.push({ target: 'official-account-footer', className: String(target.className).slice(0, 80), rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } })
    }
    const stillVisible = Array.from(document.querySelectorAll('body *')).some((el) => maskedAccount.test((el.textContent || '').trim()) && visible(el))
    return { hidden, accountTextGone: !stillVisible }
  })
}

function recordSanitization(result, label) {
  if (!result) return
  meta.sanitization = meta.sanitization || { purpose: '发布截图不公开当前登录账户显示名（本机为脱敏手机号）；只隐藏官方侧栏账户行，不改舞台/产品状态', events: [] }
  meta.sanitization.events.push({ at: label, ...result })
  check('sanitize.' + label, result.accountTextGone, result)
}

/* ------------------------------------------------------------------ */

ensureDir(OUT_DIR)
ensureDir(META_DIR)

const localClient = path.join(ROOT, 'client.js')
const localSha = sha256File(localClient)
const localText = fs.readFileSync(localClient, 'utf8')
meta.build = {
  clientSha256Local: localSha,
  clientBytesLocal: fileSize(localClient),
  served: null,
  match: false,
  matchRule: '本地 client.js 全文 == 服务端 bundle 前缀，且后缀仅 dev sourceMappingURL（combo 路由追加）',
}
meta.server = { urlFile: 'artifacts/p2/server-url.txt', origin: (() => {
  try {
    return new URL(readServerUrl()).origin
  } catch (error) {
    return null
  }
})() }
meta.environment = baselineInfo()

let app = null
let pendingError = null
try {
  app = await openApp({ viewport: VIEW, colorScheme: 'light', settleMs: 1500 })
  const { page, handles } = app

  // 0) 构建一致性：实例实际提供的 bundle 必须来自仓库当前 client.js（截图必须来自当前构建）。
  const served = await ensureServedBuild(page, localText)
  meta.build.served = served
  meta.build.match = !!(served && served.ok && served.prefixMatch && served.suffixOnlySourceMap)
  check('build.served-matches-local', meta.build.match, {
    localSha,
    servedRawSha: served && served.sha,
    servedBytes: served && served.bytes,
    prefixMatch: served && served.prefixMatch,
    suffixOnlySourceMap: served && served.suffixOnlySourceMap,
    suffix: served && served.suffix,
    bootUrl: served && served.url,
  })

  // 1) 环境：语言 / 主题 / 版本 / 会话目录。
  const lang = await page.evaluate(() => document.documentElement.lang || null)
  const boot = await page.evaluate(() => {
    const graph = window.__DSH_BOOT__ || {}
    const entry = (graph.entries || []).find((item) => item.id === 'dsh-onestep')
    return { release: graph.release || null, entries: (graph.entries || []).length, selfEntry: entry || null }
  })
  const probeVersion = await page.evaluate(() => (window.__ONESTEP__ ? window.__ONESTEP__.version : null))
  const theme0 = await themeInfo(page)
  meta.environment.lang = lang
  meta.environment.theme = theme0.theme
  meta.environment.probeVersion = probeVersion
  meta.environment.boot = boot
  log('[capture] lang=' + lang + ' theme=' + theme0.theme + ' version=' + probeVersion + ' release=' + JSON.stringify(boot.release) + ' entries=' + boot.entries)

  const rows = await listSessions(page)
  const currentId = await page.evaluate(() => {
    try {
      return window.__ONESTEP__.actions.snapshot().focusId || window.__ONESTEP__.actions.currentSessionId()
    } catch (error) {
      return null
    }
  })
  const rowIds = Object.keys(rows)
  const brief = (id) => {
    const row = rows[id] || {}
    const titleKeys = ['title', 'name', 'label', 'summary']
    let title = null
    for (const key of titleKeys) {
      if (row[key]) {
        title = String(row[key]).slice(0, 80)
        break
      }
    }
    return { id, blank: !!row.blank, title }
  }
  meta.sessions = {
    total: rowIds.length,
    current: currentId ? brief(currentId) : null,
    sample: rowIds.slice(0, 12).map(brief),
  }

  if (INSPECT) {
    log('[capture] inspect: ' + JSON.stringify(meta.sessions, null, 2).slice(0, 4000))
    meta.ok = true
    writeMeta()
    await closeApp(app)
    process.exit(0)
  }

  // 2) 常规清理：重置舞台持久化状态并 reload，保证 01 从「普通模式」开始。
  await resetStageStorage(page)
  await reloadApp(page, { settleMs: 1500 })
  const normalSnap = await snapshot(page)
  check('normal.mode', normalSnap.mounted === false && (normalSnap.candidates || []).length === 0 && (await page.evaluate(() => document.querySelectorAll('[data-onestep-stage]').length === 0)), {
    mounted: normalSnap.mounted,
    candidates: normalSnap.candidates,
  })

  // 候选偏好：优先本项目相关会话（避免把与本插件无关的个人工作区会话拍进公开截图）。
  function projectScore(title) {
    return /(P0|P1|Onestep|onestep|PowerShell|审查|确认|报告|开发|舞台|插件|性能|无障碍|i18n|发布|会话)/.test(String(title || '')) ? 0 : 1
  }

  // 3) 选焦点会话：优先「有真实正文」的普通会话。
  // 排除 subagent 会话（标题以「你是 dsh-onestep 项目的」开头，composer 为 disabled 状态）与当前开发会话（含内部上下文），
  // 发布截图只用普通用户工作会话；不足时回退全量。
  const SUBAGENT_TITLE = /^你是 dsh-onestep 项目的/
  const INTERNAL_TITLES = new Set(['开始开发P2'])
  const rankedAll = rowIds
    .map((id) => ({ id, title: (rows[id] || {}).title || null, blank: !!(rows[id] || {}).blank, updatedAt: (rows[id] || {}).updatedAt || 0 }))
    .filter((item) => !item.blank)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const regular = rankedAll.filter((item) => !SUBAGENT_TITLE.test(item.title || '') && !INTERNAL_TITLES.has(item.title || ''))
  const ranked = regular.length >= 4 ? regular : rankedAll
  const titleRanked = ranked.filter((item) => item.title && item.title !== 'dsh-onestep')
  const focusOrder = [...titleRanked, ...ranked.filter((item) => !titleRanked.includes(item))].slice(0, 8)
  const focusTries = []
  let focusTarget = null
  for (const item of focusOrder) {
    await page.evaluate((id) => window.__ONESTEP__.actions.focusSession(id), item.id)
    await sleep(2400)
    const probe = await page.evaluate(() => {
      const content = document.querySelector('[data-conversation-content]')
      const textbox = document.querySelector('[role="textbox"]')
      return {
        textLen: content ? (content.innerText || '').trim().length : 0,
        composerUsable: !!textbox && textbox.getAttribute('aria-disabled') !== 'true',
      }
    })
    focusTries.push({ id: item.id, title: item.title, textLen: probe.textLen, composerUsable: probe.composerUsable })
    if (probe.textLen >= 400 && probe.composerUsable) {
      focusTarget = item.id
      break
    }
  }
  if (!focusTarget) focusTarget = focusOrder[0].id
  // 候场：按 updatedAt 倒序遍历会话，读正文长度取 3 个「有实际内容」的会话（跳过空会话，避免候场卡空白）。
  const candidatePool = ranked.filter((item) => item.id !== focusTarget)
  const candidateProbed = []
  for (const item of candidatePool) {
    if (candidateProbed.filter((entry) => entry.textLen >= 300).length >= 3 || candidateProbed.length >= 7) break
    await page.evaluate((id) => window.__ONESTEP__.actions.focusSession(id), item.id)
    await sleep(2200)
    const textLen = await page.evaluate(() => {
      const content = document.querySelector('[data-conversation-content]')
      return content ? (content.innerText || '').trim().length : 0
    })
    candidateProbed.push({ id: item.id, title: item.title, textLen })
  }
  // 候选：优先项目相关会话（公开截图不出现无关个人工作区会话）；projectScore(1) 仅在凑不满 3 个时兜底。
  const richCandidates = candidateProbed
    .filter((entry) => entry.textLen >= 300)
    .sort((a, b) => projectScore(a.title) - projectScore(b.title) || b.textLen - a.textLen)
  const projectCandidates = candidateProbed
    .filter((entry) => projectScore(entry.title) === 0)
    .sort((a, b) => b.textLen - a.textLen)
  const candidateIds = []
  for (const entry of [...richCandidates.filter((item) => projectScore(item.title) === 0), ...projectCandidates]) {
    if (candidateIds.length >= 3) break
    if (!candidateIds.includes(entry.id)) candidateIds.push(entry.id)
  }
  for (const entry of richCandidates) {
    if (candidateIds.length >= 3) break
    if (!candidateIds.includes(entry.id)) candidateIds.push(entry.id)
  }
  if (candidateIds.length < 3) throw new Error('可用候场会话不足 3 个：' + JSON.stringify({ focusTarget, candidateIds, total: rowIds.length }))
  const originalFocusId = currentId
  // 候场探测期间焦点被切走，恢复回选定的焦点会话。
  await page.evaluate((id) => window.__ONESTEP__.actions.focusSession(id), focusTarget)
  await waitFor(() => page.evaluate((id) => window.__ONESTEP__.actions.currentSessionId() === id, focusTarget), { timeout: 10000, interval: 120, label: 'focus.restore-initial' })
  await waitFor(
    () =>
      page.evaluate(() => {
        const content = document.querySelector('[data-conversation-content]')
        if (!content) return false
        const rect = content.getBoundingClientRect()
        return rect.width > 2 && rect.height > 2
      }),
    { timeout: 15000, interval: 150, label: 'focus.content' },
  )
  await setTheme(page, 'light')
  await sleep(1800)
  recordSanitization(await hidePersonalUi(page), 'initial')
  meta.sessions.selected = {
    focus: brief(focusTarget),
    focusTries,
    candidateProbe: candidateProbed,
    candidates: candidateIds.map(brief),
    originalFocusId,
  }
  log('[capture] focus=' + focusTarget + ' candidates=' + JSON.stringify(candidateIds) + ' tries=' + JSON.stringify(focusTries) + ' candidateProbe=' + JSON.stringify(candidateProbed))
  await shot(page, '01-normal.png', { scene: '普通模式（无舞台）：官方单会话界面 + 左栏行「加入舞台」入口', viewport: VIEW })

  // 4) 建立 1 焦点 + 3 候场（真实非空会话，实时缩略可见内容）。
  let snapStage
  try {
    snapStage = await enterStage(page, candidateIds, { settleMs: 1200 })
  } catch (error) {
    // 部分会话被目录 reconcile 丢掉时，enterStage 会因数量不足抛错；能继续就用可用数量采集。
    snapStage = await snapshot(page)
    if (!snapStage.mounted || (snapStage.candidates || []).length < 2) throw error
    log('[capture] enterStage 仅就绪 ' + snapStage.candidates.length + ' 个候场，继续采集（原因见 meta）')
    meta.sessions.partialEnterStage = String(error).slice(0, 500)
  }
  // 跨工作区/目录 reconcile 可能丢掉个别候选（实测 kig 工作区会话被 reconcile 移除）：
  // 补齐到 3 个；仍不足则降级为可用数量（>=2）而不是直接失败。
  let activeCandidateIds = (snapStage.candidates || []).slice()
  if (activeCandidateIds.length < 3) {
    // 补齐池 = 全部普通会话（项目相关优先；排除焦点/已在候场；跨工作区会话会被 reconcile 自动丢弃）。
    const refillPool = ranked
      .filter((item) => item.id !== focusTarget)
      .sort((a, b) => projectScore(a.title) - projectScore(b.title) || b.updatedAt - a.updatedAt)
      .map((item) => item.id)
    for (const id of refillPool) {
      if (activeCandidateIds.length >= 3) break
      if (activeCandidateIds.includes(id)) continue
      await page.evaluate((sid) => window.__ONESTEP__.actions.addCandidate(sid), id)
      await sleep(1000)
      activeCandidateIds = (await snapshot(page)).candidates || activeCandidateIds
    }
  }
  if (activeCandidateIds.length < 2) throw new Error('enterStage 后候场不足 2 个：' + JSON.stringify(activeCandidateIds))
  candidateIds.length = 0
  candidateIds.push(...activeCandidateIds)
  meta.stage = {
    focusId: snapStage.focusId || null,
    candidateIds,
    candidateSessions: candidateIds.map(brief),
  }
  // 焦点窗需要主绑定上报；极端情况下补一次 focusSession。
  if (!snapStage.focusId) {
    await page.evaluate((id) => window.__ONESTEP__.actions.focusSession(id), focusTarget)
    await waitFor(() => page.evaluate(() => !!window.__ONESTEP__.actions.snapshot().focusId), { timeout: 8000, label: 'stage.focus' })
  }
  await waitFor(
    () =>
      page.evaluate((expected) => {
        const stage = document.querySelector('[data-onestep-stage]')
        if (!stage) return false
        return stage.querySelectorAll('.onestep-frame[data-mode="candidate"]').length === expected && stage.querySelectorAll('[data-onestep-occurrence]').length >= expected + 1
      }, candidateIds.length),
    { timeout: 12000, interval: 150, label: 'stage.live-occurrences' },
  )
  await sleep(1800)
  const geometryLight = await waitStableLayout(page)
  log('[capture] stage geometry ' + JSON.stringify(geometryLight))
  await setTheme(page, 'light')
  await sleep(400)
  await shot(page, '02-stage-light.png', { scene: '舞台 light：1 焦点 + 3 候场（实时缩略）', viewport: VIEW })

  // 4) 深色主题同一舞台。
  await setTheme(page, 'dark')
  await sleep(700)
  await shot(page, '03-stage-dark.png', { scene: '舞台 dark：1 焦点 + 3 候场（实时缩略）', viewport: VIEW })
  await setTheme(page, 'light')
  await sleep(400)

  // 5) 真实鼠标 hover 候场卡 → 右下控制点显示（12px 视觉/24px 命中）。
  const cards = await page.evaluate(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    if (!stage) return []
    return Array.from(stage.querySelectorAll('.onestep-frame[data-mode="candidate"]')).map((el) => {
      const rect = el.getBoundingClientRect()
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, sessionId: el.getAttribute('data-onestep-window-session') }
    })
  })
  const card = cards[0]
  if (!card) throw new Error('未找到候场卡，无法拍 hover 图')
  await page.mouse.move(card.x + card.w / 2, card.y + card.h / 2)
  await waitFor(
    () =>
      page.evaluate(() => {
        const control = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="candidate"] .onestep-control')
        if (!control) return false
        const style = getComputedStyle(control)
        return style.opacity === '1' && style.pointerEvents !== 'none'
      }),
    { timeout: 6000, interval: 100, label: 'hover.control-visible' },
  )
  await sleep(500)
  await shot(page, '04-candidate-hover-control.png', {
    scene: '候场卡真实鼠标 hover：右下关闭控制点显示（悬停卡 ' + String(card.sessionId || '').slice(0, 8) + '…）',
    viewport: VIEW,
  })
  // 鼠标移出候场卡（停在焦点窗 chrome 上，避免触发快速新建条热区）。
  await page.mouse.move(700, 18)
  await sleep(300)

  // 6) 快速新建条（键盘等价入口；输入草稿后展示）。
  await page.evaluate(() => window.__ONESTEP__.actions.requestQuickNew())
  await waitFor(
    () => page.evaluate(() => {
      const bar = document.querySelector('.onestep-quick')
      return !!bar && bar.getAttribute('data-open') === '1'
    }),
    { timeout: 6000, interval: 100, label: 'quick.open' },
  )
  await sleep(600)
  await page.keyboard.type('整理本周发布清单')
  await sleep(400)
  await shot(page, '05-quick-bar.png', { scene: '快速新建条：打开并输入草稿（Enter 创建，草稿不自动发送）', viewport: VIEW })
  // Esc 两段式：非空第一次清空，第二次收起。
  await page.keyboard.press('Escape')
  await sleep(350)
  await page.keyboard.press('Escape')
  await sleep(400)
  check(
    'quick.closed',
    await page.evaluate(() => {
      const bar = document.querySelector('.onestep-quick')
      return !bar || bar.getAttribute('data-open') !== '1'
    }),
    null,
  )

  // 7) header 入口选择浮层（普通模式路径）。
  // 先 reload：清掉页面内 quickSignal 等瞬态信号（否则后续重新挂载舞台会再次自动唤起快速条）；
  // reloadApp 的 normalize 会自动退出舞台，保证 06 是普通模式。
  await reloadApp(page, { settleMs: 1500 })
  recordSanitization(await hidePersonalUi(page), 'after-quick-reload')
  await setTheme(page, 'light')
  await sleep(600)
  const headerClicked = await page
    .locator('[data-onestep-header-action]')
    .first()
    .click({ timeout: 5000 })
    .then(() => true)
    .catch((error) => {
      log('[capture] header 按钮点击失败：' + String(error).slice(0, 200))
      return false
    })
  if (!headerClicked) {
    // 回退：Ctrl+Alt+S（无候场时打开 picker），与 header 入口同一浮层。
    await page.keyboard.press('Control+Alt+KeyS')
    log('[capture] 回退键盘入口 Ctrl+Alt+S 打开 picker')
  }
  await waitFor(() => page.evaluate(() => !!document.querySelector('[data-onestep-picker="1"]')), { timeout: 8000, interval: 120, label: 'picker.open' })
  await sleep(500)
  // 勾选前两项，展示「进入舞台（N）」按钮的多选态。
  const checks = page.locator('.onestep-picker-item input[type="checkbox"]')
  const checkCount = Math.min(await checks.count(), 2)
  for (let index = 0; index < checkCount; index += 1) {
    await checks.nth(index).check({ timeout: 3000 }).catch(() => {})
  }
  await sleep(500)
  await shot(page, '06-picker.png', {
    scene: 'header「舞台」入口选择浮层：勾选 2 个候选会话（进入舞台 N）',
    viewport: VIEW,
  })
  await page.keyboard.press('Escape')
  await sleep(500)
  check('picker.closed', await page.evaluate(() => !document.querySelector('[data-onestep-picker="1"]')), null)

  // 8) 重新进舞台：候场栏收起（reload 后主绑定应仍是焦点会话；偏差时补一次）。
  const focusAfterPicker = await page.evaluate(() => window.__ONESTEP__.actions.currentSessionId())
  if (focusAfterPicker !== focusTarget) {
    log('[capture] reload 后焦点为 ' + focusAfterPicker + '，补切回 ' + focusTarget)
    await page.evaluate((id) => window.__ONESTEP__.actions.focusSession(id), focusTarget)
    await waitFor(() => page.evaluate((id) => window.__ONESTEP__.actions.currentSessionId() === id, focusTarget), { timeout: 10000, interval: 120, label: 'focus.restore' })
    await sleep(1200)
  }
  await enterStage(page, candidateIds, { settleMs: 1200 })
  await waitFor(
    () => page.evaluate((expected) => window.__ONESTEP__.actions.snapshot().mounted === true && window.__ONESTEP__.actions.snapshot().candidates.length === expected, candidateIds.length),
    { timeout: 12000, interval: 150, label: 'stage.reentered' },
  )
  await setTheme(page, 'light')
  await sleep(1200)
  await page.evaluate(() => window.__ONESTEP__.actions.setRailCollapsed(true))
  await waitFor(
    () => page.evaluate(() => {
      const toggle = document.querySelector('[data-onestep-rail-toggle]')
      return !!toggle && toggle.getAttribute('aria-expanded') === 'false' && window.__ONESTEP__.actions.snapshot().railCollapsed === true
    }),
    { timeout: 6000, interval: 100, label: 'rail.collapsed' },
  )
  // 悬停收起手柄，让「展开」入口在截图里清晰可见（真实鼠标）。
  const toggleRect = await page.evaluate(() => {
    const toggle = document.querySelector('[data-onestep-rail-toggle]')
    if (!toggle) return null
    const rect = toggle.getBoundingClientRect()
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
  })
  if (toggleRect) await page.mouse.move(toggleRect.x + toggleRect.w / 2, toggleRect.y + toggleRect.h / 2)
  await sleep(700)
  await shot(page, '07-rail-collapsed.png', {
    scene: '候场栏收起：候场栏收为 40px 边条（控件见左下角展开手柄），焦点窗占满舞台；不退出舞台',
    viewport: VIEW,
  })
  // 记录「收起态状态条绘制」的实测观察（见 capture.json.observations）：
  // 当前构建里焦点窗（z-index:3）覆盖候场栏 40px 边条，状态条 mini items 有布局尺寸但被覆盖。
  meta.observations = meta.observations || []
  const collapsedPaint = await page.evaluate(() => {
    const rail = document.querySelector('[data-onestep-rail]')
    const mini = document.querySelector('[data-onestep-rail-mini]')
    const focusFrame = document.querySelector('.onestep-frame[data-mode="focus"]')
    const rect = (el) => (el ? ((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }))(el.getBoundingClientRect()) : null)
    return {
      rail: rect(rail),
      mini: rect(mini),
      miniItems: mini ? mini.querySelectorAll('.onestep-rail-mini-item').length : 0,
      focusFrame: rect(focusFrame),
      topElementAtMiniDot: (() => {
        const el = document.elementFromPoint(292, 14)
        return el ? { tag: el.tagName, cls: String(el.className).slice(0, 60) } : null
      })(),
    }
  })
  meta.observations.push({
    kind: 'collapsed-rail-paint',
    note: '收起态：焦点窗与候场栏边条在布局上重叠（focusFrame x=280 覆盖 rail 280..320），候场栏 mini 状态条有 DOM/布局尺寸但被焦点窗（z-index:3）覆盖，仅展开手柄可见。截图为当前构建的如实画面；是否为缺陷待 Lead/实现方裁决。',
    evidence: collapsedPaint,
  })
  await page.mouse.move(700, 18)
  await sleep(200)

  // 9) 精简候场档（手动切档；与自动降级生效后的渲染同档）。
  await page.evaluate(() => window.__ONESTEP__.actions.setRailCollapsed(false))
  await page.evaluate(() => window.__ONESTEP__.actions.setPreviewMode('card'))
  await waitFor(
    () => page.evaluate(() => window.__ONESTEP__.actions.snapshot().previewModeEffective === 'card' && window.__ONESTEP__.actions.snapshot().previewMode === 'card'),
    { timeout: 6000, interval: 100, label: 'preview.card' },
  )
  await sleep(1200)
  await shot(page, '08-lite-card.png', {
    scene: '精简候场档（lite）：候场卡显示标题/状态/最近提问，焦点窗仍为 live',
    viewport: VIEW,
  })

  // 10) 顶部候场栏 @1280×800（主区 1000px < 1080 → 自动切顶部）。
  await page.evaluate(() => window.__ONESTEP__.actions.setPreviewMode('live'))
  await page.setViewportSize(VIEW_TOP_RAIL)
  await waitFor(
    () => page.evaluate(() => {
      const stage = document.querySelector('[data-onestep-stage]')
      return !!stage && stage.getAttribute('data-rail-side') === 'top'
    }),
    { timeout: 8000, interval: 120, label: 'rail.top' },
  )
  await sleep(1200)
  await waitStableLayout(page, 'layout.top-rail')
  await shot(page, '09-top-rail-1280.png', {
    scene: '1280×800：舞台主区 <1080px 自动切顶部候场栏（1 焦点 + 3 候场）',
    viewport: VIEW_TOP_RAIL,
  })

  // 11) 双主题对比（1440×900，1 焦点 + 2 候场，与 02/03 的 1+3 场景区分）。
  await page.setViewportSize(VIEW)
  await waitFor(() => page.evaluate(() => window.innerWidth === 1440), { timeout: 5000, interval: 100, label: 'viewport.restore' })
  await page.evaluate(() => window.__ONESTEP__.actions.removeCandidate(window.__ONESTEP__.actions.snapshot().candidates[2]))
  await waitFor(() => page.evaluate(() => window.__ONESTEP__.actions.snapshot().candidates.length === 2), { timeout: 6000, interval: 100, label: 'stage.2candidates' })
  await sleep(1200)
  await waitStableLayout(page, 'layout.compare')
  await setTheme(page, 'light')
  await sleep(600)
  await shot(page, '10-theme-compare-light.png', { scene: '双主题对比（light）：1 焦点 + 2 候场', viewport: VIEW })
  await setTheme(page, 'dark')
  await sleep(700)
  await shot(page, '10-theme-compare-dark.png', { scene: '双主题对比（dark）：1 焦点 + 2 候场', viewport: VIEW })
  await setTheme(page, 'light')
  await sleep(400)

  // 12) 恢复普通模式 + 原焦点会话 + 清理 localStorage 舞台状态，并验证。
  await leaveStage(page)
  await resetStageStorage(page)
  if (originalFocusId) {
    await page.evaluate((id) => window.__ONESTEP__.actions.focusSession(id), originalFocusId)
    await sleep(700)
  }
  await sleep(500)
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => !!window.__ONESTEP__, null, { timeout: 60000 })
  await page.waitForSelector('[role="textbox"], [contenteditable="true"]', { timeout: 60000 })
  await sleep(1500)
  recordSanitization(await hidePersonalUi(page), 'final')
  await setTheme(page, 'light')
  const finalSnap = await snapshot(page)
  const finalStorage = await readStageStorage(page)
  const finalDom = await page.evaluate(() => ({
    stage: document.querySelectorAll('[data-onestep-stage]').length,
    rowActions: document.querySelectorAll('[data-onestep-row-action]').length,
    picker: document.querySelectorAll('[data-onestep-picker="1"]').length,
  }))
  meta.cleanup = {
    mounted: finalSnap.mounted,
    candidates: finalSnap.candidates,
    focusId: finalSnap.focusId,
    originalFocusId,
    previewMode: finalSnap.previewMode,
    railCollapsed: finalSnap.railCollapsed,
    railSide: finalSnap.railSide,
    storage: finalStorage,
    dom: finalDom,
    theme: (await themeInfo(page)).theme,
    lang: await page.evaluate(() => document.documentElement.lang || null),
  }
  const storageClean =
    !!finalStorage &&
    Array.isArray(finalStorage.candidates) &&
    finalStorage.candidates.length === 0 &&
    finalStorage.railCollapsed === false &&
    finalStorage.previewMode === 'live'
  check('cleanup.normal-mode', finalSnap.mounted === false && (finalSnap.candidates || []).length === 0 && finalDom.stage === 0, {
    mounted: finalSnap.mounted,
    candidates: finalSnap.candidates,
    stageDom: finalDom.stage,
  })
  check('cleanup.storage-reset', storageClean, finalStorage)

  // 13) 页面错误汇总。
  meta.pageErrors = handles.pageErrors
  meta.consoleErrors = handles.consoleErrors
  check('no.page-errors', handles.pageErrors.length === 0, handles.pageErrors.slice(0, 5))

  const failed = meta.checks.filter((item) => !item.pass)
  meta.ok = failed.length === 0 && meta.screenshots.length >= 11
  log('[capture] ' + (meta.ok ? 'PASS' : 'FAIL') + ' screenshots=' + meta.screenshots.length + ' checks=' + meta.checks.length + ' failed=' + JSON.stringify(failed.map((item) => item.name)))
  if (!meta.ok) process.exitCode = 1
} catch (error) {
  pendingError = error
  meta.error = String((error && error.stack) || error)
  log('[capture] FATAL ' + String(error && error.message ? error.message : error))
  process.exitCode = 1
} finally {
  try {
    if (app) await closeApp(app)
  } catch (error) {
    /* ignore */
  }
  writeMeta()
  if (pendingError) log('[capture] wrote failing meta -> ' + path.relative(ROOT, META_FILE).replace(/\\/g, '/'))
}
