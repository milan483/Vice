"""KDE compatibility preserves the upstream GSR command/lifecycle contract."""
import asyncio
import signal
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from vice import active_window as aw, main as main_mod, recorder as rec
from vice.config import Config, RecordingConfig
from vice.kwin_gsr_bridge import _isolated_command


UUID = "6fa1fae1-4123-4567-8abc-123456789abc"
PIN = "kwin:" + UUID


class KWinWindowIdentityTests(unittest.TestCase):
    def test_pin_and_game_identity_come_from_one_focus_snapshot(self):
        with mock.patch.object(aw, "_run", return_value="{" + UUID + "}\n42\nsteam_app_123\n") as query, \
                mock.patch.object(aw, "_read_proc_comm", return_value="game"), \
                mock.patch.object(aw, "_kwin_capture_available", return_value=True):
            window = aw._get_active_window_kde()
        self.assertEqual(window, {"pid": 42, "process": "game", "class": "steam_app_123", "window_id": PIN})
        query.assert_called_once_with([
            "kdotool", "getactivewindow", "getwindowid", "getwindowpid", "getwindowclassname",
        ])

    def test_missing_optional_capture_support_keeps_game_detection(self):
        with mock.patch.object(aw, "_run", return_value="{" + UUID + "}\n42\ngame\n"), \
                mock.patch.object(aw, "_read_proc_comm", return_value="game"), \
                mock.patch.object(aw, "_kwin_capture_available", return_value=False):
            window = aw._get_active_window_kde()
        self.assertEqual(window["pid"], 42)
        self.assertNotIn("window_id", window)

    def test_geometry_checks_the_pinned_uuid_after_focus_changes(self):
        with mock.patch.object(aw, "_run", return_value="Window\n Position: 10,20\n Geometry: 800x600\n") as query:
            self.assertEqual(aw.get_window_geometry(PIN), (800, 600))
        query.assert_called_once_with(["kdotool", "getwindowgeometry", "{" + UUID + "}"])

    def test_closed_window_has_no_geometry(self):
        with mock.patch.object(aw, "_run", return_value=""):
            self.assertIsNone(aw.get_window_geometry(PIN))


