import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const runner = path.resolve(import.meta.dirname, '../scripts/p4/verify/run-all.mjs')
function list(...args) {
  return spawnSync(process.execPath, [runner, '--list', ...args], { encoding: 'utf8' })
}

test('P4 --only accepts space and equals forms without listing other suites', () => {
  for (const args of [['--only', 'm1,m6'], ['--only=m1,m6'], ['--only', 'm1-morph,m6-perf']]) {
    const result = list(...args)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.stdout.trim().split(/\r?\n/).map((line) => line.split(' ')[0]), ['m1', 'm6'])
  }
})

test('P4 fails on missing, unknown, or ambiguous suite selections', () => {
  for (const args of [
    ['--only'], ['--only='], ['--only= , '], ['--only', '--list'],
    ['--only=m1,typo'], ['--only=typo'], ['--only=m1', '--only=m2'], ['--typo'],
  ]) {
    const result = list(...args)
    assert.equal(result.status, 2, JSON.stringify(args) + ': ' + result.stderr)
    assert.equal(result.stdout, '', 'invalid selection must not run or list a partial suite')
  }
})
