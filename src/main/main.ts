/**
 * Main process entry: wires the Spotify service, artwork/palette cache, settings,
 * the floating window, the tray menu and typed IPC together.
 */
import { app, BrowserWindow, ipcMain, powerMonitor, Tray } from 'electron';
import type { ControlCommand, NowPlaying, Settings, TrackInfo } from '../shared/types';
import { IPC } from '../shared/types';
import { getArtwork } from './artwork';
import { getLyrics } from './lyrics';
import { SettingsStore } from './settings';
import { nextTrack, playPause, previousTrack, setPosition, SpotifyService, type RawSpotifyState } from './spotify';
import { createTray } from './tray';
import { applyLevel, applySize, createWidgetWindow, snapToDesktopGrid } from './window';

// Single instance: a second launch just shows the existing widget.
if (!app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: SettingsStore;
const spotify = new SpotifyService();

/** Cache of enriched track info by track id (artwork path + palette), avoids re-fetching. */
let currentTrack: TrackInfo | null = null;
let lastSent: NowPlaying | null = null;
let lastLyricsTrack: string | null = null;

function send<T>(channel: string, payload: T): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Convert a raw Spotify read into what the renderer shows, enriching with cached art. */
async function toNowPlaying(raw: RawSpotifyState): Promise<NowPlaying> {
  const sampledAt = Date.now();
  if (!raw.running) {
    currentTrack = null;
    return { mode: 'not-running', state: 'stopped', track: null, positionSec: 0, sampledAt };
  }
  if (!raw.track) {
    currentTrack = null;
    return { mode: 'idle', state: raw.state, track: null, positionSec: 0, sampledAt };
  }
  const t = raw.track;
  const isAd = t.spotifyUrl.startsWith('spotify:ad') || t.id.startsWith('spotify:ad') || t.artist.trim() === '';
  if (isAd) {
    currentTrack = null;
    return {
      mode: 'ad',
      state: raw.state,
      track: { id: t.id, name: 'Advertisement', artist: '', album: '', artworkUrl: '', artworkPath: null, durationMs: t.durationMs, palette: null },
      positionSec: raw.positionSec,
      sampledAt,
    };
  }

  if (!currentTrack || currentTrack.id !== t.id) {
    // Track changed: fetch (or load cached) artwork + palette once.
    const art = t.artworkUrl ? await getArtwork(t.id, t.artworkUrl) : null;
    currentTrack = {
      id: t.id,
      name: t.name,
      artist: t.artist,
      album: t.album,
      artworkUrl: t.artworkUrl,
      artworkPath: art ? 'file://' + art.imagePath : null,
      durationMs: t.durationMs,
      palette: art?.palette ?? null,
    };
  }
  return { mode: 'track', state: raw.state, track: currentTrack, positionSec: raw.positionSec, sampledAt };
}

let converting: Promise<void> | null = null;
function onSpotifyState(raw: RawSpotifyState): void {
  // Serialise conversions so a slow artwork download can't reorder updates.
  converting = (converting ?? Promise.resolve()).then(async () => {
    const np = await toNowPlaying(raw);
    lastSent = np;
    send(IPC.nowPlaying, np);
    void maybeSendLyrics(np);
  }).catch((err) => console.error('[main] state conversion failed', err));
}

/** Look lyrics up once per track (when enabled) and push them to the renderer. */
async function maybeSendLyrics(np: NowPlaying, force = false): Promise<void> {
  if (!store.get().lyrics || np.mode !== 'track' || !np.track) return;
  if (!force && lastLyricsTrack === np.track.id) return;
  lastLyricsTrack = np.track.id;
  const lyrics = await getLyrics(np.track);
  if (lastSent?.track?.id === lyrics.trackId) send(IPC.lyrics, lyrics);
}

function applySettings(patch: Partial<Settings>): void {
  const s = store.set(patch);
  if (win && !win.isDestroyed()) {
    if ('size' in patch) applySize(win, s.size);
    if ('level' in patch) applyLevel(win, s.level);
    if ('clickThrough' in patch) win.setIgnoreMouseEvents(s.clickThrough);
    if ('visible' in patch) {
      if (s.visible) win.showInactive(); else win.hide();
      spotify.setHidden(!s.visible);
    }
  }
  if ('launchAtLogin' in patch) app.setLoginItemSettings({ openAtLogin: s.launchAtLogin });
  if ('lyrics' in patch && s.lyrics && lastSent) void maybeSendLyrics(lastSent, true);
  send(IPC.settings, s);
}

function createWindow(): void {
  const s = store.get();
  win = createWidgetWindow(s);
  const savePosition = () => {
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    store.set({ bounds: { x, y } });
  };

  win.once('ready-to-show', () => {
    if (store.get().visible) win?.showInactive();
    // Land on the desktop-widget grid right away (no drag needed).
    if (store.get().level === 'desktop' && win) void snapToDesktopGrid(win).then(() => savePosition());
  });
  // When the user drops the card: snap it onto the desktop-widget grid, then remember
  // the position. 'moved' fires once at the end of a drag on macOS.
  let snapping = false;
  win.on('moved', () => {
    if (snapping || !win) return;
    snapping = true;
    const task = store.get().level === 'desktop' ? snapToDesktopGrid(win) : Promise.resolve(false);
    task.finally(() => {
      // setPosition(…, animate) emits another 'moved'; ignore it, then persist.
      setTimeout(() => { snapping = false; savePosition(); }, 350);
    });
  });
  win.on('hide', () => spotify.setHidden(true));
  win.on('show', () => spotify.setHidden(false));
  // Surface renderer console output in the terminal during development.
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) console.log(`[renderer] ${msg}`);
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  app.dock?.hide();
  store = new SettingsStore();
  createWindow();

  tray = createTray(() => store.get(), {
    toggleVisible: () => applySettings({ visible: !store.get().visible }),
    setSize: (size) => applySettings({ size }),
    setBackground: (background) => applySettings({ background }),
    setLevel: (level) => applySettings({ level }),
    setClickThrough: (clickThrough) => applySettings({ clickThrough }),
    setLaunchAtLogin: (launchAtLogin) => applySettings({ launchAtLogin }),
    setLyrics: (lyrics) => applySettings({ lyrics }),
    quit: () => app.quit(),
  });

  // ---- IPC from renderer ----
  ipcMain.on(IPC.ready, () => {
    send(IPC.settings, store.get());
    if (lastSent) { send(IPC.nowPlaying, lastSent); void maybeSendLyrics(lastSent, true); }
    void spotify.refresh();
  });
  ipcMain.on(IPC.control, (_e, cmd: ControlCommand) => {
    const run = cmd === 'playpause' ? playPause : cmd === 'next' ? nextTrack : previousTrack;
    run().then(() => spotify.refresh()).catch((err) => console.warn('[main] control failed', err.message));
  });
  // Seeks arrive rapidly while the record is being dragged: run one at a time and
  // always jump to the most recent requested position (latest wins).
  let pendingSeek: number | null = null;
  let seekRunning = false;
  const pumpSeek = () => {
    if (seekRunning || pendingSeek === null) return;
    const target = pendingSeek;
    pendingSeek = null;
    seekRunning = true;
    setPosition(target)
      .catch((err) => console.warn('[main] seek failed', err.message))
      .finally(() => {
        seekRunning = false;
        if (pendingSeek !== null) pumpSeek();
        else void spotify.refresh();
      });
  };
  ipcMain.on(IPC.seek, (_e, seconds: number) => {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return;
    pendingSeek = seconds;
    pumpSeek();
  });

  spotify.on('state', onSpotifyState);
  spotify.start();

  // After sleep, Spotify's state may have changed without a notification reaching us.
  powerMonitor.on('resume', () => void spotify.refresh());
  powerMonitor.on('unlock-screen', () => void spotify.refresh());

  app.on('second-instance', () => applySettings({ visible: true }));
});

// Menu-bar app: keep running when the window is hidden/closed.
app.on('window-all-closed', () => { /* no-op */ });

app.on('before-quit', () => {
  spotify.stop();
  tray?.destroy();
});
