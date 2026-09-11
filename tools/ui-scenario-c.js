/**
 * UI 场景 C：打包后（app.isPackaged=true）的端到端验证
 * 用真实 DOM 事件跑完整流程：填入单个视频链接 → 识别 → 选 MP3 → 开始下载 → 等待落盘。
 * 目的是证明「打包后的 exe」不仅能自检内核，还能真正调用内置 yt-dlp/ffmpeg 完成下载。
 */
(async () => {
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = [];
  const waitUntil = async (fn, timeout, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (fn()) return true;
      await sleep(300);
    }
    throw new Error('timeout: ' + label);
  };

  try {
    const bin = await window.api.bin.check();
    log.push(`ytdlp=${bin.ytdlp.ok}(${bin.ytdlp.version}) ffmpeg=${bin.ffmpeg.ok} packaged=${bin.userData}`);

    // 全量下载（不是仅音频），走 ffmpeg 合并，最能验证内置二进制
    await window.api.settings.set({
      rateLimit: '',
      skipDownloaded: false,
      autoRetry: 0,
      audioOnly: false,
      quality: '360',
    });

    $('urlInput').value = 'https://www.youtube.com/watch?v=5mU6SRS2Bxo';
    $('btnFetch').click();
    await waitUntil(() => document.querySelectorAll('#list .row').length > 0, 120000, '列表');
    log.push('识别完成: ' + document.querySelector('#list .row .row-title')?.textContent.trim());

    const qs = $('qualitySelect');
    qs.value = '360';
    qs.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(300);

    document.querySelector('#list .row input[type=checkbox]').click();
    await sleep(300);
    $('btnDownload').click();
    log.push('已开始下载: ' + $('actionSummary').textContent);

    await waitUntil(
      () => {
        const el = document.querySelector('#queueList .q-item');
        return el && (el.classList.contains('done') || el.classList.contains('error'));
      },
      240000,
      '下载结束'
    );

    const el = document.querySelector('#queueList .q-item');
    const path = el.getAttribute('data-path');
    return {
      ok: true,
      packaged: (await window.api.info()).isPackaged,
      log,
      finalClass: el.className,
      filePath: path,
      stats: $('queueStats').innerText.replace(/\s+/g, ' ').trim(),
    };
  } catch (err) {
    return { ok: false, error: err.message, log };
  }
})();
