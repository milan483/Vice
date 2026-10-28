import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {api} from '../lib/api';
import {copyShareLink, shareButtonLabel, shareClip as runShare} from '../lib/share';
import {clipTitle, type Clip, type Highlight} from '../lib/types';
import {Modal} from '../components/Modal';
import {ShareModal} from '../components/ShareModal';
import {TrimModal} from '../components/TrimModal';
import {Viewer, type HighlightUpdate} from '../components/Viewer';
import {useRenameClip} from './clipActions';
import {useStore} from './store';
import {t} from '../lib/i18n';
import {snapshotQueue, resolveQueue, renameInQueue} from './playbackQueue';

interface Playback {
  openViewer: (slug: string, originatingSlugs?: readonly string[]) => void;
  renameClip: (clip: Clip, name: string) => Promise<Clip | null>;
  openTrim: (slug: string) => void;
  openShare: (slug: string) => void;
}

const PlaybackContext = createContext<Playback | null>(null);

/**
 * Owns the viewer and the trim modal, so any screen can open a clip without
 * carrying the playback element around with it. Both surfaces live here rather
 * than inside a screen because the viewer has to survive a change of view.
 */
export function PlaybackProvider({children}: {children: ReactNode}) {
  const {state, notify, refreshClips} = useStore();
  const {clips} = state;

  const [queueSlugs, setQueueSlugs] = useState<string[]>([]);
  const [viewerSlug, setViewerSlug] = useState<string | null>(null);
  const [trimSlug, setTrimSlug] = useState<string | null>(null);
  const [highlightState, setHighlightState] = useState<{slug: string | null; list: Highlight[]}>({
    slug: null,
    list: [],
  });
  // Never render the previous clip's markers while the next request is pending.
  const highlights = highlightState.slug === viewerSlug ? highlightState.list : [];
  const highlightRevision = useRef(0);
  const setHighlights = useCallback(
    (update: HighlightUpdate) => {
      highlightRevision.current += 1;
      setHighlightState(current => ({
        slug: viewerSlug,
        list:
          typeof update === 'function'
            ? update(current.slug === viewerSlug ? current.list : [])
            : update,
      }));
    },
    [viewerSlug],
  );
  const [confirmDelete, setConfirmDelete] = useState<Clip | null>(null);
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const [shareSlug, setShareSlug] = useState<string | null>(null);

  const viewerClip = clips.find(c => c.slug === viewerSlug) ?? null;
  const trimClip = clips.find(c => c.slug === trimSlug) ?? null;
  const shareClip = clips.find(c => c.slug === shareSlug) ?? null;

  const viewerClips = useMemo(() => resolveQueue(queueSlugs, clips), [queueSlugs, clips]);

  const openViewer = useCallback(
    (slug: string, originatingSlugs?: readonly string[]) => {
      // Card previews keep decoding behind the scrim otherwise, and they are
      // muted, so nothing on screen would explain the extra load.
      document.querySelectorAll<HTMLVideoElement>('video.clip-preview').forEach(v => v.pause());
      setQueueSlugs(snapshotQueue(slug, originatingSlugs ?? clips.map(clip => clip.slug)));
      setViewerSlug(slug);
    },
    [clips],
  );

  const openTrim = useCallback((slug: string) => setTrimSlug(slug), []);

  // Highlights belong to the clip on screen, so they reload whenever it does.
  useEffect(() => {
    if (!viewerSlug) {
      setHighlightState({slug: null, list: []});
      return;
    }
    let cancelled = false;
    const load = async (): Promise<void> => {
      const revision = highlightRevision.current;
      try {
        const list = await api.highlights(viewerSlug);
        if (cancelled) return;
        // A mutation completed after this GET took its snapshot. Read again
        // rather than erasing it or losing marks that predated the new one.
        if (revision !== highlightRevision.current) {
          void load();
          return;
        }
        setHighlightState({slug: viewerSlug, list});
      } catch (err) {
        console.debug('Loading highlights failed', err);
        // Retain successful local mutations if the initial read fails.
        if (!cancelled)
          setHighlightState(current =>
            current.slug === viewerSlug ? current : {slug: viewerSlug, list: []},
          );
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [viewerSlug]);

  // A rename in flight. The daemon broadcasts clip_deleted for the old slug
  // the moment the file moves, which reaches the effect below well before the
  // response carrying the new slug gets back here. Without this the viewer
  // closes on the user mid-rename and there is nothing left to redirect (#170).
  const renamingFrom = useRef<string | null>(null);

  // A clip deleted underneath the viewer, from anywhere, closes it.
  useEffect(() => {
    const gone = (slug: string) =>
      slug !== renamingFrom.current && !clips.some(c => c.slug === slug);
    if (viewerSlug && gone(viewerSlug)) setViewerSlug(null);
    if (trimSlug && gone(trimSlug)) setTrimSlug(null);
    if (shareSlug && gone(shareSlug)) setShareSlug(null);
  }, [clips, viewerSlug, trimSlug, shareSlug]);

  const renameClip = useRenameClip();
  const rename = useCallback(
    async (clip: Clip, name: string) => {
      renamingFrom.current = clip.slug;
      try {
        const updated = await renameClip(clip, name);
        if (updated?.slug) {
          setQueueSlugs(current => renameInQueue(current, clip.slug, updated.slug));
          setViewerSlug(current => (current === clip.slug ? updated.slug : current));
          setTrimSlug(current => (current === clip.slug ? updated.slug : current));
          setShareSlug(current => (current === clip.slug ? updated.slug : current));
        }
        return updated;
      } finally {
        renamingFrom.current = null;
      }
    },
    [renameClip],
  );

  const fail = useCallback(
    (title: string) => (err: Error) =>
      notify({kind: 'error', title, detail: err.message, tone: 'error', holdMs: 7000}),
    [notify],
  );

  const say = useCallback(
    (title: string, detail?: string, tone: 'accent' | 'error' = 'accent') =>
      notify({
        kind: tone === 'error' ? 'error' : 'info',
        title,
        detail,
        tone,
        holdMs: tone === 'error' ? 7000 : 3500,
      }),
    [notify],
  );

  const reveal = useCallback(
    (clip: Clip) => void api.revealClip(clip.slug).catch(fail(t('viewer.errReveal'))),
    [fail],
  );

  const openExternally = useCallback(
    (clip: Clip) => void api.openClip(clip.slug).catch(fail(t('viewer.errSystemPlayer'))),
    [fail],
  );

  const discordFile = Boolean(state.config?.sharing?.share_discord_file);
  const share = useCallback(
    (clip: Clip) => void runShare(clip, discordFile, notify, setManualCopy),
    [discordFile, notify],
  );
  const shareMenu = useCallback((clip: Clip) => setShareSlug(clip.slug), []);

  const copyLink = useCallback(
    (clip: Clip) => void copyShareLink(clip, notify, setManualCopy),
    [notify],
  );

  const value = useMemo<Playback>(
    () => ({openViewer, openTrim, openShare: setShareSlug, renameClip: rename}),
    [openViewer, openTrim, rename],
  );

  return (
    <PlaybackContext.Provider value={value}>
      {children}

      <Viewer
        clip={viewerClip}
        clips={viewerClips}
        highlights={highlights}
        onHighlightsChange={setHighlights}
        onSelect={setViewerSlug}
        onClose={() => setViewerSlug(null)}
        onTrim={clip => setTrimSlug(clip.slug)}
        trimOpen={trimSlug !== null}
        overlayOpen={
          trimSlug !== null || shareSlug !== null || confirmDelete !== null || manualCopy !== null
        }
        onRename={rename}
        onShare={share}
        onShareMenu={shareMenu}
        shareLabel={shareButtonLabel(discordFile)}
        onReveal={reveal}
        onOpenExternally={openExternally}
        onDelete={setConfirmDelete}
        notify={say}
      />

      <ShareModal clip={shareClip} onClose={() => setShareSlug(null)} onCopyLink={copyLink} />

      <TrimModal
        clip={trimClip}
        highlights={trimSlug && trimSlug === viewerSlug ? highlights : []}
        onClose={() => setTrimSlug(null)}
        onSaved={refreshClips}
        notify={say}
        onRename={rename}
        onReveal={reveal}
        onOpenExternally={openExternally}
      />

      <Modal
        open={confirmDelete !== null}
        title={t('viewer.confirmDeleteTitle')}
        onClose={() => setConfirmDelete(null)}
        footer={
          <>
            <button type="button" className="btn btn-quiet" onClick={() => setConfirmDelete(null)}>
              {t('common.keepIt')}
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              onClick={() => {
                const clip = confirmDelete;
                setConfirmDelete(null);
                if (!clip) return;
                setViewerSlug(null);
                void api
                  .deleteClip(clip.slug)
                  .then(() => say(t('viewer.clipDeleted')))
                  .catch(fail(t('viewer.errDelete')));
              }}
            >
              {t('common.delete')}
            </button>
          </>
        }
      >
        <p>
          {t('viewer.confirmDeleteBody', {
            name: confirmDelete ? clipTitle(confirmDelete) : '',
          })}
        </p>
      </Modal>

      <Modal
        open={manualCopy !== null}
        title={t('viewer.copyLinkTitle')}
        onClose={() => setManualCopy(null)}
      >
        <p>{t('viewer.copyLinkBody')}</p>
        <textarea className="manual-copy" readOnly value={manualCopy ?? ''} rows={3} />
      </Modal>
    </PlaybackContext.Provider>
  );
}

export function usePlayback(): Playback {
  const playback = useContext(PlaybackContext);
  if (!playback) throw new Error('usePlayback was called outside the provider');
  return playback;
}
