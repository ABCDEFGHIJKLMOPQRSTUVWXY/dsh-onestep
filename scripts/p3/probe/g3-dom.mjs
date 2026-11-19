/**
 * D14 / G3 DOM 适配探针（docs/p3-plan.md §5.5 / §6 G3 / §4.3 例外二）：
 * 1) 清点官方浮窗 DOM 契约：`[data-dockkit-float]` 属性、标题、dock/close/grip/resize 按钮、computed position/z-index。
 * 2) 注入 peek 属性（`data-onestep-peek` + transform/pointer-events + inert + aria-hidden），
 *    触发官方 re-render（新开浮窗 / toggleExpanded / focus）后检查是否保留；MutationObserver 记录增删改。
 * 3) z 层：body portal 的 fixed 右缘按钮（z 63）应盖过浮窗（浮窗层 60），且低于官方 dockkit tab 菜单（z 70）。
 * 4) 点击外部检测：document pointerdown capture 探针里 elementFromPoint/target 分类，验证 §5.5 触发规则可判定。
 */
import {
  Results, closeApp, domState, enterStage, fileAddress, isExpanded, log, mountedSessionId, openApp, p3Call,
  rectDeviation, sleep, slotLayout, stageLayout,
} from './lib.mjs'

const VIEWPORT = { width: 1440, height: 900 }
const results = new Results('g3-dom', 'D14 DOM 注入 + z 层 + 点击外部')
let app = null

