/**
 * UI 场景 F：打包后端到端验证「新文件名模板 + 同时下载音频 + 字幕」
 * 直接下到用户真实的 F:\YouTube下载，产出文件可肉眼核对。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const waitUntil = async (fn, timeout, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (fn()) return true;
      await sleep(400);
    }
    throw new Error('timeout: ' + label);
  };

  try {
    const saved = await window.api.settings.set({
      quality: '360',
      audioOnly: false,
      alsoAudio: true,
      writeSubs: true,
      writeAutoSubs: true,
      subLangs: 'en',
      subFormat: 'srt',
      embedSubs: false,
      rateLimit: '',
      skipDownloaded: false,
    });

    $('urlInput').value = 'https://www.youtube.com/watch?v=5mU6SRS2Bxo';
    $('btnFetch').click();
    await waitUntil(() => document.querySelectorAll('#list .row').length > 0, 120000, '列表');
    document.querySelector('#list .row input[type=checkbox]').click();
    await sleep(300);
    $('btnDownload').click();

    const key = '5mU6SRS2Bxo';
    const item = async () => {
      const l = await window.api.queue.list();
      return (l.items || []).find((x) => x.key === key) || null;
    };
    await waitUntil(() => {
      const el = document.querySelector('#queueList .q-item');
      return el && (el.classList.contains('done') || el.classList.contains('error'));
    }, 240000, '视频下载结束');
    // 等音频导出与字幕抓取都结束
    await waitUntil(async () => true, 1, 'noop');
    for (let i = 0; i < 60; i++) {
      const it = await item();
      if (it && !it.extractingAudio && !it.fetchingSubs && (it.audioPath || it.audioError) && (it.subCount > 0 || it.subError)) break;
      await sleep(1000);
    }
    const it = await item();
    return {
      ok: true,
      filePath: it.filePath,
      audioPath: it.audioPath,
      subPaths: it.subPaths,
      stage: it.stage,
      audioError: it.audioError,
      subError: it.subError,
      fileNameTemplate: saved.filenameTemplate,
      subLangs: saved.subLangs,
      subFormat: saved.subFormat,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
})();
