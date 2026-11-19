#!/usr/bin/env node
/**
 * 发布前仓库自查（公开仓库版）：包内容、版本一致性、忽略规则、脱敏、文档与截图完整性。
 *
 * 用法：npm run p3:hygiene
 * 产物：artifacts/p3/verify/release-hygiene.json；失败退出码 1。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const OUT = path.join(ROOT, 'artifacts', 'p3', 'verify', 'release-hygiene.json')
const report = { ok: false, at: new Date().toISOString(), checks: [], hits: [], notes: [] }
const add = (name, pass, actual, note) => report.checks.push({ name, pass, actual, note })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const exists = (rel) => fs.existsSync(path.join(ROOT, rel))

const pkg = JSON.parse(read('package.json'))
const expectedFiles = ['LICENSE', 'README.md', 'client.js', 'cordis.patch.yml', 'index.js', 'package.json']
add('version.current', /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version)
const versionOf = (rel) => {
  const match = read(rel).match(/const VERSION = '([^']+)'/)
  return match ? match[1] : null
}
add('version.host-half', versionOf('index.js') === pkg.version, { host: versionOf('index.js'), pkg: pkg.version })
add('version.client-half', versionOf('src/client/index.js') === pkg.version, { client: versionOf('src/client/index.js'), pkg: pkg.version })
add('files.field', JSON.stringify(pkg.files) === JSON.stringify(['index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'LICENSE']), pkg.files)
add('engines.dsh', typeof pkg.engines?.dsh === 'string' && />=\d+\.\d+\.\d+/.test(pkg.engines.dsh), pkg.engines?.dsh)
add('dsh.bundle', pkg.dsh?.bundle?.patch === './cordis.patch.yml', pkg.dsh?.bundle)
add('dsh.client', pkg.dsh?.client?.platform === 'web', pkg.dsh?.client)

// 包内容（npm pack --dry-run，不落盘）
let pack = null
try {
  const raw = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' })
  pack = JSON.parse(raw)[0]
} catch (error) {
  add('pack.dry-run', false, String(error).slice(0, 300))
}
if (pack) {
  const paths = pack.files.map((item) => item.path).sort()
  add('pack.dry-run', true, { filename: pack.filename, entryCount: pack.entryCount, unpackedSize: pack.unpackedSize })
  add('pack.files.match', JSON.stringify(paths) === JSON.stringify(expectedFiles), { paths })
  const client = pack.files.find((item) => item.path === 'client.js')
  add('pack.client.size', !!client && client.size === fs.statSync(path.join(ROOT, 'client.js')).size, client && client.size)
}

// 忽略规则：本机证据、浏览器数据、归档与第三方快照都不得入库
const gitignore = read('.gitignore')
for (const pattern of ['node_modules/', 'tmp/', 'artifacts/', 'docs/archive/', 'doc/', 'tmp-edge-profile*/', '.env', '*.tgz']) {
  add('gitignore.' + pattern, gitignore.includes(pattern), pattern)
}

// 脱敏扫描（只扫会入库的文本；跳过已忽略目录）
const SKIP_DIRS = new Set(['node_modules', '.git', 'tmp', 'artifacts', 'archive', 'tool', 'tools'])
const SKIP_TOP = new Set(['doc'])
const TEXT_EXT = /\.(md|json|js|mjs|cjs|yml|yaml|ps1|txt|html|css)$/i
const PATTERNS = [
  { name: 'loopback-token', re: /[?&]token=[A-Za-z0-9_-]{20,}/ },
  { name: 'bearer', re: /Authorization\s*:\s*Bearer\s+[A-Za-z0-9._-]{20,}/i },
  { name: 'cookie-header', re: /(Cookie|Set-Cookie)\s*:\s*\S{30,}/i },
  { name: 'local-absolute-userpath', re: /[A-Za-z]:\\Users\\[A-Za-z0-9_.-]+\\/ },
  { name: 'session-id', re: /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/ },
]
const hits = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const rel = path.relative(ROOT, full).replace(/\\/g, '/')
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (path.dirname(full) === ROOT && SKIP_TOP.has(entry.name)) continue
      walk(full)
      continue
    }
    if (!TEXT_EXT.test(entry.name)) continue
    const size = fs.statSync(full).size
    if (size > 2 * 1024 * 1024) continue
    let text = ''
    try { text = fs.readFileSync(full, 'utf8') } catch (_error) { continue }
    for (const pattern of PATTERNS) {
      if (pattern.re.test(text)) hits.push({ file: rel, pattern: pattern.name })
    }
  }
}
walk(ROOT)
// 本仓库出于「记录并防止」目的在 release-hygiene 自身保留了一条路径正则；排除自身。
const realHits = hits.filter((hit) => hit.file !== 'scripts/p3/verify/release-hygiene.mjs')
add('sensitive.scan', realHits.length === 0, realHits.slice(0, 20))
report.hits = realHits.slice(0, 50)

// 文档完整性
const docs = ['README.md', 'CHANGELOG.md', 'SECURITY.md', 'LICENSE', 'docs/README.md', 'docs/user-guide.md', 'docs/architecture.md', 'docs/compatibility.md', 'docs/release/checklist.md', 'docs/release/evidence.md', 'docs/review/0.7.0-pre-release.md']
for (const doc of docs) {
  const ok = exists(doc)
  add('doc.' + doc, ok && read(doc).length > 300, ok ? read(doc).length : null)
}

// 截图完整性（以 MANIFEST.json 为准，校验 sha256）
const manifestPath = 'docs/assets/MANIFEST.json'
if (exists(manifestPath)) {
  const manifest = JSON.parse(read(manifestPath))
  const shots = Array.isArray(manifest.shots) ? manifest.shots : []
  add('assets.manifest.count', shots.length >= 5, shots.length)
  const bad = []
  for (const shot of shots) {
    const rel = 'docs/assets/' + shot.file
    if (!exists(rel)) { bad.push({ file: rel, reason: 'missing' }); continue }
    const bytes = fs.statSync(path.join(ROOT, rel)).size
    if (bytes < 20000) bad.push({ file: rel, reason: 'too-small', bytes })
    if (shot.sha256) {
      const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex')
      if (digest.toLowerCase() !== String(shot.sha256).toLowerCase()) bad.push({ file: rel, reason: 'sha-mismatch' })
    }
  }
  add('assets.files', bad.length === 0, bad)
  add('assets.privacy', manifest.privacy && manifest.privacy.containsRealSessionTitles === false && manifest.privacy.containsAccountInfo === false, manifest.privacy)
} else {
  add('assets.manifest', false, manifestPath)
}

report.notes.push('本地证据/浏览器数据/归档/第三方研究快照由 .gitignore 排除；npm 包只含 6 个文件。')
report.ok = report.checks.every((item) => item.pass)
const failed = report.checks.filter((item) => !item.pass).map((item) => item.name)
report.summary = { total: report.checks.length, pass: report.checks.length - failed.length, fail: failed.length, failedNames: failed }
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
console.log('[release-hygiene] ' + (report.ok ? 'PASS' : 'FAIL') + ' checks=' + report.summary.pass + '/' + report.summary.total + ' hits=' + realHits.length + ' -> ' + path.relative(ROOT, OUT))
if (!report.ok) for (const item of report.checks.filter((c) => !c.pass)) console.log('[FAIL] ' + item.name + ' ' + JSON.stringify(item.actual).slice(0, 300))
process.exitCode = report.ok ? 0 : 1
