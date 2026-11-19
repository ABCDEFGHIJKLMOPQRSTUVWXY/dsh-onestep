/**
 * P3-6 G8 视觉/无障碍门禁：双主题 + 1280/860 截图、标签层 z/aria、键盘恢复、reduced motion。
 */
import path from 'node:path'
import fs from 'node:fs'

import { ROOT, Results, readServerUrl, openApp, closeApp, sleep, p3Call, actionCall, enterStage, mountedSessionId, fileAddress, domState, waitFor } from '../probe/lib.mjs'

const OUT = path.join(ROOT, 'artifacts', 'p3', 'verify')
const SHOTS = path.join(OUT, 'shots')
const results = new Results('g8-visual', 'P3-6 G8 视觉/无障碍（主题/视口/键盘/动效）', path.join(OUT, 'g8-visual.json'))
fs.mkdirSync(SHOTS, { recursive: true })

const FILES = ['README.md', 'CHANGELOG.md', 'package.json', 'LICENSE']
const shot = async (page, name) => results.shot(page, name, SHOTS)
const openFloats = async (page, sessionId, count) => {
  for (let index = 0; index < count; index += 1) {
    await actionCall(page, 'companionOpenResource', null, fileAddress(sessionId, FILES[index % FILES.length]))
    await sleep(320)
  }
}

