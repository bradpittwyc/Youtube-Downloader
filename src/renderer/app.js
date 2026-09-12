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

const SECTION_ORDER = ['single', 'videos', 'shorts', 'live', 'podcasts', 'playlists', 'playlist'];
const SECTION_LABEL = {
  single: '单个视频',
  videos: 'Videos',
  shorts: 'Shorts',
  live: 'Live 直播',
  podcasts: 'Podcasts',
  playlists: '播放列表',
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
  /** 只显示还没下载过的视频（显示过滤器，只影响列表可见性，不影响勾选） */
  showOnlyUndownloaded: false,
  /** 播放列表按需展开：plId → 该列表的视频数组 */
  playlistVideos: {},
  /** 正在读取中的播放列表 id */
  playlistLoading: new Set(),
  /** 磁盘上的已下载索引：视频ID → 本地记录（按 ID 识别本地文件，不依赖队列历史） */
  downloadedIndex: new Map(),
  selected: new Set(),
  renderedCount: 0,
  queue: [],
  stats: {},
  settings: null,
  fetching: false,
};

/**
 * 已下载完成的视频 id 集合。三个来源合并，宁多勿漏：
 *   1. 队列里 done / skipped 且文件还在
 *   2. 磁盘上的「边车索引」—— 按视频 ID 扫描下载目录得到，
 *      队列被清空 / 换机器 / 重装之后依然能识别出本地已有的作品
 * 必须确认文件还在磁盘上：用户可能把文件删了，这时不能只说"已下载"，
 * 否则重新下载会被永久跳过（实测踩过）。
 *
 * 结果做了缓存：列表每渲染一行都要问一次，上千行时重建 Set 会明显变慢。
 */
let _doneCache = null;
function doneKeys() {
  if (_doneCache) return _doneCache;
  const set = new Set(
    state.queue
      .filter((q) => (q.status === 'done' || q.status === 'skipped') && q.fileExists !== false)
      .map((q) => q.key)
  );
  for (const id of state.downloadedIndex.keys()) set.add(id);
  _doneCache = set;
  return set;
}
/** 队列或索引变化后必须调用，否则列表上的「已下载」标记会是旧的 */
function invalidateDoneCache() {
  _doneCache = null;
}

/** 拉取磁盘上的已完成索引（按视频 ID） */
async function loadDownloadsIndex(fresh) {
  try {
    const r = await api.downloads.index({ fresh: !!fresh });
    const map = new Map();
    for (const it of (r && r.list) || []) map.set(it.id, it);
    state.downloadedIndex = map;
    invalidateDoneCache();
    console.log(`已下载索引：磁盘上识别到 ${map.size} 个作品`);
    return map;
  } catch (err) {
    console.error('loadDownloadsIndex failed:', err && err.message);
    return state.downloadedIndex;
  }
}

/** 「已下载集合」的签名，用来判断是否需要因为下载完成而刷新列表 */
let doneSig = '';
/** 已完成任务数，用来判断博主下载数是否变化 */
let lastDoneCount = -1;

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
  let out = base;
  if (q) out = out.filter((it) => String(it.title || '').toLowerCase().includes(q));
  if (state.showOnlyUndownloaded) {
    const done = doneKeys();
    out = out.filter((it) => !done.has(it.id));
  }
  return out;
}

/** 播放列表标签页里已展开的全部视频 */
function expandedPlaylistItems() {
  const out = [];
  for (const vids of Object.values(state.playlistVideos)) out.push(...vids);
  return out;
}

