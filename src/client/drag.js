/**
 * P1-7 拖拽编排：document 级 dragstart 捕获 + 普通模式落点 HUD。
 *
 * 数据协议（P0 S7 已验证）：
 *   - dragstart capture 阶段读 target.closest('[data-row-key]') → "session:<id>"；
 *   - drop 阶段读 dataTransfer.getData('text/plain') → 纯 sessionId（Chromium 在 dragover 阶段拿不到数据）。
 * 原则：只在会话区（普通模式）/舞台内（舞台模式）preventDefault；侧栏内部重排交给官方。
 */
import { React, h } from './h.js'

/** 创建拖拽状态信号（供 overlay 与 StageRoot 使用）。 */
export function createDragSignal() {
  let value = { active: false, sessionId: null, rowKey: null, over: null }
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next) {
      if (next === value) return false
      value = next
      for (const listener of Array.from(listeners)) {
        try {
          listener(value)
        } catch (_error) {
          /* ignore */
        }
      }
      return true
    },
  }
}

/**
 * 安装拖拽编排：dragstart/dragend + document 级 dragover/drop 捕获。
 *
 * 为什么 drop 走 document capture（而不是 React 合成事件）：DSH 主框架对拖拽事件有
 * 自己的捕获/委托层，React 合成 drop 在实测中不一定送达插件 overlay；capture 阶段在
 * 文档最外层最先执行，可稳定拿到 target/dataTransfer 并 preventDefault 允许投放。
 *
 * @param {object} signal createDragSignal() 返回值
 * @param {{log:Function, getStageMounted:Function, isSessionId:Function, onDrop:Function}} options
 * @returns {() => void} disposer
 */
export function installDragCapture(signal, options) {
  const readRow = (target) => {
    if (!target || typeof target.closest !== 'function') return null
    const row = target.closest('[data-row-key]')
    return row ? String(row.getAttribute('data-row-key') || '') : null
  }
  const readId = (event) => {
    let text = ''
    try {
      text = event.dataTransfer ? String(event.dataTransfer.getData('text/plain') || '') : ''
    } catch (_error) {
      text = ''
    }
    if (text) {
      if (text.indexOf('session:') === 0) return text.slice('session:'.length)
      if (text.indexOf('workspace:') === 0) return null
      return text
    }
    const current = signal.getSnapshot()
    return current.active ? current.sessionId : null
  }
  /** 判定拖拽落点 zone（普通模式 HUD / 舞台内窗口）。 */
  const zoneOf = (target) => {
    if (!target || typeof target.closest !== 'function') return null
    if (target.closest('[data-onestep-drag-hud]')) return 'focus'
    if (target.closest('[data-onestep-drag-rail]')) return 'rail'
    if (!options.getStageMounted()) return null
    if (target.closest('[data-onestep-stage] .onestep-frame[data-mode="focus"]')) return 'focus'
    if (target.closest('[data-onestep-stage]')) return 'rail'
    return null
  }
  const onStart = (event) => {
    const rowKey = readRow(event.target)
    if (!rowKey || rowKey.indexOf('session:') !== 0) return
    let text = ''
    try {
      text = event.dataTransfer ? String(event.dataTransfer.getData('text/plain') || '') : ''
    } catch (_error) {
      text = ''
    }
    const sessionId = text && text.indexOf('session:') !== 0 ? text : rowKey.slice('session:'.length)
    signal.set({ active: true, sessionId, rowKey, over: null })
    options.log.log('drag.start', { rowKey, sessionId: sessionId.slice(0, 16) })
  }
  const onEnd = () => {
    if (!signal.getSnapshot().active) return
    signal.set({ active: false, sessionId: null, rowKey: null, over: null })
    options.log.log('drag.end', null)
  }
  const setOver = (zone) => {
    const current = signal.getSnapshot()
    if (!current.active || current.over === zone) return
    signal.set({ ...current, over: zone })
  }
  const onDragOver = (event) => {
    if (!signal.getSnapshot().active) return
    const zone = zoneOf(event.target)
    if (!zone) {
      setOver(null)
      return
    }
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    setOver(zone)
  }
  const onDrop = (event) => {
    if (!signal.getSnapshot().active) return
    const zone = zoneOf(event.target)
    if (!zone) {
      setOver(null)
      return
    }
    const sessionId = readId(event)
    event.preventDefault()
    event.stopPropagation()
    options.log.log('drag.drop', { zone, sessionId: sessionId ? sessionId.slice(0, 16) : null })
    if (sessionId && (!options.isSessionId || options.isSessionId(sessionId))) {
      options.onDrop(sessionId, zone)
    }
    signal.set({ active: false, sessionId: null, rowKey: null, over: null })
  }
  document.addEventListener('dragstart', onStart, true)
  document.addEventListener('dragend', onEnd, true)
  document.addEventListener('dragover', onDragOver, true)
  document.addEventListener('drop', onDrop, true)
  return () => {
    document.removeEventListener('dragstart', onStart, true)
    document.removeEventListener('dragend', onEnd, true)
    document.removeEventListener('dragover', onDragOver, true)
    document.removeEventListener('drop', onDrop, true)
  }
}

