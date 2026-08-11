/* The Headsmith mark, defined once.
 *
 * An anvil in white on a forge-orange rounded tile. Both the SVG (docs site,
 * README) and every PNG (extension icons, Web Store assets) are generated from
 * the geometry below, so the vector and the raster can never drift apart.
 *
 * Coordinates are in a 0..100 space, origin top-left. The silhouette is drawn
 * as one closed polygon traversed clockwise from the horn tip.
 *
 * Two things drove the shape:
 *
 *   - It has to survive 16x16. At that size the waist and the underside
 *     chamfer are roughly one pixel each, so the outline is built from a small
 *     number of long straight runs rather than curves -- an anvil rendered
 *     with a rounded horn and a filleted base turns to mush in the toolbar.
 *   - The horn has to stay readable, because a symmetric anvil reads as a
 *     generic plinth. It is deliberately blunt and slightly over-long for a
 *     real anvil; at icon scale a correctly-proportioned horn disappears.
 */

export const PALETTE = {
  tile: '#B4470E',
  glyph: '#FFFFFF',
  // Used only by the promo tiles and og:image, never by the icon itself.
  tileDark: '#8A360B',
  ink: '#14161A',
  paper: '#FFF8F3',
};

/* Fraction of the canvas the tile's corner radius occupies. Chrome renders
   the toolbar icon without a mask, so the tile provides its own shape. */
export const TILE_RADIUS = 0.2;

/* Inset of the glyph within the tile, as a fraction of the tile. Keeps the
   anvil off the rounded corners at every size -- at 16px a tighter inset puts
   the horn tip into the corner radius and the mark reads as cramped. */
export const GLYPH_INSET = 0.16;

/* Authored in whatever coordinates read clearly; `ANVIL` below is this fitted
   to the glyph box, so these numbers can be nudged without also having to
   recentre the shape by hand.

   The horn attaches along the entire left face of the top slab rather than
   tapering off part of it -- an earlier version left a step between horn and
   slab underside, and at icon scale that step read as a detached bar floating
   next to the anvil rather than as a horn. */
const ANVIL_RAW = [
  [6, 36], //   horn tip, top
  [32, 28], //  slab top-left
  [88, 28], //  slab top-right
  [88, 50], //  slab bottom-right -- a thick slab, so the flat top survives
  [76, 50], //  underside, stepping in
  [66, 58], //  chamfer down to the waist
  [66, 64], //  waist, right
  [86, 72], //  base flare, right
  [88, 84], //  foot, bottom-right
  [12, 84], //  foot, bottom-left
  [14, 72], //  base flare, left
  [34, 64], //  waist, left -- wide and short; a narrow waist collapses the
  [34, 58], //  whole silhouette into an hourglass below about 24px
  [32, 50], //  slab bottom-left, where the horn's lower edge begins
  [6, 43], //   horn tip, bottom
];

/* Fits a polygon into the 0..100 box, preserving aspect and centring. Without
   this the mark sits in whatever corner of the box its raw coordinates put it
   and uses only part of the available area, which at 16px is the difference
   between a legible anvil and a smudge. */
function fitToBox(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const scale = 100 / Math.max(maxX - minX, maxY - minY);
  const offX = (100 - (maxX - minX) * scale) / 2;
  const offY = (100 - (maxY - minY) * scale) / 2;
  return points.map(([x, y]) => [
    Number(((x - minX) * scale + offX).toFixed(3)),
    Number(((y - minY) * scale + offY).toFixed(3)),
  ]);
}

export const ANVIL = fitToBox(ANVIL_RAW);

/* The polygon as an SVG path `d` attribute. */
export function anvilPath() {
  return (
    ANVIL.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ') + ' Z'
  );
}

/* Maps the 0..100 glyph space into a tile of `size` pixels, honouring the
   inset. Returns points in pixel coordinates. */
export function anvilPoints(size) {
  const inset = size * GLYPH_INSET;
  const span = size - inset * 2;
  return ANVIL.map(([x, y]) => [inset + (x / 100) * span, inset + (y / 100) * span]);
}

export function svg({ size = 128, tile = PALETTE.tile, glyph = PALETTE.glyph, rounded = true } = {}) {
  const r = rounded ? (TILE_RADIUS * 100).toFixed(1) : '0';
  const inset = GLYPH_INSET * 100;
  const span = 100 - inset * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="Headsmith">
  <title>Headsmith</title>
  <rect width="100" height="100" rx="${r}" ry="${r}" fill="${tile}"/>
  <g transform="translate(${inset} ${inset}) scale(${(span / 100).toFixed(6)})">
    <path d="${anvilPath()}" fill="${glyph}"/>
  </g>
</svg>
`;
}
