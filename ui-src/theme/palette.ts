import {ACCENTS, DEFAULT_ACCENT, type AccentRamp} from './accents';
import {deriveAccent} from './deriveAccent';
import {AMOLED, exactAccent} from './exactAccent';
import type {ThemePreferences} from './selection';

let cachedCustom: {seed: string; ramp: AccentRamp} | null = null;

export function generatedRamp(seed: string): AccentRamp {
  if (cachedCustom?.seed === seed) return cachedCustom.ramp;
  const {ramp} = deriveAccent(seed);
  cachedCustom = {seed, ramp};
  return ramp;
}

const amoledRamp = exactAccent(AMOLED).ramp!;
let cachedManual: {base: string; bg: string; ramp: AccentRamp} | null = null;

/** The boot cover and the live UI resolve the same validated preferences. */
export function resolveRamp({selection, seed, manual}: ThemePreferences): AccentRamp {
  if (selection.mode === 'generated' && seed) return generatedRamp(seed);
  if (selection.mode === 'amoled') return amoledRamp;
  if (selection.mode === 'manual' && manual) {
    if (cachedManual?.base === manual.base && cachedManual.bg === manual.bg) return cachedManual.ramp;
    const {ramp} = exactAccent(manual);
    if (ramp) {
      cachedManual = {...manual, ramp};
      return ramp;
    }
  }
  return ACCENTS[selection.mode === 'preset' ? selection.name : DEFAULT_ACCENT];
}
