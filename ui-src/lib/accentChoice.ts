import {useStore} from '../state/store';
import type {AccentName} from '../theme/accents';
import type {ExactColors} from '../theme/exactAccent';

/** Settings and the tutorial share the active selection and its saved choices. */
export function useAccentChoice() {
  const {state, selectTheme} = useStore();
  const {selection, seed, manual} = state.themePreferences;

  return {
    selection,
    seed,
    manual,
    choose: (name: AccentName) => selectTheme(previous => ({
      ...previous, selection: {mode: 'preset', name},
    })),
    chooseCustom: (seed: string) => selectTheme(previous => ({
      ...previous, selection: {mode: 'generated'}, seed,
    })),
    chooseManual: (manual: ExactColors) => selectTheme(previous => ({
      ...previous, selection: {mode: 'manual'}, manual,
    })),
    chooseAmoled: () => selectTheme(previous => ({
      ...previous, selection: {mode: 'amoled'},
    })),
  };
}
