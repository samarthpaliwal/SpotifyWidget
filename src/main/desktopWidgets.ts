/**
 * Finds the frames of macOS's own desktop widgets so ours can sit at the same window
 * level and snap onto the same grid. Uses CGWindowListCopyWindowInfo through a JXA
 * one-shot (no native module, no Screen Recording permission needed for bounds).
 */
import { execFile } from 'node:child_process';

export interface Rect { x: number; y: number; width: number; height: number }

/** kCGDesktopIconWindowLevel + 2: where Sonoma+ draws desktop widgets. */
export const DESKTOP_WIDGET_LEVEL = -2147483601;

const SCRIPT = `
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
var arr = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID));
var out = [];
for (var i = 0; i < arr.count; i++) {
  var d = ObjC.deepUnwrap(arr.objectAtIndex(i)) || {};
  if (d.kCGWindowOwnerName !== 'Notification Center') continue;
  if (d.kCGWindowLayer !== ${DESKTOP_WIDGET_LEVEL}) continue;
  var b = d.kCGWindowBounds || {};
  if (!(b.Width >= 100 && b.Height >= 100)) continue;
  out.push([b.X, b.Y, b.Width, b.Height]);
}
JSON.stringify(out);
`;

let cache: { at: number; rects: Rect[] } | null = null;

export function getDesktopWidgetFrames(): Promise<Rect[]> {
  if (cache && Date.now() - cache.at < 2000) return Promise.resolve(cache.rects);
  return new Promise((resolve) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', SCRIPT], { timeout: 3000 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      try {
        const rects = (JSON.parse(stdout.toString().trim()) as number[][])
          .map(([x, y, width, height]) => ({ x, y, width, height }));
        cache = { at: Date.now(), rects };
        resolve(rects);
      } catch { resolve([]); }
    });
  });
}

/**
 * Snap `win` (our frame) onto the desktop-widget grid. macOS lays widgets out on 180px
 * cells (small = 1×1, medium = 2×1, large = 2×2), so every cell origin reachable from an
 * existing widget's origin in 180px steps is a candidate; the nearest one within
 * `threshold` wins. Returns null when nothing is close enough.
 */
export const GRID_CELL = 180;
export function snapToWidgets(win: Rect, widgets: Rect[], threshold = 72): { x: number; y: number } | null {
  type Best = { x: number; y: number; d: number };
  let best: Best | null = null;
  const consider = (x: number, y: number) => {
    const d = Math.hypot(x - win.x, y - win.y);
    if (d <= threshold && (!best || d < best.d)) best = { x, y, d };
  };
  for (const w of widgets) {
    for (let i = -8; i <= 8; i++) {
      for (let j = -8; j <= 8; j++) consider(w.x + i * GRID_CELL, w.y + j * GRID_CELL);
    }
  }
  const found = best as Best | null;
  return found ? { x: found.x, y: found.y } : null;
}
