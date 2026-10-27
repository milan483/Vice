import type {AudioSourcesInfo} from '../../lib/types';
import {t} from '../../lib/i18n';
import {Toggle} from './Fields';

/** GSR matches application names without regard to case. Keep the saved key. */
function applicationPreferenceKey(values: Record<string, unknown>, id: string): string {
  if (Object.prototype.hasOwnProperty.call(values, id)) return id;
  return Object.keys(values).find(key => key.toLowerCase() === id.toLowerCase()) ?? id;
}

export function ApplicationMixer({
  sources,
  enabled,
  volumes,
  captureAudio,
  switchesDisabled,
  onEnabledChange,
  onVolumeChange,
}: {
  sources: AudioSourcesInfo;
  enabled: Record<string, boolean>;
  volumes: Record<string, number>;
  captureAudio: boolean;
  switchesDisabled: boolean;
  onEnabledChange: (id: string, value: boolean) => void;
  onVolumeChange: (id: string, value: number) => void;
}) {
  const applications = new Map<string, {id: string; label: string; detected: boolean}>();
  const detected = new Map(
    sources.sources.filter(source => source.id.startsWith('app:')).map(source => [source.id.toLowerCase(), source]),
  );
  const active = new Set((sources.application_mixer?.active_sources ?? []).map(id => id.toLowerCase()));
  for (const id of [
    ...Object.keys(enabled),
    ...Object.keys(volumes),
    ...(sources.application_mixer?.active_sources ?? []),
    ...sources.sources.map(source => source.id),
  ]) {
    if (!id.startsWith('app:') || applications.has(id.toLowerCase())) continue;
    const source = detected.get(id.toLowerCase());
    applications.set(id.toLowerCase(), {id, label: source?.label || id.slice(4), detected: !!source});
  }

  return (
    <div className="app-mixer">
      <p className="tracks-empty">{t('appMixer.tracksHelp')}</p>
      {!captureAudio ? <p className="tracks-warning">{t('appMixer.desktopOff')}</p> : null}
      {sources.warning ? <p className="tracks-warning" role="status">{sources.warning}</p> : null}
      {applications.size === 0 ? <p className="tracks-empty">{t('appMixer.empty')}</p> : null}
      {[...applications.values()].sort((a, b) => a.label.localeCompare(b.label)).map(app => {
        const enabledKey = applicationPreferenceKey(enabled, app.id);
        const volumeKey = applicationPreferenceKey(volumes, detected.get(app.id.toLowerCase())?.id ?? app.id);
        const isEnabled = enabled[enabledKey] !== false;
        const volume = Math.max(0, Math.min(200, volumes[volumeKey] ?? 100));
        const isCaptured = sources.application_mixer?.active === true && active.has(app.id.toLowerCase());
        const status = !isEnabled
          ? isCaptured ? 'offOnApply' : 'off'
          : !captureAudio ? 'desktopDisabled'
          : isCaptured ? app.detected ? 'capturing' : 'notPlaying'
          : app.detected ? 'pending' : 'absent';
        return (
          <div className="app-mixer-row" key={app.id.toLowerCase()}>
            <div className="app-mixer-name" title={app.id}>
              <strong>{app.label}</strong>
              <span>{t(`appMixer.${status}`)}</span>
            </div>
            <Toggle
              label={t('appMixer.enabledAria', {name: app.label})}
              checked={isEnabled}
              disabled={switchesDisabled}
              onChange={value => onEnabledChange(enabledKey, value)}
            />
            <div className="app-mixer-volume" role="group" aria-label={t('audioTracks.levelAria', {name: app.label})}>
              <button
                type="button"
                className="btn btn-quiet btn-sm"
                aria-label={t('appMixer.decreaseAria', {name: app.label})}
                disabled={volume <= 0}
                onClick={() => onVolumeChange(volumeKey, Math.max(0, volume - 5))}>−</button>
              <output aria-label={t('audioTracks.levelAria', {name: app.label})}>{volume}%</output>
              <button
                type="button"
                className="btn btn-quiet btn-sm"
                aria-label={t('appMixer.increaseAria', {name: app.label})}
                disabled={volume >= 200}
                onClick={() => onVolumeChange(volumeKey, Math.min(200, volume + 5))}>+</button>
            </div>
          </div>
        );
      })}
      <p className="tracks-empty">{t('appMixer.levelHelp')}</p>
    </div>
  );
}
