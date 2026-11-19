/**
 * P3-11 收起与边缘标签层（D11/D12/D14，例外二的可视部分）。
 *
 * 官方没有「移出视口但保留」的 API（`hide()` 对浮窗 = 关闭并丢内容状态，见
 * docs/p3/contracts.md C12），因此收起 = 对官方浮窗元素做**可见性注入**：
 *   `[data-onestep-peek="1"]` + 内联 `transform: translateX(calc(100% + 24px)) !important`、
 *   `pointer-events: none !important` + `inert` + `aria-hidden="true"`；
 * 官方 tab/布局状态保持不变；恢复 = 移除上述注入并归还焦点。
 *
 * 右缘标签层 = `ReactDOM.createPortal` 到 `document.body` 的 fixed 堆叠按钮
 * （z 层 63：高于浮窗层 60、低于官方菜单），点击恢复单个浮窗。
 *
 * 对账/重放：官方 re-render 可能重写 `inert`/`aria-hidden`（contracts.md §10 R-09），
 * 用 MutationObserver（仅在存在收起项时开启）按 tabId 重新注入；切会话时由调用方
 * `setItems(sessionId, items)` 换数据。
 *
 * 本模块只读 DOM + 注入可见性属性，不改官方状态/内容；卸载时全部还原。
 */
import { COMPANION } from './adapter.js'
import { MOTION } from './motion.js'

export const TAG_ATTR = 'data-onestep-peek-tag'
export const TAG_GRIP_ATTR = 'data-onestep-peek-grip'
export const TRACK_ATTR = 'data-onestep-peek-track'
/** 0.7.0：标签堆容器（整堆可拖动，不再只依赖顶部手柄）。 */
export const STACK_ATTR = 'data-onestep-peek-stack'
export const LAYER_ATTR = 'data-onestep-peek-layer'
export const FLOAT_ID_PREFIX = 'onestep-float-'
/** P4-7：恢复位移过渡期间标记（移除该属性即失去 transition，故延迟清理）。 */
export const PEEK_RESTORING_ATTR = 'data-onestep-peek-restoring'

/** 桌面 App 自定义标题栏高度 CSS 变量（页面内 40px；web profile 无此变量）。 */
export const TITLEBAR_VAR = '--dsh-windows-titlebar-height'
/** 标签层默认上边距（无标题栏时）。 */
export const PEEK_LAYER_DEFAULT_TOP = 16
/** 标签层与视口底部的安全间距。 */
export const PEEK_LAYER_BOTTOM_GAP = 8
/** 标签拖动手柄高度 + 间隙（底部边界估算用）。 */
export const PEEK_LAYER_GRIP_SPACE = 22
/** 0.7.0：松手吸附阈值（px，接近上下边界/默认安全位置时吸附）。 */
export const PEEK_SNAP = COMPANION.defaults.peekSnap
/** 0.7.0：在整堆上按下后移动多少像素才视为拖动（用于和点击区分）。 */
export const PEEK_TAG_DRAG_THRESHOLD = 4

/**
 * 读取桌面标题栏高度（web/隔离 profile 返回 0）。
 * @param {Document|null} [doc]
 * @returns {number}
 */
export function readTitlebarHeight(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || !doc.documentElement) return 0
  try {
    const raw = (doc.defaultView || window).getComputedStyle(doc.documentElement).getPropertyValue(TITLEBAR_VAR)
    const value = Number.parseFloat(raw)
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch (_error) {
    return 0
  }
}

/**
 * 标签层默认顶部位置：16 + 标题栏高度（避开桌面窗口控制按钮）。
 * @param {number} [titlebarHeight]
 * @returns {number}
 */
export function defaultPeekTop(titlebarHeight = readTitlebarHeight()) {
  const bar = Number.isFinite(titlebarHeight) && titlebarHeight > 0 ? titlebarHeight : 0
  return PEEK_LAYER_DEFAULT_TOP + bar
}

/**
 * 标签层最小顶部位置：不覆盖桌面标题栏/窗口控制。
 * @param {number} [titlebarHeight]
 * @returns {number}
 */
