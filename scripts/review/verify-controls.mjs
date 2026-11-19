/**
 * P1 review 修复验收 #3：chrome 菜单 / 关闭控制点语义 / inert / 持久化恢复 / 焦点可编辑性。
 * 产物：artifacts/review/verify/verify-controls.json + *.png
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
const step = (name, data) => {
  result.steps.push({ name, at: new Date().toISOString(), data })
  console.log('[ctl] ' + name + ' ' + JSON.stringify(data).slice(0, 900))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, name) })
  result.screenshots.push(name)
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
  await sleep(500)
  const ids = await page.evaluate(() => {
    const rows = window.__ONESTEP__.actions.listSessions()
    return Object.keys(rows).filter((id) => !rows[id].blank)
  })
  await page.evaluate((picked) => window.__ONESTEP__.actions.enterStage(picked), ids.slice(0, 4))
  await sleep(1800)

  // A. chrome 按钮组：＋ / ⇥ / … ；不再暴露 L/C/⤢/× 开发按钮
  const chrome = await page.evaluate(() => {
    const focus = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
    const buttons = Array.from(focus.querySelectorAll('.onestep-chrome .onestep-btn'))
    return buttons.map((b) => ({ text: b.textContent, title: b.title, more: b.hasAttribute('data-onestep-more'), quick: b.hasAttribute('data-onestep-quick-open') }))
  })
  result.pass.chromeButtonsClean = chrome.length === 3 && chrome.some((b) => b.more) && chrome.some((b) => b.quick) && !chrome.some((b) => b.text === 'L' || b.text === 'C' || b.text === '⤢')
  step('chrome-buttons', { chrome, count: chrome.length })

  // B. 更多菜单：切换完整/精简 + 退出舞台
  const modeBeforeMenu = await page.evaluate(() => window.__ONESTEP__.actions.snapshot().previewMode)
  await page.click('[data-onestep-stage] [data-onestep-more]')
  await sleep(500)
  const menu = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[data-onestep-stage] .onestep-menu .onestep-menu-item'))
    return { count: items.length, texts: items.map((i) => i.textContent) }
  })
  step('more-menu', menu)
  // P3-4 起菜单新增伴生窗形态/打开官方右栏项（产品变更，见 docs/p3-plan.md §5.1/P3-4）：
  // 断言从「恰好 2 项」放宽为「至少 2 项，首项为预览档切换、末项为退出舞台」。
  const firstText = menu.texts[0] || ''
  const lastText = menu.texts[menu.texts.length - 1] || ''
  result.pass.moreMenuHasPreviewAndExit = menu.count >= 2 && /候场/.test(firstText) && /退出舞台|Exit stage/.test(lastText)
  await shot(page, '21-more-menu.png')
  if (menu.count >= 1) {
    await page.evaluate(() => {
      const item = document.querySelectorAll('[data-onestep-stage] .onestep-menu .onestep-menu-item')[0]
      if (item) item.click()
    })
    await sleep(700)
  }
  const modeAfterMenu = await page.evaluate(() => window.__ONESTEP__.actions.snapshot().previewMode)
  result.pass.menuTogglesPreview = modeAfterMenu !== modeBeforeMenu
  step('preview-mode-after-menu', { modeBeforeMenu, modeAfterMenu })
  // 再切回原档位（走菜单第一条路径）
  await page.click('[data-onestep-stage] [data-onestep-more]')
  await sleep(300)
  await page.evaluate(() => {
    const item = document.querySelectorAll('[data-onestep-stage] .onestep-menu .onestep-menu-item')[0]
    if (item) item.click()
  })
  await sleep(600)

  // C. inert：候场 body inert，唯一可编辑 composer 在焦点窗（inert 语义只在 live 档存在，显式切换）
  await page.evaluate(() => window.__ONESTEP__.actions.setPreviewMode('live'))
  await sleep(1500)
  const inert = await page.evaluate(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    const candidateBodies = Array.from(stage.querySelectorAll('.onestep-frame[data-mode="candidate"] .onestep-body'))
    const focus = stage.querySelector('.onestep-frame[data-mode="focus"]')
    const focusEditors = focus ? focus.querySelectorAll('[contenteditable="true"], [role="textbox"]') : []
    let blocked = null
    const candEditor = candidateBodies[0] ? candidateBodies[0].querySelector('[contenteditable="true"], [role="textbox"]') : null
    if (candEditor) {
      candEditor.focus()
      blocked = document.activeElement !== candEditor && !candidateBodies[0].contains(document.activeElement)
    }
    return {
      inertAll: candidateBodies.length > 0 && candidateBodies.every((b) => b.hasAttribute('inert')),
      candidateBodies: candidateBodies.length,
      focusEditors: focusEditors.length,
      candidateEditorBlocked: blocked,
      stageComposers: stage.querySelectorAll('[contenteditable="true"]').length,
    }
  })
  result.pass.candidateInert = inert.inertAll && inert.candidateEditorBlocked !== false
  result.pass.singleEditableComposer = inert.focusEditors === 1
  step('inert', inert)
  await page.evaluate(() => window.__ONESTEP__.actions.setPreviewMode('card'))
  await sleep(900)

  // D. 候场卡关闭控制点：hover 后点击 → 移出候场，舞台保留
  const beforeClose = await page.evaluate(() => window.__ONESTEP__.actions.snapshot().candidates.length)
  const cand = await page.evaluate(() => {
    const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="candidate"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  if (cand) {
    await page.mouse.move(cand.x, cand.y)
    await sleep(400)
    const clicked = await page.evaluate(() => {
      const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="candidate"] .onestep-control')
      if (!el) return false
      el.click()
      return true
    })
    await sleep(900)
    const afterClose = await page.evaluate(() => {
      const s = window.__ONESTEP__.actions.snapshot()
      return { mounted: s.mounted, candidates: s.candidates.length, toast: s.feedback.toast ? s.feedback.toast.text : null }
    })
    result.pass.candidateCloseWorks = clicked && afterClose.mounted && afterClose.candidates === beforeClose - 1
    step('candidate-close', { beforeClose, afterClose })
    await shot(page, '22-after-candidate-close.png')
  }

  // E. 焦点关闭控制点：hover 右下角 → 点击 → 提升候场为焦点
  const beforeFocus = await page.evaluate(() => {
    const s = window.__ONESTEP__.actions.snapshot()
    return { focusId: s.focusId, candidates: s.candidates.slice() }
  })
  if (beforeFocus.candidates.length > 0) {
    const f = await page.evaluate(() => {
      const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    })
    await page.mouse.move(f.x + f.w - 20, f.y + f.h - 20)
    await sleep(450)
    const pressed = await page.evaluate(() => {
      const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"] .onestep-control')
      if (!el) return false
      el.click()
      return true
    })
    await sleep(1200)
    const afterFocus = await page.evaluate(() => {
      const s = window.__ONESTEP__.actions.snapshot()
      return { mounted: s.mounted, focusId: s.focusId, candidates: s.candidates.slice(), toast: s.feedback.toast ? s.feedback.toast.text : null }
    })
    result.pass.focusClosePromotes = pressed && afterFocus.mounted && afterFocus.focusId === beforeFocus.candidates[0]
    step('focus-close', { beforeFocus, afterFocus })
    await shot(page, '23-after-focus-close.png')
  }

  // F. 焦点窗内容仍挂载且可交互（会话若本身只读则 composer 不可编辑，属数据状态而非舞台缺陷）
  const editable = await page.evaluate(() => {
    const focus = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
    const occurrences = focus ? focus.querySelectorAll('[data-onestep-occurrence]').length : 0
    const editors = focus ? Array.from(focus.querySelectorAll('[contenteditable="true"]')) : []
    const first = editors[0]
    if (first) first.focus()
    return { editors: editors.length, occurrences, focused: first ? focus.contains(document.activeElement) : null }
  })
  result.pass.focusContentMounted = editable.occurrences >= 1
  step('focus-editable', editable)

  // G. 持久化恢复：flush → reload → 舞台恢复且仍贴合宿主
  const beforeReload = await page.evaluate(() => {
    window.__ONESTEP__.actions.flushPersist()
    const s = window.__ONESTEP__.actions.snapshot()
    return { candidates: s.candidates.slice(), focusId: s.focusId }
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.__ONESTEP__, null, { timeout: 60000 })
  await sleep(3000)
  const restored = await page.evaluate(() => {
    const s = window.__ONESTEP__.actions.snapshot()
    const stage = document.querySelector('[data-onestep-stage]')
    const host = (() => {
      if (!stage) return null
      let node = stage.parentElement
      while (node && node !== document.body) {
        const cs = getComputedStyle(node)
        const r = node.getBoundingClientRect()
        if (cs.display !== 'contents' && r.width > 0 && r.height > 0) return r
        node = node.parentElement
      }
      return null
    })()
    const sr = stage ? stage.getBoundingClientRect() : null
    return {
      mounted: s.mounted, candidates: s.candidates.slice(), focusId: s.focusId,
      stage: sr ? { x: Math.round(sr.x), y: Math.round(sr.y), w: Math.round(sr.width), h: Math.round(sr.height) } : null,
      host: host ? { x: Math.round(host.x), y: Math.round(host.y), w: Math.round(host.width), h: Math.round(host.height) } : null,
    }
  })
  result.pass.persistenceRestoresStage = restored.mounted && beforeReload.candidates.every((id) => restored.candidates.includes(id))
  step('persistence', { beforeReload, restored })
  await shot(page, '24-persisted-restored.png')

  await context.close()
} catch (error) {
  result.error = String((error && error.stack) || error)
  console.log('[ctl] FAIL ' + result.error)
} finally {
  await browser.close().catch(() => {})
}
result.finishedAt = new Date().toISOString()
result.ok = Object.keys(result.pass).length > 0 && Object.values(result.pass).every(Boolean)
fs.writeFileSync(path.join(OUT, 'verify-controls.json'), JSON.stringify(result, null, 1), 'utf8')
console.log('[ctl] wrote verify-controls.json pass=' + JSON.stringify(result.pass) + ' ok=' + result.ok)
