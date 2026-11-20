/**
 * StageRoot：注册在 main keyed 'conversation'（priority:-1）的舞台根组件。
 *
 * 结构（开发文档 §5/§6）：
 *   root 作用域组件（无 session 座位）→ 自声明 onestep.focus（session-maybe 桥）+ onestep.window（session）
 *   焦点窗 = 当前主绑定（桥上报）；候场窗 = StageStore candidates；每个窗口 = SessionProvider(插件 retain 引用) + renderSlot。
 *   候场窗 live 档：官方会话内容的静态快照（渲染一次后克隆，仅状态变化时重拍）+ inert；card 档：状态卡。
 *
 * P1 review 修复（对应 issue：舞台覆盖官方左栏 / 候场卡与设计稿不符 / 关闭钮位置与显隐）：
 *   1) .onestep-stage 不再是 absolute:inset 0（会逃逸到 position:relative 的 AppFrame，覆盖 280px 官方左栏），
 *      改为按「main 列宿主矩形」定位的 fixed 容器；
 *   2) 候场窗收敛为设计稿卡片形态（固定高度、整卡可点提升、右下控制点）；
 *   3) 关闭控制点改为右下角 12px 圆点/24px 命中区：候场整窗 hover、焦点只在右下 88×88 触发角且带 120ms 延迟。
 */
import { React, h } from './h.js'
import { LIMITS, SESSION_FIELDS, SLOTS, statusOf } from './adapter.js'
import { layoutUsable, preferredRailSide, solve } from './layout.js'
import { effectivePreviewMode } from './store.js'
import { WindowErrorBoundary } from './content.js'
import { classifyStatus, formatRelative } from './status.js'
import { interpolate } from './locale.js'
import { MOTION, windowName } from './motion.js'
import { createCaptureScheduler, createPreviewCache, fitSnapshot, previewStatusKey, recaptureDelayMs } from './preview-cache.js'

const useStoreSnapshot = (observable) => React.useSyncExternalStore(observable.subscribe, observable.getSnapshot, observable.getSnapshot)

/** 空信号兜底：StageRoot 在无注入（组件测试/降级）时也能安全订阅。 */
const EMPTY_SIGNAL = { getSnapshot: () => null, subscribe: () => () => {} }

/**
 * 窗口内容（官方 occurrence）子组件：React.memo 隔离。
 * 拖拽候场栏/布局重算只改窗口外壳几何（transform/宽高），官方内容子树不应重复 reconcile；
 * 提升/换绑焦点时 sessionId/reference 变化才会重渲染（窗口 key 稳定、内容不重挂载）。
 */
const WindowSlotContent = React.memo(function WindowSlotContent(props) {
  const { SessionProvider, renderSlot, sessionId, reference, interactive, onWindowError, t } = props
  return h(
    SessionProvider,
    { session: reference },
    h(
      WindowErrorBoundary,
      { sessionId, onError: onWindowError, label: t('error.windowRender') },
      renderSlot(SLOTS.window, { ownerSessionId: sessionId, interactive: !!interactive }),
    ),
  )
})


/** 单张候场卡快照落位后的最短静置帧数（等官方虚拟列表/ResizeObserver 稳定再克隆）。 */
const SNAPSHOT_SETTLE_FRAMES = 2
/** 内容尺寸就绪后再等一小段，等会话数据（标题/历史）落定，避免把空白壳拍进快照。 */
const SNAPSHOT_SETTLE_MS = 220
/** 快照抓取超时：官方内容迟迟没有尺寸时不再等待，保留精简卡。 */
const SNAPSHOT_TIMEOUT_MS = 2600
/**
 * F1（换焦继承快照）体积上限（HTML 字符数）：焦点窗比候场抓取宿主（560–720 逻辑宽）大，
 * 直接继承的 HTML 可能更大；超过上限时返回 false 走旧的「换焦后重新抓拍」路径，
 * 避免把超大快照灌进缓存并放大注入（解析+布局）成本。取值约等于 e2e 实测最大快照的 1.4 倍。
 */
const MAX_INHERIT_SNAPSHOT_CHARS = 2400000
const rafOnce = (callback) =>
  typeof window !== 'undefined' && window.requestAnimationFrame ? window.requestAnimationFrame(callback) : setTimeout(callback, 16)

/**
 * 候场卡静态快照（0.7.0 用户要求：完整后场缩略改为静态、只在状态变化时更新）。
 *
 * 生命周期：
 *   - 有快照 → 直接渲染静态 HTML（缩放展示，像图片一样随卡片尺寸缩放，不重排）；
 *   - 无快照 / 状态签名过期 → 显示旧快照（若有）或精简卡，并把「拍快照」任务交给
 *     Controller 的串行空闲调度器（一次只挂载一张官方内容，避免长任务叠加）；
 *   - 拍快照：隐藏宿主里挂载官方 occurrence → 等 [data-conversation-content] 有尺寸 →
 *     再等两帧 → 克隆 innerHTML 进缓存 → 立刻卸载隐藏 occurrence。
 * 卡片本身不再持有 live occurrence 订阅，滚动/拖宽/换焦时不会触发官方内容反复挂载。
 */
function CandidatePreview(props) {
  const { sessionId, reference, statusKey, width, height, boxWidth, boxHeight, SessionProvider, renderSlot, onWindowError, t, cache, scheduler, deferred, onCaptured, placeholder } = props
  const [capturing, setCapturing] = React.useState(false)
  const sourceRef = React.useRef(null)
  const latest = cache.latest(sessionId)
  const current = !!(latest && latest.key === statusKey)
  /** F4：本次抓取持有的调度器 job token；只有真正结束/取消时释放（见 releaseJob）。 */
  const captureJobRef = React.useRef(null)
  /** capturing 的同步镜像：effect 清理阶段要读到最新值（清理时 state 仍是上次渲染的快照）。 */
  const capturingRef = React.useRef(false)
  capturingRef.current = capturing

  /** F4：释放调度器槽位；只对自己持有的 job 调 done(job)，拿旧 token/重复调用不会误释放。 */
  const releaseJob = () => {
    const job = captureJobRef.current
    if (!job) return
    captureJobRef.current = null
    scheduler.done(job)
  }

  // 状态签名变化 / 无快照时，排队拍快照（deferred 期间先显示已有快照或精简卡）。
  // F4：首次抓取（无快照）立即入队；已有快照的重拍先防抖 500ms，且同会话距上次成功抓拍 <2500ms 时延后。
  React.useEffect(() => {
    if (deferred || current) return undefined
    if (capturingRef.current || captureJobRef.current) return undefined
    const snapshot = cache.latest(sessionId)
    const delayMs = snapshot ? recaptureDelayMs(snapshot.at) : 0
    let timer = null
    const start = () => {
      timer = null
      if (capturingRef.current || captureJobRef.current) return
      const job = {
        run: () => {
          job.started = true
          setCapturing(true)
        },
      }
      captureJobRef.current = job
      scheduler.push(job)
    }
    if (delayMs <= 0) start()
    else timer = setTimeout(start, delayMs)
    return () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      const job = captureJobRef.current
      // 只回收「尚未开始执行」的排队任务；已开始的由 finish() 或卸载路径释放（F4）。
      if (job && !job.started) {
        captureJobRef.current = null
        scheduler.remove(job)
      }
    }
  }, [deferred, current, statusKey, sessionId, scheduler, cache])

  // 抓取阶段：等官方内容首帧有尺寸后克隆为静态 HTML，随后卸载隐藏 occurrence。
  React.useEffect(() => {
    if (!capturing) return undefined
    const host = sourceRef.current
    if (!host) {
      // 宿主意外缺失（正常路径在提交后必定存在）：结束本次抓取，避免调度器槽位悬挂。
      releaseJob()
      setCapturing(false)
      return undefined
    }
    let cancelled = false
    const startedAt = Date.now()
    let settleTimer = null
    const finish = () => {
      if (cancelled) return
      cancelled = true
      let html = ''
      try {
        html = host.innerHTML
      } catch (_error) {
        html = ''
      }
      if (html) {
        cache.set(sessionId, statusKey, html, width, height)
        if (onCaptured) onCaptured()
      }
      // F4：抓取正常结束才释放调度器槽位（token 校验，重复调用安全）。
      releaseJob()
      setCapturing(false)
    }
    const tick = () => {
      if (cancelled) return
      const content = host.querySelector('[data-conversation-content]')
      const rect = content ? content.getBoundingClientRect() : null
      if (rect && rect.width > 2 && rect.height > 2) {
        // 先等两帧（虚拟列表首帧），再等 mark 稳定：官方内容会在挂载后继续补历史/标题，
        // 过快克隆会拍到空白壳，导致状态未变却出现「先空后满」的重拍。
        let frames = 0
        let lastLength = -1
        const settle = () => {
          if (cancelled) return
          if (Date.now() - startedAt > SNAPSHOT_TIMEOUT_MS) {
            finish()
            return
          }
          if (frames < SNAPSHOT_SETTLE_FRAMES) {
            frames += 1
            rafOnce(settle)
            return
          }
          let length = 0
          try {
            length = host.innerHTML.length
          } catch (_error) {
            length = 0
          }
          if (length > 0 && length === lastLength) {
            finish()
            return
          }
          lastLength = length
          settleTimer = setTimeout(settle, SNAPSHOT_SETTLE_MS)
        }
        settle()
        return
      }
      if (Date.now() - startedAt > SNAPSHOT_TIMEOUT_MS) {
        finish()
        return
      }
      rafOnce(tick)
    }
    rafOnce(tick)
    return () => {
      cancelled = true
      if (settleTimer !== null) clearTimeout(settleTimer)
      // F4：这里不再无条件 scheduler.done()。抓取中 statusKey 变化会「取消旧判定 → 立即重跑同一次抓取」，
      // 此时 job 仍归本组件所有；真正的结束由 finish() 释放、卸载由下方 unmount effect 释放。
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, sessionId, statusKey])

  // F4：卸载时释放仍在占用调度器的抓取任务（避免调度器永久卡住）。
  React.useEffect(() => () => {
    releaseJob()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // F1：deferred（刚降级）期间只渲染精简卡——继承来的快照不在这 320ms 内注入（解析+布局约 40–100ms），
  // 避免把注入成本压进换焦提交/VT 更新回调；延后到 deferred 解除后再显示。
  const snapshot = deferred ? null : cache.latest(sessionId)
  const snapshotEl = snapshot
    ? (() => {
        // 整张快照按 contain 缩放进卡片内容区：永远完整可见，比例不一致时居中留白。
        const fit = fitSnapshot(boxWidth, boxHeight, snapshot.width, snapshot.height)
        return h(
          'div',
          { className: 'onestep-thumb', 'data-onestep-snapshot': '1', 'aria-hidden': 'true' },
          h('div', {
            className: 'onestep-thumb-content',
            style: {
              left: fit.left,
              top: fit.top,
              width: snapshot.width,
              height: snapshot.height,
              transform: 'scale(' + fit.scale + ')',
              transformOrigin: 'top left',
            },
            dangerouslySetInnerHTML: { __html: snapshot.html },
          }),
        )
      })()
    : null
  const sourceEl = capturing
    ? h(
        'div',
        {
          className: 'onestep-thumb',
          'data-onestep-snapshot-source': '1',
          'aria-hidden': 'true',
          style: { visibility: 'hidden', pointerEvents: 'none' },
        },
        h(
          'div',
          { ref: sourceRef, className: 'onestep-thumb-content', style: { width, height } },
          h(WindowSlotContent, {
            SessionProvider,
            renderSlot,
            sessionId,
            reference,
            interactive: false,
            onWindowError,
            t,
          }),
        ),
      )
    : null

  if (!snapshotEl && !sourceEl) return placeholder
  return h(React.Fragment, null, snapshotEl, sourceEl)
}

/** 完成未读闪烁的高亮窗口（P4-5：动画 2×600ms + 200ms 余量；feedback 层到点自动清）。 */
const FLASH_MS = MOTION.flashHold

/** 焦点窗右下角关闭控制点的触发角 / 显示 / 隐藏时序（产品报告 §7.7）。 */
const FOCUS_CLOSE_CORNER = LIMITS.focusCloseCorner
const FOCUS_CLOSE_SHOW_MS = 120
const FOCUS_CLOSE_HIDE_MS = 300

/**
 * 找到舞台应当占据的宿主矩形：StageRoot 被 slot 渲染器放进 main 列，
 * 祖先里常有 display:contents 包装层（rect 为 0），继续上溯到第一个真实盒子。
 * @param {HTMLElement} element 舞台根元素
 * @returns {{left:number,top:number,width:number,height:number}|null}
 */
function measureHostRect(element) {
  let node = element ? element.parentElement : null
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node)
    const rect = node.getBoundingClientRect()
    if (style.display !== 'contents' && rect.width > 0 && rect.height > 0) {
      return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
    }
    node = node.parentElement
  }
  return null
}