export function minPeekTop(titlebarHeight = readTitlebarHeight()) {
  const bar = Number.isFinite(titlebarHeight) && titlebarHeight > 0 ? titlebarHeight : 0
  return bar > 0 ? bar + 8 : PEEK_LAYER_DEFAULT_TOP / 2
}

/**
 * 标签层可用纵向范围（夹取/吸附共用；纯函数）。
 * @param {{viewportHeight?:number, layerHeight?:number, minTop?:number}} [options]
 * @returns {{minTop:number, maxTop:number}}
 */
export function peekTopRange(options = {}) {
  const minTop = Number.isFinite(options.minTop) ? Math.max(0, Math.round(options.minTop)) : minPeekTop()
  const viewportHeight = Number.isFinite(options.viewportHeight) ? options.viewportHeight : 0
  const layerHeight = Number.isFinite(options.layerHeight) ? Math.max(0, Math.round(options.layerHeight)) : 0
  const maxTop = viewportHeight > 0 ? Math.max(minTop, Math.round(viewportHeight - layerHeight - PEEK_LAYER_BOTTOM_GAP)) : Number.MAX_SAFE_INTEGER
  return { minTop, maxTop }
}

/**
 * 夹取标签层顶部位置（拖动/键盘/窗口缩放共用；纯函数）。
 * @param {number} top 期望位置
 * @param {{viewportHeight?:number, layerHeight?:number, minTop?:number}} [options]
 * @returns {number}
 */
export function clampPeekTop(top, options = {}) {
  const { minTop, maxTop } = peekTopRange(options)
  const value = Number.isFinite(top) ? Math.round(top) : minTop
  return Math.min(Math.max(value, minTop), maxTop)
}

/**
 * 松手吸附（0.7.0）：先夹取，再在阈值内吸附到上沿/下沿/默认安全位置（纯函数）。
 * @param {number} top 松手位置
 * @param {{viewportHeight?:number, layerHeight?:number, minTop?:number, defaultTop?:number, snap?:number}} [options]
 * @returns {number}
 */
export function snapPeekTop(top, options = {}) {
  const clamped = clampPeekTop(top, options)
  const { minTop, maxTop } = peekTopRange(options)
  const snap = Number.isFinite(options.snap) ? Math.max(0, Number(options.snap)) : PEEK_SNAP
  const candidates = [minTop, maxTop]
  if (Number.isFinite(options.defaultTop)) candidates.push(Math.round(options.defaultTop))
  let result = clamped
  let bestDistance = Infinity
  for (const candidate of candidates) {
    if (candidate < minTop || candidate > maxTop) continue
    const distance = Math.abs(candidate - clamped)
    if (distance <= snap && distance < bestDistance) {
      result = candidate
      bestDistance = distance
    }
  }
  return result
}

/** kind → 字形图标（生产精修可换 ui-primitives；先保证零 CJK、可读）。 */
const KIND_GLYPHS = {
  guide: '◎',
  text: '▤',
  files: '▥',
  terminal: '▣',
  plan: '☰',
  'changes-review': '±',
  subagentchat: '◈',
  scheduleTask: '◷',
}

/**
 * @param {string} kind 官方 tab kind
 * @returns {string} 单字形
 */
export function glyphForKind(kind) {
  return KIND_GLYPHS[kind] || '◇'
}

/**
 * 当前会话的右栏 panel（`[data-sidebar-right-panel][data-sidebar-right-session]`）。
 * 背景会话的 panel 在文档中但被 `hidden` 包裹，这里排除。
 * @param {string|null|undefined} sessionId
 * @returns {Element|null}
 */
export function findSessionPanel(sessionId) {
  if (!sessionId) return null
  const panels = document.querySelectorAll(COMPANION.selectors.panel)
  for (const panel of panels) {
    if (panel.getAttribute(COMPANION.attrs.session) !== sessionId) continue
    if (panel.closest('[hidden]')) continue
    return panel
  }
  return null
}

/**
 * 按 tabId 找官方浮窗元素（优先当前会话 panel；找不到再全局兜底）。
 * @param {string|null|undefined} sessionId
 * @param {string} tabId
 * @returns {Element|null}
 */
