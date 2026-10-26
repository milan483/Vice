"""Native fullscreen state and restoration, without a running GUI."""
import threading
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from vice.app import _PlayerFullscreen


class Event:
    def __iadd__(self, callback):
        self.callback = callback
        return self


class Native:
    def __init__(self):
        self.fullscreen = False
        self.is_fullscreen = False
        self.state = 'maximized'
        self.toggles = 0

    def isFullScreen(self):
        return self.fullscreen

    def windowState(self):
        return self.state

    def setWindowState(self, state):
        self.state = state

    def toggle(self):
        self.toggles += 1
        self.fullscreen = not self.is_fullscreen
        self.is_fullscreen = self.fullscreen
        self.state = 'fullscreen' if self.fullscreen else 'normal'


class PlayerFullscreenTests(unittest.TestCase):
    def setUp(self):
        self.native = Native()
        self.window = SimpleNamespace(
            native=self.native, events=SimpleNamespace(before_show=Event()),
            toggle_fullscreen=self.native.toggle,
        )
        self.controller = _PlayerFullscreen(self.window)
        self.controller._qt = True
        self.controller._dispatch = lambda callback: callback()

    def test_idempotent_and_restores_maximized_state(self):
        self.assertTrue(self.controller.set(True))
        self.assertTrue(self.controller.set(True))
        self.assertEqual(self.native.toggles, 1)
        self.assertFalse(self.controller.set(False))
        self.assertEqual(self.native.state, 'maximized')
        self.assertFalse(self.controller.set(False))
        self.assertEqual(self.native.toggles, 2)

    def test_reads_window_manager_exit_and_repairs_backend_flag(self):
        self.controller.set(True)
        self.native.fullscreen = False  # WM exit leaves pywebview's flag stale.
        self.assertFalse(self.controller.get())
        self.assertEqual(self.native.state, 'maximized')
        self.assertTrue(self.native.is_fullscreen)
        self.controller.set(False)
        self.assertEqual(self.native.state, 'maximized')
        self.assertTrue(self.controller.set(True))
        self.assertTrue(self.native.fullscreen)

    def test_rejects_non_boolean_and_unavailable_window(self):
        with self.assertRaises(ValueError):
            self.controller.set('true')
        self.controller._dispatch = None
        with self.assertRaisesRegex(RuntimeError, 'not ready'):
            self.controller.set(True)

    def test_gui_errors_reach_bridge_caller(self):
        def broken():
            raise RuntimeError('window closed')
        self.window.toggle_fullscreen = broken
        with self.assertRaisesRegex(RuntimeError, 'window closed'):
            self.controller.set(True)

    def test_concurrent_requests_are_serialized(self):
        errors = []
        def request():
            try:
                self.controller.set(True)
            except Exception as exc:
                errors.append(exc)
        threads = [threading.Thread(target=request) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(self.native.toggles, 1)

    def test_gui_timeout_does_not_later_mutate_window(self):
        callbacks = []
        self.controller._dispatch = callbacks.append
        with patch('vice.app.threading.Event.wait', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'timed out'):
                self.controller.set(True)
        callbacks[0]()
        self.assertEqual(self.native.toggles, 0)

    def test_window_manager_rejection_reaches_caller(self):
        self.window.toggle_fullscreen = lambda: None
        with patch('vice.app.time.monotonic', side_effect=[0, 4]):
            with self.assertRaisesRegex(RuntimeError, 'window manager'):
                self.controller.set(True)

    def test_gtk_uses_actual_surface_state_and_repairs_backend_flag(self):
        state = {'value': 0}
        backend = SimpleNamespace(is_fullscreen=True)
        def toggle():
            state['value'] = 0 if backend.is_fullscreen else 16
            backend.is_fullscreen = not backend.is_fullscreen
        backend.toggle_fullscreen = toggle
        self.window.native = SimpleNamespace(
            get_window=lambda: SimpleNamespace(get_state=lambda: state['value']),
        )
        self.window.uid = 'main'
        self.window.gui = SimpleNamespace(BrowserView=SimpleNamespace(instances={'main': backend}))
        self.controller._qt = False
        repository = SimpleNamespace(Gdk=SimpleNamespace(WindowState=SimpleNamespace(FULLSCREEN=16)))
        with patch.dict('sys.modules', {'gi.repository': repository}):
            self.assertFalse(self.controller.get())
            self.assertTrue(self.controller.set(True))
            self.assertTrue(backend.is_fullscreen)
            state['value'] = 0  # External exit; backend's flag is stale again.
            self.assertTrue(self.controller.set(True))
            self.assertFalse(self.controller.set(False))


if __name__ == '__main__':
    unittest.main()
