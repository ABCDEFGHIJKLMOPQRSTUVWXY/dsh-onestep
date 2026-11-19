/** P3-11 收起与边缘标签层：点击浮窗外、标签恢复、键盘、MutationObserver 重放、会话隔离。 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const require = createRequire(path.join(ROOT, 'tools', 'pw') + path.sep)
const { chromium } = require('playwright-core')
const url = fs.readFileSync(path.join(ROOT, 'artifacts', 'p3', 'server-url.txt'), 'utf8').split(/\r?\n/)[0].trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = path.join(ROOT, 'artifacts', 'p3', 'verify', 'peek-tags.json')

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
page.on('response', (r) => { if (r.status() >= 400) out.httpFailures.push({ status: r.status(), url: r.url().slice(0, 200) }) })

const read = `() => {
  const tags = Array.from(document.querySelectorAll('[data-onestep-peek-tag]')).map((el) => ({
    tabId: el.getAttribute('data-onestep-peek-tag'),
    label: el.getAttribute('aria-label'),
    expanded: el.getAttribute('aria-expanded'),
    controls: el.getAttribute('aria-controls'),
    text: el.textContent,
    rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })(),
  }))
  const floats = Array.from(document.querySelectorAll('[data-dockkit-float]')).map((el) => {
    const r = el.getBoundingClientRect()
    return { tabId: el.getAttribute('data-dockkit-content'), id: el.id || null, peeked: el.getAttribute('data-onestep-peek') === '1', inert: el.hasAttribute('inert'), ariaHidden: el.getAttribute('aria-hidden'), transform: getComputedStyle(el).transform, pointerEvents: getComputedStyle(el).pointerEvents, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  })
  const layer = document.querySelector('[data-onestep-peek-layer]')
  return {
    tags,
    floats,
    layer: layer ? { zIndex: getComputedStyle(layer).zIndex, position: getComputedStyle(layer).position, pointerEvents: getComputedStyle(layer).pointerEvents, parentIsBody: layer.parentElement === document.body } : null,
    activeTag: document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-onestep-peek-tag') : null,
    counts: window.__ONESTEP__.actions.p3.floatMode().value,
    tagsProbe: window.__ONESTEP__.actions.p3.floatTags().value,
    mode: window.__ONESTEP__.actions.p3.floatMode().value.mode,
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

  // 开 3 个浮窗
  await page.evaluate(async ({ files }) => {
    for (const file of files) {
      window.__ONESTEP__.actions.companionOpenResource(null, file)
      await new Promise((r) => setTimeout(r, 260))
    }
  }, { files: [address('README.md'), address('CHANGELOG.md'), address('package.json')] })
  await sleep(400)
  out.open = await page.evaluate((readSrc) => eval('(' + readSrc + ')()'), read)
  step('open3', { floats: out.open.floats.length, labels: out.open.floats.map((f) => f.tabId) })

  // A) 点击浮窗外（焦点窗中部）→ 全部收起 + 标签层
  await page.mouse.click(300, 820)
  await sleep(450)
  step('A.peekAll', await page.evaluate((readSrc) => eval('(' + readSrc + ')()'), read))
  await page.screenshot({ path: path.join(ROOT, 'artifacts', 'p3', 'verify', 'p3-11-peek-tags.png') })

  // B) 点击第二个标签 → 只恢复该窗
  const secondTab = await page.evaluate((readSrc) => {
    const state = eval('(' + readSrc + ')()')
    const tags = state.tags
    if (tags.length < 2) return null
    const target = tags[1].tabId
    tags[1] && document.querySelector('[data-onestep-peek-tag="' + target + '"]').click()
    return target
  }, read)
  await sleep(450)
  step('B.restoreOne', { target: secondTab, state: await page.evaluate((readSrc) => eval('(' + readSrc + ')()'), read) })

  // C) 键盘：聚焦第一个标签，真实 Enter 恢复
  const cTarget = await page.evaluate(() => {
    const tag = document.querySelector('[data-onestep-peek-tag]')
    if (!tag) return null
    tag.focus()
    return tag.getAttribute('data-onestep-peek-tag')
  })
  if (cTarget) await page.keyboard.press('Enter')
  await sleep(450)
  const keyboard = await page.evaluate((readSrc) => eval('(' + readSrc + ')()'), read)
  step('C.keyboardRestore', { target: cTarget, visible: keyboard.floats.filter((float) => !float.peeked).map((float) => float.tabId), tags: keyboard.tags.length })

  // D) 再次全部收起 → 官方 re-render 后注入保留；手动剥离后 observer 重放
  await page.mouse.click(300, 820)
  await sleep(400)
  const domReplay = await page.evaluate(async (readSrc) => {
    const p3 = window.__ONESTEP__.actions.p3
    const before = eval('(' + readSrc + ')()')
    // 触发官方 re-render：展开/收起右栏
    p3.toggleExpanded()
    await new Promise((r) => setTimeout(r, 350))
    p3.toggleExpanded()
    await new Promise((r) => setTimeout(r, 350))
    const afterRerender = eval('(' + readSrc + ')()')
    // 手动破坏注入，验证 MutationObserver 重放
    const peeked = document.querySelectorAll('[data-onestep-peek="1"]')
    for (const element of Array.from(peeked)) {
      element.removeAttribute('data-onestep-peek')
      element.removeAttribute('inert')
      element.removeAttribute('aria-hidden')
      element.style.removeProperty('transform')
      element.style.removeProperty('pointer-events')
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 120))))
    const afterReplay = eval('(' + readSrc + ')()')
    return { before: { peeked: before.floats.filter((f) => f.peeked).length, tags: before.tags.length }, afterRerender: { peeked: afterRerender.floats.filter((f) => f.peeked).length, tags: afterRerender.tags.length }, afterReplay: { peeked: afterReplay.floats.filter((f) => f.peeked).length, tags: afterReplay.tags.length, inert: afterReplay.floats.filter((f) => f.inert).length } }
  }, read)
  step('D.observerReplay', domReplay)

  // E) 会话隔离：切到候场会话 → 无标签；切回 → 收起态仍在
  const switching = await page.evaluate(async () => {
    const actions = window.__ONESTEP__.actions
    const p3 = actions.p3
    const oldSession = p3.snapshot().mounted
    const snapshot = actions.snapshot()
    const target = snapshot.candidates[0]
    actions.promote(target)
    await new Promise((r) => setTimeout(r, 1000))
    const switched = { focus: actions.snapshot().focusId, tags: document.querySelectorAll('[data-onestep-peek-tag]').length, peak: p3.floatTags().value }
    actions.focusSession(oldSession)
    await new Promise((r) => setTimeout(r, 1200))
    const back = { focus: actions.snapshot().focusId, tags: document.querySelectorAll('[data-onestep-peek-tag]').length, floats: document.querySelectorAll('[data-dockkit-float]').length, peeked: document.querySelectorAll('[data-onestep-peek="1"]').length, peak: p3.floatTags().value }
    return { oldSession, target, switched, back }
  })
  step('E.sessionIsolation', switching)


  // F) 标签层拖动定位（US-3/4 / G3：桌面窗口控制遮挡 → 安全默认 + 拖动/键盘持久化）
  const trackTop = () => page.evaluate(() => {
    const track = document.querySelector('[data-onestep-peek-track]')
    if (!track) return null
    const rect = track.getBoundingClientRect()
    return { top: Math.round(rect.top), left: Math.round(rect.left), height: Math.round(rect.height), inlineTop: track.style.top }
  })
  const gripRect = () => page.evaluate(() => {
    const grip = document.querySelector('[data-onestep-peek-grip]')
    if (!grip) return null
    const rect = grip.getBoundingClientRect()
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), label: grip.getAttribute('aria-label'), tag: grip.getAttribute('data-onestep-peek-grip') }
  })
  const storedTop = () => page.evaluate(() => {
    try {
      const state = JSON.parse(localStorage.getItem('dsh.onestep.companion.v1') || '{}')
      return state && state.ui ? state.ui.peekTop : undefined
    } catch (_error) { return 'parse-error' }
  })

  // F1) 桌面标题栏模拟：--dsh-windows-titlebar-height=40px 时默认 top=56（不压窗口控制）
  await context.addInitScript(() => {
    const apply = () => { try { document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '40px') } catch (_error) {} }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply)
    else apply()
  })
  await page.evaluate(() => { try { localStorage.removeItem('dsh.onestep.companion.v1') } catch (_error) {} })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[role="textbox"], [contenteditable="true"]', { timeout: 60000 })
  await page.waitForFunction(() => !!window.__ONESTEP__, null, { timeout: 40000 })
  await sleep(1400)
  const rows2 = await page.evaluate(() => Object.keys(window.__ONESTEP__.actions.listSessions()).slice(0, 3))
  await page.evaluate((ids) => window.__ONESTEP__.actions.enterStage(ids), rows2)
  await sleep(1300)
  const sessionId2 = await page.evaluate(() => window.__ONESTEP__.actions.p3.snapshot().mounted)
  const address2 = (f) => 'dsh-resource://file/session/' + sessionId2 + '/' + f
  await page.evaluate(async ({ files }) => {
    for (const f of files) {
      window.__ONESTEP__.actions.companionOpenResource(null, f)
      await new Promise((r) => setTimeout(r, 280))
    }
  }, { files: [address2('README.md'), address2('CHANGELOG.md')] })
  await sleep(400)
  await page.evaluate(() => window.__ONESTEP__.actions.p3.floatPeekAll())
  await sleep(450)
  const defaultTop = await trackTop()
  const grip = await gripRect()
  step('F1.defaultSafeTop', { track: defaultTop, grip, titlebarVar: await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height').trim()) })

  // F2) 真实鼠标拖动 grip 向下 120px → 位置变化并持久化到 localStorage
  const beforeDrag = await trackTop()
  if (grip) {
    await page.mouse.move(grip.x, grip.y)
    await page.mouse.down()
    await page.mouse.move(grip.x, grip.y + 60, { steps: 6 })
    await page.mouse.move(grip.x, grip.y + 120, { steps: 6 })
    await page.mouse.up()
    await sleep(300)
  }
  const afterDrag = await trackTop()
  const persistedDrag = await storedTop()
  step('F2.drag', { before: beforeDrag, after: afterDrag, persisted: persistedDrag })
  await page.screenshot({ path: path.join(ROOT, 'artifacts', 'p3', 'verify', 'p3-11-peek-tags-dragged.png') })

  // F3) 键盘微调：↑ 8px / Shift+↑ 24px / Home 回安全位
  const keyboardAnchor = await page.evaluate(() => {
    const grip = document.querySelector('[data-onestep-peek-grip]')
    if (!grip) return null
    grip.focus()
    return !!document.activeElement && document.activeElement.getAttribute('data-onestep-peek-grip') === '1'
  })
  if (keyboardAnchor) await page.keyboard.press('ArrowDown')
  await sleep(250)
  const afterArrow = await trackTop()
  if (keyboardAnchor) await page.keyboard.press('Shift+ArrowDown')
  await sleep(250)
  const afterShift = await trackTop()
  if (keyboardAnchor) await page.keyboard.press('Home')
  await sleep(250)
  const afterHome = await trackTop()
  step('F3.keyboard', { focused: keyboardAnchor, afterArrow, afterShift, afterHome, persisted: await storedTop() })

  // F4) 刷新后位置保持（持久化 → 重新收起）
  const persistedBeforeReload = await storedTop()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[role="textbox"], [contenteditable="true"]', { timeout: 60000 })
  await page.waitForFunction(() => !!window.__ONESTEP__, null, { timeout: 40000 })
  await sleep(1500)
  const rows3 = await page.evaluate(() => Object.keys(window.__ONESTEP__.actions.listSessions()).slice(0, 3))
  await page.evaluate((ids) => window.__ONESTEP__.actions.enterStage(ids), rows3)
  await sleep(1300)
  const sessionId3 = await page.evaluate(() => window.__ONESTEP__.actions.p3.snapshot().mounted)
  const address3 = (f) => 'dsh-resource://file/session/' + sessionId3 + '/' + f
  await page.evaluate(async ({ files }) => {
    for (const f of files) {
      window.__ONESTEP__.actions.companionOpenResource(null, f)
      await new Promise((r) => setTimeout(r, 280))
    }
  }, { files: [address3('README.md'), address3('CHANGELOG.md')] })
  await sleep(400)
  await page.evaluate(() => window.__ONESTEP__.actions.p3.floatPeekAll())
  await sleep(500)
  const afterReload = await trackTop()
  step('F4.reloadPersist', { persistedBeforeReload, afterReload, probeTop: await page.evaluate(() => window.__ONESTEP__.actions.p3.floatTagTop()) })

  out.tagDrag = {
    defaultTop: defaultTop && defaultTop.top,
    expectedDefault: 56,
    gripLabel: grip && grip.label,
    dragDelta: beforeDrag && afterDrag ? afterDrag.top - beforeDrag.top : null,
    persistedDrag,
    keyboard: { afterArrow: afterArrow && afterArrow.top, afterShift: afterShift && afterShift.top, afterHome: afterHome && afterHome.top },
    reload: { persisted: persistedBeforeReload, afterReload: afterReload && afterReload.top },
    pass: {
      defaultSafe: !!defaultTop && defaultTop.top === 56,
      gripPresent: !!grip && !!grip.label,
      dragMoved: !!beforeDrag && !!afterDrag && afterDrag.top >= beforeDrag.top + 60,
      dragPersisted: typeof persistedDrag === 'number',
      keyboardMoved: !!afterArrow && !!afterShift && afterArrow.top === afterShift.top - 24,
      reloadKept: !!afterReload && !!persistedBeforeReload && Math.abs(afterReload.top - persistedBeforeReload) <= 1,
    },
  }
  out.tagDrag.ok = Object.values(out.tagDrag.pass).every(Boolean)

  out.ok = out.pageErrors.length === 0 && (!out.tagDrag || out.tagDrag.ok)
  out.final = await page.evaluate((readSrc) => eval('(' + readSrc + ')()'), read)
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
