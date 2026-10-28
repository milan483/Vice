"""Feed one KWin window stream to unmodified GSR through a private portal bus.

This process is a per-recording protocol adapter, never a replacement for the
desktop's portal service.  KWin still decides whether the helper may capture.
All children inherit the caller's process group for Vice's normal reaper.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import selectors
import signal
import socket
import subprocess
import sys
import tempfile
import time


PORTAL = "org.freedesktop.portal.ScreenCast"
REQUEST = "org.freedesktop.portal.Request"
SESSION = "org.freedesktop.portal.Session"
ROOT = "/org/freedesktop/portal/desktop"


def _isolated_command(command: list[str], directory: str) -> list[str]:
    """Discard inherited restore settings, including their argument values."""
    result: list[str] = []
    index = 0
    while index < len(command):
        if command[index] in {"-restore-portal-session", "-portal-session-token-filepath"}:
            if index + 1 >= len(command):
                raise ValueError(f"missing value for {command[index]}")
            index += 2
            continue
        result.append(command[index])
        index += 1
    sources = [result[i + 1] if i + 1 < len(result) else None
               for i, value in enumerate(result) if value == "-w"]
    if sources != ["portal"]:
        raise ValueError("the GSR command must use -w portal")
    return result + ["-restore-portal-session", "no", "-portal-session-token-filepath",
                     str(Path(directory) / "portal-token")]


def run(window: str, command: list[str]) -> int:
    cursor = "embedded"
    for index, argument in enumerate(command):
        if argument == "-cursor":
            if index + 1 >= len(command) or command[index + 1] not in {"yes", "no"}:
                raise ValueError("GSR -cursor must be yes or no")
            cursor = "hidden" if command[index + 1] == "no" else "embedded"
    cursor_mode = 1 if cursor == "hidden" else 2
    # Keep these optional dependencies out of normal Vice imports.
    try:
        import dbus
        import dbus.service
        from dbus.mainloop.glib import DBusGMainLoop
        from gi.repository import GLib
    except ImportError as error:
        raise RuntimeError("KWin GSR bridge requires dbus-python and PyGObject (GLib)") from error

    DBusGMainLoop(set_as_default=True)
    loop = GLib.MainLoop()
    children: list[subprocess.Popen] = []
    state = {"node": None, "opened": False, "failed": False, "stopping": False, "deadline": None,
             "helper_buffer": b"", "started": time.monotonic()}
    sessions: dict[str, object] = {}
    requests: dict[str, object] = {}
    pending: dict[str, tuple[object, object]] = {}
    gsr = None
    daemon = None
    bus = None
    owner = None

    def stop(reason: str | None = None) -> None:
        if state["stopping"]:
            return
        state["stopping"] = True
        state["deadline"] = time.monotonic() + 15.0
        if reason:
            state["failed"] = True
            print(f"vice KWin capture: {reason}", file=sys.stderr, flush=True)
        for request, _session in list(pending.values()):
            request.respond(2, {})
        pending.clear()
        for session in list(sessions.values()):
            session.closed = True
            session.Closed({})
        if gsr is not None and gsr.poll() is None:
            # GSR handles SIGINT by finishing its current recording.
            gsr.send_signal(signal.SIGINT)
        else:
            loop.quit()

    def require_session(path, sender):
        session = sessions.get(str(path))
        if session is None or session.sender != sender or session.closed:
            raise dbus.exceptions.DBusException("Unknown capture session",
                                               name="org.freedesktop.portal.Error.InvalidArgument")
        return session

    def token(value) -> str:
        value = str(value)
        if not re.fullmatch(r"[A-Za-z0-9_]+", value):
            raise dbus.exceptions.DBusException("Invalid handle token",
                                               name="org.freedesktop.portal.Error.InvalidArgument")
        return value

    class Request(dbus.service.Object):
        def __init__(self, sender, options):
            self.sender = sender
            self.path = ROOT + "/request/" + sender.lstrip(":").replace(".", "_") + "/" + token(options["handle_token"])
            self.finished = False
            super().__init__(bus, self.path)
            requests[self.path] = self

        @dbus.service.signal(REQUEST, signature="ua{sv}")
        def Response(self, response, results):
            pass

        def respond(self, response, results):
            if not self.finished:
                self.finished = True
                # Portal responses are directed to the requesting client.
                # In particular GSR versions with a capitalized "Portal" in
                # their signal match cannot receive a broadcast response.
                # Unicast delivery needs no subscription or timing delay.
                message = dbus.lowlevel.SignalMessage(self.path, REQUEST, "Response")
                message.set_destination(self.sender)
                message.append(dbus.UInt32(response), results, signature="ua{sv}")
                bus.send_message(message)
                pending.pop(self.path, None)
                requests.pop(self.path, None)
                self.remove_from_connection()
            return False

        @dbus.service.method(REQUEST, in_signature="", out_signature="", sender_keyword="sender")
        def Close(self, sender=None):
            if sender == self.sender:
                self.respond(1, {})

    class Session(dbus.service.Object):
        def __init__(self, sender, options):
            self.sender = sender
            self.closed = False
            self.selected = False
            self.started = False
            self.path = ROOT + "/session/" + sender.lstrip(":").replace(".", "_") + "/" + token(options["session_handle_token"])
            super().__init__(bus, self.path)
            sessions[self.path] = self

        @dbus.service.signal(SESSION, signature="a{sv}")
        def Closed(self, details):
            pass

        @dbus.service.method(SESSION, in_signature="", out_signature="", sender_keyword="sender")
        def Close(self, sender=None):
            if sender == self.sender:
                stop()

    def start_response(request, session):
        if request.finished or session.closed:
            return
        session.started = True
        properties = dbus.Dictionary({"source_type": dbus.UInt32(2)}, signature="sv")
        streams = dbus.Array([dbus.Struct((dbus.UInt32(state["node"]), properties), signature="ua{sv}")], signature="(ua{sv})")
        request.respond(0, {"streams": streams})

    class ScreenCast(dbus.service.Object):
        @dbus.service.method("org.freedesktop.DBus.Properties", in_signature="ss", out_signature="v")
        def Get(self, interface, name):
            values = self.GetAll(interface)
            if name not in values:
                raise dbus.exceptions.DBusException("Unknown property", name="org.freedesktop.DBus.Error.InvalidArgs")
            return values[name]

        @dbus.service.method("org.freedesktop.DBus.Properties", in_signature="s", out_signature="a{sv}")
        def GetAll(self, interface):
            if interface != PORTAL:
                return {}
            return {"version": dbus.UInt32(4), "AvailableSourceTypes": dbus.UInt32(2),
                    "AvailableCursorModes": dbus.UInt32(3)}

        @dbus.service.method(PORTAL, in_signature="a{sv}", out_signature="o", sender_keyword="sender")
        def CreateSession(self, options, sender=None):
            session = Session(sender, options)
            request = Request(sender, options)
            GLib.idle_add(request.respond, 0, {"session_handle": dbus.String(session.path)})
            return dbus.ObjectPath(request.path)

        @dbus.service.method(PORTAL, in_signature="oa{sv}", out_signature="o", sender_keyword="sender")
        def SelectSources(self, session_handle, options, sender=None):
            session = require_session(session_handle, sender)
            request = Request(sender, options)
            # GSR can request monitor|window. Advertised capabilities and the
            # returned source are always WINDOW; a monitor-only client fails.
            if (session.selected or not int(options.get("types", 1)) & 2
                    or int(options.get("cursor_mode", 1)) != cursor_mode):
                GLib.idle_add(request.respond, 2, {})
            else:
                session.selected = True
                GLib.idle_add(request.respond, 0, {})
            return dbus.ObjectPath(request.path)

        @dbus.service.method(PORTAL, in_signature="osa{sv}", out_signature="o", sender_keyword="sender")
        def Start(self, session_handle, parent_window, options, sender=None):
            session = require_session(session_handle, sender)
            request = Request(sender, options)
            if not session.selected or session.started or state["stopping"]:
                GLib.idle_add(request.respond, 2, {})
            elif state["node"] is not None:
                GLib.idle_add(start_response, request, session)
            else:
                pending[request.path] = (request, session)
            return dbus.ObjectPath(request.path)

        @dbus.service.method(PORTAL, in_signature="oa{sv}", out_signature="h", sender_keyword="sender")
        def OpenPipeWireRemote(self, session_handle, options, sender=None):
            session = require_session(session_handle, sender)
            if not session.started or state["stopping"]:
                raise dbus.exceptions.DBusException("Capture stream is unavailable",
                                                   name="org.freedesktop.portal.Error.Failed")
            runtime = os.environ.get("XDG_RUNTIME_DIR")
            if not runtime:
                raise dbus.exceptions.DBusException("XDG_RUNTIME_DIR is unset",
                                                   name="org.freedesktop.portal.Error.Failed")
            remote = os.environ.get("PIPEWIRE_REMOTE", "pipewire-0")
            path = remote if os.path.isabs(remote) else os.path.join(runtime, remote)
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.connect(path)
                state["opened"] = True
                return dbus.types.UnixFd(connection.fileno())

    def helper_ready(fd, condition):
        try:
            chunk = os.read(fd, 65536)
        except BlockingIOError:
            return True
        if not chunk:
            stop("KWin stream helper disconnected")
            return False
        state["helper_buffer"] += chunk
        if len(state["helper_buffer"]) > 1024 * 1024:
            stop("KWin stream helper sent an oversized event")
            return False
        while b"\n" in state["helper_buffer"]:
            line, state["helper_buffer"] = state["helper_buffer"].split(b"\n", 1)
            try:
                event = json.loads(line)
                kind = event["event"]
                if kind == "created":
                    node = event["node_id"]
                    if type(node) is not int or not 0 < node < 2**32 or state["node"] is not None:
                        raise ValueError("invalid or repeated PipeWire node")
                    state["node"] = node
                    for request, session in list(pending.values()):
                        start_response(request, session)
                elif kind in {"failed", "closed"}:
                    stop(str(event.get("message") or f"KWin window stream {kind}"))
                    return False
                elif kind != "serial":
                    raise ValueError("unknown helper event")
            except (ValueError, KeyError, TypeError) as error:
                stop(f"invalid KWin stream helper event: {error}")
                return False
        return True

    def poll():
        if gsr.poll() is not None:
            loop.quit()
            return False
        if not state["stopping"]:
            if helper.poll() is not None:
                stop("KWin stream helper exited")
            elif daemon.poll() is not None:
                stop("private capture bus exited")
            elif not state["opened"] and time.monotonic() - state["started"] > 25:
                stop("timed out establishing the KWin capture session")
        elif time.monotonic() >= state["deadline"]:
            gsr.kill()
        return True

    def on_signal(number, _frame):
        if number == signal.SIGUSR1:
            if gsr is not None and gsr.poll() is None and not state["stopping"]:
                gsr.send_signal(signal.SIGUSR1)
        else:
            stop()

    old_signals = {number: signal.signal(number, on_signal)
                   for number in (signal.SIGINT, signal.SIGTERM, signal.SIGUSR1)}
    try:
        with tempfile.TemporaryDirectory(prefix="vice-kwin-gsr-") as directory:
            command = _isolated_command(command, directory)
            daemon = subprocess.Popen(["dbus-daemon", "--session", "--nofork", "--print-address=1",
                                       f"--address=unix:path={directory}/bus"],
                                      stdout=subprocess.PIPE, stderr=sys.stderr)
            children.append(daemon)
            with selectors.DefaultSelector() as selector:
                selector.register(daemon.stdout, selectors.EVENT_READ)
                if not selector.select(timeout=5):
                    raise RuntimeError("private D-Bus daemon did not start")
                address = daemon.stdout.readline().decode().strip()
            if not address.startswith("unix:"):
                raise RuntimeError("private D-Bus daemon returned no address")
            bus = dbus.bus.BusConnection(address)
            owner = dbus.service.BusName("org.freedesktop.portal.Desktop", bus=bus,
                                        allow_replacement=False, do_not_queue=True)
            portal = ScreenCast(bus, ROOT)
            if state["stopping"]:
                return 0
            helper = subprocess.Popen([sys.executable, "-m", "vice.kwin_stream", "--window", window,
                                       "--cursor", cursor],
                                      stdout=subprocess.PIPE, stderr=sys.stderr)
            children.append(helper)
            os.set_blocking(helper.stdout.fileno(), False)
            GLib.io_add_watch(helper.stdout.fileno(), GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, helper_ready)
            environment = os.environ.copy()
            environment["DBUS_SESSION_BUS_ADDRESS"] = address
            if state["stopping"]:
                return 0
            gsr = subprocess.Popen(command, env=environment, stdout=sys.stderr, stderr=sys.stderr)
            children.append(gsr)
            GLib.timeout_add(100, poll)
            loop.run()
            returncode = gsr.wait()
            return (returncode if returncode >= 0 else 128 - returncode) or (1 if state["failed"] else 0)
    finally:
        # Finalize GSR before destroying the stream or its bus, even on errors.
        for child in reversed(children):
            if child is daemon:
                # Drop the name while its bus is still available, so the
                # BusName finalizer does not call an already closed connection.
                owner = None
            if child.poll() is None:
                child.send_signal(signal.SIGINT if child is gsr else signal.SIGTERM)
                try:
                    child.wait(timeout=15 if child is gsr else 3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
        if bus is not None:
            bus.close()
        for number, handler in old_signals.items():
            signal.signal(number, handler)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--window", required=True, help="exact KWin window UUID")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a GSR command is required after --")
    try:
        return run(args.window, command)
    except (RuntimeError, ValueError, OSError) as error:
        print(f"vice KWin capture: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
