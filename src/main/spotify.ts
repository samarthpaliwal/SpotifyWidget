/**
 * Spotify desktop-app integration via AppleScript (osascript).
 *
 * - Never launches Spotify: we check `pgrep -x Spotify` before every Apple Event.
 * - Instant updates: a long-lived `osascript -l JavaScript` helper subscribes to the
 *   `com.spotify.client.PlaybackStateChanged` distributed notification and prints a
 *   line per event; we re-read the full state when one arrives.
 * - Polling: ~1s while playing (for position), ~5s when paused/idle or Spotify is
 *   closed, and slower when the widget window is hidden.
 */
import { ChildProcess, execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { PlayerState } from '../shared/types';

/** Raw snapshot read from Spotify in one Apple Event round-trip. */
export interface RawSpotifyState {
  running: boolean;
  state: PlayerState;
  positionSec: number;
  track: {
    id: string;
    name: string;
    artist: string;
    album: string;
    artworkUrl: string;
    durationMs: number;
    spotifyUrl: string;
  } | null;
}

/** Unit separator: safe delimiter for fields that may contain commas/quotes. */
const SEP = String.fromCharCode(31);

// One round-trip reads everything. `player state` is coerced to text.
// `duration` is milliseconds, `player position` is seconds (handled by caller).
const READ_SCRIPT = `
tell application "Spotify"
  set sep to character id 31
  set pstate to (player state as text)
  set ppos to (player position as text)
  try
    set trk to current track
    return pstate & sep & ppos & sep & (id of trk) & sep & (name of trk) & sep & (artist of trk) & sep & (album of trk) & sep & (artwork url of trk) & sep & ((duration of trk) as text) & sep & (spotify url of trk)
  on error
    return pstate & sep & ppos
  end try
end tell`;

/**
 * JXA helper that forwards Spotify's distributed notification to stdout, one JSON
 * line per event. It defines a tiny Obj-C observer class and runs the run loop
 * forever; we kill it on quit.
 */
const LISTENER_SCRIPT = `
ObjC.import('Foundation');
ObjC.registerSubclass({
  name: 'SpotifyWidgetObserver',
  methods: {
    'handle:': {
      types: ['void', ['id']],
      implementation: function (n) {
        var out = $.NSFileHandle.fileHandleWithStandardOutput;
        var line = '{}';
        try {
          var info = n.userInfo;
          if (info && $.NSJSONSerialization.isValidJSONObject(info)) {
            var data = $.NSJSONSerialization.dataWithJSONObjectOptionsError(info, 0, $());
            line = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
          }
        } catch (e) {}
        out.writeData($(line + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
      }
    }
  }
});
var obs = $.SpotifyWidgetObserver.alloc.init;
$.NSDistributedNotificationCenter.defaultCenter.addObserverSelectorNameObject(obs, 'handle:', 'com.spotify.client.PlaybackStateChanged', $());
$.NSRunLoop.currentRunLoop.run;
`;

function runOsascript(script: string, lang: 'AppleScript' | 'JavaScript' = 'AppleScript'): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', lang, '-e', script], { timeout: 6000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (err as { killed?: boolean }).killed
          ? 'osascript timed out. If this keeps happening, allow this app under System Settings > Privacy & Security > Automation > Spotify'
          : stderr?.toString().trim() || err.message;
        reject(new Error(msg));
      } else resolve(stdout.toString().replace(/\n$/, ''));
    });
  });
}

/** True if the Spotify process exists. Uses pgrep so we never trigger a launch. */
export function isSpotifyRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('pgrep', ['-x', 'Spotify'], (err) => resolve(!err));
  });
}

export async function readSpotify(): Promise<RawSpotifyState> {
  if (!(await isSpotifyRunning())) {
    return { running: false, state: 'stopped', positionSec: 0, track: null };
  }
  const out = await runOsascript(READ_SCRIPT);
  const f = out.split(SEP);
  const state = (['playing', 'paused', 'stopped'].includes(f[0]) ? f[0] : 'stopped') as PlayerState;
  const positionSec = Number.parseFloat(f[1]) || 0;
  if (f.length < 9) return { running: true, state, positionSec, track: null };
  return {
    running: true,
    state,
    positionSec,
    track: {
      id: f[2],
      name: f[3],
      artist: f[4],
      album: f[5],
      artworkUrl: f[6],
      durationMs: Number.parseInt(f[7], 10) || 0,
      spotifyUrl: f[8],
    },
  };
}

async function tellSpotify(cmd: string): Promise<void> {
  if (!(await isSpotifyRunning())) return;
  await runOsascript(`tell application "Spotify" to ${cmd}`);
}

export const playPause = () => tellSpotify('playpause');
export const nextTrack = () => tellSpotify('next track');
export const previousTrack = () => tellSpotify('previous track');
export const setPosition = (seconds: number) =>
  tellSpotify(`set player position to ${Math.max(0, seconds).toFixed(2)}`);

export interface SpotifyServiceEvents {
  state: (s: RawSpotifyState) => void;
}

/**
 * Keeps a fresh RawSpotifyState and emits `state` whenever it is re-read.
 * The caller decides what changed.
 */
export class SpotifyService extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private listener: ChildProcess | null = null;
  private listenerRestartTimer: NodeJS.Timeout | null = null;
  private last: RawSpotifyState = { running: false, state: 'stopped', positionSec: 0, track: null };
  private hidden = false;
  private stopped = false;
  private refreshing: Promise<void> | null = null;
  private lastError = '';

  start(): void {
    this.stopped = false;
    this.startListener();
    void this.refresh();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.listenerRestartTimer) clearTimeout(this.listenerRestartTimer);
    this.timer = null;
    this.listener?.kill();
    this.listener = null;
  }

  /** Throttle polling while the widget window is hidden. */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (!hidden) void this.refresh();
    else this.schedule();
  }

  get current(): RawSpotifyState {
    return this.last;
  }

  /** Re-read Spotify now (coalesces concurrent calls). */
  refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    try {
      this.last = await readSpotify();
      this.lastError = '';
    } catch (err) {
      // Spotify may be mid-launch/quit, or permission was denied. Keep the last
      // known state but mark as not running if the process is gone.
      const msg = (err as Error).message;
      if (msg !== this.lastError) console.warn('[spotify] read failed:', msg);   // log each distinct error once
      this.lastError = msg;
      if (!(await isSpotifyRunning())) {
        this.last = { running: false, state: 'stopped', positionSec: 0, track: null };
      }
    }
    if (!this.stopped) {
      this.emit('state', this.last);
      this.schedule();
    }
  }

  /** Next poll delay based on state and visibility. */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped) return;
    let delay: number;
    if (!this.last.running) delay = 5000;
    else if (this.last.state === 'playing') delay = 1000;
    else delay = 5000;
    if (this.hidden) delay = Math.max(delay, 15000);
    this.timer = setTimeout(() => void this.refresh(), delay);
  }

  private startListener(): void {
    if (this.stopped || this.listener) return;
    const child = spawn('osascript', ['-l', 'JavaScript', '-e', LISTENER_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.listener = child;
    let buf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        buf = buf.slice(nl + 1);
        // Any event = re-read the full state (keeps a single source of truth).
        void this.refresh();
      }
    });
    child.stderr?.on('data', (d: Buffer) => console.warn('[spotify-listener]', d.toString().trim()));
    child.on('exit', (code) => {
      this.listener = null;
      if (this.stopped) return;
      console.warn(`[spotify-listener] exited (${code}); restarting in 5s, polling continues`);
      this.listenerRestartTimer = setTimeout(() => this.startListener(), 5000);
    });
  }
}
