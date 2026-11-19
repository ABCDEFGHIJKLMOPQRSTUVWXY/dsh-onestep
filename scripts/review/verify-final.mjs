/**
 * P1 review 修复验收 #4：picker / 提升唯一候场 / 关闭最后候场 / 陈旧焦点 / 键盘控制点 /
 * quick 工作区 chip 与 hover 不抢焦点 / 主题对比度 / HUD 默认绿 / 卡序 / 8px 分隔 / 顶部卡高。
 * 产物：artifacts/review/verify/verify-final.json + *.png
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const require = createRequire(path.join(ROOT, 'tools', 'pw') + path.sep)
const { chromium } = require('playwright-core')
const OUT = path.join(ROOT, 'artifacts', 'review', 'verify')
const url = fs.readFileSync(path.join(ROOT, 'artifacts', 'review', 'server-url.txt'), 'utf8').trim().split('#')[0]
const result = { startedAt: new Date().toISOString(), steps: [], screenshots: [], errors: [], consoleErrors: [], pass: {} }
const step = (name, data) => {
  result.steps.push({ name, at: new Date().toISOString(), data })
  console.log('[final] ' + name + ' ' + JSON.stringify(data).slice(0, 900))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, name) })
  result.screenshots.push(name)
}
const snapshot = (page) => page.evaluate(() => window.__ONESTEP__.actions.snapshot())

function luminance(rgbText) {
  const m = String(rgbText).match(/rgba?\(([^)]+)\)/)
  if (!m) return null
  const parts = m[1].split(',').map((v) => Number(v.trim())).slice(0, 3)
  const [r, g, b] = parts.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  if (la === null || lb === null) return null
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
  const page = await context.newPage()
  page.on('pageerror', (e) => result.errors.push(String(e).slice(0, 300)))
  page.on('console', (msg) => { if (msg.type() === 'error') result.consoleErrors.push(msg.text().slice(0, 300)) })
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('[role="textbox"], [data-placeholder]', { timeout: 60000 })
  await page.waitForFunction(() => !!window.__ONESTEP__, null, { timeout: 30000 })
  await sleep(1500)
  await page.evaluate(() => window.__ONESTEP__.actions.exitStage())
  await sleep(700)

  // ---------- 0. 打开当前会话（保证主绑定存在） ----------
  const rows = await page.evaluate(() => window.__ONESTEP__.actions.listSessions())
  const ids = Object.keys(rows).filter((id) => !rows[id].blank)
  await page.evaluate((id) => window.__ONESTEP__.actions.focusSession(id), ids[0])
  await sleep(1200)

  // ---------- 1. picker 入口（header 按钮）不再崩溃 ----------
  const headerBefore = await page.evaluate(() => ({ headerActions: document.querySelectorAll('[data-onestep-header-action]').length }))
  await page.evaluate(() => { const btn = document.querySelector('[data-onestep-header-action]'); if (btn) btn.click() })
  await sleep(700)
  const picker = await page.evaluate(() => {
    const el = document.querySelector('[data-onestep-picker]')
    if (!el) return null
    const labels = Array.from(el.querySelectorAll('label')).map((l) => l.textContent.trim().slice(0, 40))
    const buttons = Array.from(el.querySelectorAll('button')).map((b) => b.textContent.trim())
    return { text: el.innerText.slice(0, 200), labels: labels.slice(0, 3), buttons }
  })
  result.pass.pickerOpens = !!picker && picker.buttons.some((b) => /取消|Cancel/.test(b))
  step('picker', { headerBefore, picker })
  await shot(page, '31-picker.png')
  if (picker) {
    await page.keyboard.press('Escape')
    await sleep(500)
  }

  // ---------- 2. 提升唯一候场：舞台应保留（旧焦点入候场） ----------
  const promoteSetup = await page.evaluate(async (all) => {
    window.__ONESTEP__.actions.exitStage()
    await new Promise((r) => setTimeout(r, 500))
    await window.__ONESTEP__.actions.enterStage(all)
    return window.__ONESTEP__.actions.snapshot()
  }, ids.slice(0, 2))
  await sleep(1600)
  const beforePromote = await snapshot(page)
  const candRect = await page.evaluate(() => {
    const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="candidate"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  if (candRect) {
    await page.mouse.click(candRect.x, candRect.y)
    await sleep(1400)
  }
  const afterPromote = await snapshot(page)
  result.pass.promoteKeepsStage = afterPromote.mounted === true && afterPromote.candidates.length === 1 && afterPromote.focusId !== beforePromote.focusId
  step('promote-sole-candidate', {
    before: { focus: beforePromote.focusId, candidates: beforePromote.candidates },
    after: { mounted: afterPromote.mounted, focus: afterPromote.focusId, candidates: afterPromote.candidates },
  })
  await shot(page, '32-promote-sole.png')

  // ---------- 3. 关闭最后一个候场：无异常 + 退出舞台 + 全局 toast 可见 ----------
  const pageErrorsBefore = result.errors.length
  const lastCand = await page.evaluate(() => {
    const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="candidate"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  if (lastCand) {
    await page.mouse.move(lastCand.x, lastCand.y)
    await sleep(400)
    await page.evaluate(() => {
      const ctl = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="candidate"] .onestep-control')
      if (ctl) ctl.click()
    })
    await sleep(900)
  }
  const closed = await page.evaluate(() => {
    const s = window.__ONESTEP__.actions.snapshot()
    const toast = document.querySelector('.onestep-toast')
    return {
      mounted: s.mounted,
      candidates: s.candidates,
      focusId: s.focusId,
      stageDom: document.querySelectorAll('[data-onestep-stage]').length,
      toast: toast ? toast.innerText.slice(0, 80) : null,
      errorCount: 0,
    }
  })
  result.pass.closeLastCandidateNoError = result.errors.length === pageErrorsBefore && closed.mounted === false
  result.pass.exitToastVisible = !!closed.toast
  step('close-last-candidate', closed)
  await shot(page, '33-close-last-toast.png')

  // ---------- 4. 陈旧 focusSignal：退出后切焦点，再「＋」重进不应带出旧焦点 ----------
  const stale = await page.evaluate(async (all) => {
    const before = window.__ONESTEP__.actions.snapshot()
    // 退出舞台后先点另一个会话改变主绑定（普通模式）
    const other = all.find((id) => id !== before.focusId)
    if (other) window.__ONESTEP__.actions.focusSession(other)
    await new Promise((r) => setTimeout(r, 1200))
    // 用「加入舞台」把第三个会话加进来
    const third = all.find((id) => id !== before.focusId && id !== other)
    if (third) window.__ONESTEP__.actions.addCandidate(third)
    await new Promise((r) => setTimeout(r, 1200))
    const s = window.__ONESTEP__.actions.snapshot()
    return { focusAfterSwitch: other, candidates: s.candidates, mounted: s.mounted }
  }, ids.slice(0, 6))
  result.pass.noStaleFocusDemote = stale.mounted === true && stale.candidates.length === 1
  step('stale-focus-reentry', stale)
  await page.evaluate(() => window.__ONESTEP__.actions.exitStage())
  await sleep(700)

  // ---------- 5. 键盘：聚焦候选卡控制点后 Enter 应关闭而非提升 ----------
  const kbSetup = await page.evaluate(async (all) => {
    await window.__ONESTEP__.actions.enterStage(all)
    return window.__ONESTEP__.actions.snapshot()
  }, ids.slice(0, 3))
  await sleep(1500)
  const kb = await page.evaluate(() => {
    const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="candidate"] .onestep-control')
    if (!el) return null
    el.focus()
    return { focused: document.activeElement === el }
  })
  const focusBeforeKb = (await snapshot(page)).focusId
  const candsBeforeKb = (await snapshot(page)).candidates.length
  if (kb && kb.focused) {
    await page.keyboard.press('Enter')
    await sleep(900)
  }
  const afterKb = await snapshot(page)
  result.pass.controlKeyboardCloses = afterKb.focusId === focusBeforeKb && afterKb.candidates.length === candsBeforeKb - 1
  step('control-keyboard', { kb, focusBeforeKb, after: { focus: afterKb.focusId, candidates: afterKb.candidates.length } })

  // ---------- 6. quick 条：工作区 chip + hover 不抢焦点 ----------
  const activeBefore = await page.evaluate(() => ({ tag: document.activeElement.tagName, cls: String(document.activeElement.className || '').slice(0, 60) }))
  const f = await page.evaluate(() => {
    const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  if (f) {
    await page.mouse.move(f.x + f.w / 2, f.y + f.h - 6)
    await sleep(600)
  }
  const quickOpen = await page.evaluate(() => {
    const bar = document.querySelector('[data-onestep-stage] .onestep-quick')
    const chip = bar ? bar.querySelector('.onestep-chip') : null
    return {
      open: bar ? bar.getAttribute('data-open') : null,
      chip: chip ? { text: chip.textContent.trim(), disabled: chip.disabled, tag: chip.tagName } : null,
      activeTag: document.activeElement.tagName,
      activeCls: String(document.activeElement.className || '').slice(0, 60),
    }
  })
  result.pass.quickHasWorkspaceChip = !!quickOpen.chip
  result.pass.quickHoverDoesNotStealFocus = quickOpen.activeCls.indexOf('onestep-input') === -1
  step('quick-chip-hover', { activeBefore, quickOpen })
  await shot(page, '34-quick-chip.png')

  // ---------- 7. 主题对比度（浅 / 深） ----------
  const measureTheme = async () => page.evaluate(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    if (!stage) return null
    const cand = stage.querySelector('.onestep-frame[data-mode="candidate"]')
    const title = cand ? cand.querySelector('.onestep-title') : null
    const sub = cand ? cand.querySelector('.onestep-sub') : null
    const focusTitle = stage.querySelector('.onestep-frame[data-mode="focus"] .onestep-title')
    const bg = (el) => (el ? getComputedStyle(el).backgroundColor : null)
    const fg = (el) => (el ? getComputedStyle(el).color : null)
    const cardBg = bg(cand)
    // 标题行背景透明，取卡片底作为对比背景
    return {
      theme: document.body.getAttribute('data-ds-dark-theme') === '' ? 'dark' : 'light',
      cardBg,
      candidateTitle: fg(title),
      candidateSub: fg(sub),
      focusChromeTitle: fg(focusTitle),
    }
  })
  await page.evaluate(() => window.__ONESTEP__.actions.requestQuickNew())
  await page.emulateMedia({ colorScheme: 'light' })
  await sleep(600)
  const light = await measureTheme()
  await shot(page, '35-theme-light.png')
  await page.emulateMedia({ colorScheme: 'dark' })
  await sleep(700)
  const dark = await measureTheme()
  await shot(page, '36-theme-dark.png')
  const lightContrast = light ? contrast(light.candidateTitle, light.cardBg) : null
  const darkContrast = dark ? contrast(dark.candidateTitle, dark.cardBg) : null
  result.pass.lightThemeReadable = lightContrast !== null && lightContrast >= 4.5
  result.pass.darkThemeReadable = darkContrast !== null && darkContrast >= 4.5
  step('theme-contrast', { light, dark, lightContrast: lightContrast && Math.round(lightContrast * 100) / 100, darkContrast: darkContrast && Math.round(darkContrast * 100) / 100 })
  await page.emulateMedia({ colorScheme: 'light' })
  await sleep(500)

  // ---------- 8. HUD 默认色 + 卡序 + 8px 分隔 + 顶部卡高 ----------
  await page.evaluate(() => window.__ONESTEP__.actions.exitStage())
  await sleep(800)
  const dragSrc = await page.evaluate(() => {
    let current = null
    try { current = (JSON.parse(localStorage.getItem('dsh.sessions.current') || '{}') || {}).sessionId || null } catch (_e) { current = null }
    const rows = Array.from(document.querySelectorAll('[data-row-key^="session:"]'))
    const el = rows.filter((r) => r.getAttribute('draggable') === 'true' && r.getAttribute('data-row-key') !== 'session:' + current)[0]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  if (dragSrc) {
    await page.mouse.move(dragSrc.x, dragSrc.y)
    await page.mouse.down()
    await sleep(180)
    for (let i = 1; i <= 8; i += 1) {
      await page.mouse.move(dragSrc.x + i * 18, dragSrc.y + i * 3, { steps: 2 })
      await sleep(25)
    }
    const hud = await page.evaluate(() => {
      const el = document.querySelector('[data-onestep-drag-rail]')
      if (!el) return null
      const cs = getComputedStyle(el)
      return { border: cs.borderColor, background: cs.backgroundColor, label: el.textContent.trim() }
    })
    result.pass.hudGreenDefault = !!hud && /green|34|0\.77|0\.772/.test(hud.background) && hud.label.length > 0
    step('hud-default', hud)
    await shot(page, '37-hud-green.png')
    await page.keyboard.press('Escape')
    await page.mouse.up().catch(() => {})
    await sleep(500)
  }

  // 卡序：新加入在上（store 顺序 + DOM 顺序）——排除真实主绑定会话，避免被 handleFocus 去重
  const order = await page.evaluate(async (all) => {
    window.__ONESTEP__.actions.exitStage()
    await new Promise((r) => setTimeout(r, 400))
    let currentMain = null
    try { currentMain = (JSON.parse(localStorage.getItem('dsh.sessions.current') || '{}') || {}).sessionId || null } catch (_e) { currentMain = null }
    const pool = all.filter((id) => id !== currentMain)
    window.__ONESTEP__.actions.addCandidate(pool[0])
    await new Promise((r) => setTimeout(r, 900))
    window.__ONESTEP__.actions.addCandidate(pool[1])
    await new Promise((r) => setTimeout(r, 900))
    const s = window.__ONESTEP__.actions.snapshot()
    const titles = Array.from(document.querySelectorAll('[data-onestep-stage] .onestep-frame[data-mode="candidate"] .onestep-title')).map((el) => el.textContent)
    return { currentMain, candidates: s.candidates, titles, pool: pool.slice(0, 2) }
  }, ids.slice(0, 8))
  result.pass.newCandidateFirst = order.candidates.length >= 2 && order.candidates[0] === order.pool[1]
  step('candidate-order', order)

  // 8px 分隔 + 顶部卡高（1280）
  const geometry = await page.evaluate(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    const rail = stage ? stage.querySelector('[data-onestep-rail]') : null
    const cand = stage ? stage.querySelector('.onestep-frame[data-mode="candidate"]') : null
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    return { stage: rect(stage), rail: rect(rail), cand: rect(cand) }
  })
  result.pass.railInset8 = geometry.rail && geometry.cand && Math.abs(geometry.rail.x - geometry.cand.x) <= 1 && Math.abs(geometry.cand.x - geometry.stage.x - 8) <= 1
  step('rail-inset', geometry)
  await page.setViewportSize({ width: 1280, height: 800 })
  await sleep(1200)
  const topGeometry = await page.evaluate(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    const cand = stage ? stage.querySelector('.onestep-frame[data-mode="candidate"]') : null
    const railSide = stage ? stage.getAttribute('data-rail-side') : null
    const r = cand ? cand.getBoundingClientRect() : null
    return { railSide, card: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null }
  })
  result.pass.topRailCardHeight108 = topGeometry.railSide === 'top' && topGeometry.card && topGeometry.card.h === 108
  step('top-rail-card', topGeometry)
  await shot(page, '38-top-rail.png')

  await context.close()
} catch (error) {
  result.error = String((error && error.stack) || error)
  console.log('[final] FAIL ' + result.error)
} finally {
  await browser.close().catch(() => {})
}
result.finishedAt = new Date().toISOString()
result.ok = Object.keys(result.pass).length > 0 && Object.values(result.pass).every(Boolean)
fs.writeFileSync(path.join(OUT, 'verify-final.json'), JSON.stringify(result, null, 1), 'utf8')
console.log('[final] wrote verify-final.json pass=' + JSON.stringify(result.pass) + ' ok=' + result.ok)
