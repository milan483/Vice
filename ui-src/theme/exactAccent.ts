import {ACCENTS, type AccentRamp} from './accents';
import {contrastRatio, normalizeHex} from './deriveAccent';

export interface ExactColors {
  base: string;
  bg: string;
}

export const DEFAULT_MANUAL: ExactColors = {base: '#ffffff', bg: ACCENTS.blue.bg};
export const AMOLED: ExactColors = {base: '#ffffff', bg: '#000000'};

function mix(from: string, to: string, weight: number): string {
  const channels = [1, 3, 5].map(i => {
    const a = parseInt(from.slice(i, i + 2), 16);
    const b = parseInt(to.slice(i, i + 2), 16);
    return Math.round(a + (b - a) * weight).toString(16).padStart(2, '0');
  });
  return `#${channels.join('')}`;
}

export function exactAccent(colors: ExactColors):
  | {ramp: AccentRamp; error: null}
  | {ramp: null; error: 'invalidHex' | 'lightBackground' | 'exactContrast'} {
  const base = normalizeHex(colors.base);
  const bg = normalizeHex(colors.bg);
  if (!base || !bg) return {ramp: null, error: 'invalidHex'};

  const lift = (weight: number) => mix(bg, '#ffffff', weight);
  const ramp: AccentRamp = {
    ...ACCENTS.blue, // Keep the semantic error roles independent of the user's colors.
    base,
    bg,
    ambient: bg,
    surfaceLowest: lift(0.03),
    surfaceLow: lift(0.07),
    surface: lift(0.11),
    surfaceHigh: lift(0.16),
    surfaceHighest: lift(0.21),
    onSurface: '#f5f5f5',
    onSurfaceVariant: '#d6d6d6',
    primaryContainer: mix(bg, base, 0.19),
    secondaryContainer: mix(bg, base, 0.14),
    tertiaryContainer: mix(bg, base, 0.21),
    onPrimaryContainer: '#f5f5f5',
    onSecondaryContainer: '#f5f5f5',
    onTertiaryContainer: '#f5f5f5',
    outline: '#b5b5b5',
    outlineVariant: mix(bg, '#ffffff', 0.34),
    onBase: '#000000',
    hover: base === '#ffffff' ? '#eeeeee' : mix(base, '#ffffff', 0.16),
    active: mix(base, '#000000', 0.12),
  };

  // The highest surface bounds the other lightened fills. Keep body text,
  // muted text and field boundaries legible even in a raised popover.
  if (
    contrastRatio(ramp.surfaceHighest, ramp.onSurfaceVariant) < 4.5 ||
    contrastRatio(ramp.surfaceHighest, ramp.outline) < 3
  ) return {ramp: null, error: 'lightBackground'};

  if (
    contrastRatio(base, bg) < 4.5 ||
    contrastRatio(base, ramp.surfaceHighest) < 4.5 ||
    contrastRatio(base, ramp.onBase) < 4.5
  ) return {ramp: null, error: 'exactContrast'};

  if (contrastRatio(ramp.active, ramp.onBase) < 4.5) {
    ramp.active = mix(base, '#ffffff', 0.32);
  }
  return {ramp, error: null};
}
