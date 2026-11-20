import test from 'node:test'
import assert from 'node:assert/strict'
import { layoutUsable, preferredRailSide, solve } from '../src/client/layout.js'
import { LIMITS } from '../src/client/adapter.js'

const base = { railSide: 'left', railSize: 232, railCollapsed: false, count: 2 }

test('left rail: focus and top-aligned fixed-height cards (设计稿 232×148)', () => {
  const two = solve({ ...base, count: 2, width: 1440, height: 900 })
  assert.equal(two.degraded, 'none')
  assert.equal(two.rail.w, 232)
  assert.equal(two.focus.x, 8 + 232 + 12)
  assert.equal(two.focus.w, 1440 - 8 - 232 - 12)
  assert.equal(two.focus.h, 900)
  assert.equal(two.cards.length, 2)
  // 候场卡固定 √2:1（宽 232 → 高 232/√2），顶部对齐、不拉伸
  const aspect = Math.SQRT2
  assert.ok(Math.abs(two.cards[0].h - 232 / aspect) < 0.01)
  assert.equal(two.cards[0].w, 232)
  assert.equal(two.cards[0].y, 0)
  assert.ok(Math.abs(two.cards[1].y - (232 / aspect + 12)) < 0.01)
  assert.ok(two.cards[1].y + two.cards[1].h < 900)

  const three = solve({ ...base, count: 3, width: 1440, height: 900 })
  assert.ok(Math.abs(three.cards[0].h - 232 / aspect) < 0.01, '3 张卡固定 √2:1')
  assert.ok(Math.abs(three.cards[2].y - (232 / aspect + 12) * 2) < 0.01)
  assert.equal(three.scroll, false)
})

test('three candidates in short container compress and mark scroll', () => {
  const layout = solve({ ...base, count: 3, width: 1280, height: 400 })
  assert.equal(layout.cards.length, 3)
  assert.equal(layout.scroll, true)
  assert.ok(layout.cards[0].h >= 108)
  assert.ok(layout.cards[2].y + layout.cards[2].h <= 400)
})

test('top rail: cards横排 + focus 在下方', () => {
  const layout = solve({ ...base, railSide: 'top', railSize: 132, width: 1280, height: 800 })
  assert.equal(layout.degraded, 'none')
  assert.equal(layout.rail.h, 132)
  assert.equal(layout.focus.y, 132 + 12)
  assert.equal(layout.cards.length, 2)
  assert.ok(Math.abs(layout.cards[0].h - 108) < 0.001)
  assert.ok(Math.abs(layout.cards[0].w - 108 * Math.SQRT2) < 0.01, '顶部候场卡宽=高×√2')
  assert.ok(layout.cards[0].x > 0, '顶部卡水平居中')
})

test('three candidates at 1280 keep cardMinHeight', () => {
  const layout = solve({ ...base, width: 1280, height: 800, count: 3 })
  assert.equal(layout.cards.length, 3)
  assert.equal(layout.scroll, false)
  assert.ok(layout.cards[0].h >= 108)
})

test('collapsed rail frees full width', () => {
  const layout = solve({ ...base, railCollapsed: true, width: 1280, height: 800 })
  assert.equal(layout.degraded, 'rail-collapsed')
  assert.equal(layout.focus.w, 1280)
  assert.equal(layout.rail.w, 40)
})

test('layoutUsable：用户收起候场栏 ≠ 窄屏，不触发退出；容器过窄才退出', () => {
  const collapsed = solve({ ...base, count: 3, railCollapsed: true, width: 1440, height: 900 })
  assert.equal(collapsed.degraded, 'rail-collapsed')
  assert.equal(collapsed.visibleCount, 0)
  assert.equal(collapsed.focus.w, 1440)
  assert.equal(layoutUsable(collapsed, { count: 3, collapsed: true }), true)
  const normal = solve({ ...base, count: 3, width: 1440, height: 900 })
  assert.equal(layoutUsable(normal, { count: 3, collapsed: false }), true)
  assert.equal(layoutUsable(normal, { count: 2, collapsed: false }), false)
  // 折叠态 + 容器过窄：solve 返回 empty（rail=null）→ 不可用（应退出）
  const tiny = solve({ ...base, count: 3, railCollapsed: true, width: 700, height: 900 })
  assert.equal(tiny.rail, null)
  assert.equal(layoutUsable(tiny, { count: 3, collapsed: true }), false)
  // count=0 时舞台本就不挂载，视为可用
  assert.equal(layoutUsable(tiny, { count: 0, collapsed: false }), true)
})

