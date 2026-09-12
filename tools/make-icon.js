'use strict';
/**
 * 生成 YouTube 原版风格的图标（.png + 多尺寸 .ico）。
 *
 * 原版 logo 的形状是「纯红圆角矩形 + 白色播放三角」，宽高比约 1.43:1，
 * 而不是常见的「圆角方块 + 三角」。
 *
 * 纯手写像素渲染 + 4 倍超采样做抗锯齿，然后自己编码 PNG、再打包成 ICO —
 * 这样不依赖任何图像库（项目里没有 sharp / canvas，也不该为一张图标引入）。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RED = [255, 0, 0]; // YouTube 品牌红
const WHITE = [255, 255, 255];

/** 有向距离：圆角矩形（<0 在内部） */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 有向距离：指向右的三角形（三个顶点） */
function sdTriangle(px, py, a, b, c) {
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1];
  const len = (u) => Math.sqrt(dot(u, u));
  const p = [px, py];
  const e0 = sub(b, a), e1 = sub(c, b), e2 = sub(a, c);
  const v0 = sub(p, a), v1 = sub(p, b), v2 = sub(p, c);
  const p0 = sub(v0, [e0[0] * Math.min(Math.max(dot(v0, e0) / dot(e0, e0), 0), 1), e0[1] * Math.min(Math.max(dot(v0, e0) / dot(e0, e0), 0), 1)]);
  const p1 = sub(v1, [e1[0] * Math.min(Math.max(dot(v1, e1) / dot(e1, e1), 0), 1), e1[1] * Math.min(Math.max(dot(v1, e1) / dot(e1, e1), 0), 1)]);
  const p2 = sub(v2, [e2[0] * Math.min(Math.max(dot(v2, e2) / dot(e2, e2), 0), 1), e2[1] * Math.min(Math.max(dot(v2, e2) / dot(e2, e2), 0), 1)]);
  const d = Math.min(len(p0) * Math.sign(v0[0] * e0[1] - v0[1] * e0[0]), len(p1) * Math.sign(v1[0] * e1[1] - v1[1] * e1[0]), len(p2) * Math.sign(v2[0] * e2[1] - v2[1] * e2[0]));
  const inside = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0 &&
                 (c[0] - b[0]) * (p[1] - b[1]) - (c[1] - b[1]) * (p[0] - b[0]) >= 0 &&
                 (a[0] - c[0]) * (p[1] - c[1]) - (a[1] - c[1]) * (p[0] - c[0]) >= 0;
  // 简化：用「重心坐标」判断内外，距离只对边缘近似
  void inside;
  return d;
}

/** 三角形内外（重心法，稳妥） */
function inTriangle(px, py, a, b, c) {
  const d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1]);
  const d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (py - c[1]);
  const d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1]);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * 渲染一张 size×size 的 RGBA 像素图。
 * 内部按 SS 倍超采样后再平均，得到平滑边缘。
 */
function render(size, ss) {
  const S = size * ss;
  const out = Buffer.alloc(size * size * 4, 0);
  const acc = new Float32Array(size * size * 4);

  // 几何：红色圆角矩形（宽高比 1.43），白色播放三角居中
  // 参数对齐官方 logo 的 SVG 几何（rect 546×384、圆角约 0.18 高、三角高 0.42 高、宽高比 0.88）
  const margin = S * 0.045;
  const rectW = S - margin * 2;
  const rectH = rectW / 1.43;
  const cx = S / 2;
  const cy = S / 2;
  const hw = rectW / 2;
  const hh = rectH / 2;
  const radius = rectH * 0.18;

  // 三角：高约矩形高的 42%，顶点朝右，整体略微右移（官方也是偏右约 0.1 个三角宽）
  const triH = rectH * 0.42;
  const triW = triH * 0.88;
  const tx = cx - triW / 2 + triW * 0.10;
  const A = [tx, cy - triH / 2];
  const B = [tx, cy + triH / 2];
  const C = [tx + triW, cy];

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      // 红色圆角矩形
      if (sdRoundRect(px, py, cx, cy, hw, hh, radius) <= 0) {
        const white = inTriangle(px, py, A, B, C);
        const c = white ? WHITE : RED;
        const ox = Math.floor(x / ss);
        const oy = Math.floor(y / ss);
        const i = (oy * size + ox) * 4;
        acc[i] += c[0];
        acc[i + 1] += c[1];
        acc[i + 2] += c[2];
        acc[i + 3] += 255;
      }
    }
  }
  const n = ss * ss;
  for (let i = 0; i < size * size * 4; i++) out[i] = Math.round(acc[i] / n);
  return out;
}

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- ICO 打包

function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
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

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });

const entries = SIZES.map((size) => {
  const ss = size <= 32 ? 8 : 4; // 小尺寸用更高倍超采样，边缘才干净
  const rgba = render(size, ss);
  return { size, png: encodePng(rgba, size), rgba };
});

fs.writeFileSync(path.join(buildDir, 'icon.ico'), buildIco(entries));

// 预览用的大图 + Electron 里可能用到的 png
const big = entries.find((e) => e.size === 256);
fs.writeFileSync(path.join(buildDir, 'icon.png'), big.png);
// 额外存一张 512 供查看细节
fs.writeFileSync(path.join(buildDir, 'icon-512.png'), encodePng(render(512, 2), 512));

console.log('已生成:');
console.log('  build/icon.ico     ', (fs.statSync(path.join(buildDir, 'icon.ico')).size / 1024).toFixed(1) + ' KB',
  `(${SIZES.join(', ')} 共 ${SIZES.length} 个尺寸)`);
console.log('  build/icon.png     ', (fs.statSync(path.join(buildDir, 'icon.png')).size / 1024).toFixed(1) + ' KB');
console.log('  build/icon-512.png ', (fs.statSync(path.join(buildDir, 'icon-512.png')).size / 1024).toFixed(1) + ' KB');
