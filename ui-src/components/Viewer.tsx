import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {api} from '../lib/api';
import {useEscape} from '../lib/escape';
import {DEFAULT_MARK_COLOR, MARK_COLORS} from '../lib/palette';
import {useExitTransition} from '../lib/exit';
import {formatBytes, formatDuration} from '../lib/format';
import {
  clipNeedsProxy,
  playQuietly,
  playbackUrl,
  useVideoFailure,
  videoFailureMessage,
} from '../lib/playback';
import {
  getPlayerFullscreen,
  requestPlayerFullscreen,
  subscribePlayerFullscreen,
} from '../lib/fullscreen';
import {clipTitle, imageTitle, type Clip, type Highlight} from '../lib/types';
import {IconClose} from './Icons';
import {KeyOverlay} from './KeyOverlay';
import type {KeyInterval} from '../lib/keyLayout';
import {InlineRename} from './InlineRename';
import {ViewerControls, PLAYBACK_SPEEDS, type EndBehavior} from './ViewerControls';
import {t, tNode} from '../lib/i18n';

const HIGHLIGHT_COLORS = MARK_COLORS;
const DEFAULT_HIGHLIGHT_COLOR = DEFAULT_MARK_COLOR;

export type HighlightUpdate = Highlight[] | ((current: Highlight[]) => Highlight[]);

export interface ViewerProps {
  clip: Clip | null;
  /** The snapshotted originating queue, resolved against live library metadata. */
  clips: Clip[];
  highlights: Highlight[];
  onHighlightsChange: (next: HighlightUpdate) => void;
  onSelect: (slug: string) => void;
  onClose: () => void;
  onTrim: (clip: Clip) => void;
  trimOpen: boolean;
  overlayOpen?: boolean;
  onShare: (clip: Clip) => void;
  onShareMenu: (clip: Clip) => void;
  shareLabel: string;
  onReveal: (clip: Clip) => void;
  onDelete: (clip: Clip) => void;
  onOpenExternally: (clip: Clip) => void;
  onRename: (clip: Clip, name: string) => void;
  notify: (title: string, detail?: string, tone?: 'accent' | 'error') => void;
}

const VOLUME_KEY = 'vice-volume';
const MUTED_KEY = 'vice-muted';
const SPEED_KEY = 'vice-playback-speed';
const KEYS_SHOWN_KEY = 'vice-viewer-keys';
function storedNumber(key: string, fallback: number, valid: (value: number) => boolean): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}
function storedFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Session state still applies. */
  }
}
const FOCUSABLE =
  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