test('zero candidates collapses rail edge', () => {
  const layout = solve({ ...base, count: 0, width: 1280, height: 800 })
  assert.equal(layout.cards.length, 0)
  assert.equal(layout.focus.w, 1280)
})

test('too narrow → single degraded focus (stage should exit)', () => {
  const narrow = solve({ ...base, width: 700, height: 800 })
  assert.equal(narrow.degraded, 'none')
  assert.equal(narrow.cards.length, 0)
  assert.equal(narrow.visibleCount, 0)
  assert.equal(preferredRailSide(700), null)
})

test('rail 收窄优先于单窗；宽屏 left、中宽 top', () => {
  const layout = solve({ ...base, railSize: 320, width: 800, height: 800 })
  assert.equal(layout.degraded, 'rail-collapsed')
  assert.ok(layout.rail.w < 320)
  assert.ok(layout.focus.w >= 480)
  assert.equal(preferredRailSide(1440), 'left')
  assert.equal(preferredRailSide(900), 'top')
  // 默认 232 时 800 宽可直接容纳焦点最小宽（232+12+556）
  assert.equal(solve({ ...base, width: 800, height: 800 }).degraded, 'none')
})

test('railSize 只夹下限；超宽值按焦点窗最小尺寸收窄（0.7.0 解除最大宽度限制）', () => {
  const maxFit = 1280 - LIMITS.railInset - LIMITS.gap - LIMITS.focusMinWidth
  const huge = solve({ ...base, railSize: 9999, width: 1280, height: 800 })
  assert.equal(huge.rail.w, maxFit)
  assert.equal(huge.focus.w, LIMITS.focusMinWidth)
  assert.equal(huge.degraded, 'rail-collapsed')

  // 旧上限 320 已解除：用户拖到 600 时布局原样采用
  const wide = solve({ ...base, railSize: 600, width: 1440, height: 900 })
  assert.equal(wide.rail.w, 600)
  assert.ok(wide.focus.w > LIMITS.focusMinWidth)

  // 下限仍然生效
  const low = solve({ ...base, railSize: 1, width: 1280, height: 800 })
  assert.equal(low.rail.w, LIMITS.railLeft.min)

  // 顶部候场栏同样解除最大高度；超高时同样给焦点窗保底
  const topHuge = solve({ ...base, railSide: 'top', railSize: 9999, width: 1280, height: 800 })
  const topMaxFit = 800 - LIMITS.gap - LIMITS.focusMinHeight
  assert.equal(topHuge.rail.h, topMaxFit)
  assert.equal(topHuge.focus.h, LIMITS.focusMinHeight)
})

test('伴生窗挤压：stageW 下探 + 强制收栏 → 单窗保活', () => {
  // 右栏 push 后主区 512px：默认阈值会 empty（舞台退出）
  const def = solve({ ...base, count: 2, width: 512, height: 900 })
  assert.equal(def.visibleCount, 0)
  assert.equal(def.rail, null)

  // compact 策略：stageW=focusMinWidth(480) + railCollapsed=true → 焦点满宽单窗
  const compact = solve({ ...base, count: 2, width: 512, height: 900, railCollapsed: true, min: { stageW: 480 } })
  assert.equal(compact.degraded, 'rail-collapsed')
  assert.equal(compact.cards.length, 0)
  assert.equal(compact.visibleCount, 0)
  assert.equal(compact.focus.w, 512)
  assert.equal(compact.focus.h, 900)

  // 再窄于 focusMinWidth 仍应退出（empty）
  const tiny = solve({ ...base, count: 2, width: 420, height: 900, railCollapsed: true, min: { stageW: 480 } })
  assert.equal(tiny.visibleCount, 0)
  assert.equal(tiny.rail, null)
})

