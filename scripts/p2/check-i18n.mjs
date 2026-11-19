#!/usr/bin/env node
/**
 * P2-2 i18n 自检：产品文案零硬编码 + zh/en 字典完整性。
 *
 * 检查项：
 *  1. baseline locale 存在（DSH locale.register 要求 zh/en 双基线）与键命名规范
 *  2. zh/en 键集一致（双向差集）
 *  3. 使用但缺失的键（t('x') / props.t('x') / 动态前缀 t('x.' + y) / labelKey 字面量 / STATUS_KEYS / 键字面量）
 *  4. 未使用的键（warning；预留键见 RESERVED_KEYS）
 *  5. 硬编码用户可见文案（UI 位 CJK/英文字面量；UI 位 = label/title/placeholder/aria-label/alt 等属性、h() 文本子节点）
 *  6. 非 UI 位 CJK 字面量（需人工确认为内部标识；确认为内部后加入 INTERNAL_ALLOW）
 *  7. 插值参数 zh/en 一致；零宽空格 / BOM；空文案
 *
 * 用法：node scripts/p2/check-i18n.mjs [--verbose]
 * 产物：artifacts/p2/i18n/check-i18n.json；有 error 时退出码 1。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DICTIONARIES, STATUS_KEYS } from '../../src/client/locale.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const DEFAULT_SRC_DIR = path.join(ROOT, 'src', 'client')
const OUT_DIR = path.join(ROOT, 'artifacts', 'p2', 'i18n')
const OUT_FILE = path.join(OUT_DIR, 'check-i18n.json')

/** 硬编码扫描豁免：dev-only 探针面板（localStorage flag 打开，非产品 UI）、纯 CSS 模板（styles.js 无界面文案）。 */
export const HARDCODED_EXEMPT_FILES = new Set(['probe.js', 'styles.js'])
/** 非 UI 位内部标识白名单（日志事件名、动作 result note 等，绝不渲染到界面）。 */
export const INTERNAL_ALLOW = new Set([
  '无主会话：先成为焦点', // drag.enterStage 的 action result note（仅探针/日志可见）
])
const CJK = /[\u4e00-\u9fff]/
const UI_ATTR_KEYS = new Set([
  'label', 'title', 'placeholder', 'aria-label', 'ariaLabel', 'alt', 'message',
  'confirmLabel', 'cancelLabel', 'description', 'hint', 'emptyText', 'errorText',
])
/** 预留键：P2-1 才接入 UI（rail 收起手柄 / 候场栏 aria 标签 / 候场序号 / 探针面板标题）。 */
export const RESERVED_KEYS = new Set(['rail.collapse', 'rail.expand', 'rail.left', 'rail.top', 'window.candidate', 'a11y.panel'])

/** 从源码中剥离注释、收集字符串字面量（占位标记保留位置上下文）。 */
export function tokenize(src) {
  const strings = []
  let code = ''
  let i = 0
  let line = 1
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++
        i++
      }
      i += 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      const startLine = line
      i++
      let value = ''
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          value += src[i + 1] === undefined ? '' : src[i + 1]
          i += 2
          continue
        }
        if (src[i] === '\n') {
          if (quote !== '`') break
          value += '\n'
          line++
          i++
          continue
        }
        value += src[i]
        i++
      }
      i++
      const idx = strings.length
      strings.push({ value, line: startLine, kind: quote === '`' ? 'template' : 'string' })
      code += '\u0000' + idx + '\u0000'
      continue
    }
    if (ch === '\n') line++
    code += ch
    i++
  }
  return { code, strings }
}

const markerOf = (index) => '\u0000' + index + '\u0000'

