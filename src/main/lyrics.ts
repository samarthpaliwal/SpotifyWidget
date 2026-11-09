/**
 * Lyrics from LRCLIB (https://lrclib.net): a free, open lyrics database with no API key.
 * We look a track up by title / artist / album / duration, prefer time-synced lyrics
 * (LRC format) and fall back to plain text. Results (including misses) are cached on disk
 * per track id so each song is looked up at most once.
 */
import { app, net } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Lyrics, LyricLine } from '../shared/types';

const cacheDir = () => path.join(app.getPath('userData'), 'lyrics');
const keyFor = (trackId: string) => createHash('sha1').update(trackId).digest('hex').slice(0, 24);
const inflight = new Map<string, Promise<Lyrics>>();
/** After a server/network failure, skip lookups for a while instead of hitting a dead service per track. */
const BACKOFF_MS = 10 * 60 * 1000;
let backoffUntil = 0;

const EMPTY = (trackId: string): Lyrics => ({ trackId, synced: false, lines: [] });

/** Parse LRC "[mm:ss.xx] text" lines into {t, text}, sorted by time. */
export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const m = raw.match(/^\s*((?:\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\])+)\s*(.*)$/);
    if (!m) continue;
    const text = m[2].trim();
    for (const tag of m[1].matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)) {
      const frac = tag[3] ? Number.parseInt(tag[3].padEnd(3, '0').slice(0, 3), 10) / 1000 : 0;
      out.push({ t: Number.parseInt(tag[1], 10) * 60 + Number.parseInt(tag[2], 10) + frac, text });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

export function getLyrics(track: { id: string; name: string; artist: string; album: string; durationMs: number }): Promise<Lyrics> {
  let p = inflight.get(track.id);
  if (!p) {
    p = fetchLyrics(track).finally(() => inflight.delete(track.id));
    inflight.set(track.id, p);
  }
  return p;
}

async function fetchLyrics(track: { id: string; name: string; artist: string; album: string; durationMs: number }): Promise<Lyrics> {
  const dir = cacheDir();
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${keyFor(track.id)}.json`);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Lyrics;
  } catch { /* not cached */ }

  let result = EMPTY(track.id);
  if (Date.now() < backoffUntil) return result;
  try {
    // Spotify titles often carry " - Remix" / " (feat. X)" suffixes LRCLIB doesn't index; try the
    // exact title first, then a cleaned one.
    const titles = [track.name, track.name.replace(/\s*[-(\[].*$/, '').trim()].filter((t, i, a) => t && a.indexOf(t) === i);
    for (const title of titles) {
      const q = new URLSearchParams({
        track_name: title,
        artist_name: track.artist,
        album_name: track.album,
        duration: String(Math.round(track.durationMs / 1000)),
      });
      const res = await net.fetch(`https://lrclib.net/api/get?${q}`, {
        headers: { 'User-Agent': 'SpotifyWidget/1.0 (https://github.com/local/spotify-widget)' },
      });
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { syncedLyrics?: string | null; plainLyrics?: string | null; instrumental?: boolean };
      if (json.instrumental) { result = { trackId: track.id, synced: false, lines: [], instrumental: true }; break; }
      if (json.syncedLyrics) {
        const lines = parseLrc(json.syncedLyrics).filter((l) => l.text);
        if (lines.length) { result = { trackId: track.id, synced: true, lines }; break; }
      }
      if (json.plainLyrics) {
        result = { trackId: track.id, synced: false, lines: json.plainLyrics.split(/\r?\n/).filter(Boolean).map((text) => ({ t: 0, text })) };
        break;
      }
    }
  } catch (err) {
    backoffUntil = Date.now() + BACKOFF_MS;
    console.warn(`[lyrics] lookup failed: ${(err as Error).message} (pausing lookups for ${BACKOFF_MS / 60000} min)`);
    return result;   // don't cache transient failures
  }
  try { await fs.writeFile(file, JSON.stringify(result)); } catch { /* ignore */ }
  return result;
}
