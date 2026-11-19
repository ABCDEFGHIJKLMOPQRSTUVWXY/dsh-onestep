/**
 * P1 review 修复验收：舞台定位 / 候场卡与关闭控制点 / 卡片点击 / quickSignal / 拖入非焦点区。
 * 产物：artifacts/review/verify/verify-fix.json + *.png
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const require = createRequire(path.join(ROOT, 'tools', 'pw') + path.sep)
const { chromium } = require('playwright-core')
const OUT = path.join(ROOT, 'artifacts', 'review', 'verify')
fs.mkdirSync(OUT, { recursive: true })
const url = fs.readFileSync(path.join(ROOT, 'artifacts', 'review', 'server-url.txt'), 'utf8').trim().split('#')[0]
const result = { startedAt: new Date().toISOString(), steps: [], screenshots: [], errors: [], pass: {} }
const step = (name, data) => {
  result.steps.push({ name, at: new Date().toISOString(), data })
  console.log('[verify] ' + name + ' ' + JSON.stringify(data).slice(0, 900))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, name) })
  result.screenshots.push(name)
}

/** 页面内：宿主矩形（与 stage-root measureHostRect 同算法）+ 关键几何。 */
function pageGeometry() {
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const stage = document.querySelector('[data-onestep-stage]')
  const hostM = (() => {
    if (!stage) return null
    let node = stage.parentElement
    while (node && node !== document.body) {
      const cs = getComputedStyle(node)
      const r = node.getBoundingClientRect()
      if (cs.display !== 'contents' && r.width > 0 && r.height > 0) return { el: node, rect: rect(node), cls: String(node.className || '').slice(0, 60) }
      node = node.parentElement
    }
    return null
  })()
  const row = document.querySelector('[data-row-key^="session:"]')
  let sidebar = null
  let node = row
  while (node && node.parentElement && node.parentElement !== document.body) {
    const r = node.getBoundingClientRect()
    if (r.width >= 180 && r.width <= 420 && r.height > 300 && r.x <= 8) { sidebar = node; break }
    node = node.parentElement
  }
  const sidebarRect = rect(sidebar)
  const sidebarHit = sidebarRect ? document.elementFromPoint(sidebarRect.x + sidebarRect.w / 2, sidebarRect.y + 120) : null
  const cards = stage ? Array.from(stage.querySelectorAll('.onestep-frame[data-mode="candidate"]')) : []
  const focus = stage ? stage.querySelector('.onestep-frame[data-mode="focus"]') : null
  const controlInfo = (el) => {
    if (!el) return null
    const c = el.querySelector('.onestep-control')
    if (!c) return null
    const cs = getComputedStyle(c)
    return {
      rect: rect(c),
      opacity: cs.opacity,
      visible: cs.opacity !== '0' && cs.pointerEvents !== 'none',
      position: cs.position,
      dot: (() => { const d = c.querySelector('.onestep-control-dot'); if (!d) return null; const r = d.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), bg: getComputedStyle(d).backgroundColor } })(),
    }
  }
  return {
    viewport: { w: innerWidth, h: innerHeight },
    officialMain: rect(document.querySelector('main')),
    host: hostM ? { cls: hostM.cls, rect: hostM.rect } : null,
    stage: rect(stage),
    stageOverlapsSidebar: sidebarRect && rect(stage) ? !(rect(stage).x >= sidebarRect.x + sidebarRect.w) : null,
    sidebar: sidebarRect,
    sidebarHit: sidebarHit ? { tag: sidebarHit.tagName, cls: String(sidebarHit.className || '').slice(0, 60), inStage: !!sidebarHit.closest('[data-onestep-stage]') } : null,
    railSide: stage ? stage.getAttribute('data-rail-side') : null,
    candidates: cards.map((el) => {
      const r = rect(el)
      const cs = getComputedStyle(el)
      return { rect: r, borderRadius: cs.borderRadius, background: cs.backgroundColor, shadow: cs.boxShadow, title: (el.querySelector('.onestep-title') || {}).textContent || null, control: controlInfo(el) }
    }),
    focus: focus ? { rect: rect(focus), control: controlInfo(focus), chrome: rect(focus.querySelector('.onestep-chrome')), actionButtons: Array.from(focus.querySelectorAll('.onestep-chrome .onestep-btn')).map((b) => ({ text: b.textContent, title: b.title, rect: rect(b) })) } : null,
  }
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
  const page = await context.newPage()
  page.on('pageerror', (e) => result.errors.push(String(e).slice(0, 300)))
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('[role="textbox"], [data-placeholder]', { timeout: 60000 })
  const cont = page.getByRole('button', { name: '继续' })
  if ((await cont.count()) > 0) await cont.first().click().catch(() => {})
  await page.waitForFunction(() => !!window.__ONESTEP__, null, { timeout: 30000 })
  await sleep(1500)
  await page.evaluate(() => window.__ONESTEP__.actions.exitStage())
  await sleep(600)

  const normal = await page.evaluate(pageGeometry)
  step('normal-geometry', { officialMain: normal.officialMain, sidebar: normal.sidebar, stage: normal.stage })
  await shot(page, '01-normal.png')

  const ids = await page.evaluate(() => {
    const rows = window.__ONESTEP__.actions.listSessions()
    return Object.keys(rows).filter((id) => !rows[id].blank)
  })
  // 焦点 1 + 候场 3
  await page.evaluate((picked) => window.__ONESTEP__.actions.enterStage(picked), ids.slice(0, 4))
  await sleep(1800)
  const entered = await page.evaluate(pageGeometry)
  step('stage-geometry', {
    stage: entered.stage,
    host: entered.host,
    officialMain: entered.officialMain,
    sidebar: entered.sidebar,
    sidebarHit: entered.sidebarHit,
    candidates: entered.candidates.map((c) => c.rect),
    focus: entered.focus && entered.focus.rect,
  })
  result.pass.stageFitsHost = !!entered.stage && !!entered.host && Math.abs(entered.stage.x - entered.host.rect.x) <= 1 && Math.abs(entered.stage.w - entered.host.rect.w) <= 1
  result.pass.sidebarNotCovered = !!entered.sidebarHit && entered.sidebarHit.inStage === false
  result.pass.cardSize = entered.candidates.length === 3 && entered.candidates.every((c) => c.rect.w >= 200 && c.rect.w <= 240 && Math.abs(c.rect.w / c.rect.h - Math.SQRT2) < 0.02)
  result.pass.cardRadius = entered.candidates.every((c) => c.borderRadius.indexOf('12px') !== -1)
  result.pass.controlAtBottomRight = entered.candidates.every((c) => {
    if (!c.control) return false
    return c.control.rect.x >= c.rect.x + c.rect.w - 40 && c.control.rect.y >= c.rect.y + c.rect.h - 40
  })
  result.pass.controlHiddenByDefault = entered.candidates.every((c) => c.control && c.control.opacity === '0')
  await shot(page, '02-stage-3cards.png')

  // 候场卡 hover → 控制点显示
  if (entered.candidates[0]) {
    const c = entered.candidates[0].rect
    await page.mouse.move(c.x + c.w / 2, c.y + c.h / 2)
    await sleep(350)
    const hover = await page.evaluate(() => {
      const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="candidate"]')
      const ctl = el.querySelector('.onestep-control')
      const dot = ctl.querySelector('.onestep-control-dot')
      return { opacity: getComputedStyle(ctl).opacity, dot: dot ? { w: dot.getBoundingClientRect().width, h: dot.getBoundingClientRect().height, bg: getComputedStyle(dot).backgroundColor } : null }
    })
    result.pass.candidateHoverShowsControl = hover.opacity === '1'
    step('candidate-hover-control', hover)
    await shot(page, '03-candidate-hover.png')
  }

  // 候场卡点击提升（live 模式）
  const focusBefore = await page.evaluate(() => window.__ONESTEP__.actions.snapshot().focusId)
  const c0 = entered.candidates[1] ? entered.candidates[1].rect : entered.candidates[0].rect
  await page.mouse.click(c0.x + c0.w / 2, c0.y + c0.h / 2)
  await sleep(1200)
  const focusAfterLiveClick = await page.evaluate(() => window.__ONESTEP__.actions.snapshot().focusId)
  result.pass.liveCardClickPromotes = focusAfterLiveClick !== focusBefore
  step('live-card-click', { focusBefore, focusAfterLiveClick })

  // 焦点窗关闭控制点：中心 hover 不显示；右下角 88×88 hover 显示
  const focusRect = await page.evaluate(() => {
    const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  if (focusRect) {
    const readFocusCtl = () => page.evaluate(() => {
      const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
      const ctl = el && el.querySelector('.onestep-control')
      return ctl ? { opacity: getComputedStyle(ctl).opacity, dataShow: ctl.getAttribute('data-show') } : null
    })
    await page.mouse.move(focusRect.x + focusRect.w / 2, focusRect.y + focusRect.h / 2)
    await sleep(400)
    const centerHover = await readFocusCtl()
    await page.mouse.move(focusRect.x + focusRect.w - 20, focusRect.y + focusRect.h - 20)
    await sleep(500)
    const cornerHover = await readFocusCtl()
    await page.mouse.move(focusRect.x + focusRect.w / 2, focusRect.y + focusRect.h / 2)
    await sleep(150)
    const afterLeave150 = await readFocusCtl()
    await sleep(700)
    const afterLeave700 = await readFocusCtl()
    result.pass.focusControlCenterHidden = centerHover.opacity === '0'
    result.pass.focusControlCornerShown = cornerHover.opacity === '1'
    result.pass.focusControlHideDelayed = afterLeave150.opacity === '1' && afterLeave700.opacity === '0'
    step('focus-control-hover', { centerHover, cornerHover, afterLeave150, afterLeave700 })
    await shot(page, '04-focus-corner-hover.png')
  }

  // quickSignal 消费：requestQuickNew → 快速新建条打开
  await page.evaluate(() => window.__ONESTEP__.actions.requestQuickNew())
  await sleep(500)
  const quick = await page.evaluate(() => {
    const bar = document.querySelector('[data-onestep-stage] .onestep-quick')
    return { exists: !!bar, open: bar ? bar.getAttribute('data-open') : null }
  })
  result.pass.quickSignalOpensBar = quick.open === '1'
  step('quick-signal', quick)
  await shot(page, '05-quick-open.png')
  await page.evaluate(() => {
    const bar = document.querySelector('[data-onestep-stage] .onestep-quick')
    if (bar) bar.setAttribute('data-open', '0')
  })

  // card 模式：整卡点击提升
  await page.evaluate(() => window.__ONESTEP__.actions.setPreviewMode('card'))
  await sleep(900)
  const focusBeforeCard = await page.evaluate(() => window.__ONESTEP__.actions.snapshot().focusId)
  const cardTarget = await page.evaluate(() => {
    const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="candidate"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  if (cardTarget) {
    await page.mouse.click(cardTarget.x, cardTarget.y)
    await sleep(1200)
  }
  const focusAfterCard = await page.evaluate(() => window.__ONESTEP__.actions.snapshot().focusId)
  result.pass.compactCardClickPromotes = focusAfterCard !== focusBeforeCard
  step('compact-card-click', { focusBeforeCard, focusAfterCard })
  await shot(page, '06-compact-mode.png')
  await page.evaluate(() => window.__ONESTEP__.actions.setPreviewMode('live'))
  await sleep(600)

  // 退出舞台 → 普通模式；再从侧栏拖入「非焦点区」，验证进入舞台后左栏仍可见
  await page.evaluate(() => window.__ONESTEP__.actions.exitStage())
  await sleep(900)
  const dragSource = await page.evaluate(() => {
    let current = null
    try { current = (JSON.parse(localStorage.getItem('dsh.sessions.current') || '{}') || {}).sessionId || null } catch (_e) { current = null }
    const rows = Array.from(document.querySelectorAll('[data-row-key^="session:"]'))
    const el = rows.filter((r) => r.getAttribute('draggable') === 'true' && r.getAttribute('data-row-key') !== 'session:' + current)[0]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { key: el.getAttribute('data-row-key'), x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  if (dragSource) {
    await page.mouse.move(dragSource.x, dragSource.y)
    await page.mouse.down()
    await sleep(180)
    for (let i = 1; i <= 8; i += 1) {
      await page.mouse.move(dragSource.x + i * 18, dragSource.y + i * 3, { steps: 2 })
      await sleep(25)
    }
    const rail = await page.evaluate(() => {
      const el = document.querySelector('[data-onestep-drag-rail]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    await shot(page, '07-drag-hud.png')
    if (rail) {
      const from = { x: dragSource.x + 144, y: dragSource.y + 24 }
      for (let i = 1; i <= 12; i += 1) {
        await page.mouse.move(from.x + ((rail.x - from.x) * i) / 12, from.y + ((rail.y - from.y) * i) / 12, { steps: 2 })
        await sleep(25)
      }
      await sleep(200)
      await page.mouse.up()
      await sleep(1500)
      const afterDrag = await page.evaluate(pageGeometry)
      step('drag-rail-stage-geometry', { stage: afterDrag.stage, host: afterDrag.host, sidebarHit: afterDrag.sidebarHit, candidates: afterDrag.candidates.map((c) => c.rect) })
      result.pass.dragRailKeepsSidebarVisible = afterDrag.sidebarHit && afterDrag.sidebarHit.inStage === false
      await shot(page, '08-after-drag-rail.png')
    }
  }

  await context.close()
} catch (error) {
  result.error = String((error && error.stack) || error)
  console.log('[verify] FAIL ' + result.error)
} finally {
  await browser.close().catch(() => {})
}
result.finishedAt = new Date().toISOString()
result.ok = Object.keys(result.pass).length > 0 && Object.values(result.pass).every(Boolean)
fs.writeFileSync(path.join(OUT, 'verify-fix.json'), JSON.stringify(result, null, 1), 'utf8')
console.log('[verify] wrote artifacts/review/verify/verify-fix.json pass=' + JSON.stringify(result.pass) + ' ok=' + result.ok)