/** 收集 t(...) 直接键、动态前缀键、labelKey 字面量键。 */
function collectKeyRefs(code, strings, name) {
  const refs = [] // {key, where}
  const prefixes = []
  for (const match of code.matchAll(/(?:^|[^\w$])(?:[\w$]+\.)*t\(\s*\u0000(\d+)\u0000\s*[,)]/g)) {
    const index = Number(match[1])
    refs.push({ key: strings[index].value, where: `${name}:${strings[index].line}` })
  }
  for (const match of code.matchAll(/(?:^|[^\w$])(?:[\w$]+\.)*t\(\s*\u0000(\d+)\u0000\s*\+/g)) {
    const index = Number(match[1])
    prefixes.push({ prefix: strings[index].value, where: `${name}:${strings[index].line}` })
  }
  for (const match of code.matchAll(/labelKey\s*:\s*\u0000(\d+)\u0000/g)) {
    const index = Number(match[1])
    refs.push({ key: strings[index].value, where: `${name}:${strings[index].line}` })
  }
  return { refs, prefixes }
}

/** UI 位判定：返回 null | attribute | child。 */
export function uiContext(before) {
  const attr = before.match(/([A-Za-z-]+)\s*:\s*$/)
  if (attr && UI_ATTR_KEYS.has(attr[1])) return 'attribute'
  if (/,\s*$/.test(before) && /\bh\([^()]*,\s*$/.test(before.slice(-400))) return 'child'
  if (/\(\s*$/.test(before) && /\bh\([^()]*,\s*$/.test(before.slice(-400))) return 'child'
  return null
}

/** 模板中 {name} 参数集合。 */
export function paramSet(text) {
  const set = new Set()
  for (const match of String(text).matchAll(/\{(\w+)\}/g)) set.add(match[1])
  return set
}

function sameSet(a, b) {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}

/**
 * 扫描源码目录并返回完整报告（不写盘）。
 * @param {object} [options]
 * @param {string} [options.srcDir] 源码目录（默认 src/client）
 * @param {Record<string, Record<string,string>>} [options.dictionaries] 字典（默认 locale.js DICTIONARIES）
 * @param {Record<string,string>} [options.statusKeys] 状态→键映射
 * @returns {object}
 */
export function scanI18n(options = {}) {
  const srcDir = options.srcDir || DEFAULT_SRC_DIR
  const dictionaries = options.dictionaries || DICTIONARIES
  const statusKeys = options.statusKeys || STATUS_KEYS
  const errors = []
  const warnings = []
  const error = (check, message, detail) => errors.push({ check, message, ...(detail ? { detail } : {}) })
  const warn = (check, message, detail) => warnings.push({ check, message, ...(detail ? { detail } : {}) })

  const files = fs
    .readdirSync(srcDir)
    .filter((name) => name.endsWith('.js'))
    .sort()

  const usedKeys = new Map() // key -> [where]
  const refs = []
  const prefixes = []
  const hardcoded = []
  const reviewCjk = []
  const allLiterals = new Set()
  const fileReports = []

  for (const name of files) {
    const raw = fs.readFileSync(path.join(srcDir, name), 'utf8')
    const { code, strings } = tokenize(raw)
    const report = { file: name, strings: strings.length, hardcoded: 0, reviewCjk: 0 }
    if (name !== 'locale.js') {
      for (const item of strings) allLiterals.add(item.value)
      const refsOfFile = collectKeyRefs(code, strings, name)
      refs.push(...refsOfFile.refs)
      prefixes.push(...refsOfFile.prefixes)
    }
    for (let index = 0; index < strings.length; index++) {
      const item = strings[index]
      const marker = markerOf(index)
      const at = code.indexOf(marker)
      if (at < 0) continue
      const before = code.slice(Math.max(0, at - 400), at)
      const after = code.slice(at + marker.length, at + marker.length + 24)
      const isPropertyKey = /^\s*:/.test(after)
      if (isPropertyKey) continue
      if (name === 'locale.js' || HARDCODED_EXEMPT_FILES.has(name)) continue
      const value = item.value
      const ctx = uiContext(before)
      const trimmed = value.trim()
      if (trimmed === '' || INTERNAL_ALLOW.has(trimmed)) continue
      if (ctx) {
        const isCjk = CJK.test(trimmed)
        const isBadEnglish =
          /^[A-Za-z0-9 .,:;!?'’"()/%+\-…·]+$/.test(trimmed) && /[A-Za-z]/.test(trimmed) && trimmed.length > 1
        if (isCjk || isBadEnglish) {
          hardcoded.push({ file: name, line: item.line, value, context: ctx })
          report.hardcoded++
        }
        continue
      }
      if (CJK.test(trimmed)) {
        reviewCjk.push({ file: name, line: item.line, value })
        report.reviewCjk++
      }
    }
    fileReports.push(report)
  }

  // ---- 1. baseline locale 与键命名 ----
  for (const locale of ['zh', 'en']) {
    if (!dictionaries[locale] || typeof dictionaries[locale] !== 'object') {
      error('baseline', `缺少 baseline locale: ${locale}`)
    }
  }
  for (const locale of Object.keys(dictionaries)) {
    for (const key of Object.keys(dictionaries[locale])) {
      if (!/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/.test(key)) error('key-format', `[${locale}] 键名不合规: ${key}`)
    }
  }

  // ---- 2. zh/en 键集一致 ----
  const zhKeys = new Set(Object.keys(dictionaries.zh || {}))
  const enKeys = new Set(Object.keys(dictionaries.en || {}))
  for (const key of zhKeys) if (!enKeys.has(key)) error('locale-parity', `en 缺失: ${key}`)
  for (const key of enKeys) if (!zhKeys.has(key)) error('locale-parity', `zh 缺失: ${key}`)
  const allKeys = new Set([...zhKeys, ...enKeys])

  // ---- 3. 插值参数一致 + 零宽字符 + 空文案 ----
  for (const key of allKeys) {
    const zh = dictionaries.zh?.[key]
    const en = dictionaries.en?.[key]
    if (typeof zh === 'string' && typeof en === 'string' && !sameSet(paramSet(zh), paramSet(en))) {
      error('params', `插值参数 zh/en 不一致: ${key}`, { zh, en })
    }
    for (const [locale, text] of [['zh', zh], ['en', en]]) {
      if (typeof text === 'string' && /[\u200B\uFEFF]/.test(text)) error('zero-width', `[${locale}] 含零宽空格/BOM: ${key}`)
      if (typeof text === 'string' && text.trim() === '') error('empty', `[${locale}] 空文案: ${key}`)
    }
  }

  // ---- 4. 使用但缺失的键 ----
  for (const [status, key] of Object.entries(statusKeys)) {
    usedKeys.set(key, [...(usedKeys.get(key) || []), `STATUS_KEYS.${status}`])
    if (!allKeys.has(key)) error('missing-key', `STATUS_KEYS 引用但字典缺失: ${key}`)
  }
  for (const ref of refs) {
    usedKeys.set(ref.key, [...(usedKeys.get(ref.key) || []), ref.where])
    if (!allKeys.has(ref.key)) error('missing-key', `使用但字典缺失: ${ref.key}`, { where: ref.where })
  }
  const dynamicPrefixes = new Set(prefixes.map((item) => item.prefix))
  for (const key of allKeys) {
    for (const prefix of dynamicPrefixes) {
      if (key.startsWith(prefix) && !usedKeys.has(key)) usedKeys.set(key, [`dynamic prefix ${prefix}`])
    }
    if (allLiterals.has(key)) usedKeys.set(key, [...(usedKeys.get(key) || []), 'literal'])
  }

  // ---- 5. 未使用键（warning） ----
  for (const key of allKeys) {
    if (!usedKeys.has(key) && !RESERVED_KEYS.has(key)) warn('unused-key', `未使用: ${key}`)
  }
  const unused = [...allKeys].filter((key) => !usedKeys.has(key) && !RESERVED_KEYS.has(key))

  // ---- 6. 硬编码 ----
  for (const item of hardcoded) {
    error('hardcoded', `${item.file}:${item.line} 硬编码文案 ${JSON.stringify(item.value)}`, { context: item.context })
  }
  for (const item of reviewCjk) {
    error('hardcoded-review', `${item.file}:${item.line} 非 UI 位中文字面量待确认 ${JSON.stringify(item.value)}`)
  }

  return {
    ok: errors.length === 0,
    startedAt: new Date().toISOString(),
    srcDir,
    summary: {
      files: files.length,
      locales: Object.keys(dictionaries),
      keys: { zh: zhKeys.size, en: enKeys.size },
      usedKeys: usedKeys.size,
      unusedKeys: unused,
      dynamicPrefixes: [...dynamicPrefixes],
      hardcoded: hardcoded.length,
      reviewCjk: reviewCjk.length,
      errors: errors.length,
      warnings: warnings.length,
    },
    checks: {
      localeParity: errors.filter((item) => item.check === 'locale-parity').length === 0,
      missingKeys: errors.filter((item) => item.check === 'missing-key').length === 0,
      hardcoded: errors.filter((item) => item.check === 'hardcoded' || item.check === 'hardcoded-review').length === 0,
      params: errors.filter((item) => item.check === 'params').length === 0,
      zeroWidth: errors.filter((item) => item.check === 'zero-width').length === 0,
    },
    hardcoded,
    reviewCjk,
    unusedKeys: unused,
    errors,
    warnings,
    files: fileReports,
  }
}

function main() {
  const verbose = process.argv.includes('--verbose')
  const result = scanI18n()
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2) + '\n', 'utf8')
  const { summary } = result
  console.log('[i18n] locales=' + summary.locales.join(',') + ' zh=' + summary.keys.zh + ' en=' + summary.keys.en)
  console.log(
    '[i18n] hardcoded=' + summary.hardcoded + ' reviewCjk=' + summary.reviewCjk + ' missing=' +
      result.errors.filter((item) => item.check === 'missing-key').length + ' unused(warn)=' + summary.unusedKeys.length,
  )
  for (const item of result.errors) console.error('[i18n][error] ' + item.message)
  if (verbose) {
    for (const item of result.warnings) console.log('[i18n][warn] ' + item.message)
    for (const item of result.unusedKeys) console.log('[i18n][unused] ' + item)
  }
  console.log('[i18n] ' + (result.ok ? 'PASS' : 'FAIL') + ' -> ' + path.relative(ROOT, OUT_FILE))
  process.exit(result.ok ? 0 : 1)
}

if (import.meta.main) main()

export { DEFAULT_SRC_DIR, OUT_FILE, ROOT }
