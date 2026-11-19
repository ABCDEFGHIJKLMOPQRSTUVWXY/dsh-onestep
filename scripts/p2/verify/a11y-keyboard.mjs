#!/usr/bin/env node
/**
 * dsh-onestep P2-1 验证：无障碍（ARIA / 状态点 / focus-visible / aria-live / 对比度 / reduced motion）
 * + 键盘全流程（进入舞台、提升、移出、退出、撤销、快捷键矩阵 vs 文档 §10.1）。
 *
 * 期望值来自 docs/产品设计报告.md §9.2/§10（ARIA、尺寸、对比度、键盘地图、焦点管理）与
 * docs/开发文档.md §9.6 P2 出口；实现基线来自 src/client/{stage-root,index,styles,store}.js。
 *
 * 产物：artifacts/p2/verify/a11y-keyboard.json + artifacts/p2/a11y/*.png
 * 运行：node scripts/p2/verify/a11y-keyboard.mjs（需隔离实例在跑；不启动/重启实例）
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ROOT, ARTIFACTS, Results, openApp, closeApp, snapshot, probeLog, domStats, listSessions,
  ensureStage, leaveStage, pressChord, sleep, waitFor, domTabbables, tabSequence, waitStageReady,
  measureContrast, setTheme, themeInfo, composerStats, blurActive, listActionNames,
  resetStageStorage, round2,
} from './lib.mjs'

const OUT = path.join(ARTIFACTS, 'a11y')
const SHOTS = path.join(ARTIFACTS, 'verify', 'shots')
fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(SHOTS, { recursive: true })

const results = new Results('a11y-keyboard', 'P2-1 无障碍与键盘全流程', path.join(ARTIFACTS, 'verify', 'a11y-keyboard.json'))
const app = await openApp({ colorScheme: 'light', viewport: { width: 1440, height: 900 } })
const { page } = app
const C = {
  stage: '[data-onestep-stage]',
  focus: '[data-onestep-stage] .onestep-frame[data-mode="focus"]',
  candidate: '[data-onestep-stage] .onestep-frame[data-mode="candidate"]',
}
const activeDesc = () =>
  page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body || el === document.documentElement) return { tag: 'BODY', frame: null }
    return {
      tag: el.tagName,
      cls: String(el.className || '').slice(0, 70),
      role: el.getAttribute('role'),
      label: (el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 50),
      frame: el.closest && el.closest('.onestep-frame') ? el.closest('.onestep-frame').getAttribute('data-mode') : null,
      insideStage: !!el.closest('[data-onestep-stage]'),
    }
  })
const focusInfo = () => page.evaluate(() => {
  const stage = document.querySelector('[data-onestep-stage]')
  if (!stage) return null
  const focus = stage.querySelector('.onestep-frame[data-mode="focus"]')
  const cands = Array.from(stage.querySelectorAll('.onestep-frame[data-mode="candidate"]'))
  const attr = (el, name) => (el ? el.getAttribute(name) : null)
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 }
  }
  const css = (el, prop) => (el ? getComputedStyle(el)[prop] : null)
  const focusDot = focus ? focus.querySelector('.onestep-dot') : null
  const focusControl = focus ? focus.querySelector('.onestep-control') : null
  const splitter = stage.querySelector('[data-onestep-splitter]')
  const live = stage.querySelector('[aria-live]')
  return {
    stage: { role: attr(stage, 'role'), label: attr(stage, 'aria-label'), tabIndex: stage.tabIndex },
    focus: {
      role: attr(focus, 'role'),
      label: attr(focus, 'aria-label'),
      radius: css(focus, 'borderRadius'),
      titleWeight: css(focus && focus.querySelector('.onestep-title'), 'fontWeight'),
      titleSize: css(focus && focus.querySelector('.onestep-title'), 'fontSize'),
      rect: rect(focus),
    },
    candidates: cands.map((el) => ({
      role: attr(el, 'role'),
      label: attr(el, 'aria-label'),
      tabIndex: el.tabIndex,
      preview: attr(el, 'data-preview'),
      titleWeight: css(el.querySelector('.onestep-title'), 'fontWeight'),
      titleSize: css(el.querySelector('.onestep-title'), 'fontSize'),
      dot: (() => {
        const d = el.querySelector('.onestep-dot')
        return d ? { w: rect(d).w, h: rect(d).h, cssW: css(d, 'width'), cssH: css(d, 'height'), aria: attr(d, 'aria-label'), title: attr(d, 'title'), tone: attr(d, 'data-tone'), radius: css(d, 'borderRadius') } : null
      })(),
      bodyInert: (() => {
        const body = el.querySelector('.onestep-body')
        return body ? { inertAttr: body.hasAttribute('inert'), dataInert: attr(body, 'data-inert') } : null
      })(),
      control: (() => {
        const ctl = el.querySelector('.onestep-control')
        const dot = ctl ? ctl.querySelector('.onestep-control-dot') : null
        return ctl
          ? {
              w: rect(ctl).w,
              h: rect(ctl).h,
              cssW: css(ctl, 'width'),
              cssH: css(ctl, 'height'),
              dotW: dot ? rect(dot).w : null,
              dotCssW: dot ? css(dot, 'width') : null,
            }
          : null
      })(),
    })),
    candidateCount: cands.length,
    focusControl: focusControl
      ? {
          w: rect(focusControl).w,
          h: rect(focusControl).h,
          cssW: css(focusControl, 'width'),
          cssH: css(focusControl, 'height'),
          dotW: (() => {
            const dot = focusControl.querySelector('.onestep-control-dot')
            return dot ? rect(dot).w : null
          })(),
          dotCssW: (() => {
            const dot = focusControl.querySelector('.onestep-control-dot')
            return dot ? css(dot, 'width') : null
          })(),
          dataShow: attr(focusControl, 'data-show'),
        }
      : null,
    focusDot: focusDot ? { w: rect(focusDot).w, h: rect(focusDot).h, aria: attr(focusDot, 'aria-label'), title: attr(focusDot, 'title'), tone: attr(focusDot, 'data-tone') } : null,
    splitter: splitter
      ? { role: attr(splitter, 'role'), tabIndex: splitter.tabIndex, ariaLabel: attr(splitter, 'aria-label'), valuemin: attr(splitter, 'aria-valuemin'), valuemax: attr(splitter, 'aria-valuemax'), valuenow: attr(splitter, 'aria-valuenow') }
      : null,
    live: live ? { ariaLive: attr(live, 'aria-live'), role: attr(live, 'role'), text: live.textContent } : null,
  }
})
const mapRatio = (set) => {
  const out = {}
  for (const [key, value] of Object.entries(set)) out[key] = value ? { ratio: value.ratio, fg: value.fg, bg: value.bg, font: value.font } : null
  return out
}
const minContrast = (set) => Math.min(...Object.values(set).filter(Boolean).map((item) => item.ratio))

/** 用「空白/可编辑」会话进入舞台：保证焦点窗 composer 可编辑，焦点转移才有对象可断言。 */
const ensureIdleStage = async (count) => {
  await leaveStage(page)
  const rows = await listSessions(page)
  const blankIds = Object.keys(rows).filter((id) => rows[id].blank)
  if (blankIds.length < count + 1) throw new Error('可用空白会话不足（需要 ' + (count + 1) + ' 个）')
  const mainId = blankIds[0]
  await page.evaluate((id) => window.__ONESTEP__.actions.focusSession(id), mainId)
  await sleep(1400)
  const candidateIds = blankIds.slice(1, 1 + count)
  await page.evaluate((ids) => {
    for (const id of ids) window.__ONESTEP__.actions.addCandidate(id)
  }, candidateIds)
  await waitStageReady(page, count)
  await sleep(900)
  return { mainId, candidateIds }
}

