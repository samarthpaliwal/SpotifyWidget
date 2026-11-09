/**
 * Renderer: pure DOM + CSS. No frameworks.
 *
 * - Spin: one Web Animations API rotation on a GPU-composited layer. Pause/resume
 *   ease `playbackRate` so the disc decelerates/accelerates; the angle is never reset.
 * - Backgrounds and art: two stacked layers crossfaded by toggling a class.
 * - Progress: interpolated from the last sample once per second (no rAF loops).
 * - Everything pauses while the window is hidden (visibilitychange).
 */
import type { Lyrics, NowPlaying, Palette, Settings, WidgetApi } from '../shared/types';
import { SPOTIFY_GREEN } from '../shared/types';

declare global { interface Window { widget: WidgetApi } }

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const body = document.body;
const disc = $('#disc');
const discButton = $('#disc-button');
const arts = Array.from(disc.querySelectorAll<HTMLImageElement>('.art'));
const bgLayers = Array.from(document.querySelectorAll<HTMLElement>('.bg-layer'));
const titleWrap = $('.title-wrap');
const titleEl = $('#title');
const artistEl = $('#artist');
const elapsedEl = $('#elapsed');
const totalEl = $('#total');
const bar = $('#bar');
const fill = $('#fill');
const knob = $('.knob');

const SPIN_MS = 1800;          // one revolution; ≈33⅓ RPM. Change --spin-duration in CSS too.
const RAMP_MS = 600;           // decelerate / accelerate time

// ------------------------------------------------------------------ Spin
const spin = disc.animate(
  [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
  { duration: SPIN_MS, iterations: Infinity, easing: 'linear' },
);
spin.pause();
let ramp: number | null = null;
let spinning = false;

/**
 * Ease playbackRate from its current value to `target` over RAMP_MS, then pause if 0.
 * Uses a short setTimeout loop (~60 Hz) rather than requestAnimationFrame so the ramp
 * completes even when rAF is throttled; it only runs for RAMP_MS per state change.
 */
function rampSpin(target: 0 | 1): void {
  if (ramp !== null) clearTimeout(ramp);
  const from = spin.playbackRate;
  if (target === 1) spin.play();
  const t0 = performance.now();
  const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
  const step = () => {
    const p = Math.min(1, (performance.now() - t0) / RAMP_MS);
    const rate = from + (target - from) * easeOut(p);
    spin.playbackRate = Math.max(0.0001, rate);
    if (p < 1) ramp = window.setTimeout(step, 16);
    else {
      ramp = null;
      if (target === 0) spin.pause();   // angle preserved; resume continues from here
      else spin.playbackRate = 1;
    }
  };
  step();
}

function setSpinning(on: boolean): void {
  if (on === spinning) return;
  spinning = on;
  if (document.hidden) { if (!on) { spin.playbackRate = 0.0001; spin.pause(); } return; }
  rampSpin(on ? 1 : 0);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (ramp !== null) { clearTimeout(ramp); ramp = null; }
    spin.pause();
    stopClock();
    if (lyricTimer !== null) { clearTimeout(lyricTimer); lyricTimer = null; }
  } else {
    if (spinning) { spin.playbackRate = 1; spin.play(); }
    startClock();
    renderProgress();
    renderLyric(true);
  }
});

// ------------------------------------------------------------------ Art & background crossfade
let activeArt = 0;
let activeBg = 0;
let currentArtPath: string | null = null;
let currentTrackId: string | null = null;

function applyPalette(p: Palette | null, neutral: boolean): void {
  const pal = p ?? { dominant: '#2a2f36', accent: SPOTIFY_GREEN, secondary: '#3a4048', dark: '#0e1114', lightText: true };
  const r = document.documentElement.style;
  r.setProperty('--accent', pal.accent);
  r.setProperty('--dominant', pal.dominant);
  r.setProperty('--secondary', pal.secondary);
  r.setProperty('--dark', pal.dark);
  // Frosted / neutral backgrounds are always dark → white text.
  const lightText = neutral || body.dataset.bg === 'frosted' ? true : pal.lightText;
  r.setProperty('--text', lightText ? '#ffffff' : '#111111');
  r.setProperty('--muted', lightText ? 'rgba(255,255,255,0.68)' : 'rgba(0,0,0,0.6)');
  r.setProperty('--scrim', lightText ? 'rgba(0,0,0,0.28)' : 'rgba(255,255,255,0.14)');
  body.classList.toggle('dark-text', !lightText);
}

