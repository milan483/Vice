import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || '/home/kylan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const browser = await chromium.launch({executablePath: process.env.PLAYER_BROWSER || '/opt/brave-origin-bin/brave', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required']});
const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const results = [];
const url = process.env.QUEUE_TEST_URL || 'http://127.0.0.1:5175/tools/player-browser/queue.html';
const next = page.getByRole('button', {name: 'Next clip', exact: true});
const previous = page.getByRole('button', {name: 'Previous clip', exact: true});
async function source(slug) {await page.waitForFunction(value => document.querySelector('.watch-video')?.getAttribute('src')?.includes(`queue=${value}`), slug);}
async function reset() {await page.goto(url); await page.waitForFunction(() => window.queueHarness?.ready);}
async function open(slug, queue) {await page.evaluate(({slug, queue}) => window.queueHarness.open(slug, queue), {slug, queue}); await source(slug);}
async function step(slug) {await next.click(); await source(slug);}
async function check(name, fn) {
  try {await reset(); await fn(); results.push({name, ok: true}); console.log(`PASS ${name}`);}
  catch (error) {results.push({name, ok: false, error: error.message}); console.error(`FAIL ${name}: ${error.message}`);}
}
try {
  await check('direct library opening snapshots additions and skips later deletions', async () => {
    await open('clip-0');
    await page.evaluate(() => {window.queueHarness.add('new-recording'); window.queueHarness.remove('clip-1');});
    await step('clip-2'); await previous.click(); await source('clip-0');
    assert.equal(await previous.isDisabled(), true);
  });
  await check('origin remains stable when source filters and library change', async () => {
    await page.evaluate(() => {window.queueHarness.view('clips'); window.queueHarness.search('Selected game');});
    await page.waitForFunction(() => window.queueHarness.visible.length === 5);
    await page.getByRole('button', {name: 'Open clip-0', exact: true}).click(); await source('clip-0');
    await page.evaluate(() => {window.queueHarness.search('Other game'); window.queueHarness.add('new-recording');});
    await step('clip-2'); await step('clip-4'); await step('clip-6'); await step('clip-8');
    assert.equal(await next.isDisabled(), true);
  });
  await check('playlist origin uses displayed clip order and survives playlist exit', async () => {
    await page.evaluate(() => window.queueHarness.view('clips', 'selected'));
    await page.waitForFunction(() => window.queueHarness.visible.length === 3);
    await page.getByRole('button', {name: 'Open clip-0', exact: true}).click(); await source('clip-0');
    await page.evaluate(() => window.queueHarness.view('clips'));
    await step('clip-4'); await step('clip-8'); assert.equal(await next.isDisabled(), true);
  });
  await check('Home recent row stops after the eight displayed cards', async () => {
    await page.locator('.home-section').filter({has: page.getByRole('heading', {name: 'Recent clips', exact: true})}).getByRole('button', {name: 'Open clip-7', exact: true}).click();
    await source('clip-7'); assert.equal(await next.isDisabled(), true);
    await previous.click(); await source('clip-6');
  });
  await check('Home most viewed uses its displayed ranking', async () => {
    await page.locator('.home-section').filter({has: page.getByRole('heading', {name: 'Most viewed', exact: true})}).getByRole('button', {name: 'Open clip-8', exact: true}).click();
    await source('clip-8'); assert.equal(await previous.isDisabled(), true);
    await step('clip-9'); await step('clip-0');
  });
  await check('context menu Open retains filtered origin', async () => {
    await page.evaluate(() => {window.queueHarness.view('clips'); window.queueHarness.search('Selected game');});
    await page.getByRole('button', {name: 'Open clip-0', exact: true}).click({button: 'right'});
    await page.getByRole('menuitem', {name: 'Open', exact: true}).click();
    await source('clip-0'); await step('clip-2');
  });
  await check('active rename survives daemon deletion and retains queue position', async () => {
    await open('clip-0', ['clip-0', 'clip-2', 'clip-4']);
    await page.evaluate(() => window.queueHarness.rename('clip-0', 'renamed-current'));
    await source('renamed-current'); await step('clip-2'); await previous.click(); await source('renamed-current');
  });
  await check('later rename stays navigable and active deletion closes viewer', async () => {
    await open('clip-0', ['clip-0', 'clip-2', 'clip-4']);
    await page.evaluate(() => window.queueHarness.rename('clip-2', 'renamed-later'));
    await step('renamed-later'); await step('clip-4');
    await page.evaluate(() => window.queueHarness.remove('clip-4'));
    await page.waitForFunction(() => !document.querySelector('.watch-video'));
  });
  await check('late old-clip highlights response cannot overwrite the current clip', async () => {
    await page.evaluate(() => window.queueHarness.hold('clip-0'));
    await open('clip-0', ['clip-0', 'clip-2']);
    await step('clip-2');
    await page.waitForFunction(() => [...document.querySelectorAll('.watch-marker')].some(marker => marker.getAttribute('aria-label')?.includes('Marker clip-2')));
    await page.evaluate(() => window.queueHarness.release('clip-0'));
    await page.waitForTimeout(80);
    assert.equal(await page.locator('.watch-marker').count(), 1);
    assert.ok((await page.locator('.watch-marker').getAttribute('aria-label')).includes('Marker clip-2'));
  });
  await check('source change clears old highlights while next fetch is pending', async () => {
    await open('clip-0', ['clip-0', 'clip-2']);
    await page.waitForFunction(() => [...document.querySelectorAll('.watch-marker')].some(marker => marker.getAttribute('aria-label')?.includes('Marker clip-0')));
    await page.evaluate(() => window.queueHarness.hold('clip-2'));
    await step('clip-2');
    assert.equal(await page.locator('.watch-marker').count(), 0, 'Old clip highlights remained on the next clip while its request was pending');
    await page.evaluate(() => window.queueHarness.release('clip-2'));
    await page.waitForFunction(() => [...document.querySelectorAll('.watch-marker')].some(marker => marker.getAttribute('aria-label')?.includes('Marker clip-2')));
  });
  await check('delayed initial GET refetches after H and retains saved plus new markers', async () => {
    await page.evaluate(() => window.queueHarness.hold('clip-0'));
    await open('clip-0', ['clip-0', 'clip-2']);
    await page.waitForFunction(() => window.queueHarness.pending('clip-0'));
    await page.waitForFunction(() => Number.isFinite(document.querySelector('.watch-video')?.duration));
    await page.keyboard.press('h');
    await page.waitForFunction(() => document.querySelectorAll('.watch-marker').length === 1);
    const addedLabel = await page.locator('.watch-marker').getAttribute('aria-label');
    assert.ok(!addedLabel.includes('Marker clip-0'));
    await page.evaluate(() => window.queueHarness.release('clip-0'));
    await page.waitForFunction(() => document.querySelectorAll('.watch-marker').length === 2);
    const labels = await page.locator('.watch-marker').evaluateAll(markers => markers.map(mark => mark.getAttribute('aria-label')));
    assert.ok(labels.includes(addedLabel), 'Newly saved marker disappeared during the refetch');
    assert.ok(labels.some(label => label.includes('Marker clip-0')), 'Previously saved marker was lost');
  });
  await check('failed delayed initial GET retains a successful local H mutation', async () => {
    await page.evaluate(() => window.queueHarness.hold('clip-0'));
    await open('clip-0', ['clip-0', 'clip-2']);
    await page.waitForFunction(() => window.queueHarness.pending('clip-0'));
    await page.waitForFunction(() => Number.isFinite(document.querySelector('.watch-video')?.duration));
    await page.keyboard.press('h');
    await page.waitForFunction(() => document.querySelectorAll('.watch-marker').length === 1);
    const label = await page.locator('.watch-marker').getAttribute('aria-label');
    await page.evaluate(() => window.queueHarness.release('clip-0', true));
    await page.waitForTimeout(80);
    assert.equal(await page.locator('.watch-marker').count(), 1);
    assert.equal(await page.locator('.watch-marker').getAttribute('aria-label'), label);
  });
  assert.deepEqual(errors, []);
} finally {await browser.close();}
await fs.mkdir('/tmp/vice-player-browser', {recursive: true});
await fs.writeFile('/tmp/vice-player-browser/queue-results.json', JSON.stringify({results, errors}, null, 2));
if (results.some(result => !result.ok) || errors.length) process.exitCode = 1;
