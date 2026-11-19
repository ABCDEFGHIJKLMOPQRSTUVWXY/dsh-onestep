#!/usr/bin/env node
/**
 * P2-5：engines.dsh 支持范围自检（无外部依赖的最小 semver 子集）。
 *
 * 背景：DSH 只发 rc（如 0.2.2-rc.1），npm semver 的 prerelease 规则使「单 range」无法同时覆盖
 * 「最新 rc + 上一 rc」（0.2.2-rc.1 / 0.2.1-rc.5）。仓库采用 OR range 表达已测支持范围：
 *   >=0.2.2-rc.1 <0.3.0 || >=0.2.1-rc.5 <0.2.2
 * 每次 DSH rc 发布并完成兼容回归后，更新 package.json engines 与 SUPPORTED_MATRIX。
 *
 * 校验项：
 *  1. 矩阵中「已测/声明支持」的版本必须被 engines 覆盖；
 *  2. 「不在支持范围」的样本（更老 rc / alpha / 0.3.x）必须被排除；
 *  3. OR range 语法可解析、环境可解析。
 *
 * 用法：node scripts/p2/compat/check-engines.mjs [--json]
 * 产物：artifacts/p2/compat/engines.json；失败退出码 1。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const PKG = path.join(ROOT, 'package.json')
const OUT_DIR = path.join(ROOT, 'artifacts', 'p2', 'compat')
const OUT_FILE = path.join(OUT_DIR, 'engines.json')

/**
 * 支持矩阵：随每次 rc 兼容回归更新。
 * - supported：声明支持（发布文档写明的范围）
 * - verified：本轮实际跑过兼容冒烟的版本
 * - excluded：必须被 engines 排除的样本（含边界）
 */
const SUPPORTED_MATRIX = {
  current: '0.2.2-rc.1',
  previous: '0.2.1-rc.5',
  verified: ['0.2.2-rc.1'],
  supported: ['0.2.2-rc.1', '0.2.1-rc.5'],
  // 注：OR range 会同时接受 0.2.2 正式版（同版本线的发布版，契约预期一致；待官方发布后实测）。
  // 0.2.x 后续 patch rc 属前向容忍（上界只挡 0.3 线，与旧「<0.3.0」的意图一致）。
  forwardTolerated: ['0.2.3-rc.1'],
  excluded: ['0.2.0-rc.1', '0.2.1-alpha.1', '0.2.2-alpha.3', '0.3.0-rc.1'],
}

export function parseVersion(text) {
  const match = String(text).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function compareIdentifier(a, b) {
  const aNum = /^\d+$/.test(a)
  const bNum = /^\d+$/.test(b)
  if (aNum && bNum) return Number(a) - Number(b)
  if (aNum) return -1
  if (bNum) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

export function compareVersions(left, right) {
  const a = typeof left === 'string' ? parseVersion(left) : left
  const b = typeof right === 'string' ? parseVersion(right) : right
  if (!a || !b) throw new Error('非法版本号')
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1
    if (b.prerelease[index] === undefined) return 1
    const diff = compareIdentifier(a.prerelease[index], b.prerelease[index])
    if (diff !== 0) return diff
  }
  return 0
}

/** npm semver 子集：支持 `>=`/`>`/`<=`/`<`/`=`、空格「与」、`||`「或」。 */
export function satisfies(version, range) {
  const target = parseVersion(version)
  if (!target) return false
  const sets = String(range)
    .split('||')
    .map((part) => part.trim())
    .filter(Boolean)
  if (sets.length === 0) return false
  return sets.some((set) => {
    const comparators = set.split(/\s+/).filter(Boolean).map((token) => {
      const match = token.match(/^(>=|<=|>|<|=)?(.+)$/)
      return { operator: match[1] || '=', value: parseVersion(match[2]) }
    })
    if (comparators.some((item) => !item.value)) return false
    const allMatch = comparators.every((item) => {
      const diff = compareVersions(target, item.value)
      if (item.operator === '>=') return diff >= 0
      if (item.operator === '>') return diff > 0
      if (item.operator === '<=') return diff <= 0
      if (item.operator === '<') return diff < 0
      return diff === 0
    })
    if (!allMatch) return false
    // 宿主语义对齐（0.7.0 审查 F-P1-1）：DSH 0.2.2-rc.1 用
    // semver.satisfies(runtime, range, { includePrerelease: true }) 判定 engines.dsh，
    // 预发布版本直接参与比较，不套用 npm 默认的「同 tuple 才接受 prerelease」规则。
    // 门禁必须与宿主同语义，否则会把「<0.3.0 挡不住 0.3.0-rc.*」误判为有效（fail-open）。
    return true
  })
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'))
  const range = pkg.engines && pkg.engines.dsh
  const errors = []
  if (!range) errors.push('package.json 缺少 engines.dsh')

  const results = {}
  const forwardTolerated = SUPPORTED_MATRIX.forwardTolerated || []
  for (const version of [...SUPPORTED_MATRIX.supported, ...SUPPORTED_MATRIX.excluded, ...forwardTolerated, SUPPORTED_MATRIX.current]) {
    results[version] = satisfies(version, range)
  }
  for (const version of forwardTolerated) {
    if (!results[version]) errors.push('前向容忍版本被 engines 排除: ' + version)
  }
  for (const version of SUPPORTED_MATRIX.supported) {
    if (!results[version]) errors.push(`声明支持但被 engines 排除: ${version}`)
  }
  for (const version of SUPPORTED_MATRIX.excluded) {
    if (results[version]) errors.push(`声明不支持但被 engines 接受: ${version}`)
  }
  const result = {
    ok: errors.length === 0,
    at: new Date().toISOString(),
    engines: range,
    matrix: SUPPORTED_MATRIX,
    satisfies: results,
    futureRcSample: { version: '0.2.3-rc.1', note: '下一 rc 发布后需加入 supported 并更新 engines（预期当前 false）' },
    errors,
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2) + '\n', 'utf8')
  console.log('[engines] ' + (result.ok ? 'PASS' : 'FAIL') + ' range=' + range)
  for (const [version, value] of Object.entries(results)) console.log('[engines] ' + (value ? 'in ' : 'out') + ' ' + version)
  for (const item of errors) console.error('[engines][error] ' + item)
  console.log('[engines] -> ' + path.relative(ROOT, OUT_FILE))
  process.exit(result.ok ? 0 : 1)
}

if (import.meta.main) main()
