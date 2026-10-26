import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || '/home/kylan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const output = process.env.PLAYER_TEST_OUTPUT || '/tmp/vice-player-browser';
await fs.mkdir(output, {recursive: true});
const browser = await chromium.launch({
  executablePath: process.env.PLAYER_BROWSER || '/opt/brave-origin-bin/brave', headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
const page = await context.newPage();
const results = [];
const errors = [];
const requests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {if (request.url().includes('/api/')) requests.push({url: request.url(), method: request.method(), data: request.postData()});});
const url = process.env.PLAYER_TEST_URL || 'http://127.0.0.1:5175/tools/player-browser/index.html';
const video = page.locator('.watch-video');
const button = name => page.getByRole('button', {name, exact: true}).first();
async function media() {
  return video.evaluate(v => ({time: v.currentTime, duration: v.duration, paused: v.paused,
    muted: v.muted, volume: v.volume, rate: v.playbackRate, src: v.currentSrc,
    width: v.videoWidth, height: v.videoHeight}));
}
async function until(fn, message, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await page.waitForTimeout(50);
  }
  assert.fail(message);
}
async function check(name, fn) {
  try { await fn(); results.push({name, ok: true}); console.log(`PASS ${name}`); }
  catch (error) {
    results.push({name, ok: false, error: error.message}); console.error(`FAIL ${name}: ${error.message}`);
    await page.screenshot({path: `${output}/${results.length}-failure.png`, fullPage: true});
  }
}
async function pauseAt(time = 10) {
  await video.evaluate((v, t) => {v.pause(); v.currentTime = t;}, time);
  await page.waitForTimeout(100);
}
async function closeExternal() {
  await page.evaluate(() => window.playerHarness.openOverlay(null));
  await page.waitForTimeout(400);
}

