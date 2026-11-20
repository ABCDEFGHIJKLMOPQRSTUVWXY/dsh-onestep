/**
 * 候场预览快照（0.7.0 用户要求「完整后场的缩略改成静态图片，只有在状态改变时才更新」）。
 *
 * 背景：候场卡此前的 live 缩略会给每张可见卡挂载一份官方会话内容，挂载/卸载单卡
 * 约 0.15–0.4s；滚动/拖宽/换焦触发虚拟化进出视口时会出现连续长任务（诊断见
 * artifacts/p3/verify/perf-candidate-jank.json）。这里把 live 档改为：
 *   1) 在隐藏宿主里渲染一次官方内容；
 *   2) 把渲染结果克隆为静态 HTML 快照（纯 DOM，无 React 订阅、无事件、不再更新）；
 *   3) 之后卡片只显示静态快照；只有「状态签名」变化时才重新拍快照。
 *
 * 本模块是纯逻辑（无 DOM/React），可单测：状态签名、快照 LRU 缓存、串行空闲调度器。
 */

/**
 * 把快照按「完整显示」缩放进卡片内容区（equivalent to CSS object-fit: contain）：
 * 取宽高两个方向缩放比的较小值，整张快照始终可见；比例不一致时居中留白。
 *
 * @param {number} boxWidth 卡片内容区宽（CSS px）
 * @param {number} boxHeight 卡片内容区高（CSS px）
 * @param {number} snapshotWidth 快照逻辑宽
 * @param {number} snapshotHeight 快照逻辑高
 * @returns {{scale:number, left:number, top:number, width:number, height:number}}
 */
export function fitSnapshot(boxWidth, boxHeight, snapshotWidth, snapshotHeight) {
  const bw = Math.max(1, Number(boxWidth) || 1)
  const bh = Math.max(1, Number(boxHeight) || 1)
  const sw = Math.max(1, Number(snapshotWidth) || 1)
  const sh = Math.max(1, Number(snapshotHeight) || 1)
  const scale = Math.max(0.01, Math.min(bw / sw, bh / sh))
  const width = sw * scale
  const height = sh * scale
  return {
    scale,
    left: Math.max(0, (bw - width) / 2),
    top: Math.max(0, (bh - height) / 2),
    width,
    height,
  }
}

/** 快照格式版本（未来若要给快照加前后处理，可据此失效旧缓存）。 */
export const PREVIEW_SNAPSHOT_VERSION = 1

/**
 * 计算候场卡的「状态签名」：只有这些字段变化才重新拍快照。
 * 刻意不包含 updatedAt / 消息内容变化——运行中的流式输出不会触发快照刷新。
 *
 * @param {object|null|undefined} row sessions.byId 行
 * @param {object|null|undefined} status useSessionStatus 项（running/completionUnread/pendingInteraction）
 * @returns {string}
 */
export function previewStatusKey(row, status) {
  const pending = status && status.pendingInteraction ? status.pendingInteraction : null
  return [
    'v' + PREVIEW_SNAPSHOT_VERSION,
    row && row.blank ? 'blank' : 'filled',
    row && row.awaitingFirstTurn ? 'awaiting' : 'started',
    String((row && row.displayTitle) || ''),
    status && status.running ? 'running' : 'idle',
    status && status.completionUnread ? 'unread' : 'read',
    pending ? String(pending.kind || 'pending') : '',
  ].join('|')
}

/**
 * 创建快照缓存（每个 sessionId 只保留最新快照；LRU 上限防御坏状态/长会话列表）。
 *
 * @param {{max?:number, now?:()=>number}} [options]
 * @returns {{
 *   latest:(sessionId:string)=>({key:string,html:string,width:number,height:number,at:number}|null),
 *   get:(sessionId:string,key:string)=>({key:string,html:string,width:number,height:number,at:number}|null),
 *   set:(sessionId:string,key:string,html:string,width:number,height:number)=>object,
 *   retain:(ids:Iterable<string>)=>void,
 *   clear:()=>void,
 *   size:()=>number,
 * }}
 */
export function createPreviewCache(options = {}) {
  const max = Math.max(1, Math.floor(Number(options.max) || 24))
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const entries = new Map()

  const prune = () => {
    while (entries.size > max) {
      const oldest = entries.keys().next()
      if (oldest.done) break
      entries.delete(oldest.value)
    }
  }

  const latest = (sessionId) => {
    const id = String(sessionId || '')
    return entries.get(id) || null
  }

  const get = (sessionId, key) => {
    const entry = latest(sessionId)
    if (!entry || entry.key !== key) return null
    // LRU 触碰
    entries.delete(String(sessionId))
    entries.set(String(sessionId), entry)
    return entry
  }

  const set = (sessionId, key, html, width, height) => {
    const id = String(sessionId || '')
    if (!id || typeof html !== 'string' || !html) return null
    const entry = {
      key: String(key || ''),
      html,
      width: Math.max(1, Math.round(Number(width) || 1)),
      height: Math.max(1, Math.round(Number(height) || 1)),
      at: now(),
    }
    entries.delete(id)
    entries.set(id, entry)
    prune()
    return entry
  }

  /** 只保留仍在意向集合里的快照（候场移除/换焦后释放内存）。 */
  const retain = (ids) => {
    const keep = new Set(Array.from(ids || []).map((id) => String(id)))
    for (const id of Array.from(entries.keys())) {
      if (!keep.has(id)) entries.delete(id)
    }
  }

  return {
    latest,
    get,
    set,
    retain,
    clear: () => entries.clear(),
    size: () => entries.size,
  }
}

