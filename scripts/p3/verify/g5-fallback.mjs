/**
 * P3-6 G5 回退门禁：官方入口错误原样抛、包装层直通场景（split/非舞台）、能力自检纯函数。
 * 依赖：隔离实例（artifacts/p3/server-url.txt）。
 */
import path from 'node:path'
import fs from 'node:fs'

import { ROOT, Results, readServerUrl, openApp, closeApp, sleep, p3Call, actionCall, enterStage, mountedSessionId, fileAddress, stageSnapshot, leaveStage } from '../probe/lib.mjs'
import { checkWrapSupport, decideOpen } from '../../../src/client/service-wrap.js'

const OUT = path.join(ROOT, 'artifacts', 'p3', 'verify')
const results = new Results('g5-fallback', 'P3-6 G5 回退（错误透传/直通场景/能力自检）', path.join(OUT, 'g5-fallback.json'))

const floatCount = (page) => page.evaluate(() => document.querySelectorAll('[data-dockkit-float]').length)
const panelOpen = (page) => page.evaluate(() => !!document.querySelector('[data-sidebar-right-panel][data-sidebar-right-open]'))

// 1) 纯函数能力自检：缺方法必须报告；显式 placement 必须直通。
const missing = checkWrapSupport({ openResource: () => {}, openTab: () => {} })
results.assert('g5.support.missing-detected', missing.ok === false && missing.missing.includes('float'), { actual: missing })
results.assert('g5.decide.explicit-passthrough', decideOpen({ destination: 'sidebar' }).redirect === false && decideOpen({ paneId: 'p' }).redirect === false, { actual: decideOpen({ destination: 'sidebar' }) })
results.assert('g5.decide.default-redirect', decideOpen({ params: { line: 3 } }).redirect === true, { actual: decideOpen({ params: { line: 3 } }) })

let app = null
try {
  readServerUrl()
  app = await openApp({ viewport: { width: 1440, height: 900 } })
  const { page } = app
  results.captureErrors(app.handles)
  const stage = await enterStage(page, { count: 3 })
  const sessionId = await mountedSessionId(page)
  results.assert('g5.stage.ready', !!sessionId, { actual: { sessionId, stage } })
  const wrap = await p3Call(page, 'wrap')
  results.assert('g5.wrap.enabled-in-stage', wrap.value && wrap.value.enabled === true, { actual: wrap.value })

  // 2) 非法资源地址：官方错误原样抛给调用方（不吞、不产生浮窗/记录）
  const badAddress = await actionCall(page, 'companionOpenResource', null, 'dsh-resource://noop/not-claimable.txt')
  const badAddressInner = badAddress.value || {}
  const badAddressCounts = await p3Call(page, 'floatMode')
  results.assert('g5.bad-address.throws-passthrough', badAddressInner.ok === false && badAddressInner.reason === 'throw' && String(badAddressInner.error || '').includes('no registered tab type'), { actual: badAddressInner })
  results.assert('g5.bad-address.no-side-effect', (await floatCount(page)) === 0 && badAddressCounts.value.counts.total === 0, { actual: { floats: await floatCount(page), counts: badAddressCounts.value.counts } })
  results.assert('g5.bad-address.no-pageerror', app.handles.pageErrors.length === 0, { actual: app.handles.pageErrors.slice(0, 3) })

  // 3) 未注册 kind：被官方 kind 校验/适配层守卫拒绝（不产生浮窗）；行为与 P1 守卫一致
  const badKind = await actionCall(page, 'companionOpenTab', null, 'no-such-kind')
  const badKindInner = badKind.value || {}
  results.assert('g5.bad-kind.rejected', badKindInner.ok === false && (badKindInner.reason === 'throw' || String(badKindInner.reason || '').startsWith('kind-missing')), { actual: badKindInner })
  results.assert('g5.bad-kind.no-side-effect', (await floatCount(page)) === 0, { actual: { floats: await floatCount(page) } })

  // 4) split 形态：包装层禁用、打开直通官方（无浮窗）
  const splitMode = await p3Call(page, 'floatSetMode', 'split')
  await sleep(500)
  const splitWrap = await p3Call(page, 'wrap')
  const splitOpen = await actionCall(page, 'companionOpenResource', null, fileAddress(sessionId, 'README.md'))
  await sleep(400)
  results.assert('g5.split.wrap-disabled', splitWrap.value.enabled === false, { actual: splitWrap.value })
  results.assert('g5.split.open-passthrough', splitOpen.ok === true && (await floatCount(page)) === 0 && (await panelOpen(page)) === true, { actual: { open: splitOpen, floats: await floatCount(page), panelOpen: await panelOpen(page) } })
  await p3Call(page, 'floatSetMode', 'float')
  await sleep(300)

  // 5) 非舞台：包装层禁用，打开回到官方右栏（无浮窗）
  await leaveStage(page)
  await sleep(600)
  const outside = await p3Call(page, 'wrap')
  const outsideOpen = await actionCall(page, 'companionOpenResource', null, fileAddress(sessionId, 'CHANGELOG.md'))
  await sleep(400)
  results.assert('g5.nonstage.wrap-disabled', outside.value.enabled === false, { actual: outside.value })
  results.assert('g5.nonstage.official-behavior', outsideOpen.ok === true && (await floatCount(page)) === 0, { actual: { open: outsideOpen, floats: await floatCount(page) } })
  results.assert('g5.no-pageerror', app.handles.pageErrors.length === 0, { actual: app.handles.pageErrors.slice(0, 5) })
} catch (error) {
  results.fatal(error)
} finally {
  await closeApp(app)
}
const summary = results.finish()
fs.mkdirSync(OUT, { recursive: true })
process.exitCode = summary.ok ? 0 : 1
