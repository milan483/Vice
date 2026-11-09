import {api} from './api';
import {resolveRamp} from '../theme/palette';
import type {ThemePreferences} from '../theme/selection';

export async function persistThemePreference(preferences: ThemePreferences): Promise<void> {
  const ramp = resolveRamp(preferences);
  await api.setAppState({
    theme: {version: 1, ...preferences},
  });
  // Share embeds use the displayed primary. A generated seed is only input.
  await api.saveConfig({sharing: {embed_color: ramp.base}});
}
