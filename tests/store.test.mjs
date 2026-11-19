import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addCandidate,
  candidateIds,
  createStageStore,
  defaultStageState,
  effectivePreviewMode,
  evaluateAutoLite,
  isStageActive,
  loadPersisted,
  normalizeState,
  reconcile,
  removeCandidate,
  serializePersisted,
  setRailSide,
  setRailSize,
  setPreviewMode,
} from '../src/client/store.js'

const far = 1000

test('default state inactive with 3 slots', () => {
  const state = defaultStageState()
  assert.equal(isStageActive(state), false)
  assert.equal(state.candidates.length, 0)
  assert.equal(normalizeState(undefined).railSide, 'left')
  // v3 起候场卡默认实时缩略画面（live，等比缩放 + 隐藏输入区）
  assert.equal(state.previewMode, 'live')
})

test('v1/v2 persistence migrates to v3 (live thumbnail) while keeping roster', () => {
  const storage = {
    data: new Map(),
    getItem(key) { return this.data.has(key) ? this.data.get(key) : null },
    setItem(key, value) { this.data.set(key, value) },
  }
  const legacy = {
    version: 1,
    candidates: [{ sessionId: 's1', addedAt: 1, lastFocusedAt: 2 }],
    railSide: 'left',
    railSize: 232,
    railCollapsed: false,
    previewMode: 'live',
    autoLite: true,
    persistStage: true,
    reducedMotion: 'system',
  }
  storage.setItem('dsh.onestep.v1', JSON.stringify(legacy))
  const loaded = loadPersisted(storage, 'dsh.onestep.v1')
  assert.equal(loaded.version, 3)
  assert.equal(loaded.previewMode, 'live')
  assert.deepEqual(loaded.candidates.map((item) => item.sessionId), ['s1'])
  // v2 也迁移到 v3
  storage.setItem('dsh.onestep.v1', JSON.stringify({ ...legacy, version: 2, previewMode: 'card' }))
  const loaded2 = loadPersisted(storage, 'dsh.onestep.v1')
  assert.equal(loaded2.version, 3)
  assert.equal(loaded2.previewMode, 'live')
  // 未知版本仍拒绝
  storage.setItem('dsh.onestep.v1', JSON.stringify({ version: 99, candidates: [] }))
  assert.equal(loadPersisted(storage, 'dsh.onestep.v1'), null)
})

test('addCandidate dedupes + 上限 12 内不淘汰、第 13 个淘汰最久未用', () => {
  let state = defaultStageState()
  const a = addCandidate(state, 's1', 1)
  state = a.state
  assert.equal(a.added, true)
  const dup = addCandidate(state, 's1', 5)
  assert.equal(dup.existed, true)
  state = dup.state
  assert.equal(state.candidates.length, 1)
  assert.equal(state.candidates[0].lastFocusedAt, 5)
  // 0.6.0：上限 12 —— 第 2..12 个都不应淘汰
  for (let index = 2; index <= 12; index += 1) {
    const result = addCandidate(state, 's' + index, index * 10)
    state = result.state
    assert.equal(result.evicted, null, '第 ' + index + ' 个不应淘汰')
    assert.equal(state.candidates.length, index)
  }
  assert.deepEqual(candidateIds(state), ['s12', 's11', 's10', 's9', 's8', 's7', 's6', 's5', 's4', 's3', 's2', 's1'])
  // 第 13 个：淘汰 lastFocusedAt 最小的 s1，新加入者插到头部
  const thirteenth = addCandidate(state, 's13', 130)
  assert.equal(thirteenth.evicted, 's1')
  assert.deepEqual(candidateIds(thirteenth.state), ['s13', 's12', 's11', 's10', 's9', 's8', 's7', 's6', 's5', 's4', 's3', 's2'])
})

test('normalizeState：持久化候选超过上限时保留前 12 个且去重', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'a']
  const raw = {
    version: 3,
    candidates: ids.map((sessionId) => ({ sessionId })),
    railSide: 'left',
    railSize: 232,
    previewMode: 'live',
  }
  const state = normalizeState(raw)
  assert.deepEqual(candidateIds(state), ids.slice(0, 12))
})

