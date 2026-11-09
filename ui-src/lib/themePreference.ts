import {api} from './api';
import {
  DEFAULT_PREFERENCES,
  legacyPreferences,
  parsePreferences,
  type ThemePreferences,
} from '../theme/selection';
import {resolveAccent} from '../theme/viceTheme';

export function loadThemePreference(): {preferences: ThemePreferences; source: 'saved' | 'legacy' | 'default'} {
  const boot = document.getElementById('saved-theme');
  try {
    const saved = parsePreferences(JSON.parse(boot?.textContent || 'null'));
    if (saved) return {preferences: saved, source: 'saved'};
  } catch (err) {
    console.debug('Reading the saved theme failed', err);
  }

  try {
    const legacy = legacyPreferences(
      localStorage.getItem('vice-theme'),
      localStorage.getItem('vice-custom-accent'),
    );
    if (legacy) return {preferences: legacy, source: 'legacy'};
  } catch (err) {
    console.debug('Reading the legacy theme failed', err);
  }
  return {preferences: DEFAULT_PREFERENCES, source: 'default'};
}

export async function persistThemePreference(preferences: ThemePreferences): Promise<void> {
  const {ramp} = resolveAccent(preferences);
  await api.setAppState({
    theme: {version: 1, ...preferences, boot: {bg: ramp.bg, base: ramp.base, seed: preferences.seed}},
  });
  // Share embeds use the displayed primary. A generated seed is only input.
  await api.saveConfig({sharing: {embed_color: ramp.base}});
}
