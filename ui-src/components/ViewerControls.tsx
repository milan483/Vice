import {useRef, useState} from 'react';
import {formatDuration} from '../lib/format';
import {t} from '../lib/i18n';
import type {Highlight} from '../lib/types';
import {IconExpand} from './Icons';

export const PLAYBACK_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
export type EndBehavior = 'stop' | 'loop' | 'next';

export function ViewerControls({
  paused,
  current,
  duration,
  volume,
  muted,
  speed,
  endBehavior,
  highlights,
  canPrevious,
  canNext,
  expanded,
  fullscreen,
  fullscreenBusy,
  shareLabel,
  panelOpen,
  menuOpen,
  onToggle,
  onStep,
  onSeek,
  onVolume,
  onMute,
  onSpeed,
  onEndBehavior,
  onExpand,
  onFullscreen,
  onShare,
  onShareMenu,
  onPanel,
  onMenu,
  onHighlightDrag,
}: {
  paused: boolean;
  current: number;
  duration: number;
  volume: number;
  muted: boolean;
  speed: number;
  endBehavior: EndBehavior;
  highlights: Highlight[];
  canPrevious: boolean;
  canNext: boolean;
  expanded: boolean;
  fullscreen: boolean;
  fullscreenBusy: boolean;
  shareLabel: string;
  panelOpen: boolean;
  menuOpen: boolean;
  onToggle: () => void;
  onStep: (delta: number) => void;
  onSeek: (seconds: number) => void;
  onVolume: (level: number) => void;
  onMute: () => void;
  onSpeed: (speed: number) => void;
  onEndBehavior: (behavior: EndBehavior) => void;
  onExpand: () => void;
  onFullscreen: () => void;
  onShare: () => void;
  onShareMenu: () => void;
  onPanel: () => void;
  onMenu: () => void;
  onHighlightDrag: (e: React.PointerEvent, highlight: Highlight, track: HTMLElement) => void;
}) {
  const seekRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const bounded = duration > 0 ? Math.max(0, Math.min(duration, current)) : 0;
  const percent = duration > 0 ? (bounded / duration) * 100 : 0;
  const glyph = (path: string) => (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
  return (
    <div className="watch-controls" data-player-controls="true">
      <div
        className="watch-seek"
        ref={seekRef}
        onPointerMove={e => {
          const rect = e.currentTarget.getBoundingClientRect();
          setHover(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
        }}
        onPointerLeave={() => setHover(null)}
      >
        <div className="watch-seek-track">
          <div style={{width: `${percent}%`}} />
        </div>
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.01}
          value={bounded}
          disabled={!duration}
          aria-label={t('viewer.seek')}
          aria-valuetext={`${formatDuration(bounded)} / ${formatDuration(duration)}`}
          onKeyDown={e => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault();
              onSeek(Math.max(0, Math.min(duration, bounded + (e.key === 'ArrowRight' ? 5 : -5))));
            }
          }}
          onChange={e => onSeek(Number(e.target.value))}
        />
        {highlights.map(h => (
          <button
            key={h.id}
            type="button"
            className="watch-marker"
            style={{
              left: `${duration ? Math.min(100, Math.max(0, (h.time / duration) * 100)) : 0}%`,
              background: h.color,
            }}
            aria-label={t('viewer.highlightAt', {
              label: h.label,
              time: formatDuration(h.time, true),
            })}
            title={`${h.label} · ${formatDuration(h.time, true)}`}
            onPointerDown={e => {
              if (seekRef.current) onHighlightDrag(e, h, seekRef.current);
            }}
            onClick={() => onSeek(h.time)}
          />
        ))}
        {hover !== null && duration > 0 ? (
          <output
            className="watch-seek-preview mono"
            style={{left: `clamp(36px, ${hover * 100}%, calc(100% - 36px))`}}
          >
            {formatDuration(hover * duration)}
          </output>
        ) : null}
      </div>
      <div className="watch-transport">
        <button
          type="button"
          className="player-btn"
          disabled={!canPrevious}
          onClick={() => onStep(-1)}
          title={t('viewer.prevClip')}
          aria-label={t('viewer.prevClip')}
        >
          {glyph('M6 4v16M19 5l-10 7 10 7V5Z')}
        </button>
        <button
          type="button"
          className="player-main"
          onClick={onToggle}
          title={t(paused ? 'viewer.play' : 'viewer.pause')}
          aria-label={t(paused ? 'viewer.play' : 'viewer.pause')}
        >
          {paused ? glyph('m8 4 12 8-12 8V4Z') : glyph('M8 4v16M16 4v16')}
        </button>
        <button
          type="button"
          className="player-btn"
          disabled={!canNext}
          onClick={() => onStep(1)}
          title={t('viewer.nextClip')}
          aria-label={t('viewer.nextClip')}
        >
          {glyph('M18 4v16M5 5l10 7-10 7V5Z')}
        </button>
        <div className="player-volume">
          <button
            type="button"
            className="player-btn"
            onClick={onMute}
            aria-pressed={muted}
            title={t(muted ? 'viewer.unmuteHint' : 'viewer.muteHint')}
            aria-label={t(muted ? 'viewer.unmute' : 'viewer.mute')}
          >
            {glyph(
              muted || !volume
                ? 'M11 4 5 9H2v6h3l6 5V4ZM17 9l5 6M22 9l-5 6'
                : 'M11 4 5 9H2v6h3l6 5V4ZM16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14',
            )}
          </button>
          <input
            type="range"
            className="player-volume-range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            aria-label={t('viewer.volume')}
            style={{['--filled' as string]: `${muted ? 0 : volume * 100}%`}}
            onChange={e => onVolume(Number(e.target.value))}
          />
        </div>
        <span className="watch-time mono">
          {formatDuration(current)} / {formatDuration(duration)}
        </span>
        <div className="watch-spacer" />
        <select
          className="watch-select"
          aria-label={t('viewer.speed')}
          title={t('viewer.speed')}
          value={speed}
          onChange={e => onSpeed(Number(e.target.value))}
        >
          {PLAYBACK_SPEEDS.map(rate => (
            <option key={rate} value={rate}>
              {rate}×
            </option>
          ))}
        </select>
        <select
          className="watch-select watch-end"
          aria-label={t('viewer.endBehavior')}
          title={t('viewer.endBehavior')}
          value={endBehavior}
          onChange={e => onEndBehavior(e.target.value as EndBehavior)}
        >
          <option value="stop">{t('viewer.endStop')}</option>
          <option value="loop">{t('viewer.endLoop')}</option>
          <option value="next">{t('viewer.endNext')}</option>
        </select>
        <button
          type="button"
          className="player-btn"
          aria-label={t('viewer.highlightsHeading')}
          title={t('viewer.highlightsHeading')}
          aria-expanded={panelOpen}
          aria-controls="watch-highlights"
          onClick={onPanel}
        >
          {glyph('m12 3 3 6 6 1-4.5 4.5 1 6.5-5.5-3-5.5 3 1-6.5L3 10l6-1 3-6Z')}
        </button>
        <button
          type="button"
          className="player-btn"
          aria-label={shareLabel}
          title={shareLabel}
          onClick={onShare}
          onContextMenu={e => {
            e.preventDefault();
            onShareMenu();
          }}
        >
          {glyph('M8 12h12m-5-5 5 5-5 5M10 4H4v16h6')}
        </button>
        <button
          type="button"
          className="player-btn"
          aria-label={t(expanded ? 'viewer.shrink' : 'viewer.expand')}
          title={t(expanded ? 'viewer.shrink' : 'viewer.expand')}
          aria-pressed={expanded}
          disabled={fullscreen}
          onClick={onExpand}
        >
          <IconExpand collapse={expanded} />
        </button>
        <button
          type="button"
          className="player-btn"
          aria-label={t(fullscreen ? 'viewer.exitFullscreen' : 'viewer.fullscreen')}
          title={t(fullscreen ? 'viewer.exitFullscreen' : 'viewer.fullscreen')}
          aria-pressed={fullscreen}
          disabled={fullscreenBusy}
          onClick={onFullscreen}
        >
          {glyph(
            fullscreen
              ? 'M4 9h5V4M15 4v5h5M20 15h-5v5M9 20v-5H4'
              : 'M9 4H4v5M15 4h5v5M20 15v5h-5M9 20H4v-5',
          )}
        </button>
        <button
          type="button"
          className="player-btn"
          aria-label={t('viewer.actions')}
          title={t('viewer.actions')}
          aria-expanded={menuOpen}
          aria-controls="watch-actions"
          onClick={onMenu}
        >
          {glyph('M5 11v2M12 11v2M19 11v2')}
        </button>
      </div>
    </div>
  );
}
