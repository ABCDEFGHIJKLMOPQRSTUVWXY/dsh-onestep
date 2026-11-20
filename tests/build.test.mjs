import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { buildClient } from '../scripts/build.mjs'

function fixture(t) {
  const tempDir = path.resolve(import.meta.dirname, '../tmp')
  fs.mkdirSync(tempDir, { recursive: true })
  const root = fs.mkdtempSync(path.join(tempDir, 'build-test-'))
  t.after(() => {
    assert.equal(path.dirname(root), tempDir)
    fs.rmSync(root, { recursive: true, force: true })
  })
  const entry = path.join(root, 'src', 'client', 'index.js')
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(entry, "export const label = '舞台'\n")
  return { root, entry, out: path.join(root, 'client.js') }
}

test('build check rejects missing bundles without creating them', async (t) => {
  const { root, out } = fixture(t)
  await assert.rejects(buildClient({ root, checkOnly: true }), /client\.js is missing/)
  assert.equal(fs.existsSync(out), false)
})

test('build check catches source changes and leaves stale bundles untouched', async (t) => {
  const { root, entry, out } = fixture(t)
  const result = await buildClient({ root })
  const original = fs.readFileSync(out)
  assert.equal(result.bytes, original.length)
  assert.ok(original.length > original.toString('utf8').length, 'byte count includes UTF-8 text')
  const modifiedAt = fs.statSync(out).mtimeMs
  await buildClient({ root, checkOnly: true })
  assert.equal(fs.statSync(out).mtimeMs, modifiedAt, 'check must not rewrite matching bundles')

  fs.writeFileSync(entry, "export const label = '新的舞台'\n")
  await assert.rejects(buildClient({ root, checkOnly: true }), /client\.js is out of date/)
  assert.deepEqual(fs.readFileSync(out), original)
  await buildClient({ root })
  assert.notDeepEqual(fs.readFileSync(out), original)
  await buildClient({ root, checkOnly: true })
})

test('build output is independent of the invoking working directory', async (t) => {
  const { root, out } = fixture(t)
  await buildClient({ root })
  const original = fs.readFileSync(out)
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../scripts/build.mjs')).href
  const run = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { buildClient } from ${JSON.stringify(moduleUrl)}; await buildClient({ root: ${JSON.stringify(root)} });`,
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(fs.readFileSync(out), original)
})
