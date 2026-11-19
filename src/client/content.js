/**
 * 窗口内容组件：官方 conversation.content Factory occurrence + 渲染错误边界。
 *
 * 已验证机制（P0 S4）：`renderFactorySlot('conversation.content', {variant:'embedded', phase, hero},
 * {slots:{views}}) ` 在第三方插件可用；会话绑定来自外层显式 SessionProvider。
 * 状态归类/相对时间在 status.js（纯函数，单测覆盖）；本模块只做渲染。
 */
import { React, h } from './h.js'
import { CONTENT_FACTORY } from './adapter.js'

/** 工厂视图的局部组件：固定 Chat 视图（module-level，避免每次 render 重建导致 remount）。 */
export function FixedChatView(props) {
  return props.renderSlot('conversation.session', { view: 'chat' })
}

/**
 * 单个窗口的渲染错误边界：失败降级为错误提示，不影响其他窗口。
 * label 由父级传入（i18n 文案归 locale 字典所有；本组件不持产品文案）。
 */
export class WindowErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error: String((error && error.message) || error) }
  }
  componentDidCatch(error) {
    if (this.props.onError) this.props.onError(this.props.sessionId, String((error && error.message) || error))
  }
  render() {
    if (this.state.error !== null) {
      const label = this.props.label || ''
      return h(
        'div',
        { style: { padding: 12, color: 'var(--dsw-alias-label-secondary,#9aa4b2)', fontSize: 12 } },
        label ? label + ': ' + this.state.error : this.state.error,
      )
    }
    return this.props.children
  }
}

/**
 * 官方 conversation.content 的 occurrence（注册到 onestep.window，session 作用域）。
 * 焦点窗 interactive=true；候场窗 interactive=false（由父层加 inert + 点击面）。
 * @param {object} props slot props（useSession/useConversation/useSessions/renderFactorySlot + owner props）
 */
export function WindowContentOccurrence(props) {
  const sessionId = String(props.ownerSessionId)
  const interactive = !!props.interactive
  const session = props.useSession((value) => value)
  const conversation = props.useConversation((value) => value)
  const summaryBlank = props.useSessions((state) => (state.byId[sessionId] ? state.byId[sessionId].blank : undefined))

  const active = !!(conversation && conversation.activeTargets && conversation.activeTargets.size > 0)
  let shellPhase = 'blank'
  if (session !== undefined && session !== null) {
    if (active || (!session.blank && !session.awaitingFirstTurn) || session.running) shellPhase = 'active'
    else if (session.promptAttempted) shellPhase = 'engaging'
  }
  const settling = shellPhase === 'blank' && session !== undefined && session !== null && session.openState === 'loading' && summaryBlank !== true
  const hero = shellPhase === 'blank' && session !== undefined && session !== null && (session.openState === 'open' || summaryBlank === true)
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'

  return h(
    'div',
    {
      'data-onestep-occurrence': sessionId,
      'data-onestep-interactive': interactive ? '1' : '0',
      style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 },
    },
    props.renderFactorySlot(
      CONTENT_FACTORY.name,
      { variant: CONTENT_FACTORY.variant, phase, hero },
      { slots: { views: FixedChatView } },
    ),
  )
}
