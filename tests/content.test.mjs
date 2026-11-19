import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyStatus, formatRelative } from '../src/client/status.js'
import { interpolate, DICTIONARIES, NS, STATUS_KEYS } from '../src/client/locale.js'
import { detectCapabilities, LIMITS, SLOTS, statusOf, statusesSnapshot } from '../src/client/adapter.js'

test('classifyStatus 覆盖 pending > unread > running > blank > idle', () => {
  assert.equal(classifyStatus({ pendingInteraction: { kind: 'approval' } }, {}).kind, 'pendingApproval')
  assert.equal(classifyStatus({ pendingInteraction: { kind: 'question' } }, {}).kind, 'pendingQuestion')
  assert.equal(classifyStatus({ pendingInteraction: { kind: 'plan' } }, {}).kind, 'pendingPlan')
  assert.equal(classifyStatus({ completionUnread: true }, {}).kind, 'completedUnread')
  assert.equal(classifyStatus({ running: true }, {}).kind, 'running')
  assert.equal(classifyStatus(null, { blank: true }).kind, 'blank')
  assert.equal(classifyStatus(null, {}).kind, 'idle')
  // pending 优先级高于 unread/running
  assert.equal(classifyStatus({ running: true, completionUnread: true, pendingInteraction: { kind: 'approval' } }, {}).kind, 'pendingApproval')
})

test('formatRelative 容错', () => {
  assert.equal(formatRelative(undefined), '')
  assert.equal(formatRelative(0), '')
  const now = Date.now()
  assert.ok(typeof formatRelative(now - 60000, now) === 'string')
})

test('locale 字典 zh/en 同键集 + 插值', () => {
  const zhKeys = Object.keys(DICTIONARIES.zh).sort()
  const enKeys = Object.keys(DICTIONARIES.en).sort()
  assert.deepEqual(zhKeys, enKeys)
  assert.ok(zhKeys.length > 20)
  assert.equal(NS, 'onestep')
  for (const key of Object.values(STATUS_KEYS)) assert.ok(DICTIONARIES.zh[key], 'missing zh ' + key)
  assert.equal(interpolate('会话“{title}”已完成', { title: 'X' }), '会话“X”已完成')
  assert.equal(interpolate('no params', undefined), 'no params')
  assert.equal(interpolate('{missing}'), '{missing}')
})

test('detectCapabilities：缺 slots 时 ok=false；可选服务缺失不阻塞', () => {
  const bad = detectCapabilities({ get: () => undefined })
  assert.equal(bad.ok, false)
  assert.ok(bad.missing.includes('slots.register/inject'))
  const good = detectCapabilities({
    slots: { register() {}, inject() {} },
    get: (name) => (name === 'sessions' ? {} : undefined),
  })
  assert.equal(good.ok, true)
  assert.deepEqual(good.missing, [])
  assert.equal(good.services.sessions, true)
  assert.equal(good.services.uiWorkspace, false)
  assert.equal(good.services.sidebarRight, false)
})

test('adapter 常量与槽名契约稳定', () => {
  assert.equal(SLOTS.main, 'main')
  assert.equal(SLOTS.mainKey, 'conversation')
  assert.equal(SLOTS.window, 'onestep.window')
  assert.equal(SLOTS.focus, 'onestep.focus')
  assert.equal(SLOTS.rowAction, 'sidebar.workspaces.session.row.action')
  assert.equal(LIMITS.maxCandidates, 12)
  assert.ok(LIMITS.railLeft.min < LIMITS.railLeft.default && LIMITS.railLeft.default < LIMITS.railLeft.max)
})

test('statusOf / statusesSnapshot 兼容 Map 与普通对象（useSessionStatus 是 Map）', () => {
  const map = new Map([
    ['a', { running: true }],
    ['b', { completionUnread: true }],
  ])
  assert.deepEqual(statusOf(map, 'a'), { running: true })
  assert.equal(statusOf(map, 'z'), undefined)
  assert.deepEqual(statusOf({ a: { running: true } }, 'a'), { running: true })
  assert.equal(statusOf(null, 'a'), undefined)
  assert.deepEqual(statusesSnapshot(map), { a: { running: true }, b: { completionUnread: true } })
  assert.deepEqual(statusesSnapshot({ x: 1 }), { x: 1 })
  assert.deepEqual(statusesSnapshot(undefined), {})
})
