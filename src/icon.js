// Draws the app icon (a little yellow duck on a deep teal tile) as a PNG, so no image file is needed in the project.
// TonConnect wallets show this icon when the player connects a wallet.
import zlib from "node:zlib";

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const cache = new Map();
export function iconPng(size = 180) {
  if (cache.has(size)) return cache.get(size);
  const SS = 3; // 3x3 samples per pixel for smooth edges
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const rr = size * 0.22; // corner radius of the tile
  const insideTile = (x, y) => {
    const dx = Math.max(Math.abs(x - size / 2) - (size / 2 - rr), 0);
    const dy = Math.max(Math.abs(y - size / 2) - (size / 2 - rr), 0);
    return dx * dx + dy * dy <= rr * rr;
  };
  const inCircle = (u, v, cx, cy, r) => (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
  const inBeak = (u, v) => u >= 0.64 && u <= 0.86 && Math.abs(v - 0.5) <= 0.075 * (1 - (u - 0.64) / 0.22) + 0.02;
  for (let py = 0; py < size; py++) {
    const row = py * (size * 4 + 1);
    raw[row] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          if (!insideTile(x, y)) continue;
          const u = x / size, v = y / size;
          const t = (u + v) / 2;
          let col = [14 + 8 * t, 66 - 14 * t, 78 - 16 * t]; // teal gradient tile
          if (inCircle(u, v, 0.45, 0.82, 0.2) || inCircle(u, v, 0.22, 0.66, 0.1)) col = [247, 190, 40]; // body + tail
          if (inCircle(u, v, 0.5, 0.46, 0.27)) col = [255, 205, 56]; // head
          if (inCircle(u, v, 0.5, 0.46, 0.27) && !inCircle(u, v, 0.5, 0.46, 0.245)) col = [255, 226, 130]; // light rim
          if (inBeak(u, v)) col = [255, 128, 40]; // beak
          if (inCircle(u, v, 0.56, 0.4, 0.045)) col = [255, 255, 255]; // eye
          if (inCircle(u, v, 0.575, 0.4, 0.022)) col = [16, 24, 30]; // pupil
          r += col[0]; g += col[1]; b += col[2]; a += 255;
        }
      }
      const n = SS * SS, i = row + 1 + px * 4;
      const cov = a / 255;
      raw[i] = cov ? Math.round(r / cov) : 0;
      raw[i + 1] = cov ? Math.round(g / cov) : 0;
      raw[i + 2] = cov ? Math.round(b / cov) : 0;
      raw[i + 3] = Math.round(a / n);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bit, RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  cache.set(size, png);
  return png;
}
