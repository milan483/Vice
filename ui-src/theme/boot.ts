import {resolveRamp} from './palette';
import {loadThemePreference} from './startup';

const {preferences} = loadThemePreference();
const {bg, base} = resolveRamp(preferences);
const style = document.documentElement.style;
style.setProperty('--vice-bg', bg);
style.setProperty('--boot-accent', base);
