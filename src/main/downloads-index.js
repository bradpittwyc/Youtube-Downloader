'use strict';
/**
 * 已下载索引：以【磁盘上的边车文件】为准，而不是队列历史。
 *
 * 每个下载完成的视频旁边会写一个 `<文件名>.video.json`（约几百字节），内容是：
 *   { id, title, channel, uploadDate, viewCount, url, file, at }
 *
 * 为什么需要它：文件名模板是「标题 [日期].mp4」，**不含视频 ID**，
 * 所以光看文件名无法判断某个作品是否已经下载过。队列记录又可能被「清除已完成」删掉、
 * 或者换台机器/重装后就没有了。边车文件把 ID 落在文件旁边，扫描目录即可还原全部记录。
 *
 * 顺带：它也是「作品详情」的本地缓存，点开预览时能秒出文案与发布时间。
 */
const fs = require('fs');
const path = require('path');

/** 去掉扩展名后的基准路径 */
function baseOf(videoPath) {
  return String(videoPath || '').replace(/\.[^.\\/]+$/, '');
}

function sidecarOf(videoPath) {
  return `${baseOf(videoPath)}.video.json`;
}

/** 写边车（失败不影响主流程） */
function writeSidecar(videoPath, info) {
  if (!videoPath) return '';
  const p = sidecarOf(videoPath);
  try {
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          id: info.id || '',
          title: info.title || '',
          channel: info.channel || '',
          uploadDate: info.uploadDate || '',
          viewCount: info.viewCount == null ? null : info.viewCount,
          likeCount: info.likeCount == null ? null : info.likeCount,
          duration: info.duration == null ? null : info.duration,
          url: info.url || '',
          file: path.basename(videoPath),
          at: new Date().toISOString(),
        },
        null,
        2
      ),
      'utf8'
    );
    return p;
  } catch (err) {
    console.error('[index] 写边车失败:', err && err.message);
    return '';
  }
}

function readSidecar(p) {
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    return j && j.id ? j : null;
  } catch (_) {
    return null;
  }
}

/**
 * 扫描下载目录下的所有边车文件，建立 视频ID → 记录 的映射。
 * 以边车所在目录里的实际视频文件是否存在为准（找不到就把这条判为失效）。
 */
function scan(outputDir, opts = {}) {
  const out = new Map();
  const maxDepth = opts.maxDepth || 6;
  const root = String(outputDir || '').trim();
  if (!root || !fs.existsSync(root)) return out;

  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    const sidecars = [];
    let hasVideo = false;
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < maxDepth && !e.name.startsWith('.')) stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      } else if (e.name.endsWith('.video.json')) {
        sidecars.push(path.join(dir, e.name));
      } else if (/\.(mp4|mkv|webm|m4a|mp3|opus|flac|wav)$/i.test(e.name)) {
        hasVideo = true;
      }
    }
    if (!sidecars.length) continue;
    for (const p of sidecars) {
      const rec = readSidecar(p);
      if (!rec) continue;
      // 边车旁边的文件（优先用它自己记的文件名，回退找同名的视频）
      const own = rec.file ? path.join(path.dirname(p), rec.file) : '';
      const base = p.replace(/\.video\.json$/i, '');
      let videoFile = own && fs.existsSync(own) ? own : '';
      if (!videoFile) {
        for (const ext of ['.mp4', '.mkv', '.webm', '.m4a', '.mp3']) {
          if (fs.existsSync(base + ext)) { videoFile = base + ext; break; }
        }
      }
      // 文件已经不在磁盘上 → 这条记录作废（用户可能手动删了）
      if (!videoFile) continue;
      const prev = out.get(rec.id);
      if (!prev || String(rec.at || '') > String(prev.at || '')) {
        out.set(rec.id, Object.assign({}, rec, { videoPath: videoFile, sidecarPath: p, dir: path.dirname(p) }));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 内存缓存

let cache = null; // { dir, at, map }

/** 取索引；同一个目录 5 秒内复用缓存，避免枚举时反复扫盘 */
function lookupAll(outputDir, opts = {}) {
  const dir = String(outputDir || '').trim();
  const ttl = opts.ttl == null ? 5000 : opts.ttl;
  if (cache && cache.dir === dir && Date.now() - cache.at < ttl) return cache.map;
  const map = scan(dir, opts);
  cache = { dir, at: Date.now(), map };
  return map;
}

function invalidate() {
  cache = null;
}

/** 直接往缓存里塞一条（刚下载完时用，省一次全盘扫描） */
function remember(rec) {
  if (!cache || !rec || !rec.id) return;
  cache.map.set(rec.id, rec);
}

module.exports = { sidecarOf, writeSidecar, scan, lookupAll, invalidate, remember, baseOf };
