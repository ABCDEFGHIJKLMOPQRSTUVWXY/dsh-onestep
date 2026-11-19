// probe: 侧栏会话行 / 可拖拽元素 DOM 结构（为 S7 拖拽探针定位源元素与属性）
// 用法：node scripts/p0/verify/playwright-driver.mjs probe --script scripts/p0/verify/probes/sidebar-dom.js --out artifacts/p0/verify/sidebar-dom.json

function pick(el) {
  var r = el.getBoundingClientRect();
  return {
    tag: el.tagName,
    cls: String(el.className || '').slice(0, 120),
    draggableAttr: el.getAttribute('draggable'),
    rowKey: el.getAttribute('data-row-key'),
    sessionId: el.getAttribute('data-session-id'),
    text: String(el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    inSidebar: !!el.closest('aside,[class*="sidebar"],[data-sidebar]'),
  };
}

var rows = Array.prototype.slice.call(document.querySelectorAll('[data-row-key]'));
var draggables = Array.prototype.slice.call(document.querySelectorAll('[draggable="true"]'));
var sessionish = Array.prototype.slice.call(document.querySelectorAll('[data-session-id],[class*="sessionRow"],[class*="session-row"],[class*="SessionRow"]'));
var sidebar = document.querySelector('aside,[class*="sidebar"],[data-sidebar]');

var pickResult = function (el, selector) {
  var target = el;
  var draggableAncestor = null;
  var walk = el;
  for (var i = 0; i < 8 && walk; i += 1, walk = walk.parentElement) {
    if (walk.getAttribute && walk.getAttribute('draggable') === 'true') {
      draggableAncestor = pick(walk);
      break;
    }
  }
  return { matched: selector, el: pick(target), draggableAncestor: draggableAncestor };
};

var firstRow = rows.length ? rows[0] : null;
return {
  rowsCount: rows.length,
  draggablesCount: draggables.length,
  sessionishCount: sessionish.length,
  sidebar: sidebar ? pick(sidebar) : null,
  rows: rows.slice(0, 8).map(function (el) { return pickResult(el, '[data-row-key]'); }),
  draggables: draggables.slice(0, 8).map(function (el) { return pick(el); }),
  sessionish: sessionish.slice(0, 10).map(function (el) { return pick(el); }),
  firstRowHasDraggableAncestor: firstRow ? !!pickResult(firstRow, '[data-row-key]').draggableAncestor : null,
};
