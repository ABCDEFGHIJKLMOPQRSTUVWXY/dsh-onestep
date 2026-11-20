/**
 * P1 开发探针：window.__ONESTEP__ 全局证据面 + 可选面板（localStorage 开关）。
 * 生产行为不依赖它；验证器（scripts/p0/verify/playwright-driver.mjs）通过 actions 驱动。
 */
import { React, h } from './h.js'
import { PROBE_FLAG_KEY } from './adapter.js'

/**
 * @param {object} deps 由 apply 注入
 * @returns {{version:string, api:object, Panel:Function|null}}
 */
export function createProbe(deps) {
  const { version, log, store, focusSignal, stageControl, actions, t, getRows, getStatus, feedback } = deps
  const startedAt = Date.now()

  const snapshot = () => {
    const stage = store.getSnapshot()
    const feedbackState = feedback.getSnapshot()
    const allRows = getRows()
    const rowIds = Object.keys(allRows)
    const rowSample = {}
    for (const id of rowIds.slice(0, 8)) rowSample[id] = allRows[id]
    // P2-3：自动降级运行时状态（自动降级只覆盖渲染，不改用户保存的 previewMode）。
    const autoLite = deps.autoLite ? deps.autoLite() : null
    return {
      version,
      startedAt,
      now: Date.now(),
      mounted: !!stageControl.mounted,
      mainReady: !!stageControl.mainReady,
      focusId: focusSignal.getSnapshot(),
      candidates: (stage.candidates || []).map((c) => c.sessionId),
      stageActive: (stage.candidates || []).length > 0,
      railSide: stage.railSide,
      railSize: stage.railSize,
      railCollapsed: stage.railCollapsed,
      previewMode: stage.previewMode,
      previewModeEffective: autoLite && autoLite.active ? 'card' : stage.previewMode,
      autoLite,
      perf: deps.perf ? deps.perf() : null,
      motion: deps.motion ? deps.motion() : null,
      companion: actions.companionSnapshot(),
      feedback: {
        flash: Object.keys(feedbackState.flash || {}),
        bubble: feedbackState.bubble,
        toast: feedbackState.toast,
        announcement: feedbackState.announcement,
      },
      rowsTotal: rowIds.length,
      rowsSample: rowSample,
      statuses: getStatus(),
      drag: deps.getDrag ? deps.getDrag() : null,
      dom: domStats(),
      logs: log.tail(80),
    }
  }

  const waitFor = (predicate, timeoutMs = 8000) =>
    new Promise((resolve, reject) => {
      const started = Date.now()
      const tick = () => {
        let value = false
        try {
          value = predicate()
        } catch (_error) {
          value = false
        }
        if (value) {
          resolve(value)
          return
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error('probe waitFor timeout'))
          return
        }
        setTimeout(tick, 60)
      }
      tick()
    })

  const api = {
    snapshot,
    /** P3-1 官方伴生浮窗原语探针桥（float-probe.js；非生产路径）。 */
    p3: deps.p3 || null,
    waitFor,
    listSessions: () => getRows(),
    currentSessionId: () => (deps.currentMainSessionId ? deps.currentMainSessionId() : null),
    dropSession: (sessionId, zone) => {
      actions.enterStageFromDrop(sessionId, zone)
      return snapshot()
    },
    motionState: () => (deps.motion ? deps.motion() : null),
    demoFeedback: (input) => {
      const options = input || {}
      if (options.flashSessionId) feedback.flash(options.flashSessionId)
      if (options.bubbleSessionId) feedback.setBubble(options.bubbleSessionId, options.kind || 'approval')
      return snapshot()
    },
    enterStage: async (sessionIds) => {
      const ids = Array.isArray(sessionIds) ? sessionIds.filter(Boolean) : []
      // 先加候场触发舞台挂载（挂载后才会有 onestep.focus 桥来上报主绑定）
      for (const id of ids) actions.addCandidate(id)
      await waitFor(() => stageControl.mounted === true, 12000)
      if (!focusSignal.getSnapshot() && ids.length > 0) {
        actions.focusSession(ids[0])
        await waitFor(() => !!focusSignal.getSnapshot(), 10000)
      }
      await new Promise((r) => setTimeout(r, 500))
      return snapshot()
    },
    exitStage: () => {
      actions.exitStage()
      return snapshot()
    },
    addCandidate: (sessionId) => {
      actions.addCandidate(sessionId)
      return snapshot()
    },
    removeCandidate: (sessionId) => {
      actions.closeCandidate(sessionId, 'probe')
      return snapshot()
    },
    promote: (sessionId) => {
      actions.promote(sessionId)
      return snapshot()
    },
    closeFocus: () => {
      actions.closeFocus()
      return snapshot()
    },
    focusSession: (sessionId) => {
      actions.focusSession(sessionId)
      return snapshot()
    },
    setPreviewMode: (mode) => {
      actions.setPreviewMode(mode)
      return snapshot()
    },
    /** 收起/展开候场栏（P2-3；手柄点击的 probe 等价路径）。 */
    /** P4 验证：picker 打开/关闭（G6 覆盖层动效需要产品态触发）。 */
    openPicker: () => actions.openPicker(),
    closePicker: () => actions.closePicker(),
    /** P4 验证：气泡出场（G5 需要产品态触发 clearBubble → data-leaving 动画）。 */
    clearBubble: (sessionId) => feedback.clearBubble(sessionId),
    /** P4-8：减少动效开关（e2e 用）。 */
    setReducedMotion: (value) => actions.setReducedMotion(value),
    setRailCollapsed: (collapsed) => {
      actions.setRailCollapsed(collapsed)
      return snapshot()
    },
    /** 0.7.0 验证：直接设置候场栏尺寸（自由宽度 e2e 用；生产路径是拖动分隔条）。 */
    setRailSize: (px) => {
      store.setRailSize(px)
      return snapshot()
    },
    toggleRailCollapsed: () => {
      actions.setRailCollapsed(!store.getSnapshot().railCollapsed)
      return snapshot()
    },
    /** P2-4 故障注入：指定下一次自动降级采样的性能值（e2e 用；生产路径不调用）。 */
    simulatePerf: (sample) => {
      actions.simulatePerfSample(sample)
      return snapshot()
    },
    /** 立即触发一次自动降级判定（使用当前/注入的采样值）。 */
    runAutoLiteSample: () => {
      actions.runAutoLiteSample()
      return snapshot()
    },
    toggleRightbar: () => {
      actions.toggleRightbar()
      return snapshot()
    },
    /** 伴生窗能力 + 跟随状态（P1-10）。 */
    companion: () => actions.companionSnapshot(),
    companionToggle: () => {
      actions.companionToggle()
      return snapshot()
    },
    companionEnsure: () => {
      actions.companionEnsure()
      return snapshot()
    },
    companionOpenTab: (sessionId, kind, options) => actions.companionOpenTab(sessionId, kind, options),
    companionOpenResource: (sessionId, address, options) => actions.companionOpenResource(sessionId, address, options),
    companionActive: () => actions.companionActive(),
    quickNew: async (text) => {
      await actions.quickNew(text)
      await new Promise((r) => setTimeout(r, 1200))
      return snapshot()
    },
    /** 仅唤起快速新建条（Alt+N 等价路径），不创建会话。 */
    requestQuickNew: () => {
      actions.requestQuickNew()
      return snapshot()
    },
    /** 键盘路径「回到焦点会话输入」（Ctrl+Alt+1 等价）。 */
    requestFocusInput: () => {
      actions.requestFocusInput()
      return snapshot()
    },
    /** 焦点在窗口间循环（Ctrl+Alt+←/→ 等价；direction=1 下一个 / -1 上一个）。 */
    cycleFocus: (direction) => {
      actions.cycleFocus(direction)
      return snapshot()
    },
    undo: () => {
      actions.undo()
      return snapshot()
    },
    layout: () => {
      const stage = document.querySelector('[data-onestep-stage]')
      const rects = {}
      if (stage) {
        const bounds = stage.getBoundingClientRect()
        rects.stage = { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height }
        const focus = stage.querySelector('[data-mode="focus"]')
        if (focus) {
          const r = focus.getBoundingClientRect()
          rects.focus = { x: r.x, y: r.y, w: r.width, h: r.height }
        }
        rects.candidates = Array.from(stage.querySelectorAll('[data-mode="candidate"]')).map((el) => {
          const r = el.getBoundingClientRect()
          return { x: r.x, y: r.y, w: r.width, h: r.height, sessionId: el.getAttribute('data-onestep-window-session') }
        })
      }
      return rects
    },
    setProbeFlag: (on) => {
      try {
        if (on) localStorage.setItem(PROBE_FLAG_KEY, '1')
        else localStorage.removeItem(PROBE_FLAG_KEY)
      } catch (_error) {
        /* storage 不可用时忽略 */
      }
      return true
    },
    flushPersist: () => store.flush(),
    boot: () => {
      const boot = window.__DSH_BOOT__
      const entry = boot && boot.entries ? boot.entries.find((item) => item.id === 'dsh-onestep') : null
      return { release: boot ? boot.release : null, entries: boot && boot.entries ? boot.entries.length : null, selfEntry: entry || null }
    },
  }

  function domStats() {
    const q = (selector) => document.querySelectorAll(selector).length
    return {
      stage: q('[data-onestep-stage]'),
      focusFrames: q('[data-onestep-stage] .onestep-frame[data-mode="focus"]'),
      candidateFrames: q('[data-onestep-stage] .onestep-frame[data-mode="candidate"]'),
      occurrences: q('[data-onestep-occurrence]'),
      inertBodies: q('.onestep-body[data-inert="1"]'),
      editableComposers: q('[contenteditable="true"]'),
      officialConversationOutsideStage: Array.from(document.querySelectorAll('[data-conversation-content]')).filter((el) => !el.closest('[data-onestep-stage]')).length,
      officialConversationInsideStage: Array.from(document.querySelectorAll('[data-conversation-content]')).filter((el) => el.closest('[data-onestep-stage]')).length,
      chromeFrames: q('.onestep-frame'),
      quickBars: q('.onestep-quick'),
      probePanels: q('.onestep-probe'),
    }
  }

  /** 可选探针面板（localStorage flag 打开；默认不渲染）。 */
  function ProbePanel() {
    const [tick, setTick] = React.useState(0)
    const data = snapshot()
    React.useEffect(() => {
      const timer = setInterval(() => setTick((value) => value + 1), 1000)
      return () => clearInterval(timer)
    }, [])
    return h(
      'div',
      { className: 'onestep-probe', 'data-tick': String(tick) },
      h('div', { style: { fontWeight: 600, marginBottom: 6 } }, 'onestep P1 ' + version),
      h('div', { className: 'onestep-probe-row' }, h('span', null, 'mounted'), h('span', null, String(data.mounted) + ' / mainReady=' + String(data.mainReady))),
      h('div', { className: 'onestep-probe-row' }, h('span', null, 'focus'), h('span', null, String(data.focusId || 'none').slice(0, 18))),
      h('div', { className: 'onestep-probe-row' }, h('span', null, 'candidates'), h('span', null, String(data.candidates.length))),
      h('div', { className: 'onestep-probe-row' }, h('span', null, 'preview'), h('span', null, data.previewMode + ' / ' + data.railSide)),
      h('div', { className: 'onestep-probe-row' }, h('span', null, 'dom'), h('span', null, JSON.stringify(data.dom))),
      h('div', { className: 'onestep-probe-row' }, h('span', null, 'flash/bubble'), h('span', null, data.feedback.flash.length + ' / ' + (data.feedback.bubble ? data.feedback.bubble.kind : 'none'))),
      h('div', { style: { marginTop: 6 } },
        h('button', { className: 'onestep-probe-btn', onClick: () => api.exitStage() }, 'exit'),
        h('button', { className: 'onestep-probe-btn', onClick: () => { console.log('[onestep] DUMP ' + JSON.stringify(snapshot())) } }, 'dump'),
      ),
      h('div', { style: { marginTop: 6, whiteSpace: 'pre-wrap', fontSize: 11, opacity: 0.85 } },
        (data.logs || []).slice(-6).map((item, index) => h('div', { key: String(index) + item.t }, new Date(item.t).toISOString().slice(11, 23) + ' ' + item.event + ' ' + JSON.stringify(item.data))),
      ),
    )
  }

  const probeFlagOn = (() => {
    try {
      return localStorage.getItem(PROBE_FLAG_KEY) === '1'
    } catch (_error) {
      return false
    }
  })()

  return { version, api, ProbePanel: probeFlagOn ? ProbePanel : null }
}

/** 环形事件日志（探针 + console 双通道）。 */
export function createLogger(limit = 200) {
  const events = []
  return {
    log(event, data) {
      const entry = { t: Date.now(), event: String(event), data: data === undefined ? null : data }
      events.push(entry)
      if (events.length > limit) events.shift()
      try {
        console.log('[onestep] ' + JSON.stringify(entry))
      } catch (_error) {
        /* best effort */
      }
      return entry
    },
    tail(count) {
      return events.slice(-Math.max(1, count || 20))
    },
    all: () => events.slice(),
  }
}
