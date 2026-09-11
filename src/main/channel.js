'use strict';
/**
 * 频道识别与枚举：
 *  - parseTarget()      解析用户粘贴的链接，判断是频道 / 视频 / 播放列表
 *  - enumerateChannel() 抓取 Videos / Shorts / Live(Streams) / Podcasts 四个标签页
 *
 * 实测结论（2026-09，yt-dlp 2026.08.19）：
 *  1. 四个标签页均可通过 `<channel>/{tab}` + --flat-playlist --dump-single-json 一次拿到全量列表
 *     （856 个视频约 18 秒）
 *  2. streams 标签页返回的条目自带 live_status: is_live / is_upcoming / was_live
 *  3. podcasts 标签页返回的是「播客播放列表容器」而非单集，需要二级展开
 *  4. 频道若没有某个标签页，yt-dlp 直接报错 "This channel does not have a X tab"，
 *     必须区分「没有该标签」和「真的出错」，否则会误导用户
 */
const { BASE_FLAGS, run, killTree, extractErrors } = require('./ytdlp');

const TABS = ['videos', 'shorts', 'streams', 'podcasts'];

/**
 * 标签页 → 分类键 的映射。
 * streams 标签页的内容归入 live 分类，因此 tabStatus / warnings 也必须用 live 作为键，
 * 否则渲染层按 live 查不到状态（踩坑：会导致「没有直播标签的频道」整个 Live 分类消失）。
 */
const SECTION_OF_TAB = { videos: 'videos', shorts: 'shorts', streams: 'live', podcasts: 'podcasts' };

const TAB_LABEL = {
  videos: 'Videos',
  shorts: 'Shorts',
  live: 'Live',
  podcasts: 'Podcasts',
  playlist: '播放列表',
};

function parseTarget(rawInput) {
  let s = String(rawInput || '').trim();
  if (!s) return { kind: 'unknown', error: '请粘贴频道主页链接' };
  // 去掉常见包裹字符
  s = s.replace(/^["'<]+|["'>]+$/g, '').trim();

  if (s.startsWith('@')) s = 'https://www.youtube.com/' + s;
  else if (!/^https?:\/\//i.test(s)) {
    if (/^(www\.|m\.)?youtube\.com\//i.test(s) || /^youtu\.be\//i.test(s)) s = 'https://' + s;
    else if (/^[\w.\-]+$/.test(s)) s = 'https://www.youtube.com/@' + s;
    else return { kind: 'unknown', error: '无法识别的链接格式' };
  }

  let u;
  try {
    u = new URL(s);
  } catch (_) {
    return { kind: 'unknown', error: '无法解析该链接' };
  }

  const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  const parts = u.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be') {
    const id = parts[0];
    if (!id) return { kind: 'unknown', error: '短链接缺少视频 ID' };
    return { kind: 'video', videoId: id, url: `https://www.youtube.com/watch?v=${id}` };
  }

  if (host !== 'youtube.com' && host !== 'music.youtube.com' && host !== 'youtube-nocookie.com') {
    return { kind: 'unknown', error: `暂不支持该站点：${host}` };
  }

  if (parts[0] === 'watch') {
    const id = u.searchParams.get('v');
    if (!id) return { kind: 'unknown', error: '缺少视频 ID' };
    return { kind: 'video', videoId: id, url: `https://www.youtube.com/watch?v=${id}` };
  }
  if (parts[0] === 'shorts' && parts[1]) {
    return { kind: 'video', videoId: parts[1], url: `https://www.youtube.com/watch?v=${parts[1]}` };
  }
  if (parts[0] === 'live' && parts[1]) {
    return { kind: 'video', videoId: parts[1], url: `https://www.youtube.com/watch?v=${parts[1]}` };
  }
  if (parts[0] === 'playlist') {
    const listId = u.searchParams.get('list');
    if (!listId) return { kind: 'unknown', error: '缺少播放列表 ID' };
    return {
      kind: 'playlist',
      playlistId: listId,
      url: `https://www.youtube.com/playlist?list=${listId}`,
    };
  }

  if (parts[0] && /^(@|channel$|c$|user$)/.test(parts[0])) {
    // 统一归一化到 www.youtube.com，保证缓存键与去重稳定
    // （youtube.com / m.youtube.com / music.youtube.com 会得到同一个 base）
    const CANON = 'https://www.youtube.com';
    const base = parts[0].startsWith('@')
      ? `${CANON}/${parts[0]}`
      : `${CANON}/${parts[0]}/${parts[1] || ''}`;
    const maybeTab = parts[0].startsWith('@') ? parts[1] : parts[2];
    const requestedTab = TABS.includes(maybeTab) ? maybeTab : null;
    const cleanBase = base.replace(/\/+$/, '');
    return {
      kind: 'channel',
      channelBase: cleanBase,
      requestedTab,
      url: cleanBase,
    };
  }

  return { kind: 'unknown', error: '这不是频道主页、视频或播放列表链接' };
}

function thumbFor(id) {
  return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : '';
}

function normalizeEntry(entry, section, extra) {
  const id = entry.id;
  return Object.assign(
    {
      id,
      title: entry.title || '(无标题)',
      url: entry.url && /^https?:/.test(entry.url)
        ? entry.url
        : entry.webpage_url || `https://www.youtube.com/watch?v=${id}`,
      duration: typeof entry.duration === 'number' ? entry.duration : null,
      liveStatus: entry.live_status || null,
      viewCount: typeof entry.view_count === 'number' ? entry.view_count : null,
      thumbnail: thumbFor(id),
      sections: [section],
    },
    extra || {}
  );
}

/** 判断 yt-dlp 的报错是不是「该频道没有这个标签页」 */
function isMissingTabError(text) {
  return /does not have a .*?tab/i.test(text) || /has no .*?tab/i.test(text);
}

function isFatalChannelError(text) {
  return /does not exist|Unable to find|not a valid URL|Unsupported URL|Incomplete YouTube ID|HTTP Error 404|404 Not Found|This channel is not available/i.test(
    text
  );
}

/**
 * 执行一次 flat 枚举
 * @returns {{ok:boolean, json:object|null, error:string, missing:boolean}}
 */
async function dumpFlat(bin, url, opts = {}) {
  const args = BASE_FLAGS.concat([
    '--flat-playlist',
    '--dump-single-json',
    '--no-progress',
    '--extractor-args',
    'youtubetab:approximate_date',
  ]);
  if (opts.playlistEnd && opts.playlistEnd > 0) args.push('--playlist-end', String(opts.playlistEnd));
  args.push(url);

  const res = await run(bin, args, { onChild: opts.onChild });

  if (res.code !== 0) {
    const msg = extractErrors(res.stderr) || res.stderr.slice(-500) || `yt-dlp 退出码 ${res.code}`;
    return {
      ok: false,
      json: null,
      error: msg,
      missing: isMissingTabError(msg),
      fatal: isFatalChannelError(msg),
    };
  }

  const text = res.stdout.trim();
  if (!text) return { ok: false, json: null, error: 'yt-dlp 未返回任何数据', missing: false };

  try {
    // --dump-single-json 可能输出多行 JSON（带 --flat-playlist 时通常是一行）
    const json = JSON.parse(text);
    return { ok: true, json, error: '', missing: false };
  } catch (_) {
    // 兜底：按行解析，取最后一个完整 JSON
    const lines = text.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return { ok: true, json: JSON.parse(lines[i]), error: '', missing: false };
      } catch (__) {
        /* continue */
      }
    }
    return { ok: false, json: null, error: '返回数据解析失败', missing: false };
  }
}

