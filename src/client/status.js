/**
 * 会话状态归类与格式化的纯函数（无 React/DOM 依赖，供组件与单测共用）。
 */

/**
 * 会话状态归类（候场卡/焦点 chrome/反馈共用）。
 * @param {object|null} status useSessionStatus 行
 * @param {object|null} row useSessions 行
 * @returns {{kind:string,labelKey:string,tone:string}}
 */
export function classifyStatus(status, row) {
  if (status && status.pendingInteraction) {
    const kind = status.pendingInteraction.kind
    if (kind === 'question') return { kind: 'pendingQuestion', labelKey: 'card.pendingQuestion', tone: 'pending' }
    if (kind === 'plan') return { kind: 'pendingPlan', labelKey: 'card.pendingPlan', tone: 'pending' }
    return { kind: 'pendingApproval', labelKey: 'card.pendingApproval', tone: 'pending' }
  }
  if (status && status.completionUnread) return { kind: 'completedUnread', labelKey: 'card.completedUnread', tone: 'unread' }
  if (status && status.running) return { kind: 'running', labelKey: 'card.running', tone: 'running' }
  if (row && row.blank) return { kind: 'blank', labelKey: 'card.blank', tone: 'idle' }
  return { kind: 'idle', labelKey: 'card.idle', tone: 'idle' }
}

/**
 * 相对时间（Intl；失败回退空串）。
 * @param {number|undefined} epochMs 时间戳
 * @param {number} [now] 当前时间
 * @returns {string}
 */
export function formatRelative(epochMs, now = Date.now()) {
  if (!epochMs || typeof epochMs !== 'number') return ''
  try {
    const minutes = Math.round((epochMs - now) / 60000)
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
    if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
    return formatter.format(Math.round(minutes / 60), 'hour')
  } catch (_error) {
    return ''
  }
}
