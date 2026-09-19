#!/usr/bin/env bash
# Playwright headless test for calendar grab flow
# Usage: ./scripts/test-calendar-grab.sh [SERVER_URL] [API_KEY]
#
# Requires: npx playwright (auto-installs on first run)
set -e

SERVER="${1:-http://localhost:8001}"
API_KEY="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -z "$API_KEY" ]; then
  echo "Usage: $0 <server_url> <api_key>"
  echo "Example: $0 http://111.111.111.111:8001 your-api-key-here"
  exit 1
fi

echo "🧪 Calendar grab flow test — $SERVER"
echo ""

# Write the test file
cat > /tmp/test-calendar-grab.mjs << 'TESTEOF'
import { chromium } from 'playwright';

const SERVER = process.env.SERVER;
const API_KEY = process.env.API_KEY;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

// Collect console logs and network errors
const logs = [];
page.on('console', msg => logs.push(`[console] ${msg.type()}: ${msg.text()}`));
page.on('requestfailed', req => logs.push(`[network-fail] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`));

// Intercept API responses for debugging
page.on('response', async resp => {
  const url = resp.url();
  if (url.includes('/api/calendar/') || url.includes('/api/v3/')) {
    const status = resp.status();
    let body = '';
    try { body = (await resp.text()).slice(0, 500); } catch {}
    logs.push(`[api] ${status} ${url.split('?')[0]} → ${body}`);
  }
});

try {
  // 1. Navigate to app
  console.log('1️⃣  Navigating to app...');
  await page.goto(SERVER, { waitUntil: 'networkidle', timeout: 15000 });
  console.log(`   ✅ Page loaded: ${await page.title()}`);

  // 2. Navigate to Calendar page
  console.log('2️⃣  Opening Calendar page...');
  // Try sidebar nav link
  const calLink = page.locator('a, button, div').filter({ hasText: /Calendario|Calendar/i }).first();
  if (await calLink.isVisible()) {
    await calLink.click();
    await page.waitForTimeout(2000);
  }
  console.log(`   ✅ Calendar page URL: ${page.url()}`);

  // 3. Find and click a calendar item to open modal
  console.log('3️⃣  Looking for calendar items...');
  // Take screenshot to see what's on screen
  await page.screenshot({ path: '/tmp/calendar-page.png' });
  console.log('   📸 Screenshot saved: /tmp/calendar-page.png');

  // Try clicking on a calendar item card/row
  const items = page.locator('.calendar-item, .calendar-card, [class*="calendar"] [class*="item"], tr[class*="row"]');
  const count = await items.count();
  console.log(`   Found ${count} calendar items`);

  if (count > 0) {
    await items.first().click();
    await page.waitForTimeout(1500);
    console.log('   ✅ Clicked first calendar item');
    await page.screenshot({ path: '/tmp/calendar-modal.png' });
    console.log('   📸 Screenshot saved: /tmp/calendar-modal.png');
  } else {
    console.log('   ⚠️  No calendar items found — taking screenshot for analysis');
  }

  // 4. Check if modal opened and select indexer
  console.log('4️⃣  Checking for modal/indexer selector...');
  const indexerDropdown = page.locator('select.calendar-indexer-dropdown, select[class*="indexer"]');
  if (await indexerDropdown.isVisible({ timeout: 3000 })) {
    const options = await indexerDropdown.locator('option').allTextContents();
    console.log(`   Indexer options: ${options.join(', ')}`);

    // Select AMULE if available, otherwise first non-"all" option
    const amuleOption = options.find(o => /amule|amulet/i.test(o));
    if (amuleOption) {
      await indexerDropdown.selectOption({ label: amuleOption });
      console.log(`   ✅ Selected indexer: ${amuleOption}`);
    } else if (options.length > 1) {
      await indexerDropdown.selectOption({ index: 1 });
      console.log(`   ✅ Selected first indexer: ${options[1]}`);
    }
  } else {
    console.log('   ⚠️  No indexer dropdown visible');
  }

  // 5. Click search
  console.log('5️⃣  Clicking search...');
  const searchBtn = page.locator('button').filter({ hasText: /Buscar|Search/i }).first();
  if (await searchBtn.isVisible({ timeout: 3000 })) {
    await searchBtn.click();
    console.log('   ✅ Search clicked — waiting for results (up to 240s)...');

    // Wait for results or error (up to 250s)
    try {
      await page.waitForSelector('.calendar-releases, .calendar-modal-status.status-error', { timeout: 250000 });
      await page.screenshot({ path: '/tmp/calendar-results.png' });
      console.log('   📸 Screenshot saved: /tmp/calendar-results.png');

      // Check for results
      const releases = page.locator('.release-row, .release-item, [class*="release"]');
      const releaseCount = await releases.count();
      console.log(`   ✅ Found ${releaseCount} release elements`);

      // 6. Try grab first release
      if (releaseCount > 0) {
        console.log('6️⃣  Attempting grab...');
        const grabBtn = page.locator('button').filter({ hasText: /⬇️|Descargar|Grab/i }).first();
        if (await grabBtn.isVisible({ timeout: 3000 })) {
          await grabBtn.click();
          await page.waitForTimeout(5000);
          await page.screenshot({ path: '/tmp/calendar-grab-result.png' });
          console.log('   📸 Screenshot saved: /tmp/calendar-grab-result.png');

          // Check result
          const statusEl = page.locator('.calendar-modal-status');
          if (await statusEl.isVisible({ timeout: 3000 })) {
            const statusText = await statusEl.textContent();
            console.log(`   Grab result: ${statusText}`);
          }
        } else {
          console.log('   ⚠️  No grab button visible');
        }
      }
    } catch {
      await page.screenshot({ path: '/tmp/calendar-timeout.png' });
      console.log('   ⏰ Timed out waiting for results — screenshot saved: /tmp/calendar-timeout.png');
    }
  } else {
    console.log('   ⚠️  No search button found');
  }

  // Print collected logs
  console.log('\n--- Collected logs ---');
  for (const log of logs) {
    console.log(log);
  }

} catch (err) {
  console.error('❌ Test error:', err.message);
  await page.screenshot({ path: '/tmp/calendar-error.png' }).catch(() => {});
  console.log('   📸 Error screenshot saved: /tmp/calendar-error.png');

  console.log('\n--- Collected logs ---');
  for (const log of logs) {
    console.log(log);
  }
} finally {
  await browser.close();
}
TESTEOF

echo "🧪 Running test against $SERVER..."
echo ""
SERVER="$SERVER" API_KEY="$API_KEY" npx playwright test --config=/dev/null 2>/dev/null || \
  SERVER="$SERVER" API_KEY="$API_KEY" node /tmp/test-calendar-grab.mjs

echo ""
echo "📸 Screenshots saved in /tmp/calendar-*.png"
