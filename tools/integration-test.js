'use strict';
/**
 * 集成测试（不依赖 Electron）：
 * 通过 mock require('electron') 直接驱动 src/main 下的真实模块，
 * 用真实 yt-dlp / ffmpeg 跑「识别 → 入队 → 下载 → 暂停 → 断点续传」全链路。
 *
 * 运行： node tools/integration-test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'ytdl-harness');
const DL = path.join(TMP, 'downloads');

// ---------- mock electron ----------
const fakeElectron = {
  app: {
    isPackaged: false,
    getAppPath: () => ROOT,
    getVersion: () => '1.0.0-test',
    getPath: (name) => {
      const d = path.join(TMP, name);
      fs.mkdirSync(d, { recursive: true });
      return d;
    },
  },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, ...rest);
};

// ---------- 被测模块 ----------
const channel = require('../src/main/channel');
const settingsStore = require('../src/main/settings');
const paths = require('../src/main/paths');
const ytdlp = require('../src/main/ytdlp');
const { DownloadQueue, buildFormat } = require('../src/main/queue');

// ---------- 测试脚手架 ----------
let pass = 0;
let fail = 0;
const failures = [];

/**
 * 快速模式：YTLD_QUICK=1
 * 频道枚举是最慢的一环（两个频道 × 4 个标签页 × 全量翻页），
 * 而且连续跑多次会触发 YouTube 限流使耗时成倍增长。
 * 日常改动验证用快速模式（单频道、少量条目），发版前再跑完整模式。
 */
const QUICK = process.env.YTLD_QUICK === '1';

function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    failures.push(label + (extra ? ` — ${extra}` : ''));
    console.log(`  ❌ ${label}${extra ? ' — ' + extra : ''}`);
  }
}

function section(t) {
  console.log(`\n=== ${t} ===  [${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`);
}

function waitFor(fn, timeoutMs, label, interval = 250) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let v;
      try {
        v = fn();
      } catch (err) {
        return reject(err);
      }
      if (v) return resolve(v);
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`超时：${label}`));
      setTimeout(tick, interval);
    };
    tick();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 每个用例都用干净的队列文件，避免上一个用例残留的队列项污染下一个
 * （踩坑：曾导致 T7 复用了 T6 的 filePath，测试假通过）。
 */
function freshQueue() {
  try {
    fs.rmSync(paths.queueFile(), { force: true });
  } catch (_) {}
  const q = new DownloadQueue();
  q.load();
  return q;
}