/** 当前列表里可见的条目（播放列表标签页走单独一套） */
function currentVisibleItems() {
  return state.activeTab === 'playlists' ? expandedPlaylistItems() : filteredItems();
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

function rowHtml(it, nested) {
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
  // 「已下载」标记以 doneKeys() 为准（队列 + 磁盘边车索引），不再只看队列状态
  if (doneKeys().has(it.id)) meta.push('<span class="badge done">已下载</span>');

  return `<div class="row ${selected ? 'selected' : ''} ${nested ? 'nested' : ''}" data-id="${esc(it.id)}">
    <input type="checkbox" ${selected ? 'checked' : ''} data-check="${esc(it.id)}" />
    <img class="row-thumb" loading="lazy" src="${esc(it.thumbnail || '')}" data-preview="${esc(
      it.id
    )}" title="点击查看详情" />
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
  // 播放列表标签页走单独一套渲染：先列播放列表，点开某个才显示它的视频
  if (state.activeTab === 'playlists') return renderPlaylistsList(reset);

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

  // 过滤器把内容全隐藏时给个明确提示，避免用户以为列表坏了
  if (reset && items.length === 0) {
    const total = (state.searchScope === 'all' ? allItems() : currentTabItems()).length;
    if (state.showOnlyUndownloaded && total > 0) {
      list.innerHTML = `<div class="group-head">当前分类下的 ${total} 个视频都已下载完成，没有未下载的了</div>`;
      state.renderedCount = 0;
    }
  }

  $('listMore').classList.toggle('hidden', end >= items.length);
  $('loadMoreInfo').textContent = `已显示 ${end} / ${items.length}`;
  updateSelectionUI();
}

/**
 * 播放列表标签页的渲染。
 * 像 YouTube 原页面一样先把播放列表列出来（缩略图 + 标题），
 * **点了某个播放列表才去抓它的视频**——不预展开，识别才快。
 */
function renderPlaylistsList(reset) {
  const list = $('list');
  if (reset) {
    state.renderedCount = 0;
    list.innerHTML = '';
  }
  const pls = (state.data && state.data.playlists) || [];
  if (!pls.length) {
    list.innerHTML = '<div class="group-head">该频道没有播放列表</div>';
    $('listMore').classList.add('hidden');
    return;
  }

  let html = '';
  for (const pl of pls) {
    const loading = state.playlistLoading.has(pl.id);
    const vids = state.playlistVideos[pl.id];
    const open = !!vids;
    const selCount = open ? vids.filter((v) => state.selected.has(v.id)).length : 0;
    const allSel = open && vids.length > 0 && selCount === vids.length;
    const meta = loading
      ? '<span class="spinner"></span> 正在读取…'
      : open
      ? `${vids.length} 个视频${selCount ? ` · 已选 ${selCount}` : ''}`
      : '点击展开查看视频';
    html += `<div class="pl-row ${open ? 'open' : ''}" data-pl-row="${esc(pl.id)}">
      <input type="checkbox" data-pl-check="${esc(pl.id)}" ${allSel ? 'checked' : ''} title="勾选 = 把这个播放列表全部加入选择" />
      <img class="pl-thumb" loading="lazy" src="${esc(pl.thumbnail || '')}" />
      <div class="pl-main">
        <div class="pl-title">${esc(pl.title)}</div>
        <div class="pl-meta">${meta}</div>
      </div>
      <div class="pl-actions">
        <button class="btn tiny" data-pl-toggle="${esc(pl.id)}">${loading ? '读取中…' : open ? '收起' : '展开'}</button>
      </div>
    </div>`;
    if (open) html += vids.map((v) => rowHtml(v, true)).join('');
  }
  list.innerHTML = html;
  $('listMore').classList.add('hidden');
  updateSelectionUI();
}

/** 展开 / 收起某个播放列表 */
async function togglePlaylist(id) {
  const pl = ((state.data && state.data.playlists) || []).find((p) => p.id === id);
  if (!pl) return;
  if (state.playlistVideos[id]) {
    delete state.playlistVideos[id];
    renderList(true);
    return;
  }
  await expandPlaylist(pl);
}

/** 真正去抓某个播放列表的视频；已抓过则直接复用 */
async function expandPlaylist(pl) {
  if (state.playlistVideos[pl.id]) return state.playlistVideos[pl.id];
  if (state.playlistLoading.has(pl.id)) return null;
  state.playlistLoading.add(pl.id);
  renderList(true);

  const res = await api.channel.playlistItems({ url: pl.url, title: pl.title });
  state.playlistLoading.delete(pl.id);

  if (!res.ok) {
    toast(`展开「${pl.title}」失败：${res.error}`, 'err', 9000);
    renderList(true);
    return null;
  }

  // 合并进总列表：已在总列表里的复用【同一个对象】，
  // 这样同一视频在播放列表里和在 Videos 里的勾选状态永远一致。
  const byId = new Map(state.data.items.map((i) => [i.id, i]));
  const merged = res.items.map((it) => {
    const exist = byId.get(it.id);
    if (exist) {
      if (!exist.playlistTitle && it.playlistTitle) exist.playlistTitle = it.playlistTitle;
      return exist;
    }
    byId.set(it.id, it);
    state.data.items.push(it);
    return it;
  });
  state.playlistVideos[pl.id] = merged;
  renderList(true);
  return merged;
}

/** 勾选整个播放列表 = 展开并全选 */
async function onPlaylistCheck(id, checked) {
  const pl = ((state.data && state.data.playlists) || []).find((p) => p.id === id);
  if (!pl) return;
  const vids = state.playlistVideos[id] || (await expandPlaylist(pl));
  if (!vids) return;
  if (checked) vids.forEach((v) => state.selected.add(v.id));
  else vids.forEach((v) => state.selected.delete(v.id));
  renderList(true);
  updateSelectionUI();
  toast(checked ? `已把「${pl.title}」的 ${vids.length} 个视频加入选择` : `已取消「${pl.title}」的选择`, 'ok', 3000);
}

function updateSelectionUI() {
  const items = currentVisibleItems();
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
  state.playlistVideos = {};
  state.playlistLoading.clear();
  $('channelView').classList.add('hidden');
  $('emptyState').classList.remove('hidden');
  $('list').innerHTML = '';
  $('btnRefresh').classList.add('hidden');
  $('chCacheInfo').textContent = '';
  loadLibrary();
}

/* ==================== 本次已抓取（会话缓存，用于快速切换） ==================== */

/* ==================== 主页书签库 ==================== */

/**
 * 主页下半部分的数据：分类清单 + 频道库。
 * 频道库 = 持久化的「下过的博主」 ∪ 本次运行抓取过的，按 URL 去重。
 * 分类是识别频道时按视频标题算出来的（见 src/main/categories.js）。
 */
const bmLib = { cats: [], channels: [], active: 'all' };

async function loadLibrary() {
  try {
    const [catRes, topRes, sesRes] = await Promise.all([
      api.channels.categories(),
      api.channels.top(300),
      api.channel.sessionList(),
    ]);
    bmLib.cats = (catRes && catRes.list) || [];

    const byUrl = new Map();
    for (const c of (topRes && topRes.list) || []) {
      const key = String(c.url || '').toLowerCase();
      if (!key) continue;
      byUrl.set(key, {
        url: c.url,
        title: c.title || c.url,
        avatar: c.avatar || '',
        cat: c.cat || '',
        catName: c.catName || '',
        downloads: c.downloads || 0,
        session: false,
      });
    }
    for (const c of (sesRes && sesRes.list) || []) {
      const key = String(c.url || '').toLowerCase();
      if (!key) continue;
      const prev = byUrl.get(key) || {};
      byUrl.set(key, {
        url: c.url,
        title: c.title || prev.title || c.url,
        avatar: c.avatar || prev.avatar || '',
        cat: c.cat || prev.cat || '',
        catName: c.catName || prev.catName || '',
        downloads: prev.downloads || 0,
        session: true,
      });
    }
    bmLib.channels = Array.from(byUrl.values());
    renderLibrary();
    return bmLib;
  } catch (err) {
    console.error('loadLibrary failed:', err && err.message);
    return bmLib;
  }
}

function renderLibrary() {
  const tabs = $('bmTabs');
  const panel = $('bmPanel');
  if (!tabs || !panel) return;

  const all = bmLib.channels;
  const catOf = (c) => c.cat || 'other';
  const countOf = (id) => (id === 'all' ? all.length : all.filter((c) => catOf(c) === id).length);

  // 分类标签（「全部」在最前）。书签用短名，否则 8 个标签会换行、破坏书签的连贯观感；
  // 完整分类名显示在卡片副标题上。
  const list = [{ id: 'all', name: '全部', short: '全部', icon: '📚' }].concat(bmLib.cats);
  tabs.innerHTML = list
    .map(
      (c) => `<button class="bm-tab${bmLib.active === c.id ? ' on' : ''}" data-bm="${esc(c.id)}" title="${esc(
        c.name
      )}">
        <span>${c.icon || ''}</span>${esc(c.short || c.name)}<span class="bm-n">${countOf(c.id)}</span>
      </button>`
    )
    .join('');

  const show = bmLib.active === 'all' ? all : all.filter((c) => catOf(c) === bmLib.active);
  if (!show.length) {
    panel.innerHTML = `<div class="bm-empty">${
      all.length
        ? '这个分类下还没有博主。<br><span class="muted">识别过的频道会按视频内容自动归类</span>'
        : '还没有博主。<br><span class="muted">在上面粘贴一个频道链接，识别后它就会出现在这里</span>'
    }</div>`;
    return;
  }
  show.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
  panel.innerHTML = `<div class="bm-grid">${show.map(bmCardHtml).join('')}</div>`;
}

function bmCardHtml(c) {
  const cat = bmLib.cats.find((x) => x.id === c.cat);
  const catName = cat ? cat.name : c.catName || (c.cat ? c.cat : '未分类');
  const sub = `${catName}${c.downloads ? ' · 下载 ' + c.downloads : ''}`;
  return `<button class="ch-card" data-bm-url="${esc(c.url)}" title="${esc(
    `${c.title}\n${sub}\n点击抓取最新内容`
  )}">
    <img loading="lazy" src="${esc(c.avatar || '')}" />
    <span class="n"><b>${esc(c.title)}</b><span>${esc(sub)}</span></span>
    ${c.session ? '<span class="now">本次</span>' : ''}
    ${c.downloads ? `<span class="dl">${c.downloads}</span>` : ''}
  </button>`;
}

function renderChannel(data) {
  state.data = data;
  state.activeTab = 'all';
  state.selected.clear();
  state.renderedCount = 0;
  // 换频道时清空播放列表的展开状态
  state.playlistVideos = {};
  state.playlistLoading.clear();

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
          <img class="q-thumb" loading="lazy" />
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
    // 退避等待中：显示实时倒计时（每行单独更新，见 retryTicker）
    if (q.nextRetryAt && q.nextRetryAt > Date.now()) {
      el.dataset.retryAt = String(q.nextRetryAt);
      el.dataset.retryLabel = q.retryKind === 'throttle' ? 'YouTube 限流，' : q.retryKind === 'transient' ? '网络问题，' : '';
      stageText = `⏸ ${el.dataset.retryLabel}${fmtRetryIn(q.nextRetryAt)}后自动重试`;
    } else {
      delete el.dataset.retryAt;
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
    if (q.status === 'queued' && q.nextRetryAt && q.nextRetryAt > Date.now()) {
      // 退避等待中的任务：给一个「立即重试」，不用干等
      buttons.push(['retryNow', '立即重试', '不等退避了，马上再试一次']);
    } else if (q.status === 'queued') {
      buttons.push(['pause', '暂停', '']);
    }
    if (q.status === 'paused' || q.status === 'canceled') buttons.push(['resume', '继续', '从断点继续下载']);
    if (q.status === 'error') buttons.push(['retry', '重试', '']);
    // 只保留「打开」与「重做」。
    // 现在每个视频一个独立文件夹，音频/字幕/ASS/学习文档全在里面，
    // 「打开」进去就能看到全部产物，再给每个文件单独做快捷按钮已无必要。
    if (q.status === 'done' || q.status === 'skipped') {
      buttons.push(['open', '打开', '打开该视频的文件夹（含视频/音频/字幕/文档）']);
    }
    if (q.studyDocPath) {
      buttons.push(['redoDoc', '重做', '重新生成（走翻译缓存，不产生 API 费用；按住 Ctrl 可强制重新翻译）']);
      // 金句来自学习文档的分析结果，所以只有生成过文档的任务才有这个入口
      buttons.push(['quoteCards', '金句图', '把文档里的金句渲染成图片，方便存手机或分享']);
    } else if ((q.status === 'done' || q.status === 'skipped') && q.fileExists !== false) {
      // 注意：这里【不能】用 subCount > 0 做条件。
      // 字幕数量是下载时记下的，可能因为文件名截断之类的原因漏记（实测踩过），
      // 一旦漏记按钮就整个消失，用户连「重新试一次」的入口都没有。
      // 只要下载完成且文件还在，就给一个生成入口——生成前会重新扫盘找字幕。
      buttons.push(['redoDoc', '生成文档', '调用大模型生成中英对照学习文档（会先重新扫描视频旁边的字幕）']);
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

/* ==================== 系统字体列表（字幕字体选择） ==================== */

/** 常见中文字体的中文名别名：.NET 报的是英文族名（Microsoft YaHei），但 libass 也认中文名 */
const ZH_FONT_ALIASES = ['微软雅黑', '宋体', '黑体', '楷体', '仿宋', '等线', '思源黑体', '思源宋体'];

async function loadFontList() {
  try {
    const r = await api.fonts.list();
    const list = ((r && r.list) || []).slice();
    if (!list.length) return;
    for (const a of ZH_FONT_ALIASES) if (!list.includes(a)) list.push(a);
    list.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    $('fontList').innerHTML = list.map((f) => `<option value="${esc(f)}"></option>`).join('');
    console.log(`已加载 ${list.length} 个系统字体`);
  } catch (err) {
    console.error('loadFontList failed:', err && err.message);
  }
}

/* ==================== 作品详情预览 ==================== */

/**
 * 点封面打开详情。数据分两步来，先出再补：
 *   1. 列表里已有的（标题/封面/播放量/时长）→ 立即渲染，不用等网络
 *   2. 已下载过的 → 读本地边车文件，补上发布时间等
 *   3. 联网拉完整信息 → 补上**文案**（列表用的 flat 数据不含文案，只能按需再拉一次）
 *
 * pvSeq 是「在途请求作废」计数器：连点几个封面或中途关掉时，
 * 早先的请求回来得晚，不能让它覆盖掉当前正在看的那个。
 */
let pvSeq = 0;
let pvData = {};

function fmtUploadDate(s) {
  const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : String(s || '');
}

function closePreview() {
  pvSeq++;
  $('previewModal').classList.add('hidden');
}

function renderPreview(patch) {
  pvData = Object.assign({}, pvData, patch || {});
  const d = pvData;
  const cover = $('pvCover');
  if (d.thumbnail) {
    cover.src = d.thumbnail;
    cover.style.visibility = 'visible';
  } else {
    cover.removeAttribute('src');
    cover.style.visibility = 'hidden';
  }
  $('pvTitle').textContent = d.title || '—';

  const meta = [];
  if (d.channel) meta.push(`<span>📺 ${esc(d.channel)}</span>`);
  if (d.uploadDate) meta.push(`<span>📅 ${esc(fmtUploadDate(d.uploadDate))}</span>`);
  if (d.viewCount != null) meta.push(`<span>👁 ${fmtCount(d.viewCount)} 次播放</span>`);
  if (d.likeCount != null) meta.push(`<span>👍 ${fmtCount(d.likeCount)}</span>`);
  if (d.duration) meta.push(`<span>⏱ ${fmtDuration(d.duration)}</span>`);
  if (d.id) meta.push(`<span class="muted">ID ${esc(d.id)}</span>`);
  $('pvMeta').innerHTML = meta.join('');

  const local = state.downloadedIndex.get(d.id || '');
  $('pvOpenFolder').classList.toggle('hidden', !local);
  $('pvYoutube').href = d.webpageUrl || d.url || '#';
  $('pvDownload').textContent = local || doneKeys().has(d.id) ? '重新下载' : '下载这个';
}

async function openPreview(id) {
  const it = itemById(id);
  if (!it) return;
  const seq = ++pvSeq;
  pvData = {};
  $('previewModal').classList.remove('hidden');
  // 第一步：列表里已有的数据，秒出
  renderPreview({
    id: it.id,
    title: it.title,
    thumbnail: it.thumbnail,
    viewCount: it.viewCount,
    duration: it.duration,
    url: it.url,
    webpageUrl: it.url,
    channel: it.channel || '',
  });

  // 第二步：下载过的读本地边车（发布时间、播放量、点赞）—— 不用联网
  try {
    const loc = await api.downloads.local(id);
    if (seq !== pvSeq) return;
    if (loc && loc.ok && loc.rec) {
      const rec = loc.rec;
      renderPreview({
        uploadDate: rec.uploadDate,
        channel: rec.channel || pvData.channel,
        viewCount: rec.viewCount != null ? rec.viewCount : pvData.viewCount,
        likeCount: rec.likeCount,
      });
    }
  } catch (_) {}

  // 第三步：联网补发布时间/播放量/点赞
  // （列表用的 flat 数据没有发布时间，只能按需再拉一次）
  const res = await api.downloads.details(it.url);
  if (seq !== pvSeq) return; // 已经切走或关掉了，丢弃这次结果
  if (res && res.ok && res.details) {
    const d = res.details;
    renderPreview({
      id: d.id || pvData.id,
      title: d.title || pvData.title,
      channel: d.channel || pvData.channel,
      uploadDate: d.uploadDate || pvData.uploadDate,
      viewCount: d.viewCount != null ? d.viewCount : pvData.viewCount,
      likeCount: d.likeCount || pvData.likeCount,
      duration: d.duration || pvData.duration,
      thumbnail: d.thumbnail || pvData.thumbnail,
      webpageUrl: d.webpageUrl || pvData.url,
    });
  } else {
    // 拉不到就保持列表里已有的信息，不打扰用户（常见于 YouTube 风控）
    console.warn('读取作品详情失败:', (res && res.error) || '未知错误');
  }
}

/* ==================== Cookies（浏览器 / 文件 / 实测） ==================== */

/** 把本机装了哪些浏览器填进下拉框；没装的标灰，避免选了却读不到 */
async function loadCookieBrowsers() {
  try {
    const r = await api.cookies.detect();
    const sel = $('setCookieBrowser');
    const cur = sel.value;
    sel.innerHTML =
      '<option value="">不使用</option>' +
      ((r && r.browsers) || [])
        .map(
          (b) =>
            `<option value="${esc(b.id)}"${b.available ? '' : ' disabled'}>${esc(b.name)}${
              b.available ? '' : '（未安装）'
            }</option>`
        )
        .join('');
    if (cur) sel.value = cur;
  } catch (err) {
    console.error('loadCookieBrowsers failed:', err && err.message);
  }
}

/** 实测 Cookies 是否真的生效（只配了不算数，YouTube 认不认要试了才知道） */
async function testCookies() {
  const out = $('cookieTestResult');
  out.textContent = '测试中…';
  out.style.color = '';
  try {
    // 传当前表单里的值：用户往往是选完就点测试，此时还没保存
    const r = await api.cookies.test({
      cookieBrowser: $('setCookieBrowser').value,
      cookieFile: $('setCookieFile').value.trim(),
    });
    if (r && r.ok) {
      out.textContent = `生效（读到：${String(r.title || '').slice(0, 24)}）`;
      out.style.color = 'var(--ok)';
    } else {
      out.textContent = '失败：' + String((r && r.error) || '未知错误').slice(0, 200);
      out.style.color = 'var(--err)';
    }
  } catch (err) {
    out.textContent = '失败：' + (err && err.message);
    out.style.color = 'var(--err)';
  }
}

/* ==================== 退避重试的倒计时 ==================== */

/** 「还有多久重试」的人话描述 */
function fmtRetryIn(ts) {
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} 分 ${r} 秒` : `${m} 分钟`;
}