/**
 * 枚举整个频道
 * @param {string} bin yt-dlp 路径
 * @param {string} channelBase 例如 https://www.youtube.com/@MrBeast
 * @param {object} opts { onProgress, onChild, maxItems }
 */
async function enumerateChannel(bin, channelBase, opts = {}) {
  const { onProgress } = opts;
  const maxItems = opts.maxItems || 0;

  const result = {
    channel: { url: channelBase, title: '', id: '', handle: '', followerCount: null, avatar: '' },
    sections: { videos: [], shorts: [], live: [], podcasts: [] },
    items: [],
    warnings: [],
    tabStatus: {},
  };

  const byId = new Map();

  for (let i = 0; i < TABS.length; i++) {
    const tab = TABS[i];
    const sec = SECTION_OF_TAB[tab];
    if (onProgress) onProgress({ phase: 'tab', tab: sec, index: i, total: TABS.length });

    const tabUrl = `${channelBase}/${tab}`;
    const res = await dumpFlat(bin, tabUrl, { onChild: opts.onChild });

    if (!res.ok) {
      if (res.missing) {
        result.tabStatus[sec] = 'missing';
        result.warnings.push({ tab: sec, level: 'info', message: `该频道没有 ${TAB_LABEL[sec]} 标签页` });
      } else {
        result.tabStatus[sec] = 'error';
        result.warnings.push({ tab: sec, level: 'error', message: res.error });
        if (res.fatal && !result.channel.title) {
          return { ok: false, error: res.error, result };
        }
      }
      continue;
    }

    const json = res.json;
    result.tabStatus[sec] = 'ok';

    // 频道元信息（任取第一个成功的标签页）
    if (!result.channel.title) {
      result.channel.title = json.channel || json.uploader || json.title || '';
      result.channel.id = json.channel_id || '';
      result.channel.handle = json.uploader_id || '';
      result.channel.followerCount =
        typeof json.channel_follower_count === 'number' ? json.channel_follower_count : null;
      const thumbs = json.thumbnails || [];
      if (thumbs.length) result.channel.avatar = thumbs[thumbs.length - 1].url || '';
    }

    const entries = Array.isArray(json.entries) ? json.entries.filter(Boolean) : [];

    if (tab === 'podcasts') {
      // 二级展开：podcasts 标签页里是播放列表容器
      const containers = entries.filter((e) => e.ie_key === 'YoutubeTab' || /playlist\?list=/.test(e.url || ''));
      const directVideos = entries.filter((e) => !(e.ie_key === 'YoutubeTab' || /playlist\?list=/.test(e.url || '')));
      let done = 0;

      for (const c of containers) {
        if (onProgress) {
          onProgress({
            phase: 'podcast-playlist',
            tab: sec,
            index: done,
            total: containers.length,
            label: c.title || '',
          });
        }
        const sub = await dumpFlat(bin, c.url, { onChild: opts.onChild });
        done++;
        if (!sub.ok) {
          result.warnings.push({
            tab: sec,
            level: 'error',
            message: `播客「${c.title || c.id}」展开失败：${sub.error}`,
          });
          continue;
        }
        const eps = Array.isArray(sub.json.entries) ? sub.json.entries.filter(Boolean) : [];
        for (const ep of eps) {
          if (!ep.id) continue;
          pushItem(result, byId, normalizeEntry(ep, 'podcasts', { playlistTitle: c.title || '' }), maxItems);
        }
      }
      for (const e of directVideos) {
        if (!e.id) continue;
        pushItem(result, byId, normalizeEntry(e, 'podcasts', {}), maxItems);
      }
    } else {
      for (const e of entries) {
        if (!e.id) continue;
        pushItem(result, byId, normalizeEntry(e, sec, {}), maxItems);
      }
    }
  }

  result.items = Array.from(byId.values());
  return { ok: true, result };
}

