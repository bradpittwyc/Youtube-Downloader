/**
 * UI 场景 D：验证「旧版本入队的暂停任务」能否在新版本下继续断点续传
 * （只跑一小会儿就重新暂停，不真的下完几个 GB）
 */
(async () => {
  const KEY = 'baecUt1GaPk';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const find = async () => {
    const l = await window.api.queue.list();
    return (l.items || []).find((x) => x.key === KEY) || null;
  };

  const b = await find();
  if (!b) return { ok: false, error: '队列里找不到该任务' };
  const startBytes = b.downloadedBytes;
  const startStatus = b.status;

  await window.api.queue.action(KEY, 'resume');

  let grew = false;
  let minSeen = Number.MAX_SAFE_INTEGER;
  let last = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const it = await find();
    if (!it) break;
    last = it;
    minSeen = Math.min(minSeen, it.downloadedBytes || 0);
    if ((it.downloadedBytes || 0) > startBytes + 2 * 1024 * 1024) {
      grew = true;
      break;
    }
    if (it.status === 'error') break;
  }

  // 立刻恢复到暂停状态，不占用带宽也不破坏进度
  await window.api.queue.action(KEY, 'pause');
  await sleep(1500);
  const a = await find();

  return {
    ok: true,
    startStatus,
    startBytesMB: +(startBytes / 1048576).toFixed(1),
    endBytesMB: a ? +((a.downloadedBytes || 0) / 1048576).toFixed(1) : null,
    minSeenMB: +(minSeen / 1048576).toFixed(1),
    status: a ? a.status : null,
    stage: a ? a.stage : null,
    resumedNotRestarted: grew && minSeen >= startBytes,
    verdict: grew && minSeen >= startBytes ? '✅ 断点续传成功（没有从头再来）' : '❌ 疑似重新开始了',
  };
})();
