// Dev tool: prints the extracted palette for every cached cover.
// Usage: npx electron scripts/palette-test.cjs [dir]
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
app.whenReady().then(() => {
  const { extractPalette } = require('../.cache/palette-test-bundle.js');
  const dir = process.argv[2] || path.join(app.getPath('appData'), 'SpotifyWidget', 'artwork');
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jpg'))) {
    console.log(f, JSON.stringify(extractPalette(path.join(dir, f))));
  }
  app.quit();
});
