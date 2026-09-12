'use strict';
/**
 * 博主下载记录（userData/channels.json）。
 * 用于首页的「最近下载的博主」快捷入口：按下载数倒序显示头像，点一下即可抓取最新内容。
 *
 * 计数时机：某个视频【下载成功或已存在】时给它所属的博主 +1。
 * 因此这个数字反映的是"实际下过的数量"，而不是"点过多少次"。
 */
const fs = require('fs');
const path = require('path');
const { userDataDir, ensureDir } = require('./paths');

let cache = null;

function file() {
  return path.join(ensureDir(userDataDir()), 'channels.json');
}

/** 用频道主页地址作为唯一键（@handle 形式，稳定且可读） */
function keyOf(ref) {
  if (!ref || !ref.url) return '';
  return String(ref.url).trim().replace(/\/+$/, '').toLowerCase();
}

function load() {
  if (cache) return cache;
  let list = [];
  try {
    const f = file();
    if (fs.existsSync(f)) {
      // 容忍 BOM（外部工具用 PowerShell 改过就会带上）
      const raw = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
      list = Array.isArray(raw) ? raw : raw.list || [];
    }
  } catch (err) {
    console.error('[channels] load failed:', err && err.message);
    list = [];
  }
  cache = list.filter((x) => x && x.url);
  return cache;
}

function save() {
  try {
    fs.writeFileSync(file(), JSON.stringify(cache || [], null, 2), 'utf8');
  } catch (err) {
    console.error('[channels] save failed:', err && err.message);
  }
}

/**
 * 给某个博主累加下载数（博主不存在则新建）。
 * @param {{url:string,title?:string,avatar?:string,cat?:string,catName?:string}} ref
 * @param {number} [n]
 */
function bump(ref, n) {
  const key = keyOf(ref);
  if (!key) return null;
  const list = load();
  const inc = Number(n) > 0 ? Number(n) : 1;
  let item = list.find((x) => keyOf(x) === key);
  if (!item) {
    item = {
      url: String(ref.url).trim().replace(/\/+$/, ''),
      title: ref.title || '',
      avatar: ref.avatar || '',
      cat: '',
      catName: '',
      downloads: 0,
      lastAt: '',
    };
    list.push(item);
  }
  // 标题/头像可能会更新（例如频道改名、换了头像），有新的就覆盖
  if (ref.title) item.title = ref.title;
  if (ref.avatar) item.avatar = ref.avatar;
  // 分类也允许后续修正（第一次可能没有标题可依据）
  if (ref.cat) {
    item.cat = ref.cat;
    if (ref.catName) item.catName = ref.catName;
  }
  item.downloads = (Number(item.downloads) || 0) + inc;
  item.lastAt = new Date().toISOString();
  save();
  return item;
}

/**
 * 记录/更新某个博主的分类（书签分组用）。
 * 识别频道时我们手上才有几百条视频标题，那是分类的最佳时机。
 */
function setCategory(ref, cat, catName) {
  const key = keyOf(ref);
  if (!key || !cat) return null;
  const list = load();
  let item = list.find((x) => keyOf(x) === key);
  if (!item) {
    // 还没下载过也算「库」里的一员，先建档（下载数 0）
    item = {
      url: String(ref.url).trim().replace(/\/+$/, ''),
      title: (ref && ref.title) || '',
      avatar: (ref && ref.avatar) || '',
      cat: '',
      catName: '',
      downloads: 0,
      lastAt: '',
    };
    list.push(item);
  }
  item.cat = cat;
  if (catName) item.catName = catName;
  if (ref && ref.title) item.title = ref.title;
  if (ref && ref.avatar) item.avatar = ref.avatar;
  save();
  return item;
}

/** 按下载数倒序（同数量按最近下载时间倒序） */
function top(limit) {
  const list = load().slice();
  list.sort((a, b) => {
    const d = (Number(b.downloads) || 0) - (Number(a.downloads) || 0);
    if (d !== 0) return d;
    return String(b.lastAt || '').localeCompare(String(a.lastAt || ''));
  });
  return limit > 0 ? list.slice(0, limit) : list;
}

function remove(url) {
  const key = keyOf({ url });
  const list = load();
  const i = list.findIndex((x) => keyOf(x) === key);
  if (i >= 0) {
    list.splice(i, 1);
    save();
    return true;
  }
  return false;
}

/** 仅供测试：丢弃内存缓存 */
function _reset() {
  cache = null;
}

module.exports = { load, save, bump, setCategory, top, remove, keyOf, _reset };
