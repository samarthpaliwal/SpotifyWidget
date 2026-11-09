/** The floating widget window: frameless, transparent, always-on-top, all Spaces. */
import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import type { Settings, SizePreset, WindowLevel } from '../shared/types';
import { SIZE_PRESETS } from '../shared/types';
import { DESKTOP_WIDGET_LEVEL, getDesktopWidgetFrames, snapToWidgets } from './desktopWidgets';

export function createWidgetWindow(settings: Settings): BrowserWindow {
  const { width, height } = SIZE_PRESETS[settings.size];
  const win = new BrowserWindow({
    width,
    height,
    x: settings.bounds?.x,
    y: settings.bounds?.y,
    frame: false,
    transparent: true,
    hasShadow: false,          // the card draws its own CSS shadow
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    show: false,
    acceptFirstMouse: true,    // first click on the widget acts, it doesn't just focus
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true, // pause rendering work when hidden
    },
  });

  applyLevel(win, settings.level);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(settings.clickThrough);
  clampToScreen(win);
  void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  return win;
}

/**
 * Window level.
 * - desktop: the exact window level macOS uses for its own desktop widgets
 *   (kCGDesktopIconWindowLevel + 2), so ours stacks with them: above the wallpaper and
 *   desktop icons, below every app window, still clickable. Hidden from Mission Control.
 * - floating: NSFloatingWindowLevel, above all normal windows.
 */
export function applyLevel(win: BrowserWindow, level: WindowLevel): void {
  if (level === 'floating') {
    win.setAlwaysOnTop(true, 'floating');
    win.setHiddenInMissionControl(false);
  } else {
    // 'normal' is NSNormalWindowLevel (0); the relative offset puts us at the widget level.
    win.setAlwaysOnTop(true, 'normal', DESKTOP_WIDGET_LEVEL);
    win.setHiddenInMissionControl(true);
  }
}

/**
 * After the user drops the card, align it with the system desktop widgets (same grid,
 * directly beside the nearest one). Falls back to the screen edge with the same 8px margin.
 */
export async function snapToDesktopGrid(win: BrowserWindow): Promise<boolean> {
  const b = win.getBounds();
  const widgets = await getDesktopWidgetFrames();
  let target = snapToWidgets(b, widgets);
  console.log(`[snap] from ${b.x},${b.y} widgets=${widgets.length} -> ${target ? target.x + ',' + target.y : 'none'}`);
  if (!target) {
    const area = screen.getDisplayMatching(b).workArea;
    const margin = 8;
    const nearLeft = Math.abs(b.x - (area.x + margin)) < 48;
    const nearRight = Math.abs(b.x + b.width - (area.x + area.width - margin)) < 48;
    const nearTop = Math.abs(b.y - (area.y + margin)) < 48;
    const nearBottom = Math.abs(b.y + b.height - (area.y + area.height - margin)) < 48;
    if (nearLeft || nearRight || nearTop || nearBottom) {
      target = {
        x: nearLeft ? area.x + margin : nearRight ? area.x + area.width - margin - b.width : b.x,
        y: nearTop ? area.y + margin : nearBottom ? area.y + area.height - margin - b.height : b.y,
      };
    }
  }
  if (!target || (target.x === b.x && target.y === b.y)) return false;
  if (win.isDestroyed()) return false;
  win.setPosition(Math.round(target.x), Math.round(target.y), true);
  return true;
}

export function applySize(win: BrowserWindow, size: SizePreset): void {
  const { width, height } = SIZE_PRESETS[size];
  const [x, y] = win.getPosition();
  win.setBounds({ x, y, width, height }, true);
  clampToScreen(win);
}

/** Keep the window reachable if the saved position is off-screen (display removed, etc.). */
function clampToScreen(win: BrowserWindow): void {
  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const x = Math.min(Math.max(b.x, area.x), area.x + area.width - b.width);
  const y = Math.min(Math.max(b.y, area.y), area.y + area.height - b.height);
  if (x !== b.x || y !== b.y) win.setPosition(x, y);
}
