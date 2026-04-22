const fs = require("node:fs");
const path = require("node:path");

const OUTPUT_DIR = path.join(__dirname, "..", "build");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "icon.ico");
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SCALE = 4;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function mixColor(a, b, t) {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
    Math.round(lerp(a[3], b[3], t))
  ];
}

function putPixel(image, width, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= width) {
    return;
  }
  const index = (y * width + x) * 4;
  const alpha = color[3] / 255;
  const inv = 1 - alpha;
  image[index] = Math.round(color[0] * alpha + image[index] * inv);
  image[index + 1] = Math.round(color[1] * alpha + image[index + 1] * inv);
  image[index + 2] = Math.round(color[2] * alpha + image[index + 2] * inv);
  image[index + 3] = Math.min(255, Math.round(color[3] + image[index + 3] * inv));
}

function pointInRoundRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius, Math.min(x, right - radius));
  const cy = Math.max(top + radius, Math.min(y, bottom - radius));
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function pointInPoly(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i][0];
    const yi = points[i][1];
    const xj = points[j][0];
    const yj = points[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function fillRoundRect(image, width, left, top, right, bottom, radius, colorForPoint) {
  for (let y = Math.floor(top); y < Math.ceil(bottom); y += 1) {
    for (let x = Math.floor(left); x < Math.ceil(right); x += 1) {
      if (pointInRoundRect(x + 0.5, y + 0.5, left, top, right, bottom, radius)) {
        putPixel(image, width, x, y, colorForPoint(x, y));
      }
    }
  }
}

function fillRect(image, width, left, top, right, bottom, color) {
  fillRoundRect(image, width, left, top, right, bottom, 1.5 * SCALE, () => color);
}

function fillPoly(image, width, points, color) {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const left = Math.floor(Math.min(...xs));
  const right = Math.ceil(Math.max(...xs));
  const top = Math.floor(Math.min(...ys));
  const bottom = Math.ceil(Math.max(...ys));
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (pointInPoly(x + 0.5, y + 0.5, points)) {
        putPixel(image, width, x, y, color);
      }
    }
  }
}

function drawGlyphs(image, width, size) {
  if (size < 32) {
    return;
  }

  const unit = width / 64;
  const left = width * 0.18;
  const top = width * 0.18;
  const stroke = Math.max(2 * SCALE, unit * 3.6);
  const height = width * 0.22;
  const hWidth = width * 0.17;
  const gap = width * 0.045;
  const color = [255, 255, 255, 226];

  fillRect(image, width, left, top, left + stroke, top + height, color);
  fillRect(image, width, left + hWidth, top, left + hWidth + stroke, top + height, color);
  fillRect(image, width, left, top + height * 0.43, left + hWidth + stroke, top + height * 0.43 + stroke, color);

  const fLeft = left + hWidth + stroke + gap;
  fillRect(image, width, fLeft, top, fLeft + stroke, top + height, color);
  fillRect(image, width, fLeft, top, fLeft + hWidth, top + stroke, color);
  fillRect(image, width, fLeft, top + height * 0.45, fLeft + hWidth * 0.82, top + height * 0.45 + stroke, color);
}

function renderSize(size) {
  const width = size * SCALE;
  const image = new Uint8Array(width * width * 4);
  const margin = width * 0.07;
  const radius = width * 0.2;
  const teal = [7, 136, 121, 255];
  const blue = [62, 91, 190, 255];
  const violet = [120, 88, 215, 255];

  fillRoundRect(image, width, margin, margin, width - margin, width - margin, radius, (x, y) => {
    const t = Math.min(1, Math.max(0, (x + y) / (width * 1.72)));
    const first = mixColor(teal, blue, t);
    return mixColor(first, violet, Math.max(0, t - 0.55) * 0.8);
  });

  fillRoundRect(image, width, width * 0.12, width * 0.12, width * 0.88, width * 0.88, radius * 0.72, () => [
    255,
    255,
    255,
    22
  ]);

  drawGlyphs(image, width, size);

  const arrow = [255, 255, 255, 242];
  fillRect(image, width, width * 0.45, width * 0.34, width * 0.55, width * 0.61, arrow);
  fillPoly(
    image,
    width,
    [
      [width * 0.29, width * 0.55],
      [width * 0.71, width * 0.55],
      [width * 0.5, width * 0.76]
    ],
    arrow
  );
  fillRect(image, width, width * 0.28, width * 0.78, width * 0.72, width * 0.85, [255, 255, 255, 225]);

  return downsample(image, width, SCALE);
}