/**
 * 每秒刷一遍「等待重试」的倒计时。
 * 只动那几行文字，不重绘整个列表（列表可能有上千行）。
 */
function startRetryTicker() {
  setInterval(() => {
    for (const el of document.querySelectorAll('#queueList [data-retry-at]')) {
      const at = Number(el.dataset.retryAt || 0);
      if (!at) continue;
      const stage = el.querySelector('.q-stage');
      if (!stage) continue;
      if (at > Date.now()) {
        stage.textContent = `⏸ ${el.dataset.retryLabel || ''}${fmtRetryIn(at)}后自动重试`;
      }
      // 到点后由主进程重新排队，队列变更会触发整体重绘，这里不用管
    }
  }, 1000);
}

/* ==================== 最近下载的博主 ==================== */

/* ==================== 识别 ==================== */

async function doFetch(force) {
  const input = $('urlInput').value.trim();
  if (!input) {
    toast('请先粘贴博主主页链接', 'warn');
    return;
  }
  if (state.fetching) return;
  // 排查「界面自己跳到别的频道」这类问题全靠它：谁在什么时候发起了识别
  console.log(`[ui] 发起识别：${input}${force ? '（强制）' : ''}`);
  state.fetching = true;
  // 命中缓存时 IPC 几十毫秒就回来了。如果立刻显示贾维斯球，它会一闪而过，
  // 看着像界面在抽搐。所以延迟 280ms 再显示 —— 快路径根本不会看到球。
  const ballTimer = setTimeout(() => setFetchingUI(true), 280);

  const res = await api.channel.enumerate(input, !!force);
  clearTimeout(ballTimer);
  state.fetching = false;
  setFetchingUI(false);

  if (!res.ok) {
    if (res.canceled) toast('已取消识别', 'warn');
    else toast('识别失败：' + res.error, 'err', 9000);
    return;
  }

  const data = res.data;
  renderChannel(data);
  if (res.sessionCached) {
    $('chCacheInfo').textContent = '（本次已抓取，直接复用）';
  } else if (res.cached) {
    const mins = Math.round((res.cacheAgeSec || 0) / 60);
    const ago = mins < 60 ? `${mins} 分钟前` : mins < 1440 ? `${Math.round(mins / 60)} 小时前` : `${Math.round(mins / 1440)} 天前`;
    $('chCacheInfo').textContent = res.refreshing ? `（${ago}的列表 · 正在后台更新…）` : `（缓存 ${ago}）`;
  } else {
    $('chCacheInfo').textContent = '';
  }
  $('btnRefresh').classList.remove('hidden');

  const total = allItems().length;
  if (!total) {
    toast('没有识别到任何内容，可能该频道为空或链接有误', 'warn', 7000);
  }
  // 识别成功不再弹提示：上方状态栏已经在显示进度，列表也直接出来了，弹窗只是噪音
  const errs = (data.warnings || []).filter((w) => w.level === 'error');
  if (errs.length) toast(`有 ${errs.length} 个分类抓取失败，详情见列表上方提示`, 'warn', 7000);
}