/**
 * @param {object} props 注入面（见 index.js 的 main 注册 inject）
 */
export function StageRoot(props) {
  const { t, store, feedback, focusSignal, getReference, hasReference } = props
  const stage = useStoreSnapshot(store)
  const feedbackState = useStoreSnapshot(feedback)
  const focusId = useStoreSnapshot(focusSignal)
  // 0.6.1：点击换焦的占位内容（真实官方聊天体在 VT 动画期间才挂载）。
  const focusPreviewId = useStoreSnapshot(props.focusPreviewSignal || EMPTY_SIGNAL)
  // P2-3：自动降级运行时状态（由 index.js 采样判定；只覆盖渲染，不改 store.previewMode）。
  const autoLiteState = useStoreSnapshot(props.autoLiteSignal || EMPTY_SIGNAL)
  const autoLiteActive = !!(autoLiteState && autoLiteState.active)
  // P3-4：伴生窗形态（float/split），决定「…」菜单项文案与切换方向。
  const companionModeState = useStoreSnapshot(props.companionModeSignal || EMPTY_SIGNAL)
  const companionMode = companionModeState === 'split' ? 'split' : 'float'
  // P3-12：已收回右栏的伴生窗数量（>0 时菜单提供「转回浮窗」）。
  const companionDockedState = useStoreSnapshot(props.companionDockedSignal || EMPTY_SIGNAL)
  const companionDocked = Number(companionDockedState) || 0
  const previewMode = effectivePreviewMode(stage, autoLiteActive)
  const dragState = props.dragSignal ? useStoreSnapshot(props.dragSignal) : { active: false, over: null }
  const dragActive = !!dragState.active
  const dragOver = dragState.over || null
  const lastDragEndAt = React.useRef(0)
  const prevDragActive = React.useRef(false)
  React.useEffect(() => {
    if (prevDragActive.current && !dragActive) lastDragEndAt.current = Date.now()
    prevDragActive.current = dragActive
  }, [dragActive])
  const dragSuppressed = () => dragActive || Date.now() - lastDragEndAt.current < 350
  const rows = props.useSessions((state) => state.byId)
  const statusMap = props.useSessionStatus((state) => state)
  // F1：captureFocusSnapshot 读取「最近一次提交」的目录/状态（只写 ref，不触发渲染；避免把桥函数绑到这两张大表上）。
  const rowsRef = React.useRef(rows)
  const statusMapRef = React.useRef(statusMap)
  rowsRef.current = rows
  statusMapRef.current = statusMap
  // 快速新建条的工作区 chip（产品报告 §7.8）；root 作用域提供 useWorkspaces，缺失时退化为纯文案。
  const workspaces = props.useWorkspaces ? props.useWorkspaces((state) => state.items) : null

  const containerRef = React.useRef(null)
  const [size, setSize] = React.useState({ width: 0, height: 0 })
  const [hostBox, setHostBox] = React.useState(null)
  const [dropTarget, setDropTarget] = React.useState(null)
  const [quick, setQuick] = React.useState({ open: false, text: '', pending: false, error: null })
  const [quickWorkspaceId, setQuickWorkspaceId] = React.useState(null)
  const [quickWorkspaceMenu, setQuickWorkspaceMenu] = React.useState(false)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const menuWrapRef = React.useRef(null)
  const quickWorkspaceRef = React.useRef(null)
  const [focusCloseVisible, setFocusCloseVisible] = React.useState(false)
  const quickTimer = React.useRef(null)
  const quickHideTimer = React.useRef(null)
  const quickInputRef = React.useRef(null)
  const quickBarRef = React.useRef(null)
  const focusCloseTimer = React.useRef(null)
  const focusFrameRef = React.useRef(null)
  /** 键盘路径的焦点转移：焦点切换后把 DOM 焦点移到新焦点窗 composer。 */
  const pendingComposerFocus = React.useRef(false)
  const splitDrag = React.useRef(null)
  const narrowRef = React.useRef(false)
  // 0.7.0：候场卡静态快照缓存 + 串行空闲调度（只在状态签名变化时重拍，见 preview-cache.js）。
  const previewCacheRef = React.useRef(null)
  if (!previewCacheRef.current) previewCacheRef.current = createPreviewCache({ max: 24 })
  const captureSchedulerRef = React.useRef(null)
  if (!captureSchedulerRef.current) captureSchedulerRef.current = createCaptureScheduler({ gapMs: 140 })
  const [, setPreviewVersion] = React.useState(0)
  React.useEffect(
    () => () => {
      try {
        captureSchedulerRef.current.dispose()
      } catch (_error) {
        /* ignore */
      }
      previewCacheRef.current.clear()
    },
    [],
  )
  /**
   * F1（换焦继承快照）：把「即将失去焦点」的焦点窗内容同步序列化进快照缓存。
   * 由 index.js 的 applyFocusReport 在改焦点状态之前调用——此时焦点窗 DOM 仍是旧会话、
   * 且已挂载真实官方内容，序列化一次（~4–10ms）即可省掉换焦后为「被降级会话」再隐藏挂载一次官方内容（0.15–0.4s）。
   * 失败返回 false，调用方保持旧行为（换焦后由 CandidatePreview 重新抓拍）。
   * @param {string} sessionId 即将降级的焦点会话
   * @returns {boolean} 是否写入快照缓存
   */
  const captureFocusSnapshot = React.useCallback((sessionId) => {
    const id = sessionId === undefined || sessionId === null ? '' : String(sessionId)
    if (!id) return false
    try {
      const stageElement = containerRef.current
      if (!stageElement || typeof stageElement.querySelector !== 'function') return false
      const frame = stageElement.querySelector('.onestep-frame[data-mode="focus"]')
      if (!frame) return false
      const frameSessionId = frame.getAttribute('data-onestep-window-session')
      if (frameSessionId && frameSessionId !== id) return false
      const body = frame.querySelector('.onestep-body')
      if (!body) return false
      // 占位内容（0.6.1 慢速点击路径的骨架）不能当快照；没有真实 occurrence 的窗口也不拍。
      if (body.querySelector('[data-onestep-focus-preview]')) return false
      if (!body.querySelector('[data-onestep-occurrence]')) return false
      const width = Math.max(0, Math.round(body.clientWidth))
      const height = Math.max(0, Math.round(body.clientHeight))
      if (width < 3 || height < 3) return false
      let html = ''
      try {
        html = body.innerHTML
      } catch (_error) {
        return false
      }
      if (!html || html.length > MAX_INHERIT_SNAPSHOT_CHARS) return false
      const row = rowsRef.current ? rowsRef.current[id] : null
      const key = previewStatusKey(row, statusOf(statusMapRef.current, id))
      previewCacheRef.current.set(id, key, html, width, height)
      return true
    } catch (_error) {
      return false
    }
  }, [])

  React.useEffect(() => {
    const bridge = props.previewBridge
    if (!bridge) return undefined
    bridge.capture = captureFocusSnapshot
    return () => {
      if (bridge.capture === captureFocusSnapshot) bridge.capture = null
    }
  }, [props.previewBridge, captureFocusSnapshot])
  const quickTick = props.quickSignal ? useStoreSnapshot(props.quickSignal) : 0
  const focusInputTick = props.focusInputSignal ? useStoreSnapshot(props.focusInputSignal) : 0
  /**
   * P2-4 焦点切换优化：切换瞬间先把「刚被降级为候场」的窗口按 card 渲染，
   * 避免它挂载官方聊天体与焦点窗首帧抢主线程；焦点就绪（或 320ms 兜底）后再挂载 live 缩略。
   */
  const DEFERRED_LIVE_MS = 320
  const [deferredLiveIds, setDeferredLiveIds] = React.useState({})
  const previousFocusRef = React.useRef(null)
  const deferTimersRef = React.useRef({})
  const clearDeferredLive = React.useCallback((sessionId) => {
    setDeferredLiveIds((prev) => {
      if (!sessionId || !prev[sessionId]) return prev
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
  }, [])
  /**
   * P4 修复（用户反馈「焦点↔候场交换动画卡顿」）：降级候场卡的 live 缩略（挂载官方聊天体）是重活，
   * 若在 VT morph 期间挂载会造成 150-200ms 主线程长任务 → 动画中途冻结。
   * 有进行中的动效时延后到 settled 再挂载；无动效时立即（保持 P2-4 的原有快速恢复行为）。
   */
  const releaseDeferredLive = (sessionId) => {
    const run = () => clearDeferredLive(sessionId)
    if (props.afterMotion) props.afterMotion(run)
    else run()
  }
  React.useEffect(() => {
    const previous = previousFocusRef.current
    previousFocusRef.current = focusId || null
    if (!previous || !focusId || previous === focusId) return undefined
    setDeferredLiveIds((prev) => (prev[previous] ? prev : { ...prev, [previous]: Date.now() }))
    if (deferTimersRef.current[previous]) clearTimeout(deferTimersRef.current[previous])
    deferTimersRef.current[previous] = setTimeout(() => {
      delete deferTimersRef.current[previous]
      releaseDeferredLive(previous)
    }, DEFERRED_LIVE_MS)
    return undefined
  }, [focusId, clearDeferredLive])
  React.useEffect(
    () => () => {
      for (const timer of Object.values(deferTimersRef.current)) clearTimeout(timer)
      deferTimersRef.current = {}
    },
    [],
  )

  // 舞台根定位：fixed + main 列宿主矩形（不再 absolute:inset 0 覆盖官方左栏）。
  React.useLayoutEffect(() => {
    const element = containerRef.current
    if (!element) return undefined
    let host = element.parentElement
    while (host && host !== document.body) {
      const style = window.getComputedStyle(host)
      const rect = host.getBoundingClientRect()
      if (style.display !== 'contents' && rect.width > 0 && rect.height > 0) break
      host = host.parentElement
    }
    if (!host || host === document.body) {
      // 兜底：找不到宿主时按最近的可测祖先；仍找不到则保持隐藏，避免再次覆盖整页。
      return undefined
    }
    const measure = () => {
      const next = measureHostRect(element)
      if (!next) return
      setHostBox((prev) =>
        prev && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height ? prev : next,
      )
    }
    measure()
    let observer = null
    try {
      observer = new ResizeObserver(measure)
      observer.observe(host)
    } catch (_error) {
      observer = null
    }
    window.addEventListener('resize', measure)
    return () => {
      if (observer) observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  // 舞台自身尺寸（布局求解用）。
  React.useEffect(() => {
    const element = containerRef.current
    if (!element) return undefined
    const measure = () => {
      const rect = element.getBoundingClientRect()
      setSize({ width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) })
    }
    measure()
    let observer = null
    try {
      observer = new ResizeObserver(measure)
      observer.observe(element)
    } catch (_error) {
      observer = null
    }
    return () => {
      if (observer) observer.disconnect()
    }
  }, [hostBox])

  const candidates = (stage.candidates || []).filter((candidate) => candidate.sessionId !== focusId)
  const count = candidates.length
  const candidateIdKey = candidates.map((candidate) => candidate.sessionId).join('|')
  // 候场移除/换焦后释放对应快照，避免缓存无限增长；候场瞬时为空（换焦中间态）不清理，等下一次稳定列表。
  React.useEffect(() => {
    if (!candidateIdKey) return
    previewCacheRef.current.retain(candidateIdKey.split('|'))
  }, [candidateIdKey])
  /**
   * 伴生窗（官方右栏）展开时的几何策略：
   * 右栏 push 会压缩会话主区，若按 stageMinWidth 判定就会把舞台直接退出。
   * 这里检测到「右栏展开 + 主区 < stageMinWidth」时进入 compact 模式：
   * 阈值下探到 focusMinWidth（480），强制隐藏候场栏（单窗显示），舞台保持；右栏收起后自动恢复。
   */
  const rightbarExpanded = typeof props.isRightbarExpanded === 'function' ? !!props.isRightbarExpanded() : false
  const compact = rightbarExpanded && size.width > 0 && size.width < LIMITS.stageMinWidth
  const layout = solve({
    width: size.width,
    height: size.height,
    railSide: stage.railSide,
    railSize: stage.railSize,
    railCollapsed: stage.railCollapsed || compact,
    count,
    min: { stageW: compact ? LIMITS.focusMinWidth : LIMITS.stageMinWidth },
  })

  // 0.6.0：候场超过可视容量时固定卡尺寸 + 滚动（左栏纵向 / 顶部横向）。
  const railBox = layout.rail
  const railAxisX = stage.railSide === 'top'
  const railScrollMax = railBox
    ? Math.max(0, Math.round(railAxisX ? layout.contentW - railBox.w : layout.contentH - railBox.h))
    : 0
  const railScrollable = !!railBox && !!layout.scroll && railScrollMax > 0
  const [railScroll, setRailScroll] = React.useState(0)
  const railScrollRef = React.useRef(0)
  railScrollRef.current = railScroll
  const railScrollMaxRef = React.useRef(railScrollMax)
  railScrollMaxRef.current = railScrollMax
  const railViewRef = React.useRef(null)
  railViewRef.current = railBox ? { x: railBox.x, y: railBox.y, w: railBox.w, h: railBox.h } : null
  const railAxisXRef = React.useRef(railAxisX)
  railAxisXRef.current = railAxisX
  const railScrollableRef = React.useRef(railScrollable)
  railScrollableRef.current = railScrollable
  const clampRailScroll = (value) => Math.min(Math.max(0, value), railScrollMaxRef.current)
  const scrollRailBy = (direction) => {
    const view = railViewRef.current
    const span = view ? (railAxisXRef.current ? view.w : view.h) : 240
    const step = Math.max(96, Math.round(span * 0.8))
    setRailScroll((prev) => clampRailScroll(prev + direction * step))
  }
  React.useEffect(() => {
    setRailScroll((prev) => {
      const next = Math.min(Math.max(0, prev), railScrollMax)
      return next === prev ? prev : next
    })
  }, [railScrollMax, stage.railSide])
  // 滚轮滚动：仅在指针位于候场栏内且确有溢出时拦截（左右栏横/纵向）。
  React.useEffect(() => {
    if (!railScrollable) return undefined
    const element = containerRef.current
    if (!element) return undefined
    const onWheel = (event) => {
      const view = railViewRef.current
      if (!view) return
      const host = element.getBoundingClientRect()
      const x = event.clientX - host.left
      const y = event.clientY - host.top
      if (x < view.x || x > view.x + view.w || y < view.y || y > view.y + view.h) return
      const delta = railAxisXRef.current ? (event.deltaX || event.deltaY) : event.deltaY
      if (!delta) return
      event.preventDefault()
      setRailScroll((prev) => clampRailScroll(prev + delta))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [railScrollable])
  const railScrollX = railAxisX ? railScroll : 0
  const railScrollY = railAxisX ? 0 : railScroll
  /** 卡片在滚动视口内可见（用于 live 缩略的虚拟化：滚出视口的卡不挂官方聊天体）。 */
  const cardVisible = (rect) => {
    if (!railScrollable || !railBox) return true
    if (railAxisX) return rect.x - railScrollX < railBox.w && rect.x - railScrollX + rect.w > 0
    return rect.y - railScrollY < railBox.h && rect.y - railScrollY + rect.h > 0
  }

  // 容器过窄 → 退出舞台（避免 React render 阶段副作用，放 effect）。
  // 用 400ms 去抖：窗口/右栏拖拽过程中会出现瞬时 0 宽测量，不能把舞台误退出。
  const narrowTimer = React.useRef(null)
  const effectiveMinWidth = compact ? LIMITS.focusMinWidth : LIMITS.stageMinWidth
  // P2-3 缺陷修复：用户收起候场栏时 solve() 返回 degraded='rail-collapsed' + visibleCount=0，
  // 这是正常折叠态（焦点窗占满），不能按「单窗降级」触发 onNarrow 退出舞台。
  const railCollapsedByUser = !!stage.railCollapsed
  const tooNarrow =
    size.width > 0 &&
    (size.width < effectiveMinWidth || (!compact && !layoutUsable(layout, { count, collapsed: railCollapsedByUser })))
  React.useEffect(() => {
    if (tooNarrow) {
      if (!narrowTimer.current) {
        narrowTimer.current = setTimeout(() => {
          narrowTimer.current = null
          narrowRef.current = true
          props.onNarrow && props.onNarrow()
        }, 400)
      }
    } else {
      if (narrowTimer.current) {
        clearTimeout(narrowTimer.current)
        narrowTimer.current = null
      }
      narrowRef.current = false
    }
    return () => {
      if (narrowTimer.current) {
        clearTimeout(narrowTimer.current)
        narrowTimer.current = null
      }
    }
  }, [tooNarrow])

  // 自动切换候选栏方向（宽屏左侧；中宽顶部）；compact（右栏展开挤压）期间不切换，避免抖动。
  React.useEffect(() => {
    if (!size.width || compact) return
    const preferred = preferredRailSide(size.width)
    if (preferred && preferred !== stage.railSide) store.setRailSide(preferred)
  }, [size.width, stage.railSide])

  // 菜单可关闭：Esc + 点击外部（产品化细节）
  React.useEffect(() => {
    if (!menuOpen) return undefined
    const onPointer = (event) => {
      if (menuWrapRef.current && !menuWrapRef.current.contains(event.target)) setMenuOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [menuOpen])
  React.useEffect(() => {
    if (!quickWorkspaceMenu) return undefined
    const onPointer = (event) => {
      if (quickWorkspaceRef.current && !quickWorkspaceRef.current.contains(event.target)) setQuickWorkspaceMenu(false)
    }
    document.addEventListener('mousedown', onPointer, true)
    return () => document.removeEventListener('mousedown', onPointer, true)
  }, [quickWorkspaceMenu])

  // 待处理气泡 / 完成未读 aria-live 播报
  const announcedRef = React.useRef({ key: null })
  React.useEffect(() => {
    const bubble = feedbackState.bubble
    if (bubble && bubble.sessionId) {
      const key = 'pending:' + bubble.sessionId + ':' + bubble.kind
      if (announcedRef.current.key === key) return
      announcedRef.current.key = key
      const row = rows[bubble.sessionId]
      const title = SESSION_FIELDS.title(row) || t('window.unnamed')
      // 播报里的待处理类型必须是本地化文案，不能把原始 kind 枚举（approval/question/plan）直接暴露给用户。
      const kindKey = bubble.kind === 'question' ? 'card.pendingQuestion' : bubble.kind === 'plan' ? 'card.pendingPlan' : bubble.kind === 'approval' ? 'card.pendingApproval' : null
      feedback.announce(interpolate(t('a11y.candidatePending'), { title, kind: kindKey ? t(kindKey) : t('bubble.needsYou') }))
    }
  }, [feedbackState.bubble, rows])

  React.useEffect(() => {
    const flash = feedbackState.flash || {}
    for (const sessionId of Object.keys(flash)) {
      const startedAt = flash[sessionId]
      if (Date.now() - startedAt > FLASH_MS) {
        feedback.clearFlash(sessionId)
        continue
      }
      const key = 'unread:' + sessionId + ':' + startedAt
      if (announcedRef.current.key === key) continue
      announcedRef.current.key = key
      const row = rows[sessionId]
      const title = SESSION_FIELDS.title(row) || t('window.unnamed')
      feedback.announce(interpolate(t('a11y.candidateComplete'), { title }))
    }
  }, [feedbackState.flash, rows])

  // 清理旧 toast 的逻辑已移到全局 StageToast（shell.overlay），舞台卸载后仍能看到退出/过窄提示。

  // 卸载时清掉悬停/快捷键定时器
  React.useEffect(() => () => {
    if (quickTimer.current) clearTimeout(quickTimer.current)
    if (quickHideTimer.current) clearTimeout(quickHideTimer.current)
    if (focusCloseTimer.current) clearTimeout(focusCloseTimer.current)
  }, [])

  const focusRow = focusId ? rows[focusId] : null
  const focusStatus = focusId ? statusOf(statusMap, focusId) : null
  const focusTitle = SESSION_FIELDS.title(focusRow) || t('window.unnamed')
  const focusClassified = classifyStatus(focusStatus, focusRow)
  const focusWorkspace = React.useMemo(() => {
    if (!workspaces || !focusId) return null
    return workspaces.find((workspace) => (workspace.sessionIds || []).includes(focusId)) || null
  }, [workspaces, focusId])
  const quickWorkspace = (workspaces || []).find((workspace) => workspace.workspaceId === quickWorkspaceId) || focusWorkspace
  const workspaceLabel = (workspace) => (workspace && (workspace.title || workspace.name || workspace.path)) || t('quickNew.workspace')

  const openQuick = () => {
    if (quickTimer.current) {
      clearTimeout(quickTimer.current)
      quickTimer.current = null
    }
    if (quickHideTimer.current) {
      clearTimeout(quickHideTimer.current)
      quickHideTimer.current = null
    }
    setQuick((prev) => (prev.open ? prev : { ...prev, open: true }))
    if (typeof window !== 'undefined' && window.requestAnimationFrame) {
      window.requestAnimationFrame(() => {
        const input = quickInputRef.current
        if (input && typeof input.focus === 'function') input.focus()
      })
    }
  }
  const scheduleOpenQuick = () => {
    if (quick.open || quickTimer.current) return
    quickTimer.current = setTimeout(() => {
      quickTimer.current = null
      // hover 唤起只滑出、不抢官方 composer 的键盘焦点（Alt+N / ＋ 按钮才聚焦输入框）。
      setQuick((prev) => (prev.open ? prev : { ...prev, open: true }))
    }, 200)
  }
  const cancelQuickHide = () => {
    if (quickHideTimer.current) {
      clearTimeout(quickHideTimer.current)
      quickHideTimer.current = null
    }
  }
  /** 隐藏快速新建条：保留草稿（下次 hover/Alt+N 唤醒时原样显示），只清错误态。 */
  const hideQuick = () => {
    cancelQuickHide()
    setQuickWorkspaceMenu(false)
    setQuick((prev) => (prev.open ? { ...prev, open: false, pending: false, error: null } : prev))
    const active = typeof document !== 'undefined' ? document.activeElement : null
    if (active && active.classList && active.classList.contains('onestep-input') && typeof active.blur === 'function') active.blur()
  }
  const scheduleQuickHide = (delay = 400) => {
    if (!quick.open) return
    cancelQuickHide()
    quickHideTimer.current = setTimeout(() => {
      quickHideTimer.current = null
      hideQuick()
    }, delay)
  }
  const closeQuick = () => {
    if (quickTimer.current) {
      clearTimeout(quickTimer.current)
      quickTimer.current = null
    }
    cancelQuickHide()
    setQuickWorkspaceMenu(false)
    setQuick({ open: false, text: '', pending: false, error: null })
  }
  const submitQuick = async () => {
    if (quick.pending) return
    const text = quick.text.trim()
    if (!text) {
      setQuick((prev) => ({ ...prev, error: t('quickNew.empty') }))
      return
    }
    setQuick((prev) => ({ ...prev, pending: true, error: null }))
    try {
      await props.onQuickNew(text, quickWorkspace ? quickWorkspace.workspaceId : undefined)
      closeQuick()
    } catch (error) {
      setQuick((prev) => ({ ...prev, pending: false, error: t('quickNew.failed') }))
    }
  }

  // Alt+N / actions.requestQuickNew 的消费端（修复：quickSignal 之前无人订阅）。
  React.useEffect(() => {
    if (!quickTick) return undefined
    openQuick()
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickTick])

  /**
   * 焦点管理（产品报告 §10.2）：
   * - 键盘路径（提升/移出焦点/回到焦点输入）→ DOM 焦点移到新焦点窗 composer；
   * - 鼠标路径提升 → 只把焦点放到窗口容器，不抢输入（避免打断用户当前输入）；
   * - 舞台退出路径在 index.js 的 unmount 清理里把焦点还给官方会话 composer。
   */
  const focusFrameContainer = () => {
    const frame = focusFrameRef.current
    if (frame && typeof frame.focus === 'function') frame.focus()
  }
  /** 官方聊天体在新焦点窗内是异步挂载的：重试到可编辑区出现（约 1.6s）再聚焦。 */
  const focusComposerWithRetry = (attempt = 0) => {
    const frame = focusFrameRef.current
    const editable = frame && frame.querySelector('[contenteditable="true"], [role="textbox"]')
    if (editable && typeof editable.focus === 'function') {
      editable.focus()
      return
    }
    if (attempt < 20) setTimeout(() => focusComposerWithRetry(attempt + 1), 80)
  }
  const scheduleFocusComposer = () => {
    if (typeof window === 'undefined') return
    if (window.requestAnimationFrame) window.requestAnimationFrame(() => focusComposerWithRetry())
    else setTimeout(focusComposerWithRetry, 0)
  }
  const scheduleFocusFrame = () => {
    if (typeof window === 'undefined') return
    if (window.requestAnimationFrame) window.requestAnimationFrame(focusFrameContainer)
    else setTimeout(focusFrameContainer, 0)
  }
  /**
   * P2-4：轮询「焦点窗内官方内容首帧可见」后回调（stage-enter-ready / focus-switch-ready 打点用）。
   * 官方聊天体在新焦点窗内异步挂载，必须等 [data-conversation-content] 有真实尺寸才算换绑完成。
   */
  const waitFocusContent = (callback) => {
    let cancelled = false
    const raf =
      typeof window !== 'undefined' && window.requestAnimationFrame
        ? window.requestAnimationFrame.bind(window)
        : (fn) => setTimeout(fn, 16)
    const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
    const startedAt = clock()
    const tick = () => {
      if (cancelled) return
      const frame = focusFrameRef.current
      const content = frame ? frame.querySelector('[data-conversation-content]') : null
      if (content) {
        const rect = content.getBoundingClientRect()
        if (rect.width > 2 && rect.height > 2) {
          callback()
          return
        }
      }
      if (clock() - startedAt > 15000) {
        callback()
        return
      }
      raf(tick)
    }
    raf(tick)
    return () => {
      cancelled = true
    }
  }
  const stageReadyReported = React.useRef(false)
  const lastReadyFocus = React.useRef(null)
  React.useEffect(() => {
    if (!focusId) return undefined
    if (!stageReadyReported.current) {
      return waitFocusContent(() => {
        stageReadyReported.current = true
        lastReadyFocus.current = focusId
        if (props.onStageReady) props.onStageReady()
      })
    }
    if (lastReadyFocus.current === focusId) return undefined
    const previous = lastReadyFocus.current
    lastReadyFocus.current = focusId
    if (previous === null) return undefined
    return waitFocusContent(() => {
      // 焦点首帧已就绪：解除降级窗口的 card 占位；若 morph 仍在播，延后到动效结束后再付 live 缩略挂载成本。
      releaseDeferredLive(previous)
      if (props.onFocusSwitchContentReady) props.onFocusSwitchContentReady()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId])
  // Ctrl+Alt+1（回到焦点会话输入）：每次信号自增都聚焦 composer。
  React.useEffect(() => {
    if (!focusInputTick) return undefined
    scheduleFocusComposer()
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusInputTick])
  // 键盘路径提升/移出焦点 → 焦点切换提交后聚焦新焦点窗 composer。
  React.useEffect(() => {
    if (!pendingComposerFocus.current) return
    pendingComposerFocus.current = false
    scheduleFocusComposer()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId])

  // 快速新建条打开时：点击其它区域隐藏（保留草稿）。
  React.useEffect(() => {
    if (!quick.open) return undefined
    const onPointerDown = (event) => {
      const bar = quickBarRef.current
      if (bar && bar.contains(event.target)) {
        cancelQuickHide()
        return
      }
      hideQuick()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quick.open])

  // 焦点窗右下 88×88 触发角：进入 120ms 后显示，离开 300ms 后隐藏。
  const clearFocusCloseTimer = () => {
    if (focusCloseTimer.current) {
      clearTimeout(focusCloseTimer.current)
      focusCloseTimer.current = null
    }
  }
  const scheduleFocusClose = (visible) => {
    clearFocusCloseTimer()
    focusCloseTimer.current = setTimeout(() => {
      focusCloseTimer.current = null
      setFocusCloseVisible(visible)
    }, visible ? FOCUS_CLOSE_SHOW_MS : FOCUS_CLOSE_HIDE_MS)
  }
  const onFocusPointerMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const inCorner = event.clientX >= rect.right - FOCUS_CLOSE_CORNER && event.clientY >= rect.bottom - FOCUS_CLOSE_CORNER
    if (inCorner) {
      if (focusCloseVisible) {
        clearFocusCloseTimer()
        return
      }
      if (focusCloseTimer.current) return
      scheduleFocusClose(true)
    } else if (focusCloseVisible) {
      if (focusCloseTimer.current) return
      scheduleFocusClose(false)
    } else {
      clearFocusCloseTimer()
    }
  }
  const onFocusPointerLeave = () => {
    scheduleQuickHide(400)
    if (!focusCloseVisible) {
      clearFocusCloseTimer()
      return
    }
    if (focusCloseTimer.current) return
    scheduleFocusClose(false)
  }

  const onDrop = (zone) => (event) => {
    event.preventDefault()
    setDropTarget(null)
    const raw = event.dataTransfer ? event.dataTransfer.getData('text/plain') : ''
    if (raw && props.isSessionId && props.isSessionId(raw)) {
      props.onDropSession && props.onDropSession(raw, zone)
    }
  }
  const allowDrop = (zone) => (event) => {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    if (dropTarget !== zone) setDropTarget(zone)
  }

  // ---------- 候场栏 ↔ 焦点窗 比例拖拽（splitter） ----------
  /** 把本帧合并后的拖拽尺寸提交到 store（rAF 合并：pointermove 频率可高于帧率）。 */
  const applySplitDrag = () => {
    const drag = splitDrag.current
    if (!drag) return
    drag.raf = null
    if (drag.pendingPx === null) return
    const px = drag.pendingPx
    drag.pendingPx = null
    store.setRailSize(px)
  }
  const startSplitDrag = (event) => {
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch (_error) {
      /* ignore */
    }
    splitDrag.current = { pointerId: event.pointerId, pendingPx: null, raf: null }
  }
  const moveSplitDrag = (event) => {
    const drag = splitDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    const stageElement = containerRef.current
    if (!stageElement) return
    const rect = stageElement.getBoundingClientRect()
    drag.pendingPx = stage.railSide === 'top' ? Math.round(event.clientY - rect.top) : Math.round(event.clientX - rect.left - LIMITS.railInset)
    // P2-4：拖拽期间 pointermove 可能远高于帧率；用 rAF 合并为每帧一次 store 提交，
    // 避免整舞台反复 render 造成掉帧（产品报告 §11.4 规则 3「不逐帧 React setState」）。
    if (drag.raf == null) {
      const raf =
        typeof window !== 'undefined' && window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : (fn) => setTimeout(fn, 16)
      drag.raf = raf(applySplitDrag)
    }
  }
  const endSplitDrag = (event) => {
    const drag = splitDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    // 松手时补交最后一帧未提交的尺寸，保证落点精确。
    if (drag.raf != null) {
      if (typeof window !== 'undefined' && window.cancelAnimationFrame) window.cancelAnimationFrame(drag.raf)
      drag.raf = null
    }
    if (drag.pendingPx !== null) {
      const px = drag.pendingPx
      drag.pendingPx = null
      store.setRailSize(px)
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch (_error) {
      /* ignore */
    }
    splitDrag.current = null
  }
  // 0.7.0：候场栏取消最大尺寸限制；End 跳到「当前舞台尺寸下仍保证焦点窗最小尺寸」的最大值。
  const railMaxFit = (() => {
    if (!size.width || !size.height) return null
    const fit = stage.railSide === 'top'
      ? size.height - LIMITS.gap - LIMITS.focusMinHeight
      : size.width - LIMITS.railInset - LIMITS.gap - LIMITS.focusMinWidth
    const min = stage.railSide === 'top' ? LIMITS.railTop.min : LIMITS.railLeft.min
    return Math.max(min, Math.round(fit))
  })()
  const onSplitterKeyDown = (event) => {
    const railSide = stage.railSide === 'top' ? 'top' : 'left'
    const bounds = railSide === 'top' ? LIMITS.railTop : LIMITS.railLeft
    const step = event.shiftKey ? 24 : 8
    let next = null
    if (railSide === 'top') {
      if (event.key === 'ArrowUp') next = stage.railSize - step
      if (event.key === 'ArrowDown') next = stage.railSize + step
    } else {
      if (event.key === 'ArrowLeft') next = stage.railSize - step
      if (event.key === 'ArrowRight') next = stage.railSize + step
    }
    if (event.key === 'Home') next = bounds.min
    if (event.key === 'End') next = railMaxFit == null ? bounds.min : railMaxFit
    if (next === null) return
    event.preventDefault()
    store.setRailSize(next)
  }

  const collapsed = !!stage.railCollapsed
  const railRect = layout.rail
  const railStyle = railRect
    ? { left: railRect.x, top: railRect.y, width: railRect.w, height: railRect.h, flexDirection: stage.railSide === 'left' ? 'column' : 'row', padding: stage.railSide === 'left' ? '0 8px 0 0' : '0 0 8px 0', '--onestep-rail-vt-name': 'onestep-rail' }
    : null
  const railBounds = stage.railSide === 'top' ? LIMITS.railTop : LIMITS.railLeft
  const splitterStyle = railRect
    ? stage.railSide === 'top'
      ? { left: 0, top: railRect.y + railRect.h + (LIMITS.gap - LIMITS.splitterSize) / 2, width: '100%', height: LIMITS.splitterSize }
      : { left: railRect.x + railRect.w + (LIMITS.gap - LIMITS.splitterSize) / 2, top: 0, width: LIMITS.splitterSize, height: '100%' }
    : null

  /** 状态点：6px 视觉 / 12px 命中（产品报告 §9.2）；颜色 + 形状双编码，AT 读状态文案（§10.3/§10.4）。 */
  const renderStatusDot = (tone, label) =>
    h(
      'span',
      { className: 'onestep-dot-hit' },
      h('span', { className: 'onestep-dot', 'data-tone': tone, role: 'img', 'aria-label': label, title: label }),
    )

  /** 关闭控制点：12px 视觉圆点 / 24px 命中区（产品报告 §7.7）。 */
  const renderControl = (onClose, extra) => {
    const options = extra || {}
    return h(
      'button',
      {
        type: 'button',
        className: 'onestep-control onestep-close',
        'data-show': options.focus ? (focusCloseVisible ? '1' : '0') : undefined,
        title: t('window.close'),
        'aria-label': t('window.close'),
        onClick: (event) => {
          event.stopPropagation()
          if (dragSuppressed()) return
          if (options.focus) {
            setFocusCloseVisible(false)
            // 键盘激活（Enter/Space → detail=0）后焦点交给新焦点窗 composer；鼠标点击不抢输入。
            if (event.detail === 0) pendingComposerFocus.current = true
          }
          onClose()
        },
        onKeyDown: (event) => {
          // 避免候选卡外层的键位处理把控制点的键盘激活吃掉
          event.stopPropagation()
        },
      },
      h('span', { className: 'onestep-control-dot' }),
      h('span', { className: 'onestep-control-x' }, '×'),
    )
  }

  const renderCandidateBody = (candidate, rect, index, frame) => {
    const sessionId = candidate.sessionId
    const reference = getReference(sessionId)
    const row = rows[sessionId]
    const status = statusOf(statusMap, sessionId)
    // P2-3：live 档位取「用户偏好 + 自动降级」后的生效档位（自动降级只覆盖渲染）。
    // P2-4：焦点切换瞬间刚降级的窗口先按 card 渲染，避免与焦点窗首帧抢主线程。
    // 0.6.0：滚动出视口的卡片不挂 live（避免 12 个官方聊天体同时存在）。
    // 0.6.1：换焦的首次提交里，刚被降级的窗口同步按 card 渲染（不等 effect），
    // 否则会在同一次提交里再挂一份官方聊天体，把 VT 回调（点击慢速路径的占位提交）拖长。
    const freshlyDemoted = previousFocusRef.current && previousFocusRef.current !== focusId && previousFocusRef.current === sessionId
    // 0.7.0：live 档改为「静态快照」——卡片不挂 live occurrence，只在状态签名变化时重拍（见 CandidatePreview）。
    const previewLive = previewMode === 'live' && !!reference
    const flash = !!(feedbackState.flash && feedbackState.flash[sessionId] && Date.now() - feedbackState.flash[sessionId] < FLASH_MS)
    const classified = classifyStatus(status, row)
    const title = SESSION_FIELDS.title(row) || t('window.unnamed')
    const bubble = feedbackState.bubble && feedbackState.bubble.sessionId === sessionId ? feedbackState.bubble : null
    // 实时缩略：候选卡固定 √2:1；官方聊天体按逻辑宽度（≈560px）渲染后整体等比缩放，避免 232px 下重排崩坏。
    const candidateChromeH = 32
    // 静态快照按固定逻辑宽（560–720）渲染再缩放展示：视觉上像图片，卡片尺寸变化时不重排。
    const thumbW = Math.min(720, Math.max(560, Math.round(rect.w)))
    const thumbScale = rect.w / thumbW
    const thumbH = Math.max(1, Math.round(Math.max(1, rect.h - candidateChromeH) / thumbScale))
    const style = {
      left: frame && frame.absolute === false ? rect.x - (frame.scrollX || 0) : (railRect ? railRect.x : 0) + rect.x,
      top: frame && frame.absolute === false ? rect.y - (frame.scrollY || 0) : (railRect ? railRect.y : 0) + rect.y,
      width: rect.w,
      height: rect.h,
      pointerEvents: 'auto',
      // P4-3：同名（sessionId）元素跨快照配对，VT 才能把候场卡 morph 到焦点位。
      '--onestep-vt-name': windowName(sessionId) || 'none',
    }
    const cardBody = h(
      'div',
      { className: 'onestep-card-body' },
      h('div', null, row && !row.blank ? t('card.recent') + ' ' + formatRelative(SESSION_FIELDS.updatedAt(row)) : t('card.blank')),
      h('div', { className: 'onestep-card-meta' }, t('bubble.raise')),
    )
    return h(
      'div',
      {
        key: 'candidate-' + sessionId,
        className: 'onestep-frame',
        'data-mode': 'candidate',
        'data-preview': previewLive ? 'live' : 'card',
        'data-flash': flash ? '1' : '0',
        'data-pending': bubble ? '1' : '0',
        'data-onestep-window-session': sessionId,
        style,
        role: 'group',
        // 程序可聚焦（tabIndex=-1 不进 Tab 序列）：会话焦点/窗口容器归属用；键盘用户走 chrome 的按钮。
        tabIndex: -1,
        // 产品报告 §10.3：候场窗 = group +「候场会话 N：〈标题〉 · 〈状态〉」
        'aria-label': interpolate(t('a11y.candidateRegion'), { index: index + 1, title, status: t(classified.labelKey) }),
        onClick: (event) => {
          if (dragSuppressed()) return
          // 0.6.1：真实鼠标点击（detail>0）走慢速+占位内容路径；键盘激活（detail=0）保持 P4 的 220ms morph。
          props.onPromote(sessionId, { click: !!(event && event.detail > 0) })
          // 鼠标路径：焦点进入新焦点窗容器（不抢输入，报告 §10.2）。
          scheduleFocusFrame()
        },
        onKeyDown: (event) => {
          if (dragSuppressed()) return
          if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            pendingComposerFocus.current = true
            props.onPromote(sessionId)
            return
          }
          // 键盘移出：候场窗内容 inert，Delete/Backspace 在窗口内不会进入编辑语义。
          if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault()
            event.stopPropagation()
            props.onCloseCandidate(sessionId)
          }
        },
      },
      h(
        'div',
        { className: 'onestep-chrome', 'data-mode': 'candidate' },
        renderStatusDot(classified.tone, t(classified.labelKey)),
        // 键盘等价入口：标题即「提升为焦点」按钮（产品报告 §10.2「只保留窗口 chrome 的提升与移出按钮可聚焦」）。
        h(
          'button',
          {
            type: 'button',
            className: 'onestep-title onestep-title-btn',
            title: t('a11y.promote'),
            'aria-label': t('a11y.promote') + ' ' + title,
            onClick: (event) => {
              event.stopPropagation()
              if (event.detail === 0) pendingComposerFocus.current = true
              else scheduleFocusFrame()
              props.onPromote(sessionId, { click: !!(event && event.detail > 0) })
            },
          },
          title,
        ),
        h('span', { className: 'onestep-sub', 'aria-hidden': 'true' }, t(classified.labelKey)),
      ),
      h(
        'div',
        { className: 'onestep-body', 'data-inert': previewLive ? '1' : '0', inert: previewLive ? '' : undefined },
        previewLive
          ? h(CandidatePreview, {
              sessionId,
              reference,
              statusKey: previewStatusKey(row, status),
              width: thumbW,
              height: thumbH,
              // 卡片 1px 边框 + chrome 占位：快照只能放进真实内容盒（否则 contain 后会压边被 overflow 裁掉）。
              boxWidth: Math.max(1, rect.w - 2),
              boxHeight: Math.max(1, rect.h - 2 - candidateChromeH),
              SessionProvider: props.SessionProvider,
              renderSlot: props.renderSlot,
              onWindowError: props.onWindowError,
              t,
              cache: previewCacheRef.current,
              scheduler: captureSchedulerRef.current,
              deferred: !!deferredLiveIds[sessionId] || !!freshlyDemoted,
              onCaptured: () => setPreviewVersion((value) => value + 1),
              placeholder: cardBody,
            })
          : cardBody,
      ),
      bubble
        ? h('button', {
            type: 'button',
            className: 'onestep-bubble',
            'data-leaving': feedbackState.bubbleLeaving ? '1' : '0',
            onClick: (event) => {
              event.stopPropagation()
              if (event.detail === 0) pendingComposerFocus.current = true
              else scheduleFocusFrame()
              props.onPromote(sessionId, { click: !!(event && event.detail > 0) })
            },
            title: t('bubble.raise'),
          }, t('card.' + (bubble.kind === 'question' ? 'pendingQuestion' : bubble.kind === 'plan' ? 'pendingPlan' : 'pendingApproval')))
        : null,
      renderControl(() => props.onCloseCandidate(sessionId)),
    )
  }

  /**
   * 0.6.1：点击换焦的占位焦点内容。VT 首帧只提交它（轻量），真实官方聊天体在动画开始后挂载；
   * 这样动画能更早开始，且动画期间完成重挂载。样式保持静态（无循环动画，reduced 安全）。
   */
  const renderFocusPreview = (sessionId) => {
    const row = rows[sessionId]
    const status = statusOf(statusMap, sessionId)
    const classified = classifyStatus(status, row)
    const title = SESSION_FIELDS.title(row) || t('window.unnamed')
    return h(
      'div',
      { className: 'onestep-focus-preview', 'data-onestep-focus-preview': '1' },
      h(
        'div',
        { className: 'onestep-focus-preview-head' },
        renderStatusDot(classified.tone, t(classified.labelKey)),
        h('span', { className: 'onestep-focus-preview-title' }, title),
        h('span', { className: 'onestep-focus-preview-state' }, t(classified.labelKey)),
      ),
      h(
        'div',
        { className: 'onestep-focus-preview-body' },
        h('div', { className: 'onestep-focus-preview-line' }),
        h('div', { className: 'onestep-focus-preview-line' }),
        h('div', { className: 'onestep-focus-preview-line short' }),
      ),
    )
  }

  const quickBar = h(
    'div',
    { className: 'onestep-quick', 'data-open': quick.open ? '1' : '0', ref: quickBarRef },
    h(
      'div',
      { className: 'onestep-quick-inner', onMouseEnter: cancelQuickHide, onMouseLeave: () => scheduleQuickHide(400) },
      h(
        'div',
        { className: 'onestep-quick-workspace', ref: quickWorkspaceRef },
        h('button', {
          type: 'button',
          className: 'onestep-chip',
          title: t('quickNew.workspacePick'),
          'aria-label': t('quickNew.workspacePick'),
          'aria-expanded': quickWorkspaceMenu ? 'true' : 'false',
          disabled: !workspaces || workspaces.length === 0,
          onClick: (event) => {
            event.stopPropagation()
            setQuickWorkspaceMenu((value) => !value)
          },
        }, workspaceLabel(quickWorkspace)),
        quickWorkspaceMenu && workspaces && workspaces.length > 0
          ? h(
              'div',
              { className: 'onestep-quick-workspace-menu', role: 'menu' },
              workspaces.map((workspace) => h('button', {
                key: workspace.workspaceId || workspace.path || workspaceLabel(workspace),
                type: 'button',
                className: 'onestep-menu-item',
                role: 'menuitem',
                onClick: (event) => {
                  event.stopPropagation()
                  setQuickWorkspaceId(workspace.workspaceId || null)
                  setQuickWorkspaceMenu(false)
                },
              }, workspaceLabel(workspace))),
            )
          : null,
      ),
      h('input', {
        ref: quickInputRef,
        className: 'onestep-input',
        placeholder: t('quickNew.placeholder'),
        value: quick.text,
        disabled: quick.pending,
        onChange: (event) => setQuick((prev) => ({ ...prev, text: event.target.value, error: null })),
        onKeyDown: (event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submitQuick()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            // 产品报告 §7.8：空文本直接收起；非空第一次清空、第二次收起。
            if (quick.text) {
              setQuick((prev) => ({ ...prev, text: '', error: null }))
            } else {
              closeQuick()
            }
          }
        },
      }),
      h('button', { type: 'button', className: 'onestep-btn', disabled: quick.pending, onClick: submitQuick }, quick.pending ? t('quickNew.creating') : t('quickNew.create')),
      h('span', { className: 'onestep-quick-tip' }, t('quickNew.hint')),
      quick.error ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary,#ec1313)', fontSize: 12 } }, quick.error) : null,
    ),
    h('div', {
      className: 'onestep-quick-handle',
      onMouseEnter: () => {
        cancelQuickHide()
        scheduleOpenQuick()
      },
      onMouseLeave: () => scheduleQuickHide(400),
      onFocus: openQuick,
    }),
  )

  const stageStyle = hostBox && hostBox.width > 0
    ? { left: hostBox.left + 'px', top: hostBox.top + 'px', width: hostBox.width + 'px', height: hostBox.height + 'px' }
    : { left: 0, top: 0, width: '100%', height: '100%', visibility: 'hidden' }

  return h(
    'div',
    {
      className: 'onestep-stage',
      ref: containerRef,
      style: stageStyle,
      'data-onestep-stage': '1',
      // P4-4：宿主矩形测量完成后才播进场动画（避免在 0×0/隐藏态播放）。
      'data-ready': hostBox && hostBox.width > 0 ? '1' : '0',
      'data-rail-side': stage.railSide,
      'data-preview-mode': previewMode,
      'data-auto-lite': autoLiteActive ? '1' : '0',
      // 产品报告 §10.3：舞台容器 role=group。
      role: 'group',
      'aria-label': t('a11y.stage'),
    },
    h('div', {
      'aria-live': 'polite',
      style: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' },
    }, feedbackState.announcement ? feedbackState.announcement.text : ''),
    props.renderSlot(SLOTS.focus, {}),
    // 产品报告 §10.2：DOM/Tab 顺序 = 焦点窗 chrome → 焦点窗内容 → 候场 1..3。
    h(
      'div',
      {
        className: 'onestep-frame',
        'data-mode': 'focus',
        'data-onestep-window-session': focusId || '',
        ref: focusFrameRef,
        tabIndex: -1,
        'data-drop': dropTarget === 'focus' || dragOver === 'focus' ? '1' : '0',
        style: { left: layout.focus.x, top: layout.focus.y, width: layout.focus.w, height: layout.focus.h, '--onestep-vt-name': windowName(focusId) || 'none' },
        // 产品报告 §10.3：焦点窗 role=region，aria「焦点会话：〈标题〉」。
        role: 'region',
        'aria-label': interpolate(t('a11y.focusRegion'), { title: focusTitle }),
        onMouseMove: onFocusPointerMove,
        onMouseLeave: onFocusPointerLeave,
        onDragOver: allowDrop('focus'),
        onDragLeave: () => setDropTarget(null),
        onDrop: onDrop('focus'),
      },
      h(
        'div',
        { className: 'onestep-chrome' },
        renderStatusDot(focusClassified.tone, t(focusClassified.labelKey)),
        h('span', { className: 'onestep-title', title: focusTitle }, focusTitle),
        h('span', { className: 'onestep-sub', 'aria-hidden': 'true' }, t(focusClassified.labelKey)),
        h(
          'div',
          { className: 'onestep-chrome-actions' },
          h('button', {
            type: 'button',
            className: 'onestep-btn',
            'data-onestep-quick-open': '1',
            title: t('quickNew.create'),
            'aria-label': t('quickNew.create'),
            onClick: () => openQuick(),
          }, '＋'),
          h('button', {
            type: 'button',
            className: 'onestep-btn',
            'data-onestep-companion-toggle': '1',
            title: t('window.companion'),
            'aria-label': t('window.companion'),
            onClick: () => {
              if (props.onToggleCompanion) props.onToggleCompanion()
            },
          }, '⇥'),
          h(
            'div',
            { className: 'onestep-menu-wrap', ref: menuWrapRef },
            h('button', {
              type: 'button',
              className: 'onestep-btn',
              'data-onestep-more': '1',
              title: t('window.more'),
              'aria-label': t('window.more'),
              'aria-expanded': menuOpen ? 'true' : 'false',
              onClick: (event) => {
                event.stopPropagation()
                setMenuOpen((value) => !value)
              },
            }, '…'),
            menuOpen
              ? h(
                  'div',
                  { className: 'onestep-menu', role: 'menu' },
                  h('button', {
                    type: 'button',
                    className: 'onestep-menu-item',
                    role: 'menuitem',
                    onClick: () => {
                      setMenuOpen(false)
                      // 手动切档走 actions（标记本次舞台会话手动优先，不被自动降级覆盖）。
                      const nextMode = previewMode === 'live' ? 'card' : 'live'
                      if (props.onSetPreviewMode) props.onSetPreviewMode(nextMode)
                      else store.setPreviewMode(nextMode)
                    },
                  }, t(previewMode === 'live' ? 'window.previewCard' : 'window.previewLive')),
                  // P4-8：减少动效开关（跟随系统 / 减少动效；写持久化并同步 <html data-onestep-motion>）。
                  h('button', {
                    type: 'button',
                    className: 'onestep-menu-item',
                    role: 'menuitem',
                    'data-onestep-motion-toggle': '1',
                    'aria-label': t(stage.reducedMotion === 'always' ? 'window.motionSystem' : 'window.motionReduced'),
                    onClick: () => {
                      setMenuOpen(false)
                      const next = stage.reducedMotion === 'always' ? 'system' : 'always'
                      if (props.onSetReducedMotion) props.onSetReducedMotion(next)
                      else store.setReducedMotion(next)
                    },
                  }, t(stage.reducedMotion === 'always' ? 'window.motionSystem' : 'window.motionReduced')),
                  h('button', {
                    type: 'button',
                    className: 'onestep-menu-item',
                    role: 'menuitem',
                    'data-onestep-companion-mode': companionMode,
                    onClick: () => {
                      setMenuOpen(false)
                      if (props.onSetCompanionMode) props.onSetCompanionMode(companionMode === 'float' ? 'split' : 'float')
                    },
                  }, t(companionMode === 'float' ? 'window.companionToSplit' : 'window.companionToFloat')),
                  companionDocked > 0
                    ? h('button', {
                        type: 'button',
                        className: 'onestep-menu-item',
                        role: 'menuitem',
                        'data-onestep-companion-restore': '1',
                        onClick: () => {
                          setMenuOpen(false)
                          if (props.onRestoreDocked) props.onRestoreDocked()
                        },
                      }, t('window.companionRestoreDocked'))
                    : null,
                  h('button', {
                    type: 'button',
                    className: 'onestep-menu-item',
                    role: 'menuitem',
                    onClick: () => {
                      setMenuOpen(false)
                      if (props.onOpenRightbar) props.onOpenRightbar()
                    },
                  }, t('window.openRightbar')),
                  h('div', { className: 'onestep-menu-sep' }),
                  h('button', {
                    type: 'button',
                    className: 'onestep-menu-item',
                    role: 'menuitem',
                    onClick: () => {
                      setMenuOpen(false)
                      props.onExit()
                    },
                  }, t('stage.exit')),
                )
              : null,
          ),
        ),
      ),
      h(
        'div',
        { className: 'onestep-body' },
        focusId && hasReference(focusId)
          ? (focusPreviewId === focusId
            ? renderFocusPreview(focusId)
            : h(WindowSlotContent, {
                SessionProvider: props.SessionProvider,
                renderSlot: props.renderSlot,
                sessionId: focusId,
                reference: getReference(focusId),
                interactive: true,
                onWindowError: props.onWindowError,
                t,
              }))
          : h('div', { style: { padding: 16, color: 'var(--dsw-alias-label-secondary,#9aa4b2)' } }, t('stage.empty')),
      ),
      quickBar,
      renderControl(() => props.onCloseFocus(), { focus: true }),
    ),
    railRect
      ? h(
          'div',
          {
            className: 'onestep-stage-rail',
            style: railStyle,
            'data-onestep-rail': '1',
            // 收起态：抬到焦点窗之上，让 40px 边条 + 状态点可见（焦点窗此时占满舞台宽度）。
            'data-collapsed': stage.railCollapsed ? '1' : '0',
            'data-scroll': railScrollable ? '1' : '0',
            role: 'group',
            'aria-label': t(stage.railSide === 'top' ? 'rail.top' : 'rail.left'),
            'data-drop': dropTarget === 'rail' || dragOver === 'rail' ? '1' : '0',
            onDragOver: allowDrop('rail'),
            onDragLeave: () => setDropTarget(null),
            onDrop: onDrop('rail'),
          },
          count === 0
            ? h('div', { className: 'onestep-rail-empty', style: { position: 'absolute', inset: 0 } }, t('rail.empty'))
            : stage.railCollapsed
              ? h(
                  'div',
                  { className: 'onestep-rail-mini', 'data-onestep-rail-mini': '1' },
                  candidates.map((candidate, index) => {
                    const sessionId = candidate.sessionId
                    const status = statusOf(statusMap, sessionId)
                    const row = rows[sessionId]
                    const classified = classifyStatus(status, row)
                    const title = SESSION_FIELDS.title(row) || t('window.unnamed')
                    return h(
                      'div',
                      {
                        key: 'rail-mini-' + sessionId,
                        className: 'onestep-rail-mini-item',
                        title: title + ' · ' + t(classified.labelKey),
                      },
                      renderStatusDot(classified.tone, t(classified.labelKey)),
                      h('span', { className: 'onestep-rail-mini-index', 'aria-hidden': 'true' }, String(index + 1)),
                    )
                  }),
                )
              : null,
          // P2-3：候场栏收起/展开手柄（原生 button：键盘可达 + aria 状态；文案复用 locale rail.collapse/rail.expand）。
          h(
            'button',
            {
              type: 'button',
              className: 'onestep-rail-toggle',
              'data-onestep-rail-toggle': '1',
              'aria-label': t(stage.railCollapsed ? 'rail.expand' : 'rail.collapse'),
              'aria-expanded': stage.railCollapsed ? 'false' : 'true',
              title: t(stage.railCollapsed ? 'rail.expand' : 'rail.collapse'),
              onClick: (event) => {
                event.stopPropagation()
                if (dragSuppressed()) return
                const nextCollapsed = !store.getSnapshot().railCollapsed
                if (props.onSetRailCollapsed) props.onSetRailCollapsed(nextCollapsed)
                else store.setRailCollapsed(nextCollapsed)
              },
              onKeyDown: (event) => event.stopPropagation(),
            },
            stage.railCollapsed ? '‹' : '›',
          ),
        )
      : null,
    railScrollable
      ? h(
          'div',
          {
            className: 'onestep-rail-viewport',
            'data-onestep-rail-scroll': '1',
            style: {
              position: 'absolute',
              left: railRect.x,
              top: railRect.y,
              width: railRect.w,
              height: railRect.h,
              overflow: 'hidden',
              pointerEvents: 'none',
              zIndex: 1,
            },
          },
          candidates.map((candidate, index) => {
            const rect = layout.cards[index]
            return rect
              ? renderCandidateBody(candidate, rect, index, { absolute: false, scrollX: railScrollX, scrollY: railScrollY, visible: cardVisible(rect) })
              : null
          }),
        )
      : candidates.map((candidate, index) => {
          const rect = layout.cards[index]
          return rect ? renderCandidateBody(candidate, rect, index, { absolute: true, scrollX: 0, scrollY: 0, visible: true }) : null
        }),
    railScrollable && !stage.railCollapsed
      ? h(
          'div',
          {
            className: 'onestep-rail-scroll-controls',
            'data-onestep-rail-scroll-controls': '1',
            style: {
              position: 'absolute',
              left: railRect.x + railRect.w / 2 - 26,
              top: railRect.y + railRect.h - 32,
              display: 'flex',
              gap: 4,
              zIndex: 5,
            },
          },
          h(
            'button',
            {
              type: 'button',
              className: 'onestep-rail-scroll-btn',
              'data-dir': 'prev',
              title: t('rail.scrollPrev'),
              'aria-label': t('rail.scrollPrev'),
              onClick: (event) => {
                event.stopPropagation()
                scrollRailBy(-1)
              },
              onKeyDown: (event) => event.stopPropagation(),
            },
            railAxisX ? '‹' : '▲',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'onestep-rail-scroll-btn',
              'data-dir': 'next',
              title: t('rail.scrollNext'),
              'aria-label': t('rail.scrollNext'),
              onClick: (event) => {
                event.stopPropagation()
                scrollRailBy(1)
              },
              onKeyDown: (event) => event.stopPropagation(),
            },
            railAxisX ? '›' : '▼',
          ),
        )
      : null,
    railRect && count > 0 && !stage.railCollapsed && splitterStyle
      ? h('div', {
          className: 'onestep-splitter',
          'data-onestep-splitter': '1',
          'data-orientation': stage.railSide === 'top' ? 'horizontal' : 'vertical',
          role: 'separator',
          tabIndex: 0,
          'aria-orientation': stage.railSide === 'top' ? 'horizontal' : 'vertical',
          'aria-label': t('a11y.railResize'),
          'aria-valuemin': railBounds.min,
          'aria-valuemax': railMaxFit == null ? undefined : railMaxFit,
          'aria-valuenow': Math.round(stage.railSide === 'top' ? railRect.h : railRect.w),
          style: splitterStyle,
          onPointerDown: startSplitDrag,
          onPointerMove: moveSplitDrag,
          onPointerUp: endSplitDrag,
          onPointerCancel: endSplitDrag,
          onKeyDown: onSplitterKeyDown,
        })
      : null,
  )
}

/** 主绑定桥（session-maybe）：只上报 sessionId，不渲染内容。 */
export function FocusBridge(props) {
  React.useEffect(() => {
    props.report(props.sessionId === undefined ? null : String(props.sessionId))
  }, [props.sessionId])
  return h('div', { 'data-onestep-focus-bridge': '1', style: { display: 'none' } })
}
