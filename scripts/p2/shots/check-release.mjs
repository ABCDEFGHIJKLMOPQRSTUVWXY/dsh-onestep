#!/usr/bin/env node
/**
 * 文档与链接门禁（发布前）：公开仓库里的每个相对链接/图片都必须可达，且不含本机路径、凭据或真实会话痕迹。
 *
 * 检查项：
 *  1. README/CHANGELOG/SECURITY/文档站内所有相对链接与图片指向存在的文件；
 *  2. 不允许链接到未随仓库发布的目录（docs/archive、doc、tmp、artifacts）；
 *  3. 文本中不得出现本机绝对路径（盘符 + Users/Github）、token/cookie 形态、真实会话 ID；
 *  4. README 至少引用 3 张 docs/assets 截图，且截图是宽度 >= 1000 的 PNG；
 *  5. 版本一致性：package.json / 根 index.js VERSION / src/client/index.js VERSION / CHANGELOG 段落标题。
 *
 * 用法：node scripts/p2/shots/check-release.mjs [--json]
 * 产物：artifacts/docs/check-docs.json；失败退出码 1。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const OUT = path.join(ROOT, 'artifacts', 'docs', 'check-docs.json')
const errors = []
const checks = []
const add = (name, pass, actual) => { checks.push({ name, pass, actual }); if (!pass) errors.push(name) }

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const exists = (rel) => fs.existsSync(path.join(ROOT, rel))

/** 需要扫描的 Markdown（不含未入库归档）。 */
const mdFiles = []
const walk = (rel) => {
  const full = path.join(ROOT, rel)
  if (!fs.existsSync(full)) return
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const child = path.posix.join(rel.replace(/\\/g, '/'), entry.name)
    if (entry.isDirectory()) {
      if (['archive', 'node_modules', 'tmp'].includes(entry.name)) continue
      walk(child)
    } else if (entry.name.endsWith('.md')) mdFiles.push(child)
  }
}
for (const top of ['README.md', 'CHANGELOG.md', 'SECURITY.md']) mdFiles.push(top)
walk('docs')
add('docs.present', mdFiles.length >= 5, mdFiles.length)

const FORBIDDEN_TARGET = /^(docs\/archive|doc\/|tmp\/|artifacts\/)/
const LINK = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const IMG = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const SKIP_TARGET = /^(https?:|mailto:|#)/
const broken = []
const forbidden = []
const images = []

for (const file of mdFiles) {
  const text = read(file)
  const dir = path.posix.dirname(file)
  for (const re of [LINK, IMG]) {
    for (const match of text.matchAll(re)) {
      const target = match[2]
      if (SKIP_TARGET.test(target)) continue
      const clean = target.split('#')[0]
      if (!clean) continue
      if (FORBIDDEN_TARGET.test(clean)) { forbidden.push({ file, target: clean }); continue }
      const resolved = clean.startsWith('/') ? clean.slice(1) : path.posix.normalize(path.posix.join(dir, clean))
      if (!exists(resolved)) { broken.push({ file, target: clean, resolved }); continue }
      if (re === IMG && /\.png$/.test(resolved)) images.push(resolved)
    }
  }
}
add('links.allResolve', broken.length === 0, broken.slice(0, 10))
add('links.noUnpublishedTargets', forbidden.length === 0, forbidden.slice(0, 10))

/** 隐私/脱敏扫描：公开文本不得含本机路径、凭据形态、真实会话 ID。 */
const PRIVACY = [
  ['local-absolute-path', /[A-Za-z]:[\\/](Users|Github)[\\/]/],
  ['loopback-token', /[?&]token=[A-Za-z0-9_-]{20,}/],
  ['bearer', /Bearer\s+[A-Za-z0-9._-]{20,}/],
  ['cookie-header', /(Cookie|Set-Cookie)\s*:\s*\S{30,}/],
  ['session-id', /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/],
]
const leaks = []
for (const file of mdFiles) {
  const text = read(file)
  for (const [name, re] of PRIVACY) if (re.test(text)) leaks.push({ file, pattern: name })
}
add('privacy.noLeaks', leaks.length === 0, leaks)

/** README 截图：至少 3 张，且为宽度 >= 1000 的 PNG。 */
const readmeImages = [...read('README.md').matchAll(IMG)].map((m) => m[2]).filter((t) => /\.png$/.test(t))
const assets = readmeImages.filter((t) => t.includes('docs/assets/'))
add('readme.screenshots', assets.length >= 3, assets.length)
const badPng = []
for (const rel of assets) {
  const clean = rel.split('#')[0]
  if (!exists(clean)) continue
  const buf = fs.readFileSync(path.join(ROOT, clean))
  const signature = buf.subarray(0, 8).toString('hex')
  const width = buf.length > 24 ? buf.readUInt32BE(16) : 0
  if (signature !== '89504e470d0a1a0a' || width < 1000) badPng.push({ file: clean, signature, width })
}
add('readme.screenshotQuality', badPng.length === 0, badPng)

/** 版本一致性。 */
const pkg = JSON.parse(read('package.json'))
const version = pkg.version
const versionOf = (rel) => {
  const match = read(rel).match(/const VERSION = '([^']+)'/)
  return match ? match[1] : null
}
const hostVersion = versionOf('index.js')
const clientVersion = versionOf('src/client/index.js')
add('version.hostHalf', hostVersion === version, { hostVersion, version })
add('version.clientHalf', clientVersion === version, { clientVersion, version })
add('version.changelog', read('CHANGELOG.md').includes('## [' + version + ']'), version)
add('version.engines', !!pkg.engines && !!pkg.engines.dsh, pkg.engines)

/** 文档集合齐备。 */
for (const doc of ['docs/README.md', 'docs/user-guide.md', 'docs/architecture.md', 'docs/compatibility.md', 'docs/release/checklist.md', 'docs/release/evidence.md']) {
  add('doc.' + doc, exists(doc))
}

const result = {
  ok: errors.length === 0,
  at: new Date().toISOString(),
  scannedMarkdown: mdFiles.length,
  screenshotsChecked: assets.length,
  checks,
  errors,
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n', 'utf8')
console.log('[check-docs] ' + (result.ok ? 'PASS' : 'FAIL') + ' checks=' + checks.filter((c) => c.pass).length + '/' + checks.length + ' md=' + mdFiles.length + ' -> ' + path.relative(ROOT, OUT))
if (!result.ok) for (const item of checks.filter((c) => !c.pass)) console.log('[FAIL] ' + item.name + ' ' + JSON.stringify(item.actual).slice(0, 300))
process.exitCode = result.ok ? 0 : 1
