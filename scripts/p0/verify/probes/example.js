// probe 示例：采集 boot payload 摘要 + 当前页面基础信息。
// 用法：node scripts/p0/verify/playwright-driver.mjs probe --script scripts/p0/verify/probes/example.js
// 契约：文件内容按函数体执行（可 await），return 值被安全序列化；可用 window.__P0__ helper。

var boot = window.__DSH_BOOT__ || null;
var entries = boot && Array.isArray(boot.entries) ? boot.entries : [];
var self = null;
for (var i = 0; i < entries.length; i += 1) {
  if (entries[i] && /onestep/i.test(String(entries[i].id || ''))) {
    self = entries[i];
    break;
  }
}
return {
  title: document.title,
  url: location.href.replace(/\?.*$/, ''),
  bootKeys: boot ? Object.keys(boot) : null,
  entriesCount: entries.length,
  selfEntry: self,
  clientScripts: Array.prototype.slice.call(document.querySelectorAll('script[src]')).map(function (s) {
    return s.src;
  }),
  p0HelperPresent: !!window.__P0__,
  p0Globals: Object.keys(window).filter(function (k) {
    return /onestep/i.test(k);
  }),
};