/* ------------------------------------------------------------------ *
 * 重拍节流（F4）：已有快照时，状态签名变化触发的重拍先防抖 + 每会话最小间隔，
 * 避免回合边界（running/unread/标题变化）连续触发 0.15–0.4s 的官方内容挂载。
 * ------------------------------------------------------------------ */

/** 状态签名变化后的重拍防抖窗口（ms）：窗口内再次变化会重新计时，合并成一次重拍。 */
export const RECAPTURE_DEBOUNCE_MS = 500
/** 同一会话两次成功抓拍的最小间隔（ms）：距上次 cache entry.at 不足时延后到满足间隔。 */
export const RECAPTURE_MIN_INTERVAL_MS = 2500

/**
 * 计算「已有快照」时一次重拍的延迟：至少防抖 500ms；若距上次成功抓拍不足 2500ms，再延后补足。
 *
 * @param {number} latestAt 上次成功抓拍时间（cache entry.at，ms 时间戳；非法值按 0 处理）
 * @param {number} [now] 当前时间（默认 Date.now）
 * @returns {number} 延迟毫秒数（>= RECAPTURE_DEBOUNCE_MS）
 */
export function recaptureDelayMs(latestAt, now = Date.now()) {
  const at = Number(latestAt) || 0
  const age = Math.max(0, (Number(now) || 0) - at)
  const throttle = age < RECAPTURE_MIN_INTERVAL_MS ? RECAPTURE_MIN_INTERVAL_MS - age : 0
  return Math.max(RECAPTURE_DEBOUNCE_MS, throttle)
}

/**
 * 串行空闲调度器：一次只允许一个快照挂载（官方内容挂载是重活），两拍之间留出间隔，
 * 避免多张卡在同一帧挂载造成长任务叠加。组件在任务结束时必须调用 done()。
 *
 * F4（换焦抓拍修复）：done 支持传入本次任务 token —— 只有 current === job 时才释放槽位，
 * 防止「抓取中状态签名变化 → effect cleanup 提前 done()」把串行保证打破（两份官方内容并发挂载）。
 * 不传 job 时保持旧语义（无条件释放），兼容探针/旧调用点。
 *
 * @param {{
 *   requestIdleCallback?: (cb:(deadline:{didTimeout:boolean,timeRemaining:()=>number})=>void)=>(number|object),
 *   cancelIdleCallback?: (handle:number|object)=>void,
 *   setTimeout?: (fn:()=>void, ms:number)=>(number|object),
 *   clearTimeout?: (handle:number|object)=>void,
 *   fallbackDelayMs?: number,
 *   gapMs?: number,
 * }} [options]
 * @returns {{
 *   push:(job:{run:()=>void})=>void,
 *   remove:(job:{run:()=>void})=>void,
 *   done:(job?:{run:()=>void})=>boolean,
 *   pending:()=>number,
 *   dispose:()=>void,
 * }}
 */
export function createCaptureScheduler(options = {}) {
  const delay = (value, fallback) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : fallback
  const gapMs = delay(options.gapMs, 120)
  const fallbackDelayMs = delay(options.fallbackDelayMs, 80)
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : (fn, ms) => setTimeout(fn, ms)
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : (timer) => clearTimeout(timer)
  const usesIdleCallback = typeof options.requestIdleCallback === 'function'
  const idle = usesIdleCallback
    ? options.requestIdleCallback
    : (callback) => setTimer(() => callback({ didTimeout: true, timeRemaining: () => 0 }), fallbackDelayMs)
  const cancelIdle = usesIdleCallback
    ? (typeof options.cancelIdleCallback === 'function' ? options.cancelIdleCallback : () => {})
    : clearTimer

  const queue = []
  let current = null
  let idleHandle = null
  let gapTimer = null
  let disposed = false

  const schedule = () => {
    if (disposed || current !== null || idleHandle !== null || gapTimer !== null || queue.length === 0) return
    idleHandle = idle(() => {
      idleHandle = null
      if (disposed || current !== null) return
      const job = queue.shift()
      if (!job) return
      current = job
      try {
        job.run()
      } catch (_error) {
        // 失败的抓取同样可能已经消耗主线程；保留间隔并且只释放自己的槽位。
        done(job)
      }
    })
  }

  /**
   * 释放本次抓取占用的槽位。
   * F4：传 job 时只有「当前正在跑的就是该 job」才释放；拿旧 token 的 cleanup / 重复调用不会误释放。
   * @param {{run:()=>void}} [job] 本次任务 token（captureScheduler.push 的同一对象）
   * @returns {boolean} 是否实际释放
   */
  const done = (job) => {
    if (disposed) return false
    if (current === null) return false
    if (job !== undefined && job !== null && current !== job) return false
    current = null
    if (gapTimer !== null) clearTimer(gapTimer)
    gapTimer = setTimer(() => {
      gapTimer = null
      schedule()
    }, gapMs)
    return true
  }

  const push = (job) => {
    if (disposed || !job || typeof job.run !== 'function') return
    queue.push(job)
    schedule()
  }

  const remove = (job) => {
    const index = queue.indexOf(job)
    if (index >= 0) queue.splice(index, 1)
  }

  const dispose = () => {
    disposed = true
    if (idleHandle !== null) {
      try { cancelIdle(idleHandle) } catch (_error) { /* ignore */ }
      idleHandle = null
    }
    if (gapTimer !== null) {
      clearTimer(gapTimer)
      gapTimer = null
    }
    queue.length = 0
    current = null
  }

  return { push, remove, done, pending: () => queue.length + (current === null ? 0 : 1), dispose }
}
