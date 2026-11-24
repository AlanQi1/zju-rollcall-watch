// 生成应用图标 build/icon.ico（纯 Node 内置 zlib，无第三方图形依赖）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(root, 'build', 'icon.ico');

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function renderPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const rOuter = size * 0.46;
  const rInner = size * 0.31;

  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter None
    for (let x = 0; x < size; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      const idx = row + 1 + x * 4;
      if (dist > rOuter + 1) continue;

      const edgeAlpha = dist <= rOuter ? 1 : Math.max(0, 1 - (dist - rOuter));
      // 渐层浙大蓝雷达底圆 (#1453D1 -> #2A7BF6)
      const grad = (x + y) / (2 * size);
      let r = Math.round(20 + grad * 22);
      let g = Math.round(83 + grad * 40);
      let b = Math.round(209 + grad * 37);

      // 细雷达环
      const ringDist = Math.abs(dist - rInner);
      if (ringDist < Math.max(1.1, size * 0.016)) {
        const blend = 0.28 * (1 - ringDist / Math.max(1.1, size * 0.016));
        r = Math.round(r + (255 - r) * blend);
        g = Math.round(g + (255 - g) * blend);
        b = Math.round(b + (255 - b) * blend);
      }

      // 居中白色对勾
      const nx = x / size;
      const ny = y / size;
      const thickness = 0.056;
      const seg1 = distToSegment(nx, ny, 0.28, 0.52, 0.44, 0.68);
      const seg2 = distToSegment(nx, ny, 0.44, 0.68, 0.74, 0.35);
      const checkDist = Math.min(seg1, seg2);
      if (checkDist < thickness + 0.015) {
        const w = checkDist <= thickness ? 1 : Math.max(0, 1 - (checkDist - thickness) / 0.015);
        r = Math.round(r + (255 - r) * w);
        g = Math.round(g + (255 - g) * w);
        b = Math.round(b + (255 - b) * w);
      }

      raw[idx] = r;
      raw[idx + 1] = g;
      raw[idx + 2] = b;
      raw[idx + 3] = Math.round(255 * edgeAlpha);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * vx + (py - y1) * vy) / len2));
  return Math.hypot(px - (x1 + t * vx), py - (y1 + t * vy));
}

const sizes = [256, 64, 48, 32, 16];
const images = sizes.map((size) => ({ size, data: renderPng(size) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);

const entries = [];
let offset = 6 + images.length * 16;
for (const img of images) {
  const entry = Buffer.alloc(16);
  entry[0] = img.size >= 256 ? 0 : img.size;
  entry[1] = img.size >= 256 ? 0 : img.size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(img.data.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += img.data.length;
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
console.log('Generated icon:', outFile);
