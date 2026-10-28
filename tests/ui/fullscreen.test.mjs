import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';

const source = await readFile(new URL('../../ui-src/lib/fullscreen.ts', import.meta.url), 'utf8');
let sequence = 0;
async function setup(native) {
  const events = new EventTarget();
  globalThis.window = Object.assign(new EventTarget(), {setTimeout, clearTimeout});
  globalThis.document = Object.assign(events, {fullscreenElement: null});
  const code = stripTypeScriptTypes(source.replace("import {IS_NATIVE, nativeLog} from './env';", `const IS_NATIVE = ${native}; const nativeLog = () => {};`));
  return import(`data:text/javascript;base64,${Buffer.from(`${code}\n// ${++sequence}`).toString('base64')}`);
}

test('browser request runs synchronously inside user activation and tracks Escape', async () => {
  const api = await setup(false);
  let called = false;
  const element = {requestFullscreen() {
    called = true;
    document.fullscreenElement = element;
    document.dispatchEvent(new Event('fullscreenchange'));
    return Promise.resolve();
  }};
  const states = [];
  const stop = api.subscribePlayerFullscreen(state => states.push(state));
  const request = api.requestPlayerFullscreen(element, true);
  assert.equal(called, true);
  await request;
  assert.equal(api.getPlayerFullscreen(), true);
  document.fullscreenElement = null;
  document.dispatchEvent(new Event('fullscreenchange'));
  assert.deepEqual(states, [false, true, false]);
  stop();
});

test('browser rejects unavailable or denied fullscreen without claiming success', async () => {
  const api = await setup(false);
  await assert.rejects(api.requestPlayerFullscreen({}, true), /unavailable/);
  await assert.rejects(api.requestPlayerFullscreen({requestFullscreen: () => Promise.reject(new Error('denied'))}, true), /denied/);
  assert.equal(api.getPlayerFullscreen(), false);
});

test('browser exit resolves when already out and exits when active', async () => {
  const api = await setup(false);
  await api.requestPlayerFullscreen({}, false);
  document.fullscreenElement = {};
  document.exitFullscreen = async () => { document.fullscreenElement = null; };
  await api.requestPlayerFullscreen({}, false);
  assert.equal(api.getPlayerFullscreen(), false);
});

test('native requests are serialized and recover after rejection', async () => {
  const api = await setup(true);
  const calls = [];
  let release;
  window.pywebview = {api: {
    get_player_fullscreen: async () => false,
    set_player_fullscreen: enabled => {
      calls.push(enabled);
      if (calls.length === 1) return new Promise(resolve => { release = resolve; });
      return Promise.resolve(enabled);
    },
  }};
  const first = api.requestPlayerFullscreen({}, true);
  const second = api.requestPlayerFullscreen({}, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [true]);
  release(true);
  await Promise.all([first, second]);
  assert.deepEqual(calls, [true, false]);
  window.pywebview.api.set_player_fullscreen = async () => { throw new Error('closed'); };
  await assert.rejects(api.requestPlayerFullscreen({}, true), /closed/);
  window.pywebview.api.set_player_fullscreen = async enabled => enabled;
  await api.requestPlayerFullscreen({}, true);
  assert.equal(api.getPlayerFullscreen(), true);
});

test('native subscription observes window manager exits and stops polling on cleanup', async () => {
  const api = await setup(true);
  let state = true;
  let reads = 0;
  window.pywebview = {api: {
    get_player_fullscreen: async () => { ++reads; return state; },
    set_player_fullscreen: async enabled => enabled,
  }};
  const states = [];
  const stop = api.subscribePlayerFullscreen(enabled => states.push(enabled));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(api.getPlayerFullscreen(), true);
  state = false;
  await new Promise(resolve => setTimeout(resolve, 330));
  assert.equal(api.getPlayerFullscreen(), false);
  stop();
  const finalReads = reads;
  await new Promise(resolve => setTimeout(resolve, 330));
  assert.equal(reads, finalReads);
  assert.deepEqual(states, [false, true, false]);
});

test('native waits for pywebviewready and validates returned state', async () => {
  const api = await setup(true);
  const request = api.requestPlayerFullscreen({}, true);
  await new Promise(resolve => setImmediate(resolve));
  window.pywebview = {api: {
    get_player_fullscreen: async () => false,
    set_player_fullscreen: async () => false,
  }};
  window.dispatchEvent(new Event('pywebviewready'));
  await assert.rejects(request, /rejected fullscreen/);
  assert.equal(api.getPlayerFullscreen(), false);
});

test('late native polling results do not overwrite a completed transition', async () => {
  const api = await setup(true);
  let releasePoll;
  window.pywebview = {api: {
    get_player_fullscreen: () => new Promise(resolve => { releasePoll = resolve; }),
    set_player_fullscreen: async enabled => enabled,
  }};
  const stop = api.subscribePlayerFullscreen(() => {});
  await new Promise(resolve => setImmediate(resolve));
  await api.requestPlayerFullscreen({}, true);
  releasePoll(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.getPlayerFullscreen(), true);
  stop();
});
