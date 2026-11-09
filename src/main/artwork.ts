/**
 * Artwork cache: downloads each album cover once, keyed by track ID, into
 * <userData>/artwork/. The extracted palette is stored beside it as JSON so
 * colour extraction also happens only once per track.
 */
import { app, net } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Palette } from '../shared/types';
import { PALETTE_VERSION } from '../shared/types';
import { extractPalette } from './palette';

export interface CachedArt {
  imagePath: string;
  palette: Palette | null;
}

const cacheDir = () => path.join(app.getPath('userData'), 'artwork');
const keyFor = (trackId: string) => createHash('sha1').update(trackId).digest('hex').slice(0, 24);

const inflight = new Map<string, Promise<CachedArt | null>>();

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

export function getArtwork(trackId: string, url: string): Promise<CachedArt | null> {
  if (!url) return Promise.resolve(null);
  let p = inflight.get(trackId);
  if (!p) {
    p = fetchArtwork(trackId, url).finally(() => inflight.delete(trackId));
    inflight.set(trackId, p);
  }
  return p;
}

async function fetchArtwork(trackId: string, url: string): Promise<CachedArt | null> {
  const dir = cacheDir();
  await fs.mkdir(dir, { recursive: true });
  const key = keyFor(trackId);
  const imagePath = path.join(dir, `${key}.jpg`);
  const palettePath = path.join(dir, `${key}.json`);

  if (!(await exists(imagePath))) {
    try {
      const res = await net.fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(imagePath, buf);
    } catch (err) {
      console.warn('[artwork] download failed:', (err as Error).message);
      return null;
    }
  }

  let palette: Palette | null = null;
  if (await exists(palettePath)) {
    try {
      palette = JSON.parse(await fs.readFile(palettePath, 'utf8')) as Palette;
      if (palette.v !== PALETTE_VERSION) palette = null; // older algorithm: re-extract
    } catch { /* re-extract */ }
  }
  if (!palette) {
    try {
      palette = extractPalette(imagePath);
      if (palette) await fs.writeFile(palettePath, JSON.stringify(palette));
    } catch (err) {
      console.warn('[artwork] palette extraction failed:', (err as Error).message);
    }
  }
  return { imagePath, palette };
}