/** 当前正在看的频道的「键」，用来判断后台刷新推回来的结果是不是当前这个 */
function currentChannelKey() {
  const ch = state.data && state.data.channel;
  return (ch && (ch.url || ch.handle)) || '';
}

/**
 * 后台刷新完成：把界面换成最新列表。
 * 关键是**保住用户的操作现场** —— 滚动位置、勾选、当前分类页、搜索词、过滤开关，
 * 否则用户正翻到一半，列表自己跳回顶部、勾选也没了，比不更新还烦。
 */
function applyRefreshedChannel(data) {
  const scroller = $('list');
  const scrollTop = scroller.scrollTop;
  const selected = new Set(state.selected);
  const tab = state.activeTab;
  const search = state.search;
  console.log(`[ui] 应用后台刷新结果：${(data.channel && data.channel.title) || '?'}`);

  renderChannel(data);

  state.activeTab = tab;
  state.search = search;
  const alive = new Set(allItems().map((x) => x.id));
  state.selected = new Set([...selected].filter((id) => alive.has(id)));
  renderList(true);
  scroller.scrollTop = scrollTop;

  $('chCacheInfo').textContent = '（刚刚更新）';
  const n = (data.items || []).length;
  toast(`列表已更新（${n} 个内容）`, 'ok', 3200);
}

