/**
 * P3-11 右缘标签层组件（React 部分；DOM/状态逻辑在 peek-layer.js，便于单测）。
 *
 * 通过 `createPortal` 渲染到 `document.body`：portal 在 app root 之外，
 * 层序按 `.onestep-peek-layer` 的 z-index 63（浮窗 60 < 标签 63 < 官方菜单）确定。
 * 标签为原生 button：`aria-expanded`/`aria-controls` 指向浮窗元素 id，Enter/Space 原生激活。
 *
 * 位置（US-3/4 / G3；0.7.0 拖动增强）：
 * - 默认 top = 16 + 桌面标题栏高度，避免压住右上角窗口控制按钮；
 * - **整堆可拖**：在任意标签上按下并上下移动 ≥4px 即拖动整堆（不再只依赖顶部手柄），
 *   松手在阈值内吸附到上沿/下沿/默认安全位置；点击语义不受影响（移动才抑制本次点击）；
 * - 顶部保留拖动手柄（`data-onestep-peek-grip`）：指针拖动 / ↑↓（Shift 24px）/ Home/End；
 * - 标签层始终贴右缘（`right:0`，拖动只改纵向位置）；
 * - 位置按全局 UI 偏好持久化（`anchor.get/set` 由调用方接 float-state 的 `ui.peekTop`）。
 */
import ReactDOM from 'react-dom'
import { React, h } from './h.js'
import {
  FLOAT_ID_PREFIX,
  LAYER_ATTR,
  PEEK_TAG_DRAG_THRESHOLD,
  STACK_ATTR,
  TAG_ATTR,
  TAG_GRIP_ATTR,
  TRACK_ATTR,
  clampPeekTop,
  defaultPeekTop,
  glyphForKind,
  minPeekTop,
  readTitlebarHeight,
  snapPeekTop,
} from './peek-layer.js'

/**
 * @param {object} controller `createPeekLayer()` 返回的控制器
 * @param {(key:string, params?:object)=>string} t i18n
 * @param {{get?:()=>number|null, set?:(top:number)=>void}} [anchor] 持久化接口（缺省则仅本次挂载内有效）
 * @returns {Function} overlay 槽组件
 */
