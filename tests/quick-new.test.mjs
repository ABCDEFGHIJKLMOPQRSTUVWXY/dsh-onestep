import test from 'node:test'
import assert from 'node:assert/strict'
import { startDraft } from '../src/client/quick-new.js'

test('quickNew：原文仅传给官方草稿接口，诊断不包含用户输入', async () => {
  const prompt = 'private draft: confidential input'
  const calls = []
  const logs = []
  const workspace = { startSession(...args) { calls.push(args) } }
  await startDraft(workspace, prompt, 'workspace-a', { log: (...args) => logs.push(args) })
  assert.deepEqual(calls, [['workspace-a', { prompt, whenDraftExists: 'replace' }]])
  assert.deepEqual(logs, [['quickNew.start', { promptLength: prompt.length, workspaceId: 'workspace-a' }]])
  assert.equal(JSON.stringify(logs).includes(prompt), false)
})

test('quickNew：等待异步创建完成，失败原样透传且不记录成功', async () => {
  let rejectCreation
  let finished = false
  const logs = []
  const failure = new Error('creation failed')
  const workspace = { startSession() { return new Promise((resolve, reject) => { rejectCreation = reject }) } }
  const pending = startDraft(workspace, 'draft', null, { log: (...args) => logs.push(args) })
  pending.then(() => { finished = true }, () => { finished = true })
  const rejected = assert.rejects(pending, (error) => error === failure)
  await Promise.resolve()
  assert.equal(finished, false)
  assert.deepEqual(logs, [])
  rejectCreation(failure)
  await rejected
  assert.deepEqual(logs, [])
})

test('quickNew：缺服务与同步异常均可由 UI 捕获，省略工作区保持默认行为', async () => {
  await assert.rejects(startDraft(null, 'draft'), /startSession missing/)
  const failure = new Error('unavailable')
  await assert.rejects(startDraft({ startSession() { throw failure } }, 'draft'), (error) => error === failure)
  await startDraft({ startSession(workspaceId, options) {
    assert.equal(workspaceId, undefined)
    assert.deepEqual(options, { prompt: 'draft', whenDraftExists: 'replace' })
  } }, 'draft')
})
