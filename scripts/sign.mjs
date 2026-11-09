// Ad-hoc signs the packaged app with our entitlements. electron-builder only embeds
// entitlements when it signs, and we build without a Developer ID (identity: null), so
// without this step the com.apple.security.automation.apple-events entitlement would be
// missing. Ad-hoc signatures work locally; for distribution use a real identity instead.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const candidates = ['out/mac-arm64/SpotifyWidget.app', 'out/mac/SpotifyWidget.app', 'out/mac-universal/SpotifyWidget.app'];
const app = candidates.find((p) => existsSync(p));
if (!app) { console.error('sign: no packaged app found in out/'); process.exit(1); }

execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--entitlements', 'build/entitlements.mac.plist', app], { stdio: 'inherit' });
console.log(`sign: ad-hoc signed ${app}`);
