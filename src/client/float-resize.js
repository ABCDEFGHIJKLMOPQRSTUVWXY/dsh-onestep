/**
 * 浮窗边缘缩放（0.7.0）：给 P3 伴生浮窗（官方 dockkit 浮窗 DOM）加 8 向缩放把手。
 *
 * 背景（docs/architecture.md §6.4）：
 * - 官方浮窗只有右下角一个 20×20 缩放角（`.floatResize`，手势固定左上角、只改宽高）；
 * - 用户反馈「只能在右下角调整大小」，需要拖动任意边缘/角调整；
 * - 官方服务面没有编程 move/resize（`ISidebarRight` 无此成员），因此：
 *   ① 手势与实时预览由本模块自绘（8 个贴在浮窗边缘的透明把手 + 内联几何预览）；
 *   ② 提交复用官方 FloatLayer 的 intents（React fiber 上取 `intents.resizeFloat`，
 *      它绑定当前会话）→ 官方 store 记录一次 `resizeFloat`（含 x/y/width/height，可撤销、持久化、重渲染）；
 *   ③ 取不到 intents（官方 DOM/React 结构漂移）时回退官方 controller 的会话 store actions
 *      （`service.actionsFor(sessionId)`）；两者都不可用则还原预览并记日志，不改变官方状态。
 *
 * 边界：只处理当前会话 panel 内的官方浮窗；停在 peek（收起）态的浮窗不接管；
 * 浮窗 DOM 缺失/属性漂移时不注入把手（能力自检，见 docs/p3-plan.md R11）。
 * 本模块不碰 React 渲染、不建独立窗口；卸载时移除把手/监听/内联样式，官方浮窗原样。
 */
import { COMPANION } from './adapter.js'
import { readTitlebarHeight } from './peek-layer.js'

