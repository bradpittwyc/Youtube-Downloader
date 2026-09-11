/**
 * UI 场景 A：粘贴频道主页 → 点击「识别」→ 等待列表渲染 → 全选
 * 该脚本在渲染进程里真实执行，用来验证 渲染层 ↔ preload ↔ 主进程 的完整接线。
 * 返回一个结果对象，会打印到主进程日志里。
 */
(async () => {
  const log = [];
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitUntil = async (fn, timeout, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (fn()) return true;
      await sleep(400);
    }
    throw new Error('timeout: ' + label);
  };

  try {
    // 1. 输入框写入频道链接
    const input = $('urlInput');
    input.value = 'https://www.youtube.com/@MrBeast';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    log.push('已填入链接');

    // 2. 真实点击「识别」按钮
    $('btnFetch').click();
    log.push('已点击识别');

    // 3. 等待频道视图出现
    await waitUntil(() => !$('channelView').classList.contains('hidden'), 180000, '频道列表出现');
    await waitUntil(() => document.querySelectorAll('#list .row').length > 0, 30000, '列表行渲染');
    log.push('频道列表已渲染');

    const channelTitle = $('chTitle').textContent;
    const tabs = Array.from(document.querySelectorAll('#tabs .tab')).map((t) => t.textContent.trim());
    const rowCount = document.querySelectorAll('#list .row').length;
    const firstRowTitle = document.querySelector('#list .row .row-title')?.textContent.trim();

    // 4. 切到 Shorts 分类
    const shortsTab = Array.from(document.querySelectorAll('#tabs .tab')).find((t) =>
      t.textContent.includes('Shorts')
    );
    if (shortsTab) {
      shortsTab.click();
      await sleep(1200);
    }
    const shortsRows = document.querySelectorAll('#list .row').length;
    const shortsFirst = document.querySelector('#list .row .row-title')?.textContent.trim();
    log.push('已切换 Shorts 分类');

    // 5. 勾选前 5 个（点击 row，走真实事件委托）
    const rows = Array.from(document.querySelectorAll('#list .row')).slice(0, 5);
    for (const r of rows) {
      r.querySelector('input[type=checkbox]').click();
      await sleep(60);
    }
    log.push('已勾选 ' + rows.length + ' 个');

    const counter = $('selCounter').textContent;
    const summary = $('actionSummary').textContent;
    const downloadEnabled = !$('btnDownload').disabled;

    // 6. 搜索过滤
    const s = $('searchInput');
    s.value = '';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(500);

    return {
      ok: true,
      log,
      channelTitle,
      tabs,
      rowCount,
      firstRowTitle,
      shortsRows,
      shortsFirst,
      counter,
      summary,
      downloadEnabled,
      thumbLoaded: Array.from(document.querySelectorAll('#list .row-thumb')).filter((i) => i.naturalWidth > 0).length,
    };
  } catch (err) {
    return { ok: false, error: err.message, log };
  }
})();
