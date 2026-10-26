/** Real Chromium regressions for overlapping production Viewer highlight writes.
 * Start the browser fixture Vite server, then run node tools/player-browser/highlights-check.mjs.
 * API responses are held and released in one browser task to exercise React batching.
 */
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || '/home/kylan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const browser = await chromium.launch({
  executablePath: process.env.PLAYER_BROWSER || '/opt/brave-origin-bin/brave', headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
const results = [];
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const url = process.env.PLAYER_TEST_URL || 'http://127.0.0.1:5175/tools/player-browser/index.html';
const output = process.env.PLAYER_TEST_OUTPUT || '/tmp/vice-player-browser';

async function prepare() {
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('video')?.videoWidth === 640);
  await page.evaluate(() => {
    document.querySelector('video').pause();
    window.pendingHighlights = [];
    const original = window.fetch.bind(window);
    window.fetch = (path, options) => {
      if (String(path).includes('/highlights') && ['POST', 'PATCH', 'DELETE'].includes(options?.method)) {
        const method = options.method;
        const request = {method, path: String(path), body: options.body ? JSON.parse(options.body) : null};
        return new Promise(resolve => {
          const index = window.pendingHighlights.length;
          request.release = (success = true) => resolve({
            ok: true, status: method === 'DELETE' ? 204 : 200,
            json: async () => method === 'POST'
              ? {highlight: {id: `concurrent-${index}`, time: 8 + index, label: `Concurrent ${index}`, color: '#ffffff'}}
              : success ? {ok: true} : {ok: false, error: 'Forced highlight move rejection'},
          });
          window.pendingHighlights.push(request);
        });
      }
      return original(path, options);
    };
  });
}
async function release(count, reverse = false) {
  await page.waitForFunction(expected => window.pendingHighlights.length === expected, count);
  // Resolve every API call together: updates must compose before React renders.
  await page.evaluate(reverse => {
    const requests = [...window.pendingHighlights];
    if (reverse) requests.reverse();
    requests.forEach(request => request.release());
  }, reverse);
}
async function check(name, callback) {
  try {
    await prepare();
    await callback();
    results.push({name, ok: true});
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({name, ok: false, error: error.message});
    console.error(`FAIL ${name}: ${error.message}`);
    await fs.mkdir(output, {recursive: true});
    await page.screenshot({path: `${output}/highlights-${results.length}-failure.png`});
  }
}

async function markerPosition() {
  return page.locator('.watch-marker').first().evaluate(marker => Number.parseFloat(marker.style.left));
}
async function beginDrag(fraction = 0.4) {
  const marker = await page.locator('.watch-marker').first().boundingBox();
  const track = await page.locator('.watch-seek').boundingBox();
  assert.ok(marker && track, 'Highlight marker and seek track must be visible');
  await page.mouse.move(marker.x + marker.width / 2, marker.y + marker.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width * fraction, marker.y + marker.height / 2, {steps: 6});
  await page.waitForFunction(expected => Math.abs(Number.parseFloat(document.querySelector('.watch-marker').style.left) - expected) < 0.5, fraction * 100);
  return {x: track.x + track.width * fraction, y: marker.y + marker.height / 2};
}

