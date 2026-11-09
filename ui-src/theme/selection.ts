import {ACCENT_NAMES, DEFAULT_ACCENT, type AccentName} from './accents';
import {exactAccent, type ExactColors} from './exactAccent';

export type ThemeSelection =
  | {mode: 'preset'; name: AccentName}
  | {mode: 'generated'}
  | {mode: 'manual'}
  | {mode: 'amoled'};

export interface ThemePreferences {
  selection: ThemeSelection;
  seed: string | null;
  manual: ExactColors | null;
}

export const DEFAULT_PREFERENCES: ThemePreferences = {
  selection: {mode: 'preset', name: DEFAULT_ACCENT},
  seed: null,
  manual: null,
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function savedHex(value: unknown): string | null {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

function preset(value: unknown): AccentName | undefined {
  return ACCENT_NAMES.find(name => name === value);
}

export function parsePreferences(value: unknown): ThemePreferences | null {
  const saved = record(value);
  if (saved.version !== 1) return null;

  const seed = savedHex(saved.seed);
  const base = savedHex(record(saved.manual).base);
  const bg = savedHex(record(saved.manual).bg);
  const manual = base && bg && exactAccent({base, bg}).ramp ? {base, bg} : null;
  const selected = record(saved.selection);
  const name = preset(selected.name);
  let selection = DEFAULT_PREFERENCES.selection;
  if (selected.mode === 'preset' && name) selection = {mode: 'preset', name};
  if (selected.mode === 'generated' && seed) selection = {mode: 'generated'};
  if (selected.mode === 'manual' && manual) selection = {mode: 'manual'};
  if (selected.mode === 'amoled') selection = {mode: 'amoled'};
  return {selection, seed, manual};
}

export function legacyPreferences(mode: unknown, storedSeed: unknown): ThemePreferences | null {
  const seed = savedHex(storedSeed);
  const name = preset(mode);
  if (!name && !seed) return null;
  const selection: ThemeSelection = mode === 'custom' && seed
    ? {mode: 'generated'}
    : {mode: 'preset', name: name ?? DEFAULT_ACCENT};
  return {selection, seed, manual: null};
}
