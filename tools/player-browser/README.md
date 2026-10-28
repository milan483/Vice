# Real Viewer browser harness

This loads the production `Viewer` with three fixture clips, two highlights,
keyboard data, the app theme, and the complete production CSS cascade. It also
uses the real TrimModal and Modal for external-overlay integration. Only daemon
requests are stubbed. Chromium decodes an actual 30 second H.264 video with audio.

Prepare a disposable video (requires ffmpeg):

```sh
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=640x360:rate=15 -f lavfi -i sine=frequency=440:sample_rate=22050 -t 30 -c:v libx264 -preset ultrafast -crf 33 -pix_fmt yuv420p -c:a aac -b:a 32k -movflags +faststart -y /tmp/vice-player-test.mp4
node node_modules/vite/bin/vite.js --config tools/player-browser/vite.config.mjs
```

Open `http://127.0.0.1:5175/tools/player-browser/index.html` or run:

```sh
node tools/player-browser/check.mjs
```

The runner accepts `PLAYER_TEST_URL`, `PLAYWRIGHT_MODULE`, `PLAYER_BROWSER`,
and `PLAYER_TEST_OUTPUT` overrides. The server accepts `PLAYER_FIXTURE`.
Defaults use the bundled Codex Playwright runtime and system Brave available
in this environment. Browser checks print each result and leave screenshots
and a JSON report under `/tmp/vice-player-browser`. The runner fails if any
check fails. It intentionally does not run the rest of the application's tests.

Coverage includes playback/source identity, keyboard seeking and range ownership,
mute/speed persistence, paused and playing window/fullscreen transitions,
double-click behavior, timeline preview, actual media endings (stop/loop/next),
highlight/frame/key actions, editing and focus containment, idle chrome behavior,
rejected fullscreen exits, pending entry races, external-overlay keyboard
ownership, close/reopen and focus restoration, and 900/560 pixel layouts.