function setFetchingUI(on) {
  $('btnFetch').disabled = on;
  $('btnFetch').innerHTML = on ? '<span class="spinner"></span> 识别中' : '识别';
  $('btnCancelFetch').classList.toggle('hidden', !on);
  // 贾维斯球：抓取期间浮在内容区上旋转，读完即隐
  $('jarvis').classList.toggle('hidden', !on);
  if (on) $('jvText').textContent = '正在连接…';
  if (!on) $('fetchStatus').classList.add('hidden');
}

function onProgress(p) {
  const el = $('fetchStatus');
  el.classList.remove('hidden');
  let text = '';
  if (p.phase === 'tab') {
    text = `正在抓取 ${SECTION_LABEL[p.tab] || p.tab} 标签页（${p.index + 1}/${p.total}）…`;
  } else if (p.phase === 'expand-playlist') {
    text = `正在展开${SECTION_LABEL[p.tab] || ''}容器「${p.label || ''}」（${(p.index || 0) + 1}/${
      p.total || '?'
    }）…`;
  } else if (p.phase === 'probe') {
    text = p.label || '读取中…';
  } else if (p.phase === 'cache') {
    text = p.label || '使用缓存';
  }
  el.innerHTML = `<span class="spinner"></span> ${esc(text)}`;
  // 贾维斯球下方也显示同一句进度，球在转的同时告诉用户进行到哪一步了
  const jv = $('jvText');
  if (jv) jv.textContent = text;
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
  $('setOrganizeInFolder').checked = s.organizeInFolder !== false;
  $('setChannelFolderName').value = s.channelFolderName || 'handle';
  $('setReadPlaylists').checked = s.readPlaylists !== false;
  $('setRateLimit').value = s.rateLimit || '';
  $('setProxy').value = s.proxy || '';
  $('setCookieFile').value = s.cookieFile || '';
  $('setCookieBrowser').value = s.cookieBrowser || '';
  $('cookieTestResult').textContent = '';
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
  $('setStudyBiSrt').checked = s.studyBilingualSrt === true;
  $('setStudyAss').checked = s.studyAss !== false;
  $('setAssColorEn').value = s.assColorEn || '#FFFFFF';
  $('setAssColorZh').value = s.assColorZh || '#FFD700';
  $('setAssOutlineColor').value = s.assOutlineColor || '#000000';
  $('setAssOutlineWidth').value = s.assOutlineWidth != null ? s.assOutlineWidth : 3;
  $('setAssFontEn').value = s.assFontEn || 'Times New Roman';
  $('setAssFontZh').value = s.assFontZh || '微软雅黑';
  $('setAssLineGap').value = s.assLineGap != null ? s.assLineGap : -0.2;
  $('setAssFontScale').value = s.assFontScale || 1;
  $('setAssWrapEn').value = s.assWrapEnChars || 44;
  $('setAssWrapZh').value = s.assWrapZhChars || 22;
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

  // 顶栏原来有一行「内核就绪 · yt-dlp …」的小字，按要求去掉了。
  // 但内核真的坏了必须让用户知道，否则只会觉得"点了没反应"——改成弹一次提示。
  if (!info.ytdlp.ok || !info.ffmpeg.ok) {
    toast('下载内核异常（yt-dlp 或 ffmpeg 不可用），请在设置里查看', 'err', 10000);
  }
  return info;
}

