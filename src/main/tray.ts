/** Menu-bar (tray) icon and its menu. All settings are toggled from here. */
import { Menu, Tray, nativeImage, app } from 'electron';
import { deflateSync } from 'node:zlib';
import type { BackgroundStyle, Settings, SizePreset, WindowLevel } from '../shared/types';

export interface TrayHandlers {
  toggleVisible(): void;
  setSize(s: SizePreset): void;
  setBackground(b: BackgroundStyle): void;
  setLevel(l: WindowLevel): void;
  setClickThrough(v: boolean): void;
  setLaunchAtLogin(v: boolean): void;
  setLyrics(v: boolean): void;
  quit(): void;
}

/**
 * Menu-bar icon: a tiny vinyl disc drawn as a template image (black + alpha) so macOS tints it
 * for light/dark menu bars. Rendered to PNG by hand: nativeImage cannot decode SVG, and an
 * undecodable image gives the Tray an empty (invisible) item.
 */
function trayIcon(): Electron.NativeImage {
  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, width: 16, height: 16, buffer: discPng(16) });
  img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: discPng(32) });
  img.setTemplateImage(true);
  return img;
}

/** Rasterise the disc at `size` px (4x4 supersampled for smooth edges) and encode as PNG. */
function discPng(size: number): Buffer {
  const SS = 4;
  const c = size / 2;
  const r = size * 0.44;
  const alphaAt = (x: number, y: number): number => {
    const d = Math.hypot(x - c, y - c) / r;      // 0 at centre, 1 at the rim
    if (d > 1) return 0;
    if (d < 0.14) return 1;                        // spindle hole rendered solid (label dot)
    if (d < 0.36) return 0.0;                      // label: transparent ring reads as a hole
    const groove = Math.abs(((d - 0.36) / 0.64) * 3 % 1 - 0.5) < 0.12 ? 0.55 : 1;
    return groove;
  };
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) a += alphaAt(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
      const i = (y * size + x) * 4;
      rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return encodePng(size, size, rgba);
}

function encodePng(w: number, h: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;                       // filter type: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let crcTable: Uint32Array | undefined;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function createTray(getSettings: () => Settings, h: TrayHandlers): Tray {
  const tray = new Tray(trayIcon());
  tray.setToolTip('Spotify Widget');

  const rebuild = () => {
    const s = getSettings();
    const menu = Menu.buildFromTemplate([
      { label: s.visible ? 'Hide Widget' : 'Show Widget', click: () => { h.toggleVisible(); rebuild(); } },
      { type: 'separator' },
      {
        label: 'Size',
        submenu: (['small', 'medium', 'large'] as SizePreset[]).map((size) => ({
          label: size[0].toUpperCase() + size.slice(1),
          type: 'radio',
          checked: s.size === size,
          click: () => { h.setSize(size); rebuild(); },
        })),
      },
      {
        label: 'Background style',
        submenu: ([
          ['blurred', 'Blurred art'],
          ['gradient', 'Solid gradient'],
          ['frosted', 'Frosted glass (no color)'],
        ] as [BackgroundStyle, string][]).map(([value, label]) => ({
          label,
          type: 'radio',
          checked: s.background === value,
          click: () => { h.setBackground(value); rebuild(); },
        })),
      },
      { label: 'Show lyrics', type: 'checkbox', checked: s.lyrics, click: (mi) => { h.setLyrics(mi.checked); rebuild(); } },
      { type: 'separator' },
      {
        label: 'Position',
        submenu: ([
          ['desktop', 'On the desktop (widget)'],
          ['floating', 'Float above windows'],
        ] as [WindowLevel, string][]).map(([value, label]) => ({
          label,
          type: 'radio',
          checked: s.level === value,
          click: () => { h.setLevel(value); rebuild(); },
        })),
      },
      { label: 'Click-through', type: 'checkbox', checked: s.clickThrough, click: (mi) => { h.setClickThrough(mi.checked); rebuild(); } },
      { label: 'Launch at login', type: 'checkbox', checked: s.launchAtLogin, click: (mi) => { h.setLaunchAtLogin(mi.checked); rebuild(); } },
      { type: 'separator' },
      { label: `Quit Spotify Widget`, accelerator: 'CmdOrCtrl+Q', click: () => h.quit() },
    ]);
    tray.setContextMenu(menu);
  };
  rebuild();
  app.on('browser-window-focus', rebuild);
  return tray;
}
