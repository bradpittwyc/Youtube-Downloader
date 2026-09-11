'use strict';
/**
 * 学习文档 CLI：不启动 Electron，直接跑完整链路，用于开发验证。
 *   node tools/study-cli.js --srt <.en.srt> [--video <video.mp4>] [--out-dir <dir>] [--estimate]
 */
const fs = require('fs');
const path = require('path');
const study = require('../src/main/study');

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--srt') a.srt = argv[++i];
    else if (k === '--video') a.video = argv[++i];
    else if (k === '--out-dir') a.outDir = argv[++i];
    else if (k === '--estimate') a.estimate = true;
    else if (k === '--no-srt') a.noSrt = true;
    else if (k === '--no-docx') a.noDocx = true;
  }
  return a;
}

function loadLlm() {
  const file = path.join(__dirname, 'probe.config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    studyBaseURL: cfg.baseURL,
    studyApiKey: cfg.apiKey,
    studyModel: cfg.model,
    studyTemperature: cfg.temperature != null ? cfg.temperature : 0.2,
    studyConcurrency: 3,
    studyMaxSegCues: 45,
    studyIncludePureEnglish: true,
    studyIncludeVocab: true,
    studyTimecode: true,
  };
}

(async function main() {
  const args = parseArgs(process.argv);
  if (!args.srt || !fs.existsSync(args.srt)) {
    console.error('用法: node tools/study-cli.js --srt <.en.srt> [--video x.mp4] [--out-dir dir] [--estimate]');
    process.exit(1);
  }
  const settings = loadLlm();

  if (args.estimate) {
    const e = study.estimateFor(args.srt, settings);
    console.log('预估（仅供参考，实际以 API 返回为准）:');
    console.log('  清洗后条目', e.stats.final, '  词数', e.stats.words);
    console.log('  输入 token ≈', e.inputTokens, ' 输出 token ≈', e.outputTokens);
    return;
  }

  console.log('开始: ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }));
  let lastPhase = '';
  const t0 = Date.now();
  const res = await study.generateForVideo({
    srtPath: args.srt,
    videoPath: args.video || args.srt.replace(/\.en\.srt$/i, '.mp4'),
    meta: {
      title: args.video ? path.basename(args.video).replace(/\.[^.]+$/, '') : '验证视频',
      channel: '验证用',
      durationMs: 0,
      url: '',
    },
    settings,
    writeBilingualSrt: !args.noSrt,
    writeDocx: !args.noDocx,
    onProgress: (p) => {
      if (p.phase !== lastPhase) {
        lastPhase = p.phase;
        console.log(`  [${p.phase}] ${p.label || ''}`);
      }
      if (p.phase === 'translate' && p.done % 5 === 0) {
        process.stdout.write(`\r    进度 ${p.done}/${p.total}   `);
      }
    },
  });

  // 输出到指定目录（默认与字幕同目录）
  if (args.outDir) {
    fs.mkdirSync(args.outDir, { recursive: true });
    for (const key of ['bilingualSrt', 'docx']) {
      const p = res.paths[key];
      if (!p) continue;
      const dest = path.join(args.outDir, path.basename(p));
      fs.renameSync(p, dest);
      res.paths[key] = dest;
    }
  }

  console.log('\n完成: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('  ' + res.summary);
  console.log('  分段', res.segments.length, ' 词汇', res.vocab.length, ' 长难句', res.segments.reduce((s, x) => s + x.notes.length, 0));
  if (res.failed.length) console.log('  失败段:', res.failed.map((f) => f.topic).join(', '));
  for (const [k, v] of Object.entries(res.paths)) {
    if (v) console.log(`  ${k}: ${v}  (${(fs.statSync(v).size / 1024).toFixed(1)} KB)`);
  }
})().catch((err) => {
  console.error('失败:', err && err.message ? err.message : err);
  process.exit(1);
});
