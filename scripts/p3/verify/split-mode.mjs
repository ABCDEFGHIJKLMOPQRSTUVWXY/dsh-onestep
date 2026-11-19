/** P3-12 手动分屏：官方「收回到侧边栏」检测、转回浮窗、刷新恢复。 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const require = createRequire(path.join(ROOT, 'tools', 'pw') + path.sep)
const { chromium } = require('playwright-core')
const url = fs.readFileSync(path.join(ROOT, 'artifacts', 'p3', 'server-url.txt'), 'utf8').split(/\r?\n/)[0].trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = path.join(ROOT, 'artifacts', 'p3', 'verify', 'split-mode.json')

const out = { ok: false, steps: [], pageErrors: [], consoleErrors: [], httpFailures: [] }
const step = (name, data) => {
  out.steps.push({ name, at: new Date().toISOString(), data: data === undefined ? null : data })
  console.log('[step] ' + name + ' ' + JSON.stringify(data).slice(0, 700))
}
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
const page = await context.newPage()
page.on('pageerror', (e) => out.pageErrors.push(String(e).slice(0, 300)))
page.on('console', (m) => { if (m.type() === 'error') out.consoleErrors.push(m.text().slice(0, 200)) })
page.on('response', (r) => { if (r.status() >= 400) out.httpFailures.push({ status: r.status(), url: r.url().slice(0, 160) }) })

const read = `() => {
  const panel = document.querySelector('[data-sidebar-right-panel]')
  const p3 = window.__ONESTEP__.actions.p3
  const state = p3.floatState().value.state
  const sessions = Object.values(state.bySession || {})
  const floats = sessions[0] ? sessions[0].floats : []
  return {
    mode: p3.floatMode().value.mode,
    counts: p3.floatMode().value.counts,
    floatModeEnabled: p3.wrap().value.enabled,
    domFloats: Array.from(document.querySelectorAll('[data-dockkit-float]')).map((el) => {
      const r = el.getBoundingClientRect()
      return { tabId: el.getAttribute('data-dockkit-content'), rect: { x: Math.round(r.x), y: Math.round(r.y) } }
    }),
    expanded: !!(panel && panel.hasAttribute('data-sidebar-right-open')),
    records: floats.map((item) => ({ tabId: item.tabId, slot: item.slot, docked: !!item.docked, peeked: !!item.peeked })),
    sessionCount: sessions.length,
  }
}`

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('[role="textbox"], [contenteditable="true"]', { timeout: 60000 })
  await page.waitForFunction(() => !!window.__ONESTEP__, null, { timeout: 40000 })
  await sleep(1200)
  const rows = await page.evaluate(() => Object.keys(window.__ONESTEP__.actions.listSessions()).slice(0, 3))
  await page.evaluate((ids) => window.__ONESTEP__.actions.enterStage(ids), rows)
  await sleep(1300)
  const sessionId = await page.evaluate(() => window.__ONESTEP__.actions.p3.snapshot().mounted)
  const address = (file) => 'dsh-resource://file/session/' + sessionId + '/' + file
  await page.evaluate(async ({ files }) => {
    for (const file of files) {
      window.__ONESTEP__.actions.companionOpenResource(null, file)
      await new Promise((r) => setTimeout(r, 300))
    }
  }, { files: [address('README.md'), address('CHANGELOG.md')] })
  await sleep(400)
  step('open2', await page.evaluate((readSrc) => eval('(' + readSrc + ')()'), read))

  // A) 点官方浮窗「收回到侧边栏」→ 检测并切 split、其余浮窗一并收回
  await page.click('[data-dockkit-float] [data-dockkit-float-dock]')
  await sleep(900)
  step('A.officialDock', await page.evaluate((readSrc) => eval('(' + readSrc + ')()'), read))
  await page.waitForFunction(() => !!document.querySelector('[data-dockkit-float-dock]'), null, { timeout: 1 }).catch(() => null)

  // B) 「…」菜单 → 「转回浮窗」（用 JS 点击：compact 布局下 rail toggle 可能盖住 chrome 按钮）
  await page.evaluate(() => document.querySelector('[data-onestep-more]').click())
  await sleep(200)
  const restoreVisible = await page.evaluate(() => !!document.querySelector('[data-onestep-companion-restore]'))
  if (restoreVisible) await page.evaluate(() => document.querySelector('[data-onestep-companion-restore]').click())
  await sleep(800)
  step('B.restoreDocked', { menuItemVisible: restoreVisible, state: await page.evaluate((readSrc) => eval('(' + readSrc + ')()'), read) })

  // C) 刷新（float 形态）：官方恢复浮窗、插件 mode float
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[role="textbox"], [contenteditable="true"]', { timeout: 60000 })
  await page.waitForFunction(() => !!window.__ONESTEP__, null, { timeout: 40000 })
  await sleep(1500)
  step('C.reloadFloat', await page.evaluate((readSrc) => eval('(' + readSrc + ')()'), read))

  // D) 切 split → 再刷新：mode split 持久化、右栏 expanded 恢复
  await page.evaluate(() => window.__ONESTEP__.actions.p3.floatSetMode('split'))
  await sleep(900)
  const afterSplit = await page.evaluate((readSrc) => eval('(' + readSrc + ')()'), read)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[role="textbox"], [contenteditable="true"]', { timeout: 60000 })
  await page.waitForFunction(() => !!window.__ONESTEP__, null, { timeout: 40000 })
  await sleep(1500)
  step('D.reloadSplit', { afterSplit, afterReload: await page.evaluate((readSrc) => eval('(' + readSrc + ')()'), read) })

  // E) split 下「转回浮窗」→ float
  await page.evaluate(() => document.querySelector('[data-onestep-more]').click())
  await sleep(200)
  const restoreSplitVisible = await page.evaluate(() => !!document.querySelector('[data-onestep-companion-restore]'))
  if (restoreSplitVisible) await page.evaluate(() => document.querySelector('[data-onestep-companion-restore]').click())
  await sleep(900)
  step('E.restoreFromSplit', { menuItemVisible: restoreSplitVisible, state: await page.evaluate((readSrc) => eval('(' + readSrc + ')()'), read) })
  await page.screenshot({ path: path.join(ROOT, 'artifacts', 'p3', 'verify', 'p3-12-restored.png') })


  // F') 收回项超过槽位：转回浮窗只恢复能放下的数量，其余保持 docked，且不得重叠（P3-12 修复回归）。
  const overflow = await page.evaluate(async () => {
    const A = window.__ONESTEP__.actions
    const P = A.p3
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    const floats = () => Array.from(document.querySelectorAll('[data-dockkit-float]')).map((el) => ({ tabId: el.getAttribute('data-dockkit-content'), rect: rect(el) }))
    const overlaps = (list) => {
      let count = 0
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const a = list[i].rect
          const b = list[j].rect
          if (!a || !b) continue
          if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1) count += 1
        }
      }
      return count
    }
    // 清掉前面步骤留下的浮窗/收回项，从干净状态开始。
    const records = Object.values(P.floatState().value.state.bySession || {}).flatMap((session) => session.floats.map((item) => item.tabId))
    for (const tabId of records) { try { P.close(tabId) } catch (_error) { /* ignore */ } await sleep(160) }
    await sleep(400)
    P.floatReconcile()
    await sleep(300)
    const sessionId = P.snapshot().mounted
    const addr = (name) => 'dsh-resource://file/session/' + sessionId + '/' + name
    for (const name of ['README.md', 'CHANGELOG.md', 'package.json', 'LICENSE', 'cordis.patch.yml']) {
      A.companionOpenResource(null, addr(name))
      await sleep(420)
    }
    const afterFive = { counts: P.floatMode().value.counts, floats: floats() }
    const split = P.floatSetMode('split')
    await sleep(1200)
    const toFloat = P.floatSetMode('float')
    await sleep(700)
    const restore = P.floatRestoreDocked()
    await sleep(1400)
    const list = floats()
    return { afterFive: { counts: afterFive.counts, count: afterFive.floats.length }, split: split.value, toFloat: toFloat.value, restore: restore.value, after: { counts: P.floatMode().value.counts, floats: list, overlaps: overlaps(list), tags: document.querySelectorAll('[data-onestep-peek-tag]').length } }
  })
  step('F.overflowRestore', overflow)
  out.overflowRestore = overflow
  out.assertions = [
    { name: 'split.overflow-restore.counts', pass: overflow.after.counts.visible === Math.min(3, overflow.afterFive.count) && overflow.after.counts.visible + overflow.after.counts.docked === overflow.afterFive.count, actual: overflow.after.counts },
    { name: 'split.overflow-restore.no-overlap', pass: overflow.after.overlaps === 0, actual: { overlaps: overflow.after.overlaps, floats: overflow.after.floats } },
  ]
  out.ok = out.pageErrors.length === 0 && out.assertions.every((item) => item.pass)
} catch (error) {
  out.fatal = String((error && error.stack) || error)
  out.ok = false
} finally {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  out.finishedAt = new Date().toISOString()
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8')
  console.log('[' + (out.ok ? 'OK' : 'FAIL') + '] wrote ' + path.relative(ROOT, OUT) + ' steps=' + out.steps.length + ' pageErrors=' + out.pageErrors.length)
  await browser.close()
}
process.exitCode = out.ok ? 0 : 1