/** 缩放把手属性（值 = 方向 n/s/e/w/ne/nw/se/sw）。 */
export const RESIZE_ATTR = COMPANION.attrs.resizeGrip
/** 缩放进行中的浮窗标记（用于样式与探针，不影响官方状态）。 */
export const RESIZING_ATTR = COMPANION.attrs.resizing
/** 八个缩放方向。 */
export const DIRECTIONS = Object.freeze(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'])
/** 最小尺寸：官方 `FLOAT_MIN_SIZE`（ui-dockkit/engine/constraints.ts）。 */
export const MIN_SIZE = Object.freeze({ width: COMPANION.defaults.floatMinWidth, height: COMPANION.defaults.floatMinHeight })
/** 拖动期间临时 z-index：保证被缩放的窗在其它浮窗之上（提交后官方会自行抬升）。 */
const DRAG_Z_INDEX = '999'
/** 各方向的缩放光标（缩放期间整窗继承，避免内容区光标跳变）。 */
const CURSORS = Object.freeze({
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
})
/** 浮窗覆盖层的拖动阈值（0：边缘手势一按下即进入缩放，不做点击/拖动区分）。 */

/**
 * 归一化矩形（容忍 DOMRect 与 {x,y,width,height}）。
 * @param {{x?:number,left?:number,y?:number,top?:number,width?:number,height?:number}|null|undefined} input
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function normalizeRect(input) {
  const source = input || {}
  const x = finiteOr(source.left, finiteOr(source.x, 0))
  const y = finiteOr(source.top, finiteOr(source.y, 0))
  const width = Math.max(1, finiteOr(source.width, 1))
  const height = Math.max(1, finiteOr(source.height, 1))
  return { x, y, width, height }
}

function finiteOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/**
 * 计算一次边缘缩放的矩形（纯函数）。
 *
 * 规则（镜像官方 `boundedResize`/`legalFloatRect` 的口径）：
 * - 西/北侧边移动时对边固定，宽高不得小于最小尺寸；
 * - 东/南侧边移动时宽高受视口限制（右/下缘不出屏）；
 * - 西/北侧边不能越过 x=0 / 标题栏下沿（`bounds.top`）。
 *
 * @param {{x:number,y:number,width:number,height:number}} start 按下时的绘制矩形
 * @param {string} direction n/s/e/w/ne/nw/se/sw
 * @param {number} dx 指针横向位移
 * @param {number} dy 指针纵向位移
 * @param {{top?:number,width?:number,height?:number}} bounds 视口边界（top = 标题栏下沿）
 * @param {{width:number,height:number}} [minSize]
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function computeResizeRect(start, direction, dx, dy, bounds, minSize = MIN_SIZE) {
  const base = normalizeRect(start)
  const dir = String(direction || '')
  const minW = Math.max(1, finiteOr(minSize && minSize.width, MIN_SIZE.width))
  const minH = Math.max(1, finiteOr(minSize && minSize.height, MIN_SIZE.height))
  const top = Math.max(0, finiteOr(bounds && bounds.top, 0))
  const viewportWidth = Math.max(minW, finiteOr(bounds && bounds.width, Number.MAX_SAFE_INTEGER))
  const viewportHeight = Math.max(minH, finiteOr(bounds && bounds.height, Number.MAX_SAFE_INTEGER))
  const deltaX = finiteOr(dx, 0)
  const deltaY = finiteOr(dy, 0)
  let { x, y, width, height } = base

  if (dir.indexOf('w') >= 0) {
    const right = base.x + base.width
    x = Math.min(Math.max(base.x + deltaX, 0), right - minW)
    width = right - x
  }
  if (dir.indexOf('e') >= 0) {
    width = Math.max(minW, Math.min(base.width + deltaX, viewportWidth - base.x))
  }
  if (dir.indexOf('n') >= 0) {
    const bottom = base.y + base.height
    y = Math.min(Math.max(base.y + deltaY, top), bottom - minH)
    height = bottom - y
  }
  if (dir.indexOf('s') >= 0) {
    height = Math.max(minH, Math.min(base.height + deltaY, viewportHeight - base.y))
  }
  return { x, y, width, height }
}

/**
 * 官方浮窗的可用区域（镜像 ui-dockkit FloatLayer `floatBounds()`）：
 * 桌面 App 有标题栏时，顶界 = 标题栏高度 + 20px；web/隔离实例为 0。
 * @param {Document|null} [doc]
 * @returns {{top:number,width:number,height:number}}
 */
export function floatBounds(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || !doc.documentElement) return { top: 0, width: 0, height: 0 }
  const root = doc.documentElement
  const windows = typeof root.hasAttribute === 'function' && root.hasAttribute('data-windows-titlebar')
  const view = doc.defaultView || null
  const width = view && Number.isFinite(Number(view.innerWidth)) ? Number(view.innerWidth) : 0
  const height = view && Number.isFinite(Number(view.innerHeight)) ? Number(view.innerHeight) : 0
  if (!windows) return { top: 0, width, height }
  // 与官方 FloatLayer.floatBounds 对齐：桌面全屏时 caption 取 0（css 也写死 top:20），
  // 否则顶界会比官方手势少一个标题栏高度（0.7.0 审查 F7）。
  const fullscreen = typeof root.hasAttribute === 'function' && root.hasAttribute('data-fullscreen')
  const caption = fullscreen ? 0 : readTitlebarHeight(doc)
  return { top: Math.max(0, caption) + COMPANION.defaults.floatCaptionFloor, width, height }
}

/**
 * 从官方浮窗 DOM 找 FloatLayer 的 intents（React fiber memoizedProps）。
 * 返回的 `intents.resizeFloat(paneId, rect)` 已绑定当前会话，提交一次官方 resize 记录。
 * @param {Element|null|undefined} element 官方浮窗容器
 * @returns {{resizeFloat:Function}|null}
 */
export function findFloatIntents(element) {
  if (!element || typeof element !== 'object') return null
  let fiber = null
  try {
    for (const key of Object.keys(element)) {
      if (key.indexOf('__reactFiber$') === 0 || key.indexOf('__reactInternalInstance$') === 0) {
        fiber = element[key]
        break
      }
    }
  } catch (_error) {
    return null
  }
  let node = fiber
  let depth = 0
  while (node && depth < 40) {
    const props = node.memoizedProps
    if (props && props.intents && typeof props.intents.resizeFloat === 'function') return props.intents
    node = node.return
    depth += 1
  }
  return null
}

