/** P3-4/P3-10 产品链路：真实消费者路径、逐帧无重排、多窗槽位、满槽、开收、形态菜单、Q2、会话切换、非舞台。 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const require = createRequire(path.join(ROOT, 'tools', 'pw') + path.sep)
const { chromium } = require('playwright-core')
const url = fs.readFileSync(path.join(ROOT, 'artifacts', 'p3', 'server-url.txt'), 'utf8').split(/\r?\n/)[0].trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = path.join(ROOT, 'artifacts', 'p3', 'verify', 'product-floats.json')

const out = { ok: false, steps: [], errors: [], pageErrors: [], consoleErrors: [] }
const step = (name, data) => {
  const entry = { name, at: new Date().toISOString(), data: data === undefined ? null : data }
  out.steps.push(entry)
  console.log('[step] ' + name + ' ' + JSON.stringify(data).slice(0, 600))
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
const page = await context.newPage()
page.on('pageerror', (e) => { out.pageErrors.push(String(e).slice(0, 300)); out.errors.push('pageerror:' + String(e).slice(0, 300)) })
page.on('console', (m) => { if (m.type() === 'error') { out.consoleErrors.push(m.text().slice(0, 200)) } })
out.httpFailures = []
page.on('response', (response) => {
  if (response.status() >= 400) out.httpFailures.push({ status: response.status(), url: response.url().slice(0, 300) })
})

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('[role="textbox"], [contenteditable="true"]', { timeout: 60000 })
  await page.waitForFunction(() => !!window.__ONESTEP__, null, { timeout: 40000 })
  await sleep(1200)
  const rows = await page.evaluate(() => Object.keys(window.__ONESTEP__.actions.listSessions()).slice(0, 3))
  await page.evaluate((ids) => window.__ONESTEP__.actions.enterStage(ids), rows)
  await sleep(1300)

  // 通用读取器（页面内）
  const read = `() => {
    const p3 = window.__ONESTEP__.actions.p3
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    const stage = document.querySelector('[data-onestep-stage]')
    const panel = document.querySelector('[data-sidebar-right-panel]')
    return {
      stage: rect(stage),
      focus: rect(stage && stage.querySelector('.onestep-frame[data-mode="focus"]')),
      expanded: !!(panel && panel.hasAttribute('data-sidebar-right-open')),
      floats: Array.from(document.querySelectorAll('[data-dockkit-float]')).map((el) => {
        const r = el.getBoundingClientRect()
        return { tabId: el.getAttribute('data-dockkit-content'), paneId: el.getAttribute('data-dockkit-float'), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, peeked: el.getAttribute('data-onestep-peek') === '1', inert: el.hasAttribute('inert') }
      }),
      mode: p3.floatMode().value,
      wrap: p3.wrap().value,
      toast: (window.__ONESTEP__.actions.snapshot().feedback || {}).toast || null,
      tabCount: (p3.floatSnapshot().value.openTabs || []).length,
    }
  }`

  step('initial', await page.evaluate((readSrc) => eval('(' + readSrc + ')()'), read))

  // A) 首个打开：逐帧采样（真实消费者路径）
  const sessionId = await page.evaluate(() => window.__ONESTEP__.actions.p3.snapshot().mounted)
  out.sessionId = sessionId
  const address = (file) => 'dsh-resource://file/session/' + sessionId + '/' + file
  const frameOpen = await page.evaluate(async ({ address, readSrc }) => {
    const record = eval('(' + readSrc + ')')
    const samples = []
    let result = null
    let n = 0
    await new Promise((resolve) => {
      const loop = () => {
        samples.push(record())
        if (n === 0) {
          try { result = window.__ONESTEP__.actions.companionOpenResource(null, address) } catch (error) { result = { thrown: String(error) } }
        }
        n += 1
        if (n < 40) requestAnimationFrame(loop)
        else resolve()
      }
      requestAnimationFrame(loop)
    })
    return { result, samples }
  }, { address: address('README.md'), readSrc: read })
  const focusKeys = new Set(frameOpen.samples.map((s) => s.focus && JSON.stringify(s.focus)))
  const stageKeys = new Set(frameOpen.samples.map((s) => s.stage && JSON.stringify(s.stage)))
  const openFrames = frameOpen.samples.map((s, i) => (s.expanded ? i : -1)).filter((i) => i >= 0)
  const floatFrames = frameOpen.samples.map((s, i) => (s.floats.length > 0 ? i : -1)).filter((i) => i >= 0)
  step('A.open1.frames', {
    result: frameOpen.result,
    focusVariants: [...focusKeys],
    stageVariants: [...stageKeys],
    expandedFrameIndexes: openFrames,
    firstFloatFrame: floatFrames[0] === undefined ? null : floatFrames[0],
    final: frameOpen.samples[frameOpen.samples.length - 1],
  })
  await sleep(250)

  // B) 第二个：CHANGELOG.md → 槽位 1
  step('B.open2', await page.evaluate(({ address, readSrc }) => {
    const result = window.__ONESTEP__.actions.companionOpenResource(null, address)
    return { result, state: eval('(' + readSrc + ')()') }
  }, { address: address('CHANGELOG.md'), readSrc: read }))
  await sleep(250)

  // C) 第三个：package.json → 槽位 2
  step('C.open3', await page.evaluate(({ address, readSrc }) => {
    const result = window.__ONESTEP__.actions.companionOpenResource(null, address)
    return { result, state: eval('(' + readSrc + ')()') }
  }, { address: address('package.json'), readSrc: read }))
  await sleep(250)

  // D) 同内容重开（README.md）：tab 数不增、不新增浮窗
  step('D.reopen', await page.evaluate(({ address, readSrc }) => {
    const before = eval('(' + readSrc + ')()')
    const result = window.__ONESTEP__.actions.companionOpenResource(null, address)
    return { before: { tabCount: before.tabCount, floats: before.floats.length }, result, after: eval('(' + readSrc + ')()') }
  }, { address: address('README.md'), readSrc: read }))
  await sleep(250)

  // E) 第四个：LICENSE → 满槽淘汰（Q13）并复用槽位
  step('E.fullslot', await page.evaluate(({ address, readSrc }) => {
    const result = window.__ONESTEP__.actions.companionOpenResource(null, address)
    return { result, state: eval('(' + readSrc + ')()'), floatState: window.__ONESTEP__.actions.p3.floatState().value }
  }, { address: address('LICENSE'), readSrc: read }))
  await sleep(300)

  // F) ⇥ 按钮：全部收起 → 再点恢复（UI 路径）
  step('F.toggle.peek', await page.evaluate(async () => {
    const button = document.querySelector('[data-onestep-companion-toggle]')
    if (!button) return { error: 'no-toggle-button' }
    button.click()
    await new Promise((r) => setTimeout(r, 350))
    const peeked = Array.from(document.querySelectorAll('[data-dockkit-float]')).map((el) => ({ tabId: el.getAttribute('data-dockkit-content'), peeked: el.getAttribute('data-onestep-peek') === '1', inert: el.hasAttribute('inert'), transform: getComputedStyle(el).transform, pointerEvents: getComputedStyle(el).pointerEvents }))
    return { afterClick: peeked, mode: window.__ONESTEP__.actions.p3.floatMode().value }
  }))
  step('F.toggle.restore', await page.evaluate(async () => {
    document.querySelector('[data-onestep-companion-toggle]').click()
    await new Promise((r) => setTimeout(r, 400))
    const floats = Array.from(document.querySelectorAll('[data-dockkit-float]')).map((el) => {
      const r = el.getBoundingClientRect()
      return { tabId: el.getAttribute('data-dockkit-content'), peeked: el.getAttribute('data-onestep-peek') === '1', transform: getComputedStyle(el).transform, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    })
    const visible = floats.filter((item) => !item.peeked)
    let overlaps = 0
    for (let i = 0; i < visible.length; i += 1) {
      for (let j = i + 1; j < visible.length; j += 1) {
        const a = visible[i].rect
        const b = visible[j].rect
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        if (ox > 1 && oy > 1) overlaps += 1
      }
    }
    return { floats, visible: visible.length, overlaps, mode: window.__ONESTEP__.actions.p3.floatMode().value }
  }))
  await sleep(200)

  // G) 「…」菜单 → 形态切到 split（UI 路径）→ 浮窗全部 dock
  step('G.menu.split', await page.evaluate(async () => {
    document.querySelector('[data-onestep-more]').click()
    await new Promise((r) => setTimeout(r, 150))
    const item = document.querySelector('[data-onestep-companion-mode]')
    const label = item ? item.textContent : null
    const modeBefore = item ? item.getAttribute('data-onestep-companion-mode') : null
    if (item) item.click()
    await new Promise((r) => setTimeout(r, 500))
    const panel = document.querySelector('[data-sidebar-right-panel]')
    return {
      label, modeBefore,
      mode: window.__ONESTEP__.actions.p3.floatMode().value,
      floats: document.querySelectorAll('[data-dockkit-float]').length,
      expanded: !!(panel && panel.hasAttribute('data-sidebar-right-open')),
      focus: (() => { const f = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]'); const r = f.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) } })(),
    }
  }))
  await sleep(300)

  // H) split 形态下打开 → 直通官方（无浮窗）
  step('H.split.open', await page.evaluate(({ address, readSrc }) => {
    const result = window.__ONESTEP__.actions.companionOpenResource(null, address)
    return { result, state: eval('(' + readSrc + ')()') }
  }, { address: address('docs/p3-plan.md'), readSrc: read }))
  await sleep(300)

  // I) 菜单切回 float
  step('I.menu.float', await page.evaluate(async () => {
    document.querySelector('[data-onestep-more]').click()
    await new Promise((r) => setTimeout(r, 150))
    const item = document.querySelector('[data-onestep-companion-mode]')
    const label = item ? item.textContent : null
    if (item) item.click()
    await new Promise((r) => setTimeout(r, 400))
    return { label, mode: window.__ONESTEP__.actions.p3.floatMode().value }
  }))
  await sleep(250)

  // J) float 形态下再打开 → 新浮窗、无 push
  step('J.float.open', await page.evaluate(({ address, readSrc }) => {
    const before = eval('(' + readSrc + ')()')
    const result = window.__ONESTEP__.actions.companionOpenResource(null, address)
    return { before: { focus: before.focus, expanded: before.expanded }, result, after: eval('(' + readSrc + ')()') }
  }, { address: address('SECURITY.md'), readSrc: read }))
  await sleep(300)

  // K) Q2：确保右栏展开后打开 → 直通（不重定向）
  step('K.q2.expanded', await page.evaluate(async ({ address, readSrc }) => {
    const p3 = window.__ONESTEP__.actions.p3
    const isOpen = () => !!document.querySelector('[data-sidebar-right-panel][data-sidebar-right-open]')
    if (!isOpen()) p3.toggleExpanded()
    await new Promise((r) => setTimeout(r, 450))
    const before = eval('(' + readSrc + ')()')
    const result = window.__ONESTEP__.actions.companionOpenResource(null, address)
    const after = eval('(' + readSrc + ')()')
    if (isOpen()) p3.toggleExpanded()
    return { before: { expanded: before.expanded, floats: before.floats.length }, result, after: { expanded: after.expanded, floats: after.floats.length, wrap: after.wrap.enabled }, focus: after.focus }
  }, { address: address('docs/p3/contracts.md'), readSrc: read }))
  await sleep(200)

  // L) 会话切换对账：切到候场会话 → 该会话计数为 0；切回 → 原会话 managed 浮窗保留
  step('L.session-switch', await page.evaluate(async () => {
    const actions = window.__ONESTEP__.actions
    const p3 = actions.p3
    const before = p3.floatState().value
    const oldSession = Object.keys(before.state.bySession)[0]
    const snapshot = actions.snapshot()
    const target = snapshot.candidates[0]
    actions.promote(target)
    await new Promise((r) => setTimeout(r, 1000))
    const switched = { focus: actions.snapshot().focusId, mode: p3.floatMode().value, floats: document.querySelectorAll('[data-dockkit-float]').length }
    actions.focusSession(oldSession)
    await new Promise((r) => setTimeout(r, 1000))
    const back = { focus: actions.snapshot().focusId, mode: p3.floatMode().value, floats: document.querySelectorAll('[data-dockkit-float]').length, state: p3.floatState().value.state.bySession[oldSession] && p3.floatState().value.state.bySession[oldSession].floats.map((item) => ({ tabId: item.tabId, slot: item.slot, peeked: item.peeked })) }
    return { oldSession, target, switched, back }
  }))

  // M) 退出舞台后打开 → 官方右栏（包装禁用；已有浮窗按 Q5 保留）
  step('M.nonstage', await page.evaluate(({ address, readSrc }) => {
    window.__ONESTEP__.actions.exitStage()
    const result = window.__ONESTEP__.actions.companionOpenResource(null, address)
    return { result, state: eval('(' + readSrc + ')()') }
  }, { address: address('docs/p2-plan.md'), readSrc: read }))

  out.ok = out.pageErrors.length === 0
} catch (error) {
  out.fatal = String((error && error.stack) || error)
  out.ok = false
} finally {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  out.finishedAt = new Date().toISOString()
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8')
  console.log('[' + (out.ok ? 'OK' : 'FAIL') + '] wrote ' + path.relative(ROOT, OUT) + ' steps=' + out.steps.length + ' errors=' + out.errors.length)
  await browser.close()
}
process.exitCode = out.ok ? 0 : 1
