/**
 * Dependency-free palette extraction.
 *
 * Electron's nativeImage decodes the JPEG for us; we downscale to 48x48,
 * bucket pixels into a coarse RGB histogram (median-cut-lite), then pick:
 *   - dominant: the most populous bucket, preferring saturated colours
 *   - secondary: the most populous bucket that is visually distinct from dominant
 *   - dark: dominant pushed toward black, for the gradient's far end
 * Runs once per track in the main process; result is cached next to the artwork.
 */
import { nativeImage } from 'electron';
import type { Palette } from '../shared/types';
import { PALETTE_VERSION, SPOTIFY_GREEN } from '../shared/types';

type RGB = [number, number, number];

const hex = ([r, g, b]: RGB) =>
  '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

function hsl([r, g, b]: RGB): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

/** WCAG relative luminance 0..1 */
export function luminance([r, g, b]: RGB): number {
  const f = (c: number) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Push a colour away from its grey axis (more saturated, same hue and lightness). */
function saturate(c: RGB): RGB {
  const avg = (c[0] + c[1] + c[2]) / 3;
  return [avg + (c[0] - avg) * 1.8, avg + (c[1] - avg) * 1.8, avg + (c[2] - avg) * 1.8].map((v) => Math.max(0, Math.min(255, v))) as RGB;
}

function dist(a: RGB, b: RGB): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function extractPalette(imagePath: string): Palette | null {
  const img = nativeImage.createFromPath(imagePath);
  if (img.isEmpty()) return null;
  const small = img.resize({ width: 48, height: 48, quality: 'good' });
  const { width, height } = small.getSize();
  const bmp = small.toBitmap(); // BGRA, premultiplied
  if (bmp.length < width * height * 4) return null;

  // 4 bits per channel histogram => 4096 buckets
  const buckets = new Map<number, { count: number; sum: RGB }>();
  for (let i = 0; i < width * height; i++) {
    const b = bmp[i * 4], g = bmp[i * 4 + 1], r = bmp[i * 4 + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(key);
    if (e) { e.count++; e.sum[0] += r; e.sum[1] += g; e.sum[2] += b; }
    else buckets.set(key, { count: 1, sum: [r, g, b] });
  }

  const entries = [...buckets.values()]
    .map((e) => ({ count: e.count, rgb: e.sum.map((v) => v / e.count) as RGB }))
    .sort((a, b) => b.count - a.count);
  if (entries.length === 0) return null;

  const total = width * height;
  const share = (e: { count: number }) => e.count / total;
  const extreme = (rgb: RGB) => { const l = hsl(rgb)[2]; return l < 0.07 || l > 0.95; };

  // "Vibrant" score (node-vibrant style): saturation × closeness to mid lightness, with a
  // gentle population term so a tiny speck can't win over a real area of colour.
  const vibrantScore = (rgb: RGB, sh: number) => {
    const [, sat, l] = hsl(rgb);
    const lightFit = Math.max(0, 1 - Math.abs(l - 0.5) * 1.8);
    return sat * lightFit * Math.pow(sh, 0.3);
  };
  const colourful = entries
    .filter((e) => share(e) > 0.003 && hsl(e.rgb)[1] > 0.3 && !extreme(e.rgb))
    .map((e) => ({ rgb: e.rgb, sh: share(e), score: vibrantScore(e.rgb, share(e)) }))
    .sort((a, b) => b.score - a.score);
  const vibrant = colourful[0];

  // Dominant: a colourful area that covers at least ~4% of the image wins; otherwise the most
  // common non-black/non-white bucket; otherwise simply the most common bucket.
  const bigColourful = colourful.find((c) => c.sh > 0.04);
  const commonMid = entries.find((e) => !extreme(e.rgb) && share(e) > 0.05);
  const dominant = bigColourful?.rgb ?? commonMid?.rgb ?? entries[0].rgb;

  // Accent: the most vibrant colour, lifted so it stays visible on the dark card.
  let accent: RGB;
  if (vibrant) {
    accent = vibrant.rgb;
    const [, sat, l] = hsl(accent);
    if (l < 0.45) accent = mix(accent, [255, 255, 255], (0.45 - l) * 1.4);
    if (sat < 0.5) accent = mix(accent, saturate(accent), 0.5);
  } else {
    accent = mix(dominant, [255, 255, 255], 0.65);   // monochrome art: light neutral bar
  }

  const secondary = entries.find((e) => dist(e.rgb, dominant) > 60 && share(e) > 0.01)?.rgb
    ?? mix(dominant, [255, 255, 255], 0.25);
  const dark = mix(dominant, [8, 8, 12], 0.72);

  // Background the text sits on ≈ 55% dark + 45% dominant, under a dark scrim.
  const bgApprox = mix(mix(dominant, dark, 0.55), [0, 0, 0], 0.3);
  const lightText = luminance(bgApprox) < 0.45;

  return { v: PALETTE_VERSION, dominant: hex(dominant), accent: hex(accent), secondary: hex(secondary), dark: hex(dark), lightText };
}

export const FALLBACK_PALETTE: Palette = {
  dominant: '#2a2f36',
  accent: SPOTIFY_GREEN,
  secondary: '#3a4048',
  dark: '#0e1114',
  lightText: true,
};
