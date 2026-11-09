import { deflateSync } from 'node:zlib';

const CAPTCHA_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(character => !['I', 'O'].includes(character));
export const CAPTCHA_ALPHABET = [...CAPTCHA_LETTERS, '2', '3', '4', '5', '6', '7', '8', '9'].join('');

// 5x7 bitmap glyphs; ambiguous characters (0/O, 1/I) are excluded by the caller.
const GLYPHS = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100']
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function encodePng(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const target = y * (width * 4 + 1);
    rows[target] = 0;
    pixels.copy(rows, target + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

export function renderCaptcha(text, { width = 190, height = 60 } = {}) {
  const pixels = Buffer.alloc(width * height * 4);
  const paint = (x, y, red, green, blue) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    pixels[offset] = red;
    pixels[offset + 1] = green;
    pixels[offset + 2] = blue;
    pixels[offset + 3] = 255;
  };
  const blend = (x, y, red, green, blue, alpha) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    pixels[offset] = Math.round(pixels[offset] * (1 - alpha) + red * alpha);
    pixels[offset + 1] = Math.round(pixels[offset + 1] * (1 - alpha) + green * alpha);
    pixels[offset + 2] = Math.round(pixels[offset + 2] * (1 - alpha) + blue * alpha);
    pixels[offset + 3] = 255;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const warmth = Math.round(8 * (x / width) + Math.random() * 5);
      paint(x, y, 247 - warmth, 245 - warmth, 238 - warmth);
    }
  }
  for (let index = 0; index < 240; index++) {
    const shade = 120 + Math.floor(Math.random() * 80);
    blend(Math.floor(Math.random() * width), Math.floor(Math.random() * height), shade, shade, shade, 0.16);
  }
  for (let lineIndex = 0; lineIndex < 4; lineIndex++) {
    const amplitude = 4 + Math.random() * 7;
    const phase = Math.random() * Math.PI * 2;
    const base = 10 + Math.random() * (height - 20);
    const color = [70 + Math.random() * 70, 70 + Math.random() * 60, 80 + Math.random() * 70];
    for (let x = 0; x < width; x++) {
      const y = Math.round(base + Math.sin(x / 17 + phase) * amplitude);
      blend(x, y, ...color, 0.34);
      blend(x, y + 1, ...color, 0.16);
    }
  }

  const scale = 4;
  for (let index = 0; index < text.length; index++) {
    const glyph = GLYPHS[text[index]];
    if (!glyph) throw new Error(`Missing captcha glyph: ${text[index]}`);
    const baseX = 14 + index * 28 + Math.floor(Math.random() * 5) - 2;
    const baseY = Math.round((height - 7 * scale) / 2) + Math.floor(Math.random() * 7) - 3;
    const tone = 42 + Math.floor(Math.random() * 38);
    const color = [tone, tone + Math.floor(Math.random() * 12), tone + 16];
    for (let row = 0; row < 7; row++) {
      for (let column = 0; column < 5; column++) {
        if (glyph[row][column] !== '1') continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const wave = Math.round(Math.sin((row * scale + dy) / 4.5 + index) * 1.6);
            const shear = Math.round((column * scale + dx) * 0.12);
            paint(baseX + column * scale + dx + wave, baseY + row * scale + dy + shear, ...color);
          }
        }
      }
    }
  }
  return encodePng(width, height, pixels);
}