test('removeCandidate reports removal', () => {
  let state = addCandidate(defaultStageState(), 's1', 1).state
  const missing = removeCandidate(state, 'nope')
  assert.equal(missing.removed, false)
  assert.equal(missing.state, state)
  const removed = removeCandidate(state, 's1')
  assert.equal(removed.removed, true)
  assert.equal(isStageActive(removed.state), false)
})

test('reconcile drops missing/main and adds previous focus on switch', () => {
  let state = defaultStageState()
  state = addCandidate(state, 's1', 1).state
  state = addCandidate(state, 's2', 2).state
  state = addCandidate(state, 's3', 3).state
  const byId = { s2: {}, s3: {}, s4: {} }
  const first = reconcile(state, { byId, mainId: 's4', prevMainId: null })
  assert.deepEqual(first.dropped, ['s1'])
  assert.equal(first.changed, true)
  assert.deepEqual(candidateIds(first.state), ['s3', 's2'])
  const switched = reconcile(first.state, { byId, mainId: 's2', prevMainId: 's4' })
  assert.equal(switched.addedPrevFocus, true)
  assert.deepEqual(candidateIds(switched.state), ['s4', 's3'])
  // 主绑定变化：新焦点从候场移除，旧焦点插入候场头部
  const third = reconcile(switched.state, { byId, mainId: 's3', prevMainId: 's2' })
  assert.deepEqual(candidateIds(third.state), ['s2', 's4'])
})

test('rain side/size/preview setters clamp and skip no-ops', () => {
  const state = defaultStageState()
  const top = setRailSide(state, 'top')
  assert.equal(top.railSide, 'top')
  assert.equal(top.railSize, 132)
  assert.equal(setRailSide(top, 'top'), top)
  const wide = setRailSize(top, 9999)
  assert.equal(wide.railSize, 220)
  const narrow = setRailSize(top, 1)
  assert.equal(narrow.railSize, 108)
  assert.equal(setPreviewMode(state, 'card').previewMode, 'card')
  assert.equal(setPreviewMode(state, 'card').previewMode, 'card')
})

test('persistence round trip and corruption tolerance', () => {
  const state = addCandidate(defaultStageState(), 's1', 1).state
  const payload = serializePersisted(state)
  const storage = {
    data: new Map(),
    getItem(key) {
      return this.data.has(key) ? this.data.get(key) : null
    },
    setItem(key, value) {
      this.data.set(key, value)
    },
  }
  storage.setItem('dsh.onestep.v1', JSON.stringify(payload))
  const loaded = loadPersisted(storage, 'dsh.onestep.v1')
  assert.deepEqual(loaded.candidates.map((item) => item.sessionId), ['s1'])
  storage.setItem('dsh.onestep.v1', '{broken')
  assert.equal(loadPersisted(storage, 'dsh.onestep.v1'), null)
  storage.setItem('dsh.onestep.v1', JSON.stringify({ version: 99, candidates: [{ sessionId: 'x' }] }))
  assert.equal(loadPersisted(storage, 'dsh.onestep.v1'), null)
})

test('createStageStore persists on flush and notifies subscribers', () => {
  const writes = []
  const storage = { getItem: () => null, setItem: (_key, value) => writes.push(value) }
  const store = createStageStore({ storage, persistDelayMs: 5 })
  let changes = 0
  const unsubscribe = store.subscribe(() => { changes += 1 })
  store.addCandidate('s1')
  assert.equal(changes, 1)
  assert.equal(isStageActive(store.getSnapshot()), true)
  store.flush()
  assert.equal(writes.length, 1)
  assert.deepEqual(JSON.parse(writes[0]).candidates.map((item) => item.sessionId), ['s1'])
  unsubscribe()
  store.setPreviewMode('card')
  assert.equal(changes, 1)
  store.dispose()
})

test('far-future timestamps do not break LRU order', () => {
  let state = defaultStageState()
  // 0.6.0 上限 12：先填满 12 个，第 13 个淘汰 lastFocusedAt 最小的 a
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']
  for (const [index, id] of ids.entries()) {
    state = addCandidate(state, id, far + index).state
  }
  const next = addCandidate(state, 'm', far + 12)
  assert.equal(next.evicted, 'a')
  assert.deepEqual(candidateIds(next.state), ['m', 'l', 'k', 'j', 'i', 'h', 'g', 'f', 'e', 'd', 'c', 'b'])
})

