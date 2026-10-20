// Generates build/icon.png (256x256) — a pixel character at a monitor — without extra deps.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const G = [
  '................',
  '..############..',
  '..#oooooooooo#..',
  '..#ogggggggbo#..',
  '..#oyyyoooooo#..',
  '..#ogggbbooo.#..',
  '..############..',
  '.......##.......',
  '.....hhhhhh.....',
  '....hhhhhhhh....',
  '....hhhhhhhh....',
  '....shhhhhhs....',
  '...ccccccccccc..',
  '...ccccccccccc..',
  '...ccccccccccc..',
  '................',
];
const C = {
  '.': [0, 0, 0, 0], '#': [42, 42, 53, 255], o: [22, 35, 61, 255], g: [95, 211, 141, 255],
  b: [122, 167, 255, 255], y: [255, 200, 87, 255], h: [43, 29, 22, 255], s: [245, 207, 166, 255],
  c: [217, 119, 87, 255],
};
const N = 256, K = N / 16;
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    const px = C[G[Math.floor(y / K)][Math.floor(x / K)]];
    px.forEach((v, i) => { raw[y * (N * 4 + 1) + 1 + x * 4 + i] = v; });
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
