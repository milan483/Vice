import {useRef, useState} from 'react';
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
import {Viewer} from '../../ui-src/components/Viewer';
import {Modal} from '../../ui-src/components/Modal';
import {TrimModal} from '../../ui-src/components/TrimModal';
import {OverlayRoot} from '../../ui-src/components/OverlayPortal';
import {accentVars, resolveAccent} from '../../ui-src/theme/viceTheme';
import {initLocale} from '../../ui-src/lib/i18n';
import type {Clip, Highlight} from '../../ui-src/lib/types';

const fixtureOptions = new URLSearchParams(location.search);
const clips: Clip[] = ['First recording', 'Second recording', 'Third recording'].map((name, index) => ({
  slug: `fixture-${index}.mp4`, name: `${name}.mp4`, size: 2400000,
  created_at: '2026-10-27T10:00:00Z', game: 'Browser test', views: 1,
  keys: true, duration: 30, width: 640, height: 360, vcodec: fixtureOptions.get('codec') || 'h264',
  unreadable: false, unreadable_reason: '', share_url: '', share_is_public: false,
  video_url: fixtureOptions.has('broken') ? '/fixture-invalid.mp4' : `/fixture.mp4?clip=${index}`, thumb_url: '',
}));
const noop = () => {};
function Harness() {
  const [clip, setClip] = useState<Clip | null>(clips[0]);
  const [overlay, setOverlay] = useState<string | null>(null);
  const actions = useRef<string[]>([]);
  const notifications = useRef<string[]>([]);
  const closeOverlay = () => setOverlay(null);
  const action = (name: string) => {actions.current.push(name); setOverlay(name);};
  Object.assign(window, {playerHarness: {actions: actions.current, notifications: notifications.current, openOverlay: setOverlay}});
  const [highlights, setHighlights] = useState<Highlight[]>([
    {id: '1', time: 4, label: 'First moment', color: '#ffca28'},
    {id: '2', time: 18, label: 'Second moment', color: '#8bc34a'},
  ]);
  const {theme, ramp} = resolveAccent('blue');
  return <Theme theme={theme} mode="dark"><div className="vice-app" style={accentVars(ramp)}>
    <OverlayRoot><button id="harness-outside" onClick={() => setClip(clips[0])}>Open fixture</button>
      <Viewer clip={clip} clips={clips} highlights={highlights} onHighlightsChange={setHighlights}
        onSelect={slug => setClip(clips.find(c => c.slug === slug) ?? null)} onClose={() => setClip(null)}
        onTrim={() => action('trim')} trimOpen={overlay === 'trim'} overlayOpen={overlay !== null}
        onShare={() => action('share')} onShareMenu={() => action('manual-copy')} shareLabel="Share"
        onReveal={() => actions.current.push('reveal')} onDelete={() => action('delete')}
        onOpenExternally={() => actions.current.push('open-external')} onRename={noop}
        notify={title => notifications.current.push(title)}/>
      <TrimModal clip={overlay === 'trim' ? clip : null} highlights={highlights} onClose={closeOverlay}
        onSaved={noop} notify={noop} onRename={noop} onReveal={noop} onOpenExternally={noop}/>
      <Modal open={overlay !== null && overlay !== 'trim'} title={`Fixture ${overlay}`} onClose={closeOverlay}>
        <p>External application overlay fixture</p><input aria-label="External input"/>
      </Modal>
    </OverlayRoot></div></Theme>;
}
initLocale();
createRoot(document.getElementById('root')!).render(<Harness/>);
