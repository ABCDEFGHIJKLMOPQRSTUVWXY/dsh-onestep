#!/usr/bin/env node
/**
 * dsh-onestep P2-3 验证：lite 自动降级 / 手动档位切换 / 4 窗表现 / 候场栏收起能力。
 *
 * 当前基线（src/client/store.js 有 autoLite 状态但无消费点）预期会暴露缺口：
 *   - autoLite 设置对渲染没有任何可见效果（无 4 窗首帧/长任务/内存阈值触发逻辑）；
 *   - 手动「完整候场 ↔ 精简候场」档位可用且持久化（P1 已实现，应 PASS）；
 *   - 候场栏收起（railCollapsed）只有状态、没有可交互手柄（P2-1/P2-3）。
 *
 * 产物：artifacts/p2/verify/lite-degrade.json + artifacts/p2/lite/*.png
 * 运行：node scripts/p2/verify/lite-degrade.mjs（需隔离实例在跑）
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ROOT, ARTIFACTS, Results, openApp, closeApp, snapshot, listSessions, leaveStage, sleep, waitFor,
  composerStats, resetStageStorage, writeStageStorage, readStageStorage, reloadApp, ensureStage,
  waitStageGone, probeLog,
} from './lib.mjs'

const OUT = path.join(ARTIFACTS, 'lite')
fs.mkdirSync(OUT, { recursive: true })
const results = new Results('lite-degrade', 'P2-3 lite 自动降级与手动档位', path.join(ARTIFACTS, 'verify', 'lite-degrade.json'))
const app = await openApp({ colorScheme: 'light', viewport: { width: 1440, height: 900 } })
const { page } = app

const stageSignature = () =>
  page.evaluate(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    const snap = window.__ONESTEP__.actions.snapshot()
    if (!stage) return { mounted: snap.mounted, hasStage: false, previewMode: snap.previewMode, railCollapsed: snap.railCollapsed, candidates: snap.candidates.length }
    const candidates = Array.from(stage.querySelectorAll('.onestep-frame[data-mode="candidate"]'))
    const visible = (el) => {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    return {
      hasStage: true,
      mounted: snap.mounted,
      previewMode: snap.previewMode,
      railSide: snap.railSide,
      railCollapsed: snap.railCollapsed,
      candidateCount: candidates.length,
      candidatePreviews: candidates.map((el) => el.getAttribute('data-preview')),
      occurrences: document.querySelectorAll('[data-onestep-occurrence]').length,
      occurrencesInsideStage: stage.querySelectorAll('[data-onestep-occurrence]').length,
      thumbnails: document.querySelectorAll('[data-onestep-thumb]').length,
      editableComposers: document.querySelectorAll('[contenteditable="true"]').length,
      visibleEditableComposers: Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(visible).length,
      visibleTextboxes: Array.from(document.querySelectorAll('[role="textbox"]')).filter(visible).length,
      heapUsed: performance.memory ? performance.memory.usedJSHeapSize : null,
    }
  })

const flush = async () => {
  try {
    await page.evaluate(() => window.__ONESTEP__.actions.flushPersist())
  } catch (_error) {
    /* ignore */
  }
}

const togglePreviewViaMenu = async () => {
  const opened = await page.evaluate(async () => {
    const more = document.querySelector('[data-onestep-more]')
    if (!more) return { error: 'no-more-button' }
    more.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const items = Array.from(document.querySelectorAll('.onestep-menu [role="menuitem"]'))
    return { labels: items.map((item) => item.textContent.trim()), expanded: more.getAttribute('aria-expanded'), itemCount: items.length }
  })
  const clicked = await page.evaluate(async () => {
    const items = Array.from(document.querySelectorAll('.onestep-menu [role="menuitem"]'))
    if (!items.length) return { error: 'no-menu-item' }
    items[0].click()
    await new Promise((resolve) => setTimeout(resolve, 900))
    return { previewMode: window.__ONESTEP__.actions.snapshot().previewMode, menuGone: !document.querySelector('.onestep-menu') }
  })
  await sleep(300)
  return { opened, clicked }
}

