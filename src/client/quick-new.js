/** 创建官方草稿会话；诊断只记录长度，不保留用户输入。 */
export async function startDraft(workspace, text, workspaceId, log) {
  if (!workspace || typeof workspace.startSession !== 'function') throw new Error('uiWorkspace.startSession missing')
  const prompt = String(text || '')
  await workspace.startSession(workspaceId || undefined, { prompt, whenDraftExists: 'replace' })
  if (log) log.log('quickNew.start', { promptLength: prompt.length, workspaceId: workspaceId || null })
}