try {
  await page.goto(url);
  await check('real media decodes and starts', async () => {
    await until(async () => (await media()).width === 640, 'H.264 fixture did not decode', 12000);
    await until(async () => (await media()).time > 0.1, 'Playback did not advance');
    assert.equal(await video.count(), 1);
    assert.equal((await media()).volume, 1, 'first-launch volume must be full');
    assert.equal((await media()).muted, false, 'first-launch playback must be unmuted');
    assert.equal((await media()).rate, 1, 'first-launch speed must be normal');
    await page.screenshot({path: `${output}/viewer.png`, fullPage: true});
  });
  await check('source switch keeps one video and starts the next clip', async () => {
    await video.evaluate(v => {v.dataset.identity = 'original';});
    await button('Next clip').click();
    await until(async () => (await media()).src.includes('clip=1'), 'Next source was not attached');
    await until(async () => (await media()).width === 640 && (await media()).time > 0, 'Next clip did not play');
    assert.equal(await video.getAttribute('data-identity'), 'original');
    await button('Previous clip').click();
    await until(async () => (await media()).src.includes('clip=0'), 'Previous source was not attached');
  });
  await check('pending stage click cannot pause a newly selected clip', async () => {
    await video.evaluate(v => {v.currentTime = 5; void v.play();});
    const box = await video.boundingBox();
    await video.click({position: {x: box.width * 0.25, y: box.height * 0.5}});
    await page.keyboard.press('Shift+ArrowRight');
    await until(async () => (await media()).src.includes('clip=1'), 'immediate keyboard switch did not select next clip');
    await page.waitForTimeout(400);
    assert.equal((await media()).paused, false, 'delayed stage click paused the next clip');
    await button('Previous clip').click();
    await until(async () => (await media()).src.includes('clip=0'), 'could not restore first clip');
  });
  await check('keyboard seek clamps to media bounds', async () => {
    await pauseAt(10);
    await video.focus();
    await page.keyboard.press('ArrowRight');
    await until(async () => (await media()).time > 10, 'Right arrow did not seek forward');
    await page.keyboard.press('ArrowLeft');
    await until(async () => Math.abs((await media()).time - 10) < 0.5, 'Left arrow did not seek back');
    await pauseAt(0.1);
    await page.keyboard.press('ArrowLeft');
    assert.ok((await media()).time >= 0);
    await pauseAt(29.8);
    await page.keyboard.press('ArrowRight');
    assert.ok((await media()).time <= (await media()).duration);
  });
  await check('volume focus owns its arrow keys', async () => {
    await pauseAt(10);
    const volume = page.getByRole('slider', {name: 'Volume', exact: true});
    await volume.focus();
    await page.keyboard.press('ArrowLeft');
    assert.ok(Math.abs((await media()).time - 10) < 0.5, 'Volume arrow also sought the video');
  });
  await check('mute persists through source changes and reload', async () => {
    const mute = button('Mute');
    if (!(await mute.count())) await button('Unmute').click();
    await button('Mute').click();
    assert.equal((await media()).muted, true);
    await button('Next clip').click();
    await until(async () => (await media()).src.includes('clip=1'), 'source switch failed');
    assert.equal((await media()).muted, true);
    await page.reload();
    await until(async () => (await media()).width === 640, 'reload did not decode');
    assert.equal((await media()).muted, true);
  });
  await check('speed persists through source changes and reload without restarting paused playback', async () => {
    await pauseAt(10);
    await page.getByLabel('Playback speed', {exact: true}).selectOption('1.5');
    assert.equal((await media()).rate, 1.5);
    assert.equal((await media()).paused, true);
    await button('Next clip').click();
    await until(async () => (await media()).src.includes('clip=1'), 'speed source switch failed');
    assert.equal((await media()).rate, 1.5);
    await page.reload();
    await until(async () => (await media()).width === 640, 'speed reload did not decode');
    assert.equal((await media()).rate, 1.5);
    await page.getByLabel('Playback speed', {exact: true}).selectOption('1');
  });
  await check('window fill and browser fullscreen preserve paused media identity and timestamp', async () => {
    await pauseAt(12);
    await video.evaluate(v => {v.dataset.identity = 'mode-check';});
    const before = await media();
    for (const label of ['Fill the window', 'Back to normal size', 'Enter fullscreen', 'Exit fullscreen']) {
      await button(label).click();
      await page.waitForTimeout(180);
      assert.equal(await video.getAttribute('data-identity'), 'mode-check');
      assert.equal((await media()).src, before.src);
      assert.equal((await media()).paused, true);
      assert.ok(Math.abs((await media()).time - before.time) < 0.05, `${label} changed playback time`);
    }
    assert.equal(await page.evaluate(() => document.fullscreenElement === null), true);
  });
  await check('double-click toggles fullscreen without toggling playback', async () => {
    await pauseAt(10);
    const doubleClickVideo = async () => {
      const box = await video.boundingBox();
      await video.dblclick({position: {x: box.width * 0.25, y: box.height * 0.5}});
    };
    await doubleClickVideo();
    await until(async () => !!(await page.evaluate(() => document.fullscreenElement)), 'double click did not enter fullscreen');
    await page.waitForTimeout(350);
    assert.equal((await media()).paused, true);
    await doubleClickVideo();
    await until(async () => !(await page.evaluate(() => document.fullscreenElement)), 'double click did not exit fullscreen');
    await page.waitForTimeout(350);
    assert.equal((await media()).paused, true);
  });
  await check('playing mode changes keep media running and double-click never pauses it', async () => {
    await video.evaluate(v => {v.currentTime = 10; v.dataset.identity = 'playing'; void v.play();});
    const source = (await media()).src;
    await button('Fill the window').click();
    await button('Back to normal size').click();
    let box = await video.boundingBox();
    await video.dblclick({position: {x: box.width * 0.25, y: box.height * 0.5}});
    await until(async () => !!(await page.evaluate(() => document.fullscreenElement)), 'playing double-click did not enter fullscreen');
    await page.waitForTimeout(350);
    assert.equal((await media()).paused, false);
    assert.ok((await media()).time >= 10);
    await button('Exit fullscreen').click();
    assert.equal(await video.getAttribute('data-identity'), 'playing');
    assert.equal((await media()).src, source);
    assert.equal((await media()).paused, false);
  });
  await check('recognized slow double-click preserves initial paused and playing state', async () => {
    const cdp = await context.newCDPSession(page);
    try { for (const initiallyPaused of [true, false]) {
      await video.evaluate((v, paused) => {v.currentTime = 10; if (paused) v.pause(); else void v.play();}, initiallyPaused);
      const box = await video.boundingBox();
      const position = {x: box.width * 0.25, y: box.height * 0.5};
      await video.click({position});
      await page.waitForTimeout(350);
      assert.equal((await media()).paused, !initiallyPaused, 'first click did not perform its delayed toggle');
      const secondClick = {x: box.x + position.x, y: box.y + position.y, button: 'left', clickCount: 2};
      await cdp.send('Input.dispatchMouseEvent', {type: 'mousePressed', ...secondClick});
      await cdp.send('Input.dispatchMouseEvent', {type: 'mouseReleased', ...secondClick});
      await until(async () => !!(await page.evaluate(() => document.fullscreenElement)), 'slow recognized double-click did not enter fullscreen');
      await page.waitForTimeout(350);
      assert.equal((await media()).paused, initiallyPaused, 'slow double-click changed the original playback state');
      await button('Exit fullscreen').click();
    }} finally {
      await cdp.detach();
      if (await page.evaluate(() => !!document.fullscreenElement)) await button('Exit fullscreen').click();
    }
  });
  await check('timeline hover shows the pointed timestamp and keyboard seek range owns arrows', async () => {
    await pauseAt(10);
    const seek = page.getByRole('slider', {name: 'Seek', exact: true});
    const box = await seek.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await until(async () => (await page.locator('.watch-seek-preview').innerText()).includes('15'), 'hover did not show middle timestamp');
    await seek.focus();
    await page.keyboard.press('ArrowRight');
    await until(async () => Math.abs((await media()).time - 15) < 0.2, 'focused seek did not move exactly five seconds');
  });
  await check('stop, loop, and automatic next ending modes use actual ended media', async () => {
    const ending = page.getByLabel('When the clip ends', {exact: true});
    await ending.selectOption('stop');
    await video.evaluate(v => {v.currentTime = v.duration - 0.2; void v.play();});
    await until(async () => (await media()).paused && (await media()).time > 29.7, 'stop did not remain at the end');
    await ending.selectOption('loop');
    await video.evaluate(v => {v.currentTime = v.duration - 0.2; void v.play();});
    await until(async () => (await media()).time < 2 && !(await media()).paused, 'loop did not restart playback');
    await ending.selectOption('next');
    await video.evaluate(v => {v.currentTime = v.duration - 0.2; void v.play();});
    await until(async () => (await media()).src.includes('clip=1') && (await media()).time < 2, 'auto-next did not select and start next clip');
    await button('Next clip').click();
    await until(async () => (await media()).src.includes('clip=2'), 'could not load last clip');
    await video.evaluate(v => {v.currentTime = v.duration - 0.2; void v.play();});
    await until(async () => (await media()).paused && (await media()).time > 29.7, 'last auto-next clip did not stop');
    assert.ok((await media()).src.includes('clip=2'));
    await ending.selectOption('stop');
    await button('Previous clip').click();
    await button('Previous clip').click();
  });
  await check('panels, keyboard highlight, frame capture, key overlay and shortcut help work', async () => {
    await pauseAt(7);
    await page.getByRole('dialog').focus();
    await page.keyboard.press('h');
    await until(async () => requests.some(r => r.url.endsWith('/highlights') && r.method === 'POST'), 'highlight shortcut did not call daemon');
    await button('Highlights').click();
    assert.equal(await page.getByRole('region', {name: 'Highlights', exact: true}).count(), 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#watch-highlights').count(), 0);
    await button('Player actions').click();
    await until(async () => await button('Keys').count() > 0, 'keys action not available');
    await button('Keys').click();
    assert.equal(await page.locator('.key-overlay').count(), 0);
    await button('Keys').click();
    assert.equal(await page.locator('.key-overlay').count(), 1);
    await button('Keyboard shortcuts').click();
    assert.equal(await page.getByRole('region', {name: 'Keyboard shortcuts', exact: true}).count(), 1);
    await page.getByRole('dialog').focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('s');
    await until(async () => requests.some(r => r.url.endsWith('/frame')), 'frame shortcut did not call daemon');
  });
  await check('editing text owns shortcuts and Shift arrows explicitly navigate clips', async () => {
    await pauseAt(10);
    await button('Player actions').click();
    await button('Rename').click();
    const input = page.getByRole('textbox');
    await input.fill('h s f m');
    await input.press('ArrowRight');
    assert.ok(Math.abs((await media()).time - 10) < 0.1, 'text arrow sought video');
    assert.equal(await page.evaluate(() => document.fullscreenElement === null), true);
    await input.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 1);
    await page.getByRole('dialog').focus();
    await page.keyboard.press('Shift+ArrowRight');
    await until(async () => (await media()).src.includes('clip=1'), 'Shift right did not navigate clips');
    await page.keyboard.press('Shift+ArrowLeft');
    await until(async () => (await media()).src.includes('clip=0'), 'Shift left did not navigate back');
  });
  await check('tab cycles inside player and escape closes panels before viewer', async () => {
    await page.getByRole('dialog').focus();
    for (let index = 0; index < 24; index++) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.querySelector('.watch-shell')?.contains(document.activeElement)), true);
    }
    await button('Highlights').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 1);
    assert.equal(await page.locator('#watch-highlights').count(), 0);
  });
  await check('immersive controls hide only while watching and stay visible with focus or pause', async () => {
    await button('Fill the window').click();
    await video.evaluate(v => {v.currentTime = 10; void v.play();});
    await page.getByRole('dialog').focus();
    await page.mouse.move(100, 200);
    await until(async () => (await page.getByRole('dialog').getAttribute('data-idle')) === 'true', 'watching did not hide controls', 4200);
    await page.mouse.move(110, 210);
    await page.getByRole('slider', {name: 'Volume', exact: true}).focus();
    await page.waitForTimeout(3250);
    assert.equal(await page.getByRole('dialog').getAttribute('data-idle'), null);
    await video.evaluate(v => v.pause());
    await page.getByRole('dialog').focus();
    await page.waitForTimeout(3250);
    assert.equal(await page.getByRole('dialog').getAttribute('data-idle'), null);
    await button('Back to normal size').click();
  });
  await check('fullscreen exit rejection blocks share, trim, and delete callbacks', async () => {
    await button('Enter fullscreen').click();
    await page.evaluate(() => {
      window.originalExitFullscreen = document.exitFullscreen.bind(document);
      document.exitFullscreen = () => Promise.reject(new Error('Fixture exit rejected'));
    });
    try {
      const before = await page.evaluate(() => window.playerHarness.actions.length);
      await button('Share').click();
      await page.waitForTimeout(100);
      for (const action of ['Trim', 'Delete']) {
        if (!(await page.locator('#watch-actions').count())) await button('Player actions').click();
        await button(action).click();
        await page.waitForTimeout(100);
      }
      assert.equal(await page.evaluate(() => window.playerHarness.actions.length), before);
      assert.equal(await page.evaluate(() => !!document.fullscreenElement), true);
      assert.ok(await page.evaluate(() => window.playerHarness.notifications.length >= 3));
    } finally {
      await page.evaluate(() => {document.exitFullscreen = window.originalExitFullscreen;});
      await button('Exit fullscreen').click();
    }
  });
  await check('Share waits for pending fullscreen entry and exits before opening external modal', async () => {
    await page.evaluate(() => {
      window.originalRequestFullscreen = Element.prototype.requestFullscreen;
      Element.prototype.requestFullscreen = function (...args) {
        return window.originalRequestFullscreen.apply(this, args).then(() => new Promise(resolve => {window.releaseEntry = resolve;}));
      };
    });
    try {
      const before = await page.evaluate(() => window.playerHarness.actions.length);
      await button('Enter fullscreen').click();
      await until(async () => await page.evaluate(() => typeof window.releaseEntry === 'function'), 'fixture entry did not become pending');
      await button('Share').click();
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.playerHarness.actions.length), before);
      await page.evaluate(() => window.releaseEntry());
      await until(async () => await page.evaluate(() => window.playerHarness.actions.length) === before + 1, 'Share did not resume after entry');
      assert.equal(await page.evaluate(() => document.fullscreenElement === null), true);
      assert.equal(await page.getByRole('dialog', {name: 'Fixture share', exact: true}).count(), 1);
      await closeExternal();
    } finally {
      await page.evaluate(() => {Element.prototype.requestFullscreen = window.originalRequestFullscreen;});
    }
  });
  await check('external trim and share overlays block main-player shortcuts and collapse fill mode', async () => {
    await pauseAt(10);
    await button('Fill the window').click();
    await button('Share').click();
    await until(async () => await page.getByRole('dialog', {name: 'Fixture share', exact: true}).count() === 1, 'share did not open');
    assert.equal(await page.locator('.watch-shell').getAttribute('data-expanded'), null);
    const before = await media();
    await page.getByRole('dialog', {name: 'Fixture share', exact: true}).focus();
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('k'); await page.keyboard.press('f');
    assert.ok(Math.abs((await media()).time - before.time) < 0.1);
    assert.equal((await media()).paused, before.paused);
    assert.equal(await page.evaluate(() => document.fullscreenElement === null), true);
    await closeExternal();
    await button('Player actions').click(); await button('Trim').click();
    await until(async () => await page.locator('video').count() === 2, 'real TrimModal did not attach preview');
    assert.equal((await media()).paused, true);
    const trimBefore = (await media()).time;
    await page.keyboard.press('ArrowRight');
    assert.ok(Math.abs((await media()).time - trimBefore) < 0.1);
    await closeExternal();
  });
  await check('header rename focus pins immersive chrome', async () => {
    await button('Fill the window').click();
    await video.evaluate(v => {v.currentTime = 10; void v.play();});
    await page.locator('.viewer-heading h2').dblclick();
    await page.locator('input.viewer-rename').focus();
    await page.mouse.move(150, 220);
    await page.waitForTimeout(3250);
    assert.equal(await page.locator('.watch-shell').getAttribute('data-idle'), null);
    await page.locator('input.viewer-rename').press('Escape');
    await button('Back to normal size').click();
  });
  await check('Escape closes player popup while a playback select owns focus', async () => {
    await button('Player actions').click();
    await page.getByLabel('Playback speed', {exact: true}).focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#watch-actions').count(), 0);
    assert.equal(await page.locator('.watch-shell').count(), 1);
  });
  await check('close and reopen release media, restore opener focus, and restore preferences', async () => {
    await button('Close the player').click();
    await page.waitForTimeout(400);
    const opener = page.locator('#harness-outside');
    await opener.focus(); await opener.click();
    await until(async () => (await media()).width === 640, 'reopen source did not decode');
    await page.getByLabel('Playback speed', {exact: true}).selectOption('1.25');
    await button('Close the player').click();
    await page.waitForTimeout(400);
    assert.equal(await video.count(), 0);
    assert.equal(await opener.evaluate(el => document.activeElement === el), true);
    await opener.click();
    await until(async () => (await media()).width === 640, 'second reopen failed');
    assert.equal((await media()).rate, 1.25);
    assert.equal((await media()).muted, true);
  });
  await check('responsive controls stay within viewport at 900 and 560 pixels', async () => {
    for (const width of [900, 560]) {
      await page.setViewportSize({width, height: 600});
      await page.waitForTimeout(150);
      await page.screenshot({path: `${output}/viewer-${width}.png`, fullPage: true});
      const bounds = await page.locator('.watch-transport').boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `transport clipped at ${width}`);
      for (const name of ['Player actions', 'Enter fullscreen', 'Highlights']) {
        const control = await button(name).boundingBox();
        assert.ok(control.x >= 0 && control.x + control.width <= width + 1, `${name} clipped at ${width}`);
      }
      for (const name of ['Volume', 'Seek']) {
        const slider = page.getByRole('slider', {name, exact: true});
        assert.equal(await slider.isVisible(), true, `${name} slider hidden at ${width}`);
        const control = await slider.boundingBox();
        assert.ok(control.width > 0 && control.height > 0, `${name} slider has no usable dimensions at ${width}`);
        assert.ok(control.x >= 0 && control.x + control.width <= width + 1 && control.y >= 0 && control.y + control.height <= 601, `${name} slider clipped at ${width}`);
      }
    }
    await page.setViewportSize({width: 1440, height: 1000});
  });
  await check('player actions dismiss on outside pointer without changing playback', async () => {
    await pauseAt(10);
    await button('Player actions').click();
    assert.equal(await page.locator('#watch-actions').count(), 1);
    await page.locator('.watch-time').click();
    assert.equal(await page.locator('#watch-actions').count(), 0);
    assert.equal((await media()).paused, true);
    assert.ok(Math.abs((await media()).time - 10) < 0.1);
  });
  await check('failed media shows actionable system-player and folder fallbacks', async () => {
    const failedPage = await context.newPage();
    try {
      await failedPage.route('**/fixture-invalid.mp4', route => route.fulfill({status: 200, contentType: 'video/mp4', body: 'deliberately invalid fixture media'}));
      const broken = new URL(url); broken.searchParams.set('broken', '1');
      await failedPage.goto(broken.href);
      const openPlayer = failedPage.getByRole('button', {name: 'Open in system player', exact: true});
      await openPlayer.waitFor({state: 'visible'});
      assert.ok((await failedPage.locator('.video-overlay').innerText()).includes('could not play'));
      await openPlayer.click();
      await failedPage.getByRole('button', {name: 'Show in folder', exact: true}).click();
      assert.deepEqual(await failedPage.evaluate(() => window.playerHarness.actions), ['open-external', 'reveal']);
      assert.equal(await failedPage.locator('.watch-video').evaluate(v => v.paused), true);
      assert.equal(await failedPage.locator('.key-overlay').count(), 0);
      await failedPage.screenshot({path: `${output}/viewer-failed-media.png`, fullPage: true});
    } finally {await failedPage.close();}
  });
  await check('unsupported HEVC requests proxy and shows preparing state until playable response', async () => {
    const proxyPage = await context.newPage();
    const proxyErrors = [];
    proxyPage.on('pageerror', error => proxyErrors.push(error.message));
    let heldRoute;
    try {
      await proxyPage.addInitScript(() => {
        const original = HTMLMediaElement.prototype.canPlayType;
        HTMLMediaElement.prototype.canPlayType = function (type) {
          return /hev1|hvc1/i.test(type) ? '' : original.call(this, type);
        };
      });
      await proxyPage.route('**/fixture.mp4**', route => {heldRoute = route;});
      const proxy = new URL(url); proxy.searchParams.set('codec', 'hevc');
      await proxyPage.goto(proxy.href);
      await proxyPage.getByText('Preparing the H.265 preview', {exact: true}).waitFor({state: 'visible'});
      assert.equal(await proxyPage.locator('.video-spinner').count(), 1);
      assert.ok((await proxyPage.locator('.watch-video').getAttribute('src')).includes('&proxy=1'));
      assert.equal(await proxyPage.locator('.watch-center-play').count(), 0);
      await proxyPage.screenshot({path: `${output}/viewer-hevc-preparing.png`, fullPage: true});
      assert.ok(heldRoute, 'proxy media request was not issued');
      await heldRoute.continue();
      await proxyPage.waitForFunction(() => document.querySelector('.watch-video')?.videoWidth === 640);
      await proxyPage.getByText('Preparing the H.265 preview', {exact: true}).waitFor({state: 'hidden'});
      assert.deepEqual(proxyErrors, []);
    } finally {await proxyPage.close();}
  });
  await check('no runtime exceptions', async () => assert.deepEqual(errors, []));
} finally {
  await fs.writeFile(`${output}/report.json`, JSON.stringify({url, results, errors}, null, 2));
  await browser.close();
}
if (results.some(result => !result.ok)) process.exitCode = 1;
