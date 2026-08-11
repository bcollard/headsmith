/* A minimal deterministic PNG encoder and polygon rasteriser.
 *
 * Zero dependencies, and that is a reproducibility decision rather than a
 * purity one. The usual way to rasterise an SVG in Node is sharp or resvg,
 * both of which ship prebuilt native binaries that differ per platform and
 * per release -- which would mean the icons in a build made on macOS are not
 * byte-identical to the ones made on the CI runner, and the whole
 * "verify the build yourself" claim in the README dies on an icon diff.
 *
 * Everything here is integer arithmetic plus node:zlib. The only remaining
 * variable is the zlib version bundled with Node, which is why the Node
 * version is pinned in .nvmrc and used verbatim in CI, and why the generated
 * PNGs are committed and checked for drift.
 */

import { deflateSync } from 'node:zlib';
import { crc32 } from './crc32.mjs';

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const payload = Buffer.concat([typeBuf, data]);
  const out = Buffer.alloc(payload.length + 8);
  out.writeUInt32BE(data.length, 0);
  payload.copy(out, 4);
  out.writeUInt32BE(crc32(payload), payload.length + 4);
  return out;
}

/* An RGBA canvas with a straightforward alpha-over compositor. */
export class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  fill(r, g, b, a = 255) {
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = r;
      this.data[i + 1] = g;
      this.data[i + 2] = b;
      this.data[i + 3] = a;
    }
  }

  /* Source-over composite of one pixel. `a` is 0..1. */
  blend(x, y, r, g, b, a) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const dstA = this.data[i + 3] / 255;
    const outA = a + dstA * (1 - a);
    if (outA <= 0) return;
    this.data[i] = (r * a + this.data[i] * dstA * (1 - a)) / outA;
    this.data[i + 1] = (g * a + this.data[i + 1] * dstA * (1 - a)) / outA;
    this.data[i + 2] = (b * a + this.data[i + 2] * dstA * (1 - a)) / outA;
    this.data[i + 3] = outA * 255;
  }

  toPNG() {
    const { width, height, data } = this;
    // Filter byte 0 (None) per scanline. Icons are flat colour, so the
    // adaptive filters buy little and cost determinism headaches.
    const raw = Buffer.alloc(height * (width * 4 + 1));
    let p = 0;
    for (let y = 0; y < height; y++) {
      raw[p++] = 0;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        raw[p++] = data[i];
        raw[p++] = data[i + 1];
        raw[p++] = data[i + 2];
        raw[p++] = data[i + 3];
      }
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // colour type: RGBA
    ihdr[10] = 0; // deflate
    ihdr[11] = 0; // adaptive filtering
    ihdr[12] = 0; // no interlace

    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

/* Even-odd point-in-polygon. */
function inside(points, x, y) {
  let result = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) result = !result;
  }
  return result;
}

/* Fills a polygon with SS x SS supersampled coverage. Sampling at pixel
   centres of the subgrid rather than corners keeps thin features (the waist,
   the horn tip) from dropping out entirely at 16px. */
export function fillPolygon(canvas, points, [r, g, b], ss = 4) {
  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const [x, y] of points) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }

  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(canvas.height - 1, Math.ceil(maxY));
  const x0 = Math.max(0, Math.floor(minX));
  const x1 = Math.min(canvas.width - 1, Math.ceil(maxX));
  const total = ss * ss;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        const py = y + (sy + 0.5) / ss;
        for (let sx = 0; sx < ss; sx++) {
          if (inside(points, x + (sx + 0.5) / ss, py)) hits++;
        }
      }
      if (hits) canvas.blend(x, y, r, g, b, hits / total);
    }
  }
}

/* A rounded rectangle, as a polygon so it goes through the same rasteriser
   and therefore antialiases identically to the glyph. */
export function roundedRectPoints(x, y, w, h, radius, segments = 16) {
  const r = Math.min(radius, w / 2, h / 2);
  const pts = [];
  const corners = [
    [x + w - r, y + r, -Math.PI / 2, 0],
    [x + w - r, y + h - r, 0, Math.PI / 2],
    [x + r, y + h - r, Math.PI / 2, Math.PI],
    [x + r, y + r, Math.PI, (3 * Math.PI) / 2],
  ];
  for (const [cx, cy, a0, a1] of corners) {
    for (let i = 0; i <= segments; i++) {
      const a = a0 + ((a1 - a0) * i) / segments;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return pts;
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}