class KWinGSRCommandTests(unittest.TestCase):
    def test_session_and_replay_use_same_pinned_source_and_original_gsr(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg = Config(recording=RecordingConfig(window_capture=True, capture_audio=False))
            cfg.output.directory = directory
            recorder = rec.GSRRecorder(cfg)
            recorder.window_override = PIN
            with mock.patch.object(aw, "get_window_geometry", return_value=(800, 600)), \
                    mock.patch.object(rec, "_gsr_prefix", side_effect=lambda: ["gpu-screen-recorder"]), \
                    mock.patch.object(rec, "gsr_supports_kwin_capture", return_value=True):
                replay = recorder._build_cmd(cpu_encoder=True)
                session = recorder._gsr_session_cmd(Path(directory) / "session.mp4", cfg.recording, window_override=PIN)
            for command in (replay, session):
                self.assertEqual(command[1:6], ["-m", "vice.kwin_gsr_bridge", "--window", UUID, "--"])
                self.assertEqual(command[6], "gpu-screen-recorder")
                self.assertEqual(command[command.index("-w") + 1], "portal")
                self.assertEqual(rec._program_name(command), "gpu-screen-recorder")
            self.assertIn("-r", replay)
            self.assertNotIn("-r", session)

    def test_x11_and_manual_capture_commands_are_unchanged(self):
        cfg = RecordingConfig(window_capture=True)
        command = ["gpu-screen-recorder", "-w", "123"]
        self.assertIs(rec._gsr_window_compat_command(command, cfg, [], "123"), command)
        self.assertIs(rec._gsr_window_compat_command(command, cfg, ["-w", "123"], PIN), command)
        cfg.window_capture = False
        self.assertIs(rec._gsr_window_compat_command(command, cfg, [], PIN), command)

    def test_missing_window_keeps_upstream_display_fallback(self):
        cfg = RecordingConfig(window_capture=True)
        with mock.patch.object(aw, "get_window_geometry", return_value=None), \
                mock.patch.object(rec, "_gsr_capture_target", return_value="DP-1"):
            args = rec._gsr_capture_args(cfg, [], window_override=PIN)
        self.assertEqual(args, ["-w", "DP-1"])
        command = ["gpu-screen-recorder", *args]
        self.assertIs(rec._gsr_window_compat_command(command, cfg, [], PIN), command)

    def test_bridge_does_not_restore_an_unrelated_portal_source(self):
        command = _isolated_command([
            "gpu-screen-recorder", "-w", "portal", "-restore-portal-session", "yes",
            "-portal-session-token-filepath", "/unrelated/token", "-r", "120",
        ], "/private")
        self.assertNotIn("/unrelated/token", command)
        self.assertEqual(command[-4:], ["-restore-portal-session", "no", "-portal-session-token-filepath", "/private/portal-token"])
        with self.assertRaises(ValueError):
            _isolated_command(["gpu-screen-recorder", "-w", "portal", "-w", "screen"], "/private")


class KWinShutdownTests(unittest.IsolatedAsyncioTestCase):
    async def test_source_change_releases_an_existing_incompatible_pin(self):
        daemon = main_mod.ViceDaemon.__new__(main_mod.ViceDaemon)
        daemon.cfg = Config(recording=RecordingConfig(window_capture=True, gsr_source="flatpak"))
        daemon._window_capture_id = PIN
        old = mock.Mock(window_override=PIN)
        old.stop = mock.AsyncMock()
        new = mock.Mock()
        new.start = mock.AsyncMock()
        daemon.recorder = old
        daemon._wire_recorder = mock.Mock(side_effect=lambda recorder: setattr(recorder, "window_override", daemon._window_capture_id))
        daemon._recording_signature = mock.Mock(return_value="replacement")
        with mock.patch.object(main_mod, "create_recorder", return_value=new), \
                mock.patch.object(main_mod, "gsr_supports_kwin_capture", return_value=False):
            self.assertTrue(await daemon._restart_recorder_for_config_locked())
        self.assertIsNone(daemon._window_capture_id)
        self.assertIsNone(old.window_override)
        self.assertIsNone(new.window_override)
        old.stop.assert_awaited_once()
        new.start.assert_awaited_once()
        self.assertIs(daemon.recorder, new)

    async def test_flatpak_does_not_restart_for_an_unsupported_kwin_pin(self):
        daemon = main_mod.ViceDaemon.__new__(main_mod.ViceDaemon)
        daemon._session_active = False
        daemon._clip_task = None
        daemon._window_capture_id = None
        daemon._match_game = mock.Mock(return_value="Game")
        daemon._restart_recorder_for_config = mock.AsyncMock()
        with mock.patch.object(aw, "get_active_window", return_value={"window_id": PIN}), \
                mock.patch.object(main_mod, "gsr_supports_kwin_capture", return_value=False), \
                mock.patch.object(main_mod.asyncio, "sleep", side_effect=asyncio.CancelledError):
            await daemon._window_capture_loop()
        self.assertIsNone(daemon._window_capture_id)
        daemon._restart_recorder_for_config.assert_not_called()

    async def test_wrapper_finalizes_gsr_before_hard_group_cleanup(self):
        process = mock.Mock()
        process.pid = 42
        process.returncode = None
        process.vice_flatpak = False
        process.vice_kwin_bridge = True
        process.wait = mock.AsyncMock(return_value=0)
        with mock.patch.object(rec, "_signal_group") as group_signal, \
                mock.patch.object(rec, "_unregister_capture"):
            await rec._terminate_group(process)
        process.send_signal.assert_called_once_with(signal.SIGTERM)
        group_signal.assert_called_once_with(process, signal.SIGKILL)


if __name__ == "__main__":
    unittest.main()
