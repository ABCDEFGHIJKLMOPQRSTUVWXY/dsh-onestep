/**
 * 窗口级反馈（瞬时态）：完成未读闪烁、待处理气泡、aria-live 播报、5s 撤销与 toast。
 * 全部内存态，不持久化；通过稳定快照给 React useSyncExternalStore。
 */
import { LIMITS } from './adapter.js'
import { MOTION } from './motion.js'

/** @returns {object} feedback 控制器 */
export function createFeedback() {
  let snapshot = {
    flash: {}, // sessionId -> 起始时间
    bubble: null, // { sessionId, kind }
    bubbleLeaving: false, // P4-5：气泡出场动画期间为 true（120ms 后清空）
    announcement: null, // { text, at }
    toast: null, // { text, at, undoable, sessionId, lifetimeMs }
    undo: null, // { sessionId, prevIndex, at, kind }
  }
  let bubbleTimer = null
  /** P4-5：flash 到点自清定时器（sessionId → timer），避免 `data-flash` 依赖下一次 re-render。 */
  const flashTimers = new Map()
  const listeners = new Set()
  const emit = () => {
    for (const listener of Array.from(listeners)) {
      try {
        listener(snapshot)
      } catch (_error) {
        /* 订阅者异常隔离 */
      }
    }
  }
  const update = (patch) => {
    snapshot = { ...snapshot, ...patch }
    emit()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** 候场会话完成未读 → 闪烁（同一未读 episode 只触发一次：由调用方边沿检测）。 */
    flash(sessionId, options = {}) {
      if (!sessionId) return
      const holdMs = Number(options.holdMs) > 0 ? Number(options.holdMs) : MOTION.flashHold
      update({ flash: { ...snapshot.flash, [sessionId]: Date.now() } })
      if (typeof setTimeout === 'function') {
        const previous = flashTimers.get(sessionId)
        if (previous !== undefined) clearTimeout(previous)
        const timer = setTimeout(() => {
          flashTimers.delete(sessionId)
          if (snapshot.flash[sessionId]) {
            const flash = { ...snapshot.flash }
            delete flash[sessionId]
            update({ flash })
          }
        }, holdMs)
        flashTimers.set(sessionId, timer)
      }
    },
    clearFlash(sessionId) {
      if (!sessionId || !snapshot.flash[sessionId]) return
      const timer = flashTimers.get(sessionId)
      if (timer !== undefined) {
        clearTimeout(timer)
        flashTimers.delete(sessionId)
      }
      const flash = { ...snapshot.flash }
      delete flash[sessionId]
      update({ flash })
    },
    setBubble(sessionId, kind) {
      if (!sessionId) return
      if (bubbleTimer !== null) {
        clearTimeout(bubbleTimer)
        bubbleTimer = null
      }
      update({ bubble: { sessionId, kind }, bubbleLeaving: false })
    },
    /** 气泡出场：先标记 leaving 播 120ms 动画，再清空（P4-5）。 */
    clearBubble(sessionId) {
      if (!snapshot.bubble) return
      if (sessionId && snapshot.bubble.sessionId !== sessionId) return
      if (snapshot.bubbleLeaving) return
      update({ bubbleLeaving: true })
      if (typeof setTimeout !== 'function') {
        update({ bubble: null, bubbleLeaving: false })
        return
      }
      bubbleTimer = setTimeout(() => {
        bubbleTimer = null
        if (snapshot.bubble) update({ bubble: null, bubbleLeaving: false })
      }, MOTION.bubbleOut)
    },
    announce(text) {
      if (!text) return
      update({ announcement: { text, at: Date.now() } })
    },
    pushUndo(entry) {
      update({ undo: { ...entry, at: Date.now() } })
    },
    clearUndo() {
      if (!snapshot.undo) return
      update({ undo: null })
    },
    /** 撤销是否仍有效。 */
    validUndo(now = Date.now()) {
      return !!snapshot.undo && now - snapshot.undo.at <= LIMITS.undoWindowMs
    },
    toast(text, options = {}) {
      const undoable = !!options.undoable
      const lifetimeMs = Number(options.lifetimeMs) > 0 ? Number(options.lifetimeMs) : (undoable ? LIMITS.undoWindowMs : 2600)
      update({ toast: { text, at: Date.now(), undoable, sessionId: options.sessionId || null, lifetimeMs } })
    },
    clearToast() {
      if (!snapshot.toast) return
      update({ toast: null })
    },
    dispose() {
      if (bubbleTimer !== null) clearTimeout(bubbleTimer)
      bubbleTimer = null
      for (const timer of flashTimers.values()) clearTimeout(timer)
      flashTimers.clear()
      listeners.clear()
    },
  }
}

/** 极简信号（单值 observable），供主绑定桥 → StageRoot 使用。 */
export function createSignal(initial) {
  let value = initial
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