/** Swap the inactive background layer in with new art + colours, then crossfade. */
function crossfadeBackground(artPath: string | null, p: Palette | null): void {
  const next = bgLayers[1 - activeBg];
  const img = next.querySelector<HTMLImageElement>('.bg-art')!;
  const pal = p ?? { dominant: '#2a2f36', secondary: '#3a4048', dark: '#0e1114' };
  next.style.setProperty('--l-dominant', pal.dominant);
  next.style.setProperty('--l-secondary', pal.secondary);
  next.style.setProperty('--l-dark', pal.dark);
  const swap = () => {
    bgLayers[activeBg].classList.remove('active');
    next.classList.add('active');
    activeBg = 1 - activeBg;
  };
  if (artPath) {
    img.src = artPath;
    // decode() resolves once the bitmap is ready so the fade never shows a half-loaded image.
    img.decode().then(swap, swap);
  } else {
    img.removeAttribute('src');
    swap();
  }
}

function crossfadeArt(artPath: string | null): void {
  if (artPath === currentArtPath) return;
  currentArtPath = artPath;
  body.classList.toggle('no-art', !artPath);
  const next = arts[1 - activeArt];
  const swap = () => {
    arts[activeArt].classList.remove('active');
    next.classList.add('active');
    activeArt = 1 - activeArt;
  };
  if (artPath) { next.src = artPath; next.decode().then(swap, swap); }
  else { next.removeAttribute('src'); swap(); }
}

// ------------------------------------------------------------------ Marquee
function updateMarquee(): void {
  titleWrap.classList.remove('marquee');
  titleEl.style.removeProperty('--marquee-shift');
  const overflow = titleEl.scrollWidth - titleWrap.clientWidth;
  if (overflow > 4) {
    titleWrap.style.setProperty('--marquee-shift', `${overflow + 8}px`);
    titleWrap.style.setProperty('--marquee-duration', `${Math.max(6, overflow / 25 + 4)}s`);
    // restart the animation cleanly
    void titleEl.offsetWidth;
    titleWrap.classList.add('marquee');
  }
}
window.addEventListener('resize', updateMarquee);

// ------------------------------------------------------------------ Progress clock
let np: NowPlaying | null = null;
let clock: number | null = null;
let seekPreview: number | null = null;

