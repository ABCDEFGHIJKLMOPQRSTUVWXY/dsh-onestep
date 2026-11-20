/**
 * CSS 语法回归：styles.js 的 CSS 文本必须能被浏览器解析为真实规则。
 *
 * 背景（0.7.0 发布前审查）：13 条规则曾被整行双引号包成字符串 token，浏览器把这些行当作
 * 无效 selector 前奏，连带吞掉其后的 .onestep-rail-mini 规则——单测此前只用 includes() 查子串，
 * 无法发现。这里用结构断言（行首引号 / 引号配对 / 花括号配平 / 关键选择器存在）覆盖该类缺陷；
 * 真实 CSSOM 解析由浏览器侧校验补充（见发布前审查证据）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { CSS } from '../src/client/styles.js'

test('CSS：没有任何规则行以双引号包住整条规则（字符串 token 会被浏览器丢弃）', () => {
  const offenders = []
  CSS.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) offenders.push(index + 1)
  })
  assert.deepEqual(offenders, [], '发现被双引号包裹的规则行（行号）：' + JSON.stringify(offenders))
})

test('CSS：每行引号成对、花括号配平', () => {
  CSS.split('\n').forEach((line, index) => {
    const quotes = (line.match(/"/g) || []).length
    assert.equal(quotes % 2, 0, '第 ' + (index + 1) + ' 行引号数为奇数：' + line.slice(0, 80))
  })
  const open = (CSS.match(/{/g) || []).length
  const close = (CSS.match(/}/g) || []).length
  assert.equal(open, close, '花括号不配平：' + open + ' vs ' + close)
})

test('CSS：模板插值已全部展开（不残留反引号或插值串）', () => {
  assert.ok(!CSS.includes(String.fromCharCode(96)), 'CSS 中残留反引号')
  assert.ok(!CSS.includes('\u0024{'), 'CSS 中残留未展开的插值')
})

test('CSS：0.7.0 审查发现的 12 个选择器都作为规则存在', () => {
  const required = [
    '.onestep-focus-preview',
    '.onestep-focus-preview-head',
    '.onestep-focus-preview-title',
    '.onestep-focus-preview-state',
    '.onestep-focus-preview-body',
    '.onestep-focus-preview-line',
    '.onestep-rail-viewport',
    '.onestep-rail-scroll-controls',
    '.onestep-rail-scroll-btn',
    '.onestep-rail-mini',
    '.onestep-rail-mini-item',
    '.onestep-rail-mini-index',
  ]
  const missing = required.filter((selector) => {
    const pattern = '(^|\\n)\\s*' + selector.replace(/[.*+?^\u0024{}()|[\]\\]/g, '\\$&') + '\\s*[^{]*\\{'
    return !new RegExp(pattern).test(CSS)
  })
  assert.deepEqual(missing, [], '缺少规则：' + JSON.stringify(missing))
})
test('CSS：0.7.0 再次点击高亮规则齐备（两下动画 + reduced 静态降级）', () => {
  assert.ok(CSS.includes('@keyframes onestep-float-flash'))
  assert.ok(CSS.includes('[data-dockkit-float][data-onestep-float-flash]::after'))
  assert.ok(CSS.includes('animation:onestep-float-flash 240ms ease-out 2'))
  assert.ok(CSS.includes(':root[data-onestep-motion="reduced"] [data-dockkit-float][data-onestep-float-flash]::after'))
  assert.ok(CSS.includes('@media (prefers-reduced-motion:reduce){[data-dockkit-float][data-onestep-float-flash]::after{animation:none;opacity:1}}'))
})