export function findFloatElement(sessionId, tabId) {
  const target = String(tabId)
  const panel = findSessionPanel(sessionId)
  const roots = panel ? [panel] : Array.from(document.querySelectorAll(COMPANION.selectors.panel))
  for (const root of roots) {
    for (const element of root.querySelectorAll(COMPANION.selectors.float)) {
      if (element.getAttribute(COMPANION.attrs.content) === target) return element
    }
  }
  return null
}

/** 收起/恢复过渡的清理定时器（按元素；WeakMap 不便全局清理，用 Map + dispose）。 */
const peekTimers = new Map()

/** 当前是否 reduced（与 index.js 的 <html data-onestep-motion> 单一事实源一致）。 */
function peekReducedMotion() {
  try {
    if (typeof document !== 'undefined' && document.documentElement && document.documentElement.getAttribute('data-onestep-motion') === 'reduced') return true
  } catch (_error) {
    /* ignore */
  }
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch (_error) {
    return false
  }
}

/** 元素可测量且非 reduced 时才做 180ms 过渡（fake/jsdom 环境跳过，不挂定时器）。 */
function canAnimatePeek(element) {
  return !!element && typeof element.getBoundingClientRect === 'function' && !peekReducedMotion()
}

function clearPeekTimer(element) {
  const timer = peekTimers.get(element)
  if (timer !== undefined) {
    clearTimeout(timer)
    peekTimers.delete(element)
  }
}

/** 清理全部收起/恢复过渡定时器（createPeekLayer dispose 与测试用）。 */
export function disposePeekMotionTimers() {
  for (const timer of peekTimers.values()) clearTimeout(timer)
  peekTimers.clear()
}

/**
 * 对单个浮窗元素注入/还原收起可见性（不改官方状态）。
 * P4-7：收起/恢复带 180ms transform 过渡（属性先加、强制一次样式计算再改 transform）；
 * reduced 或不可测量元素退化为直切。
 *
 * @param {Element} element
 * @param {boolean} peeked
 * @param {number} [offset] 位移量（默认 COMPANION.defaults.peekOffset）
 */
export function applyPeekToElement(element, peeked, offset = COMPANION.defaults.peekOffset) {
  if (!element || !element.style) return
  clearPeekTimer(element)
  if (peeked) {
    // 幂等守卫：同值 setAttribute 同样会产生 MutationObserver 记录，而观察器会安排下一帧重放；
    // 若每次都无条件重写，就形成「observer → rAF → 再注入 → observer」的永久循环（0.7.0 审查 F1）。
    if (
      element.getAttribute(COMPANION.attrs.peek) === '1' &&
      element.style.getPropertyValue('transform') &&
      element.hasAttribute('inert') &&
      element.getAttribute('aria-hidden') === 'true'
    ) {
      return
    }
    const tabId = element.getAttribute(COMPANION.attrs.content)
    if (tabId && !element.id) element.id = FLOAT_ID_PREFIX + tabId
    // 用「视口宽 + offset」平移（而非 100% 自身宽）：多槽位时左侧浮窗也必须移出右缘。
    element.setAttribute(COMPANION.attrs.peek, '1')
    if (canAnimatePeek(element)) {
      // 先让 transition 规则生效（属性已加），再改 transform，否则同一帧内不会触发过渡。
      try {
        element.getBoundingClientRect()
      } catch (_error) {
        /* ignore */
      }
    }
    element.style.setProperty('transform', 'translateX(calc(100vw + ' + offset + 'px))', 'important')
    element.style.setProperty('pointer-events', 'none', 'important')
    element.setAttribute('inert', '')
    element.setAttribute('aria-hidden', 'true')
  } else {
    const wasPeeked = element.getAttribute(COMPANION.attrs.peek) === '1'
    const animate = wasPeeked && canAnimatePeek(element)
    // 恢复顺序：先加 restoring（保住 transition 规则）→ 移除 peek/transform（触发过渡）→ 180ms 后清理。
    if (animate) element.setAttribute(PEEK_RESTORING_ATTR, '1')
    element.removeAttribute(COMPANION.attrs.peek)
    element.style.removeProperty('transform')
    element.style.removeProperty('pointer-events')
    element.removeAttribute('inert')
    element.removeAttribute('aria-hidden')
    try {
      element.inert = false
    } catch (_error) {
      /* 老引擎无 inert 属性时忽略 */
    }
    if (animate) {
      const timer = setTimeout(() => {
        peekTimers.delete(element)
        try {
          element.removeAttribute(PEEK_RESTORING_ATTR)
        } catch (_error) {
          /* ignore */
        }
      }, MOTION.peek)
      peekTimers.set(element, timer)
    }
  }
}

