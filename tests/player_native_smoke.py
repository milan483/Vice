"""Optional real Qt/pywebview smoke test; start tools/player-browser Vite first.

Run: python tests/player_native_smoke.py
A child process uses Qt's offscreen platform and a fresh browser profile; no
existing Vice process or desktop window is controlled. Requires pywebview/Qt.
The parent enforces a hard timeout, including renderer process cleanup.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import traceback

ROOT = Path(__file__).resolve().parents[1]


def child() -> int:
    sys.path.insert(0, str(ROOT))
    import webview
    from vice.app import _PlayerFullscreen

    results: list[dict] = []
    errors: list[str] = []

    class API:
        controller = None

        def set_player_fullscreen(self, enabled):
            return self.controller.set(enabled)

        def get_player_fullscreen(self):
            return self.controller.get()

        def log_debug(self, message):
            print('JS:', message, flush=True)

    api = API()
    url = os.environ.get('PLAYER_NATIVE_URL', 'http://127.0.0.1:5175/tools/player-browser/index.html?native=1')
    win = webview.create_window('Vice isolated native integration', url, js_api=api, width=1100, height=800)
    api.controller = _PlayerFullscreen(win)
    controller = api.controller

    def wait_for(probe, description, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if probe():
                return
            time.sleep(0.05)
        raise AssertionError(description)

    def js(expression):
        return win.evaluate_js(expression)

    def click(label):
        encoded = json.dumps(label)
        if not js(f"(() => {{ const button = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === {encoded}); if (!button || button.disabled) return false; button.click(); return true; }})()"):
            raise AssertionError(f'Button missing/disabled: {label}')

    def record(name, callback):
        try:
            callback()
            results.append({'name': name, 'ok': True})
            print('PASS', name, flush=True)
        except Exception:
            error = traceback.format_exc()
            results.append({'name': name, 'ok': False, 'error': error})
            errors.append(error)
            print('FAIL', name, error, flush=True)

    def worker():
        try:
            wait_for(lambda: js("Boolean(document.querySelector('.watch-video') && window.pywebview?.api?.set_player_fullscreen)"), 'Viewer/bridge not loaded', 18)
            js("document.querySelector('.watch-video').dataset.identity = 'retained'")

            def media():
                wait_for(lambda: js("document.querySelector('.watch-video').videoWidth === 640 && document.querySelector('.watch-video').currentTime > 0"), 'Native H.264 playback did not decode/advance', 10)
            record('native H.264 playback decodes and advances', media)

            def maximize():
                win.maximize()
                wait_for(lambda: controller._on_gui(lambda: win.native.isMaximized()), 'Native window did not maximize')
            record('real Qt window maximizes', maximize)

            def enter():
                click('Enter fullscreen')
                wait_for(controller.get, 'Qt did not enter fullscreen')
                wait_for(lambda: js("document.querySelector('.watch-shell').hasAttribute('data-fullscreen')"), 'Viewer did not acknowledge native fullscreen')
                assert js("document.fullscreenElement === null"), 'Native path used DOM fullscreen'
                assert js("document.querySelectorAll('.watch-video').length === 1 && document.querySelector('.watch-video').dataset.identity === 'retained'")
            record('Viewer button enters actual native fullscreen and retains video', enter)

            def exit_keyboard():
                js("document.querySelector('.watch-shell').focus(); document.querySelector('.watch-shell').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', code:'Escape', bubbles:true}))")
                wait_for(lambda: not controller.get(), 'Escape did not exit native fullscreen')
                wait_for(lambda: controller._on_gui(lambda: win.native.isMaximized()), 'Escape did not restore maximized window')
                wait_for(lambda: js("!document.querySelector('.watch-shell').hasAttribute('data-fullscreen')"), 'Viewer native fullscreen state stuck')
            record('Escape exits fullscreen and restores maximized native state', exit_keyboard)

            def external_exit():
                enter()
                # A real GUI state change independent of our fullscreen bridge,
                # equivalent to a window-manager fullscreen exit.
                controller._on_gui(lambda: win.native.showNormal())
                wait_for(lambda: js("!document.querySelector('.watch-shell').hasAttribute('data-fullscreen')"), 'Viewer did not notice external Qt fullscreen exit')
                wait_for(lambda: controller._on_gui(lambda: win.native.isMaximized()), 'External exit did not restore maximized state')
            record('external native exit synchronizes Viewer and restores maximized state', external_exit)

            def close():
                enter()
                click('Close the player')
                wait_for(lambda: not controller.get(), 'Closing viewer left native window fullscreen')
                wait_for(lambda: controller._on_gui(lambda: win.native.isMaximized()), 'Closing viewer did not restore maximized state')
                wait_for(lambda: js("!document.querySelector('.watch-shell')"), 'Closed player remained mounted')
            record('closing fullscreen viewer restores maximized native window', close)
            print('NATIVE_MEDIA', json.dumps(js("(() => { const v=document.querySelector('video'); return {h264:document.createElement('video').canPlayType('video/mp4; codecs=\"avc1.640028\"'), videoPresent:!!v, notifications:window.playerHarness?.notifications}; })()")), flush=True)
        except Exception:
            errors.append(traceback.format_exc())
            print(errors[-1], flush=True)
        finally:
            report = {'results': results, 'errors': errors, 'backend': 'qt', 'platform': os.environ.get('QT_QPA_PLATFORM')}
            Path('/tmp/vice-player-native-report.json').write_text(json.dumps(report, indent=2))
            win.destroy()

    webview.start(worker, gui='qt', debug=False, private_mode=True)
    return 1 if errors else 0


def main() -> int:
    if '--child' in sys.argv:
        return child()
    environment = dict(os.environ)
    environment.update({
        'QT_QPA_PLATFORM': 'offscreen', 'QTWEBENGINE_DISABLE_SANDBOX': '1',
        'QTWEBENGINE_CHROMIUM_FLAGS': '--no-sandbox --disable-gpu --disable-dev-shm-usage --autoplay-policy=no-user-gesture-required',
        'QT_QUICK_BACKEND': 'software', 'LIBGL_ALWAYS_SOFTWARE': '1',
        'PYTHONUNBUFFERED': '1',
    })
    process = subprocess.Popen([sys.executable, __file__, '--child'], cwd=ROOT, env=environment, start_new_session=True)
    try:
        return process.wait(timeout=70)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        print('FAIL: native smoke test exceeded 70 seconds', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
