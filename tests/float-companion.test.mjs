/**
 * P3-3 浮窗编排层单测（node:test）：槽位分配/满槽淘汰/对账/原语归一化（不依赖真实 DOM）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createFloatCompanion } from '../src/client/companion.js'
import { createCompanionState, upsertFloat, sessionStateOf } from '../src/client/float-state.js'

const STAGE_1440 = { x: 280, y: 0, width: 1160, height: 900 }

function fakeService(overrides = {}) {
  const calls = []
  const service = {
    calls,
    expanded: false,
    record: { id: 'tab2', kind: 'text', title: 'README.md' },
    isExpanded() {
      calls.push(['isExpanded'])
      return this.expanded
    },
    toggleExpanded() {
      calls.push(['toggleExpanded'])
      this.expanded = !this.expanded
    },
    active() {
      calls.push(['active'])
      return this.record
    },
    float(tabId, rect) {
      calls.push(['float', tabId, rect])
      if (this.floatError) throw this.floatError
    },
    focus(tabId) {
      calls.push(['focus', tabId])
    },
    dock(paneId) {
      calls.push(['dock', paneId])
    },
    close(tabId) {
      calls.push(['close', tabId])
    },
    hide(tabId) {
      calls.push(['hide', tabId])
    },
    openTabs: {
      getSnapshot() {
        return [
          { sessionId: 's1', tabId: 'tab2', kind: 'text', contentId: 'a' },
          { sessionId: 's2', tabId: 'tab9', kind: 'guide', contentId: 'b' },
        ]
      },
    },
    tabsIn(sessionId) {
      calls.push(['tabsIn', sessionId])
      return [{ id: 'tab2', kind: 'text', title: 'README.md' }]
    },
    ...overrides,
  }
  return service
}

function fakeDom(overrides = {}) {
  return {
    stageRect: () => STAGE_1440,
    viewport: () => ({ width: 1440, height: 900 }),
    panel: (sessionId) => ({ found: !!sessionId, open: true, opening: false, mode: 'push', rect: { x: 792, y: 0, width: 648, height: 900 } }),
    floats: () => [],
    ...overrides,
  }
}

function create(service, dom, focus = 's1') {
  return createFloatCompanion({ getService: () => service, getFocusId: () => focus, dom, log: () => {} })
}

test('snapshot：焦点/右栏态/槽位/浮窗回显/openTabs 过滤当前会话', () => {
  const service = fakeService({ expanded: true })
  const floats = [{ paneId: 'float3', tabId: 'tab2', title: 'README.md', rect: { x: 1076, y: 16, width: 348, height: 868 } }]
  const companion = create(service, fakeDom({ floats: () => floats }))
  const snap = companion.snapshot()
  assert.equal(snap.available, true)
  assert.equal(snap.sessionId, 's1')
  assert.equal(snap.expanded, true)
  assert.equal(snap.floatCount, 1)
  assert.deepEqual(snap.floats, floats)
  assert.equal(snap.slots.maxSlots, 3)
  assert.deepEqual(snap.openTabs.map((item) => item.tabId), ['tab2'])
  assert.equal(snap.panel.open, true)
})

test('slots：无舞台 → null；860 窄屏 → 单槽；1440 → 三槽', () => {
  assert.equal(create(fakeService(), fakeDom({ stageRect: () => null })).slots(), null)
  assert.equal(create(fakeService(), fakeDom({ stageRect: () => ({ x: 10, y: 0, width: 0, height: 100 }) })).slots(), null)
  const narrow = create(fakeService(), fakeDom({ stageRect: () => ({ x: 56, y: 0, width: 804, height: 900 }), viewport: () => ({ width: 860, height: 900 }) })).slots()
  assert.equal(narrow.maxSlots, 1)
  assert.deepEqual(narrow.slots[0], { x: 504, y: 16, width: 340, height: 868 })
  const wide = create(fakeService(), fakeDom()).slots()
  assert.equal(wide.maxSlots, 3)
  assert.deepEqual(wide.slots.map((slot) => slot.x), [1076, 720, 364])
})

test('allocate：空 → 槽 0；占用 → 顺延；不把已收起浮窗算占用', () => {
  const companion = create(fakeService(), fakeDom())
  assert.equal(companion.allocate([]).slot, 0)
  assert.equal(companion.allocate([{ tabId: 'a', slot: 0, peeked: false }]).slot, 1)
  const two = [0, 1].map((slot) => ({ tabId: 't' + slot, slot, peeked: false }))
  assert.equal(companion.allocate(two).slot, 2)
  const peeked = [{ tabId: 'a', slot: 0, peeked: true }]
  assert.equal(companion.allocate(peeked).slot, 0)
})

test('allocate：满槽淘汰最久未聚焦（Q13），返回其槽位与淘汰记录；已收起记录不占槽', () => {
  const companion = create(fakeService(), fakeDom())
  const floats = [
    { tabId: 'a', slot: 0, peeked: false, lastFocusedAt: 30 },
    { tabId: 'b', slot: 1, peeked: false, lastFocusedAt: 10 },
    { tabId: 'c', slot: 2, peeked: false, lastFocusedAt: 20 },
  ]
  const result = companion.allocate(floats)
  assert.equal(result.ok, true)
  assert.equal(result.slot, 1)
  assert.equal(result.evicted.tabId, 'b')
  assert.equal(result.rect.x, 720)
  // 全部收起 = 槽位全部可用（视觉上隐藏，不参与占用；恢复时按 swap 规则处理）
  const allPeeked = floats.map((item) => ({ ...item, peeked: true }))
  const freed = companion.allocate(allPeeked)
  assert.equal(freed.ok, true)
  assert.equal(freed.slot, 0)
  assert.equal(freed.evicted, null)
  assert.equal(companion.allocate([]).slot, 0)
})

test('allocate：无舞台 → no-stage', () => {
  const companion = create(fakeService(), fakeDom({ stageRect: () => null }))
  assert.equal(companion.allocate([]).reason, 'no-stage')
})

test('reconcile：更新标题/paneId、移除已关闭、报告未管理、写回状态', () => {
  let state = upsertFloat(createCompanionState(1), 's1', { tabId: 'tab2', paneId: 'float3', kind: 'text', title: 'old.md', slot: 0 })
  state = upsertFloat(state, 's1', { tabId: 'tab4', paneId: 'float5', kind: 'text', title: 'closed.md', slot: 1 })
  const domFloats = [
    { paneId: 'float3', tabId: 'tab2', title: 'README.md', rect: { x: 1076, y: 16, width: 348, height: 868 } },
    { paneId: 'float9', tabId: 'tab8', title: 'unmanaged.md', rect: { x: 720, y: 16, width: 348, height: 868 } },
  ]
  const companion = create(fakeService(), fakeDom({ floats: () => domFloats }))
  const result = companion.reconcile(state, 's1', 500)
  assert.equal(result.changed, true)
  assert.deepEqual(result.removed, ['tab4'])
  assert.equal(result.unmanaged.length, 1)
  assert.equal(result.unmanaged[0].tabId, 'tab8')
  const floats = sessionStateOf(result.state, 's1').floats
  assert.deepEqual(floats.map((item) => item.tabId), ['tab2'])
  assert.equal(floats[0].title, 'README.md')
  assert.equal(floats[0].slot, 0)
  assert.deepEqual(result.counts, { total: 1, peeked: 0, visible: 1 })
  assert.equal(sessionStateOf(state, 's1').floats.length, 2) // 入参不可变
})

test('reconcile：无变化时 state 原样返回（引用不变）；无舞台不抛', () => {
  const state = upsertFloat(createCompanionState(1), 's1', { tabId: 'tab2', paneId: 'float3', kind: 'text', title: 'a.md', slot: 0 })
  const companion = create(fakeService(), fakeDom({ floats: () => [{ paneId: 'float3', tabId: 'tab2', title: 'a.md', rect: { x: 1076, y: 16, width: 348, height: 868 } }] }))
  const result = companion.reconcile(state, 's1', 600)
  assert.equal(result.changed, false)
  assert.equal(result.state, state)
  const noStage = create(fakeService(), fakeDom({ stageRect: () => null, floats: () => [{ paneId: 'float3', tabId: 'tab2', title: 'a.md' }] }))
  assert.doesNotThrow(() => noStage.reconcile(state, 's1', 700))
})

test('allocate：已收回右栏（docked）的记录不占槽、不参与淘汰', () => {
  const companion = create(fakeService(), fakeDom())
  const floats = [
    { tabId: 'a', slot: 0, peeked: false, docked: true, lastFocusedAt: 1 },
    { tabId: 'b', slot: 1, peeked: false, docked: false, lastFocusedAt: 5 },
    { tabId: 'c', slot: 2, peeked: false, docked: false, lastFocusedAt: 9 },
  ]
  const result = companion.allocate(floats)
  assert.equal(result.ok, true)
  assert.equal(result.slot, 0) // docked 的 a 不占槽
  assert.equal(result.evicted, null)
  const full = [
    { tabId: 'a', slot: 0, peeked: false, docked: false, lastFocusedAt: 1 },
    { tabId: 'b', slot: 1, peeked: false, docked: false, lastFocusedAt: 5 },
    { tabId: 'c', slot: 2, peeked: false, docked: false, lastFocusedAt: 9 },
    { tabId: 'd', slot: null, peeked: false, docked: true, lastFocusedAt: 0 },
  ]
  const evict = companion.allocate(full)
  assert.equal(evict.evicted.tabId, 'a') // 淘汰最旧的非 docked 浮窗，不会选 docked 的 d
})

test('reconcile：docked 记录仅在官方 tab 仍打开时保留（关掉的 tab 回收）', () => {
  let state = upsertFloat(createCompanionState(1), 's1', { tabId: 'tab2', paneId: 'float3', kind: 'text', title: 'open.md', slot: 0, docked: true })
  state = upsertFloat(state, 's1', { tabId: 'tab9', paneId: 'float5', kind: 'text', title: 'closed.md', slot: 1, docked: true })
  const companion = create(fakeService(), fakeDom({ floats: () => [] }))
  const result = companion.reconcile(state, 's1', 900)
  const floats = sessionStateOf(result.state, 's1').floats
  assert.deepEqual(floats.map((item) => item.tabId), ['tab2']) // tab9 不在 openTabs → 回收
  assert.equal(floats[0].docked, true)
  assert.equal(result.changed, true)
})

test('原语归一化：无服务/缺方法/抛错一律 {ok:false}，不向外抛', () => {
  const noService = createFloatCompanion({ getService: () => undefined, getFocusId: () => 's1', dom: fakeDom(), log: () => {} })
  assert.equal(noService.activeRecord().reason, 'unavailable')
  assert.equal(noService.floatTab('tab2', { x: 0, y: 0, width: 1, height: 1 }).reason, 'unavailable')
  assert.equal(noService.openTabs().ok, false)
  assert.equal(noService.tabsIn('s1').ok, false)

  const throwing = fakeService({ floatError: new Error('boom') })
  const companion = create(throwing, fakeDom())
  const result = companion.floatTab('tab2', { x: 0, y: 0, width: 1, height: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'throw')
  assert.equal(result.error, 'boom')
  assert.equal(companion.floatTab(null).reason, 'no-tab')
  assert.equal(companion.dockPane(null).reason, 'no-pane')
})

test('原语调用：float/focus/dock/close/hide/toggleExpanded 透传参数；tabsIn 按会话', () => {
  const service = fakeService()
  const companion = create(service, fakeDom())
  companion.floatTab('tab2', { x: 1, y: 2, width: 3, height: 4 })
  companion.focusTab('tab2')
  companion.dockPane('float3')
  companion.closeTab('tab2')
  companion.hideTab('tab2')
  assert.equal(companion.isExpanded(), false)
  companion.toggleExpanded()
  assert.equal(companion.isExpanded(), true)
  assert.deepEqual(companion.tabsIn('s1').value.map((tab) => tab.id), ['tab2'])
  const methods = service.calls.map((call) => call[0])
  for (const name of ['float', 'focus', 'dock', 'close', 'hide', 'toggleExpanded', 'tabsIn']) {
    assert.ok(methods.includes(name), name)
  }
  assert.deepEqual(service.calls.find((call) => call[0] === 'float'), ['float', 'tab2', { x: 1, y: 2, width: 3, height: 4 }])
})
