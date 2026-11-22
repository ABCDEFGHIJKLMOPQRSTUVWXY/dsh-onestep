/**
 * dsh-onestep —— 浏览器半入口（P1 MVP）。
 *
 * 组成（开发文档 §3.1 / §3.3）：
 *   ① 能力探测（缺关键插槽/服务 → 不进入舞台，官方界面不受影响）
 *   ② locale 字典 / 样式注入 / 全局快捷键
 *   ③ StageStore（持久化）+ 主绑定信号（onestep.focus 桥上报）+ 引用管理（retain/release）
 *   ④ 模式机：candidates ≥1 → 注册 main keyed 'conversation' 覆盖；清空 → dispose 恢复官方
 *   ⑤ 入口：侧栏行 action「加入舞台」、header「舞台」picker、Alt+S
 *   ⑥ 窗口级反馈：完成未读闪烁 / 待处理气泡 / aria-live / 5s 撤销
 *   ⑦ window.__ONESTEP__ 探针（验证器用）
 */
import { React, h } from './h.js'
import {
  COMPANION,
  CONTENT_FACTORY,
  INJECT,
  LIMITS,
  PROBE_FLAG_KEY,
  SERVICES,
  SESSION_FIELDS,
  SLOTS,
  detectCapabilities,
  sessionsById,
  statusOf,
  statusesSnapshot,
} from './adapter.js'
import { DICTIONARIES, NS, interpolate } from './locale.js'
import { CSS } from './styles.js'
import { createStageStore, loadPersisted, normalizeState, addCandidate as addCandidatePure, removeCandidate as removeCandidatePure, AUTO_LITE_LIMITS, evaluateAutoLite } from './store.js'
import { createMotionController, nextTask, resolveMotionMode, systemPrefersReducedMotion, transitionName, waitForApplied } from './motion.js'
import { createFeedback, createSignal } from './feedback.js'
import { StageDragOverlay, createDragSignal, installDragCapture, readDropSessionId } from './drag.js'
import { createCompanion, createFloatCompanion } from './companion.js'
import { loadCompanionState, saveCompanionState, sessionStateOf, modeOf, setMode as setCompanionModeState, upsertFloat, markPeeked, markAllPeeked, touchFloat, countFloats, markAllDocked, peekTopOf, setPeekTop } from './float-state.js'
import { applyFloatPeek as applyFloatPeekDom, createPeekLayer } from './peek-layer.js'
import { createPeekTagLayer } from './peek-tags.js'
import { allocateSlotIndex, computeSlots } from './float-layout.js'
import { FocusBridge, StageRoot } from './stage-root.js'
import { WindowContentOccurrence } from './content.js'
import { createLogger, createProbe } from './probe.js'
import { createFloatProbe } from './float-probe.js'
import { installServiceWrap } from './service-wrap.js'
import { installFloatResize } from './float-resize.js'
import { createFloatFlash } from './float-flash.js'
import { startDraft } from './quick-new.js'

export const inject = INJECT

/** 插件版本（与 package.json 保持一致；构建期不读文件）。 */
const VERSION = '1.0.2'

/**
 * 诊断开关：URL hash `#onestep=no-locale,no-shortcuts,no-entries,no-overlay,no-sessions,no-main`。
 * 仅用于 P1 开发期定位「我们的注册是否影响官方插件激活」；不影响默认行为。
 */
function readDiagnosticFlags() {
  const out = {}
  try {
    const match = String(location.hash || '').match(/onestep=([^&]+)/)
    if (match) {
      for (const name of decodeURIComponent(match[1]).split(',')) {
        const key = name.trim()
        if (key) out[key] = true
      }
    }
  } catch (_error) {
    /* ignore */
  }
  return out
}
const FLAGS = readDiagnosticFlags()
const enabled = (name) => !FLAGS['no-' + name]

const useSpecSnapshot = (observable) => React.useSyncExternalStore(observable.subscribe, observable.getSnapshot, observable.getSnapshot)

const safeStorage = () => {
  try {
    const storage = window.localStorage
    storage.getItem(PROBE_FLAG_KEY)
    return storage
  } catch (_error) {
    return null
  }
}

/** 探针暴露的最近测量条数上限。 */
const PERF_RECENT_LIMIT = 24

/**
 * P2-4 性能打点记录器：performance.mark / measure + 最近测量环形记录（探针 snapshot 暴露）。
 * 打点名（产品报告 §11.1 测量方法）：
 * - stage-enter-start / stage-enter-ready → measure('stage-enter')
 * - focus-switch-start / focus-switch-ready → measure('focus-switch')
 * @param {object} log 事件日志
 */
function createPerfRecorder(log) {
  const supported =
    typeof performance !== 'undefined' && typeof performance.mark === 'function' && typeof performance.measure === 'function'
  const recent = []
  const round = (value) => Math.round(value * 100) / 100
  const mark = (name) => {
    if (!supported) return false
    try {
      performance.mark(name)
      return true
    } catch (_error) {
      return false
    }
  }
  const measure = (name, startMark, endMark) => {
    if (!supported) return null
    let record = null
    try {
      performance.measure(name, startMark, endMark)
      const entries = performance.getEntriesByName(name, 'measure')
      const entry = entries.length ? entries[entries.length - 1] : null
      if (entry) record = { name, startMark, endMark, durationMs: round(entry.duration), at: Date.now() }
    } catch (_error) {
      return null
    }
    if (!record) return null
    recent.push(record)
    if (recent.length > PERF_RECENT_LIMIT) recent.splice(0, recent.length - PERF_RECENT_LIMIT)
    log.log('perf.measure', record)
    return record
  }
  return { supported, mark, measure, recent: () => recent.slice() }
}

/** 读表演示内存（Chromium performance.memory；不可用时返回 null）。 */
function readHeapMB() {
  try {
    const memory = performance.memory
    if (!memory || !Number.isFinite(memory.usedJSHeapSize)) return null
    return Math.round((memory.usedJSHeapSize / 1048576) * 10) / 10
  } catch (_error) {
    return null
  }
}

/** 注册 locale 字典（返回 disposer）。 */
function installLocale(ctx, log) {
  try {
    const dispose = ctx.locale.register(NS, DICTIONARIES)
    log.log('locale.registered', null)
    return typeof dispose === 'function' ? dispose : () => {}
  } catch (error) {
    log.log('locale.register.error', String(error))
    return () => {}
  }
}

/** 注入/卸载样式。 */
function installStyles(log) {
  try {
    const tag = document.createElement('style')
    tag.dataset.onestep = '1'
    tag.textContent = CSS
    document.head.appendChild(tag)
    log.log('styles.injected', null)
    return () => {
      tag.remove()
      log.log('styles.removed', null)
    }
  } catch (error) {
    log.log('styles.error', String(error))
    return () => {}
  }
}

/**
 * cordis 客户端插件入口。
 * @param {object} ctx client cordis context
 */