try {
  /* ============ 0. 环境与实例 ============ */
  const boot = await page.evaluate(() => window.__ONESTEP__.actions.boot())
  const theme0 = await themeInfo(page)
  const actionNames = await listActionNames(page)
  const shortcutLogs = (await probeLog(page, 200)).filter((entry) => entry.event === 'shortcut.register').map((entry) => entry.data && entry.data.id)
  results.step('env', { boot, theme: theme0, actionNames, shortcutLogs })
  results.setEnv('release', boot.release)
  results.setEnv('bootEntries', boot.entries)
  results.assert('env.instance-ready', !!boot.release && boot.entries > 0, {
    expected: '隔离实例 boot 就绪且插件条目存在', actual: { release: boot.release, entries: boot.entries, selfEntry: boot.selfEntry && boot.selfEntry.id }, category: 'env',
  })
  results.assert('env.shortcuts-registered', ['toggle-stage', 'quick-new', 'close-focus', 'undo', 'focus-1', 'focus-2', 'focus-3', 'focus-4'].every((id) => shortcutLogs.includes(id)), {
    expected: '8 个插件快捷键注册成功', actual: shortcutLogs, category: 'P2-1',
  })
  const indexSrc = fs.readFileSync(path.join(ROOT, 'src', 'client', 'index.js'), 'utf8')
  const adapterSrc = fs.readFileSync(path.join(ROOT, 'src', 'client', 'adapter.js'), 'utf8')
  const hasConflictCheck = /reservedShortcut|reservedSequences|conflictCheck|shortcut\.conflict|保留序列|冲突检测/i.test(indexSrc) || /reserved|RESERVED/i.test(adapterSrc)
  results.setEnv('shortcutConflictDetection', hasConflictCheck)
  results.skip(
    'shortcut-conflict-detection',
    '注册走官方 ctx.shortcuts.register({defaults,label,regions})：改键/冲突提示可能由官方快捷键服务提供，需人工在官方快捷键设置页确认；插件侧无保留序列表（index.js:956-994、adapter.js 均无）。本套件不把它记作 e2e 失败。',
    'P2-1',
  )

  /* ============ 1. 普通模式 → 键盘路径进入舞台 ============ */
  await page.evaluate(() => window.__ONESTEP__.actions.setPreviewMode('live'))
  const rows = await listSessions(page)
  const current = await snapshot(page)
  const normalSession = Object.keys(rows).find((id) => !rows[id].blank && id !== current.focusId)
  await page.evaluate((id) => window.__ONESTEP__.actions.focusSession(id), normalSession)
  await sleep(1500)
  let header = { count: 0 }
  try {
    await waitFor(
      () => page.evaluate(() => {
        const btn = document.querySelector('[data-onestep-header-action]')
        if (!btn) return false
        const r = btn.getBoundingClientRect()
        return r.width > 2 && r.height > 2
      }),
      { timeout: 8000, interval: 200, label: 'header-entry' },
    )
    header = await page.evaluate(() => {
      const btn = document.querySelector('[data-onestep-header-action]')
      return { count: document.querySelectorAll('[data-onestep-header-action]').length, label: btn.getAttribute('aria-label'), visible: true }
    })
  } catch (_error) {
    header = await page.evaluate(() => ({ count: document.querySelectorAll('[data-onestep-header-action]').length }))
  }
  const normalComposer = await composerStats(page)
  results.step('normal-mode', { header, composer: normalComposer })
  results.assert('env.header-entry-present', header.count === 1 && header.visible === true, {
    expected: '普通模式 header 有可见「加入舞台」入口按钮（键盘可达）', actual: header, category: 'P2-1',
  })
  results.assert('env.normal-composer', normalComposer.editableVisible === 1, {
    expected: '普通模式可编辑 composer=1', actual: normalComposer, category: 'env',
  })
  await results.shot(page, 'p2-a11y-00-normal.png', SHOTS)

  // 键盘激活 header 按钮 → picker → 勾选 → 确认 → 舞台
  await page.evaluate(() => document.querySelector('[data-onestep-header-action]').focus())
  const headerFocused = await page.evaluate(() => document.activeElement === document.querySelector('[data-onestep-header-action]'))
  await page.keyboard.press('Enter')
  await sleep(800)
  const picker = await page.evaluate(() => {
    const el = document.querySelector('[data-onestep-picker]')
    if (!el) return null
    const boxes = el.querySelectorAll('input[type="checkbox"]')
    const buttons = Array.from(el.querySelectorAll('button')).map((b) => b.textContent.trim())
    return { boxes: boxes.length, buttons, hasBox: boxes.length > 0, name: el.getAttribute('role') || null }
  })
  await page.evaluate(() => {
    const el = document.querySelector('[data-onestep-picker]')
    const boxes = el ? el.querySelectorAll('input[type="checkbox"]') : []
    if (boxes[0]) boxes[0].focus()
  })
  await page.keyboard.press('Space')
  await sleep(200)
  await page.evaluate(() => {
    const el = document.querySelector('[data-onestep-picker]')
    if (!el) return
    const buttons = Array.from(el.querySelectorAll('button'))
    if (buttons.length) buttons[buttons.length - 1].focus()
  })
  const confirmLabel = await page.evaluate(() => (document.activeElement ? document.activeElement.textContent.trim() : null))
  await page.keyboard.press('Enter')
  await sleep(1800)
  const entered = await snapshot(page)
  results.step('keyboard-enter', { headerFocused, picker, confirmLabel, entered: { mounted: entered.mounted, candidates: entered.candidates.length } })
  results.assert('keyboard-enter-stage', headerFocused && !!picker && picker.hasBox && entered.mounted === true && entered.candidates.length === 1, {
    expected: '键盘路径：header 入口 Enter → picker → Space 勾选 → Enter 确认 → 进入舞台（1 候场）',
    actual: { headerFocused, pickerBoxes: picker && picker.boxes, confirmLabel, mounted: entered.mounted, candidates: entered.candidates.length }, category: 'P2-1',
  })
  await results.shot(page, 'p2-a11y-01-stage.png', SHOTS)

  /* ============ 2. ARIA 角色 / 标签 / 状态点 ============ */
  await ensureStage(page, 3)
  const info = await focusInfo()
  results.step('aria-structure', info)
  await results.shot(page, 'p2-a11y-02-stage-3candidates.png', SHOTS)

  results.assert('aria-stage-role', info.stage.role === 'group', {
    expected: '舞台容器 role=group（报告 §10.3）', actual: info.stage.role, category: 'P2-1',
    evidence: "src/client/stage-root.js:728 role: 'region'",
  })
  results.assert('aria-stage-label', /Onestep 会话舞台|Onestep stage/i.test(String(info.stage.label || '')), {
    expected: 'aria-label「Onestep 会话舞台」', actual: info.stage.label, category: 'P2-1', evidence: 'src/client/locale.js:56 与报告文案不一致',
  })
  results.assert('aria-focus-role', info.focus.role === 'region', {
    expected: '焦点窗 role=region（报告 §10.3）', actual: info.focus.role, category: 'P2-1', evidence: "src/client/stage-root.js:784 role: 'group'",
  })
  results.assert('aria-focus-label', /焦点会话|Focus session/i.test(String(info.focus.label || '')), {
    expected: 'aria-label「焦点会话：〈标题〉」', actual: info.focus.label, category: 'P2-1', evidence: 'src/client/stage-root.js:785 使用「焦点窗口: 标题」',
  })
  results.assert('aria-candidate-role', info.candidates.length > 0 && info.candidates.every((c) => c.role === 'group'), {
    expected: '候场窗 role=group（报告 §10.3）', actual: info.candidates.map((c) => c.role), category: 'P2-1', evidence: "src/client/stage-root.js:561-563 role: 'button' + tabIndex=0",
  })
  const candidateNumbers = info.candidates.map((c) => {
    const match = String(c.label || '').match(/候场会话\s*(\d+)|Candidate session\s*(\d+)/i)
    return match ? Number(match[1] || match[2]) : null
  })
  results.assert('aria-candidate-number', candidateNumbers.length > 0 && candidateNumbers.every((n, i) => n === i + 1), {
    expected: '候场卡 aria-label 含序号「候场会话 1/2/3：标题」', actual: { labels: info.candidates.map((c) => c.label), numbers: candidateNumbers }, category: 'P2-1', evidence: 'src/client/stage-root.js:563 label=标题+状态，无序号',
  })
  const statusTextExposed = info.candidates.every((c) => /空闲|运行中|等待|完成|出错|idle|running|pending|unread|error/i.test(String(c.label || '')))
  results.assert('aria-state-text-encoding', statusTextExposed, {
    expected: '状态「颜色 + 文字」双编码中的文字编码存在', actual: { labels: info.candidates.map((c) => c.label), statusTextExposed }, category: 'P2-1',
  })
  // 三态形状编码是 CSS 层实现（圆=运行/空闲、三角=待处理、方块=完成未读）；
  // 状态取决于当前候选卡真实状态，故以样式表规则 + 实际点半径双证据判定。
  const shapeEvidence = await page.evaluate(() => {
    const styleText = Array.from(document.querySelectorAll('style[data-onestep]')).map((node) => node.textContent || '').join('\n')
    return {
      pendingShape: /data-tone="pending"\][^}]*border-radius:0/.test(styleText),
      unreadShape: /data-tone="unread"\][^}]*border-radius:1px/.test(styleText),
    }
  })
  results.assert('aria-state-shape-encoding', shapeEvidence.pendingShape && shapeEvidence.unreadShape, {
    expected: '红/绿/琥珀三态用不同形状区分（圆点/三角/方块，报告 §10.4）',
    actual: { ...shapeEvidence, dotRadii: info.candidates.map((c) => c.dot && c.dot.radius) },
    category: 'P2-1',
  })
  results.assert('aria-state-dot-size', info.candidates.every((c) => c.dot && c.dot.cssW === '6px' && c.dot.cssH === '6px'), {
    expected: '状态点 6px 视觉 / 12px 命中（报告 §9.2）', actual: { dots: info.candidates.map((c) => c.dot), focusDot: info.focusDot }, category: 'P2-1',
    evidence: 'src/client/styles.js:25 .onestep-dot{width:8px;height:8px}，无 12px 命中扩展',
  })
  results.assert('aria-state-dot-label', info.candidates.every((c) => c.dot && (!!c.dot.aria || !!c.dot.title)) && !!info.focusDot && (!!info.focusDot.aria || !!info.focusDot.title), {
    expected: '每个状态点 aria-label 含状态文案（报告 §10.3）', actual: { candidateDots: info.candidates.map((c) => c.dot && { aria: c.dot.aria, title: c.dot.title }), focusDot: info.focusDot }, category: 'P2-1',
    evidence: '候选卡状态点无 aria/title（stage-root.js:584），仅焦点卡 dot 有 title（stage-root.js:795）',
  })
  results.assert('aria-control-hit-target', info.candidates.every((c) => c.control && c.control.cssW === '24px' && c.control.cssH === '24px') && info.focusControl.cssW === '24px' && info.focusControl.cssH === '24px', {
    expected: '控制点 24px 命中区（报告 §9.2/§10.3）', actual: { candidateControls: info.candidates.map((c) => c.control), focusControl: info.focusControl }, category: 'P2-1',
    note: '隐藏态 transform:scale(.9) 会使 getBoundingClientRect≈21.6px，故以 CSS 宽高为准；聚焦/悬停时 scale(1)=24px',
  })
  results.assert('aria-control-visual-size', info.candidates.every((c) => c.control && c.control.dotCssW === '12px') && info.focusControl.dotCssW === '12px', {
    expected: '控制点 12px 视觉（报告 §9.2）', actual: { candidateDotCssW: info.candidates.map((c) => c.control && c.control.dotCssW), focusDotCssW: info.focusControl.dotCssW }, category: 'P2-1',
  })
  results.assert('aria-splitter', !!info.splitter && info.splitter.role === 'separator' && info.splitter.tabIndex === 0 && Number(info.splitter.valuenow) > 0, {
    expected: '比例分隔条 role=separator + tabIndex=0 + aria-valuenow', actual: info.splitter, category: 'P2-1',
  })
  results.assert('aria-candidate-inert', info.candidates.every((c) => c.bodyInert && c.bodyInert.inertAttr), {
    expected: '候场内容容器 inert（报告 §10.2）', actual: info.candidates.map((c) => c.bodyInert), category: 'P2-1',
  })

  // 真实 Tab：候场 inert 内容不应被 Tab 进入
  const tabSeq = await tabSequence(page, 10)
  const inertHits = tabSeq.filter((item) => /onestep-card-body|an3WzG_body|onestep-thumb-content/.test(String(item.cls || '')))
  results.step('tab-sequence-sample', tabSeq)
  results.assert('aria-inert-tab-real', inertHits.length === 0, {
    expected: 'Tab 顺序不进入候场内容（inert）', actual: { inertHits: inertHits.length, sequence: tabSeq.map((s) => (s.insideFrame || 'x') + ':' + (s.cls || '').slice(0, 22)) }, category: 'P2-1',
  })

  /* ============ 3. DOM/Tab 顺序 ============ */
  const tabbables = await domTabbables(page)
  const stageTabbables = tabbables.filter((item) => item.dataOnestepStage === '1')
  const firstFocusIndex = stageTabbables.findIndex((item) => item.insideFrame === 'focus')
  const firstCandidateIndex = stageTabbables.findIndex((item) => item.insideFrame === 'candidate')
  results.step('tab-order', { stageTabbables: stageTabbables.slice(0, 24), firstFocusIndex, firstCandidateIndex })
  results.assert('tab-order-focus-first', firstFocusIndex >= 0 && firstCandidateIndex >= 0 && firstFocusIndex < firstCandidateIndex, {
    expected: 'Tab 顺序：焦点窗 chrome → 焦点窗内容 → 候场 chrome（报告 §10.2）',
    actual: { firstFocusIndex, firstCandidateIndex, orderSample: stageTabbables.slice(0, 10).map((t) => (t.insideFrame || 'splitter') + ':' + (t.cls || '').slice(0, 24)) },
    category: 'P2-1', evidence: 'stage-root.js:753-776 先渲染 candidates 再 focus frame → DOM 顺序与报告相反',
  })
  results.assert('tab-order-stage-not-tabbable', !tabbables.some((item) => item.tag === 'DIV' && item.cls === 'onestep-stage'), {
    expected: '舞台容器不进入 Tab 序列（tabindex=-1）', actual: { stageTabbable: tabbables.some((item) => item.tag === 'DIV' && item.cls === 'onestep-stage'), stageTabIndex: info.stage.tabIndex }, category: 'P2-1',
  })

  /* ============ 4. focus-visible / 控制点键盘 ============ */
  const candidateControl = await (async () => {
    // 候场窗 role=group（不直接可聚焦），键盘路径：标题按钮（提升）→ 下一个 Tab = 关闭控制点。
    const focused = await page.evaluate(() => {
      const frameEl = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="candidate"]')
      if (!frameEl) return null
      const titleButton = frameEl.querySelector('.onestep-title-btn')
      if (!titleButton) return null
      titleButton.focus()
      return document.activeElement === titleButton
    })
    await page.keyboard.press('Tab')
    await sleep(200)
    const style = await page.evaluate(() => {
      const el = document.activeElement
      if (!el) return null
      const cs = getComputedStyle(el)
      return { cls: String(el.className), focusVisible: el.matches(':focus-visible'), opacity: cs.opacity, boxShadow: cs.boxShadow, background: cs.backgroundColor, pointerEvents: cs.pointerEvents, frame: el.closest('.onestep-frame')?.getAttribute('data-mode') || null }
    })
    return { focused, style }
  })()
  results.step('candidate-control-focus', candidateControl)
  results.assert('focus-visible-candidate-control', !!candidateControl.style && candidateControl.style.focusVisible === true && candidateControl.style.opacity === '1' && /rgb\(/.test(String(candidateControl.style.boxShadow)), {
    expected: '候选卡控制点键盘聚焦时显示 + focus-visible 明显（报告 §10.3/§10.4）', actual: candidateControl.style, category: 'P2-1',
  })
  await results.shot(page, 'p2-a11y-03-candidate-control-focus.png', SHOTS)

  const focusControl = await (async () => {
    const prepared = await page.evaluate(() => {
      const focus = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
      if (!focus) return null
      const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      const list = Array.from(focus.querySelectorAll(selector)).filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      })
      const control = focus.querySelector('.onestep-control')
      const index = list.indexOf(control)
      if (index <= 0) return null
      list[index - 1].focus()
      return { prevCls: String(list[index - 1].className).slice(0, 50) }
    })
    await page.keyboard.press('Tab')
    await sleep(200)
    const style = await page.evaluate(() => {
      const el = document.activeElement
      if (!el) return null
      const cs = getComputedStyle(el)
      return { cls: String(el.className), focusVisible: el.matches(':focus-visible'), opacity: cs.opacity, boxShadow: cs.boxShadow, background: cs.backgroundColor, frame: el.closest('.onestep-frame')?.getAttribute('data-mode') || null }
    })
    return { prepared, style }
  })()
  results.step('focus-control-focus', focusControl)
  results.assert('focus-visible-focus-control', !!focusControl.style && focusControl.style.focusVisible === true && focusControl.style.opacity === '1' && /rgb\(/.test(String(focusControl.style.boxShadow)), {
    expected: '焦点窗控制点键盘聚焦时显示 + focus-visible 明显', actual: focusControl.style, category: 'P2-1',
  })

  const controlEnter = await (async () => {
    await page.evaluate(() => {
      const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="candidate"] .onestep-control')
      if (el) el.focus()
    })
    const before = await snapshot(page)
    await page.keyboard.press('Enter')
    await sleep(900)
    const after = await snapshot(page)
    return { candidatesBefore: before.candidates.length, candidatesAfter: after.candidates.length, focusSame: before.focusId === after.focusId }
  })()
  results.step('candidate-control-enter', controlEnter)
  results.assert('keyboard-candidate-control-close', controlEnter.candidatesAfter === controlEnter.candidatesBefore - 1 && controlEnter.focusSame, {
    expected: '候选卡控制点 Enter 关闭该候场且不提升', actual: controlEnter, category: 'P2-1',
  })

  /* ============ 5. 对比度（明暗双主题） ============ */
  await setTheme(page, 'light')
  const lightContrast = {
    candidateTitle: await measureContrast(page, C.candidate + ' .onestep-title'),
    candidateMeta: await measureContrast(page, C.candidate + ' .onestep-sub'),
    focusTitle: await measureContrast(page, C.focus + ' .onestep-title'),
    focusMeta: await measureContrast(page, C.focus + ' .onestep-sub'),
  }
  await results.shot(page, 'p2-a11y-04-theme-light.png', SHOTS)
  await setTheme(page, 'dark')
  const darkContrast = {
    candidateTitle: await measureContrast(page, C.candidate + ' .onestep-title'),
    candidateMeta: await measureContrast(page, C.candidate + ' .onestep-sub'),
    focusTitle: await measureContrast(page, C.focus + ' .onestep-title'),
    focusMeta: await measureContrast(page, C.focus + ' .onestep-sub'),
  }
  await results.shot(page, 'p2-a11y-05-theme-dark.png', SHOTS)
  await setTheme(page, 'light')
  results.step('contrast', { lightContrast, darkContrast, lightMin: round2(minContrast(lightContrast)), darkMin: round2(minContrast(darkContrast)) })
  results.assert('contrast-light-aa', minContrast(lightContrast) >= 4.5, {
    expected: '浅色主题标题/元信息对比度 ≥4.5:1（WCAG AA）', actual: { min: round2(minContrast(lightContrast)), samples: mapRatio(lightContrast) }, category: 'P2-1',
  })
  results.assert('contrast-dark-aa', minContrast(darkContrast) >= 4.5, {
    expected: '深色主题标题/元信息对比度 ≥4.5:1', actual: { min: round2(minContrast(darkContrast)), samples: mapRatio(darkContrast) }, category: 'P2-1',
  })

  /* ============ 6. 尺寸契约（P2-1） ============ */
  const visual = await focusInfo()
  results.assert('visual-focus-radius-16', String(visual.focus.radius) === '16px', {
    expected: '焦点窗圆角 16px（报告 §9.2；P2-1）', actual: visual.focus.radius, category: 'P2-1', evidence: 'styles.js:15 .onestep-frame{border-radius:12px}',
  })
  results.assert('visual-title-weight-500', visual.focus.titleWeight === '500' && visual.candidates.every((c) => c.titleWeight === '500'), {
    expected: '标题字重 500（报告 §9.2；P2-1）', actual: { focus: visual.focus.titleWeight, candidates: visual.candidates.map((c) => c.titleWeight), sizes: { focus: visual.focus.titleSize, candidates: visual.candidates.map((c) => c.titleSize) } }, category: 'P2-1', evidence: 'styles.js:16-24 标题 font-weight:600',
  })

  /* ============ 7. 焦点转移 ============ */
  const pollActive = async (timeout, predicate) => {
    const timeline = []
    const started = Date.now()
    for (;;) {
      const active = await activeDesc()
      const textboxes = (await composerStats(page)).textboxesVisible
      timeline.push({ t: Date.now() - started, active: active.tag + (active.role ? '/' + active.role : '') + (active.frame ? '@' + active.frame : ''), textboxes })
      if (predicate(active, textboxes) || Date.now() - started > timeout) return { matched: predicate(active, textboxes), timeline, final: active }
      await sleep(200)
    }
  }
  await ensureIdleStage(2)
  const kbPromote = await (async () => {
    const before = await snapshot(page)
    await page.evaluate(() => document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="candidate"]').focus())
    await page.keyboard.press('Enter')
    await sleep(300)
    const after = await snapshot(page)
    const poll = await pollActive(2500, (active) => active.role === 'textbox' && active.frame === 'focus')
    return { beforeFocus: String(before.focusId).slice(0, 10), afterFocus: String(after.focusId).slice(0, 10), focusChanged: after.focusId !== before.focusId, poll }
  })()
  results.step('focus-transfer-keyboard-promote', kbPromote)
  results.assert('focus-transfer-keyboard-promote', kbPromote.focusChanged && kbPromote.poll.matched, {
    expected: '键盘提升后焦点移到新焦点窗 composer（报告 §10.2）', actual: kbPromote, category: 'P2-1',
    evidence: 'stage-root.js/index.js 无焦点转移代码（全库仅 quick 输入 focus()）；实测落到 BODY 且 2.5s 内不恢复',
  })

  const mousePromote = await (async () => {
    const before = await snapshot(page)
    const rect = await page.evaluate(() => {
      const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="candidate"]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    if (!rect) return { skipped: true }
    await page.mouse.click(rect.x, rect.y)
    await sleep(300)
    const after = await snapshot(page)
    const poll = await pollActive(2500, (active) => active.frame === 'focus')
    return { beforeFocus: String(before.focusId).slice(0, 10), afterFocus: String(after.focusId).slice(0, 10), focusChanged: after.focusId !== before.focusId, poll }
  })()
  results.step('focus-transfer-mouse-promote', mousePromote)
  results.assert('focus-transfer-mouse-promote', mousePromote.focusChanged === true && mousePromote.poll.matched === true, {
    expected: '鼠标提升后焦点进入新焦点窗（报告 §10.2 偏好窗口容器、不抢输入）', actual: mousePromote, category: 'P2-1',
    note: '实测焦点落在新焦点窗 composer（而非报告要求的窗口容器）——记录为轻微偏差，见 p2-baseline 缺口清单',
  })

  const closeFocus = await (async () => {
    const before = await snapshot(page)
    await page.evaluate(() => window.__ONESTEP__.actions.closeFocus())
    await sleep(300)
    const after = await snapshot(page)
    const poll = await pollActive(2500, (active) => active.role === 'textbox' && active.frame === 'focus')
    return { beforeFocus: String(before.focusId).slice(0, 10), afterFocus: String(after.focusId).slice(0, 10), mounted: after.mounted, changed: after.focusId !== before.focusId, poll }
  })()
  results.step('focus-transfer-close-focus', closeFocus)
  results.assert('focus-transfer-close-focus', closeFocus.changed && closeFocus.poll.matched, {
    expected: '移出焦点窗后焦点移到新焦点窗 composer（报告 §10.2）', actual: closeFocus, category: 'P2-1',
  })

  const exitFocus = await (async () => {
    await blurActive(page)
    const before = await domStats(page)
    await pressChord(page, { ctrl: true, alt: true, key: 's' })
    await sleep(400)
    const after = await snapshot(page)
    const poll = await pollActive(5000, (active, textboxes) => active.role === 'textbox' && active.insideStage === false && textboxes >= 1)
    const dom = await domStats(page)
    return { beforeStage: before.stage, mounted: after.mounted, dom: { stage: dom.stage, editableComposers: dom.editableComposers, textboxes: poll.final && poll.final.role }, poll }
  })()
  results.step('focus-transfer-exit', exitFocus)
  results.assert('focus-transfer-exit', exitFocus.mounted === false && exitFocus.dom.stage === 0 && exitFocus.poll.matched === true, {
    expected: '退出舞台后焦点回到官方会话 composer（报告 §10.2）', actual: exitFocus, category: 'P2-1',
    note: '若先 blur 再按键退出，实测焦点停在 BODY（官方 composer 已挂载但未获焦）；只有在焦点本就在 composer 时退出才保留焦点',
  })

  /* ============ 8. aria-live ============ */
  await ensureStage(page, 1)
  const liveRegion = await page.evaluate(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    const live = stage && stage.querySelector('[aria-live]')
    return { exists: !!live, ariaLive: live && live.getAttribute('aria-live'), role: live && live.getAttribute('role'), text: live && live.textContent }
  })
  results.assert('aria-live-region', liveRegion.exists && liveRegion.ariaLive === 'polite', {
    expected: '舞台内 aria-live=polite 播报区（报告 §10.3）', actual: liveRegion, category: 'P2-1',
  })
  const candId = (await snapshot(page)).candidates[0]
  const livePending = await page.evaluate(async (id) => {
    window.__ONESTEP__.actions.demoFeedback({ bubbleSessionId: id, kind: 'approval' })
    await new Promise((r) => setTimeout(r, 600))
    const stage = document.querySelector('[data-onestep-stage]')
    const live = stage && stage.querySelector('[aria-live]')
    return { text: live && live.textContent, announcement: window.__ONESTEP__.actions.snapshot().feedback.announcement }
  }, candId)
  const liveDedup = await page.evaluate(async (id) => {
    const before = window.__ONESTEP__.actions.snapshot().feedback.announcement
    window.__ONESTEP__.actions.demoFeedback({ bubbleSessionId: id, kind: 'approval' })
    await new Promise((r) => setTimeout(r, 600))
    const after = window.__ONESTEP__.actions.snapshot().feedback.announcement
    return { beforeAt: before && before.at, afterAt: after && after.at, sameAt: before && after ? before.at === after.at : false }
  }, candId)
  results.step('aria-live-pending', { livePending, liveDedup })
  results.assert('aria-live-pending-once', !!livePending.text && /需要你处理|needs you/i.test(livePending.text) && liveDedup.sameAt === true, {
    expected: '待处理事件 aria-live 播报一次（同 key 不重复）', actual: { text: livePending.text, dedupSameAt: liveDedup.sameAt }, category: 'P2-1',
  })
  const liveCompletion = await page.evaluate(async (id) => {
    const before = window.__ONESTEP__.actions.snapshot().feedback.announcement
    window.__ONESTEP__.actions.demoFeedback({ flashSessionId: id })
    await new Promise((r) => setTimeout(r, 700))
    const stage = document.querySelector('[data-onestep-stage]')
    const live = stage && stage.querySelector('[aria-live]')
    const after = window.__ONESTEP__.actions.snapshot().feedback.announcement
    return { beforeText: before && before.text, afterText: after && after.text, liveText: live && live.textContent, changed: !!(before && after && before.at !== after.at) }
  }, candId)
  results.step('aria-live-completion', liveCompletion)
  // 裁决（P2-1，Lead 2026-11-09）：完成未读保留 aria-live 播报（每 episode 一次、同 key 去重），
  // 理由：屏幕阅读器用户无法感知纯视觉徽标/闪烁；产品报告 §10.3「完成只用徽标」与开发文档 §7.5
  // 冲突时以「可感知」优先，并已同步产品报告 §10.3。
  results.assert('aria-live-completion-once', liveCompletion.changed === true, {
    expected: '完成未读 aria-live 播报一次（同 episode 去重；报告 §10.3 已按可感知原则修订）',
    actual: liveCompletion, category: 'P2-1',
  })
  const kindRaw = await page.evaluate(async (id) => {
    window.__ONESTEP__.actions.demoFeedback({ bubbleSessionId: id, kind: 'question' })
    await new Promise((r) => setTimeout(r, 600))
    return window.__ONESTEP__.actions.snapshot().feedback.announcement
  }, candId)
  results.assert('aria-live-kind-i18n', !!kindRaw && !/approval|question|plan\b/.test(String(kindRaw.text)), {
    expected: '播报中的待处理类型是本地化文案（不是原始 kind=approval）', actual: kindRaw, category: 'P2-1', evidence: 'stage-root.js:247 插值 {kind: bubble.kind} 直接输出原始枚举',
  })

  /* ============ 9. 快捷键矩阵（实现 vs 文档 §10.1） ============ */
  await ensureStage(page, 3)
  const chordMatrix = []
  const chord = async (label, mapping, expect) => {
    await blurActive(page)
    const before = await snapshot(page)
    const quickBefore = await page.evaluate(() => document.querySelector('.onestep-quick')?.getAttribute('data-open') || null)
    await pressChord(page, mapping)
    await sleep(900)
    const after = await snapshot(page)
    const quickAfter = await page.evaluate(() => document.querySelector('.onestep-quick')?.getAttribute('data-open') || null)
    const logs = (await probeLog(page, 120)).filter((entry) => /promote|focus\.close|candidate\.close|quick|undo/.test(entry.event)).slice(-4).map((entry) => entry.event)
    const row = {
      label,
      expect,
      mapping,
      focusChanged: after.focusId !== before.focusId,
      focusBefore: String(before.focusId).slice(0, 10),
      focusAfter: String(after.focusId).slice(0, 10),
      candidatesBefore: before.candidates.length,
      candidatesAfter: after.candidates.length,
      mountedBefore: before.mounted,
      mountedAfter: after.mounted,
      quickBefore,
      quickAfter,
      logs,
    }
    chordMatrix.push(row)
    return row
  }

  const implPromote = await chord('Ctrl+Alt+2 → 提升第 2 窗', { ctrl: true, alt: true, key: '2' }, 'impl')
  const docPromote = await chord('Alt+2（文档）→ 提升', { alt: true, key: '2' }, 'doc')
  const docCycle = await chord('Ctrl+Alt+→（文档）→ 循环切换', { ctrl: true, alt: true, key: 'ArrowRight' }, 'doc')
  const implQuick = await chord('Ctrl+Alt+Shift+N → 快速新建', { ctrl: true, alt: true, shift: true, key: 'n' }, 'impl')
  await page.keyboard.press('Escape')
  await sleep(400)
  const docQuick = await chord('Alt+N（文档）→ 快速新建', { alt: true, key: 'n' }, 'doc')
  const docClose = await chord('Alt+W（文档）→ 移出焦点', { alt: true, key: 'w' }, 'doc')
  const implClose = await chord('Ctrl+Alt+Shift+W → 移出焦点', { ctrl: true, alt: true, shift: true, key: 'w' }, 'impl')

  await blurActive(page)
  await page.evaluate(() => document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="candidate"]').focus())
  await page.keyboard.press('Delete')
  await sleep(800)
  const afterDelete = await snapshot(page)
  const docUndo = await chord('Ctrl+Z（文档）→ 撤销', { ctrl: true, key: 'z' }, 'doc')
  const implUndo = await chord('Ctrl+Alt+Z → 撤销', { ctrl: true, alt: true, key: 'z' }, 'impl')

  // 输入抑制：需焦点窗 composer 可编辑（用空白会话归一化，避免只读/子代理会话干扰）
  await ensureIdleStage(1)
  const composerRect = await page.evaluate(() => {
    const focus = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
    const input = focus && focus.querySelector('[role="textbox"]')
    if (!input) return null
    const r = input.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) }
  })
  if (composerRect) {
    await page.mouse.click(composerRect.x, composerRect.y)
    await sleep(500)
  }
  const composerBefore = await snapshot(page)
  const composerActive = await activeDesc()
  await pressChord(page, { ctrl: true, alt: true, key: '2' })
  await sleep(800)
  const composerAfter = await snapshot(page)
  results.step('shortcut-in-composer', { composerRect, composerActive, focusBefore: String(composerBefore.focusId).slice(0, 10), focusAfter: String(composerAfter.focusId).slice(0, 10) })

  await blurActive(page)
  const beforeDocToggle = await snapshot(page)
  await pressChord(page, { alt: true, key: 's' })
  await sleep(700)
  const afterDocToggle = await snapshot(page)
  await pressChord(page, { ctrl: true, alt: true, key: 's' })
  await sleep(1300)
  const afterImplToggle = await snapshot(page)
  const toast = await page.evaluate(() => {
    const el = document.querySelector('.onestep-toast')
    return el ? { text: el.textContent.trim().slice(0, 80), role: el.getAttribute('role') } : null
  })
  results.step('shortcut-toggle-stage', { beforeDocToggle: beforeDocToggle.mounted, afterDocToggle: afterDocToggle.mounted, afterImplToggle: afterImplToggle.mounted, toast })
  results.step('shortcut-matrix', chordMatrix)

  results.assert('shortcut-promote-impl', implPromote.focusChanged === true, {
    expected: '实现键 Ctrl+Alt+2 提升第 2 个候场', actual: { focusBefore: implPromote.focusBefore, focusAfter: implPromote.focusAfter, logs: implPromote.logs }, category: 'P2-1',
  })
  results.assert('shortcut-promote-doc', docPromote.focusChanged === false, {
    expected: '文档旧键 Alt+2 不生效：键位口径已裁决为实现 Ctrl+Alt 系（开发文档 §7.1/产品报告 §10.1 已同步）', actual: { focusBefore: docPromote.focusBefore, focusAfter: docPromote.focusAfter, note: '旧 Alt 系在 desktop 菜单/输入法下有冲突面，P1 实测后改为 Ctrl+Alt 系' }, category: 'P2-1',
  })
  results.assert('shortcut-cycle-doc', docCycle.focusChanged === true, {
    expected: '文档键 Ctrl+Alt+←/→ 在窗口间循环（报告 §10.1）', actual: { focusBefore: docCycle.focusBefore, focusAfter: docCycle.focusAfter, registeredIds: shortcutLogs.filter((id) => /cycle/i.test(id)) }, category: 'P2-1',
  })
  results.assert('shortcut-quick-impl', implQuick.quickAfter === '1', {
    expected: '实现键 Ctrl+Alt+Shift+N 唤起快速新建条', actual: { quickBefore: implQuick.quickBefore, quickAfter: implQuick.quickAfter }, category: 'P2-1',
  })
  results.assert('shortcut-quick-doc', docQuick.quickAfter === '0', {
    expected: '文档旧键 Alt+N 不生效（键位以实现 Ctrl+Alt+Shift+N 为准）', actual: { quickBefore: docQuick.quickBefore, quickAfter: docQuick.quickAfter }, category: 'P2-1',
  })
  results.assert('shortcut-close-focus-impl', implClose.focusChanged === true && implClose.candidatesAfter === implClose.candidatesBefore - 1, {
    expected: '实现键 Ctrl+Alt+Shift+W 移出焦点（提升下一个候场）', actual: { focusBefore: implClose.focusBefore, focusAfter: implClose.focusAfter, candidatesBefore: implClose.candidatesBefore, candidatesAfter: implClose.candidatesAfter }, category: 'P2-1',
  })
  results.assert('shortcut-close-focus-doc', docClose.focusChanged === false && docClose.candidatesAfter === docClose.candidatesBefore, {
    expected: '文档旧键 Alt+W 不生效（键位以实现 Ctrl+Alt+Shift+W 为准）', actual: { focusBefore: docClose.focusBefore, focusAfter: docClose.focusAfter, candidatesBefore: docClose.candidatesBefore, candidatesAfter: docClose.candidatesAfter }, category: 'P2-1',
  })
  results.assert('shortcut-undo-impl', implUndo.candidatesAfter === afterDelete.candidates.length + 1, {
    expected: '实现键 Ctrl+Alt+Z 撤销最近一次移出/淘汰（5s 内）', actual: { candidatesAfterDelete: afterDelete.candidates.length, afterDocUndo: docUndo.candidatesAfter, afterImplUndo: implUndo.candidatesAfter }, category: 'P2-1',
  })
  results.assert('shortcut-undo-doc', docUndo.candidatesAfter === afterDelete.candidates.length, {
    expected: '文档旧键 Ctrl+Z 不生效（键位以实现 Ctrl+Alt+Z 为准）', actual: { candidatesAfterDelete: afterDelete.candidates.length, afterDocUndo: docUndo.candidatesAfter, afterImplUndo: implUndo.candidatesAfter }, category: 'P2-1',
  })
  results.assert('shortcut-input-suppression', !!composerRect && composerActive.role === 'textbox' && String(composerAfter.focusId) === String(composerBefore.focusId), {
    expected: '文本输入内不拦截快捷键（报告 §10.1「文本输入内不拦截」）：composer 聚焦时 Ctrl+Alt+2 不应提升', actual: { composerRect, composerActive, focusBefore: String(composerBefore.focusId).slice(0, 10), focusAfter: String(composerAfter.focusId).slice(0, 10) }, category: 'P2-1',
  })
  results.assert('shortcut-toggle-stage-doc', afterDocToggle.mounted === true, {
    expected: '文档旧键 Alt+S 不生效（键位以实现 Ctrl+Alt+S 为准）', actual: { mountedAfterAltS: afterDocToggle.mounted }, category: 'P2-1',
  })
  results.assert('shortcut-toggle-stage-impl', afterImplToggle.mounted === false, {
    expected: '实现键 Ctrl+Alt+S 在舞台模式退出舞台', actual: { mountedAfterCtrlAltS: afterImplToggle.mounted }, category: 'P2-1',
  })
  results.assert('toast-role-status', !!toast && toast.role === 'status', {
    expected: '退出 toast role=status（报告 §10.3）', actual: toast, category: 'P2-1',
  })

  /* ============ 10. Esc 两段式（快速新建条） ============ */
  await ensureStage(page, 1)
  await blurActive(page)
  await pressChord(page, { ctrl: true, alt: true, shift: true, key: 'n' })
  await sleep(500)
  await page.keyboard.type('draft-x')
  await sleep(300)
  const quickTyped = await page.evaluate(() => ({ open: document.querySelector('.onestep-quick')?.getAttribute('data-open') || null, value: document.querySelector('.onestep-quick .onestep-input')?.value ?? null }))
  await page.keyboard.press('Escape')
  await sleep(400)
  const quickEsc1 = await page.evaluate(() => ({ open: document.querySelector('.onestep-quick')?.getAttribute('data-open') || null, value: document.querySelector('.onestep-quick .onestep-input')?.value ?? null }))
  await page.keyboard.press('Escape')
  await sleep(400)
  const quickEsc2 = await page.evaluate(() => ({ open: document.querySelector('.onestep-quick')?.getAttribute('data-open') || null }))
  results.step('quick-esc-two-stage', { quickTyped, quickEsc1, quickEsc2 })
  results.assert('quick-esc-two-stage', quickTyped.open === '1' && quickEsc1.open === '1' && quickEsc1.value === '' && quickEsc2.open === '0', {
    expected: '非空文本第一次 Esc 清空、第二次收起（报告 §7.8）', actual: { quickTyped, quickEsc1, quickEsc2 }, category: 'P2-1',
  })

  /* ============ 11. reduced motion ============ */
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await sleep(500)
  const reduced = await page.evaluate(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    const frame = stage && stage.querySelector('.onestep-frame[data-mode="candidate"]')
    const dot = stage && stage.querySelector('.onestep-dot')
    const quickInner = stage && stage.querySelector('.onestep-quick-inner')
    const focus = stage && stage.querySelector('.onestep-frame[data-mode="focus"]')
    const cs = (el) => (el ? getComputedStyle(el) : null)
    const stageCs = stage ? getComputedStyle(stage) : null
    return {
      media: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      vars: stageCs ? { fast: stageCs.getPropertyValue('--onestep-fast').trim(), base: stageCs.getPropertyValue('--onestep-base').trim(), slow: stageCs.getPropertyValue('--onestep-slow').trim() } : null,
      frameTransition: cs(frame) ? cs(frame).transitionDuration : null,
      focusTransition: cs(focus) ? cs(focus).transitionDuration : null,
      dotAnimation: cs(dot) ? { name: cs(dot).animationName, duration: cs(dot).animationDuration } : null,
      quickTransition: cs(quickInner) ? cs(quickInner).transitionDuration : null,
    }
  })
  const candId2 = (await snapshot(page)).candidates[0]
  const reducedFlash = await page.evaluate(async (id) => {
    window.__ONESTEP__.actions.demoFeedback({ flashSessionId: id })
    await new Promise((r) => setTimeout(r, 400))
    const flashEl = document.querySelector('[data-onestep-stage] .onestep-frame[data-flash="1"]')
    return flashEl ? { animationName: getComputedStyle(flashEl).animationName, borderColor: getComputedStyle(flashEl).borderColor } : null
  }, candId2)
  results.step('reduced-motion', { reduced, reducedFlash })
  results.assert('reduced-motion', reduced.media === true && ['0ms', '0s'].includes(String(reduced.vars && reduced.vars.base)) && String(reduced.frameTransition).split(', ').every((part) => part === '0s') && reduced.dotAnimation !== null && reduced.dotAnimation.name === 'none' && !!reducedFlash && reducedFlash.animationName === 'none', {
    expected: 'prefers-reduced-motion: reduce 时关闭脉冲/缩放/滑出位移（报告 §9.3/§10.6）', actual: { reduced, reducedFlash }, category: 'P2-1',
  })
  await results.shot(page, 'p2-a11y-06-reduced-motion.png', SHOTS)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await sleep(300)

  /* ============ 12. 清理与错误 ============ */
  await leaveStage(page)
  await resetStageStorage(page)
  results.assert('env.no-page-errors', app.handles.pageErrors.length === 0, {
    expected: '整个 a11y/键盘套件无页面异常', actual: { pageErrors: app.handles.pageErrors, consoleErrors: app.handles.consoleErrors.slice(0, 5) }, category: 'env',
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
