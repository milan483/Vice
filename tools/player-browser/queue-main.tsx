import {createRoot} from 'react-dom/client';
import {Theme} from '@astryxdesign/core/theme';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '../../ui-src/styles/base.css';
import '../../ui-src/styles/shell.css';
import '../../ui-src/styles/home.css';
import '../../ui-src/styles/clips.css';
import '../../ui-src/styles/images.css';
import '../../ui-src/styles/viewer.css';
import '../../ui-src/styles/settings.css';
import '../../ui-src/styles/editor.css';
import {StoreProvider, useStore} from '../../ui-src/state/store';
import {PlaybackProvider, usePlayback} from '../../ui-src/state/playback';
import {OverlayRoot} from '../../ui-src/components/OverlayPortal';
import {Home} from '../../ui-src/screens/Home';
import {Clips} from '../../ui-src/screens/Clips';
import {api} from '../../ui-src/lib/api';
import {initLocale} from '../../ui-src/lib/i18n';
import {accentVars, resolveAccent} from '../../ui-src/theme/viceTheme';
import type {Clip, Highlight} from '../../ui-src/lib/types';

const makeClip = (slug: string, index = 0): Clip => ({
  slug, name: `${slug}.mp4`, size: 2400000, created_at: '2026-10-27T10:00:00Z',
  game: index % 2 ? 'Other game' : 'Selected game', views: 10 - index,
  duration: 30, width: 640, height: 360, vcodec: 'h264', unreadable: false,
  unreadable_reason: '', share_url: '', share_is_public: false,
  video_url: `/fixture.mp4?queue=${slug}`, thumb_url: '',
});
let library = Array.from({length: 10}, (_, i) => makeClip(`clip-${i}`, i));
// Most viewed order differs from the recent row and includes a ninth/tenth clip.
library[8].views = 100; library[9].views = 90;
const pending = new Map<string, {resolve: (value: Highlight[]) => void; reject: (reason: Error) => void; snapshot: Highlight[]}>();
const savedHighlights = new Map<string, Highlight[]>();
let highlightId = 0;
const held = new Set<string>();
let updateStore: (clips: Clip[]) => void = () => {};
const highlight = (slug: string): Highlight[] => savedHighlights.get(slug) ?? [{id: `mark-${slug}`, label: `Marker ${slug}`, time: 4, color: '#ffaa00'}];
Object.assign(api, {
  getConfig: async () => ({recording: {clip_duration: 20}, sharing: {}}),
  clips: async () => [...library], images: async () => [],
  playlists: async () => [{id: 'selected', name: 'Selected clips', kind: 'custom', clip_slugs: ['clip-8', 'clip-4', 'clip-0'], emoji: null, color1: null, color2: null, created_at: '', edited: false}],
  status: async () => ({running: true, recording: false, version: '', hotkeys_available: true, backend: 'auto'}),
  markViewed: async () => ({views: 1}),
  highlights: (slug: string) => {
    const snapshot = highlight(slug).map(mark => ({...mark}));
    return held.has(slug)
      ? new Promise<Highlight[]>((resolve, reject) => pending.set(slug, {resolve, reject, snapshot}))
      : Promise.resolve(snapshot);
  },
  addHighlight: async (slug: string, body: Omit<Highlight, 'id'>) => {
    const mark = {...body, id: `added-${++highlightId}`};
    savedHighlights.set(slug, [...highlight(slug), mark]);
    return {ok: true, highlight: mark};
  },
  renameClip: async (slug: string, name: string) => {
    const old = library.find(clip => clip.slug === slug)!;
    library = library.filter(clip => clip.slug !== slug);
    updateStore([...library]); // Match daemon clip_deleted before the response.
    await new Promise(resolve => setTimeout(resolve, 60));
    const updated = {...old, slug: name, name: `${name}.mp4`, video_url: `/fixture.mp4?queue=${name}`};
    library = [...library, updated];
    return updated;
  },
});
// Provider owns real websocket lifecycle; this harness supplies mutations explicitly.
window.WebSocket = class {close() {}} as unknown as typeof WebSocket;

function Controls() {
  const {state, dispatch, visibleClips} = useStore();
  const playback = usePlayback();
  updateStore = clips => dispatch({type: 'setClips', clips});
  Object.assign(window, {queueHarness: {
    ready: state.ready, visible: visibleClips.map(clip => clip.slug),
    open: playback.openViewer,
    add: (slug: string) => {library = [makeClip(slug), ...library]; updateStore([...library]);},
    remove: (slug: string) => {library = library.filter(clip => clip.slug !== slug); updateStore([...library]);},
    rename: (slug: string, name: string) => playback.renameClip(state.clips.find(clip => clip.slug === slug)!, name),
    search: (query: string) => dispatch({type: 'setSearch', query}),
    view: (view: 'home' | 'clips', playlistId: string | null = null) => dispatch({type: 'setView', view, playlistId}),
    hold: (slug: string) => held.add(slug),
    release: (slug: string, fail = false) => {
      held.delete(slug);
      const request = pending.get(slug);
      if (fail) request?.reject(new Error('Delayed highlights GET failed'));
      else request?.resolve(request.snapshot);
      pending.delete(slug);
    },
    pending: (slug: string) => pending.has(slug),
  }});
  return <div data-ready={state.ready}>{state.view === 'home' ? <Home/> : <Clips/>}</div>;
}
const {theme, ramp} = resolveAccent('blue');
initLocale();
createRoot(document.getElementById('root')!).render(
  <Theme theme={theme} mode="dark"><div className="vice-app" style={accentVars(ramp)}>
    <OverlayRoot><StoreProvider><PlaybackProvider><Controls/></PlaybackProvider></StoreProvider></OverlayRoot>
  </div></Theme>,
);
