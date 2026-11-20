/**
 * 舞台样式（CSS 字符串，apply 时注入/卸载）。
 * 约束（开发文档 §8.3）：只用 --dsw-alias-* / --dsw-elevation-* / 半径/间距 token，
 * 禁止字面色与组件库；动效 transform/opacity；prefers-reduced-motion 全降级。
 * P4-2：动效时长/距离/曲线 token 由 motion.js 单一源插值到 :root（覆盖 stage 与 portal 层）。
 *
 * 关键结构（P1 review 修复）：
 * - .onestep-stage 由 React 按「main 列宿主矩形」写入 left/top/width/height（position:fixed），
 *   不再用 inset:0 逃逸到 AppFrame 覆盖官方左栏；
 * - 候场窗收敛为卡片形态（§7.4 尺寸、§7.7 右下控制点），关闭控制点默认隐藏、hover/focus 显示。
 */
import { motionTokensCss, motionReducedCss, motionViewTransitionCss } from './motion.js'

export const CSS = `
${motionTokensCss()}
.onestep-stage{position:fixed;z-index:2;overflow:hidden;box-sizing:border-box;background:var(--dsw-alias-bg-base,#15181c);color:var(--dsw-alias-label-primary,#e6e6e6);font:13px/1.45 var(--dsw-font-family,system-ui,sans-serif)}
.onestep-stage *{box-sizing:border-box}
.onestep-stage-rail{position:absolute;display:flex;gap:12px;padding:0;view-transition-name:var(--onestep-rail-vt-name,none)}
/* 收起态：候场栏收为 40px 边条，需压在焦点窗（z-index:3）之上才可见（P2-6 截图复核发现的绘制缺陷修复）。 */
.onestep-stage-rail[data-collapsed="1"]{z-index:4;background:var(--dsw-alias-bg-layer-1,#1b1f24)}
.onestep-stage[data-rail-side="left"] .onestep-stage-rail[data-collapsed="1"]{border-right:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:0 8px 8px 0}
.onestep-stage[data-rail-side="top"] .onestep-stage-rail[data-collapsed="1"]{border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:0 0 8px 8px}
.onestep-frame{position:absolute;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-2,#2c2c2e);view-transition-name:var(--onestep-vt-name,none);box-shadow:var(--dsw-elevation-panel,0 8px 24px rgba(0,0,0,.22));transition:box-shadow var(--onestep-base) var(--onestep-ease),transform var(--onestep-base) var(--onestep-ease),border-color var(--onestep-base) var(--onestep-ease)}
/* P4-4：舞台进场 260ms（宿主矩形就绪后）：整体淡入 + 焦点窗 .98→1 + 候场栏侧向滑入；只动 opacity/transform。 */
.onestep-stage[data-ready="1"]{animation:onestep-stage-in var(--onestep-stage-in) ease-out}
.onestep-stage[data-ready="1"] .onestep-frame[data-mode="focus"]{animation:onestep-focus-in var(--onestep-stage-in) ease-out}
.onestep-stage[data-ready="1"] .onestep-stage-rail{animation:onestep-rail-in var(--onestep-stage-in) ease-out}
.onestep-stage[data-rail-side="left"]{--onestep-rail-dx:calc(-1 * var(--onestep-rail-shift))}
.onestep-stage[data-rail-side="top"]{--onestep-rail-dy:calc(-1 * var(--onestep-rail-shift))}
@keyframes onestep-stage-in{from{opacity:0}to{opacity:1}}
@keyframes onestep-focus-in{from{transform:scale(var(--onestep-scale-enter))}to{transform:none}}
@keyframes onestep-rail-in{from{opacity:0;transform:translate(var(--onestep-rail-dx,0px),var(--onestep-rail-dy,0px))}to{opacity:1;transform:none}}
/* 候场卡：设计稿 01-left-rail / 产品报告 §6.6 M4/M5 —— 圆角卡片、轻阴影、hover 抬起 */
.onestep-frame[data-mode="candidate"]{z-index:1;box-shadow:var(--dsw-elevation-soft,0 4px 14px rgba(0,0,0,.18));cursor:pointer}
/* 焦点窗：产品报告 §9.2 —— 圆角 --dsw-radius-lg（16px）、层级高于候场卡（DOM 为 Tab 顺序服务，视觉层级用 z-index） */
.onestep-frame[data-mode="focus"]{z-index:3;border-radius:var(--dsw-radius-lg,16px)}
.onestep-frame[data-mode="candidate"]{transition-duration:var(--onestep-fast)}
@media (hover:hover){.onestep-frame[data-mode="candidate"]:hover{box-shadow:var(--dsw-elevation-panel,0 8px 24px rgba(0,0,0,.22));border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.45));transform:translateY(calc(-1 * var(--onestep-hover-lift)))}}
/* P4-5：完成闪烁 = 600ms×2（报告 §9.3）；只动 outline（不触发布局、不覆盖高程阴影）。 */
.onestep-frame[data-flash="1"]{outline:2px solid transparent;outline-offset:1px;animation:onestep-flash calc(var(--onestep-flash) * 2) var(--onestep-ease)}
@keyframes onestep-flash{0%{outline-color:transparent}10%{outline-color:var(--dsw-alias-state-business-primary,#4c8dff)}45%{outline-color:transparent}60%{outline-color:var(--dsw-alias-state-business-primary,#4c8dff)}95%,100%{outline-color:transparent}}
/* 焦点窗 chrome：高约 40px（开发文档 §6.4；产品报告 §9.2 的 36 为设计稿旧值，P2 保留实现 40） */
.onestep-chrome{flex:0 0 auto;display:flex;align-items:center;gap:8px;min-height:40px;padding:0 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-1,#1b1f24)}
/* 候场卡标题行：高约 32px；卡片形态下背景透明、无分隔线（设计稿卡片） */
.onestep-chrome[data-mode="candidate"]{min-height:32px;padding:0 10px;gap:6px;border-bottom:0;background:transparent}
/* 状态点：产品报告 §9.2 —— 6px 视觉 / 12px 命中；§10.4 —— 颜色 + 形状双编码（圆形=运行/空闲、三角=待处理、方形=完成未读） */
.onestep-dot-hit{display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;flex:0 0 auto}
.onestep-dot{display:block;flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#7d8590);transition:background-color var(--onestep-fast) linear}
.onestep-dot[data-tone="running"]{background:var(--dsw-alias-state-business-primary,#4c8dff)}
.onestep-dot[data-tone="pending"]{width:0;height:0;border-radius:0;background:transparent;border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:7px solid var(--dsw-alias-state-warn-primary,#f59e0b)}
.onestep-dot[data-tone="unread"]{border-radius:1px;background:var(--dsw-alias-state-success-primary,#22c55e)}
.onestep-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary,#e6e6e6)}
.onestep-chrome[data-mode="candidate"] .onestep-title{font-size:12px;line-height:16px;font-weight:500}
/* 候场卡标题 = 键盘「提升为焦点」按钮（外观与标题文字一致，focus-visible 有明确焦点环） */
.onestep-title-btn{display:block;padding:0;border:0;background:transparent;text-align:left;font-family:inherit;cursor:pointer}
.onestep-title-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:2px;border-radius:4px}
.onestep-sub{flex:0 0 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:42%;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary,#9aa4b2)}
.onestep-chrome-actions{flex:0 0 auto;display:flex;align-items:center;gap:2px}
.onestep-btn{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;height:24px;min-width:24px;padding:0 6px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#9aa4b2);font:inherit;font-size:12px;cursor:pointer}
.onestep-btn:hover,.onestep-btn:focus-visible{border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-2,#252a31);color:var(--dsw-alias-label-primary,#e6e6e6);outline:none}
.onestep-menu-wrap{position:relative}
.onestep-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:40;display:flex;flex-direction:column;min-width:168px;padding:4px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:10px;background:var(--dsw-alias-bg-layer-3,#2a3038);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.26));animation:onestep-menu-in var(--onestep-menu) ease-out}
@keyframes onestep-menu-in{from{opacity:0;transform:translateY(calc(-1 * var(--onestep-shift-menu)))}to{opacity:1;transform:none}}
.onestep-menu-item{display:flex;align-items:center;height:30px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.onestep-menu-item:hover,.onestep-menu-item:focus-visible{background:var(--dsw-alias-bg-layer-2,#252a31);outline:none}
.onestep-menu-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l2,rgba(127,127,127,.28))}
/* 关闭控制点：视觉 12px 圆点 / 24px 命中区；默认中性，hover 为 error 底 + 白叉（产品报告 §7.7） */
.onestep-control{position:absolute;right:6px;bottom:6px;z-index:24;display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:50%;background:transparent;cursor:pointer;opacity:0;transform:scale(.9);pointer-events:none;transition:opacity var(--onestep-fast) var(--onestep-ease) 400ms,transform var(--onestep-fast) var(--onestep-ease) 400ms,background var(--onestep-fast) linear}
.onestep-control-dot{width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-label-secondary,#8b949e);transition:opacity var(--onestep-fast) linear}
.onestep-control-x{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:14px;line-height:1;color:#fff;opacity:0;transition:opacity var(--onestep-fast) linear}
.onestep-control:hover,.onestep-control:focus-visible{background:var(--dsw-alias-state-error-primary,#ec1313);outline:none}
.onestep-control:hover .onestep-control-dot,.onestep-control:focus-visible .onestep-control-dot{opacity:0}
.onestep-control:hover .onestep-control-x,.onestep-control:focus-visible .onestep-control-x{opacity:1}
.onestep-control:focus-visible{opacity:1;transform:scale(1);pointer-events:auto;box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,#4c8dff)}
/* 候场卡：整窗 hover 显示（产品报告 §7.7） */
.onestep-frame[data-mode="candidate"]:hover .onestep-control,.onestep-frame[data-mode="candidate"]:focus-within .onestep-control{opacity:1;transform:scale(1);pointer-events:auto;transition-delay:50ms,50ms,0ms}
/* 焦点窗：右下 88×88 触发角（React 侧计时 120ms 显示 / 300ms 隐藏，CSS 只做 120ms 淡入淡出） */
.onestep-frame[data-mode="focus"] .onestep-control{transition-delay:0ms,0ms,0ms}
.onestep-frame[data-mode="focus"] .onestep-control[data-show="1"]{opacity:1;transform:scale(1);pointer-events:auto;transition-delay:0ms,0ms,0ms}
@media (hover:none){.onestep-control{opacity:1;transform:scale(1);pointer-events:auto;transition-delay:0ms}}
.onestep-body{position:relative;flex:1 1 auto;min-height:0;overflow:auto}
.onestep-body[data-inert="1"]{overflow:hidden}
/* 焦点窗内容区与官方会话区同底色（bg-base）：官方 composerSeat 自带 linear-gradient(transparent→bg-base)，
   若窗口底色不是 bg-base，底部会出现一条割裂的渐变带。 */
.onestep-frame[data-mode="focus"]{background:var(--dsw-alias-bg-base,#15181c)}
.onestep-frame[data-mode="focus"] .onestep-body{background:var(--dsw-alias-bg-base,#15181c)}
/* 候场卡静态快照：官方内容按逻辑宽度渲染一次后克隆为静态画面，整体等比缩放，避免在 232px 逻辑宽度下重排导致布局崩坏 */
.onestep-thumb{position:absolute;inset:0;overflow:hidden;background:var(--dsw-alias-bg-base,#15181c)}
.onestep-thumb-content{position:absolute;left:0;top:0;transform-origin:top left;pointer-events:none}
/* 候场栏 ↔ 焦点窗 可拖拽分隔条（比例调整） */
.onestep-splitter{position:absolute;z-index:14;display:flex;align-items:center;justify-content:center;background:transparent;touch-action:none;outline:none}
.onestep-splitter[data-orientation="vertical"]{cursor:col-resize}
.onestep-splitter[data-orientation="horizontal"]{cursor:row-resize}
.onestep-splitter::after{content:"";border-radius:999px;background:var(--dsw-alias-border-l2,rgba(127,127,127,.28));transition:background var(--onestep-fast) linear,transform var(--onestep-fast) var(--onestep-ease)}
.onestep-splitter[data-orientation="vertical"]::after{width:4px;height:44px}
.onestep-splitter[data-orientation="horizontal"]::after{width:44px;height:4px}
.onestep-splitter:hover::after,.onestep-splitter:focus-visible::after{background:var(--dsw-alias-state-business-primary,#4c8dff)}
.onestep-splitter:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,#4c8dff);border-radius:6px}
/* 候场卡不渲染官方输入区（composer）——232×148 卡片曾被官方“对话框”整块覆盖，且无法交互；
   只在会话需要人工介入时用气泡提示（见 .onestep-bubble）。live 缩略档也保持“只看不输入”。 */
.onestep-frame[data-mode="candidate"] [data-composer-seat],
.onestep-frame[data-mode="candidate"] [data-composer-card],
.onestep-frame[data-mode="candidate"] [data-slot="conversation.composer.bar"],
.onestep-frame[data-mode="candidate"] [data-chain-overlay-fallback="conversation.composer"]{display:none!important}
.onestep-card-body{display:flex;flex-direction:column;gap:6px;padding:2px 10px 10px;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2)}
.onestep-card-meta{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2)}
.onestep-bubble{position:absolute;left:8px;right:8px;bottom:8px;z-index:22;display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(245,158,11,.45));background:var(--dsw-alias-state-warn-tertiary,rgba(245,158,11,.15));color:var(--dsw-alias-state-warn-label,#dd8629);font-size:12px;font-weight:600;box-shadow:var(--dsw-elevation-soft,0 4px 14px rgba(0,0,0,.18));cursor:pointer;animation:onestep-bubble-in var(--onestep-base) var(--onestep-ease)}
.onestep-bubble[data-leaving="1"]{animation:onestep-bubble-out var(--onestep-bubble-out) ease-in forwards;pointer-events:none}
.onestep-bubble::before{content:"";flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:currentColor}
.onestep-bubble::after{content:"›";margin-left:auto;font-size:14px;line-height:1}
@keyframes onestep-bubble-in{from{opacity:0;transform:translateY(var(--onestep-shift))}to{opacity:1;transform:none}}
@keyframes onestep-bubble-out{from{opacity:1;transform:none}to{opacity:0;transform:translateY(var(--onestep-shift))}}
/* 需要人工介入的候场卡：边框强调 + 微弱呼吸（reduced-motion 下关闭） */
.onestep-frame[data-mode="candidate"][data-pending="1"]{border-color:var(--dsw-alias-state-warn-primary,#f59e0b);box-shadow:var(--dsw-elevation-panel,0 8px 24px rgba(0,0,0,.22)),0 0 0 1px var(--dsw-alias-state-warn-primary,#f59e0b)}
@media (prefers-reduced-motion:reduce){.onestep-bubble,.onestep-bubble[data-leaving="1"]{animation:none}}
.onestep-stage-rail .onestep-rail-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:10px;color:var(--dsw-alias-label-secondary,#9aa4b2);font-size:12px}
/* P2-3 候场栏收起/展开手柄：收起后只剩 40px 边条，手柄常显且键盘可达（aria-expanded 表达状态） */
.onestep-rail-toggle{position:absolute;z-index:26;display:flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:6px;background:var(--dsw-alias-bg-layer-3,#2a3038);color:var(--dsw-alias-label-secondary,#9aa4b2);font:inherit;font-size:14px;line-height:1;cursor:pointer}
.onestep-rail-toggle:hover,.onestep-rail-toggle:focus-visible{border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.45));color:var(--dsw-alias-label-primary,#e6e6e6);outline:none}
.onestep-rail-toggle:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,#4c8dff)}
.onestep-stage[data-rail-side="left"] .onestep-rail-toggle{left:2px;bottom:8px}
.onestep-stage[data-rail-side="top"] .onestep-rail-toggle{right:8px;top:2px}
/* 0.6.1：点击换焦的占位焦点内容（VT 首帧轻量提交；真实聊天体在动画期间挂载） */
.onestep-focus-preview{position:absolute;inset:0;display:flex;flex-direction:column;padding:18px 22px;gap:14px;color:var(--dsw-alias-label-primary,#e6edf5)}
.onestep-focus-preview-head{display:flex;align-items:center;gap:8px;font-size:13px;min-height:20px}
.onestep-focus-preview-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60%}
.onestep-focus-preview-state{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa4b2)}
.onestep-focus-preview-body{display:flex;flex-direction:column;gap:12px;margin-top:16px;opacity:.6}
.onestep-focus-preview-line{height:10px;border-radius:6px;width:78%;background:var(--dsw-alias-border-l1,rgba(127,127,127,.22))}
.onestep-focus-preview-line.short{width:52%}
/* 0.6.0：候场超容量时的滚动视口与翻页按钮（滚轮/点击可用；卡尺寸保持可读） */
.onestep-rail-viewport{position:absolute;pointer-events:none;z-index:1}
.onestep-rail-viewport .onestep-frame{pointer-events:auto}
.onestep-rail-scroll-controls{position:absolute;display:flex;gap:4px;z-index:5;pointer-events:none}
.onestep-rail-scroll-btn{pointer-events:auto;display:flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#1b1f24);color:var(--dsw-alias-label-secondary,#9aa4b2);font-size:11px;line-height:1;cursor:pointer;transition:background var(--onestep-fast,120ms) ease,border-color var(--onestep-fast,120ms) ease}
.onestep-rail-scroll-btn:hover,.onestep-rail-scroll-btn:focus-visible{border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.45));color:var(--dsw-alias-label-primary,#e6edf5)}
.onestep-rail-scroll-btn:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,#4c8dff)}
/* 收起态：候场栏只剩状态条（序号 + 状态点），手柄展开后恢复完整卡片 */
.onestep-rail-mini{position:absolute;left:0;top:8px;right:8px;bottom:34px;display:flex;flex-direction:column;align-items:center;gap:8px;overflow:hidden}
.onestep-rail-mini-item{display:flex;align-items:center;gap:2px;font-size:10px;color:var(--dsw-alias-label-secondary,#9aa4b2)}
.onestep-rail-mini-index{line-height:1}
.onestep-stage[data-rail-side="top"] .onestep-rail-mini{left:8px;top:0;right:34px;bottom:8px;flex-direction:row;align-items:center;gap:10px}
.onestep-toast{position:absolute;left:50%;bottom:64px;z-index:30;transform:translateX(-50%);display:flex;align-items:center;gap:12px;padding:8px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-3,#2a3038);color:var(--dsw-alias-label-primary,#e6e6e6);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.26));font-size:12px;animation:onestep-toast-in var(--onestep-toast-in) ease-out,onestep-toast-fade var(--onestep-toast-out) ease calc(var(--onestep-toast-life,3000ms) - var(--onestep-toast-out)) forwards}
@keyframes onestep-toast-in{from{opacity:0;transform:translate(-50%,-6px)}to{opacity:1;transform:translate(-50%,0)}}
@keyframes onestep-toast-fade{to{opacity:0;visibility:hidden}}
/* P4-6：拖拽 HUD 进场（drag.js 的 zone 元素走 .onestep-hud-zone；只动 opacity/transform）。 */
.onestep-hud-zone{animation:onestep-hud-in var(--onestep-hud) ease-out;transition:background var(--onestep-fast) ease,border-color var(--onestep-fast) ease,box-shadow var(--onestep-fast) ease}
@keyframes onestep-hud-in{from{opacity:0;transform:scale(var(--onestep-scale-enter))}to{opacity:1;transform:none}}
/* P4-4：落点高亮 120ms（只动 background/border/shadow）。 */
.onestep-frame[data-drop="1"]{transition:border-color var(--onestep-fast) ease,box-shadow var(--onestep-fast) ease}
.onestep-stage-rail[data-drop="1"]{transition:background var(--onestep-fast) ease}
/* 拖放高亮（document capture 的 drop 由插件接管；此处给 React 侧 dragover 兜底） */
.onestep-frame[data-mode="focus"][data-drop="1"]{border-color:var(--dsw-alias-state-business-primary,#4c8dff);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary,#4c8dff)}
.onestep-stage-rail[data-drop="1"]{background:color-mix(in srgb, var(--dsw-alias-state-business-primary,#4c8dff) 10%, transparent);border-radius:10px}
/* 快速新建条：焦点窗底部整宽条（设计稿 01-left-rail「新对话框」/ 产品报告 §7.8）；z-index 必须高于官方 sticky composer（z=9） */
.onestep-quick{position:absolute;left:0;right:0;bottom:0;z-index:20;display:flex;justify-content:center;pointer-events:none}
.onestep-quick-workspace{position:relative;flex:0 0 auto}
.onestep-chip{display:inline-flex;align-items:center;gap:4px;max-width:180px;height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:8px;background:var(--dsw-alias-bg-layer-2,#2c2c2e);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:12px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.onestep-chip:hover,.onestep-chip:focus-visible{border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.45));outline:none}
.onestep-chip:disabled{cursor:default;opacity:.7}
.onestep-quick-workspace-menu{position:absolute;left:0;bottom:calc(100% + 6px);z-index:40;display:flex;flex-direction:column;min-width:180px;max-height:240px;overflow:auto;padding:4px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:10px;background:var(--dsw-alias-bg-layer-3,#2a3038);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.26));animation:onestep-menu-in var(--onestep-menu) ease-out}
.onestep-quick-inner{pointer-events:auto;display:flex;align-items:center;gap:8px;width:calc(100% - 16px);height:56px;margin:0 8px 8px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:12px;background:var(--dsw-alias-bg-layer-3,#2a3038);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.26));transform:translateY(140%);opacity:0;transition:transform var(--onestep-fast) var(--onestep-ease),opacity var(--onestep-fast) var(--onestep-ease)}
.onestep-quick[data-open="1"] .onestep-quick-inner{transform:translateY(0);opacity:1;transition-duration:var(--onestep-base)}
.onestep-quick-handle{position:absolute;left:0;right:0;bottom:0;height:24px;pointer-events:auto;display:flex;align-items:flex-end;justify-content:center}
.onestep-quick-handle::after{content:"";display:block;width:84px;height:8px;margin-bottom:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#252a31)}
.onestep-input{flex:1 1 auto;min-width:0;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:8px;background:var(--dsw-alias-bg-base,#15181c);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit}
.onestep-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4c8dff)}
.onestep-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);white-space:nowrap}
.onestep-quick-tip{font-size:11px;color:var(--dsw-alias-label-tertiary,#7d8590);white-space:nowrap}
.onestep-probe{position:fixed;left:12px;bottom:12px;z-index:2147483000;width:360px;max-height:44vh;overflow:auto;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-2,#2c2c2e);color:var(--dsw-alias-label-primary,#e6e6e6);font:12px/1.45 ui-monospace,Consolas,monospace;box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.26))}
.onestep-probe-row{display:flex;justify-content:space-between;gap:8px;white-space:nowrap}
.onestep-probe-btn{margin:4px 6px 0 0;padding:2px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:transparent;color:inherit;font:inherit;cursor:pointer}
/* 入口按钮：侧栏会话行「加入舞台」/ 官方 header「舞台」（内联样式收口为 token 样式类） */
.onestep-row-action{height:18px;padding:0 4px;font-size:11px}
.onestep-header-action{height:24px;padding:0 8px}
/* 舞台选择浮层（header 入口 / 快捷键入口）：全 token 化，无内联字面色 */
.onestep-picker-mask{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.28));animation:onestep-mask-in var(--onestep-overlay-in) ease-out}
@keyframes onestep-mask-in{from{opacity:0}to{opacity:1}}
.onestep-picker{width:min(520px,90vw);max-height:60vh;overflow:auto;padding:14px;border-radius:var(--dsw-radius-md,12px);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-3,#2a3038);color:var(--dsw-alias-label-primary,#e6e6e6);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.26));animation:onestep-panel-in var(--onestep-overlay-panel) ease-out}
@keyframes onestep-panel-in{from{opacity:0;transform:translateY(calc(-1 * var(--onestep-shift)))}to{opacity:1;transform:none}}
.onestep-picker-title{font-weight:600;margin-bottom:8px}
.onestep-picker-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);margin-bottom:8px}
.onestep-picker-item{display:flex;align-items:center;gap:8px;padding:6px 4px;border-radius:6px;cursor:pointer}
.onestep-picker-item:hover{background:var(--dsw-alias-bg-layer-2,#252a31)}
.onestep-picker-item-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.onestep-picker-item-meta{flex:0 0 auto;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2)}
.onestep-picker-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
@media (prefers-reduced-motion:reduce){.onestep-stage .onestep-dot{animation:none}.onestep-frame[data-flash="1"]{animation:none;outline:1px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:1px}.onestep-stage .onestep-control{transition-delay:0ms}.onestep-bubble,.onestep-bubble[data-leaving="1"],.onestep-toast,.onestep-menu,.onestep-quick-workspace-menu,.onestep-picker-mask,.onestep-picker,.onestep-hud-zone{animation:none}.onestep-stage[data-ready="1"],.onestep-stage[data-ready="1"] .onestep-frame[data-mode="focus"],.onestep-stage[data-ready="1"] .onestep-stage-rail{animation:none}@media (hover:hover){.onestep-frame[data-mode="candidate"]:hover{transform:none}}}

/* P4-7：官方浮窗收起/恢复的 180ms 位移过渡（仅命中插件标记的元素；transform 不触发布局）。 */
[data-dockkit-float][data-onestep-peek],[data-dockkit-float][data-onestep-peek-restoring]{transition:transform var(--onestep-peek) var(--onestep-ease)}
@media (prefers-reduced-motion:reduce){[data-dockkit-float][data-onestep-peek],[data-dockkit-float][data-onestep-peek-restoring]{transition:none}}
/* P3-11：右缘收起标签层（portal 到 body；z 63 高于浮窗层 60、低于官方菜单）。 */
.onestep-peek-layer{position:fixed;top:0;right:0;bottom:0;width:44px;z-index:63;pointer-events:none}
.onestep-peek-track{position:absolute;top:16px;right:0;display:flex;flex-direction:column;gap:6px;align-items:flex-end;max-height:calc(100% - 8px);pointer-events:none}
.onestep-peek-grip{pointer-events:auto;display:flex;align-items:center;justify-content:center;width:44px;height:19px;padding:0;border:0;border-radius:8px 0 0 8px;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);font-size:12px;line-height:1;cursor:grab;-webkit-user-select:none;user-select:none;touch-action:none;opacity:.55;transition:opacity var(--onestep-fast,120ms) ease,background var(--onestep-fast,120ms) ease}
.onestep-peek-grip:hover,.onestep-peek-grip:focus-visible{opacity:1;background:var(--dsw-alias-bg-layer-2)}
.onestep-peek-grip[data-dragging="1"]{cursor:grabbing}
.onestep-peek-grip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:1px}
.onestep-peek-grip-glyph{font-size:12px;letter-spacing:-1px}
.onestep-peek-stack{display:flex;flex-direction:column;gap:6px;align-items:flex-end;max-height:calc(100% - 24px);overflow:visible;pointer-events:auto}
.onestep-peek-tag{position:relative;display:flex;align-items:center;justify-content:center;gap:6px;width:38px;height:38px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px 0 0 10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1;cursor:pointer;box-shadow:var(--dsw-elevation-prominent);transition:background var(--onestep-fast) ease;overflow:visible;white-space:nowrap;flex:none}
.onestep-peek-tag:hover,.onestep-peek-tag:focus-visible{background:var(--dsw-alias-bg-layer-1)}
.onestep-peek-tag:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:1px}
.onestep-peek-glyph{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;font-size:14px;opacity:.85}
/* P4-7：标题改为绝对定位浮层（不参与布局），hover/focus 只动 opacity/translateX，不改标签宽度。 */
.onestep-peek-label{position:absolute;right:calc(100% + 6px);top:50%;transform:translate(4px,-50%);max-width:220px;padding:4px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-3,#2a3038);color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:0;pointer-events:none;box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.26));transition:opacity var(--onestep-fast) ease,transform var(--onestep-fast) ease}
.onestep-peek-tag:hover .onestep-peek-label,.onestep-peek-tag:focus-visible .onestep-peek-label{opacity:1;transform:translate(0,-50%)}
.onestep-peek-stack{touch-action:none;-webkit-user-select:none;user-select:none}
.onestep-peek-tag{cursor:grab}
.onestep-peek-stack[data-dragging="1"] .onestep-peek-tag,.onestep-peek-stack[data-dragging="1"]{cursor:grabbing}
/* 0.7.0：浮窗边缘缩放把手（8 向透明命中带；贴在官方浮窗内部，不改官方 DOM 结构） */
.onestep-float-resize-grip{position:absolute;z-index:6;touch-action:none;background:transparent}
.onestep-float-resize-grip[data-dir="n"]{top:0;left:12px;right:12px;height:6px;cursor:ns-resize}
.onestep-float-resize-grip[data-dir="s"]{bottom:0;left:12px;right:12px;height:6px;cursor:ns-resize}
.onestep-float-resize-grip[data-dir="w"]{left:0;top:12px;bottom:12px;width:6px;cursor:ew-resize}
.onestep-float-resize-grip[data-dir="e"]{right:0;top:12px;bottom:12px;width:6px;cursor:ew-resize}
.onestep-float-resize-grip[data-dir="nw"]{top:0;left:0;width:12px;height:12px;cursor:nwse-resize}
.onestep-float-resize-grip[data-dir="ne"]{top:0;right:0;width:12px;height:12px;cursor:nesw-resize}
.onestep-float-resize-grip[data-dir="sw"]{bottom:0;left:0;width:12px;height:12px;cursor:nesw-resize}
.onestep-float-resize-grip[data-dir="se"]{bottom:0;right:0;width:12px;height:12px;cursor:nwse-resize}
[data-dockkit-float][data-onestep-resizing]{user-select:none}
[data-dockkit-float][data-onestep-resizing] *{cursor:inherit}
/* 0.7.0：已打开浮窗被再次点击时闪烁两下（纯展示；层级抬升由官方 focus 完成） */
[data-dockkit-float][data-onestep-float-flash]::after{content:'';position:absolute;inset:0;z-index:7;border-radius:inherit;pointer-events:none;opacity:0;box-shadow:inset 0 0 0 2px var(--dsw-alias-state-business-primary,#4c8dff);animation:onestep-float-flash 240ms ease-out 2}
@keyframes onestep-float-flash{0%{opacity:0}35%{opacity:1}100%{opacity:0}}
:root[data-onestep-motion="reduced"] [data-dockkit-float][data-onestep-float-flash]::after{animation:none;opacity:1}
@media (prefers-reduced-motion:reduce){[data-dockkit-float][data-onestep-float-flash]::after{animation:none;opacity:1}}
@media (prefers-reduced-motion:reduce){.onestep-peek-tag,.onestep-peek-label,.onestep-peek-grip{transition:none}}
/* P4-2：reduced 双路径（属性 = 插件设置；media = 系统）+ View Transitions 伪元素规则 */
:root[data-onestep-motion="reduced"]{${motionReducedCss()}}
@media (prefers-reduced-motion:reduce){:root:not([data-onestep-motion="full"]){${motionReducedCss()}}}
${motionViewTransitionCss()}
`