try {
  app = await openApp({ viewport: VIEWPORT })
  const { page, handles } = app
  const stage = await enterStage(page, { count: 3 })
  const layout = await stageLayout(page)
  const mounted = await mountedSessionId(page)
  const slotInfo = slotLayout(layout.stage, { viewportWidth: VIEWPORT.width })
  const addresses = ['README.md', 'package.json'].map((relativePath) => fileAddress(mounted, relativePath))

  /* ---------------- 1. 官方浮窗 DOM 契约清点 ---------------- */
  const openA = await p3Call(page, 'openFloat', addresses[0], slotInfo.slots[0])
  await sleep(600)
  const inventory = await page.evaluate(() => {
    const round = (rect) => ({ x: Math.round(rect.x * 100) / 100, y: Math.round(rect.y * 100) / 100, w: Math.round(rect.width * 100) / 100, h: Math.round(rect.height * 100) / 100 })
    const floats = Array.from(document.querySelectorAll('[data-dockkit-float]')).map((el) => {
      const style = getComputedStyle(el)
      const rect = round(el.getBoundingClientRect())
      const titleEl = el.querySelector('[data-dockkit-float-title]')
      const gripEl = el.querySelector('[data-dockkit-float-grip]')
      return {
        tag: el.tagName,
        className: String(el.getAttribute('class') || '').slice(0, 160),
        attrs: {
          paneId: el.getAttribute('data-dockkit-float'),
          tabId: el.getAttribute('data-dockkit-content'),
          active: el.hasAttribute('data-dockkit-float-active'),
          host: el.getAttribute('data-dockkit-host'),
          paneAttr: el.getAttribute('data-dockkit-pane'),
          ariaHidden: el.getAttribute('aria-hidden'),
          inertProp: el.inert === true,
        },
        rect,
        styleAttr: String(el.getAttribute('style') || '').slice(0, 400),
        computed: {
          position: style.position, zIndex: style.zIndex, pointerEvents: style.pointerEvents,
          left: style.left, top: style.top, width: style.width, height: style.height,
          transform: style.transform, visibility: style.visibility, display: style.display,
        },
        cssVars: {
          x: style.getPropertyValue('--dsh-dockkit-float-x').trim(),
          y: style.getPropertyValue('--dsh-dockkit-float-y').trim(),
          width: style.getPropertyValue('--dsh-dockkit-float-width').trim(),
          height: style.getPropertyValue('--dsh-dockkit-float-height').trim(),
        },
        parent: el.parentElement ? {
          tag: el.parentElement.tagName,
          className: String(el.parentElement.getAttribute('class') || '').slice(0, 160),
          zIndex: getComputedStyle(el.parentElement).zIndex,
          position: getComputedStyle(el.parentElement).position,
          styleAttr: String(el.parentElement.getAttribute('style') || '').slice(0, 200),
        } : null,
        title: titleEl ? String(titleEl.textContent || '').slice(0, 120) : null,
        titleTag: titleEl ? titleEl.tagName : null,
        grip: gripEl ? { tag: gripEl.tagName, attrs: ['data-dockkit-float-grip'].reduce((out, name) => ({ ...out, [name]: gripEl.getAttribute(name) }), {}) } : null,
        controls: {
          dock: el.querySelector('[data-dockkit-float-dock]') ? el.querySelector('[data-dockkit-float-dock]').outerHTML.slice(0, 300) : null,
          close: el.querySelector('[data-dockkit-float-close]') ? el.querySelector('[data-dockkit-float-close]').outerHTML.slice(0, 300) : null,
          resize: el.querySelector('[data-dockkit-float-resize]') ? el.querySelector('[data-dockkit-float-resize]').outerHTML.slice(0, 240) : null,
        },
      }
    })
    const panel = document.querySelector('[data-sidebar-right-panel]')
    const panelInfo = panel ? {
      session: panel.getAttribute('data-sidebar-right-session'),
      panel: panel.getAttribute('data-sidebar-right-panel'),
      open: panel.hasAttribute('data-sidebar-right-open'),
      rect: round(panel.getBoundingClientRect()),
      zIndex: getComputedStyle(panel).zIndex,
      pointerEvents: getComputedStyle(panel).pointerEvents,
      position: getComputedStyle(panel).position,
    } : null
    return { floats, panel: panelInfo, viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio } }
  })
  results.step('inventory', inventory)
  results.metric('floatDomContract', inventory.floats[0] || null)
  results.assert('g3.float.dom.present', inventory.floats.length === 1, { actual: inventory.floats.length, expected: 1, category: 'G3' })
  const firstFloat = inventory.floats[0] || null
  results.assert('g3.float.dom.contract', !!firstFloat
    && firstFloat.computed.position === 'fixed'
    && !!firstFloat.attrs.paneId
    && !!firstFloat.attrs.tabId
    && !!firstFloat.controls.dock
    && !!firstFloat.controls.close
    && !!firstFloat.controls.resize
    && !!firstFloat.grip
    && !!firstFloat.title, {
    actual: firstFloat && {
      position: firstFloat.computed.position,
      paneId: firstFloat.attrs.paneId,
      tabId: firstFloat.attrs.tabId,
      hasDock: !!firstFloat.controls.dock,
      hasClose: !!firstFloat.controls.close,
      hasResize: !!firstFloat.controls.resize,
      hasGrip: !!firstFloat.grip,
      title: firstFloat.title,
    },
    expected: { position: 'fixed', paneId: 'float*', tabId: 'tab*', hasDock: true, hasClose: true, hasResize: true, hasGrip: true, title: 'non-empty' },
    category: 'G3',
  })
  results.metric('g3.float.zIndex.computed', firstFloat && firstFloat.computed.zIndex)
  results.metric('g3.float.parent.zIndex', firstFloat && firstFloat.parent && firstFloat.parent.zIndex)
  results.metric('g3.float.rect', firstFloat && firstFloat.rect)

  await results.shot(page, 'g3-inventory-1440.png')

  /* ---------------- 2. 注入 peek 属性 + 官方 re-render 存活观察 ---------------- */
  const injection = await page.evaluate(() => {
    const el = document.querySelector('[data-dockkit-float]')
    if (!el) return { ok: false, error: 'no-float' }
    // 原始值留档（还原用）
    const original = {
      styleAttr: String(el.getAttribute('style') || ''),
      ariaHidden: el.getAttribute('aria-hidden'),
      hadPeek: el.hasAttribute('data-onestep-peek'),
    }
    const element = el
    // 记录 MutationObserver：属性 + 子节点（官方 re-render 可能重挂）
    const mutations = []
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        mutations.push({
          type: record.type,
          attributeName: record.attributeName || null,
          target: record.target === element ? 'float' : (record.target.nodeName || 'node'),
          oldValue: record.oldValue === undefined || record.oldValue === null ? null : String(record.oldValue).slice(0, 200),
          at: Math.round(performance.now() * 10) / 10,
        })
      }
    })
    observer.observe(el.parentElement || document.body, { attributes: true, attributeOldValue: true, childList: true, subtree: true, attributeFilter: ['data-onestep-peek', 'style', 'inert', 'aria-hidden', 'data-dockkit-float-active', 'data-dockkit-float'] })
    // 注入（对应 §5.5：transform 移出视口 + pointer-events none + inert + aria-hidden）
    el.setAttribute('data-onestep-peek', '1')
    el.style.setProperty('transform', 'translateX(calc(100% + 24px))', 'important')
    el.style.setProperty('pointer-events', 'none', 'important')
    el.inert = true
    el.setAttribute('aria-hidden', 'true')
    window.__p3_g3 = { element, original, observer, mutations }
    const style = getComputedStyle(el)
    return {
      ok: true,
      injected: {
        peek: el.getAttribute('data-onestep-peek'),
        inert: el.inert === true,
        ariaHidden: el.getAttribute('aria-hidden'),
        computedTransform: style.transform,
        computedPointerEvents: style.pointerEvents,
        computedVisibility: style.visibility,
        rect: (() => { const rect = el.getBoundingClientRect(); return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } })(),
      },
    }
  })
  results.step('inject', injection)
  results.assert('g3.inject.applied', !!(injection && injection.ok
    && injection.injected.peek === '1'
    && injection.injected.inert === true
    && injection.injected.ariaHidden === 'true'
    && injection.injected.computedTransform !== 'none'
    && injection.injected.computedPointerEvents === 'none'), {
    actual: injection && injection.injected,
    expected: { peek: '1', inert: true, ariaHidden: 'true', transform: 'not none', pointerEvents: 'none' },
    category: 'G3',
  })
  if (injection && injection.ok) {
    results.metric('g3.inject.rectAfterTransform', injection.injected.rect)
  }

  /** 读注入属性存活状态。 */
  const readInjection = () => page.evaluate(() => {    const state = window.__p3_g3
    if (!state) return { available: false }
    const el = state.element
    const connected = el.isConnected
    const style = connected ? getComputedStyle(el) : null
    return {
      available: true,
      connected,
      peek: connected ? el.getAttribute('data-onestep-peek') : null,
      inert: connected ? el.inert === true : null,
      ariaHidden: connected ? el.getAttribute('aria-hidden') : null,
      computedTransform: style ? style.transform : null,
      computedPointerEvents: style ? style.pointerEvents : null,
      styleAttr: connected ? String(el.getAttribute('style') || '').slice(0, 400) : null,
      mutationCount: state.mutations.length,
      mutations: state.mutations.slice(-20),
    }
  })

  const surviveChecks = []
  // 触发 A：新开第二个浮窗（dockkit 布局新增 pane / 整体 re-render）
  const openB = await p3Call(page, 'openFloat', addresses[1], slotInfo.slots[1])
  await sleep(650)
  surviveChecks.push({ trigger: 'openFloat.second', state: await readInjection(), openCall: { ok: openB && openB.ok, tabId: openB && openB.tabId } })
  results.metric('g3.survive.openSecond', surviveChecks[surviveChecks.length - 1])

  // 触发 B：官方展开右栏（panel/seat 重渲染）
  const toggle1 = await p3Call(page, 'toggleExpanded')
  await sleep(500)
  surviveChecks.push({ trigger: 'toggleExpanded.expand', state: await readInjection(), call: toggle1, expanded: await isExpanded(page) })
  results.metric('g3.survive.toggleExpand', surviveChecks[surviveChecks.length - 1])

  // 触发 C：展开态下 focus 另一个 docked tab（activePane 切换 → 容器 re-render）
  const tabs = await p3Call(page, 'tabs')
  const dockedTab = tabs && tabs.ok && Array.isArray(tabs.value) ? tabs.value.find((tab) => tab.id !== (openA && openA.tabId) && tab.id !== (openB && openB.tabId)) : null
  const focusCall = dockedTab ? await p3Call(page, 'focus', dockedTab.id) : { ok: false, error: 'no-docked-tab' }
  await sleep(500)
  surviveChecks.push({ trigger: 'focus.dockedTab', state: await readInjection(), focusCall, dockedTabId: dockedTab && dockedTab.id })
  results.metric('g3.survive.focusDocked', surviveChecks[surviveChecks.length - 1])

  // 触发 D：收起右栏（panel 状态回到初始）
  const toggle2 = await p3Call(page, 'toggleExpanded')
  await sleep(500)
  surviveChecks.push({ trigger: 'toggleExpanded.collapse', state: await readInjection(), call: toggle2, expanded: await isExpanded(page) })
  results.metric('g3.survive.toggleCollapse', surviveChecks[surviveChecks.length - 1])

  // 汇总 MutationObserver 中直接作用于浮窗元素的记录
  const mutationSummary = await page.evaluate(() => {
    const state = window.__p3_g3
    if (!state) return null
    const onFloat = state.mutations.filter((record) => record.target === 'float')
    return {
      total: state.mutations.length,
      onFloatCount: onFloat.length,
      onFloat: onFloat.slice(0, 30),
      sample: state.mutations.slice(-15),
    }
  })
  results.metric('g3.mutations', mutationSummary)

  // 存活判定：4 次 re-render 后 data-onestep-peek / inert / aria-hidden / transform 是否仍在
  const survival = surviveChecks.map((check) => ({
    trigger: check.trigger,
    connected: check.state.connected,
    peek: check.state.peek,
    inert: check.state.inert,
    ariaHidden: check.state.ariaHidden,
    transform: check.state.computedTransform,
    pointerEvents: check.state.computedPointerEvents,
  }))
  results.metric('g3.injection.survival', survival)
  const allSurvive = survival.every((entry) => entry.connected && entry.peek === '1' && entry.inert === true && entry.ariaHidden === 'true' && entry.transform && entry.transform !== 'none')
  results.assert('g3.injection.survives.rerender', allSurvive, {
    actual: survival,
    expected: '4 次官方 re-render 后注入属性全部保留',
    category: 'G3',
    note: 'R12：注入属性被 re-render/重挂载清除的风险实测',
  })

  // 还原
  const restore = await page.evaluate(() => {
    const state = window.__p3_g3
    if (!state) return { ok: false, error: 'no-state' }
    const el = state.element
    state.observer.disconnect()
    el.removeAttribute('data-onestep-peek')
    el.style.removeProperty('transform')
    el.style.removeProperty('pointer-events')
    el.inert = false
    if (state.original.ariaHidden === null) el.removeAttribute('aria-hidden')
    else el.setAttribute('aria-hidden', state.original.ariaHidden)
    delete window.__p3_g3
    const style = getComputedStyle(el)
    return {
      ok: true,
      peek: el.getAttribute('data-onestep-peek'),
      inert: el.inert === true,
      ariaHidden: el.getAttribute('aria-hidden'),
      transform: style.transform,
      pointerEvents: style.pointerEvents,
    }
  })
  results.step('restore', restore)
  results.assert('g3.injection.restored', !!(restore && restore.ok && restore.peek === null && restore.inert === false && restore.ariaHidden === null), {
    actual: restore,
    expected: { peek: null, inert: false, ariaHidden: null },
    category: 'G3',
  })

  await results.shot(page, 'g3-after-restore-1440.png')

  /* ---------------- 3. z 层：浮窗 / body portal 按钮 / 官方 tab 菜单 ---------------- */
  const zProbe = await page.evaluate(() => {
    const float = document.querySelector('[data-dockkit-float]')
    if (!float) return { ok: false, error: 'no-float' }
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = 'PEEK'
    button.setAttribute('data-onestep-probe-tag', '1')
    button.setAttribute('aria-label', 'onestep peek tag layer probe')
    Object.assign(button.style, {
      position: 'fixed',
      right: '4px',
      top: '320px',
      width: '40px',
      height: '64px',
      zIndex: '63',
      background: '#3b82f6',
      color: '#fff',
      border: '0',
      borderRadius: '6px',
    })
    document.body.appendChild(button)
    const floatRect = float.getBoundingClientRect()
    // 按钮与浮窗的几何关系：按钮在浮窗右缘内 8px（右缘 overlap）
    button.style.left = Math.round(floatRect.right - 28) + 'px'
    button.style.top = Math.round(floatRect.top + 240) + 'px'
    button.style.right = 'auto'
    const buttonRect = button.getBoundingClientRect()
    const overlapPoint = { x: Math.round(Math.max(floatRect.left, buttonRect.left) + 4), y: Math.round(buttonRect.top + 10) }
    const atFloat = document.elementFromPoint(Math.round(floatRect.left + 20), Math.round(floatRect.top + 240))
    const atOverlap = document.elementFromPoint(overlapPoint.x, overlapPoint.y)
    const describe = (el) => {
      if (!el) return null
      const floatHost = el.closest('[data-dockkit-float]')
      const panelHost = el.closest('[data-sidebar-right-panel]')
      return {
        tag: el.tagName,
        cls: String(el.getAttribute('class') || '').slice(0, 120),
        attrs: ['data-onestep-probe-tag', 'data-dockkit-float', 'data-dockkit-content'].reduce((out, name) => {
          if (el.hasAttribute(name)) out[name] = el.getAttribute(name)
          return out
        }, {}),
        closestFloat: floatHost ? floatHost.getAttribute('data-dockkit-float') : null,
        closestFloatTab: floatHost ? floatHost.getAttribute('data-dockkit-content') : null,
        inOfficialPanel: !!panelHost,
      }
    }
    return {
      ok: true,
      buttonRect: { x: Math.round(buttonRect.x), y: Math.round(buttonRect.y), w: Math.round(buttonRect.width), h: Math.round(buttonRect.height) },
      buttonZ: getComputedStyle(button).zIndex,
      floatRect: { x: Math.round(floatRect.x), y: Math.round(floatRect.y), w: Math.round(floatRect.width), h: Math.round(floatRect.height) },
      floatZ: getComputedStyle(float).zIndex,
      floatParentZ: float.parentElement ? getComputedStyle(float.parentElement).zIndex : null,
      overlapPoint,
      elementFromPointAtFloat: describe(atFloat),
      elementFromPointAtOverlap: describe(atOverlap),
    }
  })
  results.step('z.probe', zProbe)
  results.metric('g3.z.float', { z: zProbe.floatZ, parentZ: zProbe.floatParentZ })
  results.metric('g3.z.button', zProbe.buttonZ)
  results.metric('g3.hitTest', { atFloat: zProbe.elementFromPointAtFloat, atOverlap: zProbe.elementFromPointAtOverlap })
  const tagAboveFloat = !!(zProbe.ok && zProbe.elementFromPointAtOverlap && zProbe.elementFromPointAtOverlap.attrs['data-onestep-probe-tag'] === '1')
  results.assert('g3.tagLayer.above.float', tagAboveFloat, {
    actual: { hit: zProbe.elementFromPointAtOverlap, floatZ: zProbe.floatZ, parentZ: zProbe.floatParentZ, buttonZ: zProbe.buttonZ },
    expected: { hit: 'data-onestep-probe-tag' },
    category: 'G3',
    note: 'body portal 按钮 z-index 63 命中最上层 → 标签层方案（z 62-66）在浮窗（层 60）之上可行',
  })
  results.assert('g3.float.pointer.auto', !!(zProbe.ok && zProbe.elementFromPointAtFloat && zProbe.elementFromPointAtFloat.closestFloat), {
    actual: zProbe.elementFromPointAtFloat,
    expected: '浮窗自身（或其内容）命中，不被其它层挡住',
    category: 'G3',
  })

  // 3b. 官方菜单层（§5.5：标签层必须低于官方菜单）
  // 先关闭浮窗：浮窗会盖住 docked tab chip，真实右键需要可点击目标；同时保留「舞台不受浮窗影响」的状态。
  const menuTestClosedFloats = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-dockkit-float]')).map((el) => el.getAttribute('data-dockkit-content')))
  for (const tabId of menuTestClosedFloats) await p3Call(page, 'close', tabId)
  await sleep(500)
  if (!(await isExpanded(page))) {
    await p3Call(page, 'toggleExpanded')
    await sleep(600)
  }
  results.metric('g3.menu.closedFloats', menuTestClosedFloats)

  /** 读取当前 DOM 中所有菜单候选（可见性 / z-index / portal 容器 z）。 */
  const readMenuState = () => page.evaluate(() => {
    const round = (rect) => ({ x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) })
    return Array.from(document.querySelectorAll('[role="menu"], [data-dockkit-tab-menu], [data-context-menu]')).map((menu) => {
      const style = getComputedStyle(menu)
      const rect = menu.getBoundingClientRect()
      const visible = rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05
      let node = menu
      let container = null
      while (node && node !== document.body) {
        const nodeStyle = getComputedStyle(node)
        if (nodeStyle.zIndex && nodeStyle.zIndex !== 'auto') {
          container = { tag: node.tagName, cls: String(node.getAttribute('class') || '').slice(0, 120), zIndex: nodeStyle.zIndex, position: nodeStyle.position }
          break
        }
        node = node.parentElement
      }
      return {
        tag: menu.tagName,
        role: menu.getAttribute('role'),
        attrs: menu.getAttributeNames().slice(0, 20),
        zIndex: style.zIndex,
        position: style.position,
        visible,
        rect: round(rect),
        container,
      }
    })
  })

  let menuInfo = null
  const menuAttempts = []
  const menuOpenError = null
  try {
    // 尝试 1：真实右键 docked tab chip（官方 tab context menu）
    const chip = page.locator('[data-dockkit-tab]').first()
    const chipBox = await chip.boundingBox()
    if (chipBox) {
      await page.mouse.click(Math.round(chipBox.x + chipBox.width / 2), Math.round(chipBox.y + chipBox.height / 2), { button: 'right' })
      await sleep(600)
      menuAttempts.push({ where: 'dockedTabChip', chipBox, menus: await readMenuState() })
    }
    // 尝试 2：官方左栏会话行右键（不受浮窗/面板影响）
    if (!menuAttempts.some((attempt) => attempt.menus.some((menu) => menu.visible))) {
      await page.keyboard.press('Escape')
      await sleep(150)
      await page.mouse.click(100, 320, { button: 'right' })
      await sleep(600)
      menuAttempts.push({ where: 'leftSidebar.sessionRow', menus: await readMenuState() })
    }
    const visibleMenu = menuAttempts
      .flatMap((attempt) => attempt.menus.map((menu) => ({ ...menu, where: attempt.where })))
      .filter((menu) => menu.visible)
      .sort((left, right) => right.rect.w * right.rect.h - left.rect.w * left.rect.h)[0]
    results.metric('g3.menu.attempts', menuAttempts)
    if (visibleMenu) {
      const menuHit = await page.evaluate((menu) => {
        const button = document.querySelector('[data-onestep-probe-tag]')
        if (!button) return null
        // 把探针按钮移到菜单中心，测试谁在上
        button.style.left = Math.round(menu.rect.x + menu.rect.w / 2 - 20) + 'px'
        button.style.top = Math.round(menu.rect.y + menu.rect.h / 2 - 10) + 'px'
        const buttonRect = button.getBoundingClientRect()
        const point = { x: Math.round(buttonRect.x + 20), y: Math.round(buttonRect.y + 20) }
        const hit = document.elementFromPoint(point.x, point.y)
        return {
          point,
          hit: hit ? {
            tag: hit.tagName,
            cls: String(hit.getAttribute('class') || '').slice(0, 120),
            inMenu: !!hit.closest('[role="menu"], [data-dockkit-tab-menu], [data-context-menu]'),
            isProbeButton: hit.hasAttribute('data-onestep-probe-tag'),
          } : null,
          buttonZ: getComputedStyle(button).zIndex,
        }
      }, visibleMenu)
      menuInfo = { ...visibleMenu, hitTest: menuHit }
      results.metric('g3.menu', menuInfo)
      results.assert('g3.menu.z.above.tagLayer', Number(menuInfo.container ? menuInfo.container.zIndex : menuInfo.zIndex) > 63, {
        actual: { menuZ: menuInfo.zIndex, containerZ: menuInfo.container && menuInfo.container.zIndex, buttonZ: 63 },
        expected: '> 63',
        category: 'G3',
        note: '官方菜单层必须高于标签层（p3-plan 按 dockkit TabMenu z=70 假设；本 rc 实测为共享 context menu surface）',
      })
      results.assert('g3.menu.below', !!(menuHit && menuHit.hit && menuHit.hit.inMenu && !menuHit.hit.isProbeButton), {
        actual: menuHit,
        expected: '菜单在探针按钮 z 63 之上',
        category: 'G3',
      })
    } else {
      results.metric('g3.menu', { visible: false })
      results.skip('g3.menu.below', '官方菜单未能在无浮窗遮挡时以可见态打开（右键 chip/session row 均未命中可见菜单）', 'G3')
    }
    await page.keyboard.press('Escape')
    await sleep(300)
    await results.shot(page, 'g3-menu-z-1440.png')
  } catch (error) {
    results.metric('g3.menu.openError', String((error && error.message) || error).slice(0, 300))
    results.metric('g3.menu.attempts', menuAttempts)
    results.skip('g3.menu.below', '官方菜单打开过程异常：' + String((error && error.message) || error).slice(0, 200), 'G3')
  }
  if (await isExpanded(page)) {
    await p3Call(page, 'toggleExpanded')
    await sleep(500)
  }

  // 菜单测试关闭了浮窗：重新打开一个浮窗供「点击外部」用例使用
  const reopenForClick = await p3Call(page, 'openFloat', addresses[0], slotInfo.slots[0])
  await sleep(650)
  results.metric('g3.clickTest.reopenFloat', reopenForClick && { ok: reopenForClick.ok, tabId: reopenForClick.tabId, steps: reopenForClick.steps })

  // 探针按钮复位到浮窗右缘（点击外部用例用这个位置）
  const tagRect = await page.evaluate(() => {
    const button = document.querySelector('[data-onestep-probe-tag]')
    const float = document.querySelector('[data-dockkit-float]')
    if (!button || !float) return null
    const floatRect = float.getBoundingClientRect()
    button.style.left = Math.round(floatRect.right - 28) + 'px'
    button.style.top = Math.round(floatRect.top + 240) + 'px'
    const rect = button.getBoundingClientRect()
    return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
  })
  results.metric('g3.tagRectForClick', tagRect)

  /* ---------------- 4. 点击外部检测 ---------------- */
  const clickProbe = await page.evaluate(() => {
    const button = document.querySelector('[data-onestep-probe-tag]')
    const events = []
    const stage = document.querySelector('[data-onestep-stage]')
    const stageRect = stage ? stage.getBoundingClientRect() : null
    const handler = (event) => {
      const target = event.target instanceof Element ? event.target : null
      const point = { x: Math.round(event.clientX), y: Math.round(event.clientY) }
      const inStage = !!stageRect && point.x >= stageRect.x && point.x <= stageRect.right && point.y >= stageRect.y && point.y <= stageRect.bottom
      const inFloat = !!(target && target.closest('[data-dockkit-float]'))
      const inTagLayer = !!(target && target.closest('[data-onestep-peek-tag], [data-onestep-probe-tag]'))
      const inMenu = !!(target && target.closest('[data-dockkit-tab-menu], [role="menu"]'))
      const inOfficialPanel = !!(target && target.closest('[data-sidebar-right-panel]'))
      const hit = document.elementFromPoint(point.x, point.y)
      events.push({
        point,
        target: target ? { tag: target.tagName, cls: String(target.getAttribute('class') || '').slice(0, 100), attrs: target.getAttributeNames().slice(0, 12) } : null,
        hit: hit ? { tag: hit.tagName, cls: String(hit.getAttribute('class') || '').slice(0, 100), inFloat: !!hit.closest('[data-dockkit-float]'), isTag: !!hit.closest('[data-onestep-peek-tag], [data-onestep-probe-tag]') } : null,
        flags: { inStage, inFloat, inTagLayer, inMenu, inOfficialPanel },
        // §5.5 触发规则：不在浮窗/标签层/官方菜单中，且位于舞台区域 → 收起
        outsideRule: inStage && !inFloat && !inTagLayer && !inMenu,
      })
    }
    document.addEventListener('pointerdown', handler, true)
    window.__p3_click_probe = { events, handler, stageRect }
    return {
      ok: !!button,
      stageRect: stageRect ? { x: Math.round(stageRect.x), y: Math.round(stageRect.y), w: Math.round(stageRect.width), h: Math.round(stageRect.height) } : null,
    }
  })
  results.step('clickProbe.install', clickProbe)

  const clicks = []
  const clickSequence = [
    // 焦点窗内、且不被任何浮窗覆盖的位置（浮窗 0/1 槽从 x≈720 起）
    { name: 'inside.focusWindow', x: Math.round(layout.focus.x + 68), y: Math.round(layout.focus.y + layout.focus.h * 0.45) },
    { name: 'inside.float', x: Math.round(slotInfo.slots[0].x + slotInfo.slots[0].width * 0.5), y: 400 },
    { name: 'on.tagLayer', x: tagRect ? tagRect.x + 20 : 1416, y: tagRect ? tagRect.y + 20 : 276 },
    { name: 'official.leftSidebar', x: 100, y: 400 },
    { name: 'outside.stage.bottom', x: 640, y: 895 },
  ]
  for (const entry of clickSequence) {
    await page.mouse.click(entry.x, entry.y)
    await sleep(220)
    const state = await page.evaluate(() => {
      const probe = window.__p3_click_probe
      return probe ? probe.events[probe.events.length - 1] : null
    })
    clicks.push({ name: entry.name, at: { x: entry.x, y: entry.y }, event: state })
  }
  results.metric('g3.clickProbe.events', clicks)
  const byName = Object.fromEntries(clicks.map((entry) => [entry.name, entry.event]))
  results.assert('click.focusWindow.outside', !!(byName['inside.focusWindow']
    && byName['inside.focusWindow'].flags.inStage === true
    && byName['inside.focusWindow'].flags.inFloat === false
    && byName['inside.focusWindow'].outsideRule === true), {
    actual: byName['inside.focusWindow'],
    expected: { inStage: true, inFloat: false, outsideRule: true },
    category: 'G3',
    note: '§5.5：舞台区域内的普通点击应判定为「点击外部」',
  })
  results.assert('click.float.inside', !!(byName['inside.float'] && byName['inside.float'].flags.inFloat === true && byName['inside.float'].outsideRule === false), {
    actual: byName['inside.float'],
    expected: { inFloat: true, outsideRule: false },
    category: 'G3',
  })
  results.assert('click.tagLayer.inside', !!(byName['on.tagLayer'] && byName['on.tagLayer'].flags.inTagLayer === true && byName['on.tagLayer'].outsideRule === false), {
    actual: byName['on.tagLayer'],
    expected: { inTagLayer: true, outsideRule: false },
    category: 'G3',
  })
  results.assert('click.leftSidebar.notInStage', !!(byName['official.leftSidebar'] && byName['official.leftSidebar'].flags.inStage === false && byName['official.leftSidebar'].outsideRule === false), {
    actual: byName['official.leftSidebar'],
    expected: { inStage: false, outsideRule: false },
    category: 'G3',
    note: '§5.5：不在舞台区域（官方左栏）不触发收起',
  })

  await page.evaluate(() => {
    const probe = window.__p3_click_probe
    if (probe) document.removeEventListener('pointerdown', probe.handler, true)
    const button = document.querySelector('[data-onestep-probe-tag]')
    if (button) button.remove()
    delete window.__p3_click_probe
  })
  await results.shot(page, 'g3-click-outside-1440.png')
  results.captureErrors(handles)
  results.step('page.errors', { pageErrors: handles.pageErrors.slice(0, 8), consoleErrors: handles.consoleErrors.slice(0, 8) })
} catch (error) {
  results.fatal(error)
} finally {
  await closeApp(app)
}
const data = results.finish()
log('[g3] summary ' + JSON.stringify(data.summary))
process.exit(data.ok ? 0 : 1)
