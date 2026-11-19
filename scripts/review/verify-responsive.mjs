/**
 * P1 review 修复验收 #2：resize / 右栏挤入 / 侧栏点击换焦点 / 快速新建条与焦点控制点截图 / 退出恢复。
 * 产物：artifacts/review/verify/verify-responsive.json + *.png
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
  console.log('[resp] ' + name + ' ' + JSON.stringify(data).slice(0, 800))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, name) })
  result.screenshots.push(name)
}

async function geo(page) {
  return page.evaluate(() => {
    const rect = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    }
    const stage = document.querySelector('[data-onestep-stage]')
    const host = (() => {
      if (!stage) return null
      let node = stage.parentElement
      while (node && node !== document.body) {
        const cs = getComputedStyle(node)
        const r = node.getBoundingClientRect()
        if (cs.display !== 'contents' && r.width > 0 && r.height > 0) return { rect: rect(node), cls: String(node.className || '').slice(0, 50) }
        node = node.parentElement
      }
      return null
    })()
    const s = window.__ONESTEP__.actions.snapshot()
    return {
      viewport: { w: innerWidth, h: innerHeight },
      mounted: s.mounted,
      railSide: s.railSide,
      focusId: s.focusId,
      candidates: s.candidates,
      stage: rect(stage),
      host: host ? host.rect : null,
      fits: stage && host ? Math.abs(rect(stage).x - host.rect.x) <= 1 && Math.abs(rect(stage).w - host.rect.w) <= 1 : null,
      stageDom: document.querySelectorAll('[data-onestep-stage]').length,
      officialOutside: Array.from(document.querySelectorAll('[data-conversation-content]')).filter((el) => !el.closest('[data-onestep-stage]')).length,
    }
  })
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
  await page.evaluate((picked) => window.__ONESTEP__.actions.enterStage(picked), ids.slice(0, 3))
  await sleep(1800)
  step('base-1440', await geo(page))

  // 1) 视口 1280×800
  await page.setViewportSize({ width: 1280, height: 800 })
  await sleep(900)
  const at1280 = await geo(page)
  result.pass.resize1280Fits = at1280.fits === true
  step('resize-1280', at1280)
  await shot(page, '11-resize-1280.png')

  // 2) 860×900：按 main 列实际宽度判定 —— 要么保持舞台（顶部候场栏、贴合宿主），要么按规范退出
  await page.setViewportSize({ width: 860, height: 900 })
  await sleep(1200)
  const at860 = await geo(page)
  result.pass.resize860Graceful = at860.mounted
    ? at860.fits === true && at860.railSide === 'top'
    : at860.stageDom === 0 && at860.officialOutside >= 1
  step('resize-860', at860)
  await shot(page, '12-resize-860-top.png')

  // 3) 720 退出舞台
  await page.setViewportSize({ width: 720, height: 900 })
  await sleep(1000)
  const at720 = await geo(page)
  result.pass.narrow720Exits = at720.mounted === false && at720.stageDom === 0
  step('resize-720', at720)
  await shot(page, '13-resize-720-exit.png')

  // 回 1440 再进舞台
  await page.setViewportSize({ width: 1440, height: 900 })
  await sleep(800)
  const ids2 = await page.evaluate(() => {
    const rows = window.__ONESTEP__.actions.listSessions()
    return Object.keys(rows).filter((id) => !rows[id].blank)
  })
  await page.evaluate((picked) => window.__ONESTEP__.actions.enterStage(picked), ids2.slice(0, 3))
  await sleep(1800)
  const back = await geo(page)
  step('back-1440', back)

  // 4) 舞台模式点击官方左栏的其它会话 → 焦点跟随（左栏可交互）
  const clickRow = await page.evaluate(() => {
    const current = window.__ONESTEP__.actions.snapshot().focusId
    const rows = Array.from(document.querySelectorAll('[data-row-key^="session:"]'))
    const el = rows.find((r) => r.getAttribute('data-row-key') !== 'session:' + current)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { key: el.getAttribute('data-row-key'), x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  const focusBeforeClick = (await geo(page)).focusId
  if (clickRow) {
    await page.mouse.click(clickRow.x, clickRow.y)
    await sleep(1800)
  }
  const afterClick = await geo(page)
  result.pass.sidebarRowSwitchesFocus = afterClick.mounted && !!afterClick.focusId && afterClick.focusId !== focusBeforeClick
  step('sidebar-row-click', { clicked: clickRow ? String(clickRow.key).slice(0, 34) : null, focusBeforeClick, focusAfter: afterClick.focusId, candidates: afterClick.candidates, mounted: afterClick.mounted })
  await shot(page, '15-sidebar-switch-focus.png')

  // 5) 右栏挤入 → main 列收窄 → 舞台跟随；若降到 <760 则按规范退出并恢复官方
  await page.evaluate(() => window.__ONESTEP__.actions.toggleRightbar())
  await sleep(1400)
  const withRightbar = await geo(page)
  result.pass.rightbarGraceful = withRightbar.mounted ? withRightbar.fits === true : withRightbar.stageDom === 0 && withRightbar.officialOutside >= 1
  step('rightbar-open', withRightbar)
  await shot(page, '14-rightbar-open.png')
  await page.evaluate(() => window.__ONESTEP__.actions.toggleRightbar())
  await sleep(900)
  // 若右栏导致退出，重新进入舞台继续后续检查
  if (!(await geo(page)).mounted) {
    const ids3 = await page.evaluate(() => {
      const rows = window.__ONESTEP__.actions.listSessions()
      return Object.keys(rows).filter((id) => !rows[id].blank)
    })
    await page.evaluate((picked) => window.__ONESTEP__.actions.enterStage(picked), ids3.slice(0, 3))
    await sleep(1800)
  }

  // 6) 快速新建条截图（等待过渡完成）
  await page.evaluate(() => window.__ONESTEP__.actions.requestQuickNew())
  await sleep(900)
  await shot(page, '16-quick-open.png')

  // 7) 焦点窗右下角 hover → 控制点可见截图
  const f = await page.evaluate(() => {
    const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  if (f) {
    await page.mouse.move(f.x + f.w - 18, f.y + f.h - 18)
    await sleep(450)
    const visible = await page.evaluate(() => {
      const ctl = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"] .onestep-control')
      return ctl ? { opacity: getComputedStyle(ctl).opacity, dataShow: ctl.getAttribute('data-show') } : null
    })
    await shot(page, '17-focus-close-visible.png')
    result.pass.focusControlVisibleShot = visible && visible.opacity === '1'
    step('focus-control-shot', visible)
  }

  // 8) 退出恢复
  await page.evaluate(() => window.__ONESTEP__.actions.exitStage())
  await sleep(1200)
  const exited = await geo(page)
  result.pass.exitRestoresOfficial = exited.mounted === false && exited.stageDom === 0 && exited.officialOutside >= 1
  step('exit-restore', exited)
  await shot(page, '18-exit-restore.png')

  await context.close()
} catch (error) {
  result.error = String((error && error.stack) || error)
  console.log('[resp] FAIL ' + result.error)
} finally {
  await browser.close().catch(() => {})
}
result.finishedAt = new Date().toISOString()
result.ok = Object.keys(result.pass).length > 0 && Object.values(result.pass).every(Boolean)
fs.writeFileSync(path.join(OUT, 'verify-responsive.json'), JSON.stringify(result, null, 1), 'utf8')
console.log('[resp] wrote verify-responsive.json pass=' + JSON.stringify(result.pass) + ' ok=' + result.ok)
