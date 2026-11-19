/**
 * P3-6 G6 生命周期门禁：刷新无残留、包装层卸载-还原-重装循环、重装后功能仍在。
 */
import path from 'node:path'
import fs from 'node:fs'

import { ROOT, Results, readServerUrl, openApp, closeApp, sleep, p3Call, actionCall, enterStage, mountedSessionId, fileAddress, leaveStage } from '../probe/lib.mjs'

const OUT = path.join(ROOT, 'artifacts', 'p3', 'verify')
const results = new Results('g6-lifecycle', 'P3-6 G6 生命周期（刷新残留/包装还原与重装）', path.join(OUT, 'g6-lifecycle.json'))

const domSnapshot = (page) => page.evaluate(() => ({
  floats: document.querySelectorAll('[data-dockkit-float]').length,
  peeked: document.querySelectorAll('[data-onestep-peek="1"]').length,
  tags: document.querySelectorAll('[data-onestep-peek-tag]').length,
  layers: document.querySelectorAll('[data-onestep-peek-layer]').length,
  dragHuds: document.querySelectorAll('.onestep-drag-hud').length,
}))

let app = null
try {
  readServerUrl()
  app = await openApp({ viewport: { width: 1440, height: 900 } })
  const { page } = app
  results.captureErrors(app.handles)
  await enterStage(page, { count: 3 })
  const sessionId = await mountedSessionId(page)

  // 1) 开 2 窗 → 全部收起（产生注入 + 标签层）
  await actionCall(page, 'companionOpenResource', null, fileAddress(sessionId, 'README.md'))
  await sleep(350)
  await actionCall(page, 'companionOpenResource', null, fileAddress(sessionId, 'CHANGELOG.md'))
  await sleep(400)
  const peekAll = await p3Call(page, 'floatPeekAll')
  await sleep(350)
  const peekedState = await domSnapshot(page)
  results.assert('g6.peek.injected', peekAll.value && peekAll.value.count === 2 && peekedState.peeked === 2 && peekedState.tags === 2, { actual: { peekAll: peekAll.value, dom: peekedState } })
  results.assert('g6.peek.inert', await page.evaluate(() => Array.from(document.querySelectorAll('[data-onestep-peek="1"]')).every((el) => el.hasAttribute('inert') && el.getAttribute('aria-hidden') === 'true')), { actual: null })

  // 2) 刷新：Q11 peek 不持久化 —— 无注入/标签残留，官方浮窗恢复
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[role="textbox"], [contenteditable="true"]', { timeout: 60000 })
  await page.waitForFunction(() => !!window.__ONESTEP__, null, { timeout: 40000 })
  await sleep(1200)
  const afterReload = await domSnapshot(page)
  const stateAfterReload = await p3Call(page, 'floatState')
  const peekedSaved = Object.values(stateAfterReload.value.state.bySession || {}).flatMap((session) => session.floats).filter((item) => item.peeked).length
  results.assert('g6.reload.no-peek-residue', afterReload.peeked === 0 && afterReload.tags === 0 && afterReload.layers === 0, { actual: afterReload })
  results.assert('g6.reload.peer-reset', peekedSaved === 0, { actual: { peekedSaved } })
  results.assert('g6.reload.floats-restored', afterReload.floats >= 1, { actual: afterReload })

  // 3) 包装层卸载-还原-重装循环：方法还原、可重装、重装后仍能重定向
  const beforeCycle = await p3Call(page, 'wrap')
  const cycle = await p3Call(page, 'wrapCycle')
  const afterCycle = await p3Call(page, 'wrap')
  results.assert('g6.wrap.cycle', cycle.value && cycle.value.ok === true && cycle.value.restored === 2 && cycle.value.reinstalled === true, { actual: cycle.value })
  results.assert('g6.wrap.reinstalled-status', afterCycle.value && afterCycle.value.installed === true && afterCycle.value.enabled === true, { actual: { before: beforeCycle.value, after: afterCycle.value } })
  const openedAfterCycle = await actionCall(page, 'companionOpenResource', null, fileAddress(sessionId, 'package.json'))
  await sleep(450)
  const floatsAfterCycle = await page.evaluate(() => document.querySelectorAll('[data-dockkit-float]').length)
  const countsAfterCycle = await p3Call(page, 'floatMode')
  results.assert('g6.wrap.redirect-after-cycle', openedAfterCycle.ok === true && countsAfterCycle.value.counts.total >= 1 && floatsAfterCycle >= 2, { actual: { opened: openedAfterCycle, counts: countsAfterCycle.value.counts, floats: floatsAfterCycle } })
  results.assert('g6.no-duplicate-listeners', await page.evaluate(() => document.querySelectorAll('[data-onestep-peek-layer]').length <= 1), { actual: null })
  const logs = await page.evaluate(() => window.__ONESTEP__.log(120).map((item) => item.event))
  results.assert('g6.logs.have-cycle', logs.includes('wrap.cycle') && logs.includes('wrap.restored'), { actual: logs.filter((event) => event.startsWith('wrap')).slice(-8) })
  results.assert('g6.no-pageerror', app.handles.pageErrors.length === 0, { actual: app.handles.pageErrors.slice(0, 5) })
  await leaveStage(page)
} catch (error) {
  results.fatal(error)
} finally {
  await closeApp(app)
}
const summary = results.finish()
fs.mkdirSync(OUT, { recursive: true })
process.exitCode = summary.ok ? 0 : 1
