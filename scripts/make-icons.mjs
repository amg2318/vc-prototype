// Generates the PWA / home-screen PNG icons without any image library:
// a pressure-tapered brush stroke on a dark rounded background, rendered with
// 4×4 supersampling and written as PNG via zlib. Run: node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [43, 43, 46];
const PAPER = [250, 250, 248];
const INK = [20, 20, 26];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgb) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Stroke: an S-curve of dabs whose radius follows a pressure bell curve (unit coords 0..1).
const dabs = [];
for (let i = 0; i <= 400; i++) {
  const t = i / 400;
  dabs.push({ x: 0.22 + 0.56 * t, y: 0.5 + 0.16 * Math.sin(t * Math.PI * 2 + Math.PI), r: 0.008 + 0.055 * Math.sin(t * Math.PI) ** 0.8 });
}

/** `paper` = inset (0..0.5) of the white document card; maskable icons use a larger one. */
function render(size, paperInset) {
  const out = Buffer.alloc(size * size * 3);
  const SS = 4;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let acc = [0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const x = (px + (sx + 0.5) / SS) / size, y = (py + (sy + 0.5) / SS) / size;
      let c = BG;
      const inPaper = x > paperInset && x < 1 - paperInset && y > paperInset && y < 1 - paperInset;
      if (inPaper) {
        c = PAPER;
        for (const d of dabs) if ((x - d.x) ** 2 + (y - d.y) ** 2 < d.r * d.r) { c = INK; break; }
      }
      acc = acc.map((v, i) => v + c[i]);
    }
    acc.forEach((v, i) => (out[(py * size + px) * 3 + i] = Math.round(v / (SS * SS))));
  }
  return png(size, out);
}

const targets = [
  ['public/icons/apple-touch-icon.png', 180, 0.12],
  ['public/icons/icon-192.png', 192, 0.12],
  ['public/icons/icon-512.png', 512, 0.12],
  ['public/icons/icon-maskable-512.png', 512, 0.2],
];
for (const [path, size, inset] of targets) {
  writeFileSync(path, render(size, inset));
  console.log('wrote', path);
}
