/**
 * P3-3 伴生窗自有状态单测（node:test）：形态 / managed 浮窗元数据 / peek / 坏键容错。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  COMPANION_STORAGE_KEY,
  COMPANION_STATE_VERSION,
  DEFAULT_MODE,
  createCompanionState,
  sanitizeUi,
  peekTopOf,
  setPeekTop,
  normalizeMode,
  sanitizeFloat,
  sanitizeSessionState,
  parseCompanionState,
  loadCompanionState,
  saveCompanionState,
  sessionStateOf,
  modeOf,
  setMode,
  upsertFloat,
  updateFloats,
  removeFloat,
  markPeeked,
  markAllPeeked,
  touchFloat,
  evictOldest,
  countFloats,
  markAllDocked,
} from '../src/client/float-state.js'

function fakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}))
  return {
    calls: { get: 0, set: 0 },
    getItem(key) {
      this.calls.get += 1
      return map.has(key) ? map.get(key) : null
    },
    setItem(key, value) {
      this.calls.set += 1
      map.set(key, value)
    },
    raw: map,
  }
}

const record = (tabId, extra = {}) => ({ tabId, paneId: 'float-' + tabId, kind: 'text', title: tabId + '.md', slot: 0, peeked: false, lastFocusedAt: 1, ...extra })

test('createCompanionState：空状态形状与版本', () => {
  const state = createCompanionState(123)
  assert.deepEqual(state, { version: COMPANION_STATE_VERSION, updatedAt: 123, bySession: {} })
  assert.equal(COMPANION_STORAGE_KEY, 'dsh.onestep.companion.v1')
  assert.equal(DEFAULT_MODE, 'float')
  assert.equal(normalizeMode('split'), 'split')
  assert.equal(normalizeMode('weird'), 'float')
  assert.equal(normalizeMode(undefined), 'float')
})

test('sanitizeFloat：必需 tabId；字段类型兜底、slot 越界置空、标题截断', () => {
  assert.equal(sanitizeFloat(null), null)
  assert.equal(sanitizeFloat({ tabId: '  ' }), null)
  const clean = sanitizeFloat({ tabId: 'tab2', slot: 99, title: 'x'.repeat(200), lastFocusedAt: '5', peeked: 1 })
  assert.equal(clean.slot, null)
  assert.equal(clean.title.length, 120)
  assert.equal(clean.lastFocusedAt, 5)
  assert.equal(clean.peeked, false) // 只认严格 true
  assert.equal(clean.paneId, null)
  assert.equal(clean.kind, '')
})

test('sanitizeSessionState：mode 归一、按 tabId 去重（后者覆盖）、条数上限 8', () => {
  const floats = [record('a'), record('b'), record('a', { title: 'a-new.md' })]
  for (let index = 0; index < 10; index += 1) floats.push(record('extra' + index))
  const session = sanitizeSessionState({ mode: 'split', floats })
  assert.equal(session.mode, 'split')
  assert.ok(session.floats.length <= 8)
  const a = session.floats.filter((item) => item.tabId === 'a')
  assert.equal(a.length, 1)
  assert.equal(a[0].title, 'a-new.md')
  assert.deepEqual(sanitizeSessionState(undefined), { mode: 'float', floats: [] })
})

test('parseCompanionState：空/坏 JSON/非对象/版本不符 → 默认且原因明确', () => {
  assert.equal(parseCompanionState(null).reason, 'empty')
  assert.equal(parseCompanionState('').reason, 'empty')
  assert.equal(parseCompanionState('{bad').reason, 'bad-json')
  assert.equal(parseCompanionState([1, 2]).reason, 'not-object')
  assert.equal(parseCompanionState({ version: 0, bySession: {} }).reason, 'version-mismatch')
  const fallback = parseCompanionState({ version: 0 }, 9).state
  assert.deepEqual(fallback, { version: COMPANION_STATE_VERSION, updatedAt: 9, bySession: {} })
})

test('parseCompanionState：合法状态清洗（含未知会话结构兜底）', () => {
  const parsed = parseCompanionState({
    version: COMPANION_STATE_VERSION,
    updatedAt: 5,
    bySession: {
      s1: { mode: 'split', floats: [record('tab2', { slot: 1 })] },
      s2: { mode: 'nope', floats: 'x' },
    },
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.state.bySession.s1.mode, 'split')
  assert.equal(parsed.state.bySession.s1.floats[0].tabId, 'tab2')
  assert.deepEqual(parsed.state.bySession.s2, { mode: 'float', floats: [] })
})

test('load/save：roundtrip、键名正确、updatedAt 更新、坏存储不抛', () => {
  const storage = fakeStorage()
  const state = upsertFloat(setMode(createCompanionState(), 's1', 'split'), 's1', record('tab2'))
  const saved = saveCompanionState(storage, state, 1000)
  assert.equal(saved.ok, true)
  assert.equal(saved.saved.updatedAt, 1000)
  assert.equal(storage.calls.set, 1)
  assert.ok(storage.raw.get(COMPANION_STORAGE_KEY).includes('"tab2"'))
  const loaded = loadCompanionState(storage)
  assert.equal(loaded.ok, true)
  assert.equal(loaded.state.bySession.s1.mode, 'split')
  assert.equal(loaded.state.bySession.s1.floats[0].tabId, 'tab2')

  assert.equal(loadCompanionState(null).reason, 'no-storage')
  assert.equal(loadCompanionState({ getItem() { throw new Error('quota') } }).reason, 'storage-error')
  assert.equal(saveCompanionState({ setItem() { throw new Error('quota') } }, state).reason, 'storage-error')
  const bad = fakeStorage({ [COMPANION_STORAGE_KEY]: '{bad' })
  assert.deepEqual(loadCompanionState(bad).reason, 'bad-json')
})

test('sessionStateOf/modeOf：未知会话回默认', () => {
  const state = createCompanionState()
  assert.deepEqual(sessionStateOf(state, 'unknown'), { mode: 'float', floats: [] })
  assert.equal(modeOf(state, null), 'float')
  const split = setMode(state, 's1', 'split')
  assert.equal(modeOf(split, 's1'), 'split')
  assert.equal(modeOf(state, 's1'), 'float') // 不可变
})

test('upsertFloat：新增/覆盖同一 tabId、槽位与 peek 更新、保留其他会话', () => {
  let state = createCompanionState()
  state = upsertFloat(state, 's1', record('tab2', { slot: 0 }))
  state = upsertFloat(state, 's1', record('tab4', { slot: 1 }))
  state = upsertFloat(state, 's2', record('tab9'))
  assert.equal(sessionStateOf(state, 's1').floats.length, 2)
  state = upsertFloat(state, 's1', record('tab2', { slot: 2, title: 'v2.md' }))
  const s1 = sessionStateOf(state, 's1')
  assert.equal(s1.floats.length, 2)
  assert.equal(s1.floats.find((item) => item.tabId === 'tab2').slot, 2)
  assert.equal(s1.floats.find((item) => item.tabId === 'tab2').title, 'v2.md')
  assert.equal(sessionStateOf(state, 's2').floats.length, 1)
})

test('updateFloats/removeFloat：批量写回与删除', () => {
  let state = createCompanionState()
  state = upsertFloat(state, 's1', record('tab2'))
  state = upsertFloat(state, 's1', record('tab4'))
  state = updateFloats(state, 's1', [record('tab2', { peeked: true })])
  assert.deepEqual(sessionStateOf(state, 's1').floats.map((item) => item.tabId), ['tab2'])
  assert.equal(sessionStateOf(state, 's1').floats[0].peeked, true)
  const removed = removeFloat(state, 's1', 'tab2')
  assert.deepEqual(sessionStateOf(removed, 's1').floats, [])
  assert.equal(removeFloat(state, 's1', 'missing'), state) // 无变化原样返回
})

test('markPeeked/markAllPeeked/touchFloat：收起、全部收起、聚焦抬升', () => {
  let state = createCompanionState()
  state = upsertFloat(state, 's1', record('a', { lastFocusedAt: 1 }))
  state = upsertFloat(state, 's1', record('b', { lastFocusedAt: 2 }))
  const one = markPeeked(state, 's1', 'a', true)
  assert.equal(sessionStateOf(one, 's1').floats.find((item) => item.tabId === 'a').peeked, true)
  assert.equal(sessionStateOf(one, 's1').floats.find((item) => item.tabId === 'b').peeked, false)
  const all = markAllPeeked(state, 's1', true)
  assert.equal(countFloats(all, 's1').peeked, 2)
  assert.equal(countFloats(all, 's1').visible, 0)
  const touched = touchFloat(all, 's1', 'a', 99)
  const a = sessionStateOf(touched, 's1').floats.find((item) => item.tabId === 'a')
  assert.equal(a.lastFocusedAt, 99)
  assert.equal(a.peeked, false)
})

test('evictOldest：选最久未聚焦的未收起浮窗并标记 peek；全收起返回 null；不修改入参', () => {
  let state = createCompanionState()
  state = upsertFloat(state, 's1', record('a', { lastFocusedAt: 30 }))
  state = upsertFloat(state, 's1', record('b', { lastFocusedAt: 10 }))
  state = upsertFloat(state, 's1', record('c', { lastFocusedAt: 5, peeked: true }))
  const before = JSON.stringify(state)
  const result = evictOldest(state, 's1')
  assert.equal(result.evicted.tabId, 'b')
  assert.equal(sessionStateOf(result.state, 's1').floats.find((item) => item.tabId === 'b').peeked, true)
  assert.equal(JSON.stringify(state), before)
  const allPeeked = markAllPeeked(state, 's1', true)
  assert.equal(evictOldest(allPeeked, 's1').evicted, null)
  assert.equal(evictOldest(createCompanionState(), 's1').evicted, null)
})

test('countFloats：总数/收起/可见/已收回右栏', () => {
  let state = createCompanionState()
  state = upsertFloat(state, 's1', record('a'))
  state = upsertFloat(state, 's1', record('b', { peeked: true }))
  state = upsertFloat(state, 's1', record('c', { docked: true }))
  assert.deepEqual(countFloats(state, 's1'), { total: 3, peeked: 1, visible: 1, docked: 1 })
  assert.deepEqual(countFloats(state, 'nope'), { total: 0, peeked: 0, visible: 0, docked: 0 })
})

test('docked：清洗保留、markAllDocked/单条切换、docked 不算可见', () => {
  assert.equal(sanitizeFloat({ tabId: 'tab2', docked: true }).docked, true)
  assert.equal(sanitizeFloat({ tabId: 'tab2' }).docked, false)
  let state = upsertFloat(createCompanionState(), 's1', record('a'))
  state = upsertFloat(state, 's1', record('b', { docked: true }))
  const allDocked = markAllDocked(state, 's1', true)
  assert.equal(countFloats(allDocked, 's1').docked, 2)
  assert.equal(countFloats(allDocked, 's1').visible, 0)
  const reopened = markAllDocked(allDocked, 's1', false)
  assert.equal(countFloats(reopened, 's1').docked, 0)
  assert.equal(countFloats(reopened, 's1').visible, 2)
})

test('ui.peekTop：默认 null、清洗/设置/持久化往返', () => {
  assert.equal(peekTopOf(createCompanionState()), null)
  assert.deepEqual(sanitizeUi(null), { peekTop: null })
  assert.deepEqual(sanitizeUi({ peekTop: 56 }), { peekTop: 56 })
  assert.deepEqual(sanitizeUi({ peekTop: -3 }), { peekTop: null })
  assert.deepEqual(sanitizeUi({ peekTop: 'oops' }), { peekTop: null })
  assert.deepEqual(sanitizeUi({ peekTop: 999999 }), { peekTop: 10000 })
  const state = setPeekTop(createCompanionState(), 120)
  assert.equal(peekTopOf(state), 120)
  assert.equal(peekTopOf(setPeekTop(state, null)), null)
  assert.equal(parseCompanionState(JSON.stringify(state)).state.ui.peekTop, 120)
  // 旧状态没有 ui 字段 → 回默认 null，不丢会话数据
  const legacy = { version: COMPANION_STATE_VERSION, updatedAt: 1, bySession: {} }
  assert.equal(parseCompanionState(JSON.stringify(legacy)).state.ui.peekTop, null)
})
