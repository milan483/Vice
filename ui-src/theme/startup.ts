import {
  DEFAULT_PREFERENCES,
  legacyPreferences,
  parsePreferences,
  type ThemePreferences,
} from './selection';

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