let app = null
try {
  readServerUrl()

  // 1) 亮色 1440：三浮窗 + 收起标签层截图与断言
  app = await openApp({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
  let { page } = app
  results.captureErrors(app.handles)
  await enterStage(page, { count: 3 })
  const sessionId = await mountedSessionId(page)
  await openFloats(page, sessionId, 3)
  const three = await p3Call(page, 'floatMode')
  results.assert('g8.light.three-floats', three.value.counts.visible === 3, { actual: three.value.counts })
  await shot(page, 'p3-g8-light-1440-floats.png')

  await page.mouse.click(300, 820)
  await sleep(450)
  const peeked = await page.evaluate(() => {
    const tags = Array.from(document.querySelectorAll('[data-onestep-peek-tag]'))
    const layer = document.querySelector('[data-onestep-peek-layer]')
    return {
      tags: tags.length,
      labels: tags.map((el) => el.getAttribute('aria-label')),
      roles: tags.every((el) => el.tagName === 'BUTTON' && el.getAttribute('aria-expanded') === 'false' && el.getAttribute('aria-controls')),
      layerZ: layer ? getComputedStyle(layer).zIndex : null,
      layerRole: layer ? layer.getAttribute('role') : null,
      floats: Array.from(document.querySelectorAll('[data-dockkit-float]')).map((el) => ({ peeked: el.getAttribute('data-onestep-peek') === '1', inert: el.hasAttribute('inert'), ariaHidden: el.getAttribute('aria-hidden') })),
    }
  })
  results.assert('g8.peek.tags-rendered', peeked.tags === 3 && peeked.labels.every(Boolean) && peeked.roles === true, { actual: { tags: peeked.tags, labels: peeked.labels.slice(0, 2), roles: peeked.roles } })
  results.assert('g8.peek.layer-z', peeked.layerZ === '63' && peeked.layerRole === 'toolbar', { actual: { layerZ: peeked.layerZ, layerRole: peeked.layerRole } })
  results.assert('g8.peek.inert', peeked.floats.every((item) => item.peeked && item.inert && item.ariaHidden === 'true'), { actual: peeked.floats })
  await shot(page, 'p3-g8-light-1440-peek-tags.png')

  // 键盘：聚焦第一个标签 → Enter 恢复
  const tagId = await page.evaluate(() => {
    const tag = document.querySelector('[data-onestep-peek-tag]')
    if (!tag) return null
    tag.focus()
    return tag.getAttribute('data-onestep-peek-tag')
  })
  if (tagId) await page.keyboard.press('Enter')
  await sleep(450)
  const afterKeyboard = await page.evaluate(() => ({ tags: document.querySelectorAll('[data-onestep-peek-tag]').length, visible: Array.from(document.querySelectorAll('[data-dockkit-float]')).filter((el) => el.getAttribute('data-onestep-peek') !== '1').length }))
  results.assert('g8.keyboard.enter-restores', !!tagId && afterKeyboard.tags === 2 && afterKeyboard.visible >= 1, { actual: { tagId, afterKeyboard } })
  results.assert('g8.no-pageerror-light', app.handles.pageErrors.length === 0, { actual: app.handles.pageErrors.slice(0, 3) })
  await closeApp(app)

  // 2) 暗色 1440：浮窗 + 收起标签截图
  app = await openApp({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
  page = app.page
  results.captureErrors(app.handles)
  await enterStage(page, { count: 3 })
  const darkSession = await mountedSessionId(page)
  await openFloats(page, darkSession, 2)
  await shot(page, 'p3-g8-dark-1440-floats.png')
  await page.mouse.click(300, 820)
  await sleep(450)
  await shot(page, 'p3-g8-dark-1440-peek-tags.png')
  const darkTagCount = await page.evaluate(() => document.querySelectorAll('[data-onestep-peek-tag]').length)
  results.assert('g8.dark.peek-tags', darkTagCount === 2, { actual: { tags: darkTagCount } })
  results.assert('g8.no-pageerror-dark', app.handles.pageErrors.length === 0, { actual: app.handles.pageErrors.slice(0, 3) })
  await closeApp(app)

  // 3) reduced motion：标签层无过渡动画
  app = await openApp({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  page = app.page
  results.captureErrors(app.handles)
  await enterStage(page, { count: 3 })
  const rmSession = await mountedSessionId(page)
  await openFloats(page, rmSession, 1)
  await page.mouse.click(300, 820)
  await sleep(450)
  const motion = await page.evaluate(() => {
    const tag = document.querySelector('[data-onestep-peek-tag]')
    return tag ? { duration: getComputedStyle(tag).transitionDuration, floatTransform: getComputedStyle(document.querySelector('[data-dockkit-float]')).transform } : null
  })
  results.assert('g8.reduced-motion.no-transition', !!motion && motion.duration.split(',').every((value) => value.trim() === '0s'), { actual: motion })
  await closeApp(app)

  // 4) 1280 / 860 视口槽位截图与几何断言
  for (const viewport of [{ width: 1280, height: 900 }, { width: 860, height: 900 }]) {
    app = await openApp({ viewport })
    page = app.page
    results.captureErrors(app.handles)
    await enterStage(page, { count: 3 })
    const sid = await mountedSessionId(page)
    const slots = await p3Call(page, 'floatSlots')
    const count = slots.value && slots.value.maxSlots ? slots.value.maxSlots : 1
    await openFloats(page, sid, count)
    await sleep(400)
    const state = await domState(page)
    const geometry = await page.evaluate(() => {
      const floats = Array.from(document.querySelectorAll('[data-dockkit-float]')).map((el) => {
        const rect = el.getBoundingClientRect()
        return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
      })
      return { floats }
    })
    const within = geometry.floats.every((rect) => rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= viewport.width + 1 && rect.y + rect.h <= viewport.height + 1)
    let overlaps = 0
    for (let i = 0; i < geometry.floats.length; i += 1) {
      for (let j = i + 1; j < geometry.floats.length; j += 1) {
        const a = geometry.floats[i]
        const b = geometry.floats[j]
        if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1) overlaps += 1
      }
    }
    results.assert('g8.viewport.' + viewport.width + '.geom', geometry.floats.length === count && within && overlaps === 0, { actual: { count, maxSlots: slots.value && slots.value.maxSlots, floats: geometry.floats, within, overlaps } })
    await shot(page, 'p3-g8-' + viewport.width + '-floats.png')
    results.assert('g8.no-pageerror-' + viewport.width, app.handles.pageErrors.length === 0, { actual: app.handles.pageErrors.slice(0, 3) })
    await closeApp(app)
    app = null
  }
} catch (error) {
  results.fatal(error)
} finally {
  await closeApp(app)
}
const summary = results.finish()
fs.mkdirSync(OUT, { recursive: true })
process.exitCode = summary.ok ? 0 : 1
