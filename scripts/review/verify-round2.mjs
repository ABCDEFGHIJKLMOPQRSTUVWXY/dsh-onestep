/**
 * Round-2/3 验收：候场卡实时缩略画面（无输入区）、待处理气泡、快速条离开隐藏 + 草稿保留。
 * 产物：artifacts/review/verify/verify-round2.json + *.png
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
const step = (name, data) => { result.steps.push({ name, at: new Date().toISOString(), data }); console.log('[r2] ' + name + ' ' + JSON.stringify(data).slice(0, 1400)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (page, name) => { await page.screenshot({ path: path.join(OUT, name) }); result.screenshots.push(name) }

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

  // 1) 默认实时缩略：每张候场卡 = 等比缩放的官方聊天体 + 无输入区
  const thumb = await page.evaluate(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    const cards = stage ? Array.from(stage.querySelectorAll('.onestep-frame[data-mode="candidate"]')) : []
    return {
      previewMode: window.__ONESTEP__.actions.snapshot().previewMode,
      stageOccurrences: stage ? stage.querySelectorAll('[data-onestep-occurrence]').length : 0,
      cards: cards.map((card) => {
        const body = card.querySelector('.onestep-body')
        const content = card.querySelector('.onestep-thumb-content')
        const seat = body ? body.querySelector('[data-composer-seat], [data-composer-card]') : null
        const seatVisible = seat ? (() => { const r = seat.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(seat).display !== 'none' })() : false
        return {
          preview: card.getAttribute('data-preview'),
          hasThumb: !!content,
          scale: content ? getComputedStyle(content).transform : null,
          occurrences: body ? body.querySelectorAll('[data-onestep-occurrence]').length : 0,
          composerSeatVisible: seatVisible,
          rect: (() => { const r = card.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), ratio: Math.round((r.width / r.height) * 1000) / 1000 } })(),
        }
      }),
    }
  })
  result.pass.defaultThumbnail = thumb.previewMode === 'live' && thumb.cards.length === 3 && thumb.cards.every((c) => c.preview === 'live' && c.hasThumb && c.occurrences === 1 && !c.composerSeatVisible)
  result.pass.thumbnailScaled = thumb.cards.every((c) => c.scale && c.scale !== 'none' && c.scale !== 'matrix(1, 0, 0, 1, 0, 0)')
  step('default-thumbnail', thumb)
  await shot(page, '51-thumbnail-dark.png')

  // 2) 精简卡仍可切换（不挂载 occurrence）
  await page.evaluate(() => window.__ONESTEP__.actions.setPreviewMode('card'))
  await sleep(1200)
  const cardMode = await page.evaluate(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    const cards = stage ? Array.from(stage.querySelectorAll('.onestep-frame[data-mode="candidate"]')) : []
    return { previewMode: window.__ONESTEP__.actions.snapshot().previewMode, cardPreview: cards.map((c) => c.getAttribute('data-preview')), occurrences: stage ? stage.querySelectorAll('[data-onestep-occurrence]').length : 0 }
  })
  result.pass.cardModePlain = cardMode.previewMode === 'card' && cardMode.cardPreview.every((p) => p === 'card') && cardMode.occurrences === 1
  step('card-mode', cardMode)
  await page.evaluate(() => window.__ONESTEP__.actions.setPreviewMode('live'))
  await sleep(1800)

  // 3) pending 气泡：出现 + 点击提升
  const beforeBubble = await page.evaluate(() => window.__ONESTEP__.actions.snapshot())
  await page.evaluate(() => {
    const sessions = window.__ONESTEP__.actions.snapshot().candidates
    window.__ONESTEP__.actions.demoFeedback({ bubbleSessionId: sessions[0], kind: 'approval' })
  })
  await sleep(800)
  const bubble = await page.evaluate(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    const cards = stage ? Array.from(stage.querySelectorAll('.onestep-frame[data-mode="candidate"]')) : []
    const withBubble = cards.find((card) => card.querySelector('.onestep-bubble'))
    const el = withBubble ? withBubble.querySelector('.onestep-bubble') : null
    const r = el ? el.getBoundingClientRect() : null
    return { found: !!el, text: el ? el.textContent.trim() : null, pendingAttr: withBubble ? withBubble.getAttribute('data-pending') : null, rect: r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null }
  })
  result.pass.pendingBubbleShown = bubble.found && bubble.pendingAttr === '1'
  step('pending-bubble', bubble)
  await shot(page, '52-thumbnail-bubble.png')
  if (bubble.rect) {
    const focusBefore = await page.evaluate(() => window.__ONESTEP__.actions.snapshot().focusId)
    await page.mouse.click(bubble.rect.x, bubble.rect.y)
    await sleep(1400)
    const after = await page.evaluate(() => window.__ONESTEP__.actions.snapshot())
    result.pass.bubbleClickPromotes = after.focusId !== focusBefore
    step('bubble-click', { focusBefore, focusAfter: after.focusId, mounted: after.mounted })
  }

  // 4) 快速新建：离开隐藏 + 草稿保留 + 再唤醒显示
  await page.evaluate(() => window.__ONESTEP__.actions.requestQuickNew())
  await sleep(800)
  await page.evaluate(() => {
    const input = document.querySelector('[data-onestep-stage] .onestep-quick .onestep-input')
    if (!input) return
    input.focus()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '快速新建草稿-保留测试')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await sleep(400)
  const f = await page.evaluate(() => {
    const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  await page.mouse.move(f.x + f.w / 2, f.y + f.h - 8)
  await sleep(300)
  await page.mouse.move(f.x + f.w / 2, f.y + 200)
  await sleep(1200)
  const afterLeave = await page.evaluate(() => {
    const bar = document.querySelector('[data-onestep-stage] .onestep-quick')
    const input = bar ? bar.querySelector('.onestep-input') : null
    return { open: bar ? bar.getAttribute('data-open') : null, value: input ? input.value : null }
  })
  await page.mouse.move(f.x + f.w / 2, f.y + f.h - 8)
  await sleep(800)
  const reopened = await page.evaluate(() => {
    const bar = document.querySelector('[data-onestep-stage] .onestep-quick')
    const input = bar ? bar.querySelector('.onestep-input') : null
    return { open: bar ? bar.getAttribute('data-open') : null, value: input ? input.value : null }
  })
  result.pass.quickHidesOnLeaveKeepsDraft = afterLeave.open === '0' && afterLeave.value === '快速新建草稿-保留测试' && reopened.open === '1' && reopened.value === '快速新建草稿-保留测试'
  step('quick-hide-draft', { afterLeave, reopened })
  await shot(page, '53-quick-draft.png')

  await context.close()
} catch (error) {
  result.error = String((error && error.stack) || error)
  console.log('[r2] FAIL ' + result.error)
} finally {
  await browser.close().catch(() => {})
}
result.finishedAt = new Date().toISOString()
result.ok = Object.keys(result.pass).length > 0 && Object.values(result.pass).every(Boolean)
fs.writeFileSync(path.join(OUT, 'verify-round2.json'), JSON.stringify(result, null, 1), 'utf8')
console.log('[r2] wrote verify-round2.json pass=' + JSON.stringify(result.pass) + ' ok=' + result.ok)