try {
  /* ============ 1. 静态证据：autoLite / railCollapsed 的消费点 ============ */
  const readSrc = (name) => fs.readFileSync(path.join(ROOT, 'src', 'client', name), 'utf8')
  const srcFiles = fs.readdirSync(path.join(ROOT, 'src', 'client')).filter((name) => name.endsWith('.js'))
  const sources = Object.fromEntries(srcFiles.map((name) => [name, readSrc(name)]))
  const countOf = (text, re) => (text.match(re) || []).length
  const autoLiteRefs = Object.fromEntries(srcFiles.map((name) => [name, countOf(sources[name], /autoLite/g)]))
  const autoLiteConsumers = Object.entries(autoLiteRefs).filter(([name, count]) => count > 0 && name !== 'store.js')
  const railCollapsedRefs = Object.fromEntries(srcFiles.map((name) => [name, countOf(sources[name], /railCollapsed/g)]))
  const railCollapseCallSites = Object.entries(railCollapsedRefs)
    .filter(([name, count]) => name !== 'store.js' && count > 0)
    .map(([name]) => name)
  const staticScan = {
    autoLiteRefs,
    autoLiteConsumers: autoLiteConsumers.map(([name, count]) => ({ file: 'src/client/' + name, count })),
    setAutoLiteExported: /export function setAutoLite/.test(sources['store.js'] || ''),
    setAutoLiteActionInStore: /setAutoLite:\s*\(/.test(sources['store.js'] || ''),
    setAutoLiteCallSites: srcFiles
      .filter((name) => name !== 'store.js')
      .filter((name) => /setAutoLite|autoLite/.test(sources[name]))
      .map((name) => 'src/client/' + name),
    railCollapsedRefs,
    railCollapseNonStoreFiles: railCollapseCallSites,
    railCollapseMenuEntry: /rail\.collapse|collapseRail|toggleRail/i.test(sources['stage-root.js'] + (sources['index.js'] || '')),
    localeHasRailCollapseKeys: /'rail\.collapse'/.test(sources['locale.js'] || ''),
    localeRailCollapseUsedInComponents: /rail\.collapse|rail\.expand/.test((sources['stage-root.js'] || '') + (sources['index.js'] || '')),
    reducedMotionSetting: /reducedMotion/.test(sources['store.js'] || ''),
  }
  results.step('static-scan', staticScan)
  results.setEnv('autoLiteConsumers', staticScan.autoLiteConsumers)
  results.setEnv('autoLiteRefs', autoLiteRefs)
  results.assert('lite.auto-lite-consumer', staticScan.autoLiteConsumers.length > 0, {
    expected: 'P2-3：autoLite 应有消费点（4 窗首帧/长任务/内存阈值 → 自动降级；用户可切回）',
    actual: { autoLiteRefs, consumersOutsideStore: staticScan.autoLiteConsumers, setAutoLiteActionInStore: staticScan.setAutoLiteActionInStore, callSites: staticScan.setAutoLiteCallSites, probeActionExposesAutoLite: false },
    category: 'P2-3',
    evidence: 'autoLite 只出现在 src/client/store.js（状态定义/持久化/setAutoLite），index.js/stage-root.js/layout.js/content.js 均 0 引用；probe.actions 无 autoLite 入口；「…」菜单无自动降级项',
  })
  results.assert('lite.rail-collapse-ui', staticScan.railCollapseNonStoreFiles.length > 0 && staticScan.railCollapseMenuEntry === true, {
    expected: 'P2-1/P2-3：候场栏可收起（手柄/菜单，且可恢复）',
    actual: { railCollapsedRefs, nonStoreFiles: staticScan.railCollapseNonStoreFiles, anyMenuOrHandler: staticScan.railCollapseMenuEntry, localeHasKeysButUnused: staticScan.localeHasRailCollapseKeys && !staticScan.localeRailCollapseUsedInComponents },
    category: 'P2-1',
    evidence: 'store.js 有 setRailCollapsed，但除 store 外仅 layout.js/stage-root.js 读取字段；locale.js 的 rail.collapse/expand 两个键在组件中无引用；stage-root.js:491 的 collapsed 变量未使用',
  })

  /* ============ 2. 归一化主绑定 + 4 窗手动档位 ============ */
  const rows = await listSessions(page)
  const blankIds = Object.keys(rows).filter((id) => rows[id].blank)
  if (blankIds.length === 0) throw new Error('没有空白会话可用于归一化主绑定')
  await leaveStage(page)
  await page.evaluate((id) => window.__ONESTEP__.actions.focusSession(id), blankIds[0])
  await sleep(1200)
  await page.evaluate(() => window.__ONESTEP__.actions.setPreviewMode('live'))
  await sleep(300)
  await resetStageStorage(page)
  const stageLive = await ensureStage(page, 3, { settleMs: 900 })
  const liveSignature = await stageSignature()
  const liveGeometry = await page.evaluate(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    const r = stage.getBoundingClientRect()
    const frames = Array.from(stage.querySelectorAll('.onestep-frame')).map((el) => {
      const rect = el.getBoundingClientRect()
      return { mode: el.getAttribute('data-mode'), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
    })
    return { stage: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, frames }
  })
  await results.shot(page, 'p2-lite-01-live-4windows.png', OUT)
  results.step('stage-4windows-live', { snapshot: { focus: String(stageLive.focusId).slice(0, 12), candidates: stageLive.candidates.length }, signature: liveSignature, geometry: liveGeometry })
  results.assert('lite.4windows-live', liveSignature.candidateCount === 3 && liveSignature.occurrencesInsideStage === 4 && liveSignature.candidatePreviews.every((preview) => preview === 'live'), {
    expected: '完整档 4 窗：3 候场 live 缩略 + 焦点聊天体 = 4 个官方 occurrence',
    actual: liveSignature, category: 'P2-3',
  })
  results.assert('lite.4windows-visible-composer', liveSignature.visibleEditableComposers === 1, {
    expected: '4 窗时仅焦点窗 1 个可见可编辑 composer（候场输入区隐藏）', actual: { visibleEditableComposers: liveSignature.visibleEditableComposers, editable: liveSignature.editableComposers, visibleTextboxes: liveSignature.visibleTextboxes }, category: 'P2-3',
  })
  const insideStage = liveGeometry.frames.every((frame) => frame.x >= liveGeometry.stage.x - 1 && frame.y >= liveGeometry.stage.y - 1 && frame.x + frame.w <= liveGeometry.stage.x + liveGeometry.stage.w + 1 && frame.y + frame.h <= liveGeometry.stage.y + liveGeometry.stage.h + 1)
  results.assert('lite.4windows-layout', insideStage, {
    expected: '4 窗全部落在舞台矩形内（无溢出）', actual: { insideStage, stage: liveGeometry.stage, frames: liveGeometry.frames }, category: 'P2-3',
  })

  /* ============ 3. 手动档位切换（live → card）+ 持久化 ============ */
  const menu = await togglePreviewViaMenu()
  const cardSignature = await stageSignature()
  const storedAfterToggle = await flush().then(() => readStageStorage(page))
  await results.shot(page, 'p2-lite-02-card-4windows.png', OUT)
  results.step('manual-preview-toggle', { menu, signature: cardSignature, stored: storedAfterToggle && { previewMode: storedAfterToggle.previewMode, autoLite: storedAfterToggle.autoLite, railCollapsed: storedAfterToggle.railCollapsed } })
  results.assert('lite.manual-preview-switch', menu.opened && menu.opened.labels && menu.opened.labels.some((label) => /精简|compact/i.test(label)) && menu.clicked && menu.clicked.previewMode === 'card', {
    expected: '「…」菜单提供「切换为精简候场」，点击后 previewMode=card（P2-3 手动切回路径）',
    actual: { menuLabels: menu.opened && menu.opened.labels, previewModeAfter: menu.clicked && menu.clicked.previewMode, expanded: menu.opened && menu.opened.expanded }, category: 'P2-3',
  })
  results.assert('lite.card-mode-dom', cardSignature.previewMode === 'card' && cardSignature.candidateCount === 3 && cardSignature.occurrencesInsideStage === 1 && cardSignature.candidatePreviews.every((preview) => preview === 'card'), {
    expected: '精简档：候场 occurrence 0、仅焦点 1 个官方聊天体；候选 data-preview=card',
    actual: cardSignature, category: 'P2-3',
  })
  results.assert('lite.preview-persisted', storedAfterToggle && storedAfterToggle.previewMode === 'card', {
    expected: '手动档位持久化到 localStorage（dsh.onestep.v1.previewMode=card）', actual: storedAfterToggle && { previewMode: storedAfterToggle.previewMode, autoLite: storedAfterToggle.autoLite }, category: 'P2-3',
  })

  // 重新加载验证持久化恢复
  await page.evaluate(() => window.__ONESTEP__.actions.exitStage())
  await sleep(500)
  await flush()
  await reloadApp(page, { normalize: false })
  const afterReload = await snapshot(page)
  results.step('preview-persist-after-reload', { previewMode: afterReload.previewMode, mounted: afterReload.mounted, candidates: afterReload.candidates.length })
  results.assert('lite.preview-restored-after-reload', afterReload.previewMode === 'card', {
    expected: '刷新后 previewMode 恢复为 card', actual: { previewMode: afterReload.previewMode }, category: 'P2-3',
  })
  await ensureStage(page, 3, { settleMs: 800 })
  const cardRestoredSignature = await stageSignature()
  results.assert('lite.card-mode-after-reload', cardRestoredSignature.previewMode === 'card' && cardRestoredSignature.occurrencesInsideStage === 1 && cardRestoredSignature.candidatePreviews.every((preview) => preview === 'card'), {
    expected: '刷新后重新进入舞台仍处于精简档（仅焦点渲染聊天体）', actual: cardRestoredSignature, category: 'P2-3',
  })
  // 切回 live
  const backMenu = await togglePreviewViaMenu()
  const liveBackSignature = await stageSignature()
  results.step('manual-preview-back-live', { menu: backMenu, signature: liveBackSignature })
  results.assert('lite.manual-preview-back', liveBackSignature.previewMode === 'live' && liveBackSignature.occurrencesInsideStage === 4, {
    expected: '手动从精简档切回完整档（live，4 occurrence）', actual: liveBackSignature, category: 'P2-3',
  })

  /* ============ 4. autoLite 运行时（故障注入采样：true 降级 / false 不降级 / 手动优先 / 不写持久化） ============ */
  const runAutoLiteCase = async (options) => {
    await page.evaluate(() => window.__ONESTEP__.actions.exitStage())
    await sleep(500)
    await writeStageStorage(page, { autoLite: options.autoLite, previewMode: 'live', railCollapsed: false })
    await reloadApp(page, { normalize: false })
    await sleep(600)
    const rowsFresh = await listSessions(page)
    const blank = Object.keys(rowsFresh).find((id) => rowsFresh[id].blank)
    if (blank) {
      await page.evaluate((id) => window.__ONESTEP__.actions.focusSession(id), blank)
      await sleep(900)
    }
    // 健康机不会自然越过首帧预算：e2e 用 probe.simulatePerf 注入采样值（生产路径不调用）。
    await page.evaluate((sample) => window.__ONESTEP__.actions.simulatePerf(sample), options.sample)
    const enter = await ensureStage(page, 3, { settleMs: 1000 })
    const signature = await stageSignature()
    const snap = await snapshot(page)
    const liteLogs = (await probeLog(page, 200)).filter((entry) => /autolite|lite|degrad/i.test(entry.event))
    const stored = await flush().then(() => readStageStorage(page))
    const result = {
      enabled: options.autoLite,
      candidates: enter.candidates.length,
      signature,
      snapshot: { previewMode: snap.previewMode, autoLite: snap.autoLite },
      liteLogs: liteLogs.map((entry) => ({ event: entry.event, data: entry.data })),
      stored: stored && { previewMode: stored.previewMode, autoLite: stored.autoLite },
    }
    if (options.manualPriority) {
      // 自动降级后用户手动切回完整档：本次舞台会话内自动判定不得再覆盖（manual-override）。
      await page.evaluate(() => window.__ONESTEP__.actions.setPreviewMode('live'))
      await sleep(500)
      await page.evaluate((sample) => {
        window.__ONESTEP__.actions.simulatePerf(sample)
        window.__ONESTEP__.actions.runAutoLiteSample()
      }, options.sample)
      await sleep(600)
      result.manualPriority = { signature: await stageSignature(), autoLite: (await snapshot(page)).autoLite }
    }
    await page.evaluate(() => window.__ONESTEP__.actions.exitStage())
    await sleep(500)
    return result
  }
  const slowSample = { firstFrameMs: 1500, longTaskTotalMs: 0, memoryDeltaMB: 10 }
  const autoTrue = await runAutoLiteCase({ autoLite: true, sample: slowSample, manualPriority: true })
  const autoFalse = await runAutoLiteCase({ autoLite: false, sample: slowSample })
  const comparable = (result) => ({
    candidateCount: result.signature.candidateCount,
    candidatePreviews: result.signature.candidatePreviews,
    occurrencesInsideStage: result.signature.occurrencesInsideStage,
    previewModeEffective: result.snapshot.autoLite && result.snapshot.autoLite.active ? 'card' : result.snapshot.previewMode,
  })
  const equal = JSON.stringify(comparable(autoTrue)) === JSON.stringify(comparable(autoFalse))
  results.step('auto-lite-injected', { autoTrue, autoFalse, comparableTrue: comparable(autoTrue), comparableFalse: comparable(autoFalse), equal })
  results.assert('lite.auto-lite-runtime-effect', equal === false && autoTrue.signature.candidatePreviews.every((p) => p === 'card') && autoFalse.signature.candidatePreviews.every((p) => p === 'live'), {
    expected: '4 窗 + 首帧超预算（故障注入采样）时 autoLite=true 自动降级到精简候场、autoLite=false 保持完整档',
    actual: {
      autoTrue: { previews: autoTrue.signature.candidatePreviews, occurrences: autoTrue.signature.occurrencesInsideStage, reason: autoTrue.snapshot.autoLite && autoTrue.snapshot.autoLite.reason },
      autoFalse: { previews: autoFalse.signature.candidatePreviews, occurrences: autoFalse.signature.occurrencesInsideStage, reason: autoFalse.snapshot.autoLite && autoFalse.snapshot.autoLite.reason },
      equal,
    },
    category: 'P2-3',
    note: 'e2e 通过 probe.simulatePerf 注入首帧 1500ms（健康机不会自然触发）；真实采样路径见 §2 的 4 窗 live 断言（within-budget 不降级）',
  })
  results.assert('lite.auto-lite-no-persist', autoTrue.stored && autoTrue.stored.previewMode === 'live' && autoTrue.stored.autoLite === true, {
    expected: '自动降级不写用户持久化偏好（localStorage.previewMode 仍为 live，autoLite 开关不变）',
    actual: { stored: autoTrue.stored, snapshotPreviewMode: autoTrue.snapshot.previewMode }, category: 'P2-3',
  })
  results.assert('lite.auto-lite-manual-priority', !!autoTrue.manualPriority && autoTrue.manualPriority.signature.candidatePreviews.every((p) => p === 'live') && !!autoTrue.manualPriority.autoLite && autoTrue.manualPriority.autoLite.reason === 'manual-override', {
    expected: '用户手动切回完整档后，本次舞台会话内自动降级不再覆盖（reason=manual-override）',
    actual: autoTrue.manualPriority, category: 'P2-3',
  })

  /* ============ 5. 候场栏收起能力（运行时）：手柄交互 / 持久化收起态不退出舞台 / 展开恢复 ============ */
  const normalizeMain = async () => {
    await leaveStage(page)
    const rowsNow = await listSessions(page)
    const blank = Object.keys(rowsNow).find((id) => rowsNow[id].blank)
    if (blank) {
      await page.evaluate((id) => window.__ONESTEP__.actions.focusSession(id), blank)
      await sleep(1000)
    }
  }
  await page.evaluate(() => window.__ONESTEP__.actions.exitStage())
  await sleep(400)
  await resetStageStorage(page)
  await reloadApp(page, { normalize: false })
  await sleep(600)
  await normalizeMain()
  await ensureStage(page, 1, { settleMs: 900 })
  const railProbe = await page.evaluate(() => {
    const hitLabels = []
    const texts = ['收起候场栏', 'Collapse candidate rail', 'Expand candidate rail', '展开候场栏']
    for (const el of document.querySelectorAll('*')) {
      const label = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + String(el.textContent || '').slice(0, 40)
      if (texts.some((text) => label.includes(text))) hitLabels.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 50), label: label.trim().slice(0, 80) })
    }
    const toggle = document.querySelector('[data-onestep-rail-toggle]')
    return {
      collapseControls: hitLabels.slice(0, 8),
      probeActionKeys: Object.keys(window.__ONESTEP__.actions).filter((key) => /rail|collapse/i.test(key)),
      toggle: toggle ? { label: toggle.getAttribute('aria-label'), expanded: toggle.getAttribute('aria-expanded'), tabIndex: toggle.tabIndex } : null,
    }
  })
  results.step('rail-probe', railProbe)
  await results.shot(page, 'p2-lite-03-rail-control.png', OUT)
  results.assert('lite.rail-collapse-control', railProbe.collapseControls.length > 0 && !!railProbe.toggle && railProbe.toggle.tabIndex === 0, {
    expected: '候场栏有可交互收起/展开手柄（原生 button、键盘可达、aria-expanded 表达状态）',
    actual: { collapseControls: railProbe.collapseControls, probeRailActions: railProbe.probeActionKeys, toggle: railProbe.toggle },
    category: 'P2-1',
  })
  const collapseClick = await page.evaluate(async () => {
    const toggle = document.querySelector('[data-onestep-rail-toggle]')
    if (!toggle) return { error: 'no-toggle' }
    toggle.click()
    await new Promise((resolve) => setTimeout(resolve, 700))
    const stage = document.querySelector('[data-onestep-stage]')
    const focus = stage ? stage.querySelector('.onestep-frame[data-mode="focus"]') : null
    const stageRect = stage ? stage.getBoundingClientRect() : null
    const focusRect = focus ? focus.getBoundingClientRect() : null
    const current = document.querySelector('[data-onestep-rail-toggle]')
    return {
      mounted: window.__ONESTEP__.actions.snapshot().mounted,
      railCollapsed: window.__ONESTEP__.actions.snapshot().railCollapsed,
      candidateFrames: stage ? stage.querySelectorAll('.onestep-frame[data-mode="candidate"]').length : 0,
      railMini: stage ? stage.querySelectorAll('[data-onestep-rail-mini]').length : 0,
      focusFullWidth: !!stageRect && !!focusRect && Math.abs(focusRect.width - stageRect.width) <= 2 && Math.abs(focusRect.height - stageRect.height) <= 2,
      toggle: current ? { label: current.getAttribute('aria-label'), expanded: current.getAttribute('aria-expanded') } : null,
      toast: (() => {
        const el = document.querySelector('.onestep-toast')
        return el ? el.textContent.trim().slice(0, 60) : null
      })(),
    }
  })
  results.step('rail-collapse-click', collapseClick)
  results.assert('lite.rail-collapse-handler', collapseClick.mounted === true && collapseClick.railCollapsed === true && collapseClick.candidateFrames === 0 && collapseClick.focusFullWidth === true && collapseClick.railMini >= 1, {
    expected: '点击手柄收起：候场卡隐藏、状态条保留、焦点窗占满舞台、舞台不退出',
    actual: collapseClick, category: 'P2-3',
  })
  // 持久化收起态 → 刷新后重新进入舞台（缺陷回归：注入 railCollapsed=true 不应再被判「窗口过窄」退出）
  await flush()
  await page.evaluate(() => window.__ONESTEP__.actions.exitStage())
  await sleep(500)
  await reloadApp(page, { normalize: false })
  await sleep(600)
  const storedCollapsed = await readStageStorage(page)
  await normalizeMain()
  // 折叠态下候场卡不渲染，ensureStage 的 waitStageReady（要求候场帧出现）不适用：
  // 直接 addCandidate 让舞台挂载，并等待 snapshot().mounted + 舞台 DOM（这正是缺陷回归路径）。
  const railCandidateId = await page.evaluate(() => {
    const actions = window.__ONESTEP__.actions
    const rows = actions.listSessions()
    const current = actions.snapshot().focusId || actions.currentSessionId()
    return Object.keys(rows).find((id) => !rows[id].blank && id !== current) || Object.keys(rows)[0]
  })
  await page.evaluate((id) => window.__ONESTEP__.actions.addCandidate(id), railCandidateId)
  await waitFor(
    () =>
      page.evaluate(() => {
        const snap = window.__ONESTEP__.actions.snapshot()
        return snap.mounted === true && !!document.querySelector('[data-onestep-stage]')
      }),
    { timeout: 15000, interval: 200, label: 'collapsed-stage-mounted' },
  )
  await sleep(1400)
  const injectedState = await snapshot(page)
  const injectedDom = await page.evaluate(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    const focus = stage ? stage.querySelector('.onestep-frame[data-mode="focus"]') : null
    const stageRect = stage ? stage.getBoundingClientRect() : null
    const focusRect = focus ? focus.getBoundingClientRect() : null
    const toggle = document.querySelector('[data-onestep-rail-toggle]')
    return {
      stage: stageRect ? { x: Math.round(stageRect.x), y: Math.round(stageRect.y), w: Math.round(stageRect.width), h: Math.round(stageRect.height) } : null,
      focus: focusRect ? { x: Math.round(focusRect.x), y: Math.round(focusRect.y), w: Math.round(focusRect.width), h: Math.round(focusRect.height) } : null,
      focusFullWidth: !!stageRect && !!focusRect && Math.abs(focusRect.width - stageRect.width) <= 2,
      candidateFrames: stage ? stage.querySelectorAll('.onestep-frame[data-mode="candidate"]').length : 0,
      railMini: stage ? stage.querySelectorAll('[data-onestep-rail-mini]').length : 0,
      toggle: toggle ? { label: toggle.getAttribute('aria-label'), expanded: toggle.getAttribute('aria-expanded') } : null,
      toast: (() => {
        const el = document.querySelector('.onestep-toast')
        return el ? el.textContent.trim().slice(0, 60) : null
      })(),
    }
  })
  await results.shot(page, 'p2-lite-04-rail-collapsed.png', OUT)
  results.step('rail-collapsed-injected', {
    stored: storedCollapsed && { railCollapsed: storedCollapsed.railCollapsed, previewMode: storedCollapsed.previewMode },
    state: { mounted: injectedState.mounted, railCollapsed: injectedState.railCollapsed, candidates: injectedState.candidates.length },
    dom: injectedDom,
  })
  const injectedNarrowToast = /窗口过窄|too narrow/i.test(String(injectedDom.toast || ''))
  results.assert('lite.rail-collapsed-behavior', injectedState.mounted === true && injectedState.railCollapsed === true && injectedDom.candidateFrames === 0 && injectedDom.focusFullWidth === true && injectedState.candidates.length >= 1 && !injectedNarrowToast, {
    expected: '注入 railCollapsed=true（持久化收起态）进入舞台：保持舞台、焦点窗占满、候场 roster 保留、不弹「窗口过窄」',
    actual: { mounted: injectedState.mounted, railCollapsed: injectedState.railCollapsed, candidates: injectedState.candidates.length, dom: injectedDom, narrowToast: injectedNarrowToast },
    category: 'P2-1',
    note: '原缺陷：layout.solve(折叠态) visibleCount=0 被当成单窗降级 → 400ms 后 onNarrow 退出舞台；修复后由 layoutUsable 把折叠态判为可用（单测覆盖）。',
  })
  const expandResult = await page.evaluate(async () => {
    const toggle = document.querySelector('[data-onestep-rail-toggle]')
    if (!toggle) return { error: 'no-toggle' }
    toggle.click()
    await new Promise((resolve) => setTimeout(resolve, 700))
    const stage = document.querySelector('[data-onestep-stage]')
    const current = document.querySelector('[data-onestep-rail-toggle]')
    return {
      railCollapsed: window.__ONESTEP__.actions.snapshot().railCollapsed,
      candidateFrames: stage ? stage.querySelectorAll('.onestep-frame[data-mode="candidate"]').length : 0,
      toggle: current ? { label: current.getAttribute('aria-label'), expanded: current.getAttribute('aria-expanded') } : null,
    }
  })
  await results.shot(page, 'p2-lite-05-rail-expanded.png', OUT)
  results.step('rail-expand-click', expandResult)
  results.assert('lite.rail-collapsed-expand', expandResult.railCollapsed === false && expandResult.candidateFrames >= 1 && !!expandResult.toggle && expandResult.toggle.expanded === 'true', {
    expected: '再次点击手柄展开：候场卡恢复渲染、aria-expanded 复位',
    actual: expandResult, category: 'P2-3',
  })

  /* ============ 清理 ============ */
  try {
    await page.evaluate(() => window.__ONESTEP__.actions.exitStage())
  } catch (_error) {
    /* ignore */
  }
  await resetStageStorage(page)
  await sleep(400)
  results.assert('env.no-page-errors', app.handles.pageErrors.length === 0, {
    expected: 'lite 套件无页面异常', actual: { pageErrors: app.handles.pageErrors, consoleErrors: app.handles.consoleErrors.slice(0, 5) }, category: 'env',
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