const fmt = (s: number) => {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function currentPosition(): number {
  if (!np) return 0;
  let pos = np.positionSec;
  if (np.state === 'playing') pos += (Date.now() - np.sampledAt) / 1000;
  const dur = (np.track?.durationMs ?? 0) / 1000;
  return dur ? Math.min(pos, dur) : pos;
}

function renderProgress(): void {
  if (!np?.track) return;
  const dur = np.track.durationMs / 1000;
  const pos = seekPreview ?? currentPosition();
  const pct = dur ? (pos / dur) * 100 : 0;
  fill.style.width = `${pct}%`;
  knob.style.setProperty('--knob', `${pct}%`);
  elapsedEl.textContent = fmt(pos);
  totalEl.textContent = fmt(dur);
  if (lyrics && !lyrics.synced) renderLyric();
}

function startClock(): void {
  if (clock !== null) return;
  clock = window.setInterval(() => { if (np?.state === 'playing') renderProgress(); }, 1000);
}
function stopClock(): void {
  if (clock !== null) { clearInterval(clock); clock = null; }
}

// ------------------------------------------------------------------ Lyrics
// Synced lyrics: we show previous / current / next line and schedule a timeout for exactly
// when the next line starts (no polling). Unsynced lyrics advance in proportion to progress.
const lyricsEl = $('#lyrics');
const lyricPrev = $('#lyric-prev');
const lyricNow = $('#lyric-now');
const lyricNext = $('#lyric-next');
let lyrics: Lyrics | null = null;
let lyricTimer: number | null = null;
let lyricIndex = -1;

function setLyrics(l: Lyrics | null): void {
  lyrics = l && l.lines.length ? l : null;
  lyricIndex = -1;
  body.classList.toggle('has-lyrics', !!lyrics);
  lyricsEl.classList.toggle('unsynced', !!lyrics && !lyrics.synced);
  if (!lyrics) { lyricPrev.textContent = ''; lyricNow.textContent = ''; lyricNext.textContent = ''; }
  renderLyric(true);
}

function lyricIndexAt(pos: number): number {
  if (!lyrics) return -1;
  if (!lyrics.synced) {
    const dur = (np?.track?.durationMs ?? 0) / 1000;
    return dur ? Math.min(lyrics.lines.length - 1, Math.floor((pos / dur) * lyrics.lines.length)) : 0;
  }
  let i = -1;
  while (i + 1 < lyrics.lines.length && lyrics.lines[i + 1].t <= pos + 0.15) i++;
  return i;
}

function renderLyric(force = false): void {
  if (lyricTimer !== null) { clearTimeout(lyricTimer); lyricTimer = null; }
  if (!lyrics || !np?.track || np.mode !== 'track') return;
  const pos = seekPreview ?? currentPosition();
  const i = lyricIndexAt(pos);
  if (force || i !== lyricIndex) {
    lyricIndex = i;
    lyricPrev.textContent = i > 0 ? lyrics.lines[i - 1].text : '';
    lyricNow.textContent = i >= 0 ? lyrics.lines[i].text : '';
    lyricNext.textContent = i + 1 < lyrics.lines.length ? lyrics.lines[i + 1].text : '';
  }
  // schedule the next line change while playing
  if (lyrics.synced && np.state === 'playing' && !document.hidden && seekPreview === null) {
    const next = lyrics.lines[i + 1];
    if (next) lyricTimer = window.setTimeout(() => renderLyric(), Math.max(50, (next.t - pos) * 1000));
  }
}

// ------------------------------------------------------------------ Seeking
function posFromEvent(e: MouseEvent): number {
  const rect = bar.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  return frac * ((np?.track?.durationMs ?? 0) / 1000);
}
let dragging = false;
bar.addEventListener('mousedown', (e) => {
  if (!np?.track || np.mode !== 'track') return;
  dragging = true;
  bar.classList.add('seeking');
  seekPreview = posFromEvent(e);
  renderProgress();
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  seekPreview = posFromEvent(e);
  renderProgress();
});
window.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  const target = posFromEvent(e);
  seekPreview = null;
  if (np) { np = { ...np, positionSec: target, sampledAt: Date.now() }; renderProgress(); renderLyric(true); }
  window.widget.seek(target);
  // keep transitions off until the next real sample arrives
  setTimeout(() => bar.classList.remove('seeking'), 50);
});

// ------------------------------------------------------------------ Controls
$('#playpause').addEventListener('click', () => window.widget.control('playpause'));
$('#next').addEventListener('click', () => window.widget.control('next'));
$('#prev').addEventListener('click', () => window.widget.control('previous'));

// ------------------------------------------------------------------ The record itself
// A short click toggles play/pause. Dragging the record around its centre scrubs: the
// disc follows the pointer (rotor rotation), the time preview updates, and on release we
// seek by SECONDS_PER_TURN × turns. The spin animation is paused during the drag and its
// angle is preserved, so nothing jumps.
const rotor = $('#rotor');
const SECONDS_PER_TURN = 30;        // one full manual rotation scrubs 30 s
let drag: { id: number; startAngle: number; lastAngle: number; total: number; moved: boolean; t0: number; baseRot: number; basePos: number } | null = null;
let rotorAngle = 0;                  // persistent manual rotation of the rotor (degrees)
const LIVE_SEEK_MS = 120;            // while dragging, push the position to Spotify this often
let lastLiveSeek = 0;
let lastLiveSeekPos = -1;

/** Send the current preview position to Spotify while the record is being turned. */
function liveSeek(): void {
  if (seekPreview === null) return;
  const now = performance.now();
  if (now - lastLiveSeek < LIVE_SEEK_MS || Math.abs(seekPreview - lastLiveSeekPos) < 0.4) return;
  lastLiveSeek = now;
  lastLiveSeekPos = seekPreview;
  window.widget.seek(seekPreview);
}

function angleAt(e: PointerEvent): number {
  const r = discButton.getBoundingClientRect();
  return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
}

discButton.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const a = angleAt(e);
  drag = { id: e.pointerId, startAngle: a, lastAngle: a, total: 0, moved: false, t0: performance.now(), baseRot: rotorAngle, basePos: currentPosition() };
  lastLiveSeekPos = -1;
  discButton.setPointerCapture(e.pointerId);
});

