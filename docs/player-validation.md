# Normal clip player redesign validation

Validated on 2026-10-27. The editor player was excluded from this change.

## Implemented behavior

- A single video element and transport bar serve normal, expanded-window, and true fullscreen playback.
- The desktop bridge controls the native Qt/GTK window. Browser playback uses the Fullscreen API. Exit restores the previous viewing mode and native window state.
- Space/K plays or pauses; arrows seek five seconds; Shift+arrows navigate the originating queue; M mutes; F toggles fullscreen; H adds a highlight; S saves a frame.
- Playback offers 0.25–2× speed and mutually exclusive Stop, Loop, or Auto-next. Volume, mute, and speed persist; opening starts at the beginning; end behavior resets on close.
- The queue captures the originating Home row, search, or playlist order. New recordings do not enter it; deleted clips are skipped and renamed clips retain their positions.
- Highlights remain on the seek bar. An optional panel manages them; Share is directly accessible; secondary actions and keyboard help live in the actions popover.
- Expanded/fullscreen controls hide after three seconds of uninterrupted playback and stay visible during interaction, focus, pause, or open panels. Seek and volume support keyboard operation.
- Original-media/proxy playback, saved-key overlays, screenshot capture, and trim integration remain available. Fullscreen failures cannot strand external dialogs behind the player.

## Phase results

| Phase | Evidence | Result |
| --- | --- | --- |
| Queue and fullscreen foundations | Node queue/adapter unit tests | 14 passed |
| Viewer interactions and media | Real Chromium, H.264/audio fixture, production component and CSS | 28 passed |
| Provider and originating surfaces | Real StoreProvider, PlaybackProvider, Home, Clips, and daemon-response fixtures | 12 passed |
| Concurrent highlight mutations | Real Chromium with controlled response ordering | 7 passed |
| Native fullscreen and playback | Real Qt/pywebview in an isolated offscreen subprocess | 6 passed |
| Repository regression | Python unittest discovery with optional native Qt lifecycle checks enabled | 921 run, 920 passed, 1 skipped |
| Build and source checks | TypeScript, production Vite build, locale checker, git diff whitespace check | Passed |

The single skipped regression is accent parity, which requires `npx` on PATH.
The locale checker reports existing incomplete translations and uses the project's English fallback for new strings. Production build warnings about font URLs and single-bundle size are unchanged build constraints.

The full regression run initially exposed two host-dependent baseline tests. Both failed on an untouched HEAD checkout as well. Their fixtures now specify hardware-decoding and codec capabilities explicitly. The close-policy test mocks the new fullscreen collaborator; dedicated unit and real-window tests cover that collaborator.

Independent review found and verified fixes for failed/pending fullscreen transitions, hidden focused title controls, stale cross-clip highlights, concurrent highlight updates, and delayed single/double-click interactions. Responsive inspection also caught and removed a legacy rule hiding the volume slider.

## Reproduce

Install the lockfile dependencies, then run:

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
node tools/check-locales.mjs
node --test ui-src/state/playbackQueue.test.mjs tests/ui/fullscreen.test.mjs
VICE_RUN_NATIVE_QT_TESTS=1 python -m unittest discover -s tests
```

Prepare the real-media fixture and start the Vite harness as described in
[the browser harness instructions](../tools/player-browser/README.md), then run:

```sh
node tools/player-browser/check.mjs
node tools/player-browser/queue-check.mjs
node tools/player-browser/highlights-check.mjs
python tests/player_native_smoke.py
```

Browser tooling and executable paths can be overridden through the environment variables documented in the harness. Test reports and screenshots are written under `/tmp/vice-player-browser`; native playback results are written to `/tmp/vice-player-native-report.json`.

## Verification limits

Qt verification used a real offscreen native window and decoded real media. It did not exercise a physical monitor/compositor or multi-monitor placement. GTK fullscreen is covered by unit tests; a real GTK/WebKit session was not run. Thumbnail seek previews, picture-in-picture, playback-position history, and a trim/editor redesign remain deferred as agreed.
