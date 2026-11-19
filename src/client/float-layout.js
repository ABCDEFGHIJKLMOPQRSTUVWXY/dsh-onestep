/**
 * P3 浮窗槽位与满槽策略（纯函数，P3-3/P3-5/P3-10）。
 *
 * 设计依据：docs/p3-plan.md §5.4（P3-1 实测 1440/1280/860 三视口一致）；
 * 槽位 rect 为 **viewport CSS 像素**，官方 `float(tabId, rect)` 原样接受。
 *
 * 本模块不碰 DOM/React：输入舞台矩形（`getBoundingClientRect()` 形状）与视口宽高，
 * 输出槽位矩形数组与分配/淘汰决策，便于单测与在任意入口复用。
 */

/** 槽位与满槽默认参数（可被 options 覆盖；窄屏降级见 computeSlots）。 */
export const SLOT_DEFAULTS = Object.freeze({
  /** 浮窗之间、浮窗与舞台右缘之间的间距。 */
  gap: 8,
  /** 单窗宽度 = clamp(minWidth, stage.width × ratio, maxWidth)。 */
  ratio: 0.3,
  minWidth: 340,
  maxWidth: 480,
  /** 同一时刻最多浮窗数（插件策略；官方不校验）。 */
  maxSlots: 3,
  /** 舞台四周留白。 */
  inset: 16,
  /** 浮窗最小高度（舞台极矮时保底）。 */
  minHeight: 160,
  /** 视口宽度低于该值视为窄屏（P3-1 实测 860 视口：左栏转 drawer、stage 804）。 */
  narrowViewport: 900,
  /** 舞台宽度低于该值视为窄屏（与舞台自身退出阈值 760 对齐）。 */
  narrowStageWidth: 760,
  /** 单个会话最多记录的浮窗元数据条数（防御坏存储）。 */
  maxTracked: 8,
})

/**
 * 归一化舞台矩形，容忍 DOMRect（含 right/bottom）与 {x,y,width,height} 两种形状。
 * @param {{x?:number,y?:number,left?:number,top?:number,width?:number,height?:number,right?:number,bottom?:number}|null|undefined} input
 * @returns {{left:number,top:number,right:number,bottom:number,width:number,height:number}}
 */
