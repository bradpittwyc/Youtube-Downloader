'use strict';
/**
 * 生成应用图标（多尺寸 .ico）。
 *
 * 素材是官方 YouTube logo（build/youtube-logo.png，640×443，带透明通道）。
 * 它是宽高比 1.44:1 的横长方形，而应用图标必须是正方形，
 * 所以按比例缩放到目标宽度后**居中放进透明画布**，而不是拉伸变形。
 *
 * 缩放/补边交给内置的 ffmpeg（有 lanczos 重采样，边缘干净），
 * 本脚本只负责把各尺寸 PNG 打包成 ICO —— 不引入任何图像库。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FF = path.join(ROOT, 'resources', 'bin', 'ffmpeg.exe');
const LOGO = path.join(ROOT, 'build', 'youtube-logo.png');
const BUILD = path.join(ROOT, 'build');
const TMP = path.join(require('os').tmpdir(), 'icon-build');

/** 图标四周留白比例：官方 logo 本身没有留白，直接铺满正方形会显得太挤 */
const PAD_RATIO = 0.045;
const SIZES = [16, 24, 32, 48, 64, 128, 256];

if (!fs.existsSync(LOGO)) {
  console.error('缺少素材: ' + LOGO);
  process.exit(1);
}
if (!fs.existsSync(FF)) {
  console.error('缺少 ffmpeg: ' + FF);
  process.exit(1);
}

/** 用 ffmpeg 读出图片尺寸 */
function probeSize(file) {
  const r = spawnSync(FF, ['-hide_banner', '-i', file], { encoding: 'utf8', windowsHide: true });
  const m = ((r.stderr || '') + (r.stdout || '')).match(/Video:[\s\S]*?,\s*(\d{2,5})x(\d{2,5})/);
  if (!m) throw new Error('读不出图片尺寸: ' + file);
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

/** 把 logo 缩放到目标尺寸并居中放进透明正方形画布 */
function renderSize(size) {
  const src = probeSize(LOGO);
  const logoS = Math.max(1, Math.round(size * (1 - PAD_RATIO * 2)));
  const logoH = Math.max(1, Math.round((logoS * src.height) / src.width));
  const x = Math.round((size - logoS) / 2);
  const y = Math.round((size - logoH) / 2);
  const out = path.join(TMP, `icon-${size}.png`);
  const vf = [
    'format=rgba',
    `scale=${logoS}:${logoH}:flags=lanczos`,
    `pad=${size}:${size}:${x}:${y}:color=0x00000000`,
  ].join(',');
  const r = spawnSync(
    FF,
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', LOGO, '-vf', vf, '-pix_fmt', 'rgba', '-frames:v', '1', out],
    { windowsHide: true }
  );
  if (r.status !== 0) throw new Error(`渲染 ${size}px 失败: ` + String(r.stderr));
  return fs.readFileSync(out);
}

// ---------------------------------------------------------------- ICO 打包

function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = ICO
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size; // 0 表示 256
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// ---------------------------------------------------------------- 主流程

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(BUILD, { recursive: true });

const src = probeSize(LOGO);
console.log(`素材: ${path.basename(LOGO)}  ${src.width}x${src.height}  (宽高比 ${(src.width / src.height).toFixed(3)})`);

const entries = SIZES.map((size) => ({ size, png: renderSize(size) }));
fs.writeFileSync(path.join(BUILD, 'icon.ico'), buildIco(entries));
fs.writeFileSync(path.join(BUILD, 'icon.png'), entries[entries.length - 1].png);
fs.writeFileSync(path.join(BUILD, 'icon-512.png'), renderSize(512));

console.log('');
console.log('已生成:');
for (const f of ['icon.ico', 'icon.png', 'icon-512.png']) {
  const p = path.join(BUILD, f);
  console.log(`  build/${f.padEnd(14)} ${(fs.statSync(p).size / 1024).toFixed(1)} KB`);
}
console.log(`  （.ico 含 ${SIZES.join(' / ')} 共 ${SIZES.length} 个尺寸）`);