/** 读取文件的音频轨信息（用内置 ffmpeg，不依赖 ffprobe） */
function probeAudio(file, ffmpeg) {
  const r = require('child_process').spawnSync(ffmpeg, ['-hide_banner', '-i', file], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const text = (r.stderr || '') + (r.stdout || '');
  const line = text.split(/\r?\n/).find((l) => /Stream #\d+:\d+.*Audio:/.test(l)) || '';
  const codec = (line.match(/Audio:\s*([A-Za-z0-9_]+)/) || [])[1] || null;
  return { has: !!line, codec, line: line.trim().slice(0, 120) };
}

/** 真正尝试解码音频流，模拟播放器行为 */
function canDecodeAudio(file, ffmpeg) {
  const r = require('child_process').spawnSync(
    ffmpeg,
    ['-hide_banner', '-v', 'error', '-i', file, '-vn', '-f', 'null', '-'],
    { encoding: 'utf8', windowsHide: true }
  );
  const err = ((r.stderr || '') + (r.stdout || '')).trim();
  return { ok: r.status === 0 && !err, err: err.slice(0, 160) };
}

// ---------- 测试 0：默认下载目录 ----------
function testDefaultOutputDir() {
  section('T0 默认下载目录（不得落在 C 盘）');
  const d = settingsStore.pickDefaultOutputDir();
  const root = path.parse(d).root;
  console.log(`    解析结果: ${d}`);
  ok(!!d, '能解析出默认下载目录');
  ok(root.toUpperCase() !== 'C:\\', `默认目录不在 C 盘（实际盘符 ${root}）`, d);
  ok(d.endsWith(settingsStore.OUTPUT_FOLDER_NAME), `目录名正确（${settingsStore.OUTPUT_FOLDER_NAME}）`);

  // 迁移：旧版 C 盘默认目录应被自动替换
  const legacy = path.join(TMP, 'userData', 'downloads');
  settingsStore.save({ outputDir: legacy });
  const after = settingsStore.load().outputDir;
  ok(after !== legacy, '旧版 C 盘默认目录会被自动迁移掉', after);
  ok(path.parse(after).root.toUpperCase() !== 'C:\\', '迁移后仍不在 C 盘');

  // 自愈：盘符不存在时应回退，而不是让下载全部失败
  settingsStore.save({ outputDir: 'Q:\\definitely-not-exist\\x' });
  const healed = settingsStore.load().outputDir;
  ok(fs.existsSync(path.parse(healed).root), '不存在的盘符会被自愈回退', healed);

  // 文件名模板迁移：旧默认（标题+视频ID）→ 新默认（标题+上传日期）
  settingsStore.save({ filenameTemplate: settingsStore.LEGACY_FILENAME_TEMPLATE });
  const tpl = settingsStore.load().filenameTemplate;
  console.log(`    文件名模板: ${tpl}`);
  ok(tpl !== settingsStore.LEGACY_FILENAME_TEMPLATE, '旧文件名模板会被自动迁移');
  ok(tpl.includes('upload_date'), '新模板包含上传时间');
  ok(!tpl.includes('%(id)s'), '新模板不再包含视频 ID（按要求精简）');
  ok(/^%\(title\)s/.test(tpl), '新模板以原标题开头');
}

// ---------- 测试 1：链接解析 ----------
function testParseTarget() {
  section('T1 链接解析 parseTarget');
  const cases = [
    ['@MrBeast', 'channel', 'https://www.youtube.com/@MrBeast'],
    ['https://www.youtube.com/@MrBeast', 'channel', 'https://www.youtube.com/@MrBeast'],
    ['https://www.youtube.com/@MrBeast/videos', 'channel', 'https://www.youtube.com/@MrBeast'],
    ['youtube.com/@MrBeast/shorts', 'channel', 'https://www.youtube.com/@MrBeast'],
    ['m.youtube.com/@MrBeast', 'channel', 'https://www.youtube.com/@MrBeast'],
    ['https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA', 'channel', 'https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA'],
    ['https://www.youtube.com/watch?v=5mU6SRS2Bxo', 'video', 'https://www.youtube.com/watch?v=5mU6SRS2Bxo'],
    ['https://youtu.be/5mU6SRS2Bxo', 'video', 'https://www.youtube.com/watch?v=5mU6SRS2Bxo'],
    ['https://www.youtube.com/shorts/5mU6SRS2Bxo', 'video', 'https://www.youtube.com/watch?v=5mU6SRS2Bxo'],
    ['https://www.youtube.com/playlist?list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4', 'playlist', null],
  ];
  for (const [input, kind, url] of cases) {
    const r = channel.parseTarget(input);
    const good = r.kind === kind && (url == null || r.url === url || r.channelBase === url);
    ok(good, `"${input}" → ${kind}`, good ? '' : `实际 ${r.kind} / ${r.url || r.channelBase}`);
  }
  const bad = channel.parseTarget('https://vimeo.com/12345');
  ok(bad.kind === 'unknown', '不支持的站点被拒绝');
  const empty = channel.parseTarget('');
  ok(empty.kind === 'unknown', '空输入被拒绝');
}

// ---------- 测试 2：频道枚举 ----------
async function testEnumerate() {
  section('T2 频道枚举（真实网络）');
  const bin = paths.ytDlpPath(settingsStore.load());
  ok(!!bin, '找到内置 yt-dlp', bin || '');
  if (!bin) return;

  const cases = QUICK
    ? [{ name: '@lexfridman', base: 'https://www.youtube.com/@lexfridman', expect: ['videos'] }]
    : [
        { name: '@lexfridman', base: 'https://www.youtube.com/@lexfridman', expect: ['videos', 'podcasts'] },
        { name: '@MrBeast', base: 'https://www.youtube.com/@MrBeast', expect: ['videos', 'shorts'] },
      ];

  for (const c of cases) {
    const t0 = Date.now();
    const out = await channel.enumerateChannel(bin, c.base, {
      maxItems: QUICK ? 40 : 400,
      onProgress: (p) => {
        if (p.phase === 'tab') process.stdout.write(`    [${p.tab} ${p.index + 1}/${p.total}] `);
      },
    });
    process.stdout.write('\n');
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    ok(out.ok, `${c.name} 枚举成功（${secs}s）`, out.ok ? '' : out.error);
    if (!out.ok) continue;

    const r = out.result;
    ok(!!r.channel.title, `${c.name} 拿到频道名：${r.channel.title}`);
    ok(r.items.length > 0, `${c.name} 共识别 ${r.items.length} 个内容`);
    for (const tab of c.expect) {
      ok(r.tabStatus[tab] === 'ok', `${c.name} 的 ${tab} 标签抓取成功`, `状态=${r.tabStatus[tab]}`);
    }
    // 每个条目必备字段
    const badItem = r.items.find((it) => !it.id || !it.title || !it.url || !it.thumbnail);
    ok(!badItem, `${c.name} 所有条目字段完整`, badItem ? JSON.stringify(badItem).slice(0, 120) : '');
    // 编码回归：标题里不允许出现 U+FFFD（ANSI/UTF-8 解码错乱的标志）
    const mojibake = r.items.filter((it) => it.title.includes('\uFFFD'));
    ok(mojibake.length === 0, `${c.name} 标题无编码乱码`, mojibake.length ? mojibake[0].title : '');
    // 分类计数与 items 一致性
    const sum = Object.values(r.sections).reduce((s, a) => s + a.length, 0);
    ok(sum >= r.items.length, `${c.name} 分类计数合理（分类合计 ${sum} / 去重后 ${r.items.length}）`);
    // 去重有效性
    const ids = r.items.map((i) => i.id);
    ok(new Set(ids).size === ids.length, `${c.name} 条目已去重（${new Set(ids).size}/${ids.length}）`);
    const missing = Object.entries(r.tabStatus)
      .filter(([, v]) => v === 'missing')
      .map(([k]) => k);
    console.log(`    频道=${r.channel.title} 订阅=${r.channel.followerCount} 缺失标签=[${missing.join(',')}]`);
    console.log(
      `    分类：` +
        Object.entries(r.sections)
          .filter(([, v]) => v.length)
          .map(([k, v]) => `${k}=${v.length}`)
          .join(' ')
    );
  }

  // 单个视频探测
  const probe = await channel.probeVideo(bin, 'https://www.youtube.com/watch?v=5mU6SRS2Bxo');
  ok(probe.ok && probe.item.id === '5mU6SRS2Bxo', '单个视频信息探测成功', probe.ok ? '' : probe.error);
}

// ---------- 测试 3：下载 + 进度 ----------
async function testDownload() {
  section('T3 真实下载 + 进度回调（MP3 提取）');
  settingsStore.save({
    outputDir: DL,
    concurrency: 1,
    rateLimit: '',
    skipDownloaded: false,
    autoRetry: 0,
    embedMetadata: true,
    embedThumbnail: true,
    writeSubs: false, // 字幕由 T8 专门覆盖，这里关掉以免拖慢
  });

  const q = freshQueue();

  const stages = new Set();
  let maxProgress = 0;
  q.on('changed', () => {
    const it = q.items.get('5mU6SRS2Bxo');
    if (it) {
      stages.add(it.stage);
      maxProgress = Math.max(maxProgress, it.progress || 0);
    }
  });

  const res = q.add(
    [
      {
        id: '5mU6SRS2Bxo',
        title: 'harness-test-short',
        url: 'https://www.youtube.com/watch?v=5mU6SRS2Bxo',
        section: 'shorts',
        thumbnail: '',
      },
    ],
    { quality: '360', audioOnly: true, outputDir: DL }
  );
  ok(res.added === 1, '任务成功入队');

  try {
    await waitFor(() => q.items.get('5mU6SRS2Bxo').status === 'done', 240000, '下载完成');
    const it = q.items.get('5mU6SRS2Bxo');
    ok(true, '任务状态 = done');
    ok(!!it.filePath && fs.existsSync(it.filePath), `文件已落盘：${path.basename(it.filePath || '')}`);
    ok(!String(it.filePath).includes('\uFFFD'), '落盘路径无编码乱码（U+FFFD 回归测试）', it.filePath);
    ok(/\.mp3$/i.test(it.filePath || ''), 'MP3 格式正确');
    ok((it.totalBytes || 0) > 0, `记录到总字节数 ${it.totalBytes}`);
    ok(maxProgress >= 0.99, `进度达到 ${(maxProgress * 100).toFixed(0)}%`);
    console.log(`    经历阶段：${Array.from(stages).join(' → ')}`);
  } catch (err) {
    const it = q.items.get('5mU6SRS2Bxo');
    ok(false, '下载完成', `${err.message} | status=${it && it.status} error=${it && it.error}`);
  }

  // 已完成后重新入队：应替换历史记录（而不是被去重挡掉）
  const again = q.add(
    [{ id: '5mU6SRS2Bxo', title: 'x', url: 'https://www.youtube.com/watch?v=5mU6SRS2Bxo', section: 'shorts' }],
    {}
  );
  ok(again.added === 1 && again.skipped === 0, '已完成后可重新入队（历史记录替换）');
  await q.remove('5mU6SRS2Bxo');
  await sleep(400);
  q.clear('all');
  return q;
}

// ---------- 测试 4：暂停 / 断点续传 ----------
async function testResume() {
  section('T4 暂停 → 断点续传（核心需求）');
  const VID = 'Qtl8lJwbd4g'; // 约 20 分钟，1080p 视频流约 210MB
  const dir = path.join(DL, 'resume'); // 独立目录，避免与其它用例的文件混淆
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  settingsStore.save({
    outputDir: dir,
    concurrency: 1,
    rateLimit: '3M', // 限速，保证来得及中途暂停
    skipDownloaded: false,
    autoRetry: 0,
    embedMetadata: false,
    writeSubs: false, // 本用例只测续传，别掺字幕拖慢速度
  });

  const q = freshQueue();
  q.add(
    [
      {
        id: VID,
        title: 'harness-resume-test',
        url: `https://www.youtube.com/watch?v=${VID}`,
        section: 'videos',
        thumbnail: '',
      },
    ],
    { quality: '1080', audioOnly: false, outputDir: dir }
  );

  // 注意：不能再用视频 ID 去匹配文件名 —— 默认文件名模板已改成「标题 [日期]」，
  // 文件名里根本没有 ID（踩坑：曾因此让本用例干等 120 秒超时）。
  const partFiles = () =>
    fs.readdirSync(dir).filter((f) => /\.part(-Frag\d+)?$/i.test(f));
  const partBytes = () => partFiles().reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);

  try {
    await waitFor(() => partBytes() > 6 * 1024 * 1024, 120000, '下载到 6MB');
    const before = partBytes();
    ok(before > 0, `开始下载，.part 已写入 ${(before / 1048576).toFixed(2)} MB`);

    // 暂停
    await q.pause(VID);
    await waitFor(() => q.items.get(VID).status === 'paused', 60000, '进入 paused');
    await sleep(1200);
    const atPause = partBytes();
    ok(q.items.get(VID).status === 'paused', '暂停成功，状态 = paused');
    ok(partFiles().length > 0, `暂停后 .part 保留（${partFiles().join(', ')}）`);

    // 确认没有残留 yt-dlp 进程
    const procs = require('child_process')
      .execSync('tasklist /FI "IMAGENAME eq yt-dlp.exe" /NH', { encoding: 'utf8', windowsHide: true })
      .trim();
    ok(!/yt-dlp\.exe/i.test(procs), '暂停后无孤儿 yt-dlp 进程', procs.split('\n')[0]);

    // 继续下载
    q.resume(VID);
    await waitFor(() => q.items.get(VID).status === 'downloading', 30000, '重新进入 downloading');
    ok(true, '继续下载已启动');
    await waitFor(() => partBytes() > atPause + 1024 * 1024, 120000, '续传后体积继续增长');
    const after = partBytes();
    ok(after > atPause, `断点续传生效：${(atPause / 1048576).toFixed(2)} MB → ${(after / 1048576).toFixed(2)} MB`);

    // 收尾：暂停并移除任务、清理分片
    await q.pause(VID);
    await sleep(800);
    await q.remove(VID);
    fs.rmSync(dir, { recursive: true, force: true });
    ok(true, '测试任务已清理（.part 分片删除，不占磁盘）');
  } catch (err) {
    ok(false, '断点续传流程', err.message);
    try {
      await q.pause(VID);
      await sleep(500);
    } catch (_) {}
  }
}

// ---------- 测试 7：成品必须有声音 + 同时产出同名音频 ----------
async function testVideoHasAudioAndSidecarAudio() {
  section('T7 成品视频必须带可解码音频 + 同时导出同名音频');
  const VID = '5mU6SRS2Bxo';
  const ff = paths.ffmpegPath(settingsStore.load());
  const dir = path.join(DL, 'audio');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  settingsStore.save({
    outputDir: dir,
    rateLimit: '',
    skipDownloaded: false,
    autoRetry: 0,
    embedMetadata: false,
    concurrency: 1,
    videoCodec: 'quality',
    alsoAudio: true,
    audioFormat: 'mp3',
    writeSubs: false,
  });

  const q = freshQueue();
  q.add(
    [{ id: VID, title: 'audio-test', url: `https://www.youtube.com/watch?v=${VID}`, section: 'videos' }],
    { quality: '480', audioOnly: false, outputDir: dir, alsoAudio: true, videoCodec: 'quality' }
  );

  const it = () => q.items.get(VID);
  try {
    await waitFor(() => it() && ['done', 'error', 'skipped'].includes(it().status), 300000, '下载结束');
    ok(it().status === 'done', `视频下载成功（${it().status}）`, it().error);

    const video = it().filePath;
    ok(!!video && fs.existsSync(video), '视频文件已落盘', video);
    ok(!!video && path.dirname(video) === dir, '视频落在本次指定的输出目录（防止复用了其它用例的路径）', video);

    if (video && fs.existsSync(video)) {
      const a = probeAudio(video, ff);
      console.log(`    成品音频轨: ${a.line}`);
      ok(a.has, '成品里有音频轨');
      ok(a.codec === 'aac', `音频编码必须是 AAC（实际 ${a.codec}）— Opus 塞进 MP4 会导致没声音`);
      const dec = canDecodeAudio(video, ff);
      ok(dec.ok, '音频轨可被正常解码（模拟播放器）', dec.err);
    }

    // 等待本地音频导出完成
    await waitFor(() => it() && !it().extractingAudio && (it().audioPath || it().audioError), 180000, '音频导出');
    const audio = it().audioPath;
    ok(!!audio, '音频导出路径已记录', it().audioError || '');
    ok(!!audio && fs.existsSync(audio), `同名音频已生成：${audio ? path.basename(audio) : ''}`);
    if (audio && fs.existsSync(audio)) {
      ok(
        path.basename(audio, path.extname(audio)) === path.basename(video, path.extname(video)),
        '音频与视频同名（在文件夹中成对出现）'
      );
      ok(fs.statSync(audio).size > 10 * 1024, `音频有实际内容（${(fs.statSync(audio).size / 1024).toFixed(0)} KB）`);
      const pa = probeAudio(audio, ff);
      ok(pa.has, '音频文件本身含音频轨', pa.line);
      const da = canDecodeAudio(audio, ff);
      ok(da.ok, '音频文件可被正常解码', da.err);
    }
    const files = fs.readdirSync(dir).sort();
    console.log(`    目录内容: ${JSON.stringify(files)}`);
  } catch (err) {
    ok(false, 'T7 流程', `${err.message} | status=${it() && it().status} error=${it() && it().error}`);
  }
  q.clear('all');
}

// ---------- 测试 8：文件名模板 + 字幕下载 ----------
async function testSubtitlesAndNaming() {
  section('T8 文件名模板（标题 + 上传日期）与字幕下载');
  const VID = '5mU6SRS2Bxo';
  const dir = path.join(DL, 'subs');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  settingsStore.save({
    outputDir: dir,
    rateLimit: '',
    skipDownloaded: false,
    autoRetry: 0,
    embedMetadata: false,
    concurrency: 1,
    alsoAudio: false,
    videoCodec: 'quality',
    writeSubs: true,
    writeAutoSubs: true,
    // 默认只取原生英文；这里额外带上 zh-Hans 作为「翻译轨被限流也不能拖垮视频」的回归验证
    subLangs: 'en,zh-Hans',
    subFormat: 'srt',
    embedSubs: false,
    filenameTemplate: settingsStore.DEFAULT_FILENAME_TEMPLATE,
  });

  const q = freshQueue();
  q.add(
    [{ id: VID, title: 'subs-test', url: `https://www.youtube.com/watch?v=${VID}`, section: 'videos' }],
    { quality: '360', audioOnly: false, outputDir: dir, writeSubs: true, alsoAudio: false }
  );

  const it = () => q.items.get(VID);
  try {
    await waitFor(() => it() && ['done', 'error', 'skipped'].includes(it().status), 300000, '下载结束');
    ok(it().status === 'done', `下载成功（${it().status}）`, it().error);

    const name = path.basename(it().filePath || '');
    console.log(`    成品文件名: ${name}`);
    ok(/\[\d{4}-\d{2}-\d{2}\]\.[a-z0-9]+$/i.test(name), '文件名符合「标题 [YYYY-MM-DD]」', name);
    ok(/^World/.test(name), '保留了原视频 Title');
    ok(!/\[[A-Za-z0-9_-]{11}\]/.test(name), '文件名里不再有视频 ID（精简）');

    // 字幕是视频落地后的独立步骤，必须等它跑完再断言（否则读到的是空集）
    await waitFor(
      () => it() && !it().fetchingSubs && (it().subPaths.length > 0 || it().subError),
      180000,
      '字幕抓取结束'
    );
    // 核心回归点：即使有语言被限流，视频本身也必须是 done
    ok(it().status === 'done', '字幕部分失败时视频仍为 done（不被拖垮）');
    if (it().subError) console.log(`    （字幕接口报错：${it().subError}）`);

    ok(it().subPaths.length > 0, `至少抓到一种语言的字幕（${it().subPaths.length} 个）`);
    it().subPaths.forEach((p) => console.log('      · ' + path.basename(p)));
    const base = path.basename(it().filePath, path.extname(it().filePath));
    ok(
      it().subPaths.every((p) => path.basename(p).startsWith(base + '.')),
      '字幕与视频同名（在同一目录成对出现）'
    );
    ok(it().subPaths.some((p) => /\.srt$/i.test(p)), '字幕为 .srt 格式');
    ok(
      it().subPaths.some((p) => /\.en\./i.test(path.basename(p))),
      '包含原生语言字幕 (en)'
    );
    // 翻译轨能不能拿到取决于 YouTube 限流，不做硬断言，只报告
    const hasZh = it().subPaths.some((p) => /zh-Hans/i.test(path.basename(p)));
    console.log(`    zh-Hans 翻译轨: ${hasZh ? '已获取' : '未获取（YouTube 对翻译轨限流，属预期）'}`);
    console.log(`    目录内容: ${JSON.stringify(fs.readdirSync(dir).sort())}`);
  } catch (err) {
    ok(false, 'T8 流程', `${err.message} | status=${it() && it().status} error=${it() && it().error}`);
  }
  q.clear('all');
}

// ---------- 测试 5：错误处理 ----------
async function testErrors() {
  section('T5 错误处理与边界');
  const bin = paths.ytDlpPath(settingsStore.load());

  const bad = await channel.enumerateChannel(bin, 'https://www.youtube.com/@this-channel-does-not-exist-xyz123', {
    maxItems: 5,
  });
  ok(!bad.ok, '不存在的频道返回失败而不是崩溃', bad.ok ? '竟然成功了' : String(bad.error).slice(0, 90));

  const q = freshQueue();
  q.add(
    [
      {
        id: 'upcoming-test',
        title: 'upcoming',
        url: 'https://www.youtube.com/watch?v=dummy',
        section: 'live',
        liveStatus: 'is_upcoming',
      },
    ],
    {}
  );
  await sleep(600);
  const it = q.items.get('upcoming-test');
  ok(it && it.status === 'error' && /尚未开播/.test(it.error), '未开播直播被正确拒绝并给出提示');
  q.remove('upcoming-test');
}

// ---------- 测试 6：部分流已存在时的续传判定（回归） ----------
async function testPartialStreamResume() {
  section('T6 续传时「部分流已存在」不应误判为跳过（回归测试）');
  const VID = '5mU6SRS2Bxo';
  const bin = paths.ytDlpPath(settingsStore.load());
  const dir = path.join(DL, 'partial');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // 制造场景：完整下载一次并保留中间分片（-k），
  // 然后删掉成品 + 只留下其中一路分片 —— 这样重下时就会有一路「已存在」、另一路需要下载，
  // 正是当初把整单误判为 skipped 的真实场景。
  // 必须与队列实际使用的模板一致，否则 yt-dlp 生成的分片文件名对不上，
  // 就构造不出「某一路已存在」的场景（踩坑：这里曾写死旧模板导致测试失败）
  const tmpl = settingsStore.DEFAULT_FILENAME_TEMPLATE;
  const first = await ytdlp.run(
    bin,
    ytdlp.BASE_FLAGS.concat([
      '-f',
      // 必须与实际队列用到的格式串完全一致，否则 yt-dlp 选到的流不同，
      // 就构造不出「某一路已存在」的场景（测试会假通过）
      buildFormat({ quality: '360', videoCodec: 'quality' }),
      '--merge-output-format',
      'mp4',
      '-k',
      '-P',
      dir,
      '-o',
      tmpl,
      `https://www.youtube.com/watch?v=${VID}`,
    ])
  );
  const all = fs.readdirSync(dir);
  const isStream = (f) => /\.[fF][\w-]*\.(webm|mp4|m4a|opus|aac)$/.test(f);
  const merged = all.find((f) => f.endsWith('.mp4') && !isStream(f));
  const streams = all.filter(isStream);
  ok(
    first.code === 0 && merged && streams.length >= 2,
    '构造出「成品 + 两路分片」的初始状态',
    JSON.stringify(all)
  );
  if (merged) fs.unlinkSync(path.join(dir, merged));
  streams.slice(1).forEach((f) => fs.unlinkSync(path.join(dir, f)));
  const kept = fs.readdirSync(dir);
  ok(kept.length === 1 && isStream(kept[0]), '删掉成品，只保留一路分片', JSON.stringify(kept));

  // 再走完整队列下载：视频流会被 yt-dlp 判定为已下载，音频需要下载并合并
  settingsStore.save({
    outputDir: dir,
    rateLimit: '',
    skipDownloaded: false,
    autoRetry: 0,
    embedMetadata: false,
    concurrency: 1,
    writeSubs: false,
  });
  const q = freshQueue();
  q.add(
    [{ id: VID, title: 'partial', url: `https://www.youtube.com/watch?v=${VID}`, section: 'videos' }],
    { quality: '360', audioOnly: false, outputDir: dir }
  );

  try {
    await waitFor(
      () => {
        const it = q.items.get(VID);
        return it && ['done', 'skipped', 'error'].includes(it.status);
      },
      240000,
      '下载结束'
    );
    const it = q.items.get(VID);
    ok(
      it.alreadyDownloaded === true,
      '本轮确实触发了「某一路已存在」——场景复现成功',
      `alreadyDownloaded=${it.alreadyDownloaded}`
    );
    ok(it.status === 'done', `状态应为 done（实际 ${it.status}）— 不能因为一路已存在就整单跳过`, it.error);
    const files = fs.readdirSync(dir);
    ok(
      files.some((f) => f.endsWith('.mp4') && !isStream(f)),
      '产出合并后的成品 mp4',
      JSON.stringify(files)
    );
    const withBytes = Object.values(it._files || {}).filter((f) => f.downloaded > 0).length;
    console.log(`    _files 统计：${withBytes} 路有实际下载量，最终状态=${it.status}`);
  } catch (err) {
    const it = q.items.get(VID);
    ok(false, '部分流续传流程', `${err.message} | status=${it && it.status} error=${it && it.error}`);
  }
  q.clear('all');
}

// ---------- 主流程 ----------
(async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(DL, { recursive: true });
  // 集成测试不触发大模型（学习文档由 tools/study-cli.js 单独验证）
  settingsStore.save({ studyDoc: false });
  console.log(`临时目录: ${TMP}`);
  console.log(`模式: ${QUICK ? 'QUICK（单频道/少量条目，日常验证用）' : 'FULL（完整枚举，发版前用）'}`);

  testDefaultOutputDir();
  testParseTarget();
  await testEnumerate();
  await testDownload();
  await testResume();
  await testPartialStreamResume();
  await testVideoHasAudioAndSidecarAudio();
  await testSubtitlesAndNaming();
  await testErrors();

  section('汇总');
  console.log(`  通过 ${pass} / 失败 ${fail}`);
  if (failures.length) {
    console.log('  失败项：');
    failures.forEach((f) => console.log('   - ' + f));
  }
  // 清理可能残留的进程
  try {
    require('child_process').execSync('taskkill /IM yt-dlp.exe /F', { stdio: 'ignore', windowsHide: true });
  } catch (_) {}
  process.exit(fail > 0 ? 1 : 0);
})();