/**
 * 按 tabId 注入/还原收起态。
 * @param {string|null|undefined} sessionId
 * @param {string} tabId
 * @param {boolean} peeked
 * @returns {boolean} 是否找到元素
 */
export function applyFloatPeek(sessionId, tabId, peeked) {
  const element = findFloatElement(sessionId, tabId)
  if (!element) return false
  applyPeekToElement(element, !!peeked)
  return true
}

/**
 * 恢复后把焦点送进浮窗内容（官方浮窗元素通常不可聚焦，退到内部首个可聚焦项）。
 * @param {Element|null} element
 */
export function focusInsideFloat(element) {
  if (!element) return false
  try {
    const focusable = element.querySelector('button, [href], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]')
    if (focusable && typeof focusable.focus === 'function') {
      focusable.focus()
      return true
    }
    element.focus()
    return true
  } catch (_error) {
    return false
  }
}

/**
 * 创建收起/标签层控制器。
 *
 * @param {object} deps
 * @param {(key:string, params?:object)=>string} deps.t i18n
 * @param {(event:string, data?:object|null)=>void} [deps.log]
 * @param {()=>void} [deps.onPeekAll] 点击浮窗外/标签层外时调用（收起全部）
 * @param {(tabId:string)=>void} [deps.onRestore] 点击标签时调用（只恢复该窗）
 * @returns {object} 控制器
 */
