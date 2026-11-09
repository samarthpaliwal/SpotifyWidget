/**
 * Types shared between the main process, the preload bridge and the renderer.
 * Everything crossing IPC is defined here so both sides stay in sync.
 */

export type PlayerState = 'playing' | 'paused' | 'stopped';

/** What the renderer should show. */
export type WidgetMode =
  | 'track'        // normal: a real track with metadata
  | 'ad'           // Spotify advertisement
  | 'not-running'  // Spotify is not open
  | 'idle';        // Spotify open but nothing loaded (stopped)

/** Bump when the extraction algorithm changes so cached palettes are recomputed. */
export const PALETTE_VERSION = 2;

export interface Palette {
  v?: number;
  /** Most prominent colour of the art (background gradient, glow). */
  dominant: string;
  /** A vivid colour guaranteed to be visible on the card: progress bar, hover states, marquee fade. */
  accent: string;
  /** A second colour for gradient variation. */
  secondary: string;
  /** A dark shade derived from the art, for the gradient's far end. */
  dark: string;
  /** Whether white text is readable over the resulting background. */
  lightText: boolean;
}

export interface TrackInfo {
  id: string;         // spotify:track:...
  name: string;
  artist: string;
  album: string;
  /** Remote artwork URL as reported by Spotify (may be empty for local files). */
  artworkUrl: string;
  /** file:// path of the cached artwork, or null if none available. */
  artworkPath: string | null;
  durationMs: number;
  palette: Palette | null;
}

export interface NowPlaying {
  mode: WidgetMode;
  state: PlayerState;
  track: TrackInfo | null;
  /** Position in seconds (Spotify reports seconds; duration is in ms). */
  positionSec: number;
  /** Wall-clock ms when positionSec was sampled, so the renderer can interpolate. */
  sampledAt: number;
}

export interface LyricLine { t: number; text: string }   // t in seconds (0 for unsynced)
export interface Lyrics {
  trackId: string;
  synced: boolean;
  lines: LyricLine[];
  instrumental?: boolean;
}

export type SizePreset = 'small' | 'medium' | 'large';
export type BackgroundStyle = 'blurred' | 'gradient' | 'frosted';
/** 'desktop': pinned above the wallpaper and below every app window, like a macOS desktop widget.
 *  'floating': always on top of other windows. */
export type WindowLevel = 'desktop' | 'floating';

export interface Settings {
  size: SizePreset;
  background: BackgroundStyle;
  level: WindowLevel;
  clickThrough: boolean;
  launchAtLogin: boolean;
  /** Show time-synced lyrics (from LRCLIB) in the card. */
  lyrics: boolean;
  visible: boolean;
  bounds: { x: number; y: number } | null;
}

export type ControlCommand = 'playpause' | 'next' | 'previous';

/** API exposed to the renderer by the preload script (window.widget). */
export interface WidgetApi {
  onNowPlaying(cb: (np: NowPlaying) => void): () => void;
  onSettings(cb: (s: Settings) => void): () => void;
  onLyrics(cb: (l: Lyrics) => void): () => void;
  control(cmd: ControlCommand): void;
  seek(seconds: number): void;
  /** Renderer signals it has mounted and wants the current state. */
  ready(): void;
}

export const IPC = {
  nowPlaying: 'widget:now-playing',
  settings: 'widget:settings',
  lyrics: 'widget:lyrics',
  control: 'widget:control',
  seek: 'widget:seek',
  ready: 'widget:ready',
} as const;

/**
 * Window sizes (pixels) per preset. These are the frames macOS uses for its own desktop
 * widgets (Notification Center windows): small 180×180, medium 360×180, large 360×360.
 * The visible card is inset by WINDOW_PAD on each side (344×164 for medium), which is the
 * same inset the system widgets have, so ours lines up with them on the desktop grid.
 */
export const SIZE_PRESETS: Record<SizePreset, { width: number; height: number }> = {
  small: { width: 180, height: 180 },
  medium: { width: 360, height: 180 },
  large: { width: 360, height: 360 },
};
export const WINDOW_PAD = 8;

export const SPOTIFY_GREEN = '#1DB954';