function pushItem(result, byId, item, maxItems) {
  if (maxItems > 0 && byId.size >= maxItems && !byId.has(item.id)) return;
  const existing = byId.get(item.id);
  if (existing) {
    // 同一视频出现在多个标签页（例如同时属于 Videos 和 Podcasts）——合并分类，避免重复下载
    for (const s of item.sections) {
      if (!existing.sections.includes(s)) existing.sections.push(s);
    }
    if (!existing.playlistTitle && item.playlistTitle) existing.playlistTitle = item.playlistTitle;
    return;
  }
  byId.set(item.id, item);
  result.sections[item.sections[0]].push(item);
}

/** 枚举单个播放列表 */
async function enumeratePlaylist(bin, url, opts = {}) {
  const res = await dumpFlat(bin, url, { onChild: opts.onChild });
  if (!res.ok) return { ok: false, error: res.error };
  const json = res.json;
  const entries = Array.isArray(json.entries) ? json.entries.filter(Boolean) : [];
  const items = entries
    .filter((e) => e.id && !(e.ie_key === 'YoutubeTab'))
    .map((e) => normalizeEntry(e, 'playlist', { playlistTitle: json.title || '' }));
  return {
    ok: true,
    result: {
      channel: {
        url,
        title: json.title || '播放列表',
        id: json.id || '',
        handle: json.uploader_id || '',
        followerCount: null,
        avatar: '',
      },
      sections: { playlist: items },
      items,
      warnings: [],
      tabStatus: { playlist: 'ok' },
    },
  };
}

/** 单个视频的元信息（用于粘贴单个视频链接的场景） */
async function probeVideo(bin, url, opts = {}) {
  const args = BASE_FLAGS.concat(['--dump-single-json', '--no-playlist', url]);
  const res = await run(bin, args, { onChild: opts.onChild });
  if (res.code !== 0) return { ok: false, error: extractErrors(res.stderr) || '视频信息获取失败' };
  try {
    const json = JSON.parse(res.stdout.trim());
    return {
      ok: true,
      item: normalizeEntry(
        {
          id: json.id,
          title: json.title,
          webpage_url: json.webpage_url,
          duration: json.duration,
          live_status: json.live_status,
          view_count: json.view_count,
        },
        'single',
        { url: json.webpage_url || url, thumbnail: json.thumbnail || thumbFor(json.id) }
      ),
    };
  } catch (err) {
    return { ok: false, error: '视频信息解析失败' };
  }
}

module.exports = {
  TABS,
  TAB_LABEL,
  parseTarget,
  enumerateChannel,
  enumeratePlaylist,
  probeVideo,
  dumpFlat,
  normalizeEntry,
  thumbFor,
  isMissingTabError,
  isFatalChannelError,
  killTree,
};
