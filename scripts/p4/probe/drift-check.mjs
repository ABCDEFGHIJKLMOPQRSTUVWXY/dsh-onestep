/**
 * P4-1 探针③附：同一页面连续 10 次 morph 的 ready/提交成本漂移实验（fresh page）。
 * 目的：区分「VT/提交本身的固有成本」与「长时间反复过渡后的累计漂移」。
 * 用法：node scripts/p4/probe/drift-check.mjs
 * 产物：artifacts/p4/probe/drift-check.json
 */
import { createResults, sleep, openApp, closeApp, enterStage, installRuntime, relPath, stats } from './lib.mjs'
const results = createResults('drift-check', '临时：连续 morph 漂移实验')
let app = null
try {
  app = await openApp({ viewport: { width: 1440, height: 900 } })
  const { page } = app
  await enterStage(page, { count: 3 })
  await installRuntime(page)
  await page.evaluate(async () => { const R = window.__P4; R.installVtStyle({}); R.applyWindowNames(); await R.sleep(40) })
  const runs = []
  for (let i = 0; i < 10; i += 1) {
    const record = await page.evaluate(async () => {
      const R = window.__P4
      R.applyWindowNames()
      await R.sleep(24)
      const before = R.geometry()
      const target = (before.snapshot.candidates || [])[0]
      const row = (R.snapshot().rowsSample || {})[target] || {}
      const rec = await R.morphToFinish(target, { label: 'drift' })
      R.applyWindowNames()
      return { target, title: String(row.title || '').slice(0, 40), readyMs: rec.readyMs, finishedMs: rec.finishedMs, callbackDurationMs: rec.callbackDurationMs, focusSignalMs: rec.focusSignalMs, domCommittedMs: rec.domCommittedMs, animationsAfterPseudo: (rec.animationsAfterFinal || []).filter((a) => a.pseudoElement).length }
    })
    runs.push(record)
    await sleep(120)
  }
  results.data.runs = runs
  const ready = runs.map((run) => run.readyMs)
  const commits = runs.map((run) => run.domCommittedMs)
  results.data.summarySeries = { ready, commits, firstHalf: stats(ready.slice(0, 5)), secondHalf: stats(ready.slice(5)) }
  results.step('drift', runs)
  results.assert('drift.clean', runs.every((run) => !run.finishedError), { expected: '无异常', actual: runs.map((run) => run.readyMs), category: 'drift' })
} catch (error) {
  results.fatal(error)
} finally {
  try { await closeApp(app) } catch (_error) { /* ignore */ }
  const data = results.finish()
  console.log('[drift-check] ok=' + data.ok + ' json=' + relPath('artifacts/p4/probe/drift-check.json'))
  console.log(JSON.stringify((data.runs || []).map((run, i) => ({ i, title: run.title, ready: run.readyMs, commit: run.domCommittedMs, cb: run.callbackDurationMs }))))
}
process.exitCode = results.data.ok ? 0 : 1
