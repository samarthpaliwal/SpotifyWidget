/**
 * Preload: the only bridge between the sandboxed renderer and the main process.
 * contextIsolation is on and nodeIntegration is off; the renderer sees only `window.widget`.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { ControlCommand, Lyrics, NowPlaying, Settings, WidgetApi } from '../shared/types';
import { IPC } from '../shared/types';

const api: WidgetApi = {
  onNowPlaying(cb) {
    const handler = (_e: Electron.IpcRendererEvent, np: NowPlaying) => cb(np);
    ipcRenderer.on(IPC.nowPlaying, handler);
    return () => ipcRenderer.removeListener(IPC.nowPlaying, handler);
  },
  onSettings(cb) {
    const handler = (_e: Electron.IpcRendererEvent, s: Settings) => cb(s);
    ipcRenderer.on(IPC.settings, handler);
    return () => ipcRenderer.removeListener(IPC.settings, handler);
  },
  onLyrics(cb) {
    const handler = (_e: Electron.IpcRendererEvent, l: Lyrics) => cb(l);
    ipcRenderer.on(IPC.lyrics, handler);
    return () => ipcRenderer.removeListener(IPC.lyrics, handler);
  },
  control(cmd: ControlCommand) { ipcRenderer.send(IPC.control, cmd); },
  seek(seconds: number) { ipcRenderer.send(IPC.seek, seconds); },
  ready() { ipcRenderer.send(IPC.ready); },
};

contextBridge.exposeInMainWorld('widget', api);