/* ==================== 事件绑定 ==================== */

function bind() {
  $('btnFetch').addEventListener('click', () => doFetch(false));
  $('btnRefresh').addEventListener('click', () => doFetch(true));
  $('btnCancelFetch').addEventListener('click', () => api.channel.cancel());

  // 返回主页：本次抓取过的博主会留在主页上，可以直接切回来
  $('btnBackHome').addEventListener('click', () => {
    clearChannelView();
    $('urlInput').value = '';
  });

  // 书签标签：切换分类
  $('bmTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-bm]');
    if (!btn) return;
    bmLib.active = btn.getAttribute('data-bm');
    renderLibrary();
  });

  // 频道卡片：点击 = 填入链接并【直接开始识别】，不用再点一次
  $('bmPanel').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-bm-url]');
    if (!btn) return;
    if (state.fetching) {
      toast('正在识别中，请稍候…', 'warn');
      return;
    }
    $('urlInput').value = btn.getAttribute('data-bm-url');
    console.log(`[ui] 点击书架卡片：${$('urlInput').value}`);
    doFetch(false);
  });

  // 右键从库里移除（只是不再显示，不影响已下载的文件和队列）
  $('bmPanel').addEventListener('contextmenu', async (e) => {
    const btn = e.target.closest('[data-bm-url]');
    if (!btn) return;
    e.preventDefault();
    const url = btn.getAttribute('data-bm-url');
    const name = btn.querySelector('.n b')?.textContent || url;
    const ok = await api.dialog.confirm({
      title: '移除记录',
      message: `把「${name}」从库里移除？`,
      detail: '只是不再显示在这里，已下载的文件和队列记录都不受影响。',
      confirmLabel: '移除',
      type: 'question',
    });
    if (!ok) return;
    await api.channels.remove(url);
    await loadLibrary();
  });
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
    // 点缩略图 = 打开作品详情预览（要放在最前面，否则会被行点击吃掉）
    const thumb = e.target.closest('[data-preview]');
    if (thumb) {
      e.stopPropagation();
      openPreview(thumb.getAttribute('data-preview'));
      return;
    }
    // 播放列表行的处理要放在最前面：展开/收起、整列表勾选
    const plToggle = e.target.closest('[data-pl-toggle]');
    if (plToggle) {
      togglePlaylist(plToggle.getAttribute('data-pl-toggle'));
      return;
    }
    const plCheck = e.target.closest('[data-pl-check]');
    if (plCheck) {
      onPlaylistCheck(plCheck.getAttribute('data-pl-check'), plCheck.checked);
      return;
    }
    const plRow = e.target.closest('[data-pl-row]');
    if (plRow) {
      togglePlaylist(plRow.getAttribute('data-pl-row'));
      return;
    }

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

  // 缩略图加载失败时隐藏掉，避免显示成破图。
  // 注意：CSP 是 script-src 'self'，行内 onerror="..." 会被拦截（实测报过 CSP 违规），
  // 所以改用事件委托；error 事件不冒泡，必须用捕获阶段监听。
  const hideBrokenImage = (e) => {
    if (e.target && e.target.tagName === 'IMG') e.target.style.visibility = 'hidden';
  };
  $('list').addEventListener('error', hideBrokenImage, true);
  $('queueList').addEventListener('error', hideBrokenImage, true);

  $('btnLoadMore').addEventListener('click', () => renderList(false));

  $('searchInput').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderList(true);
  });
  $('searchScope').addEventListener('change', (e) => {
    state.searchScope = e.target.value;
    renderList(true);
  });

  const visible = () => currentVisibleItems();
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
  // 与「仅选未下载」的区别：这是一个【显示过滤器】，只影响列表显示什么，不改动勾选
  $('onlyUndownloaded').addEventListener('change', (e) => {
    state.showOnlyUndownloaded = e.target.checked;
    doneSig = [...doneKeys()].sort().join(',');
    renderList(true);
    const hidden = currentTabItems().length - filteredItems().length;
    toast(
      e.target.checked
        ? hidden > 0
          ? `已隐藏 ${hidden} 个已下载的视频`
          : '当前分类下没有已下载的视频'
        : '已显示全部视频',
      'ok',
      2500
    );
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
    if (act === 'redoDoc') {
      const key = el.getAttribute('data-key');
      const force = !!e.ctrlKey;
      toast(force ? '正在重新翻译并生成（会调用大模型）…' : '正在生成学习文档…', 'ok', 2500);
      const r = await api.study.generate(key, force);
      if (r.ok) toast(r.fromCache ? '已用翻译缓存重新排版完成' : '学习文档生成完成', 'ok', 6000);
      else toast('生成失败：' + r.error, 'err', 9000);
      return;
    }
    if (act === 'quoteCards') {
      btn.disabled = true;
      toast('正在渲染金句卡片…', 'ok', 2000);
      try {
        const r = await api.study.quoteCards(key);
        if (r && r.ok) {
          toast(`已生成 ${r.files.length} 张金句卡片`, 'ok', 6000);
          api.shell.openPath(r.dir); // 直接打开文件夹，省得用户自己去找
        } else {
          toast('生成失败：' + ((r && r.error) || '未知错误'), 'err', 9000);
        }
      } finally {
        btn.disabled = false;
      }
      return;
    }
    await api.queue.action(key, act);
  });

  $('btnPauseAll').addEventListener('click', () => api.queue.pauseAll());
  $('btnResumeAll').addEventListener('click', () => api.queue.resumeAll());
  $('btnCancelAll').addEventListener('click', async () => {
    const s = state.stats || {};
    const n =
      (s.queued || 0) + (s.downloading || 0) + (s.paused || 0) + (s.error || 0) + (s.canceled || 0);
    if (!n) {
      toast('队列里没有未完成的任务', 'warn');
      return;
    }
    const ok = await api.dialog.confirm({
      title: '全部取消',
      message: `确定要取消队列里 ${n} 个未完成的任务吗？`,
      detail: '正在下载的会立即停止；这些任务会从队列中移除。\n已经下载完成的文件不受影响，部分下载的分片（.part）会保留在磁盘上。',
      confirmLabel: '全部取消',
    });
    if (!ok) return;
    const r = await api.queue.cancelAll();
    toast(`已取消并移除 ${r.removed} 个任务`, 'ok');
  });
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

  // ---- 作品详情预览 ----
  $('btnClosePreview').addEventListener('click', closePreview);
  $('previewModal').addEventListener('click', (e) => {
    if (e.target === $('previewModal')) closePreview();
  });
  $('pvDownload').addEventListener('click', () => {
    const it = itemById(pvData.id);
    closePreview();
    if (it) enqueue([it]);
    else toast('找不到该作品的信息，请重新识别一次', 'warn');
  });
  $('pvOpenFolder').addEventListener('click', () => {
    const local = state.downloadedIndex.get(pvData.id || '');
    if (local && local.videoPath) api.shell.showItem(local.videoPath);
    else toast('没有找到本地文件', 'warn');
  });
  $('pvYoutube').addEventListener('click', (e) => {
    // 直接点 <a> 会把应用窗口导航到 YouTube，必须拦下来交给系统浏览器
    e.preventDefault();
    const u = pvData.webpageUrl || pvData.url;
    if (u) api.shell.openExternal(u);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('previewModal').classList.contains('hidden')) closePreview();
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
  $('btnTestCookie').addEventListener('click', testCookies);

  $('btnSaveSettings').addEventListener('click', async () => {
    const patch = {
      outputDir: $('setOutputDir').value.trim(),
      concurrency: Number($('setConcurrency').value) || 2,
      autoRetry: Number($('setAutoRetry').value) || 0,
      filenameTemplate: $('setFilename').value.trim() || '%(title)s [%(id)s].%(ext)s',
      organizeInFolder: $('setOrganizeInFolder').checked,
      channelFolderName: $('setChannelFolderName').value,
      readPlaylists: $('setReadPlaylists').checked,
      rateLimit: $('setRateLimit').value.trim(),
      proxy: $('setProxy').value.trim(),
      cookieFile: $('setCookieFile').value.trim(),
      cookieBrowser: $('setCookieBrowser').value,
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
      studyAss: $('setStudyAss').checked,
      assColorEn: $('setAssColorEn').value,
      assColorZh: $('setAssColorZh').value,
      assOutlineColor: $('setAssOutlineColor').value,
      assOutlineWidth: Number($('setAssOutlineWidth').value),
      assFontEn: $('setAssFontEn').value.trim() || 'Times New Roman',
      assFontZh: $('setAssFontZh').value.trim() || '微软雅黑',
      // 允许填 -0.5 ~ 0.6；填不出数字就回到默认 -0.2
      assLineGap: Number.isFinite(Number($('setAssLineGap').value)) && $('setAssLineGap').value !== ''
        ? Number($('setAssLineGap').value)
        : -0.2,
      assFontScale: Number($('setAssFontScale').value) || 1,
      assWrapEnChars: Number($('setAssWrapEn').value) || 44,
      assWrapZhChars: Number($('setAssWrapZh').value) || 22,
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

  // 后台静默刷新完成 → 换掉列表。
  // 只有「推回来的正是用户此刻在看的频道」才替换：后台任务可能在用户切走之后才回来，
  // 那时替换会把用户正在看的另一个频道冲掉。
  api.channel.onRefreshed((payload) => {
    if (!payload || !payload.data || !state.data) return;
    const norm = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
    const cur = norm(state.data.channel && state.data.channel.url);
    const next = norm(payload.data.channel && payload.data.channel.url);
    if (!cur || !next || cur !== next) {
      console.log(`后台刷新结果不属于当前频道，忽略（当前 ${cur} / 回来 ${next}）`);
      return;
    }
    applyRefreshedChannel(payload.data);
  });

  api.queue.onChanged((payload) => {
    state.queue = payload.items || [];
    state.stats = payload.stats || {};
    invalidateDoneCache();
    renderQueue();
    // 有任务完成时：博主下载数会变，磁盘上也会多出边车文件，两处都刷新
    const doneCount = state.queue.filter((q) => q.status === 'done' || q.status === 'skipped').length;
    if (doneCount !== lastDoneCount) {
      lastDoneCount = doneCount;
      loadLibrary();
      // 重新扫一遍边车索引，让「已下载」标记与列表过滤立即反映最新状态
      loadDownloadsIndex(true).then(() => renderList(true));
    }
    // 开着「仅显示未下载」时，某个视频下载完成后要把它从列表里摘掉
    if (state.showOnlyUndownloaded) {
      const sig = [...doneKeys()].sort().join(',');
      if (sig !== doneSig) {
        doneSig = sig;
        renderList(true);
      }
    }
  });
}

async function enqueue(items) {
  // 记录这批视频所属的博主：既用于下载计数，也用于决定「博主母文件夹」的名字
  const d = state.data || {};
  const ch = d.channel || {};
  const channelRef =
    d.targetKind === 'channel' && ch.url
      ? { url: ch.url, title: ch.title || '', avatar: ch.avatar || '', handle: ch.handle || '', id: ch.id || '' }
      : null;

  const res = await api.queue.add(items, {
    quality: $('qualitySelect').value,
    audioOnly: $('audioOnly').checked,
    alsoAudio: $('alsoAudio').checked,
    writeSubs: $('writeSubs').checked,
    studyDoc: $('studyDoc').checked,
    outputDir: $('outputDir').value.trim() || undefined,
    channel: channelRef,
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
  // 先填浏览器下拉框，loadSettingsToForm 才能把已保存的值选上
  await loadCookieBrowsers();
  await loadSettingsToForm();
  await refreshKernelInfo();
  const q = await api.queue.list();
  state.queue = q.items || [];
  state.stats = q.stats || {};
  lastDoneCount = state.queue.filter((x) => x.status === 'done' || x.status === 'skipped').length;
  renderQueue();
  await loadLibrary();
  loadFontList();
  await loadDownloadsIndex();
  startRetryTicker();

  const info = await api.info();
  if (!info.isPackaged) {
    console.log('dev mode', info);
  }
})();
})();
