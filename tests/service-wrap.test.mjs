/**
 * P3-2 compat 包装层单测（node:test）。
 *
 * 覆盖：能力自检 / 决策纯函数 / 槽位矩形校验 / 安装与还原 / 直通条件 /
 * 同步重定向调用序列（打开 → float 前取 active → float → 收起）/ 已管理分支 /
 * 官方异常原样抛出 / 包装层自身异常不外抛 / 重复包装与让位。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  WRAP_MARK,
  WRAPPED_METHODS,
  REQUIRED_METHODS,
  PLACEMENT_FIELDS,
  checkWrapSupport,
  decideOpen,
  normalizeRect,
  isWrapped,
  installServiceWrap,
} from '../src/client/service-wrap.js'

class FakeSidebar {
  constructor() {
    this.calls = []
    this.expanded = false
    this.record = null
    this.openError = null
    this.floatError = null
  }

  openResource(address, options) {
    this.calls.push({ method: 'openResource', address, options })
    if (this.openError) throw this.openError
    this.expanded = true
    this.record = { id: 'tab1', kind: 'text', contentId: address, title: 'file.md' }
  }

  openTab(kind, options) {
    this.calls.push({ method: 'openTab', kind, options })
    if (this.openError) throw this.openError
    this.expanded = true
    this.record = { id: 'tab2', kind, contentId: 'sidebar://' + kind, title: kind }
  }

  active() {
    this.calls.push({ method: 'active' })
    return this.record || undefined
  }

  isExpanded() {
    this.calls.push({ method: 'isExpanded' })
    return this.expanded
  }

  toggleExpanded() {
    this.calls.push({ method: 'toggleExpanded' })
    this.expanded = !this.expanded
  }

  float(tabId, rect) {
    this.calls.push({ method: 'float', tabId, rect })
    if (this.floatError) throw this.floatError
  }

  focus(tabId) {
    this.calls.push({ method: 'focus', tabId })
  }

  methodNames(filter) {
    return this.calls.filter((call) => !filter || call.method === filter || call.method === 'active' || call.method === 'isExpanded')
  }
}

const noopLog = () => {}

function install(service, policy) {
  return installServiceWrap({
    getService: () => service,
    log: noopLog,
    policy: { isEnabled: () => true, ...policy },
  })
}

test('checkWrapSupport：齐全 → ok；缺方法/无服务 → 列出 missing', () => {
  assert.deepEqual(checkWrapSupport(new FakeSidebar()), { ok: true, missing: [] })
  const partial = { openResource: () => {}, openTab: () => {} }
  const result = checkWrapSupport(partial)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'missing-method')
  assert.deepEqual(result.missing, REQUIRED_METHODS.filter((name) => typeof partial[name] !== 'function'))
  assert.equal(checkWrapSupport(undefined).reason, 'no-service')
})

test('decideOpen：默认放置才重定向；显式 placement 一律直通', () => {
  assert.deepEqual(decideOpen(undefined), { redirect: true, reason: 'default-placement' })
  assert.deepEqual(decideOpen({ params: { line: 7 } }), { redirect: true, reason: 'default-placement' })
  for (const field of PLACEMENT_FIELDS) {
    const result = decideOpen({ [field]: 'x' })
    assert.equal(result.redirect, false, field)
    assert.equal(result.reason, 'explicit-' + field)
  }
})

test('normalizeRect：合法值归一化；非法/缺字段/零尺寸 → null', () => {
  assert.deepEqual(normalizeRect({ x: 1, y: 2, width: 300, height: 400 }), { x: 1, y: 2, width: 300, height: 400 })
  assert.equal(normalizeRect(null), null)
  assert.equal(normalizeRect({ x: 1, y: 2, width: 0, height: 4 }), null)
  assert.equal(normalizeRect({ x: 'a', y: 2, width: 3, height: 4 }), null)
  assert.equal(normalizeRect({ x: 1, y: 2 }), null)
})

test('install：依赖缺失不安装也不改实例', () => {
  const partial = { openResource() {}, openTab() {}, active() {}, isExpanded() {}, toggleExpanded() {}, focus() {} }
  const before = partial.openResource
  const wrap = installServiceWrap({ getService: () => partial, policy: { isEnabled: () => true } })
  assert.equal(wrap.ok, false)
  assert.equal(wrap.reason, 'missing-method')
  assert.ok(wrap.missing.includes('float'))
  assert.equal(partial.openResource, before) // 未安装包装
})

test('install：默认禁用时完全直通（不读 active、不 float、不收起）', () => {
  const service = new FakeSidebar()
  const wrap = install(service, { isEnabled: () => false })
  assert.equal(wrap.ok, true)
  service.openResource('dsh-resource://file/session/s/README.md')
  assert.deepEqual(service.calls.map((call) => call.method), ['openResource'])
  assert.equal(service.expanded, true) // 官方行为保持（右栏展开）
  assert.equal(service.record.id, 'tab1')
  assert.equal(wrap.status().enabled, false)
  wrap.restore()
})

test('install：已展开右栏时直通（Q2 尊重手动右栏）', () => {
  const service = new FakeSidebar()
  service.expanded = true
  const wrap = install(service, {})
  service.openResource('dsh-resource://file/session/s/a.md')
  assert.deepEqual(service.calls.map((call) => call.method), ['isExpanded', 'openResource'])
  wrap.restore()
})

test('install：显式 destination/placement 直通', () => {
  const service = new FakeSidebar()
  const wrap = install(service, {})
  service.openResource('dsh-resource://file/session/s/a.md', { destination: 'float' })
  service.openTab('browser', { paneId: 'pane1' })
  assert.deepEqual(service.calls.map((call) => call.method), ['openResource', 'openTab'])
  wrap.restore()
})

test('install：默认打开 → 打开后、float 前取 active；float(rect)；收起本次展开', () => {
  const service = new FakeSidebar()
  const managed = []
  const rect = { x: 1076, y: 16, width: 348, height: 868 }
  const wrap = install(service, {
    planOpen: () => ({ rect }),
    onManaged: (record, applied) => managed.push({ id: record.id, rect: applied }),
  })
  service.openResource('dsh-resource://file/session/s/README.md')
  assert.deepEqual(service.calls.map((call) => call.method), [
    'isExpanded', // beforeExpanded
    'openResource',
    'active', // float 前取 tabId
    'float',
    'isExpanded', // 收起判定
    'toggleExpanded',
  ])
  assert.deepEqual(service.calls.find((call) => call.method === 'float'), { method: 'float', tabId: 'tab1', rect })
  assert.equal(service.expanded, false)
  assert.equal(managed.length, 1)
  assert.equal(managed[0].id, 'tab1')
  assert.equal(wrap.status().redirectCount, 1)
  wrap.restore()
})

test('install：openTab 路径同样重定向（页面无 destination）', () => {
  const service = new FakeSidebar()
  const wrap = install(service, { planOpen: () => ({ rect: { x: 0, y: 0, width: 300, height: 400 } }) })
  service.openTab('terminal')
  const methods = service.calls.map((call) => call.method)
  assert.deepEqual(methods, ['isExpanded', 'openTab', 'active', 'float', 'isExpanded', 'toggleExpanded'])
  assert.equal(service.calls.find((call) => call.method === 'float').tabId, 'tab2')
  wrap.restore()
})

test('install：已管理浮窗 → 只 focus 抬升，不再 float', () => {
  const service = new FakeSidebar()
  const wrap = install(service, { isManaged: (tabId) => tabId === 'tab1', planOpen: () => ({ rect: { x: 0, y: 0, width: 1, height: 1 } }) })
  service.openResource('dsh-resource://file/session/s/a.md')
  const methods = service.calls.map((call) => call.method)
  assert.ok(methods.includes('focus'))
  assert.equal(methods.includes('float'), false)
  assert.equal(methods.includes('toggleExpanded'), false)
  wrap.restore()
})

test('install：已管理且收起 → onRevealManaged 展开并跳过额外 focus（发布前修复）', () => {
  const service = new FakeSidebar()
  const revealed = []
  const wrap = install(service, {
    isManaged: (tabId) => tabId === 'tab1',
    onRevealManaged: (record) => {
      revealed.push(record && record.id)
      return true
    },
    planOpen: () => ({ rect: { x: 0, y: 0, width: 1, height: 1 } }),
  })
  service.openResource('dsh-resource://file/session/s/a.md')
  const methods = service.calls.map((call) => call.method)
  assert.deepEqual(revealed, ['tab1'])
  assert.equal(methods.includes('focus'), false) // 展开路径已含聚焦，不再补一次
  assert.equal(methods.includes('float'), false)
  assert.equal(wrap.status().followUpErrorCount, 0)
  wrap.restore()
})

test('install：已管理但未收起（onRevealManaged=false）→ 仍 focus 抬升', () => {
  const service = new FakeSidebar()
  const wrap = install(service, {
    isManaged: (tabId) => tabId === 'tab1',
    onRevealManaged: () => false,
    planOpen: () => ({ rect: { x: 0, y: 0, width: 1, height: 1 } }),
  })
  service.openResource('dsh-resource://file/session/s/a.md')
  const methods = service.calls.map((call) => call.method)
  assert.equal(methods.includes('focus'), true)
  assert.equal(methods.includes('float'), false)
  wrap.restore()
})

test('install：onRevealManaged 抛错 → 不抛给调用方、计数并回退 focus', () => {
  const service = new FakeSidebar()
  const logs = []
  const wrap = installServiceWrap({
    getService: () => service,
    log: (event) => logs.push(event),
    policy: {
      isEnabled: () => true,
      isManaged: (tabId) => tabId === 'tab1',
      onRevealManaged: () => {
        throw new Error('reveal boom')
      },
      planOpen: () => ({ rect: { x: 0, y: 0, width: 1, height: 1 } }),
    },
  })
  assert.doesNotThrow(() => service.openResource('dsh-resource://file/session/s/a.md'))
  const methods = service.calls.map((call) => call.method)
  assert.equal(methods.includes('focus'), true)
  assert.ok(logs.includes('wrap.reveal.error'))
  assert.equal(wrap.status().followUpErrorCount, 1)
  wrap.restore()
})

test('install：已管理且已展开 → onFocusManaged 高亮后仍 focus 抬升（0.7.0）', () => {
  const service = new FakeSidebar()
  const highlighted = []
  const wrap = install(service, {
    isManaged: (tabId) => tabId === 'tab1',
    onRevealManaged: () => false,
    onFocusManaged: (record) => {
      highlighted.push(record && record.id)
      return true
    },
  })
  service.openResource('dsh-resource://file/session/s/a.md')
  const methods = service.calls.map((call) => call.method)
  assert.deepEqual(highlighted, ['tab1'])
  assert.equal(methods.includes('focus'), true) // 层级抬升仍由官方 focus 完成
  assert.equal(methods.includes('float'), false) // 不重复展开
  wrap.restore()
})

test('install：onFocusManaged 抛错 → 不抛给调用方、计数并仍 focus', () => {
  const service = new FakeSidebar()
  const logs = []
  const wrap = installServiceWrap({
    getService: () => service,
    log: (event) => logs.push(event),
    policy: {
      isEnabled: () => true,
      isManaged: (tabId) => tabId === 'tab1',
      onRevealManaged: () => false,
      onFocusManaged: () => { throw new Error('flash boom') },
    },
  })
  assert.doesNotThrow(() => service.openResource('dsh-resource://file/session/s/a.md'))
  const methods = service.calls.map((call) => call.method)
  assert.equal(methods.includes('focus'), true)
  assert.ok(logs.includes('wrap.focus.highlight.error'))
  assert.equal(wrap.status().followUpErrorCount, 1)
  wrap.restore()
})

test('install：onRevealManaged=true 时不同时触发 onFocusManaged', () => {
  const service = new FakeSidebar()
  let focusHook = 0
  const wrap = install(service, {
    isManaged: (tabId) => tabId === 'tab1',
    onRevealManaged: () => true,
    onFocusManaged: () => {
      focusHook += 1
      return true
    },
  })
  service.openResource('dsh-resource://file/session/s/a.md')
  const methods = service.calls.map((call) => call.method)
  assert.equal(focusHook, 0)
  assert.equal(methods.includes('focus'), false)
  wrap.restore()
})

test('install：无槽位 / 矩形非法 → 不 float、不收起（结果留在官方右栏）', () => {
  for (const planOpen of [() => null, () => ({ rect: null }), () => ({ rect: { x: 0, y: 0, width: -1, height: 10 } })]) {
    const service = new FakeSidebar()
    const wrap = install(service, { planOpen })
    service.openResource('dsh-resource://file/session/s/a.md')
    const methods = service.calls.map((call) => call.method)
    assert.equal(methods.includes('float'), false)
    assert.equal(service.expanded, true) // 官方打开结果保留
    wrap.restore()
  }
})

test('install：active() 为空 → 不 float', () => {
  class NoActiveSidebar extends FakeSidebar {
    openResource(address, options) {
      super.openResource(address, options)
      this.record = null
    }
  }
  const service = new NoActiveSidebar()
  const wrap = install(service, { planOpen: () => ({ rect: { x: 0, y: 0, width: 10, height: 10 } }) })
  service.openResource('dsh-resource://file/session/s/a.md')
  assert.equal(service.calls.some((call) => call.method === 'float'), false)
  wrap.restore()
})

test('install：官方打开异常原样抛出，且不做后续重定向', () => {
  const service = new FakeSidebar()
  const failure = new Error('sidebarRight: no registered tab type claims "dsh-resource://bad"')
  service.openError = failure
  const wrap = install(service, { planOpen: () => ({ rect: { x: 0, y: 0, width: 10, height: 10 } }) })
  assert.throws(() => service.openResource('dsh-resource://bad'), (error) => error === failure)
  assert.equal(service.calls.some((call) => call.method === 'float'), false)
  wrap.restore()
})

test('install：包装层自身异常（float 抛错）不抛给调用方，结果留在官方右栏', () => {
  const service = new FakeSidebar()
  service.floatError = new Error('float failed')
  const logs = []
  const wrap = installServiceWrap({
    getService: () => service,
    log: (event) => logs.push(event),
    policy: { isEnabled: () => true, planOpen: () => ({ rect: { x: 0, y: 0, width: 10, height: 10 } }) },
  })
  assert.doesNotThrow(() => service.openResource('dsh-resource://file/session/s/a.md'))
  assert.ok(logs.includes('wrap.followup.error'))
  assert.equal(service.expanded, true) // 打开结果留在官方
  assert.equal(wrap.status().followUpErrorCount, 1)
  wrap.restore()
})

test('install：policy 抛错按禁用处理（直通）', () => {
  const service = new FakeSidebar()
  const wrap = installServiceWrap({
    getService: () => service,
    policy: {
      isEnabled: () => {
        throw new Error('boom')
      },
    },
  })
  assert.doesNotThrow(() => service.openResource('dsh-resource://file/session/s/a.md'))
  assert.deepEqual(service.calls.map((call) => call.method), ['openResource'])
  wrap.restore()
})

test('install：方法标记、重复包装让位、prototype 方法不被改写', () => {
  const service = new FakeSidebar()
  const wrap = install(service, {})
  for (const method of WRAPPED_METHODS) {
    assert.equal(typeof service[method], 'function')
    assert.equal(service[method][WRAP_MARK], true)
    assert.equal(service[method] === FakeSidebar.prototype[method], false)
  }
  assert.equal(isWrapped(service), true)
  assert.equal(FakeSidebar.prototype.openResource.name, 'openResource')
  assert.equal(install(service, {}).reason, 'already-wrapped')
  wrap.restore()
})

test('install：实例已有他人 own-property 方法时让位（不争抢）', () => {
  const service = new FakeSidebar()
  service.openTab = function foreign() {}
  const wrap = installServiceWrap({ getService: () => service, log: noopLog, policy: { isEnabled: () => true } })
  assert.equal(wrap.ok, false)
  assert.equal(wrap.reason, 'instance-patched:openTab')
  assert.equal(Object.prototype.hasOwnProperty.call(service, 'openResource'), false)
})

test('restore：还原原型方法、幂等；被他人替换时跳过', () => {
  const service = new FakeSidebar()
  const wrap = install(service, {})
  assert.equal(Object.prototype.hasOwnProperty.call(service, 'openResource'), true)
  const first = wrap.restore()
  assert.deepEqual(first, { ok: true, restored: 2 })
  assert.equal(service.openResource, FakeSidebar.prototype.openResource)
  assert.equal(Object.prototype.hasOwnProperty.call(service, 'openResource'), false)
  assert.equal(isWrapped(service), false)
  assert.deepEqual(wrap.restore(), { ok: true, restored: 0 })

  const wrap2 = install(service, {})
  service.openResource = function replaced() {}
  const second = wrap2.restore()
  assert.equal(second.restored, 1) // openTab 还原，openResource 已被替换则跳过
  assert.equal(service.openResource.name, 'replaced')
})
