/**
 * Round-3 验收：焦点窗底部渐变修复 / 候场卡 √2:1 / 候场栏-焦点窗比例拖拽（splitter）。
 * 产物：artifacts/review/verify/verify-round3.json + *.png
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const require = createRequire(path.join(ROOT, 'tools', 'pw') + path.sep)
const { chromium } = require('playwright-core')
const OUT = path.join(ROOT, 'artifacts', 'review', 'verify')
const url = fs.readFileSync(path.join(ROOT, 'artifacts', 'review', 'server-url.txt'), 'utf8').trim().split('#')[0]
const result = { startedAt: new Date().toISOString(), steps: [], screenshots: [], errors: [], pass: {} }
const step = (name, data) => { result.steps.push({ name, at: new Date().toISOString(), data }); console.log('[r3] ' + name + ' ' + JSON.stringify(data).slice(0, 1600)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (page, name) => { await page.screenshot({ path: path.join(OUT, name) }); result.screenshots.push(name) }
const ASPECT = Math.SQRT2

const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
  const page = await context.newPage()
  page.on('pageerror', (e) => result.errors.push(String(e).slice(0, 300)))
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('[role="textbox"], [data-placeholder]', { timeout: 60000 })
  await page.waitForFunction(() => !!window.__ONESTEP__, null, { timeout: 30000 })
  await sleep(1500)
  await page.evaluate(() => window.__ONESTEP__.actions.exitStage())
  await sleep(500)
  const ids = await page.evaluate(() => {
    const rows = window.__ONESTEP__.actions.listSessions()
    return Object.keys(rows).filter((id) => !rows[id].blank)
  })
  const snap0 = await page.evaluate(() => window.__ONESTEP__.actions.snapshot())
  if (!snap0.focusId) { await page.evaluate((id) => window.__ONESTEP__.actions.focusSession(id), ids[0]); await sleep(1200) }
  await page.evaluate((picked) => window.__ONESTEP__.actions.enterStage(picked), ids.slice(0, 4))
  await sleep(2600)

  // 1) 焦点窗底部渐变：composerSeat 的 linear-gradient 终点色必须等于焦点窗/舞台底色（bg-base）
  const bg = await page.evaluate(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    const focus = stage ? stage.querySelector('.onestep-frame[data-mode="focus"]') : null
    const body = focus ? focus.querySelector('.onestep-body') : null
    const seat = body ? body.querySelector('[data-composer-seat]') : null
    const cs = (el) => (el ? getComputedStyle(el) : null)
    return {
      theme: document.body.getAttribute('data-ds-dark-theme') === '' ? 'dark' : 'light',
      stageBg: cs(stage) ? cs(stage).backgroundColor : null,
      focusBg: cs(focus) ? cs(focus).backgroundColor : null,
      bodyBg: cs(body) ? cs(body).backgroundColor : null,
      composerGradient: seat ? cs(seat).backgroundImage : null,
      tokenBgBase: cs(document.body).getPropertyValue('--dsw-alias-bg-base').trim(),
    }
  })
  const gradientMatches = !!bg.composerGradient && bg.composerGradient.includes(bg.stageBg)
  result.pass.focusBackgroundMatches = bg.focusBg === bg.stageBg && bg.bodyBg === bg.stageBg
  result.pass.composerGradientMatches = gradientMatches
  step('focus-background', { ...bg, gradientMatches })
  const fr = await page.evaluate(() => {
    const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  })
  await page.screenshot({ path: path.join(OUT, '61-focus-bottom-dark.png'), clip: { x: fr.x, y: fr.y + fr.h - 280, width: fr.w, height: 280 } })
  await shot(page, '60-stage-thumbnails-dark.png')

  // 2) 候场卡比例 √2:1
  const aspect = await page.evaluate(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    const cards = stage ? Array.from(stage.querySelectorAll('.onestep-frame[data-mode="candidate"]')) : []
    return cards.map((card) => {
      const r = card.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height), ratio: Math.round((r.width / r.height) * 10000) / 10000 }
    })
  })
  result.pass.candidateAspect = aspect.length > 0 && aspect.every((c) => Math.abs(c.ratio - ASPECT) < 0.02)
  step('candidate-aspect', aspect)

  // 3) splitter 拖拽：候场栏宽度改变、卡片保持 √2、焦点窗收窄
  const before = await page.evaluate(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    const rail = stage ? stage.querySelector('[data-onestep-rail]') : null
    const focus = stage ? stage.querySelector('.onestep-frame[data-mode="focus"]') : null
    const splitter = stage ? stage.querySelector('[data-onestep-splitter]') : null
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    return { railSize: window.__ONESTEP__.actions.snapshot().railSize, rail: rect(rail), focus: rect(focus), splitter: rect(splitter) }
  })
  if (before.splitter) {
    const sx = before.splitter.x + before.splitter.w / 2
    const sy = before.splitter.y + before.splitter.h / 2
    await page.mouse.move(sx, sy)
    await page.mouse.down()
    await sleep(80)
    for (let i = 1; i <= 10; i += 1) {
      await page.mouse.move(sx + (i * 40) / 10, sy, { steps: 2 })
      await sleep(20)
    }
    await page.mouse.up()
    await sleep(700)
    const after = await page.evaluate(() => {
      const stage = document.querySelector('[data-onestep-stage]')
      const rail = stage ? stage.querySelector('[data-onestep-rail]') : null
      const focus = stage ? stage.querySelector('.onestep-frame[data-mode="focus"]') : null
      const cards = stage ? Array.from(stage.querySelectorAll('.onestep-frame[data-mode="candidate"]')) : []
      const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
      return {
        railSize: window.__ONESTEP__.actions.snapshot().railSize,
        rail: rect(rail),
        focus: rect(focus),
        cards: cards.map((card) => { const r = card.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), ratio: Math.round((r.width / r.height) * 10000) / 10000 } }),
      }
    })
    result.pass.splitterDragResizes = after.railSize > before.railSize + 20 && after.focus.w < before.focus.w - 20
    result.pass.cardsKeepAspectAfterDrag = after.cards.length > 0 && after.cards.every((c) => Math.abs(c.ratio - ASPECT) < 0.02) && after.cards.every((c) => Math.abs(c.w - after.railSize) <= 2)
    step('splitter-drag', { before, after })
    await shot(page, '62-splitter-dragged.png')
  }

  // 4) splitter 键盘可调（ArrowLeft 减少 8px）
  const kbBefore = await page.evaluate(() => window.__ONESTEP__.actions.snapshot().railSize)
  await page.evaluate(() => {
    const sp = document.querySelector('[data-onestep-splitter]')
    if (sp) sp.focus()
  })
  await page.keyboard.press('ArrowLeft')
  await sleep(500)
  const kbAfter = await page.evaluate(() => window.__ONESTEP__.actions.snapshot().railSize)
  result.pass.splitterKeyboard = kbAfter === kbBefore - 8
  step('splitter-keyboard', { kbBefore, kbAfter })

  // 5) 顶部候场栏也保持 √2（1280 视口）
  await page.setViewportSize({ width: 1280, height: 800 })
  await sleep(1400)
  const top = await page.evaluate(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    const cards = stage ? Array.from(stage.querySelectorAll('.onestep-frame[data-mode="candidate"]')) : []
    const splitter = stage ? stage.querySelector('[data-onestep-splitter]') : null
    return {
      railSide: stage ? stage.getAttribute('data-rail-side') : null,
      splitterOrientation: splitter ? splitter.getAttribute('data-orientation') : null,
      cards: cards.map((card) => { const r = card.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), ratio: Math.round((r.width / r.height) * 10000) / 10000 } }),
    }
  })
  result.pass.topRailAspect = top.railSide === 'top' && top.splitterOrientation === 'horizontal' && top.cards.length > 0 && top.cards.every((c) => Math.abs(c.ratio - ASPECT) < 0.02)
  step('top-rail', top)
  await shot(page, '63-top-rail-1280.png')

  await context.close()
} catch (error) {
  result.error = String((error && error.stack) || error)
  console.log('[r3] FAIL ' + result.error)
} finally {
  await browser.close().catch(() => {})
}
result.finishedAt = new Date().toISOString()
result.ok = Object.keys(result.pass).length > 0 && Object.values(result.pass).every(Boolean)
fs.writeFileSync(path.join(OUT, 'verify-round3.json'), JSON.stringify(result, null, 1), 'utf8')
console.log('[r3] wrote verify-round3.json pass=' + JSON.stringify(result.pass) + ' ok=' + result.ok)
