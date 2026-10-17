// One-time interactive sign-in for the dedicated test profile. Never imports credentials.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = path.join(os.homedir(), '.local/share/xpandmax-test/browser-profile');
await fs.mkdir(profile, { recursive: true, mode: 0o700 });
await fs.chmod(profile, 0o700);
const extension = path.join(root, 'extension');
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: false,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
});
try {
  const page = await context.newPage();
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
  console.log('Dedicated X test browser is open. Complete X sign-in in this Chromium window. No manual extension loading is needed.');
  // A rendered composer is evidence of an authenticated app, rather than just a /home URL.
  await page.locator('[data-testid="tweetTextarea_0"]').waitFor({ timeout: 0 });
  console.log('Authenticated X app is visible. Dedicated session saved; future test:browser:live runs reuse this profile.');
} finally {
  await context.close();
}