export function normalizeStage(input) {
  const source = input || {}
  const left = finiteOr(source.left, finiteOr(source.x, 0))
  const top = finiteOr(source.top, finiteOr(source.y, 0))
  const width = Math.max(0, finiteOr(source.width, 0))
  const height = Math.max(0, finiteOr(source.height, 0))
  const right = finiteOr(source.right, left + width)
  const bottom = finiteOr(source.bottom, top + height)
  return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

function finiteOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/**
 * 计算某视口/舞台下的槽位表。
 * 槽位从右向左编号：0 = 最右（第一个浮窗），1 = 其左侧，依此类推。
 *
 * 公式（p3-plan §5.4）：
 * - `slotW = clamp(minWidth, stage.width × ratio, maxWidth)`
 * - `rawMaxSlots = floor((stage.width - 2×inset + gap) / (slotW + gap))`
 * - `maxSlots = min(cfg.maxSlots, rawMaxSlots)`；窄屏强制 1
 * - 第 i 槽：`x = stage.right - inset - slotW - i×(slotW+gap)`；`y = stage.top + inset`；
 *   `height = max(minHeight, stage.height - 2×inset)`
 *
 * @param {object} stageInput 舞台矩形
 * @param {object} [options] 覆盖 SLOT_DEFAULTS；另可传 viewportWidth（默认取 stage.right）
 * @returns {{gap:number, slotW:number, rawMaxSlots:number, maxSlots:number, narrow:boolean, slots:Array<{x:number,y:number,width:number,height:number}>}}
 */
export function computeSlots(stageInput, options = {}) {
  const stage = normalizeStage(stageInput)
  const cfg = { ...SLOT_DEFAULTS, ...(options || {}) }
  const gap = Math.max(0, finiteOr(cfg.gap, SLOT_DEFAULTS.gap))
  const inset = Math.max(0, finiteOr(cfg.inset, SLOT_DEFAULTS.inset))
  const ratio = Number.isFinite(Number(cfg.ratio)) ? Number(cfg.ratio) : SLOT_DEFAULTS.ratio
  const slotW = clamp(finiteOr(cfg.minWidth, SLOT_DEFAULTS.minWidth), stage.width * ratio, finiteOr(cfg.maxWidth, SLOT_DEFAULTS.maxWidth))
  const usableWidth = stage.width - inset * 2
  const rawMaxSlots = Math.max(0, Math.floor((usableWidth + gap) / (slotW + gap)))
  const viewportWidth = finiteOr(options.viewportWidth, stage.right > 0 ? stage.right : stage.width)
  const narrow = viewportWidth < cfg.narrowViewport || stage.width < cfg.narrowStageWidth
  const cap = Math.max(1, Math.floor(finiteOr(cfg.maxSlots, SLOT_DEFAULTS.maxSlots)))
  const maxSlots = narrow ? 1 : Math.max(1, Math.min(cap, rawMaxSlots || 1))
  const height = Math.max(finiteOr(cfg.minHeight, SLOT_DEFAULTS.minHeight), stage.height - inset * 2)
  const slots = []
  for (let index = 0; index < maxSlots; index += 1) {
    slots.push({
      x: Math.round(stage.right - inset - slotW - index * (slotW + gap)),
      y: Math.round(stage.top + inset),
      width: Math.round(slotW),
      height: Math.round(height),
    })
  }
  return { gap, slotW: Math.round(slotW), rawMaxSlots, maxSlots, narrow, slots }
}

function clamp(min, value, max) {
  const lower = Math.min(min, max)
  const upper = Math.max(min, max)
  return Math.round(Math.min(upper, Math.max(lower, value)))
}

/**
 * 把槽位索引/矩形钳制进视口（官方渲染也会钳制；这里先保证请求矩形在视口内）。
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {{width:number,height:number}} viewport
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function clampRectToViewport(rect, viewport) {
  const source = rect || { x: 0, y: 0, width: 0, height: 0 }
  const width = Math.max(1, Math.min(finiteOr(source.width, 0), finiteOr(viewport && viewport.width, 0) || finiteOr(source.width, 1)))
  const height = Math.max(1, Math.min(finiteOr(source.height, 0), finiteOr(viewport && viewport.height, 0) || finiteOr(source.height, 1)))
  const x = Math.max(0, Math.min(finiteOr(source.x, 0), (finiteOr(viewport && viewport.width, 0) || width) - width))
  const y = Math.max(0, Math.min(finiteOr(source.y, 0), (finiteOr(viewport && viewport.height, 0) || height) - height))
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

/**
 * 分配下一个空闲槽位。
 * @param {number} maxSlots 槽位数
 * @param {Array<number|null|undefined>} occupiedSlots 已占槽位索引
 * @returns {number|null} 空闲槽位索引；满槽返回 null
 */
export function allocateSlotIndex(maxSlots, occupiedSlots) {
  const total = Math.max(0, Math.floor(finiteOr(maxSlots, 0)))
  const occupied = new Set(
    (Array.isArray(occupiedSlots) ? occupiedSlots : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0 && value < total),
  )
  for (let index = 0; index < total; index += 1) {
    if (!occupied.has(index)) return index
  }
  return null
}

/**
 * 两个矩形是否重叠；重叠宽度/高度都大于 tolerance 才算重叠（用于「两两不重叠」断言）。
 * @param {{x:number,y:number,width:number,height:number}} a
 * @param {{x:number,y:number,width:number,height:number}} b
 * @param {number} [tolerance] 允许的像素级重叠
 * @returns {boolean}
 */
export function rectsOverlap(a, b, tolerance = 0) {
  if (!a || !b) return false
  const slack = Math.max(0, finiteOr(tolerance, 0))
  const overlapX = Math.min(finiteOr(a.x, 0) + finiteOr(a.width, 0), finiteOr(b.x, 0) + finiteOr(b.width, 0)) - Math.max(finiteOr(a.x, 0), finiteOr(b.x, 0))
  const overlapY = Math.min(finiteOr(a.y, 0) + finiteOr(a.height, 0), finiteOr(b.y, 0) + finiteOr(b.height, 0)) - Math.max(finiteOr(a.y, 0), finiteOr(b.y, 0))
  return overlapX > slack && overlapY > slack
}

/**
 * 找与矩形中心最近的槽位索引（用于刷新/对账时把官方持久 rect 映射回槽位）。
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {Array<{x:number,y:number,width:number,height:number}>} slots
 * @returns {number|null}
 */
export function nearestSlotIndex(rect, slots) {
  if (!rect || !Array.isArray(slots) || slots.length === 0) return null
  const cx = finiteOr(rect.x, 0) + finiteOr(rect.width, 0) / 2
  const cy = finiteOr(rect.y, 0) + finiteOr(rect.height, 0) / 2
  let best = null
  let bestDistance = Infinity
  slots.forEach((slot, index) => {
    const dx = finiteOr(slot.x, 0) + finiteOr(slot.width, 0) / 2 - cx
    const dy = finiteOr(slot.y, 0) + finiteOr(slot.height, 0) / 2 - cy
    const distance = dx * dx + dy * dy
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  })
  return best
}

/**
 * 满槽淘汰候选：最久未聚焦的**未收起**浮窗（Q13）。
 * @param {Array<{tabId:string, slot?:number|null, peeked?:boolean, lastFocusedAt?:number}>} floats
 * @returns {object|null} 最旧的浮窗记录；没有可淘汰的（空/全部收起）返回 null
 */
export function selectEvictionCandidate(floats) {
  const list = Array.isArray(floats) ? floats.filter((item) => item && !item.peeked) : []
  if (list.length === 0) return null
  let candidate = list[0]
  for (const item of list.slice(1)) {
    const current = Number(candidate.lastFocusedAt) || 0
    const next = Number(item.lastFocusedAt) || 0
    if (next < current) candidate = item
  }
  return candidate
}

/**
 * 对账：把持久记录与实际观测到的官方浮窗（DOM 扫描结果）合并。
 *
 * - 记录仍在 DOM：更新 paneId/title/rect/peeked，槽位缺失或重复时按最近槽位重排；
 * - 记录不在 DOM：官方 tab 已关闭或已 dock → 从记录移除（removed）；
 * - DOM 有但记录没有：未管理浮窗（unmanaged，不接管，P3-11 只用通用图标/不纳入 peek）。
 *
 * @param {Array<object>} records 插件管理的浮窗记录
 * @param {Array<{paneId:string, tabId:string, title?:string, rect?:object, peeked?:boolean}>} observed DOM 观测
 * @param {Array<{x:number,y:number,width:number,height:number}>} slots 当前槽位表
 * @returns {{records:Array<object>, changed:boolean, removed:Array<string>, unmanaged:Array<object>}}
 */
export function reconcileFloats(records, observed, slots) {
  const observedList = Array.isArray(observed) ? observed.filter((item) => item && item.tabId) : []
  const observedByTab = new Map(observedList.map((item) => [String(item.tabId), item]))
  const consumedTabs = new Set()
  const kept = []
  const removed = []
  const usedSlots = new Set()
  const pending = []
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || !record.tabId) continue
    const key = String(record.tabId)
    const seen = observedByTab.get(key)
    if (!seen) {
      // 已收回官方右栏的记录保留（供「转回浮窗」），不算 removed。
      if (record.docked) {
        kept.push({ ...record, tabId: key, docked: true })
        continue
      }
      removed.push(key)
      continue
    }
    consumedTabs.add(key)
    const next = {
      ...record,
      tabId: key,
      ...(record.docked ? { docked: false } : {}),
      paneId: seen.paneId ? String(seen.paneId) : record.paneId || null,
      title: typeof seen.title === 'string' && seen.title ? seen.title : record.title || '',
    }
    if (typeof seen.peeked === 'boolean') next.peeked = seen.peeked
    const requested = Number.isInteger(next.slot) && next.slot >= 0 ? next.slot : null
    // 保留已记录的逻辑槽位（不因当前视口槽数变少而丢弃；窗口恢复后仍可对位）。
    if (requested !== null && !usedSlots.has(requested)) {
      next.slot = requested
      usedSlots.add(requested)
      kept.push(next)
    } else {
      pending.push(next)
    }
  }
  // 槽位缺失/冲突的记录：先按实际 rect 找最近空槽，其次按顺序补空槽。
  for (const record of pending) {
    const seen = observedByTab.get(record.tabId)
    const nearest = seen && seen.rect ? nearestSlotIndex(seen.rect, slots) : null
    if (nearest !== null && !usedSlots.has(nearest)) {
      record.slot = nearest
      usedSlots.add(nearest)
    } else {
      record.slot = allocateSlotIndex(slots ? slots.length : 0, Array.from(usedSlots))
      if (record.slot !== null) usedSlots.add(record.slot)
    }
    kept.push(record)
  }
  const unmanaged = observedList.filter((item) => !consumedTabs.has(String(item.tabId)))
  const changed = JSON.stringify(kept) !== JSON.stringify(Array.isArray(records) ? records : []) || removed.length > 0
  return { records: kept, changed, removed, unmanaged }
}