/**
 * 取官方 controller 上某会话的 store actions（私有方法/字段的运行时回退路径）。
 * 官方没有公开 move/resize API（docs/p3/contracts.md C10），这是能力自检失败时的兜底；
 * 两条路径都不可用时调用方只还原预览、不改变官方状态。
 * @param {object|undefined} service 官方 sidebarRight 实例
 * @param {string|null} sessionId
 * @returns {{resizeFloat:Function}|null}
 */
export function resolveServiceActions(service, sessionId) {
  if (!service || !sessionId) return null
  try {
    if (typeof service.actionsFor === 'function') {
      const actions = service.actionsFor(sessionId)
      if (actions && typeof actions.resizeFloat === 'function') return actions
    }
  } catch (_error) {
    /* 私有方法改名/不存在：继续尝试 adopted map */
  }
  try {
    const adopted = service.adopted
    const adoption = adopted && typeof adopted.get === 'function' ? adopted.get(sessionId) : null
    const actions = adoption && adoption.store && adoption.store.actions
    if (actions && typeof actions.resizeFloat === 'function') return actions
  } catch (_error) {
    /* ignore */
  }
  return null
}

/**
 * 提交一次浮窗矩形：优先 fiber intents（官方 FloatLayer 手势同构），其次会话 store actions。
 * @param {Element|null} element 官方浮窗容器
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {{getService?:()=>object|undefined, getSessionId?:()=>string|null}} [deps]
 * @returns {{ok:boolean, via?:string, reason?:string, error?:string}}
 */
export function commitFloatRect(element, rect, deps = {}) {
  const paneId = element && typeof element.getAttribute === 'function' ? element.getAttribute(COMPANION.attrs.float) : null
  if (!paneId) return { ok: false, reason: 'no-pane' }
  const normalized = normalizeRect(rect)
  const intents = findFloatIntents(element)
  if (intents) {
    try {
      intents.resizeFloat(paneId, normalized)
      return { ok: true, via: 'intents' }
    } catch (error) {
      /* 官方实现异常：继续走 store actions 兜底 */
    }
  }
  try {
    const service = typeof deps.getService === 'function' ? deps.getService() : undefined
    const panel = typeof element.closest === 'function' ? element.closest(COMPANION.selectors.panel) : null
    const sessionId = (typeof deps.getSessionId === 'function' ? deps.getSessionId() : null)
      || (panel && typeof panel.getAttribute === 'function' ? panel.getAttribute(COMPANION.attrs.session) : null)
    const actions = resolveServiceActions(service, sessionId)
    if (!actions) return { ok: false, reason: 'no-actions' }
    actions.resizeFloat(sessionId, paneId, normalized)
    return { ok: true, via: 'actions' }
  } catch (error) {
    return { ok: false, reason: 'throw', error: String((error && error.message) || error).slice(0, 200) }
  }
}

/**
 * 创建缩放把手控制器。
 *
 * @param {object} [deps]
 * @param {Document} [deps.doc]
 * @param {(event:string, data?:object|null)=>void} [deps.log]
 * @param {()=>boolean} [deps.isEnabled] 只在舞台 float 形态启用（index.js 传入）
 * @param {()=>object|undefined} [deps.getService] 官方 sidebarRight 实例
 * @param {()=>string|null} [deps.getSessionId] 当前焦点会话
 * @returns {{sync:Function, dispose:Function, snapshot:Function}}
 */
