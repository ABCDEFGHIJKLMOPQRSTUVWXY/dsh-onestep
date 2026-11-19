// probe: dsh-onestep P0 插件状态（window.__ONESTEP_P0__）
// 用法：node scripts/p0/verify/playwright-driver.mjs probe --script scripts/p0/verify/probes/onestep-state.js --out artifacts/p0/verify/onestep-state.json
// 契约：文件内容按函数体执行（可 await），返回值被安全序列化成 JSON。
// 插件未加载时本探针不抛错，而是返回 present:false + diagnostics（供 S1/S10 区分「插件没装」与「探针坏了」）。

var p = window.__ONESTEP_P0__;
var boot = window.__DSH_BOOT__ || null;
var bootEntries = boot && Array.isArray(boot.entries) ? boot.entries : null;
var bootHasEntry = !!(bootEntries && bootEntries.some(function (e) { return e && e.id === 'dsh-onestep'; }));

if (!p) {
  return {
    ok: false,
    present: false,
    diagnostics: {
      reason: 'window.__ONESTEP_P0__ 不存在：插件 client bundle 可能未加载或未 apply',
      bootHasEntry: bootHasEntry,
      bootEntriesCount: bootEntries ? bootEntries.length : null,
      scriptsWithOnestep: Array.prototype.slice.call(document.querySelectorAll('script[src]')).map(function (s) { return s.src; }).filter(function (u) { return u.indexOf('dsh-onestep') >= 0; }),
      globalsMatchingOnestep: Object.keys(window).filter(function (k) { return /onestep/i.test(k); }),
      hint: '看 console 里的 [onestep-p0] 日志；确认 profile 里 bundle 已启用且页面刷新过',
    },
  };
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch (e) {
    return fallback === undefined ? { error: String((e && e.message) || e) } : fallback;
  }
}

var state = p.state || {};
var dump = safe(function () { return typeof p.dump === 'function' ? p.dump() : null; }, null);
var bootState = state.boot || (dump && dump.boot) || null;
var stageState = (dump && dump.stage) || state.stage || null;
var stageDom = null;

if (stageState) {
  stageDom = {
    mounted: stageState.mounted === true,
    everMounted: stageState.everMounted === true,
    mountCycles: stageState.mountCycles == null ? null : stageState.mountCycles,
    rootMounts: stageState.rootMounts == null ? null : stageState.rootMounts,
    rootUnmounts: stageState.rootUnmounts == null ? null : stageState.rootUnmounts,
    focusMounts: stageState.focusMounts == null ? null : stageState.focusMounts,
    focusUnmounts: stageState.focusUnmounts == null ? null : stageState.focusUnmounts,
    focusToken: stageState.focusToken || null,
    windows: Array.isArray(stageState.windows) ? stageState.windows.length : null,
    lastError: stageState.lastError || null,
    domPresent: !!document.querySelector('[data-onestep-stage]'),
  };
}

return {
  ok: true,
  present: true,
  version: p.version || state.version || null,
  applyCount: state.applyCount == null ? null : state.applyCount,
  disposeCount: state.disposeCount == null ? null : state.disposeCount,
  bootSelfEntry: (bootState && bootState.selfEntry) || null,
  bootSelfBatches: (bootState && bootState.selfBatches) || null,
  bootHasEntry: bootHasEntry,
  mainReady: state.mainReady === true,
  headerMounts: state.header ? state.header.mounts : null,
  header: state.header || null,
  stage: stageDom,
  stageRaw: stageState,
  actions: p.actions ? Object.keys(p.actions) : [],
  checks: (dump && dump.checks) || state.checks || null,
  theme: (dump && dump.theme) || null,
  dom: (dump && dump.dom) || null,
  eventsTail: dump && Array.isArray(dump.events) ? dump.events.slice(-10) : (Array.isArray(state.events) ? state.events.slice(-10) : []),
};