export function apply(ctx) {
  const log = createLogger()
  log.log('apply', { version: VERSION, href: String(location.href).replace(/\?.*$/, '') })
  const perf = createPerfRecorder(log)
  const capability = detectCapabilities(ctx)
  if (!capability.ok) {
    log.log('capability.missing', capability)
    return
  }
  log.log('capability.ok', capability)

  const localeDispose = enabled('locale') ? installLocale(ctx, log) : () => {}
  let t = (key, params) => interpolate(DICTIONARIES.zh[key] || key, params)
  try {
    t = ctx.locale.bind(NS)
  } catch (error) {
    log.log('locale.bind.error', String(error))
  }
  ctx.effect(() => installStyles(log), 'dsh-onestep: styles')

  const storage = safeStorage()
  const store = createStageStore({ storage })
  // P4-8：减少动效模式（系统 prefers-reduced-motion + 插件设置）→ <html data-onestep-motion="reduced">。
  // CSS 侧 :root[data-onestep-motion="reduced"] 与 media 查询双路径；JS 侧 motion.isReduced() 跳过 VT。
  let motionMediaCleanup = null
  const motionMedia = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null
  const systemReduced = () => !!(motionMedia && motionMedia.matches)
  const currentMotionMode = () => resolveMotionMode(store.getSnapshot().reducedMotion, systemReduced())
  const applyMotionAttribute = () => {
    try {
      if (typeof document === 'undefined' || !document.documentElement) return
      if (currentMotionMode() === 'reduced') document.documentElement.setAttribute('data-onestep-motion', 'reduced')
      else document.documentElement.removeAttribute('data-onestep-motion')
    } catch (_error) {
      /* 属性写入失败不阻塞 */
    }
  }
  applyMotionAttribute()
  if (motionMedia) {
    const onMotionMediaChange = () => applyMotionAttribute()
    if (typeof motionMedia.addEventListener === 'function') {
      motionMedia.addEventListener('change', onMotionMediaChange)
      motionMediaCleanup = () => motionMedia.removeEventListener('change', onMotionMediaChange)
    } else if (typeof motionMedia.addListener === 'function') {
      motionMedia.addListener(onMotionMediaChange)
      motionMediaCleanup = () => motionMedia.removeListener(onMotionMediaChange)
    }
  }
  const motionController = createMotionController({
    getSetting: () => store.getSnapshot().reducedMotion,
    log: (event, data) => log.log(event, data || null),
  })
  const motionState = () => ({
    setting: store.getSnapshot().reducedMotion,
    systemReduced: systemReduced(),
    mode: currentMotionMode(),
    attribute: typeof document !== 'undefined' && document.documentElement
      ? document.documentElement.getAttribute('data-onestep-motion')
      : null,
    controller: motionController.snapshot(),
  })
  /**
   * Q2 决议（P4-1 实测）：morph 前给可见官方浮窗/收起标签临时加 view-transition-name，
   * 避免它们被窗口快照盖住（默认 t=0 约 14-15% 像素被覆盖；命名后 0）。
   * 返回还原函数；不清空官方状态，只恢复 style 原值。
   */
  const decorateMotionSnapshots = () => {
    if (typeof document === 'undefined' || !document.querySelectorAll) return null
    const cleanups = []
    const decorate = (elements, prefix, idOf) => {
      const seen = new Set()
      for (const element of elements) {
        let name = null
        let rect = null
        try {
          const id = idOf(element)
          name = id ? transitionName(prefix, id) : null
          rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null
        } catch (_error) {
          name = null
        }
        if (!name || !element.style || seen.has(name) || !rect || rect.width < 2 || rect.height < 2) continue
        seen.add(name)
        const previous = element.style.getPropertyValue('view-transition-name')
        const priority = element.style.getPropertyPriority('view-transition-name')
        try {
          element.style.setProperty('view-transition-name', name, 'important')
        } catch (_error) {
          continue
        }
        cleanups.push(() => {
          try {
            if (previous) element.style.setProperty('view-transition-name', previous, priority)
            else element.style.removeProperty('view-transition-name')
          } catch (_error) {
            /* ignore */
          }
        })
      }
    }
    try {
      const floats = Array.from(document.querySelectorAll('[data-dockkit-float]')).filter((element) => !element.closest('[hidden]') && element.getAttribute('data-onestep-peek') !== '1' && element.getAttribute('data-onestep-peek-restoring') !== '1')
      decorate(floats, 'onestep-float-', (element) => element.getAttribute('data-dockkit-content'))
    } catch (_error) {
      /* ignore */
    }
    try {
      const tags = Array.from(document.querySelectorAll('[data-onestep-peek-tag]'))
      decorate(tags, 'onestep-peek-tag-', (element) => element.getAttribute('data-onestep-peek-tag'))
    } catch (_error) {
      /* ignore */
    }
    return () => {
      for (const cleanup of cleanups) {
        try {
          cleanup()
        } catch (_error) {
          /* ignore */
        }
      }
    }
  }
  /** 舞台内几何变化统一入口（P4-3）：VT 串行/排队/跳过/直切由控制器决定。 */
  const stageMotion = (kind, update, options = {}) => {
    void motionController.run(update, { kind, decorate: decorateMotionSnapshots, ...options })
  }
  const windowRef = () => (typeof window !== 'undefined' ? window : null)
  // persistStage=false：启动时不恢复候场 roster（仍保留 rail/preview 设置）
  if (!store.getSnapshot().persistStage && store.getSnapshot().candidates.length > 0) {
    store.update((state) => ({ ...state, candidates: [] }))
  }
  const focusSignal = createSignal(null)
  /**
   * P2-3 自动 lite 降级运行时状态（不持久化）：自动降级只覆盖渲染档位，
   * 不写 store.previewMode；用户手动切档后 manualOverride=true 优先于自动判定。
   */
  const autoLiteSignal = createSignal({
    active: false,
    reason: 'idle',
    target: 'none',
    applied: 'none',
    fallback: false,
    manualOverride: false,
    metrics: null,
    sampledAt: null,
  })
  const feedback = createFeedback()
  const quickSignal = createSignal(0)
  const focusInputSignal = createSignal(0)
  const dragSignal = createDragSignal()
  const pickerSignal = createSignal({ visible: false, sessionId: null })
  /** 0.6.1：点击换焦的「占位焦点内容」sessionId（非 null 时焦点窗先渲染轻量占位，真实聊天体在动画期间挂载）。 */
  const focusPreviewSignal = createSignal(null)
  /**
   * F1（0.7.1）：换焦继承快照桥。StageRoot 挂载时注册 capture(sessionId)：
   * 在焦点状态变更前，把即将降级窗口的 DOM 同步序列化进候场快照缓存（省掉换焦后的一次隐藏官方内容挂载）。
   * 未注册（舞台未挂载/初始化顺序）时为 null，调用方静默跳过。
   */
  const previewBridge = { capture: null }
  const sessionsSvc = () => {
    try {
      return ctx.get(SERVICES.sessions)
    } catch (_error) {
      return undefined
    }
  }
  const uiWorkspace = () => ctx.get(SERVICES.uiWorkspace)
  /** 官方主绑定切换（0.6.1 慢速点击路径在动画期间调用；VT 回调里也会用）。 */
  const openOfficialSession = (sessionId) => {
    try {
      const workspace = uiWorkspace()
      if (!workspace || typeof workspace.openSession !== 'function') throw new Error('uiWorkspace.openSession missing')
      workspace.openSession(String(sessionId))
      log.log('focus.open', { id: String(sessionId) })
      return true
    } catch (error) {
      log.log('focus.error', String(error))
      return false
    }
  }
  const sidebarRight = () => ctx.get(SERVICES.sidebarRight)
  // P3-2：包装官方顶层打开入口；实际安装在 P3-3/P3-4 运行时块（policy 需要形态/槽位/状态）。
  const wrapRef = { current: null }
  const statusCache = { value: {} }
  const byId = () => sessionsById(sessionsSvc())
  /**
   * 推断当前主绑定会话：正常模式下 focusSignal 由舞台桥上报，尚未挂载时为空；
   * 这里用「mainView retain 计数」与 localStorage current 做只读回退（P0 契约 §9）。
   */
  const currentMainSessionId = () => {
    const focus = focusSignal.getSnapshot()
    if (focus) return focus
    const rows = byId()
    for (const id of Object.keys(rows)) {
      const row = rows[id]
      if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return id
    }
    try {
      const raw = storage && typeof storage.getItem === 'function' ? storage.getItem('dsh.sessions.current') : null
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && parsed.sessionId && rows[parsed.sessionId]) return parsed.sessionId
      }
    } catch (_error) {
      /* ignore */
    }
    return null
  }

  const titleOf = (sessionId) => {
    const row = byId()[sessionId]
    return SESSION_FIELDS.title(row) || t('window.unnamed')
  }

  // ---------- 引用管理（焦点 + 候场，窗口数严格对应） ----------
  const refs = {
    map: new Map(),
    retain(sessionId) {
      const id = String(sessionId)
      if (this.map.has(id)) return this.map.get(id)
      const sessions = sessionsSvc()
      if (!sessions || typeof sessions.retain !== 'function') {
        log.log('ref.retain.unavailable', { id })
        return null
      }
      let reference = null
      try {
        reference = sessions.retain(id, { source: 'onestepStage' })
      } catch (error) {
        log.log('ref.retain.error', { id, error: String(error) })
        return null
      }
      this.map.set(id, reference)
      log.log('ref.retain', { id, count: this.map.size })
      return reference
    },
    get(sessionId) {
      return this.map.get(String(sessionId)) || null
    },
    has(sessionId) {
      return this.map.has(String(sessionId))
    },
    release(sessionId) {
      const id = String(sessionId)
      const reference = this.map.get(id)
      if (!reference) return
      this.map.delete(id)
      try {
        reference.release()
      } catch (error) {
        log.log('ref.release.error', { id, error: String(error) })
      }
      log.log('ref.release', { id, count: this.map.size })
    },
    releaseAll() {
      for (const id of Array.from(this.map.keys())) this.release(id)
    },
  }

  // ---------- 模式机 / 注册状态 ----------
  const stageControl = {
    mounted: false,
    mainReady: false,
    disposers: [],
    suppressPrevFocus: false,
  }
  const isCandidate = (sessionId) => (store.getSnapshot().candidates || []).some((item) => item.sessionId === String(sessionId))

  // ---------- P2-3 自动降级 / P2-4 打点（运行时状态，不持久化） ----------
  /** 探针注入的「模拟性能采样」：仅 e2e 故障注入用，生产路径从不赋值。 */
  let forcedPerfSample = null
  /** 本次舞台会话内已按多少窗口采样过（避免 2 窗进入后补候场时重复判定）。 */
  let autoLiteSampledWindows = 0
  /** 待完成的焦点切换测量（start → ready）。 */
  let pendingFocusSwitch = null
  /** 舞台进入窗口内的 longtask 采集（主线程阻塞量）。 */
  let longTaskObserver = null
  const longTaskDurations = []
  let stageEnterHeapMB = null

  const longTaskSupported = () => typeof PerformanceObserver === 'function'

  const startLongTaskObserver = () => {
    longTaskDurations.length = 0
    if (!longTaskSupported()) return
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTaskDurations.push(Number(entry.duration) || 0)
      })
      longTaskObserver.observe({ type: 'longtask', buffered: false })
    } catch (_error) {
      longTaskObserver = null
    }
  }
  const stopLongTaskObserver = () => {
    if (!longTaskObserver) return
    try {
      longTaskObserver.disconnect()
    } catch (_error) {
      /* ignore */
    }
    longTaskObserver = null
  }
  const longTaskTotalMs = () => longTaskDurations.reduce((sum, value) => sum + value, 0)

  /** 进入舞台动作开始：打点 + 记录进入前堆量 + 开始采集长任务。 */
  const beginStageEnter = () => {
    perf.mark('stage-enter-start')
    stageEnterHeapMB = readHeapMB()
    startLongTaskObserver()
  }

  const lastMeasure = (name) => {
    const list = perf.recent().filter((record) => record.name === name)
    return list.length ? list[list.length - 1] : null
  }

  const autoLiteState = () => autoLiteSignal.getSnapshot()

  /**
   * 自动降级判定 + 生效：4 窗进入舞台后采样首帧/长任务/内存；超阈值 → 自动切精简候场
   * （渲染层覆盖，不写 store.previewMode），探针/日志记录原因；用户手动档位优先。
   */
  const runAutoLiteSample = () => {
    if (!stageControl.mounted) return null
    const stage = store.getSnapshot()
    const windows = (stage.candidates || []).length + (focusSignal.getSnapshot() ? 1 : 0)
    if (windows < AUTO_LITE_LIMITS.windows) return null
    const forced = forcedPerfSample
    const enterMeasure = lastMeasure('stage-enter')
    const heapNow = readHeapMB()
    const memoryDeltaMB =
      forced && forced.memoryDeltaMB !== undefined
        ? forced.memoryDeltaMB
        : heapNow !== null && stageEnterHeapMB !== null
          ? Math.round((heapNow - stageEnterHeapMB) * 10) / 10
          : null
    const input = {
      windows,
      enabled: stage.autoLite !== false,
      manualOverride: autoLiteState().manualOverride,
      firstFrameMs: forced && forced.firstFrameMs !== undefined ? forced.firstFrameMs : enterMeasure ? enterMeasure.durationMs : null,
      longTaskTotalMs:
        forced && forced.longTaskTotalMs !== undefined
          ? forced.longTaskTotalMs
          : longTaskSupported()
            ? Math.round(longTaskTotalMs() * 10) / 10
            : null,
      memoryDeltaMB,
      sustainedLowFps: forced ? forced.sustainedLowFps === true : false,
    }
    const decision = evaluateAutoLite(input)
    const current = autoLiteState()
    autoLiteSignal.set({
      active: decision.degrade,
      reason: decision.reason,
      target: decision.target,
      applied: decision.applied,
      fallback: decision.fallback,
      manualOverride: current.manualOverride,
      metrics: decision.metrics,
      sampledAt: Date.now(),
    })
    log.log(decision.degrade ? 'autolite.degrade' : 'autolite.idle', {
      reason: decision.reason,
      applied: decision.applied,
      metrics: decision.metrics,
    })
    return decision
  }

  /** 窗口数达到 4 窗时采样（进入即 4 窗 / 进入后补候场到 4 窗都覆盖）。 */
  const maybeSampleAutoLite = () => {
    if (!stageControl.mounted) return null
    const windows = (store.getSnapshot().candidates || []).length + (focusSignal.getSnapshot() ? 1 : 0)
    if (windows < AUTO_LITE_LIMITS.windows) return null
    if (autoLiteSampledWindows >= windows) return null
    if (!lastMeasure('stage-enter')) return null
    autoLiteSampledWindows = windows
    return runAutoLiteSample()
  }

  /** 舞台挂载完成（焦点窗官方内容首帧可见）：收尾 stage-enter 打点并触发自动降级采样。 */
  const onStageReady = () => {
    if (!perf.supported) return
    perf.mark('stage-enter-ready')
    perf.measure('stage-enter', 'stage-enter-start', 'stage-enter-ready')
    stopLongTaskObserver()
    maybeSampleAutoLite()
  }

  /** 焦点切换「主视图换绑完成」：桥上报新主绑定并完成舞台记账（报告 §11.1 快捷键 100ms 口径）。 */
  const settleFocusSwitch = () => {
    if (!pendingFocusSwitch) return
    if (pendingFocusSwitch.source !== 'action') {
      pendingFocusSwitch = null
      return
    }
    if (pendingFocusSwitch.reported) return
    pendingFocusSwitch.reported = true
    perf.mark('focus-switch-ready')
    perf.measure('focus-switch', 'focus-switch-start', 'focus-switch-ready')
  }

  /** 焦点窗内容首帧可见（报告 §11.1 点击 200ms 的「内容换绑 + 首帧」口径）。 */
  const onFocusSwitchContentReady = () => {
    if (!pendingFocusSwitch || !pendingFocusSwitch.reported) return
    pendingFocusSwitch = null
    perf.mark('focus-switch-content-ready')
    perf.measure('focus-switch-content', 'focus-switch-start', 'focus-switch-content-ready')
  }

  /** 记录一次焦点切换开始（点击/快捷键/移出焦点/外部主绑定变化）。 */
  const beginFocusSwitch = (source) => {
    if (!stageControl.mounted) return
    // 上一次切换若未走完（内容首帧未到就再次切换），丢弃旧测量，保证本次 start 独占。
    pendingFocusSwitch = { source, at: Date.now(), reported: false }
    perf.mark('focus-switch-start')
  }

  /** 用户手动切档：本舞台会话内优先于自动判定（不再被自动覆盖；不改持久化策略）。 */
  const markManualPreview = () => {
    const current = autoLiteState()
    autoLiteSignal.set({
      ...current,
      active: false,
      applied: 'none',
      target: 'none',
      reason: 'manual-override',
      manualOverride: true,
      sampledAt: Date.now(),
    })
  }

  /** 舞台退出：清自动降级运行时状态（下一次舞台会话重新采样）。 */
  const resetAutoLite = () => {
    autoLiteSampledWindows = 0
    pendingFocusSwitch = null
    stopLongTaskObserver()
    stageEnterHeapMB = null
    autoLiteSignal.set({
      active: false,
      reason: 'idle',
      target: 'none',
      applied: 'none',
      fallback: false,
      manualOverride: false,
      metrics: null,
      sampledAt: null,
    })
  }

  // ---------- actions ----------
  const companion = createCompanion({
    ctx,
    log,
    getFocusId: () => focusSignal.getSnapshot() || currentMainSessionId(),
    getCandidates: () => (store.getSnapshot().candidates || []).map((item) => item.sessionId),
  })

  // ---------- P3-3 伴生浮窗：自有状态 + DOM 对账 ----------
  // 官方持久化浮窗 rect/tab/expanded；插件只存形态/槽位/peek/managed（§5.2）。
  const companionLoaded = loadCompanionState(storage)
  if (!companionLoaded.ok && companionLoaded.reason !== 'empty') log.log('companion.state.fallback', { reason: companionLoaded.reason })
  // Q11：peek 不跨刷新 —— 载入时一律恢复为展开态。
  let companionState = companionLoaded.state
  {
    const sessions = companionState.bySession || {}
    const restored = {}
    for (const sessionId of Object.keys(sessions)) {
      const session = sessions[sessionId]
      restored[sessionId] = { ...session, floats: (session.floats || []).map((item) => ({ ...item, peeked: false })) }
    }
    companionState = { ...companionState, bySession: restored }
  }
  const persistCompanionState = (next) => {
    if (!next || next === companionState) return companionState
    companionState = next
    const saved = saveCompanionState(storage, companionState)
    if (!saved.ok) log.log('companion.state.save.error', { reason: saved.reason })
    // P3-11：收起集合变化后同步标签层（DOM 注入在观测到元素后生效）。
    if (syncPeekLayerFn) {
      try {
        syncPeekLayerFn()
      } catch (error) {
        log.log('peek.sync.error', String(error).slice(0, 120))
      }
    }
    return companionState
  }
  const companionFocusId = () => focusSignal.getSnapshot() || currentMainSessionId()
  /** P3-11：标签层同步函数（在 peekLayer 创建后赋值；状态变更时调用）。 */
  let syncPeekLayerFn = null
  /** 0.7.0：浮窗边缘缩放控制器（在 peekLayer 之后创建；sync 用 ref 供早期调用点安全访问）。 */
  const floatResizeRef = { current: null }
  const peekRef = { current: null }
  const findSessionPanel = (sessionId) => {
    if (!sessionId) return null
    for (const panel of document.querySelectorAll(COMPANION.selectors.panel)) {
      if (panel.getAttribute(COMPANION.attrs.session) === sessionId) return panel
    }
    return null
  }
  const readPanelState = (sessionId) => {
    const panel = findSessionPanel(sessionId)
    if (!panel) return { found: false, open: false, opening: false, mode: null }
    const rect = panel.getBoundingClientRect()
    return {
      found: true,
      open: panel.hasAttribute(COMPANION.attrs.panelOpen),
      opening: panel.hasAttribute(COMPANION.attrs.panelOpening),
      mode: panel.getAttribute('data-sidebar-right-panel') || null,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    }
  }
  const readFloatDom = (sessionId) => {
    const panel = findSessionPanel(sessionId)
    if (!panel) return []
    const out = []
    for (const element of panel.querySelectorAll(COMPANION.selectors.float)) {
      const rect = element.getBoundingClientRect()
      const titleElement = element.querySelector(COMPANION.selectors.floatTitle)
      const tabId = element.getAttribute(COMPANION.attrs.content) || ''
      if (!tabId) continue
      out.push({
        paneId: element.getAttribute(COMPANION.attrs.float) || '',
        tabId,
        title: titleElement ? String(titleElement.textContent || '').trim() : '',
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        peeked: element.getAttribute(COMPANION.attrs.peek) === '1',
      })
    }
    return out
  }
  const floatCompanion = createFloatCompanion({
    getService: sidebarRight,
    getFocusId: companionFocusId,
    log: (event, data) => log.log(event, data || null),
    dom: {
      stageRect: () => {
        const stage = document.querySelector(COMPANION.selectors.stage)
        return stage ? stage.getBoundingClientRect() : null
      },
      viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
      panel: readPanelState,
      floats: readFloatDom,
    },
  })
  const reconcileCompanion = (sessionId, reason) => {
    const target = sessionId || companionFocusId()
    if (!target) return null
    const result = floatCompanion.reconcile(companionState, target, Date.now())
    if (result.changed) persistCompanionState(result.state)
    if (result.changed || result.removed.length > 0 || result.unmanaged.length > 0) {
      log.log('companion.reconcile', {
        reason: reason || null,
        removed: result.removed.length,
        unmanaged: result.unmanaged.length,
        counts: result.counts,
      })
    }
    return result
  }
  const scheduleCompanionReconcile = (reason) => {
    // 等 React 提交后再读 DOM（一次 rAF，不轮询）。
    try {
      requestAnimationFrame(() => {
        reconcileCompanion(companionFocusId(), reason || 'raf')
        if (floatResizeRef.current) {
          try {
            floatResizeRef.current.sync()
          } catch (_error) {
            /* ignore */
          }
        }
      })
    } catch (_error) {
      /* 无 rAF 环境（测试）忽略 */
    }
  }

  // ---------- P3-4 入口与设置：形态信号 / 伴生窗开关 / 包装层 policy ----------
  const companionModeSignal = createSignal(modeOf(companionState, companionFocusId() || ''))
  /** P3-12：已收回右栏的伴生窗数量（菜单「转回浮窗」可见性）。 */
  const companionDockedSignal = createSignal(0)
  const refreshCompanionMode = () => {
    const next = modeOf(companionState, companionFocusId() || '')
    if (companionModeSignal.getSnapshot() !== next) companionModeSignal.set(next)
    const docked = countFloats(companionState, companionFocusId() || '').docked
    if (companionDockedSignal.getSnapshot() !== docked) companionDockedSignal.set(docked)
    if (floatResizeRef.current) {
      try {
        floatResizeRef.current.sync()
      } catch (_error) {
        /* ignore */
      }
    }
    return next
  }
  const isStageActive = () => stageControl.mounted || (store.getSnapshot().candidates || []).length > 0
  const companionFloats = () => sessionStateOf(companionState, companionFocusId() || '').floats
  const wrapEnabled = () => isStageActive() && modeOf(companionState, companionFocusId() || '') === 'float'

  // ---------- P3-11 收起与边缘标签层 ----------
  /** 收起/恢复单个浮窗（状态由调用方维护；这里只做 DOM + 观察器）。 */
  const applyFloatPeek = (tabId, peeked) => {
    const layer = peekRef.current
    const sessionId = companionFocusId()
    if (layer && layer.setPeeked) return layer.setPeeked(tabId, peeked)
    return applyFloatPeekDom(sessionId, tabId, peeked)
  }
  const syncPeekLayer = () => {
    const layer = peekRef.current
    if (!layer) return
    const sessionId = companionFocusId()
    const floats = sessionStateOf(companionState, sessionId || '').floats
    layer.setItems(sessionId, floats.map((item) => ({ tabId: item.tabId, title: item.title, kind: item.kind, slot: item.slot, peeked: item.peeked })))
    if (floatResizeRef.current) {
      try {
        floatResizeRef.current.sync()
      } catch (error) {
        log.log('float.resize.sync.error', String(error).slice(0, 120))
      }
    }
  }
  const peekLayer = createPeekLayer({
    t,
    log: (event, data) => log.log(event, data || null),
    onPeekAll: () => {
      actions.companionPeekAll()
    },
    onRestore: (tabId) => {
      actions.companionRestoreFloat(tabId)
    },
  })
  peekRef.current = peekLayer
  syncPeekLayerFn = syncPeekLayer
  const PeekTagLayer = createPeekTagLayer(peekLayer, t, {
    get: () => peekTopOf(companionState),
    set: (top) => {
      companionState = persistCompanionState(setPeekTop(companionState, top))
      log.log('companion.tag.anchor', { top })
    },
  })

  // ---------- 0.7.0 浮窗边缘缩放 ----------
  // 只在舞台 float 形态接管当前会话 panel 内的官方浮窗；split/普通模式不注入任何把手。
  const floatResize = installFloatResize({
    log: (event, data) => log.log(event, data || null),
    isEnabled: () => isStageActive() && modeOf(companionState, companionFocusId() || '') === 'float',
    getService: sidebarRight,
    getSessionId: () => companionFocusId(),
  })
  floatResizeRef.current = floatResize

  // ---------- 0.7.0 已打开浮窗的再次点击提示 ----------
  // 点击命中的浮窗已展开时：不再执行展开动作，闪烁两下 + 官方 focus 抬升到最上层。
  const floatFlash = createFloatFlash()

  /** 在当前焦点会话 panel 内按 tabId 找官方浮窗元素并起播闪烁。 */
  const flashCompanionFloat = (tabId) => {
    const sessionId = companionFocusId()
    if (!sessionId || !tabId) return false
    const panel = findSessionPanel(sessionId)
    if (!panel) return false
    for (const element of panel.querySelectorAll(COMPANION.selectors.float)) {
      if (element.getAttribute(COMPANION.attrs.content) === String(tabId)) return floatFlash.flash(element)
    }
    return false
  }

  /** 包装层 policy（形态/槽位/满槽/managed 记录）；安装与探针 wrap 循环共用。 */
  const companionWrapPolicy = {
    isEnabled: wrapEnabled,
    isManaged: (tabId) => companionFloats().some((item) => item.tabId === String(tabId)),
    /**
     * 0.7.0（发布前修复）：再次点击某个「已收起」伴生窗的链接时，展开该浮窗（与点击右缘标签同语义：
     * 只恢复这一窗、其余保持收起）。返回 true 表示已展开，包装层不再补 focus。
     */
    onRevealManaged: (record) => {
      const tabId = record && record.id ? String(record.id) : ''
      const sessionId = companionFocusId()
      if (!sessionId || !tabId) return false
      const current = sessionStateOf(companionState, sessionId).floats.find((item) => item.tabId === tabId)
      if (!current || !current.peeked) return false
      const result = actions.companionRestoreFloat(tabId)
      return !!(result && result.ok)
    },
    /** 命中的已管理浮窗已展开：只高亮闪烁两下（层级抬升由包装层随后的官方 focus 完成）。 */
    onFocusManaged: (record) => {
      const tabId = record && record.id ? String(record.id) : ''
      const sessionId = companionFocusId()
      if (!sessionId || !tabId) return false
      const current = sessionStateOf(companionState, sessionId).floats.find((item) => item.tabId === tabId)
      if (!current || current.peeked) return false
      // 只刷新最近聚焦时间（供满槽 LRU），不改槽位/形态；官方 focus 负责升到最上层。
      companionState = persistCompanionState(touchFloat(companionState, sessionId, tabId, Date.now()))
      const flashed = flashCompanionFloat(tabId)
      log.log('companion.highlight', { tabId, flashed })
      return flashed
    },
    planOpen: () => {
      const sessionId = companionFocusId()
      if (!sessionId) return null
      const allocation = floatCompanion.allocate(companionFloats())
      if (!allocation.ok) {
        log.log('companion.slot.unavailable', { reason: allocation.reason || null })
        return null
      }
      if (allocation.evicted) {
        // Q13：满槽先收起最久未聚焦的浮窗（DOM + 状态），新窗复用其槽位。
        companionState = persistCompanionState(markPeeked(companionState, sessionId, allocation.evicted.tabId, true))
        applyFloatPeek(allocation.evicted.tabId, true)
        feedback.toast(t('toast.floatLimit'))
        log.log('companion.slot.evict', { tabId: allocation.evicted.tabId, slot: allocation.slot })
      }
      return { rect: allocation.rect, slot: allocation.slot, evictedTabId: allocation.evicted ? allocation.evicted.tabId : null }
    },
    onManaged: (record, rect, plan) => {
      const sessionId = companionFocusId()
      if (!sessionId) return
      companionState = persistCompanionState(upsertFloat(companionState, sessionId, {
        tabId: String(record.id),
        paneId: null,
        kind: record.kind || '',
        title: record.title || '',
        slot: plan && Number.isInteger(plan.slot) ? plan.slot : null,
        peeked: false,
        lastFocusedAt: Date.now(),
      }))
      scheduleCompanionReconcile('managed')
    },
  }

  /** 安装包装层（policy 已接形态/槽位/满槽/managed 记录）。 */
  const installCompanionWrap = () => {
    try {
      ctx.inject(['sidebarRight'], (scope) => {
        const wrap = installServiceWrap({
          getService: sidebarRight,
          log: (event, data) => log.log(event, data || null),
          policy: companionWrapPolicy,
        })
        wrapRef.current = wrap
        log.log('wrap.install', { ok: wrap.ok, reason: wrap.reason || null, missing: wrap.missing || null })
        if (scope && typeof scope.effect === 'function') {
          scope.effect(() => () => {
            try {
              wrap.restore()
            } finally {
              if (wrapRef.current === wrap) wrapRef.current = null
            }
          }, 'dsh-onestep: sidebarRight wrap')
        }
      })
    } catch (error) {
      log.log('wrap.inject.error', String(error))
    }
  }
  installCompanionWrap()

  /** P3-6 探针：卸载-还原-重装循环（G6 生命周期验证用；生产路径不调用）。 */
  const cycleCompanionWrap = () => {
    const wrap = wrapRef.current
    if (!wrap || typeof wrap.restore !== 'function') return { ok: false, reason: 'not-installed' }
    const restored = wrap.restore()
    const next = installServiceWrap({
      getService: sidebarRight,
      log: (event, data) => log.log(event, data || null),
      policy: companionWrapPolicy,
    })
    wrapRef.current = next
    log.log('wrap.cycle', { restored: restored.restored, reinstalled: next.ok, reason: next.reason || null })
    return { ok: next.ok, restored: restored.restored, reinstalled: next.ok, reason: next.reason || null }
  }

  // P3-1 探针桥：只在窗口探针面暴露，不参与生产接线（见 float-probe.js 注释）。
  const floatProbe = createFloatProbe({
    log,
    getService: sidebarRight,
    getFocusId: companionFocusId,
    getWrap: () => (wrapRef.current ? wrapRef.current.status() : { installed: false, enabled: false, reason: 'pending' }),
    getRegistry: () => {
      try {
        return ctx.get('sidebarRightTabs')
      } catch (_error) {
        return null
      }
    },
    getFloatState: () => ({ loaded: { ok: companionLoaded.ok, reason: companionLoaded.reason || null }, state: companionState }),
    getFloatSnapshot: () => floatCompanion.snapshot(),
    getFloatSlots: () => floatCompanion.slots(),
    getFloatAllocate: (sessionId) => floatCompanion.allocate(sessionStateOf(companionState, sessionId || companionFocusId()).floats),
    getFloatReconcile: (sessionId) => {
      const result = reconcileCompanion(sessionId || companionFocusId(), 'probe')
      return result
        ? { changed: result.changed, removed: result.removed, unmanaged: result.unmanaged, counts: result.counts, state: companionState }
        : { changed: false, reason: 'no-session' }
    },
    getCompanionMode: () => ({ mode: modeOf(companionState, companionFocusId() || ''), counts: countFloats(companionState, companionFocusId() || '') }),
    getCompanionToggle: () => actions.companionToggleFloats(),
    getCompanionSetMode: (mode) => actions.companionSetMode(mode),
    getCompanionPeek: (tabId, peeked) => ({ applied: applyFloatPeek(tabId, peeked) }),
    getCompanionPeekAll: () => actions.companionPeekAll(),
    getCompanionRestore: (tabId) => actions.companionRestoreFloat(tabId),
    getCompanionRestoreDocked: () => actions.companionRestoreDocked(),
    getWrapCycle: () => cycleCompanionWrap(),
    getPeekLayer: () => ({ ...peekLayer.snapshotStats(), outside: peekLayer.hasOutsideHandler() }),
    getTagTop: () => peekTopOf(companionState),
    getFloatResize: () => (floatResizeRef.current ? floatResizeRef.current.snapshot() : null),
    getFloatResizeSync: () => {
      if (!floatResizeRef.current) return { ok: false, reason: 'unavailable' }
      floatResizeRef.current.sync()
      return { ok: true, ...floatResizeRef.current.snapshot() }
    },
    setTagTop: (top) => {
      companionState = persistCompanionState(setPeekTop(companionState, top === undefined ? null : Number(top)))
      return { ok: true, top: peekTopOf(companionState) }
    },
  })

  const actions = {
    focusSession(sessionId, options = {}) {
      if (!sessionId) return
      const next = String(sessionId)
      const kind = options && options.kind === 'close' ? 'close' : 'promote'
      const open = () => {
        try {
          const workspace = uiWorkspace()
          if (!workspace || typeof workspace.openSession !== 'function') throw new Error('uiWorkspace.openSession missing')
          workspace.openSession(next)
          log.log('focus.open', { id: next })
        } catch (error) {
          log.log('focus.error', String(error))
        }
      }
      if (!stageControl.mounted || next === focusSignal.getSnapshot()) {
        open()
        return
      }
      if (focusPreviewSignal.getSnapshot() && focusPreviewSignal.getSnapshot() !== next) focusPreviewSignal.set(null)
      // P2-4：键盘/点击提升/移出焦点都走这里；在发起官方 openSession 前打 start 点。
      beginFocusSwitch('action')
      const previous = focusSignal.getSnapshot()
      // 0.6.1：真实鼠标点击走「慢速 + 占位内容」路径 —— 点击后尽快开始 VT 动画（320ms），
      // 回调只提交轻量占位焦点内容；官方聊天体与官方主绑定切换都在动画播放期间完成。
      const motionNow = motionController.snapshot()
      const slowClick = options && options.click === true && motionNow.supported && !motionNow.reduced && !motionNow.active && refs.has(next)
      if (slowClick) {
        const direction = { from: previous && previous !== next ? previous : null, to: next }
        const clearPreview = () => {
          if (focusPreviewSignal.getSnapshot() === next) focusPreviewSignal.set(null)
        }
        let fallbackTimer = setTimeout(() => {
          fallbackTimer = null
          clearPreview()
        }, 1600)
        const stopFallback = () => {
          if (fallbackTimer) {
            clearTimeout(fallbackTimer)
            fallbackTimer = null
          }
        }
        const runPromise = motionController.run(async () => {
          // 轻量提交：先只换焦点状态 + 占位焦点内容（不挂官方聊天体）→ 新快照更快就绪、动画更早开始。
          focusPreviewSignal.set(next)
          applyFocusReport(next)
          await nextTask(windowRef())
          await nextTask(windowRef())
          // 动画已开始/即将开始：官方主绑定切换与真实内容挂载都在动画期间完成。
          openOfficialSession(next)
        }, {
          kind: 'promoteClick',
          decorate: decorateMotionSnapshots,
          direction,
          onReady: () => {
            stopFallback()
            clearPreview()
            log.log('focus.clickSlow.ready', { id: next })
          },
        })
        void runPromise
          .then((route) => {
            if (route !== 'vt') {
              stopFallback()
              clearPreview()
            }
            log.log('focus.clickSlow.route', { id: next, route })
          })
          .catch((error) => {
            stopFallback()
            clearPreview()
            log.log('focus.clickSlow.error', String((error && error.message) || error).slice(0, 160))
          })
        return
      }
      // P4-3：真实 DOM 更新必须在 VT 更新回调内（start 后同步改 DOM 会并入旧快照，实测无动画）。
      // 回调内等主绑定回报 + React 提交（宏任务轮询，禁止 rAF：VT 回调内渲染被暂停）。
      stageMotion(kind, async () => {
        open()
        // 官方提交实测 p95 ≈152ms（P4-1），上限留到 250ms；超时则按当前状态捕获（退化为直切，不阻塞）。
        await waitForApplied(() => focusSignal.getSnapshot() === next, { timeoutMs: 250, win: windowRef() })
        await nextTask(windowRef())
        await nextTask(windowRef())
      }, {
        // P4.2：方向性快照交叉（from=被降级旧焦点，to=被提升新焦点），消除放大的候场卡鬼影/闪。
        direction: { from: previous && previous !== next ? previous : null, to: next },
      })
    },
    addCandidate(sessionId) {
      const id = sessionId === undefined || sessionId === null ? '' : String(sessionId)
      if (!id) return { ok: false, reason: 'no-id' }
      if (id === focusSignal.getSnapshot()) return { ok: false, reason: 'is-focus' }
      if (!byId()[id]) return { ok: false, reason: 'not-in-catalog' }
      // P4-3：用纯函数预测返回值（VT 更新在回调内执行，动作本身保持同步返回）。
      const predicted = addCandidatePure(store.getSnapshot(), id)
      const apply = () => {
        const result = store.addCandidate(id)
        if (result.evicted) log.log('candidate.evicted', { id: result.evicted })
        return result
      }
      if (stageControl.mounted) stageMotion('add', apply)
      else apply()
      log.log('candidate.add', { id, existed: predicted.existed, evicted: predicted.evicted })
      return { ok: true, ...predicted }
    },
    closeCandidate(sessionId, reason) {
      const id = String(sessionId)
      const before = store.getSnapshot().candidates || []
      const index = before.findIndex((item) => item.sessionId === id)
      if (index < 0) return { ok: false }
      const remainingCount = before.length - 1
      const remove = () => store.removeCandidate(id)
      // P4-3：最后一个候场关闭会退出舞台（直接卸载，不做退场动画，Q6）。
      if (stageControl.mounted && remainingCount > 0) stageMotion('evict', remove)
      else remove()
      feedback.pushUndo({ kind: 'close-candidate', sessionId: id, prevIndex: index })
      // 产品报告 §7.7：关闭候场窗不弹 toast（v1 只用 Ctrl+Z 撤销，避免噪音）。
      log.log('candidate.close', { id, reason: reason || null, remaining: remainingCount })
      if (remainingCount === 0) actions.exitStage(true)
      return { ok: true }
    },
    promote(sessionId, options) {
      const id = String(sessionId)
      if (id === focusSignal.getSnapshot()) return { ok: false, reason: 'already-focus' }
      if (!isCandidate(id)) return { ok: false, reason: 'not-candidate' }
      // 不预先 removeCandidate：让 handleFocus 在「active=true」时统一做「新焦点移出候场 + 旧焦点降为候场头部」，
      // 否则提升唯一候场时 active=false，旧焦点不会被降级，舞台会整体退出（P1 review L-3）。
      actions.focusSession(id, { click: !!(options && options.click) })
      log.log('candidate.promote', { id, click: !!(options && options.click) })
      return { ok: true }
    },
    /**
     * 焦点在窗口间循环（Ctrl+Alt+←/→，报告 §10.1）。
     * 窗口顺序 = [焦点, ...候场]；下一步提升候场首位（最近加入），上一步提升候场末位。
     */
    cycleFocus(direction) {
      const focusId = focusSignal.getSnapshot()
      if (!focusId) return { ok: false, reason: 'no-focus' }
      const candidates = store.getSnapshot().candidates || []
      if (candidates.length === 0) return { ok: false, reason: 'no-candidate' }
      const index = direction > 0 ? 0 : candidates.length - 1
      const target = candidates[index] && candidates[index].sessionId
      if (!target) return { ok: false, reason: 'no-target' }
      actions.promote(target)
      log.log('focus.cycle', { direction, target })
      return { ok: true, target }
    },
    closeFocus() {
      const focusId = focusSignal.getSnapshot()
      const candidates = store.getSnapshot().candidates || []
      if (!focusId) {
        actions.exitStage(true)
        return { ok: true, exited: true }
      }
      if (candidates.length === 0) {
        actions.exitStage(true)
        return { ok: true, exited: true }
      }
      const next = candidates[0].sessionId
      const remaining = candidates.slice(1).map((item) => item.sessionId)
      store.update((state) => ({ ...state, candidates: candidates.slice(1) }))
      feedback.pushUndo({ kind: 'close-focus', sessionId: focusId, promoted: next, remaining })
      feedback.toast(interpolate(t('toast.movedOut'), { title: titleOf(focusId) }), { undoable: true, sessionId: focusId })
      stageControl.suppressPrevFocus = true
      actions.focusSession(next, { kind: 'close' })
      // 产品报告 §10.2：焦点窗关闭后焦点移到新焦点窗 composer。
      actions.requestFocusInput()
      log.log('focus.close', { from: focusId, next })
      return { ok: true, next }
    },
    setPreviewMode(mode) {
      // 用户手动切档：本次舞台会话内优先于自动降级（自动判定不得再覆盖）。
      markManualPreview()
      store.setPreviewMode(mode)
      log.log('preview.mode', { mode, source: 'manual' })
    },
    /** P4-8：减少动效开关（跟随系统 / 减少动效）；持久化并同步 <html data-onestep-motion>。 */
    setReducedMotion(value) {
      store.setReducedMotion(value)
      applyMotionAttribute()
      log.log('motion.setting', { value: store.getSnapshot().reducedMotion })
      return motionState()
    },
    setRailCollapsed(collapsed) {
      const next = !!collapsed
      if (stageControl.mounted && store.getSnapshot().railCollapsed !== next) {
        stageMotion('rail', () => store.setRailCollapsed(next))
      } else {
        store.setRailCollapsed(next)
      }
      log.log('rail.toggle', { collapsed: next })
      return { ok: true, railCollapsed: next }
    },
    /** P2-4：探针/e2e 故障注入——下一次自动降级采样使用指定性能值（生产路径不调用）。 */
    simulatePerfSample(sample) {
      forcedPerfSample = sample && typeof sample === 'object' ? { ...sample } : null
      log.log('perf.simulate', forcedPerfSample)
      return forcedPerfSample
    },
    /** P2-4：探针/e2e 触发一次自动降级判定（使用当前/注入的采样值）。 */
    runAutoLiteSample() {
      return runAutoLiteSample()
    },
    toggleRightbar() {
      try {
        const service = sidebarRight()
        if (!service || typeof service.toggleExpanded !== 'function') throw new Error('sidebarRight.toggleExpanded missing')
        service.toggleExpanded()
        log.log('rightbar.toggle', null)
      } catch (error) {
        log.log('rightbar.error', String(error))
      }
    },
    companionSnapshot: () => companion.snapshot(),
    companionToggle: () => companion.toggle(),
    companionEnsure: () => companion.ensureVisible(),
    companionOpenTab: (sessionId, kind, options) => companion.openTab(kind, options, sessionId),
    companionOpenResource: (sessionId, address, options) => companion.openResource(address, options, sessionId),
    companionActive: () => companion.activeTab(),
    /** P3-4：伴生窗开/收（可见浮窗 → 全部收起；有收起 → 恢复；无浮窗 → 打开 guide 浮窗）。 */
    companionToggleFloats() {
      const sessionId = companionFocusId()
      if (!sessionId) return { ok: false, reason: 'no-session' }
      const counts = countFloats(companionState, sessionId)
      const mode = modeOf(companionState, sessionId)
      if (counts.visible > 0 && mode === 'float') {
        return actions.companionPeekAll()
      }
      if (counts.peeked > 0) {
        // 恢复：受槽位数约束，按最近聚焦优先恢复；同槽冲突遵循 Q13 swap（占用者保持收起）。
        const floats = sessionStateOf(companionState, sessionId).floats
        const table = floatCompanion.slots()
        const budget = table ? table.maxSlots : floats.length
        const ordered = floats.slice().sort((a, b) => (Number(b.lastFocusedAt) || 0) - (Number(a.lastFocusedAt) || 0))
        const usedSlots = new Set()
        const restoreIds = new Set()
        for (const item of ordered) {
          if (restoreIds.size >= budget) break
          const slot = Number.isInteger(item.slot) ? item.slot : null
          if (slot !== null) {
            if (usedSlots.has(slot)) continue
            usedSlots.add(slot)
          }
          restoreIds.add(item.tabId)
        }
        let nextState = companionState
        for (const item of floats) nextState = markPeeked(nextState, sessionId, item.tabId, !restoreIds.has(item.tabId))
        companionState = persistCompanionState(nextState)
        const updated = sessionStateOf(companionState, sessionId).floats
        for (const item of updated) applyFloatPeek(item.tabId, !!item.peeked)
        const first = ordered.find((item) => restoreIds.has(item.tabId))
        if (first) {
          floatCompanion.focusTab(first.tabId)
          peekLayer.focusFloat(first.tabId)
        }
        log.log('companion.peek.restore', { restored: restoreIds.size, remainPeeked: updated.length - restoreIds.size })
        return { ok: true, action: 'restore', count: restoreIds.size, remainPeeked: updated.length - restoreIds.size }
      }
      // 没有 managed 浮窗：打开官方 guide，由包装层在 float 形态下自动浮出
      // （右栏已展开时 Q2 直通官方 = 在右栏打开）。
      try {
        const service = sidebarRight()
        if (!service || typeof service.openTab !== 'function') return { ok: false, reason: 'unavailable' }
        service.openTab('guide')
        log.log('companion.open.guide', null)
        scheduleCompanionReconcile('toggle-open')
        return { ok: true, action: 'open', kind: 'guide' }
      } catch (error) {
        log.log('companion.open.guide.error', String(error))
        return { ok: false, reason: 'throw', error: String(error) }
      }
    },
    /** P3-11：收起当前会话全部未收起浮窗（点击浮窗外触发）。 */
    companionPeekAll() {
      const sessionId = companionFocusId()
      if (!sessionId) return { ok: false, reason: 'no-session' }
      const counts = countFloats(companionState, sessionId)
      if (counts.visible === 0) return { ok: true, action: 'noop' }
      companionState = persistCompanionState(markAllPeeked(companionState, sessionId, true))
      const floats = sessionStateOf(companionState, sessionId).floats
      for (const item of floats) applyFloatPeek(item.tabId, true)
      const first = floats.slice().sort((a, b) => (Number(a.slot) || 0) - (Number(b.slot) || 0))[0]
      if (first) peekLayer.focusTag(first.tabId)
      log.log('companion.peek.all', { count: counts.visible })
      return { ok: true, action: 'peek', count: counts.visible }
    },
    /** P3-11：恢复单个收起浮窗（点击右缘标签触发；只恢复该窗，其余保持收起）。 */
    companionRestoreFloat(tabId) {
      const sessionId = companionFocusId()
      const target = tabId === undefined || tabId === null ? '' : String(tabId)
      if (!sessionId || !target) return { ok: false, reason: 'no-target' }
      const record = sessionStateOf(companionState, sessionId).floats.find((item) => item.tabId === target)
      if (!record) return { ok: false, reason: 'not-managed' }
      if (!record.peeked) return { ok: false, reason: 'not-peeked' }
      let next = markPeeked(companionState, sessionId, target, false)
      next = touchFloat(next, sessionId, target, Date.now())
      companionState = persistCompanionState(next)
      applyFloatPeek(target, false)
      floatCompanion.focusTab(target)
      peekLayer.focusFloat(target)
      log.log('companion.peek.restore.one', { tabId: target })
      return { ok: true, tabId: target }
    },
    /** P3-4/P3-12：切换形态。split = 把 managed 浮窗逐个 dock 回官方右栏（官方 push）。 */
    companionSetMode(mode) {
      const sessionId = companionFocusId()
      if (!sessionId) return { ok: false, reason: 'no-session' }
      const next = mode === 'split' ? 'split' : 'float'
      if (next === 'split') {
        const snapshot = floatCompanion.snapshot()
        const docked = []
        for (const item of (snapshot.floats || [])) {
          if (!item.paneId) continue
          const result = floatCompanion.dockPane(item.paneId)
          if (result.ok) docked.push(item.tabId)
        }
        for (const item of sessionStateOf(companionState, sessionId).floats) applyFloatPeek(item.tabId, false)
        // P3-12：记录保留为 docked（供「转回浮窗」），并切 split 形态。
        let nextState = setCompanionModeState(companionState, sessionId, 'split')
        nextState = markAllDocked(nextState, sessionId, true)
        companionState = persistCompanionState(nextState)
        log.log('companion.mode', { mode: 'split', docked: docked.length })
        refreshCompanionMode()
        scheduleCompanionReconcile('mode-split')
        return { ok: true, mode: 'split', docked: docked.length }
      }
      // 回浮动：已 dock 的 tab 默认留右栏（Q10），之后的新打开走浮窗。
      // 插件主动切回浮动 = 退出「右栏展开」形态，收起右栏（否则 Q2 会继续直通官方）。
      const collapsed = floatCompanion.isExpanded()
      if (collapsed) floatCompanion.toggleExpanded()
      companionState = persistCompanionState(setCompanionModeState(companionState, sessionId, 'float'))
      log.log('companion.mode', { mode: 'float', collapsed })
      refreshCompanionMode()
      scheduleCompanionReconcile('mode-float')
      return { ok: true, mode: 'float', collapsed }
    },
    /**
     * P3-12：「转回浮窗」——把已收回官方右栏（docked）的伴生 tab 重新浮出到槽位，
     * 并切回 float 形态（收起右栏）。槽位不足时保持剩余 docked 并提示。
     */
    companionRestoreDocked() {
      const sessionId = companionFocusId()
      if (!sessionId) return { ok: false, reason: 'no-session' }
      const records = sessionStateOf(companionState, sessionId).floats.filter((item) => item.docked)
      if (records.length === 0) return { ok: false, reason: 'no-docked' }
      const expandedNow = floatCompanion.isExpanded()
      // split 展开态下舞台按 compact 几何收窄；先用「收起后」的合成几何算槽位，避免按错误视口分配。
      const stage = floatCompanion.stageRect()
      const panel = floatCompanion.readPanel(sessionId)
      const syntheticStage = expandedNow && stage && panel && panel.found && panel.rect
        ? { left: stage.left, top: stage.top, width: stage.width + panel.rect.width, height: stage.height }
        : null
      const syntheticTable = syntheticStage ? computeSlots(syntheticStage, { viewportWidth: typeof window !== 'undefined' ? window.innerWidth : syntheticStage.width }) : null
      const restored = []
      for (const record of records) {
        const current = sessionStateOf(companionState, sessionId).floats
        let slot = null
        let rect = null
        if (syntheticTable) {
          const occupied = current.filter((item) => !item.docked && !item.peeked && Number.isInteger(item.slot)).map((item) => item.slot)
          slot = allocateSlotIndex(syntheticTable.maxSlots, occupied)
          if (slot === null) break
          rect = syntheticTable.slots[slot]
        } else {
          const allocation = floatCompanion.allocate(current.filter((item) => !item.docked && item.tabId !== record.tabId))
          // 槽位不足时不挤占/重叠已有浮窗：其余保持收回右栏（「转回浮窗」分批恢复）。
          if (!allocation.ok || allocation.evicted) break
          slot = allocation.slot
          rect = allocation.rect
        }
        const result = floatCompanion.floatTab(record.tabId, rect)
        if (!result.ok) continue
        companionState = persistCompanionState(upsertFloat(companionState, sessionId, {
          ...record,
          docked: false,
          peeked: false,
          slot,
          lastFocusedAt: Date.now(),
        }))
        restored.push(record.tabId)
      }
      if (restored.length === 0) return { ok: false, reason: 'float-failed' }
      if (restored.length < records.length) feedback.toast(t('toast.floatLimit'))
      if (floatCompanion.isExpanded()) floatCompanion.toggleExpanded()
      companionState = persistCompanionState(setCompanionModeState(companionState, sessionId, 'float'))
      refreshCompanionMode()
      scheduleCompanionReconcile('restore-docked')
      log.log('companion.docked.restore', { count: restored.length, synthetic: !!syntheticTable })
      return { ok: true, mode: 'float', restored: restored.length }
    },
    /** P3-12：检测官方「收回到侧边栏」：浮窗消失但 tab 仍在 openTabs → 切 split 并收回其余浮窗。 */
    companionDetectOfficialDock() {
      const sessionId = companionFocusId()
      if (!sessionId) return { ok: false, reason: 'no-session' }
      const records = sessionStateOf(companionState, sessionId).floats.filter((item) => !item.docked)
      if (records.length === 0) return { ok: false, reason: 'no-managed' }
      const domIds = new Set(floatCompanion.readFloats(sessionId).map((item) => String(item.tabId)))
      const missing = records.filter((item) => !domIds.has(String(item.tabId)))
      if (missing.length === 0) return { ok: true, detected: false }
      const openTabIds = new Set(floatCompanion.openTabs().value.map((item) => String(item.tabId)))
      const stillOpen = missing.filter((item) => openTabIds.has(String(item.tabId)))
      if (stillOpen.length === 0) {
        // tab 真的关闭了：交给对账删除。
        scheduleCompanionReconcile('dock-closed')
        return { ok: true, detected: false, reason: 'closed' }
      }
      log.log('companion.dock.detected', { count: stillOpen.length })
      actions.companionSetMode('split')
      return { ok: true, detected: true, docked: stillOpen.length }
    },
    companionToggleMode() {
      const next = modeOf(companionState, companionFocusId() || '') === 'float' ? 'split' : 'float'
      return actions.companionSetMode(next)
    },
    async quickNew(text, workspaceId) {
      await startDraft(uiWorkspace(), text, workspaceId, log)
    },
    undo() {
      const state = feedback.getSnapshot()
      if (!state.undo || !feedback.validUndo()) {
        feedback.clearUndo()
        return { ok: false, reason: 'no-undo' }
      }
      const entry = state.undo
      feedback.clearUndo()
      if (entry.kind === 'close-candidate') {
        const id = entry.sessionId
        store.update((current) => {
          const list = (current.candidates || []).filter((item) => item.sessionId !== id)
          const rawIndex = Number.isFinite(Number(entry.prevIndex)) ? Number(entry.prevIndex) : 0
          const index = Math.max(0, Math.min(rawIndex, list.length))
          list.splice(index, 0, { sessionId: id, addedAt: Date.now(), lastFocusedAt: Date.now() })
          return { ...current, candidates: list }
        })
        log.log('undo.close-candidate', { id, prevIndex: entry.prevIndex })
        return { ok: true }
      }
      if (entry.kind === 'close-focus' && entry.promoted) {
        store.addCandidate(entry.promoted)
        stageControl.suppressPrevFocus = true
        actions.focusSession(entry.sessionId)
        log.log('undo.close-focus', { id: entry.sessionId })
        return { ok: true }
      }
      return { ok: false }
    },
    /** 普通模式拖入会话区（HUD drop）：focus 区=替换焦点（旧焦点入候场）；rail 区=加入候场。 */
    enterStageFromDrop(sessionId, zone) {
      const id = sessionId === undefined || sessionId === null ? '' : String(sessionId)
      if (!id) return { ok: false, reason: 'no-id' }
      const focusId = focusSignal.getSnapshot() || currentMainSessionId()
      if (zone === 'focus') {
        if (id === focusId) return { ok: true, reason: 'already-focus' }
        if (focusId) actions.addCandidate(focusId)
        actions.focusSession(id)
      } else {
        if (!focusId) {
          actions.focusSession(id)
          return { ok: true, reason: 'became-focus', note: '无主会话：先成为焦点' }
        }
        if (id === focusId) return { ok: false, reason: 'is-focus' }
        actions.addCandidate(id)
      }
      log.log('drag.enterStage', { id, zone, focusId })
      return { ok: true }
    },
    openPicker() {
      pickerSignal.set({ visible: true, sessionId: focusSignal.getSnapshot() })
      log.log('picker.open', null)
    },
    closePicker() {
      pickerSignal.set({ visible: false, sessionId: null })
    },
    requestQuickNew() {
      quickSignal.set(Date.now())
    },
    /** 键盘路径「回到焦点会话输入」（Ctrl+Alt+1）：舞台内 StageRoot 消费该信号聚焦 composer。 */
    requestFocusInput() {
      focusInputSignal.set(focusInputSignal.getSnapshot() + 1)
    },
    nudgeQuickBar() {
      quickSignal.set(Date.now())
    },
    exitStage(showToast) {
      if (focusPreviewSignal.getSnapshot()) focusPreviewSignal.set(null)
      if (!store.getSnapshot().candidates.length) {
        if (showToast) feedback.toast(t('toast.exitedStage'))
        return
      }
      store.update((state) => ({ ...state, candidates: [] }))
      feedback.clearBubble()
      log.log('stage.exit', { toast: !!showToast })
      if (showToast) feedback.toast(t('toast.exitedStage'))
    },
    onNarrow() {
      log.log('stage.narrow', null)
      if (store.getSnapshot().candidates.length > 0) {
        feedback.toast(t('toast.tooNarrow'))
        actions.exitStage(false)
      }
    },
    onWindowError(sessionId, message) {
      log.log('window.error', { sessionId, message })
    },
    onDropSession(sessionId, zone) {
      const id = String(sessionId)
      if (zone === 'focus') {
        if (id === focusSignal.getSnapshot()) return
        // 同 promote：让 handleFocus 负责移出新焦点/降级旧焦点，避免提升唯一候场时舞台退出。
        stageControl.suppressPrevFocus = false
        actions.focusSession(id)
        log.log('drop.focus', { id })
        return
      }
      if (isCandidate(id)) return
      const result = actions.addCandidate(id)
      log.log('drop.rail', { id, ok: result.ok, evicted: result.evicted || null })
    },
    isSessionId(value) {
      return typeof value === 'string' && !!byId()[value]
    },
  }

  // ---------- 焦点 / 目录 reconcile ----------
  let lastFocusRef = null
  let syncingRefs = false
  /** 延后释放已排队（每批只排一个微任务）。 */
  let releaseFlushScheduled = false
  /** 卸载后禁止再操作引用（见清理段）。 */
  let refsClosed = false
  const desiredRefIds = () => {
    const focusId = focusSignal.getSnapshot()
    const candidates = (store.getSnapshot().candidates || []).map((item) => item.sessionId)
    const desired = new Set(candidates)
    if (focusId) {
      desired.add(focusId)
    } else if (stageControl.mounted && lastFocusRef) {
      // 切焦点瞬时抖动（桥上报 null 一帧）时保留焦点引用，避免反复 retain/release
      desired.add(lastFocusRef)
    }
    return desired
  }
  const flushRefReleases = () => {
    releaseFlushScheduled = false
    if (refsClosed) return
    const desired = desiredRefIds()
    for (const id of Array.from(refs.map.keys())) {
      if (!desired.has(id)) refs.release(id)
    }
  }
  const syncRefs = () => {
    if (syncingRefs) return
    syncingRefs = true
    try {
      const focusId = focusSignal.getSnapshot()
      if (focusId) lastFocusRef = focusId
      const desired = desiredRefIds()
      for (const id of desired) {
        if (!refs.has(id)) refs.retain(id)
      }
      // 释放延后一个微任务再重算 desired：换焦时旧焦点会先短暂不在 desired（demote 尚未把它加回候场），
      // 立即 release 会让引用计数归零、DSH 同步拆除 scope/generation（草稿/滚动位置丢失风险；
      // 0.7.0 审查 F2）。延后到微任务后，demote 通常已把旧焦点加回，引用不再归零。
      if (!releaseFlushScheduled) {
        releaseFlushScheduled = true
        queueMicrotask(flushRefReleases)
      }
    } finally {
      syncingRefs = false
    }
  }

  let nullFocusTimer = null
  /** 把一次焦点上报落到舞台/状态（0.6.1 点击慢速路径也在 VT 回调内直接调用，跳过官方等待）。 */
  const applyFocusReport = (nextRaw) => {
    const next = nextRaw ? String(nextRaw) : null
    const prev = focusSignal.getSnapshot()
    if (prev === next) return
    // F1（换焦继承快照）：在改焦点状态之前，把即将降级窗口的内容同步序列化进快照缓存。
    // 此时 DOM 仍是旧焦点（慢速点击路径在 VT 更新回调内、路径 B 在 FocusBridge effect 内），
    // 命中则换焦后被降级卡直接展示该快照，不再为它隐藏挂载一次官方内容（0.15–0.4s）。
    const suppressPrevFocus = stageControl.suppressPrevFocus
    const activeCandidates = store.getSnapshot().candidates.length > 0
    const willDemote = !!(next && prev && prev !== next && !suppressPrevFocus && activeCandidates && byId()[prev])
    if (willDemote && typeof previewBridge.capture === 'function') {
      try {
        if (previewBridge.capture(prev) === true) log.log('preview.inherit', { id: prev })
        else log.log('preview.inherit.miss', { id: prev })
      } catch (error) {
        log.log('preview.inherit.error', String((error && error.message) || error).slice(0, 160))
      }
    }
    focusSignal.set(next)
    log.log('focus.report', { from: prev, to: next })
    if (!next) {
      // 桥先于主绑定发布时可能上报 null 一帧：给 1.5s 宽限，期间主绑定到达则不退出。
      if (nullFocusTimer) clearTimeout(nullFocusTimer)
      nullFocusTimer = setTimeout(() => {
        nullFocusTimer = null
        if (focusSignal.getSnapshot()) return
        if (store.getSnapshot().candidates.length > 0) {
          store.update((state) => ({ ...state, candidates: [] }))
          log.log('stage.exit.no-focus', null)
        }
        syncRefs()
      }, 1500)
      syncRefs()
      return
    }
    if (nullFocusTimer) {
      clearTimeout(nullFocusTimer)
      nullFocusTimer = null
    }
    const suppress = stageControl.suppressPrevFocus
    stageControl.suppressPrevFocus = false
    const active = store.getSnapshot().candidates.length > 0
    // P2-4：外部主绑定变化（官方侧栏点击等）也补一条 focus-switch 起点（动作路径已有起点则不覆盖）。
    if (prev && next && stageControl.mounted && !pendingFocusSwitch) beginFocusSwitch('report')
    feedback.clearFlash(next)
    if (feedback.getSnapshot().bubble && feedback.getSnapshot().bubble.sessionId === next) feedback.clearBubble(next)
    // 「移出新焦点 + 旧焦点降级」合并为一次 store 提交：分两次提交时，next 恰为唯一候场的那一帧会出现
    // candidates=[] 的中间态，syncStage 会整舞台卸载再重挂载（0.7.0 审查 F1）。
    const demote = !!(prev && prev !== next && !suppress && active && byId()[prev])
    let demoteEvicted = null
    store.update((state) => {
      const afterRemove = removeCandidatePure(state, next).state
      if (!demote) return afterRemove
      const added = addCandidatePure(afterRemove, prev)
      demoteEvicted = added.evicted || null
      return added.state
    })
    if (demote) log.log('focus.demote', { id: prev, evicted: demoteEvicted })
    syncRefs()
    settleFocusSwitch()
  }

  const handleFocus = (nextRaw) => applyFocusReport(nextRaw)

  let reconcileScheduled = false
  const reconcileNow = () => {
    const rows = byId()
    const total = Object.keys(rows).length
    if (total === 0) return
    const result = store.reconcile({ byId: rows, mainId: focusSignal.getSnapshot(), prevMainId: null })
    if (result.changed) log.log('catalog.reconcile', { dropped: result.dropped, addedPrevFocus: result.addedPrevFocus })
    syncRefs()
  }
  /** 目录 reconcile 走微任务合并：sessions.list 通知可能由我们的 retain 同步触发，递归会栈溢出。 */
  const reconcileCatalog = () => {
    if (reconcileScheduled) return
    reconcileScheduled = true
    queueMicrotask(() => {
      reconcileScheduled = false
      try {
        reconcileNow()
      } catch (error) {
        log.log('catalog.reconcile.error', String(error))
      }
    })
  }

  // ---------- 舞台注册 / 释放 ----------
  /**
   * 延迟销毁的槽位 dispose 队列。
   * 直接在 React 提交过程中销毁注册会触发 slot runtime 的
   * `renderSlot('onestep.focus') from a disposed registration` 报错（窄屏退出路径实测）。
   * 策略：unmount 时把 disposer 移入队列并 setTimeout(0) 冲刷，让 React 先完成本次提交；
   * 若期间立即重新挂载，mountStage 开头同步冲刷，避免新旧注册冲突。
   */
  let pendingDisposers = null
  const flushPendingDisposers = () => {
    if (!pendingDisposers) return
    const list = pendingDisposers
    pendingDisposers = null
    for (const dispose of list) {
      try {
        dispose()
      } catch (error) {
        log.log('stage.unmount.error', String(error))
      }
    }
  }

  const mountStage = () => {
    if (stageControl.mounted) return
    flushPendingDisposers()
    if (!stageControl.mainReady) {
      log.log('stage.mount.deferred', { reason: 'main-not-declared' })
      return
    }
    // P2-4：进入舞台动作开始（stage-enter-start）；ready 由 StageRoot 在焦点窗首帧可见时上报。
    beginStageEnter()
    const disposers = []
    try {
      disposers.push(
        ctx.slots.register(
          {
            name: SLOTS.main,
            key: SLOTS.mainKey,
            priority: -1,
            children: {
              [SLOTS.focus]: { kind: 'single', scope: 'session-maybe' },
              [SLOTS.window]: { kind: 'single', scope: 'session' },
            },
            inject: () => ({
              t,
              store,
              feedback,
              focusSignal,
              focusPreviewSignal,
              previewBridge,
              quickSignal,
              focusInputSignal,
              dragSignal,
              getReference: (sessionId) => refs.get(sessionId),
              hasReference: (sessionId) => refs.has(sessionId),
              onPromote: actions.promote,
              onCloseCandidate: actions.closeCandidate,
              onCloseFocus: actions.closeFocus,
              onExit: actions.exitStage,
              onNarrow: actions.onNarrow,
              onToggleRightbar: actions.toggleRightbar,
              isRightbarExpanded: () => companion.isExpanded(),
              // P3-4：伴生窗开关 / 形态菜单 / 形态信号。
              onToggleCompanion: actions.companionToggleFloats,
              onSetCompanionMode: actions.companionSetMode,
              onOpenRightbar: actions.toggleRightbar,
              onRestoreDocked: actions.companionRestoreDocked,
              companionModeSignal,
              companionDockedSignal,
              onQuickNew: actions.quickNew,
              onDropSession: actions.onDropSession,
              isSessionId: actions.isSessionId,
              onUndo: actions.undo,
              onWindowError: actions.onWindowError,
              // P2-3：自动降级运行时状态（渲染层覆盖档位，不写持久化）+ 手动切档入口。
              autoLiteSignal,
              onSetPreviewMode: actions.setPreviewMode,
              // P4-8：减少动效开关（系统偏好 + 插件设置，持久化）。
              onSetReducedMotion: actions.setReducedMotion,
              // P4-3：候场栏收展走 action（VT 动画），不直接改 store。
              onSetRailCollapsed: actions.setRailCollapsed,
              // P4 修复（用户反馈交换动画卡顿）：把重活（降级候场卡的 live 缩略挂载等）延后到当前动效结束，
              // 否则官方聊天体在 morph 动画中途挂载会造成主线程长任务（实测 158-173ms）→ 动画掉帧/冻结。
              afterMotion: (callback) => {
                if (typeof callback !== 'function') return
                const run = () => {
                  try {
                    callback()
                  } catch (error) {
                    log.log('motion.after.error', String(error).slice(0, 160))
                  }
                }
                if (!motionController.snapshot().active) {
                  run()
                  return
                }
                // 动画结束后先留 120ms 余量，再尽量在浏览器空闲时挂载（避免重活落在动画收尾或用户下一次交互上）。
                void motionController.settled().then(() => {
                  setTimeout(() => {
                    try {
                      if (typeof requestIdleCallback === 'function') {
                        requestIdleCallback(() => run(), { timeout: 1500 })
                        return
                      }
                    } catch (_error) {
                      /* 回落 setTimeout */
                    }
                    setTimeout(run, 250)
                  }, 120)
                })
              },
              // P2-4：舞台/焦点切换就绪回调（由 StageRoot 在官方内容首帧可见时上报）。
              onStageReady,
              onFocusSwitchContentReady,
            }),
          },
          StageRoot,
        ),
      )
      disposers.push(
        ctx.slots.register(
          { name: SLOTS.focus, inject: () => ({ report: handleFocus }) },
          FocusBridge,
        ),
      )
      disposers.push(ctx.slots.register({ name: SLOTS.window }, WindowContentOccurrence))
      stageControl.disposers = disposers
      stageControl.mounted = true
      log.log('stage.mount', null)
    } catch (error) {
      log.log('stage.mount.error', String(error))
      stopLongTaskObserver()
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch (_error) {
          /* ignore */
        }
      }
      feedback.toast(t('error.stageUnavailable'))
      // 注意：不要清空 candidates——挂载失败可能是瞬时（槽位尚未声明/服务未就绪），
      // 保留 roster 让后续触发重试，避免把用户的舞台状态误删。
    }
  }

  /** 舞台退出后的焦点归属：官方会话 composer（官方会话恢复异步，重试约 2.5s；只在焦点仍在 body/舞台内时才移动）。 */
  const focusOfficialComposer = () => {
    let attempts = 0
    const tryFocus = () => {
      try {
        const active = document.activeElement
        const activeInsideStage = !!(active && active.closest && active.closest('[data-onestep-stage]'))
        const userElsewhere = !!active && active !== document.body && active !== document.documentElement && !activeInsideStage
        if (userElsewhere) return
        const candidates = Array.from(document.querySelectorAll('[contenteditable="true"], [role="textbox"]'))
        const target = candidates.find((element) => element.getBoundingClientRect().width > 0 && !element.closest('[data-onestep-stage]'))
        if (target && typeof target.focus === 'function') {
          target.focus()
          return
        }
      } catch (_error) {
        /* 焦点归属是增强项：失败不影响退出语义 */
      }
      attempts += 1
      if (attempts < 25 && typeof setTimeout === 'function') setTimeout(tryFocus, 100)
    }
    tryFocus()
  }

  const unmountStage = () => {
    if (!stageControl.mounted) return
    pendingDisposers = stageControl.disposers.reverse()
    stageControl.disposers = []
    stageControl.mounted = false
    // 自动降级/打点的运行时状态属于「本次舞台会话」，退出即清（用户保存的 previewMode 不动）。
    resetAutoLite()
    // 舞台卸载后不存在主绑定桥：清掉陈旧 focusSignal，避免重进舞台时把上一轮的旧焦点误降为候场。
    if (nullFocusTimer) {
      clearTimeout(nullFocusTimer)
      nullFocusTimer = null
    }
    lastFocusRef = null
    focusSignal.set(null)
    log.log('stage.unmount', null)
    // 产品报告 §10.2：舞台退出后 DOM 焦点回到官方会话 composer（React 提交后再移动，避免抢渲染）。
    if (typeof setTimeout === 'function') setTimeout(focusOfficialComposer, 0)
    // React 提交完成后再销毁槽位注册（见 pendingDisposers 注释）
    if (typeof setTimeout === 'function') setTimeout(flushPendingDisposers, 0)
    else flushPendingDisposers()
  }

  const syncStage = () => {
    const active = store.getSnapshot().candidates.length > 0
    if (active && !stageControl.mounted && stageControl.mainReady) mountStage()
    else if (!active && stageControl.mounted) unmountStage()
  }

  // ---------- 状态反馈（边沿检测组件，注册在 shell.overlay） ----------
  function StatusTracker(props) {
    const statuses = props.useSessionStatus((state) => state)
    const rows = props.useSessions((state) => state.byId)
    const stage = useSpecSnapshot(store)
    const focusId = useSpecSnapshot(focusSignal)
    statusCache.value = statusesSnapshot(statuses)
    const prevRef = React.useRef({ unread: {}, pending: {} })
    React.useEffect(() => {
      const prev = prevRef.current
      const candidates = (stage.candidates || []).map((item) => item.sessionId)
      const unreadNext = {}
      const pendingNext = {}
      for (const sessionId of candidates) {
        const status = statusOf(statuses, sessionId)
        const unread = !!(status && status.completionUnread)
        const pendingKind = status && status.pendingInteraction ? status.pendingInteraction.kind : null
        unreadNext[sessionId] = unread
        pendingNext[sessionId] = pendingKind
        if (unread && prev.unread[sessionId] !== true) {
          feedback.flash(sessionId)
          log.log('feedback.unread', { sessionId })
        }
        if (pendingKind && prev.pending[sessionId] !== pendingKind) {
          feedback.setBubble(sessionId, pendingKind)
          log.log('feedback.pending', { sessionId, kind: pendingKind })
        }
        if (!pendingKind && prev.pending[sessionId] && feedback.getSnapshot().bubble && feedback.getSnapshot().bubble.sessionId === sessionId) {
          feedback.clearBubble(sessionId)
        }
      }
      // 焦点会话的未读/气泡清除
      if (focusId) {
        if (feedback.getSnapshot().bubble && feedback.getSnapshot().bubble.sessionId === focusId) feedback.clearBubble(focusId)
        if (feedback.getSnapshot().flash[focusId]) feedback.clearFlash(focusId)
      }
      // 离场会话清理
      for (const sessionId of Object.keys(prev.unread)) {
        if (!candidates.includes(sessionId)) feedback.clearFlash(sessionId)
      }
      prevRef.current = { unread: unreadNext, pending: pendingNext }
    }, [statuses, rows, stage.candidates, focusId])
    return null
  }

  // ---------- 全局 toast（shell.overlay）：舞台卸载/退出后仍可见 ----------
  function StageToast() {
    const state = useSpecSnapshot(feedback)
    const toast = state.toast
    React.useEffect(() => {
      if (!toast) return undefined
      const lifetime = Number(toast.lifetimeMs) > 0 ? Number(toast.lifetimeMs) : (toast.undoable ? LIMITS.undoWindowMs : 2600)
      const age = Date.now() - toast.at
      if (age > lifetime) {
        feedback.clearToast()
        return undefined
      }
      const timer = setTimeout(() => feedback.clearToast(), lifetime - age)
      return () => clearTimeout(timer)
    }, [toast])
    if (!toast) return null
    return h(
      'div',
      { className: 'onestep-toast', role: 'status', style: { '--onestep-toast-life': (Number(toast.lifetimeMs) > 0 ? Number(toast.lifetimeMs) : 3000) + 'ms' } },
      h('span', null, toast.text),
      toast.undoable ? h('button', { type: 'button', className: 'onestep-btn', onClick: () => actions.undo() }, t('toast.undo')) : null,
    )
  }

  // ---------- 入口组件 ----------
  function RowActionButton(props) {
    return h(
      'button',
      {
        type: 'button',
        className: 'onestep-btn onestep-row-action',
        'data-onestep-row-action': '1',
        'data-session': props.sessionId ? String(props.sessionId) : '',
        title: props.t('entry.addCandidate'),
        'aria-label': props.t('entry.addCandidate'),
        onClick: (event) => {
          event.stopPropagation()
          props.onAdd(props.sessionId)
        },
      },
      '＋',
    )
  }

  function HeaderStageButton(props) {
    return h(
      'button',
      {
        type: 'button',
        className: 'onestep-btn onestep-header-action',
        'data-onestep-header-action': '1',
        title: props.t('entry.openStage'),
        'aria-label': props.t('entry.openStage'),
        onClick: (event) => {
          event.stopPropagation()
          props.onOpen()
        },
      },
      props.t('stage.title').slice(0, 12),
    )
  }

  /** header picker / Alt+S 的会话选择浮层。 */
  function StagePicker(props) {
    const picker = useSpecSnapshot(pickerSignal)
    const rows = props.useSessions((state) => state.byId)
    const focusId = useSpecSnapshot(focusSignal)
    const [selected, setSelected] = React.useState([])
    React.useEffect(() => {
      if (picker.visible) setSelected([])
    }, [picker.visible])
    React.useEffect(() => {
      if (!picker.visible) return undefined
      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          actions.closePicker()
        }
      }
      document.addEventListener('keydown', onKey, true)
      return () => document.removeEventListener('keydown', onKey, true)
    }, [picker.visible])
    if (!picker.visible) return null
    const items = Object.keys(rows)
      .map((id) => ({ id, row: rows[id] }))
      .filter((item) => item.id !== focusId)
      .sort((a, b) => SESSION_FIELDS.updatedAt(b.row) - SESSION_FIELDS.updatedAt(a.row))
      .slice(0, 30)
    const toggle = (id) => {
      setSelected((prev) => {
        if (prev.includes(id)) return prev.filter((item) => item !== id)
        if (prev.length >= LIMITS.maxCandidates) return prev
        return [...prev, id]
      })
    }
    return h(
      'div',
      {
        'data-onestep-picker': '1',
        className: 'onestep-picker-mask',
        onClick: () => actions.closePicker(),
      },
      h(
        'div',
        {
          className: 'onestep-picker',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('entry.stagePicker'),
          onClick: (event) => event.stopPropagation(),
        },
        h('div', { className: 'onestep-picker-title' }, t('entry.stagePicker')),
        h('div', { className: 'onestep-picker-hint' }, interpolate(t('picker.max'), { count: LIMITS.maxCandidates })),
        items.map((item) => h(
          'label',
          { key: item.id, className: 'onestep-picker-item' },
          h('input', {
            type: 'checkbox',
            checked: selected.includes(item.id),
            onChange: () => toggle(item.id),
          }),
          h('span', { className: 'onestep-picker-item-title' }, SESSION_FIELDS.title(item.row) || item.id),
          h('span', { className: 'onestep-picker-item-meta' }, item.row.blank ? t('picker.blank') : ''),
        )),
        h(
          'div',
          { className: 'onestep-picker-actions' },
          h('button', { type: 'button', className: 'onestep-btn', onClick: () => actions.closePicker() }, t('picker.cancel')),
          h('button', {
            type: 'button',
            className: 'onestep-btn',
            onClick: () => {
              for (const id of selected) actions.addCandidate(id)
              actions.closePicker()
            },
          }, interpolate(t('picker.confirm'), { count: selected.length })),
        ),
      ),
    )
  }

  // ---------- 注册入口 + overlay（等声明可用） ----------
  enabled('entries') &&
  ctx.effect(
    () =>
      ctx.slots.inject(SLOTS.rowAction, () =>
        ctx.slots.register(
          {
            name: SLOTS.rowAction,
            id: 'onestep.add-candidate',
            order: 20,
            inject: () => ({ t, onAdd: actions.addCandidate }),
          },
          RowActionButton,
        ),
      ),
    'dsh-onestep: sidebar row action',
  )
  enabled('entries') &&
  ctx.effect(
    () =>
      ctx.slots.inject(SLOTS.headerActions, () =>
        ctx.slots.register(
          {
            name: SLOTS.headerActions,
            id: 'onestep.open-stage',
            order: 20,
            inject: () => ({ t, onOpen: actions.openPicker }),
          },
          HeaderStageButton,
        ),
      ),
    'dsh-onestep: header stage button',
  )
  enabled('overlay') &&
  ctx.effect(
    () =>
      ctx.slots.inject(SLOTS.overlay, () =>
        ctx.slots.register(
          { name: SLOTS.overlay, id: 'onestep.picker', order: 60, label: () => t('entry.stagePicker') },
          StagePicker,
        ),
      ),
    'dsh-onestep: stage picker overlay',
  )
  enabled('overlay') &&
  ctx.effect(
    () =>
      ctx.slots.inject(SLOTS.overlay, () =>
        ctx.slots.register({ name: SLOTS.overlay, id: 'onestep.status-tracker', order: 61 }, StatusTracker),
      ),
    'dsh-onestep: status tracker',
  )
  enabled('overlay') &&
  ctx.effect(
    () =>
      ctx.slots.inject(SLOTS.overlay, () =>
        ctx.slots.register({ name: SLOTS.overlay, id: 'onestep.toast', order: 63 }, StageToast),
      ),
    'dsh-onestep: global toast',
  )

  // ---------- S7/P1-7 拖拽捕获 + 普通模式 HUD ----------
  ctx.effect(
    () =>
      installDragCapture(dragSignal, {
        log,
        getStageMounted: () => stageControl.mounted,
        isSessionId: actions.isSessionId,
        onDrop: actions.enterStageFromDrop,
      }),
    'dsh-onestep: drag capture',
  )
  enabled('drag') &&
    ctx.effect(
      () =>
        ctx.slots.inject(SLOTS.overlay, () =>
          ctx.slots.register(
            {
              name: SLOTS.overlay,
              id: 'onestep.drag-hud',
              order: 58,
              inject: () => ({
                t,
                signal: dragSignal,
                isStageMounted: () => stageControl.mounted,
                isSessionId: actions.isSessionId,
                onDropSession: actions.enterStageFromDrop,
              }),
            },
            StageDragOverlay,
          ),
        ),
      'dsh-onestep: drag HUD overlay',
    )

  // P3-11：右缘标签层（portal 到 body，z 63）+ 点击浮窗外收起。
  ctx.effect(
    () =>
      ctx.slots.inject(SLOTS.overlay, () =>
        ctx.slots.register(
          { name: SLOTS.overlay, id: 'onestep.peek-tags', order: 63 },
          PeekTagLayer,
        ),
      ),
    'dsh-onestep: peek tag layer',
  )
  ctx.effect(() => peekLayer.installOutsideClick(), 'dsh-onestep: peek outside click')

  // P3-12：官方浮窗「收回到侧边栏」检测（点击官方 dock 按钮后，浮窗消失但 tab 仍在 openTabs → 切 split）。
  ctx.effect(() => {
    const onPointerDown = (event) => {
      const target = event.target
      if (!target || typeof target.closest !== 'function') return
      if (!target.closest('[data-dockkit-float-dock]')) return
      setTimeout(() => {
        try {
          actions.companionDetectOfficialDock()
        } catch (error) {
          log.log('companion.dock.detect.error', String(error).slice(0, 120))
        }
      }, 120)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, 'dsh-onestep: official dock detection')

  // ---------- 探针 ----------
  // ---------- 伴生窗跟随审计：官方 mounted 应始终等于舞台焦点（主绑定） ----------
  ctx.effect(
    () =>
      companion.subscribeMounted((mounted) => {
        const focus = focusSignal.getSnapshot() || currentMainSessionId()
        const ok = !!mounted && mounted === focus
        log.log('companion.follow', { mounted: mounted || null, focus: focus || null, ok })
        // P3-3：官方 on-screen 会话变化后对账插件侧浮窗元数据；P3-4 同步形态信号；P3-11 换标签数据。
        refreshCompanionMode()
        if (syncPeekLayerFn) syncPeekLayerFn()
        scheduleCompanionReconcile('mounted-change')
      }),
    'dsh-onestep: companion follow audit',
  )

  const probe = createProbe({
    version: VERSION,
    log,
    store,
    focusSignal,
    stageControl,
    actions,
    t,
    autoLite: autoLiteState,
    perf: () => ({ supported: perf.supported, measures: perf.recent() }),
    getRows: () => {
      const rows = byId()
      const out = {}
      for (const id of Object.keys(rows)) {
        const row = rows[id]
        out[id] = { title: SESSION_FIELDS.title(row), blank: SESSION_FIELDS.blank(row), updatedAt: SESSION_FIELDS.updatedAt(row) }
      }
      return out
    },
    getStatus: () => statusCache.value,
    getFeedback: () => feedback.getSnapshot(),
    feedback,
    getDrag: () => dragSignal.getSnapshot(),
    currentMainSessionId,
    p3: floatProbe,
    // P4-8：减少动效模式/控制器只读快照（e2e 断言 <html data-onestep-motion> 与 VT 路由）。
    motion: motionState,
  })
  window.__ONESTEP__ = { version: VERSION, snapshot: probe.api.snapshot, actions: probe.api, log: log.tail }
  if (probe.ProbePanel) {
    ctx.effect(
      () =>
        ctx.slots.inject(SLOTS.overlay, () =>
          ctx.slots.register({ name: SLOTS.overlay, id: 'onestep.probe-panel', order: 62 }, probe.ProbePanel),
        ),
      'dsh-onestep: probe panel',
    )
  }

  // ---------- 快捷键 ----------
  // 键位口径（P2 定稿）：保留 Ctrl+Alt(+Shift) 系——P1 实测发现 Alt 单修饰键在 desktop 菜单与
  // 输入法下冲突面更大，且 Ctrl+Alt+W 曾与官方保留序列冲突（已用 +Shift 避让）。开发文档 §7.1 /
  // 产品报告 §10.1 已同步为真实键位；官方快捷键页显示这些 label，用户可在其中改键。
  if (enabled('shortcuts'))
  try {
    const shortcuts = ctx.shortcuts || ctx.get(SERVICES.shortcuts)
    if (shortcuts && typeof shortcuts.register === 'function') {
      const register = (id, label, code, modifiers, run) => {
        try {
          ctx.effect(
            () =>
              shortcuts.register({
                id: 'onestep.' + id,
                label: () => label,
                aliases: ['onestep-' + id],
                defaults: { 'web:windows': { code, modifiers }, 'desktop:windows': { code, modifiers } },
                regions: ['page'],
                modals: [],
                resolve: () => ({ status: 'handled', run }),
              }),
            'dsh-onestep: shortcut ' + id,
          )
          log.log('shortcut.register', { id })
        } catch (error) {
          log.log('shortcut.register.error', { id, error: String(error) })
        }
      }
      enabled('sc-toggle') && register('toggle-stage', t('stage.enter'), 'KeyS', ['primary', 'alt'], () => {
        if (store.getSnapshot().candidates.length > 0) actions.exitStage(true)
        else actions.openPicker()
      })
      enabled('sc-quick') && register('quick-new', t('shortcut.quickNew'), 'KeyN', ['primary', 'alt', 'shift'], () => actions.requestQuickNew())
      enabled('sc-close') && register('close-focus', t('window.close'), 'KeyW', ['primary', 'alt', 'shift'], () => actions.closeFocus())
      enabled('sc-undo') && register('undo', t('toast.undo'), 'KeyZ', ['primary', 'alt'], () => actions.undo())
      // Ctrl+Alt+1：回到焦点会话输入（报告 §10.1）；Ctrl+Alt+2..9：提升第 2..9 个窗口（0.6.0 上限 12，键盘只覆盖到 Digit9）。
      enabled('sc-focus') && register('focus-1', t('shortcut.focusInput'), 'Digit1', ['primary', 'alt'], () => actions.requestFocusInput())
      // Digit 键只到 9：候场超过 8 个时，第 9 个之后用滚动 + 点击/标题按钮提升。
      const shortcutMax = Math.min(LIMITS.maxCandidates + 1, 9)
      for (let index = 2; index <= shortcutMax; index += 1) {
        enabled('sc-focus') && register('focus-' + index, interpolate(t('shortcut.focus'), { index }), 'Digit' + index, ['primary', 'alt'], () => {
          const candidates = (store.getSnapshot().candidates || []).map((item) => item.sessionId)
          const target = candidates[index - 2]
          if (target) actions.promote(target)
        })
      }
      // Ctrl+Alt+←/→：焦点在窗口间循环切换（官方无该组合，报告 §10.1 原样保留）。
      enabled('sc-cycle') && register('cycle-prev', t('shortcut.cyclePrev'), 'ArrowLeft', ['primary', 'alt'], () => actions.cycleFocus(-1))
      enabled('sc-cycle') && register('cycle-next', t('shortcut.cycleNext'), 'ArrowRight', ['primary', 'alt'], () => actions.cycleFocus(1))
    } else {
      log.log('shortcuts.missing', null)
    }
  } catch (error) {
    log.log('shortcuts.error', String(error))
  }

  // ---------- 订阅：目录 / 模式机 / 引用 ----------
  const unsubscribers = []
  if (enabled('sessions'))
  try {
    ctx.inject(['sessions'], (scope) => {
      const service = (scope && typeof scope.get === 'function' ? scope.get('sessions') : null) || sessionsSvc()
      if (!service) {
        log.log('sessions.missing', null)
        return
      }
      let unsubscribe = null
      try {
        if (service.list && typeof service.list.subscribe === 'function') {
          unsubscribe = service.list.subscribe(() => reconcileCatalog())
        }
      } catch (error) {
        log.log('sessions.subscribe.error', String(error))
      }
      const cleanup = () => {
        if (typeof unsubscribe === 'function') unsubscribe()
      }
      if (scope && typeof scope.effect === 'function') {
        scope.effect(() => cleanup, 'dsh-onestep: sessions subscription')
      } else {
        unsubscribers.push(cleanup)
      }
      log.log('sessions.ready', null)
      reconcileCatalog()
      syncRefs()
      syncStage()
    })
  } catch (error) {
    log.log('sessions.inject.error', String(error))
  }
  unsubscribers.push(store.subscribe(() => {
    syncStage()
    syncRefs()
    // 进入舞台后才补候场到 4 窗时，也补一次自动降级采样。
    maybeSampleAutoLite()
    // P3-4：舞台激活/退出会影响包装层启用条件，同步形态信号。
    refreshCompanionMode()
  }))
  unsubscribers.push(focusSignal.subscribe(() => {
    syncRefs()
    // P3-3：焦点切换后对账当前会话的浮窗元数据（等 React 提交后一帧）；P3-11 换标签数据。
    refreshCompanionMode()
    if (syncPeekLayerFn) syncPeekLayerFn()
    scheduleCompanionReconcile('focus-change')
  }))

  // main 槽声明可用后再允许挂载；同时恢复持久化的 stage roster
  enabled('main') && ctx.slots.inject(SLOTS.main, () => {
    stageControl.mainReady = true
    log.log('main.declared', null)
    reconcileCatalog()
    syncRefs()
    syncStage()
    return () => {
      stageControl.mainReady = false
      unmountStage()
      log.log('main.undeclared', null)
    }
  })

  // 启动即按持久化状态尝试进入舞台
  syncStage()
  syncRefs()

  // ---------- 清理 ----------
  ctx.effect(() => {
    return () => {
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe()
        } catch (_error) {
          /* ignore */
        }
      }
      unmountStage()
      refsClosed = true
      refs.releaseAll()
      // P3-11：还原所有收起注入并卸载标签层/观察器/监听。
      try {
        const peekState = peekLayer.getSnapshot()
        for (const item of peekState.items) {
          if (item.peeked) applyFloatPeekDom(peekState.sessionId, item.tabId, false)
        }
      } catch (_error) {
        /* ignore */
      }
      peekLayer.dispose()
      try {
        if (floatResizeRef.current) floatResizeRef.current.dispose()
      } catch (_error) {
        /* ignore */
      }
      floatResizeRef.current = null
      try {
        floatFlash.dispose()
      } catch (_error) {
        /* ignore */
      }
      if (motionMediaCleanup) {
        try {
          motionMediaCleanup()
        } catch (_error) {
          /* ignore */
        }
        motionMediaCleanup = null
      }
      try {
        if (typeof document !== 'undefined' && document.documentElement) document.documentElement.removeAttribute('data-onestep-motion')
      } catch (_error) {
        /* ignore */
      }
      store.flush()
      store.dispose()
      feedback.dispose()
      localeDispose()
      try {
        delete window.__ONESTEP__
      } catch (_error) {
        /* ignore */
      }
      log.log('dispose', null)
    }
  }, 'dsh-onestep: lifecycle')
}

/** 供离线单测/探针复用（DSH 只读 apply/inject，未知导出无副作用）。 */
export const __internals = { VERSION, normalizeState, addCandidatePure, loadPersisted, LIMITS }