/**
 * 读取 drop 的 sessionId：优先 dataTransfer text/plain（P0 实测），回退 dragstart 捕获。
 * @param {DragEvent} event drop 事件
 * @param {object} signal 拖拽信号
 * @returns {string|null}
 */
export function readDropSessionId(event, signal) {
  let text = ''
  try {
    text = event.dataTransfer ? String(event.dataTransfer.getData('text/plain') || '') : ''
  } catch (_error) {
    text = ''
  }
  if (text) {
    if (text.indexOf('session:') === 0) return text.slice('session:'.length)
    if (text.indexOf('workspace:') === 0) return null
    return text
  }
  const current = signal.getSnapshot()
  return current.active ? current.sessionId : null
}

/** 计算会话主区（普通模式 HUD 的覆盖范围）。 */
function mainAreaRect() {
  const candidates = ['main', '[data-conversation-content]', '[class*="AppFrame"]']
  for (const selector of candidates) {
    const element = document.querySelector(selector)
    if (element) {
      const rect = element.getBoundingClientRect()
      if (rect.width > 320 && rect.height > 240) return { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
    }
  }
  return { x: 304, y: 0, w: Math.max(480, window.innerWidth - 304), h: window.innerHeight }
}

/**
 * 普通模式「拖入即进入舞台」HUD + drop 处理。
 * @param {object} props {t, signal, onDropSession(zone), isStageMounted(), isSessionId(id)}
 */
export function StageDragOverlay(props) {
  const drag = React.useSyncExternalStore(props.signal.subscribe, props.signal.getSnapshot, props.signal.getSnapshot)
  const [over, setOver] = React.useState(null)
  const [rect, setRect] = React.useState(() => ({ x: 0, y: 0, w: 0, h: 0 }))

  React.useEffect(() => {
    if (drag.active && !props.isStageMounted()) setRect(mainAreaRect())
    if (!drag.active && over !== null) setOver(null)
  }, [drag.active, over])

  if (!drag.active || props.isStageMounted()) return null
  const railWidth = Math.min(170, Math.max(110, rect.w * 0.15))
  const gap = 12
  const focusZone = { x: rect.x + railWidth + gap + 8, y: rect.y + 8, width: Math.max(240, rect.w - railWidth - gap - 24), height: rect.h - 16 }
  const railZone = { x: rect.x + 8, y: rect.y + 8, width: railWidth, height: rect.h - 16 }
  const zoneStyle = (zone, active) => ({
    position: 'fixed',
    left: zone.x,
    top: zone.y,
    width: zone.width,
    height: zone.height,
    zIndex: 2147482000,
    pointerEvents: 'auto',
    borderRadius: 14,
    border: '2px dashed ' + (active ? 'var(--dsw-alias-state-success-primary,#22c55e)' : 'color-mix(in srgb, var(--dsw-alias-state-success-primary,#22c55e) 55%, transparent)'),
    background: active
      ? 'color-mix(in srgb, var(--dsw-alias-state-success-primary,#22c55e) 22%, transparent)'
      : 'color-mix(in srgb, var(--dsw-alias-state-success-primary,#22c55e) 9%, transparent)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--dsw-alias-label-primary,#e6e6e6)',
    font: '13px/1.4 var(--dsw-font-family,system-ui,sans-serif)',
    boxShadow: active ? 'inset 0 0 0 1px var(--dsw-alias-state-success-primary,#22c55e)' : 'none',
  })
  /** 落点文案常显（设计稿 01-drag-to-zone：两区标签始终可见），hover 时高亮。 */
  const zoneLabel = (text, active) => h('span', { style: { opacity: active ? 1 : 0.72, fontWeight: active ? 600 : 500, transition: 'opacity var(--onestep-fast) ease' } }, text)
  const onOver = (zone) => (event) => {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    if (over !== zone) setOver(zone)
  }
  const onDrop = (zone) => (event) => {
    event.preventDefault()
    event.stopPropagation()
    setOver(null)
    const sessionId = readDropSessionId(event, props.signal)
    if (sessionId && (!props.isSessionId || props.isSessionId(sessionId))) props.onDropSession(sessionId, zone)
  }
  return h(
    React.Fragment,
    null,
    h(
      'div',
      {
        'data-onestep-drag-hud': '1',
        className: 'onestep-hud-zone',
        style: zoneStyle(focusZone, over === 'focus'),
        onDragOver: onOver('focus'),
        onDragLeave: () => setOver((value) => (value === 'focus' ? null : value)),
        onDrop: onDrop('focus'),
        'aria-label': props.t('hud.focus') + ' → ' + props.t('window.focus'),
      },
      zoneLabel(props.t('hud.focus'), over === 'focus'),
    ),
    h(
      'div',
      {
        'data-onestep-drag-rail': '1',
        className: 'onestep-hud-zone',
        style: zoneStyle(railZone, over === 'rail'),
        onDragOver: onOver('rail'),
        onDragLeave: () => setOver((value) => (value === 'rail' ? null : value)),
        onDrop: onDrop('rail'),
        'aria-label': props.t('hud.rail'),
      },
      zoneLabel(props.t('hud.rail'), over === 'rail'),
    ),
  )
}