try {
  await check('simultaneous adds retain both distinct returned highlights', async () => {
    await page.keyboard.press('h');
    await page.keyboard.press('h');
    await release(2);
    await page.waitForFunction(() => document.querySelectorAll('.watch-marker').length === 4);
    const titles = await page.locator('.watch-marker').evaluateAll(markers => markers.map(marker => marker.title));
    assert.ok(titles.some(title => title.startsWith('Concurrent 0')));
    assert.ok(titles.some(title => title.startsWith('Concurrent 1')));
  });

  await check('concurrent patch delete and add compose without losing unrelated changes', async () => {
    await page.getByRole('button', {name: 'Highlights', exact: true}).click();
    await page.getByRole('button', {name: 'Change the colour of First moment', exact: true}).click();
    const dot = page.locator('.hl-picker-dot').first();
    const chosenColor = await dot.evaluate(element => element.style.backgroundColor);
    await dot.click();
    await page.getByRole('button', {name: 'Remove Second moment', exact: true}).click();
    // A keyboard action remains usable while the highlight panel is open.
    await page.keyboard.press('h');
    await release(3, true);
    await page.waitForFunction(() => document.querySelectorAll('.watch-marker').length === 2 && ![...document.querySelectorAll('.watch-marker')].some(marker => marker.title.startsWith('Second moment')));
    const markers = await page.locator('.watch-marker').evaluateAll(elements => elements.map(element => ({title: element.title, color: element.style.backgroundColor})));
    assert.equal(markers.find(marker => marker.title.startsWith('First moment'))?.color, chosenColor);
    assert.ok(markers.some(marker => marker.title.startsWith('Concurrent 2')));
    assert.equal(await page.locator('.hl-item').count(), 2);
  });

  await check('late mutation from a previous clip does not contaminate the next clip', async () => {
    await page.keyboard.press('h');
    await page.waitForFunction(() => window.pendingHighlights.length === 1);
    await page.getByRole('button', {name: 'Next clip', exact: true}).click();
    await page.waitForFunction(() => document.querySelector('video').src.includes('clip=1'));
    await release(1);
    // Wait until the post-response notification proves that the callback ran.
    await page.waitForFunction(() => window.playerHarness.notifications.length > 0);
    assert.equal(await page.locator('.watch-marker').count(), 2);
    assert.ok((await page.locator('.watch-marker').evaluateAll(markers => markers.map(marker => marker.title))).every(title => !title.startsWith('Concurrent')));
  });

  await check('real pointer drag persists the displayed highlight timestamp', async () => {
    await beginDrag();
    const movedPercent = await markerPosition();
    await page.mouse.up();
    await page.waitForFunction(() => window.pendingHighlights.length === 1);
    const request = await page.evaluate(() => {
      const {method, path, body} = window.pendingHighlights[0];
      return {method, path, body, duration: document.querySelector('video').duration};
    });
    assert.equal(request.method, 'PATCH');
    assert.ok(request.path.endsWith('/highlights/1'));
    assert.ok(Math.abs(request.body.time - movedPercent / 100 * request.duration) < 0.01);
    await release(1);
    await page.waitForTimeout(50);
    assert.ok(Math.abs(await markerPosition() - movedPercent) < 0.01);
  });

  await check('rejected pointer drag restores the original marker position', async () => {
    const originalPercent = await markerPosition();
    await beginDrag();
    await page.mouse.up();
    await page.waitForFunction(() => window.pendingHighlights.length === 1);
    await page.evaluate(() => window.pendingHighlights[0].release(false));
    await page.waitForFunction(original => Math.abs(Number.parseFloat(document.querySelector('.watch-marker').style.left) - original) < 0.01, originalPercent);
    assert.ok((await page.evaluate(() => window.playerHarness.notifications)).length > 0);
  });

  await check('pointer cancellation restores the marker without a persistence request', async () => {
    const originalPercent = await markerPosition();
    const point = await beginDrag();
    await page.evaluate(point => window.dispatchEvent(new PointerEvent('pointercancel', {pointerId: 1, clientX: point.x, clientY: point.y, bubbles: true})), point);
    await page.waitForFunction(original => Math.abs(Number.parseFloat(document.querySelector('.watch-marker').style.left) - original) < 0.01, originalPercent);
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.pendingHighlights.length), 0);
  });

  await check('switching clip mid-drag removes listeners and prevents cross-clip persistence', async () => {
    const point = await beginDrag();
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForFunction(() => document.querySelector('video').src.includes('clip=1') && document.querySelector('video').duration > 0);
    const nextClipPosition = await markerPosition();
    await page.mouse.move(point.x + 120, point.y, {steps: 4});
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.pendingHighlights.length), 0);
    assert.equal(await markerPosition(), nextClipPosition);
  });
} finally {
  await browser.close();
}
await fs.mkdir(output, {recursive: true});
await fs.writeFile(`${output}/highlights-results.json`, JSON.stringify({results, errors}, null, 2));
if (results.some(result => !result.ok) || errors.length) process.exitCode = 1;