discButton.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const a = angleAt(e);
  let delta = a - drag.lastAngle;
  if (delta > 180) delta -= 360; else if (delta < -180) delta += 360;
  drag.lastAngle = a;
  drag.total += delta;
  if (!drag.moved && Math.abs(drag.total) > 3) {
    drag.moved = true;
    discButton.classList.add('scrubbing');
    if (ramp !== null) { clearTimeout(ramp); ramp = null; }
    spin.pause();                                       // hold the spin; angle stays
  }
  if (drag.moved) {
    rotorAngle = drag.baseRot + drag.total;
    rotor.style.transform = `rotate(${rotorAngle}deg)`;
    if (np?.track && np.mode === 'track') {
      const dur = np.track.durationMs / 1000;
      seekPreview = Math.min(dur, Math.max(0, drag.basePos + (drag.total / 360) * SECONDS_PER_TURN));
      renderProgress();
      renderLyric();
      liveSeek();                                       // the song follows the record as you turn it
    }
  }
});

function endDrag(e: PointerEvent): void {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  discButton.classList.remove('scrubbing');
  if (!d.moved) {
    // plain click
    if (np && np.mode === 'track') window.widget.control('playpause');
    return;
  }
  if (np?.track && np.mode === 'track') {
    const target = seekPreview ?? currentPosition();
    seekPreview = null;
    np = { ...np, positionSec: target, sampledAt: Date.now() };
    renderProgress();
    renderLyric(true);
    window.widget.seek(target);
  } else {
    seekPreview = null;
  }
  if (spinning && !document.hidden) { spin.playbackRate = 1; spin.play(); }
}
discButton.addEventListener('pointerup', endDrag);
discButton.addEventListener('pointercancel', endDrag);

// ------------------------------------------------------------------ State updates
function onNowPlaying(next: NowPlaying): void {
  const prev = np;
  np = next;
  body.dataset.mode = next.mode;
  body.dataset.state = next.state;

  const neutral = next.mode !== 'track';
  body.classList.toggle('neutral', neutral);

  if (next.mode === 'not-running') {
    titleEl.textContent = 'Nothing playing';
    artistEl.textContent = 'Open Spotify to get started';
  } else if (next.mode === 'idle') {
    titleEl.textContent = 'Spotify is open';
    artistEl.textContent = 'Pick something to play';
  } else if (next.mode === 'ad') {
    titleEl.textContent = 'Advertisement';
    artistEl.textContent = 'Music resumes shortly';
    disc.querySelector('.placeholder span')!.textContent = 'Ad';
  } else if (next.track) {
    titleEl.textContent = next.track.name;
    artistEl.textContent = next.track.artist;
    disc.querySelector('.placeholder span')!.textContent = next.track.album || 'No artwork';
  }
  if (next.mode !== 'ad') disc.querySelector('.placeholder span')!.textContent =
    next.mode === 'track' ? (next.track?.album || 'No artwork') : 'Open Spotify';

  const trackId = next.mode === 'track' ? next.track?.id ?? null : null;
  if (trackId !== currentTrackId || prev?.mode !== next.mode) {
    currentTrackId = trackId;
    const art = next.mode === 'track' ? next.track?.artworkPath ?? null : null;
    const pal = next.mode === 'track' ? next.track?.palette ?? null : null;
    applyPalette(pal, neutral);
    crossfadeArt(art);
    if (!neutral) crossfadeBackground(art, pal);
    updateMarquee();
  }

  // Spin only for a real track that is playing. Ads and placeholders stay still.
  setSpinning(next.mode === 'track' && next.state === 'playing');

  if (next.state === 'playing') startClock(); else stopClock();
  renderProgress();
  if (lyrics && lyrics.trackId !== next.track?.id) setLyrics(null);   // stale lyrics never show on a new track
  renderLyric(true);
}

function onSettings(s: Settings): void {
  body.dataset.bg = s.background;
  body.dataset.level = s.level;
  body.dataset.size = s.size;
  body.dataset.lyrics = s.lyrics ? 'on' : 'off';
  if (!s.lyrics) setLyrics(null);
  // text colour depends on background style
  if (np) applyPalette(np.mode === 'track' ? np.track?.palette ?? null : null, np.mode !== 'track');
  // CSS vh units follow the window size automatically; just re-measure the marquee.
  requestAnimationFrame(updateMarquee);
}

window.widget.onNowPlaying(onNowPlaying);
window.widget.onSettings(onSettings);
window.widget.onLyrics((l) => { if (np?.track?.id === l.trackId) setLyrics(l); });
window.widget.ready();
