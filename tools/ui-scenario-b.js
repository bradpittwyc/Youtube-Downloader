/**
 * UI 场景 B：完整下载流程
 * 单个视频 → 识别 → 选画质 360p → 点击「开始下载」→ 观察队列进度 → 等待完成
 * 限速 1M 以便有足够时间观察进行中的进度条。
 */
(async () => {
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitUntil = async (fn, timeout, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (fn()) return true;
      await sleep(300);
    }
    throw new Error('timeout: ' + label);
  };

  const observations = [];
  const log = [];

  try {
    // 准备：限速 1M，避免下载瞬间完成，方便观察进行中状态
    await window.api.settings.set({
      rateLimit: '1M',
      skipDownloaded: false,
      autoRetry: 0,
      audioOnly: false,
      quality: '360',
    });
    log.push('已设置限速 1M / 关闭跳过已下载');

    // 1. 粘贴单个视频链接
    $('urlInput').value = 'https://www.youtube.com/watch?v=Qtl8lJwbd4g';
    $('btnFetch').click();
    await waitUntil(() => document.querySelectorAll('#list .row').length > 0, 120000, '单视频列表');
    log.push('单视频识别完成');

    const singleTitle = document.querySelector('#list .row .row-title')?.textContent.trim();
    const tabs = Array.from(document.querySelectorAll('#tabs .tab')).map((t) => t.textContent.trim());

    // 2. 选画质 360p（走真实 change 事件）
    const qs = $('qualitySelect');
    qs.value = '360';
    qs.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(400);
    log.push('画质设为 360p');

    // 3. 勾选
    document.querySelector('#list .row input[type=checkbox]').click();
    await sleep(300);
    const counter = $('selCounter').textContent;

    // 4. 点击开始下载
    $('btnDownload').click();
    log.push('已点击开始下载');

    // 5. 等待队列出现 downloading
    await waitUntil(() => document.querySelector('#queueList .q-item'), 30000, '队列项出现');
    await waitUntil(
      () => document.querySelector('#queueList .q-item.downloading'),
      30000,
      '进入 downloading'
    );
    log.push('队列进入 downloading');

    // 6. 采样进行中的状态
    const sample = () => {
      const el = document.querySelector('#queueList .q-item');
      if (!el) return null;
      return {
        cls: el.className,
        title: el.querySelector('.q-title')?.textContent.trim(),
        stage: el.querySelector('.q-stage')?.textContent.trim(),
        nums: el.querySelector('.q-nums')?.textContent.trim(),
        barWidth: el.querySelector('.q-bar > i')?.style.width,
        actions: Array.from(el.querySelectorAll('.q-actions button')).map((b) => b.textContent.trim()),
      };
    };
    for (let i = 0; i < 6; i++) {
      await sleep(2000);
      const s = sample();
      if (s) observations.push(s);
    }

    // 7. 等待完成
    await waitUntil(() => document.querySelector('#queueList .q-item.done'), 180000, '下载完成');
    await sleep(1200);
    const final = sample();
    const stats = $('queueStats').innerText.replace(/\s+/g, ' ').trim();
    log.push('队列任务完成');

    return {
      ok: true,
      log,
      singleTitle,
      tabs,
      counter,
      firstObservation: observations[0] || null,
      lastObservation: observations[observations.length - 1] || null,
      progressAdvanced: observations.length > 1 && observations[0].barWidth !== observations[observations.length - 1].barWidth,
      final,
      stats,
      queueBadge: $('queueBadge').textContent,
    };
  } catch (err) {
    return { ok: false, error: err.message, log, observations };
  }
})();
