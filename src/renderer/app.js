'use strict';
/**
 * 渲染进程：频道列表 UI + 下载队列 UI。
 *
 * ⚠️ 整段代码必须包在 IIFE 里（踩坑记录）：
 * preload 通过 contextBridge 暴露的 window.api 是「全局对象上的不可配置属性」，
 * 在全局作用域里再写 `const api = window.api` 会直接抛
 * SyntaxError: Identifier 'api' has already been declared，
 * 导致整个脚本不执行、界面全黑。放进函数作用域即可彻底避免这类冲突。
 */
(function () {
const api = window.api;

const SECTION_ORDER = ['single', 'videos', 'shorts', 'live', 'podcasts', 'playlist'];
const SECTION_LABEL = {
  single: '单个视频',
  videos: 'Videos',
  shorts: 'Shorts',
  live: 'Live 直播',
  podcasts: 'Podcasts',
  playlist: '播放列表',
};
const LIVE_GROUP = {
  is_live: '正在直播',
  is_upcoming: '即将开播',
  was_live: '往期回放',
  null: '其他',
};

const PAGE_SIZE = 80;

const state = {
  data: null,
  activeTab: 'all',
  search: '',
  searchScope: 'current',
  selected: new Set(),
  renderedCount: 0,
  queue: [],
  stats: {},
  settings: null,
  fetching: false,
};

const $ = (id) => document.getElementById(id);

/* ==================== 工具函数 ==================== */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function fmtBytes(n) {
  if (!n || n <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '';
  return fmtBytes(bps) + '/s';
}

function fmtEta(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '';
  const s = Math.round(sec);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`;
}

function fmtCount(n) {
  if (n == null) return '';
  if (n >= 1e8) return (n / 1e8).toFixed(1) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return String(n);
}

function toast(msg, kind = '', ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

/* ==================== 频道列表 ==================== */

function allItems() {
  return (state.data && state.data.items) || [];
}

function currentTabItems() {
  const items = allItems();
  if (state.activeTab === 'all') return items;
  return items.filter((it) => (it.sections || []).includes(state.activeTab));
}

function filteredItems() {
  const base = state.searchScope === 'all' ? allItems() : currentTabItems();
  const q = state.search.trim().toLowerCase();
  if (!q) return base;
  return base.filter((it) => String(it.title || '').toLowerCase().includes(q));
}

function tabsToShow() {
  const sections = (state.data && state.data.sections) || {};
  const list = [{ key: 'all', label: '全部', count: allItems().length, missing: false }];
  for (const key of SECTION_ORDER) {
    const arr = sections[key];
    if (!arr) continue;
    if (!arr.length && !(state.data.tabStatus && state.data.tabStatus[key] === 'missing')) continue;
    list.push({
      key,
      label: SECTION_LABEL[key] || key,
      count: arr.length,
      missing: state.data.tabStatus && state.data.tabStatus[key] === 'missing',
    });
  }
  return list;
}

function renderTabs() {
  const tabs = tabsToShow();
  $('tabs').innerHTML = tabs
    .map(
      (t) =>
        `<button class="tab ${t.key === state.activeTab ? 'active' : ''} ${t.missing && !t.count ? 'missing' : ''}" data-tab="${t.key}">${esc(
          t.label
        )}<span class="count">${t.count}</span></button>`
    )
    .join('');
}

function rendersWarnings() {
  const w = (state.data && state.data.warnings) || [];
  if (!w.length) {
    $('warnings').innerHTML = '';
    return;
  }
  $('warnings').innerHTML = w
    .map(
      (x) =>
        `<div class="warn-item ${x.level === 'error' ? 'error' : ''}">${
          x.level === 'error' ? '⚠ ' : 'ℹ '
        }${esc(x.tab ? SECTION_LABEL[x.tab] || x.tab : '')}：${esc(x.message)}</div>`
    )
    .join('');
}

function rowHtml(it) {
  const selected = state.selected.has(it.id);
  const badges = [];
  if (it.liveStatus === 'is_live') badges.push('<span class="badge live">直播中</span>');
  else if (it.liveStatus === 'is_upcoming') badges.push('<span class="badge upcoming">即将开播</span>');
  else if (it.liveStatus === 'was_live') badges.push('<span class="badge replay">回放</span>');
  if ((it.sections || []).includes('shorts')) badges.push('<span class="badge short">Shorts</span>');
  if ((it.sections || []).includes('podcasts')) badges.push('<span class="badge podcast">Podcast</span>');

  const meta = [];
  const dur = fmtDuration(it.duration);
  if (dur) meta.push(`<span>⏱ ${dur}</span>`);
  if (it.viewCount != null) meta.push(`<span>👁 ${fmtCount(it.viewCount)}</span>`);
  if (it.playlistTitle) meta.push(`<span>📚 ${esc(it.playlistTitle)}</span>`);
  const doneInQueue = state.queue.find((q) => q.key === it.id && (q.status === 'done' || q.status === 'skipped'));
  if (doneInQueue) meta.push('<span class="badge done">已下载</span>');

  return `<div class="row ${selected ? 'selected' : ''}" data-id="${esc(it.id)}">
    <input type="checkbox" ${selected ? 'checked' : ''} data-check="${esc(it.id)}" />
    <img class="row-thumb" loading="lazy" src="${esc(it.thumbnail || '')}" onerror="this.style.visibility='hidden'" />
    <div class="row-main">
      <div class="row-title">${esc(it.title)}${badges.length ? ' ' + badges.join(' ') : ''}</div>
      <div class="row-meta">${meta.join('')}</div>
    </div>
    <div class="row-actions">
      <button class="btn tiny" data-dl="${esc(it.id)}" title="只下载这一个">下载</button>
    </div>
  </div>`;
}

function renderList(reset) {
  const list = $('list');
  const items = filteredItems();
  if (reset) {
    state.renderedCount = 0;
    list.innerHTML = '';
  }
  const start = state.renderedCount;
  const end = Math.min(items.length, start + PAGE_SIZE);
  const slice = items.slice(start, end);

  let html = '';
  let lastGroup = null;
  const groupLive = state.activeTab === 'live';
  for (const it of slice) {
    if (groupLive) {
      const g = it.liveStatus || 'null';
      if (g !== lastGroup) {
        html += `<div class="group-head">${esc(LIVE_GROUP[g] || g)}</div>`;
        lastGroup = g;
      }
    }
    html += rowHtml(it);
  }
  list.insertAdjacentHTML('beforeend', html);
  state.renderedCount = end;

  $('listMore').classList.toggle('hidden', end >= items.length);
  $('loadMoreInfo').textContent = `已显示 ${end} / ${items.length}`;
  updateSelectionUI();
}

function updateSelectionUI() {
  const items = filteredItems();
  $('selCounter').textContent = `已选 ${state.selected.size} / ${items.length}`;
  const n = state.selected.size;
  $('actionSummary').textContent = n ? `已选择 ${n} 个视频` : '未选择任何视频';
  $('btnDownload').disabled = n === 0;
  document.querySelectorAll('#list .row').forEach((row) => {
    const id = row.getAttribute('data-id');
    const on = state.selected.has(id);
    row.classList.toggle('selected', on);
    const cb = row.querySelector('input[type=checkbox]');
    if (cb) cb.checked = on;
  });
}

function itemById(id) {
  return allItems().find((it) => it.id === id) || null;
}

function toggleSelect(id, force) {
  const on = force != null ? force : !state.selected.has(id);
  if (on) state.selected.add(id);
  else state.selected.delete(id);
  updateSelectionUI();
}

function clearChannelView() {
  state.data = null;
  state.selected.clear();
  state.renderedCount = 0;
  $('channelView').classList.add('hidden');
  $('emptyState').classList.remove('hidden');
  $('list').innerHTML = '';
}

function renderChannel(data) {
  state.data = data;
  state.activeTab = 'all';
  state.selected.clear();
  state.renderedCount = 0;

  $('emptyState').classList.add('hidden');
  $('channelView').classList.remove('hidden');

  const ch = data.channel || {};
  $('chTitle').textContent = ch.title || '未知频道';
  const av = $('chAvatar');
  if (ch.avatar) {
    av.src = ch.avatar;
    av.style.visibility = 'visible';
  } else {
    av.removeAttribute('src');
    av.style.visibility = 'hidden';
  }

  $('chFollowers').textContent = ch.followerCount != null ? `订阅 ${fmtCount(ch.followerCount)}` : '';
  const counts = Object.entries(data.sections || {})
    .filter(([, v]) => v && v.length)
    .map(([k, v]) => `${SECTION_LABEL[k] || k} ${v.length}`)
    .join(' · ');
  $('chTotal').textContent = `共 ${allItems().length} 个内容${counts ? '（' + counts + '）' : ''}`;

  renderTabs();
  rendersWarnings();
  renderList(true);
}

/* ==================== 下载队列 UI ==================== */

const queueNodes = new Map();

function renderQueue() {
  const list = $('queueList');
  $('queueEmpty').classList.toggle('hidden', state.queue.length > 0);
  const seen = new Set();

  for (const q of state.queue) {
    seen.add(q.key);
    let el = queueNodes.get(q.key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'q-item';
      el.setAttribute('data-key', q.key);
      el.innerHTML = `<div class="q-top">
          <img class="q-thumb" loading="lazy" onerror="this.style.visibility='hidden'" />
          <div class="q-title"></div>
          <div class="q-actions"></div>
        </div>
        <div class="q-bar"><i></i></div>
        <div class="q-bottom"><span class="q-stage"></span><span class="q-nums"></span></div>
        <div class="q-error hidden"></div>`;
      list.appendChild(el);
      queueNodes.set(q.key, el);
    }
    el.className = 'q-item ' + q.status;
    const img = el.querySelector('.q-thumb');
    if (img.getAttribute('src') !== (q.thumbnail || '')) img.setAttribute('src', q.thumbnail || '');
    el.querySelector('.q-title').textContent = q.title;

    el.querySelector('.q-bar > i').style.width = `${Math.round((q.progress || 0) * 100)}%`;

    const stage = el.querySelector('.q-stage');
    let stageText = q.stage || '';
    if (q.status === 'downloading') {
      const parts = [`${Math.round((q.progress || 0) * 100)}%`];
      if (q.downloadedBytes) parts.push(fmtBytes(q.downloadedBytes) + (q.totalBytes ? ' / ' + fmtBytes(q.totalBytes) : ''));
      stageText = `${q.stage} ${parts.join(' · ')}`;
    }
    if (q.extractingAudio) stageText = '⏳ ' + stageText;
    if (q.fetchingSubs) stageText = '⏳ ' + stageText;
    if (q.studying) stageText = `⏳ ${q.studyStage || '生成学习文档'}…`;
    stage.textContent = stageText;
    stage.title = stageText;

    const nums = [];
    if (q.status === 'downloading') {
      if (q.speed) nums.push(fmtSpeed(q.speed));
      const eta = fmtEta(q.eta);
      if (eta) nums.push('剩余 ' + eta);
    }
    el.querySelector('.q-nums').textContent = nums.join(' · ');

    const errEl = el.querySelector('.q-error');
    if (q.error) {
      errEl.classList.remove('hidden');
      errEl.classList.remove('warn');
      errEl.textContent = q.error;
    } else if (q.audioError) {
      errEl.classList.remove('hidden');
      errEl.classList.add('warn');
      errEl.textContent = '音频导出失败：' + q.audioError;
    } else if (q.subError) {
      errEl.classList.remove('hidden');
      errEl.classList.add('warn');
      errEl.textContent = '字幕获取失败（视频不受影响）：' + q.subError;
    } else if (q.studyError) {
      errEl.classList.remove('hidden');
      errEl.classList.add('warn');
      errEl.textContent = '学习文档：' + q.studyError;
    } else {
      errEl.classList.add('hidden');
    }

    // 操作按钮
    const acts = el.querySelector('.q-actions');
    const buttons = [];
    if (q.status === 'downloading') buttons.push(['pause', '暂停', '暂停（支持断点续传）']);
    if (q.status === 'queued') buttons.push(['pause', '暂停', '']);
    if (q.status === 'paused' || q.status === 'canceled') buttons.push(['resume', '继续', '从断点继续下载']);
    if (q.status === 'error') buttons.push(['retry', '重试', '']);
    if (q.status === 'done' || q.status === 'skipped') buttons.push(['open', '打开', '打开所在文件夹']);
    if (q.audioPath) buttons.push(['openAudio', '音频', '定位导出的音频文件']);
    if (q.subCount > 0) buttons.push(['openSubs', `字幕${q.subCount}`, `定位字幕文件（共 ${q.subCount} 个）`]);
    if (q.biSrtPath) buttons.push(['openBiSrt', '双语', '定位中英双语字幕']);
    if (q.studyDocPath) {
      buttons.push(['openDoc', '文档', '打开学习文档']);
      buttons.push(['redoDoc', '重做', '重新生成（走翻译缓存；如需重新翻译请按住 Ctrl 点击）']);
    } else if (q.subCount > 0) {
      buttons.push(['redoDoc', '生成文档', '调用大模型生成中英对照学习文档']);
    }
    buttons.push(['remove', '✕', '从队列移除']);
    const sig = buttons.map((b) => b[0] + b[1]).join(',');
    if (acts.getAttribute('data-sig') !== sig) {
      acts.setAttribute('data-sig', sig);
      acts.innerHTML = buttons
        .map(([a, label, title]) => `<button class="btn tiny" data-act="${a}" title="${esc(title)}">${label}</button>`)
        .join('');
    }
    el.setAttribute('data-path', q.filePath || '');
    el.setAttribute('data-audio', q.audioPath || '');
    el.setAttribute('data-subs', (q.subPaths && q.subPaths[0]) || '');
    el.setAttribute('data-doc', q.studyDocPath || '');
    el.setAttribute('data-bisrt', q.biSrtPath || '');
    el.setAttribute('data-key', q.key);
  }

  for (const [key, el] of Array.from(queueNodes.entries())) {
    if (!seen.has(key)) {
      el.remove();
      queueNodes.delete(key);
    }
  }

  const s = state.stats || {};
  $('queueStats').innerHTML = [
    `进行中 <b>${s.downloading || 0}</b>`,
    `等待 <b>${s.queued || 0}</b>`,
    `暂停 <b>${s.paused || 0}</b>`,
    `完成 <b>${(s.done || 0) + (s.skipped || 0)}</b>`,
    `失败 <b>${s.error || 0}</b>`,
    `并发 <b>${s.concurrency || 2}</b>`,
    s.studyCostTotal > 0 ? `文档花费 <b>￥${s.studyCostTotal.toFixed(2)}</b>` : '',
  ]
    .filter(Boolean)
    .join('&nbsp;&nbsp;');
  $('queueBadge').textContent = (s.downloading || 0) + (s.queued || 0);
}

/* ==================== 识别 ==================== */

async function doFetch(force) {
  const input = $('urlInput').value.trim();
  if (!input) {
    toast('请先粘贴博主主页链接', 'warn');
    return;
  }
  if (state.fetching) return;
  state.fetching = true;
  setFetchingUI(true);

  const res = await api.channel.enumerate(input, !!force);
  state.fetching = false;
  setFetchingUI(false);

  if (!res.ok) {
    if (res.canceled) toast('已取消识别', 'warn');
    else toast('识别失败：' + res.error, 'err', 9000);
    return;
  }

  const data = res.data;
  renderChannel(data);
  if (res.cached) {
    $('chCacheInfo').textContent = `（缓存 ${Math.round((res.cacheAgeSec || 0) / 60)} 分钟前）`;
  } else {
    $('chCacheInfo').textContent = '';
  }
  $('btnRefresh').classList.remove('hidden');

  const total = allItems().length;
  if (!total) {
    toast('没有识别到任何内容，可能该频道为空或链接有误', 'warn', 7000);
  } else {
    toast(`识别完成，共 ${total} 个内容`, 'ok');
  }
  const errs = (data.warnings || []).filter((w) => w.level === 'error');
  if (errs.length) toast(`有 ${errs.length} 个分类抓取失败，详情见列表上方提示`, 'warn', 7000);
}

function setFetchingUI(on) {
  $('btnFetch').disabled = on;
  $('btnFetch').innerHTML = on ? '<span class="spinner"></span> 识别中' : '识别';
  $('btnCancelFetch').classList.toggle('hidden', !on);
  if (!on) $('fetchStatus').classList.add('hidden');
}

function onProgress(p) {
  const el = $('fetchStatus');
  el.classList.remove('hidden');
  if (p.phase === 'tab') {
    el.innerHTML = `<span class="spinner"></span> 正在抓取 ${esc(SECTION_LABEL[p.tab] || p.tab)} 标签页（${p.index + 1}/${p.total}）…`;
  } else if (p.phase === 'podcast-playlist') {
    el.innerHTML = `<span class="spinner"></span> 正在展开播客播放列表「${esc(p.label || '')}」（${(p.index || 0) + 1}/${
      p.total || '?'
    }）…`;
  } else if (p.phase === 'probe') {
    el.innerHTML = `<span class="spinner"></span> ${esc(p.label || '读取中…')}`;
  } else if (p.phase === 'cache') {
    el.innerHTML = `⚡ ${esc(p.label || '')}`;
  }
}

/* ==================== 设置 ==================== */

/** 「仅音频」时「同时下载音频」没有意义，置灰 */
function syncAlsoAudioEnabled() {
  const onlyAudio = $('audioOnly').checked;
  const el = $('alsoAudio');
  el.disabled = onlyAudio;
  el.closest('label').style.opacity = onlyAudio ? '0.4' : '1';
}

async function loadSettingsToForm() {
  const s = await api.settings.get();
  state.settings = s;
  $('setOutputDir').value = s.outputDir || '';
  $('setConcurrency').value = s.concurrency || 2;
  $('setAutoRetry').value = s.autoRetry == null ? 3 : s.autoRetry;
  $('setFilename').value = s.filenameTemplate || '';
  $('setRateLimit').value = s.rateLimit || '';
  $('setProxy').value = s.proxy || '';
  $('setCookieFile').value = s.cookieFile || '';
  $('setSkipDownloaded').checked = s.skipDownloaded !== false;
  $('setEmbedMeta').checked = s.embedMetadata !== false;
  $('setEmbedThumb').checked = s.embedThumbnail !== false;
  $('setLiveFromStart').checked = !!s.liveFromStart;
  $('setVideoCodec').value = s.videoCodec === 'compat' ? 'compat' : 'quality';
  $('setAudioFormat').value = s.audioFormat === 'm4a' ? 'm4a' : 'mp3';
  $('setAlsoAudio').checked = s.alsoAudio !== false;
  $('setWriteSubs').checked = s.writeSubs !== false;
  $('setWriteAutoSubs').checked = s.writeAutoSubs !== false;
  $('setEmbedSubs').checked = !!s.embedSubs;
  $('setSubLangs').value = s.subLangs || 'en';
  $('setSubFormat').value = ['vtt', 'ass'].includes(s.subFormat) ? s.subFormat : 'srt';

  // 学习文档
  $('setStudyDoc').checked = s.studyDoc !== false;
  $('setStudyPureEn').checked = s.studyIncludePureEnglish !== false;
  $('setStudyVocab').checked = s.studyIncludeVocab !== false;
  $('setStudyTimecode').checked = s.studyTimecode !== false;
  $('setStudyBiSrt').checked = s.studyBilingualSrt !== false;
  $('setStudyBase').value = s.studyBaseURL || '';
  $('setStudyModel').value = s.studyModel || '';
  $('setStudyConcurrency').value = s.studyConcurrency || 3;
  $('setStudyMaxSeg').value = s.studyMaxSegCues || 45;
  $('setStudyPriceIn').value = s.studyPriceIn != null ? s.studyPriceIn : 2;
  $('setStudyPriceOut').value = s.studyPriceOut != null ? s.studyPriceOut : 8;
  $('setStudyMinDur').value = s.studyMinDurationSec || 0;
  $('setStudyMaxVideo').value = s.studyMaxCostPerVideo || 0;
  $('setStudyMaxBatch').value = s.studyMaxCostPerBatch || 0;
  $('setStudyKey').value = '';
  const keyEl = $('setStudyKey');
  if (s.studyApiKeySet) {
    keyEl.placeholder = `${s.studyApiKeyMask || '****'}（已保存，留空不修改）`;
    $('llmStatus').textContent = s.studyKeyEncrypted ? '已配置（已加密存储）' : '已配置（明文存储）';
  } else {
    keyEl.placeholder = '在此粘贴 API Key';
    $('llmStatus').textContent = '未配置';
  }

  // 主界面同步
  $('outputDir').value = s.outputDir || '';
  $('qualitySelect').value = s.quality || 'best';
  $('audioOnly').checked = !!s.audioOnly;
  $('alsoAudio').checked = s.alsoAudio !== false;
  $('writeSubs').checked = s.writeSubs !== false;
  $('studyDoc').checked = s.studyDoc !== false;
  syncAlsoAudioEnabled();
}

async function refreshKernelInfo() {
  const info = await api.bin.check();
  $('kernelInfo').textContent = [
    `yt-dlp : ${info.ytdlp.ok ? info.ytdlp.version : '不可用'}  ${info.ytdlp.ok ? '' : '[' + info.ytdlp.error + ']'}`,
    `         ${info.ytdlp.path || '(缺失)'}`,
    `ffmpeg : ${info.ffmpeg.ok ? '可用' : '不可用'}  ${info.ffmpeg.ok ? '' : '[' + info.ffmpeg.error + ']'}`,
    `         ${info.ffmpeg.path || '(缺失)'}`,
    `数据目录: ${info.userData}`,
  ].join('\n');

  const st = $('binStatus');
  if (info.ytdlp.ok && info.ffmpeg.ok) {
    st.className = 'bin-status ok';
    st.textContent = `内核就绪 · yt-dlp ${info.ytdlp.version}`;
  } else {
    st.className = 'bin-status bad';
    st.textContent = '内核异常，点击设置查看';
  }
  return info;
}

/* ==================== 事件绑定 ==================== */

function bind() {
  $('btnFetch').addEventListener('click', () => doFetch(false));
  $('btnRefresh').addEventListener('click', () => doFetch(true));
  $('btnCancelFetch').addEventListener('click', () => api.channel.cancel());
  $('urlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doFetch(false);
  });

  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    state.activeTab = btn.getAttribute('data-tab');
    renderTabs();
    renderList(true);
  });

  $('list').addEventListener('click', (e) => {
    const dl = e.target.closest('[data-dl]');
    if (dl) {
      const id = dl.getAttribute('data-dl');
      const it = itemById(id);
      if (it) enqueue([it]);
      return;
    }
    if (e.target.matches('input[type=checkbox]')) {
      toggleSelect(e.target.getAttribute('data-check'), e.target.checked);
      return;
    }
    const row = e.target.closest('.row');
    if (row) toggleSelect(row.getAttribute('data-id'));
  });

  $('list').addEventListener('scroll', () => {
    const el = $('list');
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 320) {
      if (state.renderedCount < filteredItems().length) renderList(false);
    }
  });

  $('btnLoadMore').addEventListener('click', () => renderList(false));

  $('searchInput').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderList(true);
  });
  $('searchScope').addEventListener('change', (e) => {
    state.searchScope = e.target.value;
    renderList(true);
  });

  const visible = () => filteredItems();
  $('btnSelectAll').addEventListener('click', () => {
    visible().forEach((it) => state.selected.add(it.id));
    updateSelectionUI();
  });
  $('btnSelectNone').addEventListener('click', () => {
    state.selected.clear();
    updateSelectionUI();
  });
  $('btnSelectInvert').addEventListener('click', () => {
    visible().forEach((it) => {
      if (state.selected.has(it.id)) state.selected.delete(it.id);
      else state.selected.add(it.id);
    });
    updateSelectionUI();
  });
  $('btnSelectUnselected').addEventListener('click', () => {
    const done = new Set(
      state.queue.filter((q) => q.status === 'done' || q.status === 'skipped').map((q) => q.key)
    );
    state.selected.clear();
    visible().forEach((it) => {
      if (!done.has(it.id)) state.selected.add(it.id);
    });
    updateSelectionUI();
  });
  // 与「仅选未下载」的区别：不清空已有选择，而是在其基础上追加未下载的
  $('btnSelectAddUnselected').addEventListener('click', () => {
    const done = new Set(
      state.queue.filter((q) => q.status === 'done' || q.status === 'skipped').map((q) => q.key)
    );
    let added = 0;
    visible().forEach((it) => {
      if (!done.has(it.id) && !state.selected.has(it.id)) {
        state.selected.add(it.id);
        added++;
      }
    });
    updateSelectionUI();
    toast(added ? `已追加 ${added} 个未下载的视频` : '没有新的未下载视频可追加', added ? 'ok' : 'warn');
  });

  $('btnDownload').addEventListener('click', () => {
    const items = Array.from(state.selected)
      .map((id) => itemById(id))
      .filter(Boolean);
    if (items.length) enqueue(items);
  });

  $('qualitySelect').addEventListener('change', (e) => api.settings.set({ quality: e.target.value }));
  $('audioOnly').addEventListener('change', (e) => {
    syncAlsoAudioEnabled();
    api.settings.set({ audioOnly: e.target.checked });
  });
  $('alsoAudio').addEventListener('change', (e) => api.settings.set({ alsoAudio: e.target.checked }));
  $('writeSubs').addEventListener('change', (e) => api.settings.set({ writeSubs: e.target.checked }));
  $('studyDoc').addEventListener('change', (e) => api.settings.set({ studyDoc: e.target.checked }));

  // 学习文档：测试连接 / 清除 Key
  $('btnTestLLM').addEventListener('click', async () => {
    const st = $('llmStatus');
    st.textContent = '测试中…';
    st.style.color = 'var(--info)';
    const override = {
      studyBaseURL: $('setStudyBase').value.trim(),
      studyModel: $('setStudyModel').value.trim(),
    };
    const typed = $('setStudyKey').value.trim();
    if (typed) override.studyApiKey = typed;
    const r = await api.study.testConnection(override);
    if (r.ok) {
      st.textContent = `连接成功（${r.ms}ms）回复「${r.reply}」`;
      st.style.color = 'var(--ok)';
    } else {
      st.textContent = `失败：${r.error}`;
      st.style.color = 'var(--err)';
    }
  });

  $('btnClearKey').addEventListener('click', async () => {
    await api.settings.set({ studyApiKeyClear: true });
    $('setStudyKey').value = '';
    await loadSettingsToForm();
    toast('已清除 API Key', 'ok');
  });
  $('btnPickDir').addEventListener('click', async () => {
    const p = await api.dialog.pickFolder($('outputDir').value);
    if (p) {
      $('outputDir').value = p;
      $('setOutputDir').value = p;
      await api.settings.set({ outputDir: p });
    }
  });

  // 队列操作
  $('queueList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const el = e.target.closest('.q-item');
    const key = el.getAttribute('data-key');
    const act = btn.getAttribute('data-act');
    if (act === 'open') {
      const p = el.getAttribute('data-path');
      if (p) api.shell.openPath(p);
      else toast('该任务还没有文件路径', 'warn');
      return;
    }
    if (act === 'openAudio') {
      const p = el.getAttribute('data-audio');
      if (p) api.shell.showItem(p);
      else toast('该任务还没有音频文件', 'warn');
      return;
    }
    if (act === 'openSubs') {
      const p = el.getAttribute('data-subs');
      if (p) api.shell.showItem(p);
      else toast('没有找到字幕文件', 'warn');
      return;
    }
    if (act === 'openBiSrt') {
      const p = el.getAttribute('data-bisrt');
      if (p) api.shell.showItem(p);
      else toast('还没有生成双语字幕', 'warn');
      return;
    }
    if (act === 'openDoc') {
      const p = el.getAttribute('data-doc');
      if (p) api.shell.openPath(p);
      else toast('还没有生成学习文档', 'warn');
      return;
    }
    if (act === 'redoDoc') {
      const key = el.getAttribute('data-key');
      const force = !!e.ctrlKey;
      toast(force ? '正在重新翻译并生成（会调用大模型）…' : '正在生成学习文档…', 'ok', 2500);
      const r = await api.study.generate(key, force);
      if (r.ok) toast(r.fromCache ? '已用翻译缓存重新排版完成' : '学习文档生成完成', 'ok', 6000);
      else toast('生成失败：' + r.error, 'err', 9000);
      return;
    }
    await api.queue.action(key, act);
  });

  $('btnPauseAll').addEventListener('click', () => api.queue.pauseAll());
  $('btnResumeAll').addEventListener('click', () => api.queue.resumeAll());
  $('btnClearDone').addEventListener('click', async () => {
    await api.queue.clear('done');
    toast('已清除已完成任务', 'ok');
  });
  $('btnQueueJump').addEventListener('click', () => {
    $('queuePane').scrollIntoView({ behavior: 'smooth' });
  });

  // 设置弹窗
  $('btnSettings').addEventListener('click', async () => {
    $('settingsModal').classList.remove('hidden');
    await loadSettingsToForm();
    refreshKernelInfo();
  });
  $('btnCloseSettings').addEventListener('click', () => $('settingsModal').classList.add('hidden'));
  $('settingsModal').addEventListener('click', (e) => {
    if (e.target === $('settingsModal')) $('settingsModal').classList.add('hidden');
  });
  $('btnSetPickDir').addEventListener('click', async () => {
    const p = await api.dialog.pickFolder($('setOutputDir').value);
    if (p) $('setOutputDir').value = p;
  });
  $('btnPickCookie').addEventListener('click', async () => {
    const p = await api.dialog.pickFile();
    if (p) $('setCookieFile').value = p;
  });
  $('btnClearCookie').addEventListener('click', () => ($('setCookieFile').value = ''));

  $('btnSaveSettings').addEventListener('click', async () => {
    const patch = {
      outputDir: $('setOutputDir').value.trim(),
      concurrency: Number($('setConcurrency').value) || 2,
      autoRetry: Number($('setAutoRetry').value) || 0,
      filenameTemplate: $('setFilename').value.trim() || '%(title)s [%(id)s].%(ext)s',
      rateLimit: $('setRateLimit').value.trim(),
      proxy: $('setProxy').value.trim(),
      cookieFile: $('setCookieFile').value.trim(),
      skipDownloaded: $('setSkipDownloaded').checked,
      embedMetadata: $('setEmbedMeta').checked,
      embedThumbnail: $('setEmbedThumb').checked,
      liveFromStart: $('setLiveFromStart').checked,
      videoCodec: $('setVideoCodec').value,
      audioFormat: $('setAudioFormat').value,
      alsoAudio: $('setAlsoAudio').checked,
      writeSubs: $('setWriteSubs').checked,
      writeAutoSubs: $('setWriteAutoSubs').checked,
      embedSubs: $('setEmbedSubs').checked,
      subLangs: $('setSubLangs').value.trim() || 'en',
      subFormat: $('setSubFormat').value,
      studyDoc: $('setStudyDoc').checked,
      studyIncludePureEnglish: $('setStudyPureEn').checked,
      studyIncludeVocab: $('setStudyVocab').checked,
      studyTimecode: $('setStudyTimecode').checked,
      studyBilingualSrt: $('setStudyBiSrt').checked,
      studyBaseURL: $('setStudyBase').value.trim(),
      studyModel: $('setStudyModel').value.trim(),
      studyConcurrency: Number($('setStudyConcurrency').value) || 3,
      studyMaxSegCues: Number($('setStudyMaxSeg').value) || 45,
      studyPriceIn: Number($('setStudyPriceIn').value) || 0,
      studyPriceOut: Number($('setStudyPriceOut').value) || 0,
      studyMinDurationSec: Number($('setStudyMinDur').value) || 0,
      studyMaxCostPerVideo: Number($('setStudyMaxVideo').value) || 0,
      studyMaxCostPerBatch: Number($('setStudyMaxBatch').value) || 0,
    };
    // 只有用户真的输入了新 Key 才提交（留空表示保持原值）
    const keyInput = $('setStudyKey').value.trim();
    if (keyInput) patch.studyApiKey = keyInput;
    await api.settings.set(patch);
    await loadSettingsToForm();
    toast('设置已保存', 'ok');
    $('settingsModal').classList.add('hidden');
  });

  $('btnUpdateKernel').addEventListener('click', async () => {
    $('updateLog').classList.remove('hidden');
    $('updateLog').textContent = '开始更新…';
    $('btnUpdateKernel').disabled = true;
    const r = await api.bin.update();
    $('btnUpdateKernel').disabled = false;
    if (r.ok) {
      toast('yt-dlp 内核已更新到 ' + r.version, 'ok');
      refreshKernelInfo();
    } else {
      toast('更新失败：' + r.error, 'err', 9000);
    }
  });
  $('btnResetKernel').addEventListener('click', async () => {
    await api.bin.resetOverride();
    await refreshKernelInfo();
    toast('已恢复使用内置 yt-dlp', 'ok');
  });
  $('btnOpenData').addEventListener('click', async () => {
    const info = await api.bin.check();
    api.shell.openPath(info.userData);
  });

  api.bin.onUpdateLog((line) => {
    const el = $('updateLog');
    el.classList.remove('hidden');
    el.textContent += '\n' + line;
    el.scrollTop = el.scrollHeight;
  });

  api.channel.onProgress(onProgress);

  api.queue.onChanged((payload) => {
    state.queue = payload.items || [];
    state.stats = payload.stats || {};
    renderQueue();
  });
}

async function enqueue(items) {
  const res = await api.queue.add(items, {
    quality: $('qualitySelect').value,
    audioOnly: $('audioOnly').checked,
    alsoAudio: $('alsoAudio').checked,
    writeSubs: $('writeSubs').checked,
    studyDoc: $('studyDoc').checked,
    outputDir: $('outputDir').value.trim() || undefined,
  });
  const extras = [];
  if (!$('audioOnly').checked && $('alsoAudio').checked) extras.push('音频');
  if ($('writeSubs').checked) extras.push('字幕');
  if ($('studyDoc').checked && $('writeSubs').checked) extras.push('学习文档');
  let msg = `已加入队列 ${res.added} 个`;
  if (res.skipped) msg += `，跳过已在队列中的 ${res.skipped} 个`;
  if (extras.length) msg += `（将同时下载${extras.join(' + ')}）`;
  toast(msg, 'ok');
  $('queuePane').scrollIntoView({ behavior: 'smooth' });
}

/* ==================== 启动 ==================== */

(async function init() {
  bind();
  clearChannelView();
  await loadSettingsToForm();
  await refreshKernelInfo();
  const q = await api.queue.list();
  state.queue = q.items || [];
  state.stats = q.stats || {};
  renderQueue();

  const info = await api.info();
  if (!info.isPackaged) {
    console.log('dev mode', info);
  }
})();
})();