export function createPeekLayer(deps) {
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const t = typeof deps.t === 'function' ? deps.t : (key) => key
  const listeners = new Set()
  let snapshot = { sessionId: null, items: [] }
  let observer = null
  let frame = 0
  let disposed = false
  let outsideHandler = null
  let outsideDispose = null

  const publish = () => {
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch (_error) {
        /* 订阅方异常不影响其它订阅 */
      }
    }
  }
  const subscribe = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const getSnapshot = () => snapshot
  const peekedItems = () => snapshot.items.filter((item) => item.peeked)

  const reapplyNow = () => {
    if (disposed) return
    const items = peekedItems()
    if (items.length === 0) {
      stopObserver()
      return
    }
    for (const item of items) applyFloatPeek(snapshot.sessionId, item.tabId, true)
  }
  const scheduleReapply = () => {
    if (disposed || frame) return
    try {
      frame = requestAnimationFrame(() => {
        frame = 0
        reapplyNow()
      })
    } catch (_error) {
      frame = 0
      reapplyNow()
    }
  }
  const startObserver = () => {
    if (observer || disposed || typeof MutationObserver === 'undefined') return
    try {
      const onMutations = (records) => {
        // 自身对已收起元素重复写 data-onestep-peek 不算有效变化（F1 的循环入口）。
        const meaningful = records.some((record) => {
          if (record.type !== 'attributes' || record.attributeName !== COMPANION.attrs.peek) return true
          const target = record.target
          return !(target && typeof target.getAttribute === 'function' && target.getAttribute(COMPANION.attrs.peek) === '1')
        })
        if (meaningful) scheduleReapply()
      }
      observer = new MutationObserver(onMutations)
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [COMPANION.attrs.content, COMPANION.attrs.session, 'hidden', COMPANION.attrs.peek],
      })
    } catch (error) {
      observer = null
      log('peek.observe.error', { error: String(error).slice(0, 120) })
    }
  }
  const stopObserver = () => {
    if (observer) {
      observer.disconnect()
      observer = null
    }
  }
  const syncObserver = () => {
    if (peekedItems().length > 0) startObserver()
    else stopObserver()
  }

  /**
   * 更新标签层数据（切换会话/状态变化时调用）。
   * @param {string|null} sessionId
   * @param {Array<{tabId:string,title?:string,kind?:string,slot?:number,peeked?:boolean}>} items
   */
  const setItems = (sessionId, items) => {
    if (disposed) return
    const next = (Array.isArray(items) ? items : []).map((item, index) => ({
      tabId: String(item.tabId),
      title: typeof item.title === 'string' ? item.title : '',
      kind: typeof item.kind === 'string' ? item.kind : '',
      slot: Number.isInteger(item.slot) ? item.slot : index,
      peeked: !!item.peeked,
    }))
    snapshot = { sessionId: sessionId || null, items: next }
    publish()
    for (const item of next) if (item.peeked) applyFloatPeek(snapshot.sessionId, item.tabId, true)
    syncObserver()
  }

  /** 外部 DOM 变化后手动重放（探针/对账用）。 */
  const reapply = () => {
    scheduleReapply()
    return peekedItems().length
  }

  /**
   * 收起/恢复某个 tab 的 DOM（状态由调用方维护）。
   * @param {string} tabId
   * @param {boolean} peeked
   * @returns {boolean}
   */
  const setPeeked = (tabId, peeked) => {
    const applied = applyFloatPeek(snapshot.sessionId, tabId, peeked)
    if (peeked) syncObserver()
    else if (peekedItems().length === 0) stopObserver()
    return applied
  }

  /** 聚焦对应标签按钮（收起后键盘可达）。 */
  const focusTag = (tabId) => {
    try {
      const selector = '[' + TAG_ATTR + '="' + String(tabId).replace(/"/g, '\\"') + '"]'
      const element = document.querySelector(selector)
      if (element && typeof element.focus === 'function') {
        element.focus()
        return true
      }
    } catch (_error) {
      /* ignore */
    }
    return false
  }

  /** 焦点送进恢复后的浮窗内容。 */
  const focusFloat = (tabId) => focusInsideFloat(findFloatElement(snapshot.sessionId, tabId))

  /**
   * 点击浮窗外（且不在标签层/官方菜单/浮层内、位于舞台区域）→ 收起全部。
   * @returns {()=>void} dispose
   */
  const installOutsideClick = () => {
    if (outsideDispose) return outsideDispose
    const handler = (event) => {
      if (disposed) return
      const target = event.target
      if (!target || typeof target.closest !== 'function') return
      if (target.closest('[' + LAYER_ATTR + ']')) return
      if (target.closest(COMPANION.selectors.float)) return
      if (target.closest(COMPANION.selectors.menuMaterial)) return
      if (target.closest(COMPANION.selectors.menu)) return
      const stage = document.querySelector(COMPANION.selectors.stage)
      if (!stage || !(stage === target || stage.contains(target))) return
      const visible = snapshot.items.filter((item) => !item.peeked)
      if (visible.length === 0) return
      if (typeof deps.onPeekAll === 'function') deps.onPeekAll()
    }
    document.addEventListener('pointerdown', handler, true)
    outsideHandler = handler
    outsideDispose = () => {
      document.removeEventListener('pointerdown', handler, true)
      outsideHandler = null
      outsideDispose = null
    }
    return outsideDispose
  }

  /** 标签点击 → 恢复单个浮窗（组件在 peek-tags.js）。 */
  const restoreTab = (tabId) => {
    if (typeof deps.onRestore === 'function') {
      deps.onRestore(String(tabId))
      return true
    }
    return false
  }

  /** 卸载：移除标签层数据、observer、监听与注入（由 index.js 调用）。 */
  const dispose = () => {
    disposed = true
    disposePeekMotionTimers()
    stopObserver()
    if (frame) {
      try {
        cancelAnimationFrame(frame)
      } catch (_error) {
        /* ignore */
      }
      frame = 0
    }
    if (outsideDispose) outsideDispose()
    outsideHandler = null
    listeners.clear()
  }

  /** 统计（探针）：标签 DOM 数量 / 收起项数量。 */
  const snapshotStats = () => ({
    sessionId: snapshot.sessionId,
    items: snapshot.items.length,
    peeked: peekedItems().length,
    tags: document.querySelectorAll('[' + TAG_ATTR + ']').length,
    layer: !!document.querySelector('[' + LAYER_ATTR + ']'),
  })

  return {
    subscribe,
    getSnapshot,
    setItems,
    setPeeked,
    reapply,
    focusTag,
    focusFloat,
    restoreTab,
    installOutsideClick,
    dispose,
    snapshotStats,
    hasOutsideHandler: () => !!outsideHandler,
  }
}