/** One video and one transport stay mounted across all three viewing modes. */
export function Viewer(props: ViewerProps) {
  const {clips, highlights, onHighlightsChange, onSelect, onClose, trimOpen} = props;
  const open = props.clip !== null;
  const blocked = props.overlayOpen || trimOpen;
  const {mounted, closing} = useExitTransition(open, 320);
  const lastClip = useRef(props.clip);
  if (props.clip) lastClip.current = props.clip;
  const clip = props.clip ?? lastClip.current;
  const videoRef = useRef<HTMLVideoElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({current: 0, duration: 0});
  const [paused, setPaused] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [picker, setPicker] = useState<{
    id: string;
    color: string;
    at: {x: number; y: number};
  } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [volume, setVolume] = useState(() => storedNumber(VOLUME_KEY, 1, n => n >= 0 && n <= 1));
  const [muted, setMuted] = useState(() => storedFlag(MUTED_KEY, false));
  const [speed, setSpeed] = useState(() =>
    storedNumber(SPEED_KEY, 1, n => PLAYBACK_SPEEDS.includes(n)),
  );
  const [endBehavior, setEndBehavior] = useState<EndBehavior>('stop');
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(getPlayerFullscreen);
  const [fullscreenBusy, setFullscreenBusy] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const fullscreenPending = useRef(false);
  const fullscreenTransition = useRef<Promise<boolean> | null>(null);
  const [idle, setIdle] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  const [keysShown, setKeysShown] = useState(() => storedFlag(KEYS_SHOWN_KEY, true));
  const [keyIntervals, setKeyIntervals] = useState<KeyInterval[] | null>(null);
  const failed = useVideoFailure(videoRef, mounted);
  const immersive = expanded || fullscreen;
  const index = clip ? clips.findIndex(c => c.slug === clip.slug) : -1;
  const clickTimer = useRef<number | undefined>(undefined);
  const clickIntent = useRef<{
    slug: string | undefined;
    wasPaused: boolean;
    applied: boolean;
  } | null>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  const liveClip = useRef(clip?.slug);
  liveClip.current = clip?.slug;

  const setFull = useCallback(
    (enabled: boolean): Promise<boolean> => {
      const shell = shellRef.current;
      if (!shell) return Promise.resolve(false);
      if (fullscreenTransition.current) {
        return fullscreenTransition.current.then(() => setFull(enabled));
      }
      fullscreenPending.current = true;
      setFullscreenBusy(true);
      setFullscreenError(null);
      // Call immediately so browser entry retains transient user activation.
      const transition = requestPlayerFullscreen(shell, enabled)
        .then(
          () => true,
          error => {
            setFullscreenError((error as Error).message);
            props.notify(t('viewer.fullscreenFailed'), (error as Error).message, 'error');
            return false;
          },
        )
        .finally(() => {
          fullscreenPending.current = false;
          fullscreenTransition.current = null;
          setFullscreenBusy(false);
        });
      fullscreenTransition.current = transition;
      return transition;
    },
    [props.notify],
  );
  useEffect(() => {
    if (!mounted) return;
    return subscribePlayerFullscreen(setFullscreen);
  }, [mounted]);

  const source = clip ? playbackUrl(clip) : '';
  const sourceSlug = clip?.slug;
  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!open || !video || !source) return;
    if (video.getAttribute('src') === source) return;
    video.pause();
    video.src = source;
    video.load();
    video.volume = volume;
    video.muted = muted;
    video.playbackRate = speed;
    setPreparing(clipNeedsProxy(clip));
    setPosition({current: 0, duration: 0});
    if (!trimOpen) playQuietly(video);
    if (sourceSlug)
      void api.markViewed(sourceSlug).catch(err => console.debug('Recording the view failed', err));
    // Volume/rate are applied below too; changing a preference must not re-open a paused source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, sourceSlug, open]);
  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.volume = volume;
      video.muted = muted;
      video.playbackRate = speed;
    }
  }, [volume, muted, speed, open]);

  useEffect(() => {
    if (trimOpen) videoRef.current?.pause();
  }, [trimOpen]);
  useEffect(() => {
    if (open) return;
    const video = videoRef.current;
    if (video?.getAttribute('src')) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    if (shellRef.current && (getPlayerFullscreen() || fullscreenPending.current)) {
      void requestPlayerFullscreen(shellRef.current, false).catch(error =>
        props.notify(t('viewer.fullscreenFailed'), String(error), 'error'),
      );
    }
    window.clearTimeout(clickTimer.current);
    dragCleanup.current?.();
    setExpanded(false);
    setEndBehavior('stop');
    setPanelOpen(false);
    setMenuOpen(false);
    setHelpOpen(false);
    setPicker(null);
    setFullscreenError(null);
  }, [open, props.notify]);
  useEffect(
    () => () => {
      window.clearTimeout(clickTimer.current);
      dragCleanup.current?.();
    },
    [],
  );
  useEffect(() => {
    window.clearTimeout(clickTimer.current);
    clickIntent.current = null;
    setPicker(null);
    setRenaming(null);
    setRenamingTitle(false);
    dragCleanup.current?.();
  }, [sourceSlug]);

  const keysSlug = clip?.keys ? clip.slug : null;
  useEffect(() => {
    setKeyIntervals(null);
    if (!keysSlug) return;
    let live = true;
    void api
      .clipKeys(keysSlug)
      .then(keys => {
        if (live) setKeyIntervals(keys ?? null);
      })
      .catch(err => console.debug('Loading the clip keys failed', err));
    return () => {
      live = false;
    };
  }, [keysSlug]);

  // Hide only during uninterrupted watching. Focus, hover and drag pin the bar.
  useEffect(() => {
    if (
      !open ||
      !immersive ||
      paused ||
      menuOpen ||
      panelOpen ||
      helpOpen ||
      picker ||
      blocked ||
      dragging
    ) {
      setIdle(false);
      return;
    }
    let timer = 0;
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const controls = controlsRef.current;
        const focused = document.activeElement;
        if (
          (focused instanceof HTMLElement &&
            shellRef.current?.contains(focused) &&
            focused.matches('button, input, select, textarea, a, [contenteditable]')) ||
          controls?.matches(':hover') ||
          shellRef.current?.querySelector('.watch-heading:hover')
        )
          return;
        setIdle(true);
      }, 3000);
    };
    wake();
    const shell = shellRef.current;
    shell?.addEventListener('pointermove', wake);
    shell?.addEventListener('pointerdown', wake);
    shell?.addEventListener('keydown', wake);
    shell?.addEventListener('focusin', wake);
    shell?.addEventListener('focusout', wake);
    shell?.addEventListener('pointerleave', wake);
    return () => {
      window.clearTimeout(timer);
      shell?.removeEventListener('pointermove', wake);
      shell?.removeEventListener('pointerdown', wake);
      shell?.removeEventListener('keydown', wake);
      shell?.removeEventListener('focusin', wake);
      shell?.removeEventListener('focusout', wake);
      shell?.removeEventListener('pointerleave', wake);
    };
  }, [open, immersive, paused, menuOpen, panelOpen, helpOpen, picker, blocked, dragging]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    shellRef.current?.focus({preventScroll: true});
    return () => {
      if (previous?.isConnected) previous.focus({preventScroll: true});
    };
  }, [open]);
  useEffect(() => {
    if (!open || blocked) return;
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const shell = shellRef.current;
      if (!shell) return;
      const candidates = [...shell.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        el => el.getClientRects().length && !el.closest('[inert]'),
      );
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      if (!first) {
        e.preventDefault();
        shell.focus();
        return;
      }
      if (!shell.contains(document.activeElement) || document.activeElement === shell) {
        e.preventDefault();
        (e.shiftKey ? last : first)?.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => document.removeEventListener('keydown', trap);
  }, [open, blocked]);

  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        !target.closest('#watch-actions, [aria-controls="watch-actions"]')
      )
        setMenuOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [menuOpen]);

  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (!video?.getAttribute('src')) return;
    if (video.paused) playQuietly(video);
    else video.pause();
  }, []);
  const seek = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    // Exact currentTime is appropriate for a user-chosen timestamp; fastSeek may snap to a keyframe.
    video.currentTime = Math.max(0, Math.min(video.duration, seconds));
    setPosition({current: video.currentTime, duration: video.duration});
  }, []);
  const step = useCallback(
    (delta: number) => {
      if (index < 0) return;
      const next = clips[index + delta];
      if (next) onSelect(next.slug);
    },
    [clips, index, onSelect],
  );
  const applyVolume = useCallback((next: number) => {
    const level = round3(clamp01(next));
    setVolume(level);
    remember(VOLUME_KEY, String(level));
    if (level > 0) {
      setMuted(false);
      remember(MUTED_KEY, '0');
    }
  }, []);
  const toggleMuted = useCallback(
    () =>
      setMuted(previous => {
        remember(MUTED_KEY, previous ? '0' : '1');
        return !previous;
      }),
    [],
  );
  const applySpeed = (next: number) => {
    if (PLAYBACK_SPEEDS.includes(next)) {
      setSpeed(next);
      remember(SPEED_KEY, String(next));
    }
  };

  const saveFrame = useCallback(async () => {
    const video = videoRef.current;
    if (!clip || !video || grabbing) return;
    setGrabbing(true);
    try {
      const result = await api.saveFrame(clip.slug, video.currentTime);
      if (result.ok === false) throw new Error(result.error || t('viewer.errSaveFrame'));
      props.notify(
        result.copied === false ? t('viewer.frameSavedNotCopied') : t('viewer.frameSaved'),
        result.copy_error || imageTitle(result),
        'accent',
      );
    } catch (err) {
      props.notify(t('viewer.errSaveFrame'), (err as Error).message, 'error');
    } finally {
      setGrabbing(false);
    }
  }, [clip, grabbing, props.notify]);
  const addHighlight = useCallback(async () => {
    const video = videoRef.current;
    if (!clip || !video || !Number.isFinite(video.duration)) return;
    const slug = clip.slug;
    const time = video.currentTime;
    const label = nextHighlightLabel(highlights);
    const color = HIGHLIGHT_COLORS[highlights.length % HIGHLIGHT_COLORS.length];
    try {
      const result = await api.addHighlight(slug, {time, label, color});
      const highlight = result.highlight;
      if (!highlight) throw new Error(result.error || t('viewer.daemonNoMark'));
      if (liveClip.current === slug)
        onHighlightsChange(current => sortHighlights([...current, highlight]));
      props.notify(`${label} · ${formatDuration(time, true)}`, undefined, 'accent');
    } catch (err) {
      props.notify(t('viewer.errAddHighlight'), (err as Error).message, 'error');
    }
  }, [clip, highlights, onHighlightsChange, props.notify]);

  useEscape(
    open && !blocked,
    useCallback(() => {
      if (picker) {
        setPicker(null);
        return;
      }
      if (menuOpen) {
        setMenuOpen(false);
        controlsRef.current
          ?.querySelector<HTMLButtonElement>('[aria-controls="watch-actions"]')
          ?.focus();
        return;
      }
      if (helpOpen) {
        setHelpOpen(false);
        return;
      }
      if (panelOpen) {
        setPanelOpen(false);
        controlsRef.current
          ?.querySelector<HTMLButtonElement>('[aria-controls="watch-highlights"]')
          ?.focus();
        return;
      }
      if (fullscreen) {
        void setFull(false);
        return;
      }
      if (expanded) {
        setExpanded(false);
        return;
      }
      onClose();
    }, [picker, menuOpen, helpOpen, panelOpen, fullscreen, expanded, setFull, onClose]),
  );
  useEffect(() => {
    if (!open || closing || blocked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest('input, textarea, select') || target?.isContentEditable) return;
      const key = e.key.toLowerCase();
      if ((e.code === 'Space' || key === ' ') && target?.closest('button, a, [role="button"]'))
        return;
      if (e.code === 'Space' || key === ' ' || key === 'k') {
        e.preventDefault();
        if (!e.repeat) toggle();
      } else if (key === 'arrowleft' || key === 'arrowright') {
        e.preventDefault();
        const delta = key === 'arrowright' ? 1 : -1;
        if (e.shiftKey) step(delta);
        else seek((videoRef.current?.currentTime ?? 0) + delta * 5);
      } else if (key === 'arrowup' || key === 'arrowdown') {
        e.preventDefault();
        applyVolume(volume + (key === 'arrowup' ? 0.05 : -0.05));
      } else if (key === 'home' || key === 'end') {
        e.preventDefault();
        seek(key === 'home' ? 0 : (videoRef.current?.duration ?? 0));
      } else if (key === 'h' && !e.repeat) {
        e.preventDefault();
        void addHighlight();
      } else if (key === 'f' && !e.repeat) {
        e.preventDefault();
        void setFull(!fullscreen);
      } else if (key === 's' && !e.repeat) {
        e.preventDefault();
        void saveFrame();
      } else if (key === 'm' && !e.repeat) {
        e.preventDefault();
        toggleMuted();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [
    open,
    closing,
    blocked,
    toggle,
    step,
    seek,
    addHighlight,
    setFull,
    fullscreen,
    saveFrame,
    toggleMuted,
    applyVolume,
    volume,
  ]);

  const beginHighlightDrag = (
    event: React.PointerEvent,
    highlight: Highlight,
    track: HTMLElement,
  ) => {
    if (event.button !== 0 || !position.duration || !clip) return;
    event.preventDefault();
    event.stopPropagation();
    dragCleanup.current?.();
    setDragging(highlight.id);
    const slug = clip.slug;
    let latest = highlight.time;
    let moved = false;
    const startX = event.clientX;
    const timeAt = (clientX: number) => {
      const rect = track.getBoundingClientRect();
      return rect.width ? clamp01((clientX - rect.left) / rect.width) * position.duration : latest;
    };
    const move = (e: PointerEvent) => {
      if (liveClip.current !== slug) return;
      if (Math.abs(e.clientX - startX) < 3 && !moved) return;
      moved = true;
      latest = round3(timeAt(e.clientX));
      onHighlightsChange(current => sortHighlights(replaceTime(current, highlight.id, latest)));
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      dragCleanup.current = null;
      setDragging(null);
    };
    const cancel = () => {
      cleanup();
      if (liveClip.current === slug)
        onHighlightsChange(current =>
          sortHighlights(replaceTime(current, highlight.id, highlight.time)),
        );
    };
    const up = async () => {
      cleanup();
      if (!moved || liveClip.current !== slug) return;
      try {
        const result = await api.updateHighlight(slug, highlight.id, {time: latest});
        if (result.ok === false) throw new Error(result.error || t('viewer.daemonRejectedMove'));
      } catch (err) {
        if (liveClip.current === slug)
          onHighlightsChange(current =>
            sortHighlights(replaceTime(current, highlight.id, highlight.time)),
          );
        props.notify(t('viewer.errMoveHighlight'), (err as Error).message, 'error');
      }
    };
    dragCleanup.current = cleanup;
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
  };
  const patchHighlight = async (id: string, body: Partial<Omit<Highlight, 'id'>>) => {
    if (!clip) return;
    const slug = clip.slug;
    try {
      const result = await api.updateHighlight(slug, id, body);
      if (result.ok === false) throw new Error(result.error || t('viewer.daemonRejectedChange'));
      if (liveClip.current === slug)
        onHighlightsChange(current =>
          sortHighlights(current.map(h => (h.id === id ? {...h, ...body} : h))),
        );
    } catch (err) {
      props.notify(t('viewer.errUpdateHighlight'), (err as Error).message, 'error');
    }
  };
  const removeHighlight = async (id: string) => {
    if (!clip) return;
    const slug = clip.slug;
    try {
      await api.deleteHighlight(slug, id);
      if (liveClip.current === slug)
        onHighlightsChange(current => current.filter(h => h.id !== id));
    } catch (err) {
      props.notify(t('viewer.errDeleteHighlight'), (err as Error).message, 'error');
    }
  };

  // External modal portals must remain visible above the player, including in browser fullscreen.
  const externalAction = (action: () => void) => {
    setMenuOpen(false);
    const run = () => {
      setExpanded(false);
      action();
    };
    if (fullscreen || fullscreenPending.current) {
      void setFull(false).then(success => {
        if (success) run();
      });
    } else run();
  };
  if (!mounted || !clip) return null;
  const meta = [
    clip.duration ? formatDuration(clip.duration, true) : '',
    clip.width ? `${clip.width}×${clip.height}` : '',
    clip.size ? formatBytes(clip.size) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const updatePosition = (video: HTMLVideoElement) =>
    setPosition({
      current: video.currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
    });
  return (
    <div
      className="scrim watch-scrim"
      data-closing={closing || undefined}
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={shellRef}
        className="watch-shell"
        role="dialog"
        aria-modal="true"
        aria-label={clipTitle(clip)}
        tabIndex={-1}
        data-immersive={immersive || undefined}
        data-expanded={expanded || undefined}
        data-fullscreen={fullscreen || undefined}
        data-idle={idle || undefined}
        data-closing={closing || undefined}
      >
        <header className="watch-heading" data-player-controls="true">
          <div className="viewer-heading">
            {renamingTitle ? (
              <InlineRename
                className="viewer-rename"
                label={t('card.nameLabel')}
                initial={clipTitle(clip)}
                onCancel={() => setRenamingTitle(false)}
                onSubmit={name => {
                  setRenamingTitle(false);
                  props.onRename(clip, name);
                }}
              />
            ) : (
              <h2
                title={t('viewer.doubleClickRename')}
                onDoubleClick={() => setRenamingTitle(true)}
              >
                {clipTitle(clip)}
              </h2>
            )}
            <p className="mono">
              {meta}
              {clips.length > 1 ? ` · ${index + 1} / ${clips.length}` : ''}
            </p>
          </div>
          <button
            type="button"
            className="modal-close"
            aria-label={t('viewer.closePlayer')}
            onClick={onClose}
          >
            <IconClose size={18} />
          </button>
        </header>
        <div
          className="watch-stage"
          ref={stageRef}
          onClick={e => {
            if (
              e.target instanceof Element &&
              e.target.closest(
                'button, input, select, [data-player-controls], .video-overlay, .key-overlay',
              )
            )
              return;
            // A browser-recognized second click belongs to double-click only.
            if (e.detail > 1) return;
            window.clearTimeout(clickTimer.current);
            const intent = {
              slug: liveClip.current,
              wasPaused: videoRef.current?.paused ?? true,
              applied: false,
            };
            clickIntent.current = intent;
            clickTimer.current = window.setTimeout(() => {
              if (clickIntent.current !== intent || liveClip.current !== intent.slug) return;
              intent.applied = true;
              toggle();
            }, 300);
            // Return keyboard ownership to the player without stealing focus from controls.
            shellRef.current?.focus({preventScroll: true});
          }}
          onDoubleClick={e => {
            if (
              e.target instanceof Element &&
              e.target.closest(
                'button, input, select, [data-player-controls], .video-overlay, .key-overlay',
              )
            )
              return;
            window.clearTimeout(clickTimer.current);
            const intent = clickIntent.current;
            // Desktop double-click intervals can exceed our single-click delay.
            // Restore the original transport state if that delay already fired.
            if (intent?.applied && intent.slug === liveClip.current) {
              if (intent.wasPaused) videoRef.current?.pause();
              else playQuietly(videoRef.current);
            }
            clickIntent.current = null;
            void setFull(!fullscreen);
          }}
        >
          <video
            ref={videoRef}
            className="watch-video"
            playsInline
            onTimeUpdate={e => updatePosition(e.currentTarget)}
            onLoadedMetadata={e => updatePosition(e.currentTarget)}
            onPlay={() => setPaused(false)}
            onPause={() => setPaused(true)}
            onCanPlay={() => setPreparing(false)}
            onLoadedData={() => setPreparing(false)}
            onError={() => {
              setPreparing(false);
              videoRef.current?.pause();
            }}
            onEnded={() => {
              if (endBehavior === 'loop') {
                seek(0);
                playQuietly(videoRef.current);
              } else if (endBehavior === 'next') step(1);
            }}
          />
          {paused && !preparing && !failed ? (
            <button
              type="button"
              className="watch-center-play"
              aria-label={t('viewer.play')}
              onClick={toggle}
            >
              <PlayGlyph />
            </button>
          ) : null}
          {preparing ? (
            <div className="video-overlay">
              <span className="video-spinner" aria-hidden="true" />
              <p>{t('viewer.preparingPreview')}</p>
            </div>
          ) : null}
          {keyIntervals && keysShown && !failed ? (
            <KeyOverlay video={videoRef} intervals={keyIntervals} />
          ) : null}
          {failed ? (
            <div className="video-overlay">
              <p>{videoFailureMessage()}</p>
              <div className="video-overlay-actions">
                <button type="button" className="btn" onClick={() => props.onOpenExternally(clip)}>
                  {t('viewer.openInPlayer')}
                </button>
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => props.onReveal(clip)}
                >
                  {t('viewer.showInFolder')}
                </button>
              </div>
            </div>
          ) : null}
        </div>
        <div ref={controlsRef} className="watch-control-area">
          <ViewerControls
            paused={paused}
            current={position.current}
            duration={position.duration}
            volume={volume}
            muted={muted}
            speed={speed}
            endBehavior={endBehavior}
            highlights={highlights}
            canPrevious={index > 0}
            canNext={index >= 0 && index < clips.length - 1}
            expanded={expanded}
            fullscreen={fullscreen}
            fullscreenBusy={fullscreenBusy}
            shareLabel={props.shareLabel}
            panelOpen={panelOpen}
            menuOpen={menuOpen}
            onToggle={toggle}
            onStep={step}
            onSeek={seek}
            onVolume={applyVolume}
            onMute={toggleMuted}
            onSpeed={applySpeed}
            onEndBehavior={setEndBehavior}
            onExpand={() => setExpanded(value => !value)}
            onFullscreen={() => void setFull(!fullscreen)}
            onShare={() => externalAction(() => props.onShare(clip))}
            onShareMenu={() => externalAction(() => props.onShareMenu(clip))}
            onPanel={() => {
              setPanelOpen(value => !value);
              setMenuOpen(false);
              setHelpOpen(false);
            }}
            onMenu={() => {
              setMenuOpen(value => !value);
              setPanelOpen(false);
              setHelpOpen(false);
            }}
            onHighlightDrag={beginHighlightDrag}
          />
        </div>
        {panelOpen ? (
          <section
            id="watch-highlights"
            className="watch-panel"
            aria-label={t('viewer.highlightsHeading')}
            data-player-controls="true"
          >
            <button
              type="button"
              className="watch-panel-close player-btn"
              aria-label={t('common.close')}
              onClick={() => setPanelOpen(false)}
            >
              <IconClose size={14} />
            </button>
            <div className="viewer-hl-head">
              <span className="eyebrow">{t('viewer.highlightsHeading')}</span>
              <button
                type="button"
                className="btn btn-quiet btn-sm"
                onClick={() => void addHighlight()}
              >
                {tNode('viewer.addHighlightKey', {key: <kbd key="k">H</kbd>})}
              </button>
            </div>

            <div className="viewer-hl-list">
              {highlights.length === 0 ? (
                <p className="viewer-hl-empty">
                  {tNode('viewer.noHighlightsHelp', {key: <kbd key="k">H</kbd>})}
                </p>
              ) : (
                highlights.map(h => (
                  <div className="hl-item" key={h.id} onClick={() => seek(h.time)}>
                    <button
                      type="button"
                      className="hl-swatch"
                      style={{background: h.color || DEFAULT_HIGHLIGHT_COLOR}}
                      title={t('viewer.changeColour')}
                      aria-label={t('viewer.changeColourAria', {name: h.label})}
                      onClick={e => {
                        e.stopPropagation();
                        const rect = e.currentTarget.getBoundingClientRect();
                        setPicker({
                          id: h.id,
                          color: h.color || DEFAULT_HIGHLIGHT_COLOR,
                          at: {x: rect.left, y: rect.bottom + 6},
                        });
                      }}
                    />
                    <span className="hl-time mono">{formatDuration(h.time, true)}</span>
                    {renaming === h.id ? (
                      <InlineRename
                        className="hl-rename"
                        label={t('viewer.highlightLabel')}
                        initial={h.label}
                        emptyFallback={t('viewer.highlight')}
                        stopPropagation
                        onCancel={() => setRenaming(null)}
                        onSubmit={label => {
                          setRenaming(null);
                          void patchHighlight(h.id, {label});
                        }}
                      />
                    ) : (
                      <span
                        className="hl-label"
                        title={t('viewer.doubleClickRename')}
                        onDoubleClick={e => {
                          e.stopPropagation();
                          setRenaming(h.id);
                        }}
                      >
                        {h.label}
                      </span>
                    )}
                    <button
                      type="button"
                      className="hl-del"
                      title={t('viewer.removeHighlight')}
                      aria-label={t('viewer.removeHighlightAria', {name: h.label})}
                      onClick={e => {
                        e.stopPropagation();
                        void removeHighlight(h.id);
                      }}
                    >
                      <IconClose size={12} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </section>
        ) : null}
        {menuOpen ? (
          <div
            id="watch-actions"
            className="watch-menu"
            role="region"
            aria-label={t('viewer.actions')}
            data-player-controls="true"
          >
            <button type="button" onClick={() => externalAction(() => props.onTrim(clip))}>
              {t('viewer.trim')}
            </button>
            <button
              type="button"
              disabled={grabbing || clip.unreadable}
              onClick={() => {
                setMenuOpen(false);
                void saveFrame();
              }}
            >
              {t('viewer.saveFrame')}
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                props.onReveal(clip);
              }}
            >
              {t('viewer.reveal')}
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setRenamingTitle(true);
              }}
            >
              {t('viewer.rename')}
            </button>
            {keyIntervals ? (
              <button
                type="button"
                aria-pressed={keysShown}
                onClick={() => {
                  setKeysShown(!keysShown);
                  remember(KEYS_SHOWN_KEY, keysShown ? '0' : '1');
                }}
              >
                {t('viewer.keys')}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setHelpOpen(true);
              }}
            >
              {t('viewer.shortcutHelp')}
            </button>
            <button
              type="button"
              className="watch-delete"
              onClick={() => externalAction(() => props.onDelete(clip))}
            >
              {t('viewer.delete')}
            </button>
          </div>
        ) : null}
        {helpOpen ? (
          <section
            className="watch-panel watch-help"
            aria-label={t('viewer.shortcutHelp')}
            data-player-controls="true"
          >
            <button
              type="button"
              className="watch-panel-close player-btn"
              aria-label={t('common.close')}
              onClick={() => setHelpOpen(false)}
            >
              <IconClose size={14} />
            </button>
            <h3>{t('viewer.shortcutHelp')}</h3>
            <dl>
              {[
                ['Space / K', 'helpPlay'],
                ['← / →', 'helpSeek'],
                ['Shift + ← / →', 'helpClips'],
                ['↑ / ↓', 'volume'],
                ['Home / End', 'helpBounds'],
                ['M', 'mute'],
                ['F', 'fullscreen'],
                ['H', 'addHighlight'],
                ['S', 'saveFrame'],
                ['Esc', 'helpEscape'],
              ].map(([key, label]) => (
                <div key={key}>
                  <dt>
                    <kbd>{key}</kbd>
                  </dt>
                  <dd>{t(`viewer.${label}`)}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
        {fullscreenError ? (
          <div className="watch-error" role="alert" data-player-controls="true">
            <span>
              {t('viewer.fullscreenFailed')}: {fullscreenError}
            </span>
            <button
              type="button"
              className="player-btn"
              aria-label={t('common.close')}
              onClick={() => setFullscreenError(null)}
            >
              <IconClose size={14} />
            </button>
          </div>
        ) : null}
        {picker ? (
          <ColorPicker
            at={picker.at}
            current={picker.color}
            onClose={() => setPicker(null)}
            onPick={color => {
              setPicker(null);
              void patchHighlight(picker.id, {color});
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function ColorPicker({
  at,
  current,
  onPick,
  onClose,
}: {
  at: {x: number; y: number};
  current: string;
  onPick: (color: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dismiss = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    // Deferred a frame: the click that opened this popup is still travelling.
    const id = window.setTimeout(() => document.addEventListener('pointerdown', dismiss, true), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('pointerdown', dismiss, true);
    };
  }, [onClose]);

  return (
    <div className="hl-picker" ref={ref} style={{left: at.x, top: at.y}} role="menu">
      {HIGHLIGHT_COLORS.map(color => (
        <button
          key={color}
          type="button"
          className="hl-picker-dot"
          data-active={color === current || undefined}
          style={{background: color}}
          title={color}
          aria-label={t('viewer.useColour', {color})}
          onClick={() => onPick(color)}
        />
      ))}
    </div>
  );
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round3 = (n: number) => Number(n.toFixed(3));
const sortHighlights = (list: Highlight[]) => [...list].sort((a, b) => a.time - b.time);
const replaceTime = (list: Highlight[], id: string, time: number) =>
  list.map(h => (h.id === id ? {...h, time} : h));

/** "Highlight", then "Highlight 1", and so on, skipping names already used. */
function nextHighlightLabel(highlights: Highlight[]): string {
  // The label is stored with the clip, so this is a default name the user can
  // overwrite, like "Untitled" in an editor. It is translated for the same
  // reason. Labels already on disk keep whatever they were saved as.
  const base = t('viewer.highlight');
  const used = new Set(highlights.map(h => h.label));
  if (!used.has(base)) return base;
  let n = 1;
  while (used.has(t('viewer.highlightNumbered', {base, n}))) n++;
  return t('viewer.highlightNumbered', {base, n});
}

const PlayGlyph = () => (
  <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor" aria-hidden="true">
    <path d="M7 4l13 8-13 8z" />
  </svg>
);
