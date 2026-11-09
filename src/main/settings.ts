/** Tiny JSON settings store in <userData>/settings.json. No dependencies. */
import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Settings } from '../shared/types';

const DEFAULTS: Settings = {
  size: 'medium',
  background: 'blurred',
  level: 'desktop',
  clickThrough: false,
  launchAtLogin: false,
  lyrics: false,
  visible: true,
  bounds: null,
};

export class SettingsStore {
  private file = path.join(app.getPath('userData'), 'settings.json');
  private data: Settings;

  constructor() {
    let loaded: Partial<Settings> = {};
    try { loaded = JSON.parse(readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    this.data = { ...DEFAULTS, ...loaded };
  }

  get(): Settings { return this.data; }

  set(patch: Partial<Settings>): Settings {
    this.data = { ...this.data, ...patch };
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.warn('[settings] save failed:', (err as Error).message);
    }
    return this.data;
  }
}
