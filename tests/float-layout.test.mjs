/**
 * P3-3/P3-5/P3-10 槽位与满槽策略单测（node:test，纯函数）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SLOT_DEFAULTS,
  normalizeStage,
  computeSlots,
  clampRectToViewport,
  allocateSlotIndex,
  rectsOverlap,
  nearestSlotIndex,
  selectEvictionCandidate,
  reconcileFloats,
} from '../src/client/float-layout.js'

const STAGE_1440 = { x: 280, y: 0, width: 1160, height: 900 }
const STAGE_1280 = { x: 280, y: 0, width: 1000, height: 900 }
const STAGE_860 = { x: 56, y: 0, width: 804, height: 900 }

test('computeSlots：1440x900 三槽（P3-1 实测 {1076,720,364} y16 348×868）', () => {
  const result = computeSlots(STAGE_1440, { viewportWidth: 1440 })
  assert.equal(result.slotW, 348)
  assert.equal(result.rawMaxSlots, 3)
  assert.equal(result.maxSlots, 3)
  assert.equal(result.narrow, false)
  assert.deepEqual(result.slots, [
    { x: 1076, y: 16, width: 348, height: 868 },
    { x: 720, y: 16, width: 348, height: 868 },
    { x: 364, y: 16, width: 348, height: 868 },
  ])
})

test('computeSlots：1280x900 两槽（P3-1 实测 {924,576}）', () => {
  const result = computeSlots(STAGE_1280, { viewportWidth: 1280 })
  assert.equal(result.slotW, 340)
  assert.equal(result.rawMaxSlots, 2)
  assert.equal(result.maxSlots, 2)
  assert.deepEqual(result.slots.map((slot) => slot.x), [924, 576])
})

test('computeSlots：860x900 窄屏单槽（P3-1 实测 stage 804、槽位 x=504）', () => {
  const result = computeSlots(STAGE_860, { viewportWidth: 860 })
  assert.equal(result.narrow, true)
  assert.equal(result.slotW, 340)
  assert.equal(result.maxSlots, 1)
  assert.deepEqual(result.slots, [{ x: 504, y: 16, width: 340, height: 868 }])
})

test('computeSlots：720x900 窄屏单槽（P3-5 最小视口）', () => {
  const stage = { x: 56, y: 0, width: 664, height: 900 }
  const result = computeSlots(stage, { viewportWidth: 720 })
  assert.equal(result.narrow, true)
  assert.equal(result.slotW, 340)
  assert.equal(result.maxSlots, 1)
  assert.equal(result.slots[0].x, 720 - 16 - 340)
  assert.equal(result.slots[0].y, 16)
  assert.equal(result.slots[0].height, 868)
})

test('computeSlots：窄屏判定（视口<900 或 stage<760）；maxSlots 可配置且受几何上限约束', () => {
  assert.equal(computeSlots(STAGE_1440, { viewportWidth: 880 }).narrow, true)
  assert.equal(computeSlots({ x: 0, y: 0, width: 720, height: 900 }, { viewportWidth: 1080 }).narrow, true)
  const two = computeSlots(STAGE_1440, { viewportWidth: 1440, maxSlots: 2 })
  assert.equal(two.maxSlots, 2)
  const capped = computeSlots(STAGE_1440, { viewportWidth: 1440, maxSlots: 5 })
  assert.equal(capped.maxSlots, 3)
  const zero = computeSlots({ x: 0, y: 0, width: 0, height: 0 })
  assert.equal(zero.maxSlots, 1)
  assert.equal(zero.slots.length, 1)
})

test('computeSlots：极窄/极矮舞台仍产出可用槽位（minWidth/minHeight 保底）', () => {
  const narrow = computeSlots({ x: 0, y: 0, width: 400, height: 900 }, { viewportWidth: 400 })
  assert.equal(narrow.slotW, 340)
  assert.equal(narrow.slots[0].x, 44)
  const short = computeSlots({ x: 0, y: 40, width: 1160, height: 150 }, { viewportWidth: 1440 })
  assert.equal(short.slots[0].height, SLOT_DEFAULTS.minHeight)
  assert.equal(short.slots[0].y, 56)
})

test('normalizeStage：DOMRect 与矩形两种形状；非法值归零', () => {
  assert.deepEqual(normalizeStage({ x: 10, y: 20, width: 100, height: 200 }), { left: 10, top: 20, right: 110, bottom: 220, width: 100, height: 200 })
  assert.deepEqual(normalizeStage({ left: 10, top: 20, right: 110, bottom: 220, width: 100, height: 200 }), { left: 10, top: 20, right: 110, bottom: 220, width: 100, height: 200 })
  assert.deepEqual(normalizeStage(null), { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 })
  assert.equal(normalizeStage({ x: 'a', width: -5, height: NaN }).width, 0)
})

test('allocateSlotIndex：顺序补空槽；满槽 null；非法索引忽略', () => {
  assert.equal(allocateSlotIndex(3, []), 0)
  assert.equal(allocateSlotIndex(3, [0]), 1)
  assert.equal(allocateSlotIndex(3, [0, 2]), 1)
  assert.equal(allocateSlotIndex(3, [0, 1, 2]), null)
  assert.equal(allocateSlotIndex(3, [-1, 5, 'x']), 0)
  assert.equal(allocateSlotIndex(0, []), null)
})

test('rectsOverlap：相邻槽位不重叠、容差生效', () => {
  const [first, second] = computeSlots(STAGE_1440, { viewportWidth: 1440 }).slots
  assert.equal(rectsOverlap(first, second), false)
  assert.equal(rectsOverlap(first, { ...first }), true)
  assert.equal(rectsOverlap({ x: 0, y: 0, width: 100, height: 100 }, { x: 98, y: 0, width: 100, height: 100 }), true)
  assert.equal(rectsOverlap({ x: 0, y: 0, width: 100, height: 100 }, { x: 98, y: 0, width: 100, height: 100 }, 2), false)
  assert.equal(rectsOverlap(null, first), false)
})

test('nearestSlotIndex：按中心距离映射', () => {
  const slots = computeSlots(STAGE_1440, { viewportWidth: 1440 }).slots
  assert.equal(nearestSlotIndex({ x: 1076, y: 16, width: 348, height: 868 }, slots), 0)
  assert.equal(nearestSlotIndex({ x: 720, y: 16, width: 348, height: 868 }, slots), 1)
  assert.equal(nearestSlotIndex({ x: 0, y: 0, width: 10, height: 10 }, slots), 2)
  assert.equal(nearestSlotIndex(null, slots), null)
  assert.equal(nearestSlotIndex({ x: 0, y: 0, width: 1, height: 1 }, []), null)
})

test('clampRectToViewport：越界矩形钳回视口内', () => {
  assert.deepEqual(clampRectToViewport({ x: 1400, y: -10, width: 348, height: 900 }, { width: 1440, height: 900 }), { x: 1092, y: 0, width: 348, height: 900 })
  assert.deepEqual(clampRectToViewport({ x: 0, y: 0, width: 5000, height: 5000 }, { width: 1280, height: 720 }), { x: 0, y: 0, width: 1280, height: 720 })
})

test('selectEvictionCandidate：最久未聚焦的未收起浮窗（Q13）', () => {
  const floats = [
    { tabId: 'a', lastFocusedAt: 30, peeked: false },
    { tabId: 'b', lastFocusedAt: 10, peeked: false },
    { tabId: 'c', lastFocusedAt: 5, peeked: true },
  ]
  assert.equal(selectEvictionCandidate(floats).tabId, 'b')
  assert.equal(selectEvictionCandidate([{ tabId: 'a', peeked: true }]), null)
  assert.equal(selectEvictionCandidate([]), null)
  assert.equal(selectEvictionCandidate(undefined), null)
  assert.equal(selectEvictionCandidate([{ tabId: 'x' }, { tabId: 'y', lastFocusedAt: 1 }]).tabId, 'x')
})

test('reconcileFloats：更新 paneId/标题、移除已关闭、报告未管理、槽位去重/最近槽位回填', () => {
  const slots = computeSlots(STAGE_1440, { viewportWidth: 1440 }).slots
  const records = [
    { tabId: 'tab2', paneId: 'float3', kind: 'text', title: 'old.md', slot: 0, peeked: false, lastFocusedAt: 1 },
    { tabId: 'tab4', paneId: 'float5', kind: 'guide', title: 'guide', slot: 0, peeked: false, lastFocusedAt: 2 },
    { tabId: 'tab6', paneId: 'float7', kind: 'text', title: 'closed.md', slot: 2, peeked: false, lastFocusedAt: 3 },
  ]
  const observed = [
    { paneId: 'float3', tabId: 'tab2', title: 'README.md', rect: slots[0] },
    { paneId: 'float5', tabId: 'tab4', title: 'guide-new', rect: slots[2] },
    { paneId: 'float9', tabId: 'tab8', title: 'unmanaged.md', rect: slots[1] },
  ]
  const result = reconcileFloats(records, observed, slots)
  assert.deepEqual(result.removed, ['tab6'])
  assert.equal(result.unmanaged.length, 1)
  assert.equal(result.unmanaged[0].tabId, 'tab8')
  const byTab = new Map(result.records.map((record) => [record.tabId, record]))
  assert.equal(byTab.get('tab2').title, 'README.md')
  assert.equal(byTab.get('tab2').slot, 0) // 保留原槽
  assert.equal(byTab.get('tab4').slot, 2) // 冲突槽位重排：0 已占，按 rect 最近槽位 2
  assert.equal(result.changed, true)
})

test('reconcileFloats：已收回右栏（docked）记录在 DOM 消失时保留，重新出现则 docked=false', () => {
  const slots = computeSlots(STAGE_1440, { viewportWidth: 1440 }).slots
  const records = [{ tabId: 'tab2', paneId: 'float3', kind: 'text', title: 'a.md', slot: 0, peeked: false, docked: true }]
  const gone = reconcileFloats(records, [], slots)
  assert.deepEqual(gone.removed, [])
  assert.equal(gone.records.length, 1)
  assert.equal(gone.records[0].docked, true)
  const back = reconcileFloats(records, [{ paneId: 'float3', tabId: 'tab2', title: 'a.md', rect: slots[0] }], slots)
  assert.equal(back.records[0].docked, false)
  const closed = reconcileFloats([{ tabId: 'tab9', title: 'x.md', docked: false }], [], slots)
  assert.deepEqual(closed.removed, ['tab9'])
})

test('reconcileFloats：无变化时 changed=false；槽位表为空时保留逻辑槽位不抛', () => {
  const slots = computeSlots(STAGE_1440, { viewportWidth: 1440 }).slots
  const records = [{ tabId: 'tab2', paneId: 'float3', kind: 'text', title: 'a.md', slot: 0, peeked: false }]
  const observed = [{ paneId: 'float3', tabId: 'tab2', title: 'a.md', rect: slots[0] }]
  assert.equal(reconcileFloats(records, observed, slots).changed, false)
  const noSlots = reconcileFloats([{ tabId: 'tab2', title: 'a.md', slot: 1 }], [{ paneId: 'float3', tabId: 'tab2', title: 'a.md' }], [])
  assert.equal(noSlots.records[0].slot, 1) // 保留逻辑槽位（不因当前视口槽数变少丢弃）
})
