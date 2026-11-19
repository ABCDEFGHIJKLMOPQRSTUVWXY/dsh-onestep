/**
 * P2-2 i18n 自检脚本的测试：
 *  - 产品字典本身（zh/en 键集/插值参数/命名）通过扫描
 *  - 扫描器对各类 fixture 的判定（硬编码 CJK/英文、缺失键、注释与属性键豁免、zh/en 差集）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanI18n, tokenize, uiContext, paramSet } from '../scripts/p2/check-i18n.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')

function fixtureDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onestep-i18n-'))
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content, 'utf8')
  return dir
}

const DICT = {
  zh: { 'card.running': '运行中', 'toast.movedOut': '已移出：{title}' },
  en: { 'card.running': 'Running', 'toast.movedOut': 'Removed: {title}' },
}

test('产品字典通过 i18n 扫描（src/client 零硬编码、键完整）', () => {
  const result = scanI18n({ srcDir: path.join(ROOT, 'src', 'client') })
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2))
  assert.equal(result.summary.hardcoded, 0)
  assert.equal(result.summary.keys.zh, result.summary.keys.en)
  assert.ok(result.summary.keys.zh > 0)
})

test('扫描器：h() 文本子节点中的中文判为硬编码', () => {
  const dir = fixtureDir({
    'ui.js': `export const A = () => h('span', null, '硬编码文案')\n`,
  })
  const result = scanI18n({ srcDir: dir, dictionaries: DICT, statusKeys: {} })
  const hits = result.errors.filter((item) => item.check === 'hardcoded')
  assert.equal(hits.length, 1)
  assert.match(hits[0].message, /硬编码文案/)
})

test('扫描器：title/label 属性位英文字面量判为硬编码，属性名本身不误报', () => {
  const dir = fixtureDir({
    'ui.js': [
      `export const A = () => h('button', { title: 'Close window', label: 'x' })`,
      `export const B = () => ({ 'data-x': '1', className: 'onestep-btn' })`,
      ``,
    ].join('\n'),
  })
  const result = scanI18n({ srcDir: dir, dictionaries: DICT, statusKeys: {} })
  const hits = result.errors.filter((item) => item.check === 'hardcoded')
  assert.equal(hits.length, 1)
  assert.match(hits[0].message, /Close window/)
})

test('扫描器：使用但缺失的键报错，注释里的键不参与扫描', () => {
  const dir = fixtureDir({
    'ui.js': [
      `// t('comment.only') 只是注释`,
      `export const A = (t) => t('card.running') + t('missing.key')`,
      ``,
    ].join('\n'),
  })
  const result = scanI18n({ srcDir: dir, dictionaries: DICT, statusKeys: {} })
  const missing = result.errors.filter((item) => item.check === 'missing-key').map((item) => item.message)
  assert.deepEqual(missing, ['使用但字典缺失: missing.key'])
})

test('扫描器：props.t(...) 与三元键字面量视为已使用', () => {
  const dir = fixtureDir({
    'ui.js': `export const A = (props) => props.t('card.running') + (props.x ? 'toast.movedOut' : '')\n`,
  })
  const result = scanI18n({ srcDir: dir, dictionaries: DICT, statusKeys: {} })
  assert.equal(result.errors.length, 0)
  assert.deepEqual(result.summary.unusedKeys, [])
})

test('扫描器：zh/en 键集不一致与插值参数差异报错', () => {
  const dir = fixtureDir({ 'ui.js': `export const A = (t) => t('card.running')\n` })
  const dict = {
    zh: { 'card.running': '运行中', 'only.zh': '只在中文', 'p.mismatch': 'a{count}' },
    en: { 'card.running': 'Running', 'only.en': 'English only', 'p.mismatch': 'a{x}' },
  }
  const result = scanI18n({ srcDir: dir, dictionaries: dict, statusKeys: {} })
  assert.equal(result.checks.localeParity, false)
  assert.equal(result.checks.params, false)
})

test('扫描器：非 UI 位中文需人工确认（hardcoded-review）', () => {
  const dir = fixtureDir({ 'ui.js': `export const notes = { note: '内部提示' }\n` })
  const result = scanI18n({ srcDir: dir, dictionaries: DICT, statusKeys: {} })
  assert.equal(result.errors.filter((item) => item.check === 'hardcoded-review').length, 1)
})

test('tokenize 剥离注释并保留字符串行号', () => {
  const { strings } = tokenize(`// 注释\nconst a = 'x'\n/* 块注释 */ const b = 'y'\n`)
  assert.deepEqual(strings.map((item) => item.value), ['x', 'y'])
  assert.equal(strings[0].line, 2)
  assert.equal(strings[1].line, 3)
})

test('uiContext 识别 label 属性位与 h() 文本子节点', () => {
  assert.equal(uiContext(`h('button', { title: `), 'attribute')
  assert.equal(uiContext(`h('span', null, `), 'child')
  assert.equal(uiContext(`const x = { note: `), null)
})

test('paramSet 提取插值参数集合', () => {
  assert.deepEqual([...paramSet('会话“{title}”需要你处理：{kind}')].sort(), ['kind', 'title'])
})