export function createPeekTagLayer(controller, t, anchor = {}) {
  const getStored = typeof anchor.get === 'function' ? anchor.get : () => null
  const setStored = typeof anchor.set === 'function' ? anchor.set : () => {}

  function PeekTagLayer() {
    const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
    const peeked = state.items.filter((item) => item.peeked)
    const ordered = peeked.slice().sort((a, b) => a.slot - b.slot)
    const trackRef = React.useRef(null)
    const topRef = React.useRef(null)
    const dragRef = React.useRef({ active: false, startY: 0, startTop: 0, pointerId: null })
    const stackDragRef = React.useRef({ active: false, startY: 0, startTop: 0, pointerId: null, moved: false })
    const suppressClickRef = React.useRef(false)
    const [top, setTop] = React.useState(() => {
      const stored = getStored()
      const fallback = defaultPeekTop(readTitlebarHeight())
      const value = Number.isFinite(stored) ? stored : fallback
      topRef.current = value
      return value
    })
    const [dragging, setDragging] = React.useState(false)

    const measureHeight = () => {
      const element = trackRef.current
      if (element && typeof element.getBoundingClientRect === 'function') {
        const height = element.getBoundingClientRect().height
        if (Number.isFinite(height) && height > 0) return height
      }
      return 19 + peeked.length * 44
    }
    const rangeOptions = () => ({
      viewportHeight: window.innerHeight,
      layerHeight: measureHeight(),
      minTop: minPeekTop(),
      defaultTop: defaultPeekTop(readTitlebarHeight()),
    })
    const clamp = (value) => clampPeekTop(value, rangeOptions())
    const applyTop = (value, persist) => {
      const next = clamp(value)
      if (next !== topRef.current) {
        topRef.current = next
        setTop(next)
      }
      if (persist) setStored(next)
    }
    /** 松手：夹取 + 吸附到上/下边或默认安全位置，并持久化。 */
    const settleTop = () => {
      const next = snapPeekTop(topRef.current, rangeOptions())
      if (next !== topRef.current) {
        topRef.current = next
        setTop(next)
      }
      setStored(next)
    }

    React.useEffect(() => {
      const onResize = () => applyTop(topRef.current, false)
      window.addEventListener('resize', onResize)
      return () => window.removeEventListener('resize', onResize)
    }, [peeked.length])

    React.useEffect(() => {
      if (peeked.length > 0) applyTop(topRef.current, false)
    }, [peeked.length])

    const endDrag = (event) => {
      if (!dragRef.current.active) return
      dragRef.current.active = false
      setDragging(false)
      try {
        if (event && event.currentTarget && typeof event.currentTarget.releasePointerCapture === 'function') {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      } catch (_error) {
        /* pointer capture 可能在浏览器取消后失效 */
      }
      settleTop()
    }
    const onGripPointerDown = (event) => {
      if (typeof event.button === 'number' && event.button !== 0) return
      event.preventDefault()
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch (_error) {
        /* ignore */
      }
      dragRef.current = { active: true, startY: event.clientY, startTop: topRef.current, pointerId: event.pointerId }
      setDragging(true)
    }
    const onGripPointerMove = (event) => {
      if (!dragRef.current.active) return
      event.preventDefault()
      applyTop(dragRef.current.startTop + (event.clientY - dragRef.current.startY), false)
    }
    const onGripKeyDown = (event) => {
      const step = event.shiftKey ? 24 : 8
      let next = null
      if (event.key === 'ArrowUp') next = topRef.current - step
      else if (event.key === 'ArrowDown') next = topRef.current + step
      else if (event.key === 'Home') next = minPeekTop()
      else if (event.key === 'End') next = clampPeekTop(Number.MAX_SAFE_INTEGER, rangeOptions())
      if (next === null) return
      event.preventDefault()
      applyTop(next, true)
    }

    // 0.7.0：整堆拖动（任意标签上按下 + 上下移动 ≥4px；点击语义保持不变）。
    // 不做 pointer capture：避免把 tag 的 click 目标改到容器上；用 window 监听跟随移动。
    const detachStackRef = React.useRef(null)
    const onStackPointerDown = (event) => {
      if (typeof event.button === 'number' && event.button !== 0) return
      const target = event.target
      if (target && typeof target.closest === 'function' && target.closest('[' + TAG_GRIP_ATTR + ']')) return
      if (detachStackRef.current) return
      const pointerId = event.pointerId
      const startY = event.clientY
      const startTop = topRef.current
      const drag = { moved: false }
      stackDragRef.current = { active: true, startY, startTop, pointerId, moved: false }
      const view = window
      const detach = () => {
        detachStackRef.current = null
        stackDragRef.current = { active: false, startY: 0, startTop: 0, pointerId: null, moved: false }
        view.removeEventListener('pointermove', onMove, true)
        view.removeEventListener('pointerup', onUp, true)
        view.removeEventListener('pointercancel', onCancel, true)
      }
      const onMove = (moveEvent) => {
        if (moveEvent.pointerId !== pointerId) return
        const delta = moveEvent.clientY - startY
        if (!drag.moved) {
          if (Math.abs(delta) < PEEK_TAG_DRAG_THRESHOLD) return
          drag.moved = true
          stackDragRef.current.moved = true
          setDragging(true)
        }
        try {
          moveEvent.preventDefault()
        } catch (_error) {
          /* ignore */
        }
        applyTop(startTop + delta, false)
      }
      const onUp = (upEvent) => {
        if (upEvent.pointerId !== pointerId) return
        detach()
        setDragging(false)
        if (!drag.moved) return
        // 移动过：抑制紧随其后的 click（避免松手被当成「恢复该浮窗」）。
        suppressClickRef.current = true
        setTimeout(() => {
          suppressClickRef.current = false
        }, 0)
        settleTop()
      }
      const onCancel = () => {
        detach()
        setDragging(false)
      }
      detachStackRef.current = detach
      view.addEventListener('pointermove', onMove, true)
      view.addEventListener('pointerup', onUp, true)
      view.addEventListener('pointercancel', onCancel, true)
    }
    React.useEffect(() => () => {
      if (detachStackRef.current) detachStackRef.current()
    }, [])

    if (peeked.length === 0) return null
    const nodes = ordered.map((item) =>
      h(
        'button',
        {
          key: item.tabId,
          type: 'button',
          className: 'onestep-peek-tag',
          [TAG_ATTR]: item.tabId,
          title: item.title || item.kind,
          'aria-label': t('a11y.companionTag', { title: item.title || item.kind }),
          'aria-expanded': 'false',
          'aria-controls': FLOAT_ID_PREFIX + item.tabId,
          onClick: (event) => {
            event.stopPropagation()
            if (suppressClickRef.current) {
              suppressClickRef.current = false
              return
            }
            controller.restoreTab(item.tabId)
          },
        },
        h('span', { className: 'onestep-peek-glyph', 'aria-hidden': 'true' }, glyphForKind(item.kind)),
        h('span', { className: 'onestep-peek-label' }, item.title || item.kind),
      ),
    )
    const gripLabel = t('a11y.companionTagDrag')
    const layer = h(
      'div',
      { className: 'onestep-peek-layer', [LAYER_ATTR]: '1', role: 'toolbar', 'aria-label': t('a11y.companionTags') },
      h(
        'div',
        { className: 'onestep-peek-track', [TRACK_ATTR]: '1', ref: trackRef, style: { top: Math.round(top) + 'px' } },
        h(
          'div',
          {
            className: 'onestep-peek-grip',
            [TAG_GRIP_ATTR]: '1',
            role: 'button',
            tabIndex: 0,
            title: gripLabel,
            'aria-label': gripLabel,
            'data-dragging': dragging ? '1' : undefined,
            onPointerDown: onGripPointerDown,
            onPointerMove: onGripPointerMove,
            onPointerUp: endDrag,
            onPointerCancel: endDrag,
            onKeyDown: onGripKeyDown,
          },
          h('span', { className: 'onestep-peek-grip-glyph', 'aria-hidden': 'true' }, '⠿'),
        ),
        h(
          'div',
          {
            className: 'onestep-peek-stack',
            [STACK_ATTR]: '1',
            'data-dragging': dragging ? '1' : undefined,
            onPointerDown: onStackPointerDown,
          },
          nodes,
        ),
      ),
    )
    try {
      return ReactDOM.createPortal(layer, document.body)
    } catch (_error) {
      return null
    }
  }
  return PeekTagLayer
}