test('0.5.0/0.6.0：6 个候场卡在左/顶部候场栏（左栏改为固定尺寸滚动，顶部仍完整可见）', () => {
  // 左栏 1440×900：0.6.0 起压缩会低于最小尺寸 → 固定 √2:1 宽 232 + 纵向滚动
  const left = solve({ ...base, count: 6, width: 1440, height: 900 })
  assert.equal(left.cards.length, 6)
  assert.equal(left.scroll, true)
  assert.ok(left.contentH > left.rail.h)
  for (let i = 0; i < left.cards.length; i += 1) {
    const card = left.cards[i]
    assert.ok(card.x >= 0 && card.y >= 0)
    assert.ok(card.w > 0 && card.h > 0)
    if (i > 0) {
      const prev = left.cards[i - 1]
      assert.ok(card.y >= prev.y + prev.h, '左栏第 ' + (i + 1) + ' 张不与前一张重叠')
    }
  }
  // 顶部 980×694（用户窗口实测尺寸）：6 张横排仍放得下
  const top = solve({ ...base, railSide: 'top', railSize: 132, count: 6, width: 980, height: 694 })
  assert.equal(top.cards.length, 6)
  assert.equal(top.visibleCount, 6)
  for (let i = 0; i < top.cards.length; i += 1) {
    const card = top.cards[i]
    assert.ok(card.x >= 0)
    assert.ok(card.x + card.w <= top.rail.w + 0.01, '顶部第 ' + (i + 1) + ' 张不越界')
    if (i > 0) {
      const prev = top.cards[i - 1]
      assert.ok(card.x >= prev.x + prev.w, '顶部第 ' + (i + 1) + ' 张不与前一张重叠')
    }
  }
})

test('0.6.0：候场 >3 且压缩低于设计最小尺寸 → 固定卡尺寸 + 滚动（左/顶部）', () => {
  // 左栏 1440×900：8 张按原算法会被压到极小 → 固定 232/√2 高、内容超出、scroll=true
  const left = solve({ ...base, count: 8, width: 1440, height: 900 })
  assert.equal(left.scroll, true)
  assert.equal(left.cards.length, 8)
  const fixedLeftH = 232 / Math.SQRT2
  assert.ok(Math.abs(left.cards[0].h - fixedLeftH) < 0.01, '固定可读卡高')
  assert.ok(Math.abs(left.cards[0].w - 232) < 0.01, '固定卡宽')
  assert.ok(left.contentH > left.rail.h, '内容高度超出视口 → 可滚动')
  assert.ok(Math.abs(left.cards[7].y + left.cards[7].h - left.contentH) < 0.01, '最后一张贴内容底')
  // 顶部 980×694：8 张按原算法低于 cardMinWidth → 固定 108 高、横向滚动
  const top = solve({ ...base, railSide: 'top', railSize: 132, count: 8, width: 980, height: 694 })
  assert.equal(top.scroll, true)
  assert.equal(top.cards.length, 8)
  assert.ok(Math.abs(top.cards[0].h - 108) < 0.01, '固定卡高（cardHeightTop）')
  assert.ok(Math.abs(top.cards[0].w - 108 * Math.SQRT2) < 0.01, '固定卡宽 √2:1')
  assert.ok(top.contentW > top.rail.w, '内容宽度超出视口 → 可滚动')
  assert.ok(Math.abs(top.cards[7].x + top.cards[7].w - top.contentW) < 0.01, '最后一张贴内容右缘')
  // 6 张在 980 宽顶部栏：仍不滚动（与 0.5.0 行为一致）
  const sixTop = solve({ ...base, railSide: 'top', railSize: 132, count: 6, width: 980, height: 694 })
  assert.equal(sixTop.scroll, false)
  assert.equal(sixTop.cards.length, 6)
})
