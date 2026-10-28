import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';

// The app uses bundler modules inside a CommonJS package. Load the actual
// TypeScript helper as an ES module without requiring a separate test runner.
const source = readFileSync(new URL('./playbackQueue.ts', import.meta.url), 'utf8');
const {snapshotQueue, resolveQueue, renameInQueue} = await import(
  `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`
);

test('opening a sorted or filtered surface preserves its exact order', () => {
  assert.deepEqual(snapshotQueue('second', ['third', 'second', 'first']), ['third', 'second', 'first']);
});

test('a queue snapshots the origin and ignores later recordings and sorting changes', () => {
  const origin = ['b', 'a'];
  const queue = snapshotQueue('a', origin);
  origin.reverse();
  origin.push('new');
  assert.deepEqual(queue, ['b', 'a']);
  assert.deepEqual(resolveQueue(queue, [{slug: 'new'}, {slug: 'a'}, {slug: 'b'}]), [{slug: 'b'}, {slug: 'a'}]);
});

test('deleted queue entries are skipped while refreshed metadata stays live', () => {
  const queue = snapshotQueue('a', ['a', 'deleted', 'b']);
  const freshB = {slug: 'b', views: 21};
  assert.deepEqual(resolveQueue(queue, [freshB, {slug: 'a', views: 2}]), [{slug: 'a', views: 2}, freshB]);
});

test('renaming the current or a later clip retains its queue position', () => {
  const original = ['a', 'b', 'c'];
  const queue = renameInQueue(renameInQueue(original, 'a', 'renamed-a'), 'c', 'renamed-c');
  assert.deepEqual(queue, ['renamed-a', 'b', 'renamed-c']);
  assert.deepEqual(original, ['a', 'b', 'c']);
  assert.deepEqual(resolveQueue(queue, [{slug: 'renamed-c'}, {slug: 'b'}, {slug: 'renamed-a'}]),
    [{slug: 'renamed-a'}, {slug: 'b'}, {slug: 'renamed-c'}]);
});

test('renaming a library clip outside the originating row does not add it', () => {
  assert.deepEqual(renameInQueue(['a', 'b'], 'outside', 'renamed'), ['a', 'b']);
});

test('direct library opening can snapshot the full library', () => {
  const library = [{slug: 'a'}, {slug: 'b'}, {slug: 'c'}];
  assert.deepEqual(snapshotQueue('b', library.map(clip => clip.slug)), ['a', 'b', 'c']);
});

test('stale or repeated origins still include the selected clip only once', () => {
  assert.deepEqual(snapshotQueue('a', ['b', 'b']), ['a', 'b']);
  assert.deepEqual(snapshotQueue('a', []), ['a']);
  assert.deepEqual(renameInQueue(['a', 'b'], 'a', 'b'), ['b']);
  assert.deepEqual(resolveQueue(['gone'], []), []);
});
