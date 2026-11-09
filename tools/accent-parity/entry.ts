// Built by tools/verify-custom-accent.mjs. Not part of the app bundle.
import assert from 'node:assert/strict';
import {ACCENTS} from '../../ui-src/theme/accents';
import {AMOLED, exactAccent} from '../../ui-src/theme/exactAccent';
import {DEFAULT_PREFERENCES, legacyPreferences, parsePreferences} from '../../ui-src/theme/selection';
import {resolveRamp} from '../../ui-src/theme/palette';
import {contrastRatio, deriveAccent} from '../../ui-src/theme/deriveAccent';

const SEEDS = {
  blue: '#0099ff',
  purple: '#8b5cf6',
  green: '#10b981',
  red: '#ef4444',
  orange: '#f97316',
};
// The generator's one hand-picked tone. Everything else takes the default.
const TONE: Record<string, number> = {blue: 74};

const out: Record<string, unknown> = {};
for (const [name, seed] of Object.entries(SEEDS)) out[name] = deriveAccent(seed, TONE[name]);

// A spread of hues plus the awkward ones. None may produce a scheme that fails
// its own checks, because a user can pick any of them.
const PROBES = [
  '#000000', '#ffffff', '#808080', '#123456', '#ff0000', '#00ff00', '#0000ff',
  '#ffff00', '#00ffff', '#ff00ff', '#7c3aed', '#0a0a2e', '#8b0000', '#013220', '#2b1700',
];
out.__probes = Object.fromEntries(PROBES.map(s => [s, deriveAccent(s)]));

const {ramp: amoled} = exactAccent(AMOLED);
assert(amoled);
assert.equal(amoled.base, '#ffffff');
assert.equal(amoled.bg, '#000000');
assert.equal(amoled.ambient, amoled.bg);
assert.equal(amoled.error, ACCENTS.blue.error);
const fills = [amoled.bg, amoled.surfaceLowest, amoled.surfaceLow, amoled.surface,
  amoled.surfaceHigh, amoled.surfaceHighest];
assert.equal(new Set(fills).size, fills.length);
for (const fill of fills) {
  for (const text of [amoled.base, amoled.onSurface, amoled.onSurfaceVariant]) {
    assert(contrastRatio(fill, text) >= 4.5);
  }
  assert(contrastRatio(fill, amoled.outline) >= 3);
}
for (const fill of [amoled.base, amoled.hover, amoled.active]) {
  assert(contrastRatio(fill, amoled.onBase) >= 4.5);
}

assert.equal(exactAccent({base: ' #AEF ', bg: '#102030'}).ramp?.base, '#aaeeff');
assert.equal(exactAccent({base: '#fff', bg: '#102030'}).ramp?.bg, '#102030');
assert.equal(exactAccent({base: '#000', bg: '#000'}).error, 'exactContrast');
assert.equal(exactAccent({base: '#777', bg: '#000'}).error, 'exactContrast');
assert.equal(exactAccent({base: '#fff', bg: '#fff'}).error, 'lightBackground');
assert.equal(exactAccent({base: 'url(x)', bg: '#000'}).error, 'invalidHex');
assert.equal(exactAccent({base: '#fff', bg: '#1234'}).error, 'invalidHex');

const saved = {version: 1, seed: '#808080', manual: AMOLED};
for (const selection of [{mode: 'preset', name: 'red'}, {mode: 'generated'},
  {mode: 'manual'}, {mode: 'amoled'}]) {
  assert.deepEqual(parsePreferences({...saved, selection}), {
    selection, seed: saved.seed, manual: AMOLED,
  });
}
assert.deepEqual(parsePreferences({version: 1, seed: [], selection: {mode: 'generated'}}),
  DEFAULT_PREFERENCES);
assert.deepEqual(parsePreferences({...saved, selection: {mode: 'manual'}, manual: {
  base: '#000000', bg: '#000000',
}}), {...DEFAULT_PREFERENCES, seed: saved.seed});
assert.equal(parsePreferences('invalid'), null);
assert.deepEqual(legacyPreferences('custom', '#ABCDEF'), {
  selection: {mode: 'generated'}, seed: '#abcdef', manual: null,
});
assert.deepEqual(legacyPreferences('purple', '#808080'), {
  selection: {mode: 'preset', name: 'purple'}, seed: '#808080', manual: null,
});
assert.equal(legacyPreferences('custom', 'bad'), null);

// Include a plausible old generated cache with the same seed. Prepaint
// must use the actual derived palette even when the cache passes hex checks.
const stale = {bg: '#11131a', base: '#8ab9f3', seed: saved.seed};
const generated = {...saved, selection: {mode: 'generated'}};
const manual = {...saved, selection: {mode: 'manual'}, manual: {bg: '#102030', base: '#ffffff'}};
const startup = [generated, {...generated, boot: stale}, manual, {...manual, boot: stale}]
  .map(preferences => {
    const {bg, base} = resolveRamp(parsePreferences(preferences)!);
    return {preferences, colors: [bg, base]};
  });
assert.deepEqual(resolveRamp(parsePreferences(generated)!), deriveAccent(saved.seed).ramp);
out.__startup = startup;
assert.deepEqual(startup[1].colors, startup[0].colors);
assert.deepEqual(startup[3].colors, startup[2].colors);
assert.deepEqual(startup[2].colors, ['#102030', '#ffffff']);
assert.equal(resolveRamp(parsePreferences(generated)!), resolveRamp(parsePreferences(generated)!));

console.log(JSON.stringify(out));
