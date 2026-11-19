import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RESOURCE_SCHEME,
  evaluateCompanion,
  evaluateCompanionGuard,
  isResourceAddress,
} from '../src/client/companion.js'

test('evaluateCompanion：跟随判定 + browser 能力', () => {
  const base = evaluateCompanion({ available: true, mounted: 'a', focusId: 'a', tabKinds: ['text', 'files'], expanded: true })
  assert.equal(base.available, true)
  assert.equal(base.followOk, true)
  assert.equal(base.expanded, true)
  assert.equal(base.hasBrowser, false)
  assert.deepEqual(base.tabKinds, ['text', 'files'])

  const mismatch = evaluateCompanion({ available: true, mounted: 'old', focusId: 'a', tabKinds: ['browser'] })
  assert.equal(mismatch.followOk, false)
  assert.equal(mismatch.hasBrowser, true)

  const none = evaluateCompanion({ available: false })
  assert.equal(none.followOk, false)
  assert.deepEqual(none.tabKinds, [])
})

test('evaluateCompanionGuard：焦点/候场/无主绑定', () => {
  assert.deepEqual(evaluateCompanionGuard({ focusId: 'a', candidates: ['b'] }), { ok: true, sessionId: 'a' })
  assert.deepEqual(evaluateCompanionGuard({ focusId: 'a', candidates: ['b'], sessionId: 'b' }), { ok: false, sessionId: 'b', reason: 'candidate' })
  assert.deepEqual(evaluateCompanionGuard({ focusId: 'a', candidates: [], sessionId: 'c' }), { ok: false, sessionId: 'c', reason: 'not-focus' })
  assert.deepEqual(evaluateCompanionGuard({ focusId: null, candidates: [] }), { ok: false, sessionId: null, reason: 'no-focus' })
  assert.deepEqual(evaluateCompanionGuard({ focusId: null, candidates: [], sessionId: 'x' }), { ok: false, sessionId: null, reason: 'no-focus' })
})

test('isResourceAddress：只接受 dsh-resource://', () => {
  assert.equal(RESOURCE_SCHEME, 'dsh-resource://')
  assert.equal(isResourceAddress('dsh-resource://text/abc'), true)
  assert.equal(isResourceAddress('https://example.com'), false)
  assert.equal(isResourceAddress('../file.md'), false)
  assert.equal(isResourceAddress(undefined), false)
})