export function installFloatResize(deps = {}) {
  const doc = deps.doc || (typeof document !== 'undefined' ? document : null)
  const view = doc && doc.defaultView ? doc.defaultView : (typeof window !== 'undefined' ? window : null)
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const isEnabled = typeof deps.isEnabled === 'function' ? deps.isEnabled : () => true
  const getService = typeof deps.getService === 'function' ? deps.getService : () => undefined
  const getSessionId = typeof deps.getSessionId === 'function' ? deps.getSessionId : () => null

  /** @type {Map<Element, {grips:Element[], onPointerDown:Function}>} */
  const entries = new Map()
  let observer = null
  let observedPanel = null
  let scheduled = 0
  let disposed = false
  let gesture = null
  let lastCommit = null

  const guard = (fn, fallback) => {
    try {
      return fn()
    } catch (_error) {
      return fallback
    }
  }
  const enabled = () => !disposed && guard(() => !!isEnabled(), false)

  const currentPanel = () => {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null
    const sessionId = guard(() => getSessionId(), null)
    if (!sessionId) return null
    for (const panel of doc.querySelectorAll(COMPANION.selectors.panel)) {
      if (panel.getAttribute(COMPANION.attrs.session) !== sessionId) continue
      if (panel.closest('[hidden]')) continue
      return panel
    }
    return null
  }

  const stopObserver = () => {
    if (observer) {
      observer.disconnect()
      observer = null
    }
    observedPanel = null
  }

  const isFloatNode = (node) => {
    if (!node || node.nodeType !== 1) return false
    if (typeof node.matches === 'function' && node.matches(COMPANION.selectors.float)) return true
    return typeof node.querySelector === 'function' && !!node.querySelector(COMPANION.selectors.float)
  }

  const startObserver = (root) => {
    if (!root || observedPanel === root) return
    stopObserver()
    if (typeof MutationObserver === 'undefined') return
    observedPanel = root
    try {
      observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          const target = mutation.target
          if (mutation.type === 'childList') {
            const removed = Array.prototype.slice.call(mutation.removedNodes || [])
            const added = Array.prototype.slice.call(mutation.addedNodes || [])
            const removedGrips = removed.some((node) => node && node.nodeType === 1 && node.hasAttribute && node.hasAttribute(RESIZE_ATTR))
            const changedFloats = added.some(isFloatNode) || removed.some(isFloatNode)
            if (removedGrips) {
              scheduleSync()
              return
            }
            if (changedFloats || isFloatNode(target)) {
              scheduleSync()
              return
            }
          }
        }
      })
      observer.observe(root, { childList: true, subtree: true })
    } catch (error) {
      observer = null
      log('float.resize.observe.error', { error: String((error && error.message) || error).slice(0, 120) })
    }
  }

  const scheduleSync = () => {
    if (disposed || scheduled) return
    if (view && typeof view.requestAnimationFrame === 'function') {
      scheduled = view.requestAnimationFrame(() => {
        scheduled = 0
        sync()
      })
    } else {
      sync()
    }
  }

  const makeGrips = (element) => {
    if (!doc || typeof doc.createElement !== 'function') return null
    const grips = []
    for (const direction of DIRECTIONS) {
      const grip = doc.createElement('div')
      grip.className = 'onestep-float-resize-grip'
      grip.setAttribute(RESIZE_ATTR, direction)
      grip.setAttribute('data-dir', direction)
      grip.setAttribute('aria-hidden', 'true')
      try {
        element.appendChild(grip)
      } catch (_error) {
        return null
      }
      grips.push(grip)
    }
    return grips
  }

  const ensureGrips = (element) => {
    if (!element) return
    const entry = entries.get(element)
    if (entry) {
      if (entry.grips.every((grip) => element.contains(grip))) return
      // 官方重渲染可能删掉注入节点；同时重建监听，避免缺边或重复响应。
      removeGrips(element)
    }
    const grips = makeGrips(element)
    if (!grips) return
    const onPointerDown = (event) => onGripPointerDown(event, element)
    element.addEventListener('pointerdown', onPointerDown, true)
    entries.set(element, { grips, onPointerDown })
  }

  const removeGrips = (element) => {
    const entry = entries.get(element)
    if (!entry) return
    entries.delete(element)
    try {
      element.removeEventListener('pointerdown', entry.onPointerDown, true)
    } catch (_error) {
      /* ignore */
    }
    for (const grip of entry.grips) {
      try {
        grip.remove()
      } catch (_error) {
        /* ignore */
      }
    }
  }

  const clearAll = () => {
    for (const element of Array.from(entries.keys())) removeGrips(element)
  }

  const gestureValid = (active) => !!(active && enabled()
    && active.sessionId === guard(() => getSessionId(), null)
    && active.panel === currentPanel()
    && active.element.isConnected
    && active.panel.contains(active.element)
    && active.element.getAttribute(COMPANION.attrs.peek) !== '1')

  /** 同步把手集合：仅当前会话 panel 内的官方浮窗；未启用/无 panel 时全部移除。 */
  const sync = () => {
    if (disposed) return
    if (gesture && !gestureValid(gesture)) cancelGesture('context-changed')
    if (!enabled()) {
      stopObserver()
      clearAll()
      return
    }
    const root = currentPanel()
    if (!root) {
      stopObserver()
      clearAll()
      return
    }
    startObserver(root)
    let floats = []
    try {
      floats = Array.prototype.slice.call(root.querySelectorAll(COMPANION.selectors.float))
    } catch (_error) {
      floats = []
    }
    const live = new Set(floats)
    for (const element of Array.from(entries.keys())) {
      if (!live.has(element) || !element.isConnected) removeGrips(element)
    }
    for (const element of floats) ensureGrips(element)
  }

  const readRect = (element) => {
    try {
      const rect = element.getBoundingClientRect()
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    } catch (_error) {
      return null
    }
  }

  const saveStyle = (element) => ({
    left: element.style.left,
    top: element.style.top,
    width: element.style.width,
    height: element.style.height,
    zIndex: element.style.zIndex,
    cursor: element.style.cursor,
  })

  const applyPreview = (element, rect) => {
    try {
      element.style.left = rect.x + 'px'
      element.style.top = rect.y + 'px'
      element.style.width = rect.width + 'px'
      element.style.height = rect.height + 'px'
    } catch (_error) {
      /* ignore */
    }
  }

  const restoreStyle = (active) => {
    const element = active.element
    if (!element || !element.style) return
    try {
      const saved = active.saved
      // React 在提交后可能重写 zIndex（抬升）；只在仍是我们临时值时还原。
      if (element.style.zIndex === DRAG_Z_INDEX) element.style.zIndex = saved.zIndex
      element.style.cursor = saved.cursor
      element.style.left = saved.left
      element.style.top = saved.top
      element.style.width = saved.width
      element.style.height = saved.height
      element.removeAttribute(RESIZING_ATTR)
    } catch (_error) {
      /* ignore */
    }
  }

  const busy = () => {
    const active = gesture
    gesture = null
    if (!active) return null
    if (view) {
      try {
        view.removeEventListener('pointermove', onGestureMove, true)
        view.removeEventListener('pointerup', onGestureUp, true)
        view.removeEventListener('pointercancel', onGestureCancel, true)
        view.removeEventListener('keydown', onGestureKeyDown, true)
      } catch (_error) {
        /* ignore */
      }
    }
    try {
      if (active.grip && typeof active.grip.releasePointerCapture === 'function') active.grip.releasePointerCapture(active.pointerId)
    } catch (_error) {
      /* pointer capture 可能已失效 */
    }
    return active
  }

  const cancelGesture = (reason) => {
    const active = busy()
    if (!active) return
    restoreStyle(active)
    log('float.resize.cancel', { reason: reason || null })
  }

  const finishGesture = () => {
    // 会话切换/收起/关闭可能先于下一次 sync；松手也必须重新验证归属。
    if (gesture && !gestureValid(gesture)) {
      cancelGesture('context-changed')
      return
    }
    const active = busy()
    if (!active) return
    if (!active.moved) {
      // 边缘只是被点了一下：不提交 resize（避免污染官方撤销历史）。
      restoreStyle(active)
      return
    }
    const result = commitFloatRect(active.element, active.rect, { getService, getSessionId: () => active.sessionId })
    lastCommit = { at: Date.now(), rect: active.rect, ok: !!result.ok, via: result.via || null, reason: result.reason || null }
    if (!result.ok) {
      log('float.resize.commit.fail', { reason: result.reason || null })
      restoreStyle(active)
      return
    }
    const cleanup = () => restoreStyle(active)
    if (view && typeof view.requestAnimationFrame === 'function') {
      view.requestAnimationFrame(() => {
        if (view && typeof view.requestAnimationFrame === 'function') view.requestAnimationFrame(cleanup)
        else cleanup()
      })
    } else {
      cleanup()
    }
  }

  const onGestureMove = (event) => {
    const active = gesture
    if (!active || event.pointerId !== active.pointerId) return
    if (!gestureValid(active)) {
      cancelGesture('context-changed')
      return
    }
    const dx = event.clientX - active.startX
    const dy = event.clientY - active.startY
    const rect = computeResizeRect(active.startRect, active.direction, dx, dy, active.startBounds, MIN_SIZE)
    active.rect = rect
    active.moved = true
    applyPreview(active.element, rect)
  }

  const onGestureUp = (event) => {
    const active = gesture
    if (!active) return
    if (event.pointerId !== undefined && event.pointerId !== active.pointerId) return
    finishGesture()
  }

  const onGestureCancel = (event) => {
    if (gesture && event.pointerId !== undefined && event.pointerId !== gesture.pointerId) return
    cancelGesture('pointercancel')
  }

  const onGestureKeyDown = (event) => {
    if (event && event.key === 'Escape') {
      event.preventDefault()
      cancelGesture('escape')
    }
  }

  function onGripPointerDown(event, element) {
    if (!enabled() || !event) return
    if (typeof event.button === 'number' && event.button !== 0) return
    const target = event.target
    const grip = target && typeof target.closest === 'function' ? target.closest('[' + RESIZE_ATTR + ']') : null
    if (!grip || !element.contains(grip)) return
    const direction = grip.getAttribute(RESIZE_ATTR) || ''
    if (DIRECTIONS.indexOf(direction) < 0) return
    if (element.getAttribute(COMPANION.attrs.peek) === '1') return
    if (element.hasAttribute(RESIZING_ATTR)) return
    const panel = currentPanel()
    if (!panel || !panel.contains(element)) return
    const rect = readRect(element)
    if (!rect) return
    cancelGesture('superseded')
    try {
      event.preventDefault()
      event.stopPropagation()
    } catch (_error) {
      /* ignore */
    }
    try {
      if (typeof grip.setPointerCapture === 'function') grip.setPointerCapture(event.pointerId)
    } catch (_error) {
      /* pointer capture 不可用也不影响 window 监听 */
    }
    gesture = {
      element,
      panel,
      sessionId: guard(() => getSessionId(), null),
      grip,
      direction,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRect: rect,
      startBounds: floatBounds(doc),
      saved: saveStyle(element),
      rect,
      moved: false,
    }
    element.setAttribute(RESIZING_ATTR, '1')
    try {
      element.style.zIndex = DRAG_Z_INDEX
      element.style.cursor = CURSORS[direction] || 'nwse-resize'
    } catch (_error) {
      /* ignore */
    }
    if (view && typeof view.addEventListener === 'function') {
      view.addEventListener('pointermove', onGestureMove, true)
      view.addEventListener('pointerup', onGestureUp, true)
      view.addEventListener('pointercancel', onGestureCancel, true)
      view.addEventListener('keydown', onGestureKeyDown, true)
    }
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    stopObserver()
    if (scheduled && view && typeof view.cancelAnimationFrame === 'function') {
      try {
        view.cancelAnimationFrame(scheduled)
      } catch (_error) {
        /* ignore */
      }
      scheduled = 0
    }
    cancelGesture('dispose')
    clearAll()
    lastCommit = null
  }

  /** 探针/诊断快照（不改变状态）。 */
  const snapshot = () => {
    let grips = 0
    for (const entry of entries.values()) grips += entry.grips.length
    return {
      enabled: enabled(),
      floats: entries.size,
      grips,
      active: gesture ? { direction: gesture.direction, rect: gesture.rect } : null,
      last: lastCommit,
    }
  }

  return { sync, dispose, snapshot }
}
