#!/usr/bin/env node
/**
 * P2-7 R1：npm pack 内容核对（可复跑）。
 *
 * 做三件事：
 *   1. 在目标目录跑 `npm pack --json --pack-destination <dest>`（默认仓库根 → tmp/pack），拿到 package.json files 声明与 npm 侧清单；
 *   2. 解包 tarball（Node 内联 tar 读取，不依赖 tar.exe），记录每个条目的 sha256/字节数；
 *   3. 核对：内容恰为 files 白名单 + package.json；无禁含目录；tarball 内 client.js/index.js sha256 与源目录一致。
 *
 * 用法（仓库根）：
 *   node scripts/p2/pack/check-pack.mjs --tag repo --out artifacts/p2/pack/pack.json
 *   node scripts/p2/pack/check-pack.mjs --dir tmp/release-copy --tag upgrade --out artifacts/p2/pack/upgrade-pack.json
 *
 * 退出码：0 全过 / 1 核对失败 / 2 用法或 npm 失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const DEFAULT_DEST = path.join(ROOT, 'tmp', 'pack')
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', 'p2', 'pack')

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase()
const sha1Hex = (buffer) => crypto.createHash('sha1').update(buffer).digest('hex')
const sha256File = (file) => sha256(fs.readFileSync(file))

function parseArgs(argv) {
  const cfg = { dir: ROOT, dest: DEFAULT_DEST, out: path.join(ARTIFACT_DIR, 'pack.json'), tag: 'repo', quiet: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dir') cfg.dir = path.resolve(ROOT, argv[++i])
    else if (arg === '--dest') cfg.dest = path.resolve(ROOT, argv[++i])
    else if (arg === '--out') cfg.out = path.resolve(ROOT, argv[++i])
    else if (arg === '--tag') cfg.tag = argv[++i]
    else if (arg === '--quiet') cfg.quiet = true
    else throw new Error('unknown argument: ' + arg)
  }
  return cfg
}

/** 极简 tar.gz 读取：只取普通文件条目（npm pack 产物文件名短，不含 pax/longname 扩展）。 */
export function readTarball(file) {
  const raw = zlib.gunzipSync(fs.readFileSync(file))
  const entries = []
  let offset = 0
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break // 两个全零盘表示结束
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '').trim()
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim()
    const size = parseInt(sizeText || '0', 8) || 0
    const typeFlag = String.fromCharCode(header[156] || 0)
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '').trim()
    const fullName = prefix ? prefix + '/' + name : name
    if (fullName && (typeFlag === '0' || typeFlag === '\0' || typeFlag === '')) {
      const content = raw.subarray(offset + 512, offset + 512 + size)
      entries.push({ path: fullName, size, sha256: sha256(content) })
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

function expectedFileList(pkg, dir) {
  const declared = Array.isArray(pkg.files) ? pkg.files.slice() : []
  const expected = [...declared, 'package.json'].sort()
  return {
    declared,
    expected,
    // files 数组可以是目录/glob；本包声明恰好是具体文件名，逐项核对存在性。
    concrete: declared.every((item) => !item.includes('*') && !item.endsWith('/')),
    missingOnDisk: declared.filter((item) => !fs.existsSync(path.join(dir, item))),
  }
}

function forbiddenEntries(entries) {
  const forbid = ['node_modules/', 'artifacts/', 'tools/', 'src/', 'docs/', 'tests/', 'scripts/', 'tmp/', 'doc/', '.github/', '.git/']
  return entries.filter((entry) => {
    const rel = entry.path.replace(/^package\//, '')
    return forbid.some((prefix) => rel.startsWith(prefix))
  }).map((entry) => entry.path)
}

function main() {
  let cfg
  try { cfg = parseArgs(process.argv.slice(2)) } catch (error) {
    process.stderr.write('[check-pack] ' + error.message + '\n')
    process.exitCode = 2
    return
  }
  const pkgPath = path.join(cfg.dir, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    process.stderr.write('[check-pack] package.json 不存在: ' + pkgPath + '\n')
    process.exitCode = 2
    return
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  fs.mkdirSync(cfg.dest, { recursive: true })

  const startedAt = new Date().toISOString()
  const result = {
    ok: false,
    tag: cfg.tag,
    startedAt,
    source: { dir: path.relative(ROOT, cfg.dir).split(path.sep).join('/') || '.', packageJson: sha256File(pkgPath) },
    package: { name: pkg.name, version: pkg.version, files: pkg.files || [], engines: pkg.engines || null, dsh: pkg.dsh || null, exports: pkg.exports || null },
    expected: null,
    npm: null,
    tarball: null,
    entries: [],
    checks: {},
    failed: [],
  }
  const fail = (id, detail) => { result.checks[id] = { pass: false, detail }; result.failed.push(id) }
  const pass = (id, detail) => { result.checks[id] = { pass: true, detail } }

  // 1) npm pack
  const before = new Set(fs.existsSync(cfg.dest) ? fs.readdirSync(cfg.dest) : [])
  let npmStdout = ''
  try {
    npmStdout = execSync('npm pack --json --pack-destination "' + cfg.dest.replace(/\\/g, '/') + '"', {
      cwd: cfg.dir, encoding: 'utf8', timeout: 120000, windowsHide: true,
    })
  } catch (error) {
    result.npm = { exitCode: error.status === undefined ? null : error.status, stdout: String((error.stdout || '') + (error.stderr || '')).slice(0, 4000) }
    fail('npm.pack', result.npm)
    finish(cfg, result, 'npm pack failed')
    process.exitCode = 2
    return
  }
  let npmInfo = null
  try { npmInfo = JSON.parse(npmStdout)[0] } catch (_error) { npmInfo = null }
  result.npm = { exitCode: 0, filename: npmInfo ? npmInfo.filename : null, size: npmInfo ? npmInfo.size : null, unpackedSize: npmInfo ? npmInfo.unpackedSize : null, shasum: npmInfo ? npmInfo.shasum : null, integrity: npmInfo ? npmInfo.integrity : null, entryCount: npmInfo ? npmInfo.entryCount : null, files: npmInfo ? npmInfo.files : null }
  pass('npm.pack', { exitCode: 0, filename: result.npm.filename })

  // 2) tarball 定位（优先用 npm 自报 filename，回退目录差集）
  let tarballPath = null
  if (npmInfo && npmInfo.filename) tarballPath = path.join(cfg.dest, npmInfo.filename)
  if (!tarballPath || !fs.existsSync(tarballPath)) {
    const added = fs.readdirSync(cfg.dest).filter((name) => !before.has(name) && name.endsWith('.tgz'))
    tarballPath = added.length ? path.join(cfg.dest, added[0]) : null
  }
  if (!tarballPath) {
    fail('tarball.exists', { dest: cfg.dest })
    finish(cfg, result, 'tarball not found')
    process.exitCode = 1
    return
  }
  const tarballBuffer = fs.readFileSync(tarballPath)
  const entries = readTarball(tarballPath)
  result.tarball = {
    path: path.relative(ROOT, tarballPath).split(path.sep).join('/'),
    size: tarballBuffer.length,
    sha256: sha256(tarballBuffer),
    sha1: sha1Hex(tarballBuffer),
    npmShasum: result.npm.shasum,
    // npm 的 shasum 是 tarball 的 sha1（40 hex），不是 sha256 前缀。
    npmShasumMatches: result.npm.shasum ? result.npm.shasum.toLowerCase() === sha1Hex(tarballBuffer) : null,
    entryCount: entries.length,
  }
  result.entries = entries
  pass('tarball.exists', { path: result.tarball.path, bytes: result.tarball.size })

  // 3) 内容白名单
  const expected = expectedFileList(pkg, cfg.dir)
  result.expected = expected
  const actualPaths = entries.map((entry) => entry.path.replace(/^package\//, '')).sort()
  const expectedPaths = expected.expected.slice().sort()
  const extra = actualPaths.filter((item) => !expectedPaths.includes(item))
  const missing = expectedPaths.filter((item) => !actualPaths.includes(item))
  result.content = { actualPaths, expectedPaths, extra, missing }
  if (extra.length === 0 && missing.length === 0) pass('content.whitelist', { files: actualPaths })
  else fail('content.whitelist', { extra, missing })
  if (expected.concrete && expected.missingOnDisk.length === 0) pass('files.declared-exist', expected.declared)
  else fail('files.declared-exist', { declared: expected.declared, missingOnDisk: expected.missingOnDisk, concrete: expected.concrete })
  const forbidden = forbiddenEntries(entries)
  if (forbidden.length === 0) pass('content.no-forbidden', { checked: ['node_modules', 'artifacts', 'tools', 'src', 'docs', 'tests', 'scripts', 'tmp', 'doc', '.github'] })
  else fail('content.no-forbidden', forbidden)

  // 4) 源目录一致性：tarball 内 client.js / index.js / package.json sha256 == 源目录
  const shas = {}
  for (const rel of ['client.js', 'index.js', 'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    const sourcePath = path.join(cfg.dir, rel)
    const entry = entries.find((item) => item.path === 'package/' + rel)
    shas[rel] = {
      source: fs.existsSync(sourcePath) ? { sha256: sha256File(sourcePath), bytes: fs.statSync(sourcePath).size } : null,
      tarball: entry || null,
      match: !!(entry && fs.existsSync(sourcePath) && entry.sha256 === sha256File(sourcePath)),
    }
  }
  result.shas = shas
  if (shas['client.js'].match) pass('client.sha-match', shas['client.js'])
  else fail('client.sha-match', shas['client.js'])
  if (shas['index.js'].match) pass('index.sha-match', shas['index.js'])
  else fail('index.sha-match', shas['index.js'])

  // 5) tarball 内 package.json 与源一致且声明了 dsh.bundle/client
  let packedPkg = null
  try {
    const raw = zlib.gunzipSync(tarballBuffer)
    // 复用 entries 的偏移逻辑：重扫一次取 package.json 内容
    let offset = 0
    while (offset + 512 <= raw.length) {
      const header = raw.subarray(offset, offset + 512)
      if (header.every((byte) => byte === 0)) break
      const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '').trim()
      const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8) || 0
      if (name === 'package/package.json') {
        packedPkg = JSON.parse(raw.subarray(offset + 512, offset + 512 + size).toString('utf8'))
        break
      }
      offset += 512 + Math.ceil(size / 512) * 512
    }
  } catch (_error) { packedPkg = null }
  result.packedPackage = packedPkg ? { name: packedPkg.name, version: packedPkg.version, files: packedPkg.files, engines: packedPkg.engines, dsh: packedPkg.dsh, exports: packedPkg.exports } : null
  const bundleOk = !!(packedPkg && packedPkg.dsh && packedPkg.dsh.bundle && packedPkg.dsh.bundle.patch && packedPkg.dsh.client && packedPkg.dsh.client.platform === 'web' && packedPkg.exports && packedPkg.exports['./client'])
  if (bundleOk) pass('package.dsh-fields', { dsh: packedPkg.dsh, exports: packedPkg.exports })
  else fail('package.dsh-fields', { packed: result.packedPackage })
  const versionOk = !!(packedPkg && packedPkg.name === pkg.name && packedPkg.version === pkg.version)
  if (versionOk) pass('package.identity', { name: pkg.name, version: pkg.version })
  else fail('package.identity', { source: { name: pkg.name, version: pkg.version }, packed: packedPkg ? { name: packedPkg.name, version: packedPkg.version } : null })

  result.ok = result.failed.length === 0
  finish(cfg, result, result.ok ? null : 'checks failed')
  if (!cfg.quiet) {
    const lines = [
      '[check-pack] tag=' + cfg.tag + ' dir=' + result.source.dir + ' version=' + result.package.version,
      '[check-pack] tarball=' + result.tarball.path + ' (' + result.tarball.size + ' bytes, sha256=' + result.tarball.sha256.slice(0, 16) + '...)',
      '[check-pack] entries=' + entries.length + ': ' + actualPaths.join(', '),
      '[check-pack] ' + (result.ok ? 'OK' : 'FAIL') + (result.ok ? '' : ' failed=' + result.failed.join(',')),
      '[check-pack] evidence -> ' + path.relative(ROOT, cfg.out).split(path.sep).join('/'),
    ]
    process.stdout.write(lines.join('\n') + '\n')
  }
  process.exitCode = result.ok ? 0 : 1
}

function finish(cfg, result, error) {
  result.finishedAt = new Date().toISOString()
  if (error) result.error = error
  fs.mkdirSync(path.dirname(cfg.out), { recursive: true })
  fs.writeFileSync(cfg.out, JSON.stringify(result, null, 2) + '\n', 'utf8')
}

main()