/* ---------- P2-3 自动 lite 降级判定（产品报告 §11.3；边界覆盖） ---------- */

test('evaluateAutoLite：4 窗 + 首帧超预算 → 精简候场；等于阈值不降级', () => {
  const atLimit = evaluateAutoLite({ windows: 4, firstFrameMs: 900 })
  assert.equal(atLimit.degrade, false)
  assert.equal(atLimit.reason, 'within-budget')
  const over = evaluateAutoLite({ windows: 4, firstFrameMs: 901 })
  assert.equal(over.degrade, true)
  assert.equal(over.target, 'lite')
  assert.equal(over.applied, 'lite')
  assert.equal(over.reason, 'first-frame')
  assert.equal(over.thresholds.firstFrameMs, 900)
  assert.equal(over.metrics.firstFrameMs, 901)
})

test('evaluateAutoLite：窗口数不足不评估；关闭开关/手动覆盖优先', () => {
  assert.equal(evaluateAutoLite({ windows: 3, firstFrameMs: 5000 }).reason, 'below-window-threshold')
  assert.equal(evaluateAutoLite({ windows: 4, firstFrameMs: 5000 }).degrade, true)
  const disabled = evaluateAutoLite({ windows: 4, firstFrameMs: 5000, enabled: false })
  assert.equal(disabled.degrade, false)
  assert.equal(disabled.reason, 'disabled')
  const manual = evaluateAutoLite({ windows: 4, firstFrameMs: 5000, manualOverride: true })
  assert.equal(manual.degrade, false)
  assert.equal(manual.reason, 'manual-override')
  // long-task 单独触发（首帧未超标）
  const longTask = evaluateAutoLite({ windows: 4, firstFrameMs: 200, longTaskTotalMs: 401 })
  assert.equal(longTask.reason, 'long-task')
  assert.equal(longTask.applied, 'lite')
  assert.equal(evaluateAutoLite({ windows: 4, firstFrameMs: 200, longTaskTotalMs: 400 }).degrade, false)
})

test('evaluateAutoLite：内存/连续低帧率是极简档信号；v1.1 未接线时回退 lite', () => {
  const memory = evaluateAutoLite({ windows: 4, firstFrameMs: 200, memoryDeltaMB: 201 })
  assert.equal(memory.target, 'minimal')
  assert.equal(memory.applied, 'lite')
  assert.equal(memory.fallback, true)
  assert.equal(memory.reason, 'memory')
  const fps = evaluateAutoLite({ windows: 4, firstFrameMs: 200, sustainedLowFps: true })
  assert.equal(fps.reason, 'sustained-low-fps')
  assert.equal(fps.applied, 'lite')
  const minimal = evaluateAutoLite({ windows: 4, memoryDeltaMB: 300 }, { minimalEnabled: true })
  assert.equal(minimal.applied, 'minimal')
  // 未采样（null/非数字）不误触发；阈值可配置覆盖
  const noMetric = evaluateAutoLite({ windows: 4 })
  assert.equal(noMetric.degrade, false)
  assert.equal(noMetric.reason, 'within-budget')
  assert.equal(evaluateAutoLite({ windows: 4, firstFrameMs: 1000 }, { firstFrameMs: 2000 }).degrade, false)
})

test('effectivePreviewMode：自动降级只覆盖渲染，不改用户保存档位', () => {
  assert.equal(effectivePreviewMode({ previewMode: 'live' }, false), 'live')
  assert.equal(effectivePreviewMode({ previewMode: 'live' }, true), 'card')
  assert.equal(effectivePreviewMode({ previewMode: 'card' }, false), 'card')
  assert.equal(effectivePreviewMode({ previewMode: 'card' }, true), 'card')
  assert.equal(effectivePreviewMode(null, true), 'card')
  assert.equal(effectivePreviewMode(undefined, false), 'live')
})