function downsample(image, highWidth, scale) {
  const width = highWidth / scale;
  const output = new Uint8Array(width * width * 4);
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sum = [0, 0, 0, 0];
      for (let yy = 0; yy < scale; yy += 1) {
        for (let xx = 0; xx < scale; xx += 1) {
          const index = ((y * scale + yy) * highWidth + x * scale + xx) * 4;
          sum[0] += image[index];
          sum[1] += image[index + 1];
          sum[2] += image[index + 2];
          sum[3] += image[index + 3];
        }
      }
      const outIndex = (y * width + x) * 4;
      const samples = scale * scale;
      output[outIndex] = Math.round(sum[0] / samples);
      output[outIndex + 1] = Math.round(sum[1] / samples);
      output[outIndex + 2] = Math.round(sum[2] / samples);
      output[outIndex + 3] = Math.round(sum[3] / samples);
    }
  }
  return output;
}

function makeDib(size, rgba) {
  const xorBytes = size * size * 4;
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const maskBytes = maskRowBytes * size;
  const buffer = Buffer.alloc(40 + xorBytes + maskBytes);

  buffer.writeUInt32LE(40, 0);
  buffer.writeInt32LE(size, 4);
  buffer.writeInt32LE(size * 2, 8);
  buffer.writeUInt16LE(1, 12);
  buffer.writeUInt16LE(32, 14);
  buffer.writeUInt32LE(0, 16);
  buffer.writeUInt32LE(xorBytes, 20);
  buffer.writeInt32LE(2835, 24);
  buffer.writeInt32LE(2835, 28);
  buffer.writeUInt32LE(0, 32);
  buffer.writeUInt32LE(0, 36);

  let offset = 40;
  for (let y = size - 1; y >= 0; y -= 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      buffer[offset] = rgba[index + 2];
      buffer[offset + 1] = rgba[index + 1];
      buffer[offset + 2] = rgba[index];
      buffer[offset + 3] = rgba[index + 3];
      offset += 4;
    }
  }

  return buffer;
}

function buildIco(images) {
  const headerSize = 6 + images.length * 16;
  let imageOffset = headerSize;
  const entries = [];
  const payloads = [];

  for (const { size, rgba } of images) {
    const dib = makeDib(size, rgba);
    entries.push({ size, imageOffset, bytes: dib.length });
    payloads.push(dib);
    imageOffset += dib.length;
  }

  const buffer = Buffer.alloc(imageOffset);
  buffer.writeUInt16LE(0, 0);
  buffer.writeUInt16LE(1, 2);
  buffer.writeUInt16LE(images.length, 4);

  let entryOffset = 6;
  for (const entry of entries) {
    buffer[entryOffset] = entry.size === 256 ? 0 : entry.size;
    buffer[entryOffset + 1] = entry.size === 256 ? 0 : entry.size;
    buffer[entryOffset + 2] = 0;
    buffer[entryOffset + 3] = 0;
    buffer.writeUInt16LE(1, entryOffset + 4);
    buffer.writeUInt16LE(32, entryOffset + 6);
    buffer.writeUInt32LE(entry.bytes, entryOffset + 8);
    buffer.writeUInt32LE(entry.imageOffset, entryOffset + 12);
    entryOffset += 16;
  }

  let payloadOffset = headerSize;
  for (const payload of payloads) {
    payload.copy(buffer, payloadOffset);
    payloadOffset += payload.length;
  }

  return buffer;
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const images = SIZES.map((size) => ({ size, rgba: renderSize(size) }));
fs.writeFileSync(OUTPUT_FILE, buildIco(images));
console.log(`wrote ${OUTPUT_FILE}`);
