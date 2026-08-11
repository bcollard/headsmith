#!/usr/bin/env node
/* Generates every Headsmith image asset from scripts/lib/logo.mjs.
 *
 * Nothing binary is authored by hand and committed: the icons, the store
 * assets and the docs favicon are all derived from one geometry definition.
 * That keeps the vector and the raster consistent, and it means the shipped
 * artifact is entirely source-derived, which is what makes the reproducible
 * build claim in the README hold all the way down to the toolbar icon.
 *
 *   npm run icons            regenerate everything
 *   npm run icons -- --check fail if anything on disk differs (used by CI)
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Canvas, fillPolygon, roundedRectPoints, hexToRgb } from './lib/png.mjs';
import { PALETTE, TILE_RADIUS, GLYPH_INSET, ANVIL, svg } from './lib/logo.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');

const written = [];
const drift = [];

function emit(relPath, buffer) {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  if (checkOnly) {
    if (!existsSync(full)) {
      drift.push(`${relPath} is missing`);
      return;
    }
    const current = readFileSync(full);
    if (!current.equals(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer))) {
      drift.push(`${relPath} differs from what generate-icons.mjs produces`);
    }
    return;
  }
  writeFileSync(full, buffer);
  written.push(`${relPath} (${(buffer.length / 1024).toFixed(1)} KB)`);
}

/* Draws the mark centred in a box of arbitrary aspect, at `glyphSize` pixels
   square. Used for both the square icons and the wide promo tiles. */
function render({ width, height, glyphSize, tileColor, glyphColor, rounded, offsetX = 0, offsetY = 0, background = null }) {
  const canvas = new Canvas(width, height);
  const [br, bg, bb] = hexToRgb(background ?? tileColor);
  canvas.fill(br, bg, bb, 255);

  const tileX = (width - glyphSize) / 2 + offsetX;
  const tileY = (height - glyphSize) / 2 + offsetY;

  if (rounded && background) {
    // Promo tiles put the rounded icon on a larger flat field.
    fillPolygon(
      canvas,
      roundedRectPoints(tileX, tileY, glyphSize, glyphSize, glyphSize * TILE_RADIUS, 24),
      hexToRgb(tileColor),
    );
  } else if (rounded) {
    // The icon itself: repaint the whole canvas transparent, then the tile,
    // so the corners are genuinely rounded rather than orange-on-orange.
    canvas.data.fill(0);
    fillPolygon(
      canvas,
      roundedRectPoints(0, 0, width, height, width * TILE_RADIUS, Math.max(8, width / 4)),
      hexToRgb(tileColor),
    );
  }

  const inset = glyphSize * GLYPH_INSET;
  const span = glyphSize - inset * 2;
  const pts = ANVIL.map(([x, y]) => [
    tileX + inset + (x / 100) * span,
    tileY + inset + (y / 100) * span,
  ]);
  fillPolygon(canvas, pts, hexToRgb(glyphColor));

  return canvas.toPNG();
}

function icon(size) {
  return render({
    width: size,
    height: size,
    glyphSize: size,
    tileColor: PALETTE.tile,
    glyphColor: PALETTE.glyph,
    rounded: true,
  });
}

// ---- Extension icons -------------------------------------------------
// 16 toolbar, 32 Windows hi-dpi toolbar, 48 extensions management page,
// 128 install dialog and Web Store listing.
for (const size of [16, 32, 48, 128]) {
  emit(`src/public/icons/icon${size}.png`, icon(size));
}

// ---- Docs site / README ---------------------------------------------
emit('assets/logo.svg', Buffer.from(svg({ size: 512 })));
emit('assets/logo-mono.svg', Buffer.from(svg({ size: 512, tile: 'none', glyph: PALETTE.ink })));
emit('assets/favicon-32.png', icon(32));
emit('assets/favicon-16.png', icon(16));
// Apple touch icons are composited on white by iOS if transparent, so this
// one is deliberately drawn square with no rounding.
emit(
  'assets/apple-touch-icon-180.png',
  render({
    width: 180,
    height: 180,
    glyphSize: 180,
    tileColor: PALETTE.tile,
    glyphColor: PALETTE.glyph,
    rounded: false,
  }),
);
emit(
  'assets/og-image-1200x630.png',
  render({
    width: 1200,
    height: 630,
    glyphSize: 320,
    tileColor: PALETTE.tile,
    glyphColor: PALETTE.glyph,
    rounded: true,
    background: PALETTE.paper,
  }),
);

// ---- Chrome Web Store assets ----------------------------------------
// 440x280 small promo tile (search results) and 1400x560 marquee (featured
// placement). Sizes per the current Web Store listing requirements.
emit(
  'assets/store/store-icon-128.png',
  render({
    width: 128,
    height: 128,
    glyphSize: 128,
    tileColor: PALETTE.tile,
    glyphColor: PALETTE.glyph,
    rounded: false,
  }),
);
emit(
  'assets/store/promo-small-440x280.png',
  render({
    width: 440,
    height: 280,
    glyphSize: 176,
    tileColor: PALETTE.tile,
    glyphColor: PALETTE.glyph,
    rounded: true,
    background: PALETTE.paper,
  }),
);
emit(
  'assets/store/promo-marquee-1400x560.png',
  render({
    width: 1400,
    height: 560,
    glyphSize: 336,
    tileColor: PALETTE.tile,
    glyphColor: PALETTE.glyph,
    rounded: true,
    background: PALETTE.paper,
    offsetX: -380,
  }),
);

if (checkOnly) {
  if (drift.length) {
    console.error(`\n✗ icon drift: ${drift.length} file(s) do not match the generator\n`);
    for (const d of drift) console.error(`  - ${d}`);
    console.error('\n  Run `npm run icons` and commit the result.\n');
    process.exit(1);
  }
  console.log('\n✓ icons: all generated assets match scripts/lib/logo.mjs\n');
} else {
  console.log(`\n✓ generated ${written.length} asset(s):\n`);
  for (const w of written) console.log(`  ${w}`);
  console.log('');
}
